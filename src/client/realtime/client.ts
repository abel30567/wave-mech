import {
  TRANSPORT_AUDIO_BYTES,
  type AudioMode,
  type ConversationClient,
  type ConversationClientOptions,
  type ConversationView,
  type HandsFreeAudio,
  type HandsFreeAudioOptions,
  type RealtimeCommand,
  type RealtimeEvent,
  type ToolCapabilities,
  type ToolStatus,
  type TranscriptEntry,
} from '../../shared/realtime.js';
import { encodeAudio } from '../../shared/realtime-wire.js';
import { OutstandingAudio } from './outstanding.js';

// Reconnect/stall timing. These are client-transport concerns, not part of the
// shared wire contract, so they live here rather than in `shared/realtime.ts`.
const RECONNECT_DELAY_MS = 750;
const STALL_SOFT_MS = 2000;
const STALL_HARD_MS = 5000;
const WS_OPEN = 1;

type ViewPhase = ConversationView['phase'];

interface InputTurn {
  turnId: number;
  ready: boolean;
  finished: boolean;
  out: OutstandingAudio;
}

/**
 * Reconnecting, hands-free conversation transport.
 *
 * The client owns turn sequencing, the bounded outstanding-audio FIFO, audio
 * acknowledgement/retransmission, automatic reconnect, snapshot reconciliation
 * and stale-event filtering. Audio capture/playback is delegated to an injected
 * {@link HandsFreeAudio}; the live WebSocket and VAD are created through the
 * supplied factories so the controller is exercised deterministically in Node.
 */
class Client implements ConversationClient {
  private readonly options: ConversationClientOptions;
  private readonly socketFactory: (url: string) => WebSocket;
  private readonly audioFactory: (options: HandsFreeAudioOptions) => Promise<HandsFreeAudio>;

  private socket: WebSocket | null = null;
  private audio: HandsFreeAudio | null = null;
  private audioCreating: Promise<HandsFreeAudio> | null = null;

  private started = false;
  private ended = false;
  private connection: ConversationView['connection'] = 'offline';
  private phase: ViewPhase = 'loading-audio';
  private mode: AudioMode | null = null;

  private sessionId: string | undefined;
  private messages: TranscriptEntry[] = [];
  private partial = '';
  private muted = false;
  private outputPaused = false;
  private audioAvailable = false;
  private notice: string | undefined;
  private tool: { name: string; status: ToolStatus } | undefined;
  private capabilities: ToolCapabilities | undefined;

  private turnCounter = 0;
  private input: InputTurn | null = null;
  private finishedInput: InputTurn | null = null;
  private currentResponseId: number | null = null;

  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stallSoft: ReturnType<typeof setTimeout> | undefined;
  private stallHard: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ConversationClientOptions) {
    this.options = options;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.audioFactory =
      options.audioFactory ??
      (async (audioOptions) => (await import('./audio.js')).createHandsFreeAudio(audioOptions));
  }

  // --- public API -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.phase = 'loading-audio';
    this.connection = 'connecting';
    this.emit();

    // Audio is created first, synchronously within the user gesture, before any
    // unrelated await so the browser permits microphone/playback access.
    this.audioCreating = this.audioFactory({
      onSpeechStart: this.onSpeechStart,
      onSpeechEnd: this.onSpeechEnd,
      onMisfire: this.onMisfire,
      onPcm: this.onPcm,
      onState: this.onAudioState,
      onError: this.onAudioError,
      onDiscontinuity: this.onDiscontinuity,
    });
    try {
      this.audio = await this.audioCreating;
      this.audioAvailable = true;
    } catch {
      this.audio = null;
      this.audioAvailable = false;
      this.notice = 'Microphone unavailable. You can still type a message.';
    }
    if (this.ended) {
      await this.audio?.close();
      return;
    }

    // refreshAccess re-establishes the same-origin bootstrap before connecting.
    try {
      await this.options.refreshAccess();
    } catch {
      /* connect anyway; the server rejects an unauthenticated socket */
    }
    if (this.ended) return;
    this.connect(false);
  }

  sendText(text: string): void {
    const trimmed = text.trim();
    if (this.ended || !trimmed) return;
    if (trimmed.length > 12000) {
      this.notice = 'That message is too long.';
      this.emit();
      return;
    }
    if (!this.socketOpen()) return;
    // A typed turn pre-empts any half-captured spoken input.
    if (this.input) {
      this.send({ type: 'abort_input', turnId: this.input.turnId, reason: 'interrupted' });
      this.discardInput();
    }
    const turnId = ++this.turnCounter;
    this.send({ type: 'text', turnId, text: trimmed });
    this.partial = '';
    this.setPhase('thinking');
    this.emit();
  }

  async finishTurn(): Promise<void> {
    await this.finishInput();
  }

  mute(muted: boolean): void {
    if (this.muted === muted || this.ended) return;
    this.muted = muted;
    if (muted && this.input) {
      this.send({ type: 'abort_input', turnId: this.input.turnId, reason: 'muted' });
      this.discardInput();
    }
    if (!this.input && this.currentResponseId === null) {
      this.setPhase(this.restingPhase());
    }
    this.emit();
  }

  async resumeAudio(): Promise<void> {
    if (this.ended || !this.audio) return;
    await this.audio.resume();
    this.outputPaused = false;
    if (!this.input && this.currentResponseId === null) this.setPhase(this.restingPhase());
    this.emit();
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.clearStall();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.socketOpen()) this.send({ type: 'end' });
    try {
      this.socket?.close();
    } catch {
      /* already closing */
    }
    this.socket = null;
    // Close audio even if its asynchronous creation is still in flight.
    try {
      const audio = this.audio ?? (this.audioCreating ? await this.audioCreating : null);
      await audio?.close();
    } catch {
      /* best effort */
    }
    this.audio = null;
    this.audioAvailable = false;
    this.connection = 'offline';
    this.setPhase('ended');
    this.emit();
  }

  // --- audio callbacks ------------------------------------------------------

  private onSpeechStart = (): void => {
    if (this.ended || this.connection === 'offline' || this.connection === 'expired') return;
    if (this.muted || this.outputPaused) return; // suppressed while paused/muted
    if (this.input) return; // never admit an overlapping input turn
    if (this.phase === 'speaking' && this.currentResponseId !== null) {
      // Barge-in: drop playback immediately and ask the server to interrupt,
      // keeping the shared context open for the new turn.
      this.audio?.cancelOutput();
      this.send({ type: 'interrupt', responseId: this.currentResponseId });
      this.notice = undefined;
    }
    this.startInputTurn();
  };

  private onPcm = (pcm: ArrayBuffer): void => {
    const input = this.input;
    if (!input || this.muted || this.outputPaused) return;
    const result = input.out.push(new Uint8Array(pcm));
    if (result.status !== 'queued') {
      this.send({ type: 'abort_input', turnId: input.turnId, reason: 'overflow' });
      this.discardInput('That went on longer than I can hold. Please say it again.');
      return;
    }
    this.trySendAudio();
  };

  private onSpeechEnd = (): void => {
    void this.finishInput();
  };

  private onMisfire = (): void => {
    // A misfire never produced a committed onset, so there is nothing to abort;
    // just make sure we fall back to the resting phase.
    if (!this.input && this.currentResponseId === null) {
      this.setPhase(this.restingPhase());
      this.emit();
    }
  };

  private onAudioState = (state: 'ready' | 'suspended' | 'closed'): void => {
    if (state === 'suspended') {
      this.outputPaused = true;
      if (!this.input && this.currentResponseId === null) this.setPhase('paused');
    } else if (state === 'ready') {
      this.outputPaused = false;
    } else {
      this.audioAvailable = false;
    }
    this.emit();
  };

  private onAudioError = (message: string): void => {
    this.notice = message;
    this.emit();
  };

  private onDiscontinuity = (): void => {
    const input = this.input;
    if (!input) return;
    // A main-thread stall means the captured prefix is truncated; abandon it
    // rather than committing partial audio.
    this.send({ type: 'abort_input', turnId: input.turnId, reason: 'discontinuity' });
    this.discardInput('The audio stream stalled. Please say that again.');
  };

  // --- input turn handling --------------------------------------------------

  private startInputTurn(): void {
    this.finishedInput = null;
    const turnId = ++this.turnCounter;
    this.input = {
      turnId,
      ready: false,
      finished: false,
      out: new OutstandingAudio(TRANSPORT_AUDIO_BYTES, turnId),
    };
    this.partial = '';
    this.setPhase('recording');
    this.send({ type: 'record', turnId });
    this.armStall();
    this.emit();
  }

  private trySendAudio(): void {
    const input = this.input ?? this.finishedInput;
    if (!input || !input.ready || !this.socketOpen()) return;
    for (const frame of input.out.takeSendable()) {
      this.socket!.send(encodeAudio(frame));
    }
  }

  private async finishInput(): Promise<void> {
    const input = this.input;
    if (!input || input.finished) return; // idempotent: no duplicate finish
    input.finished = true;
    try {
      // Drain worklet frames already posted before this end barrier so the
      // declared lastSeq covers every captured sample.
      await this.audio?.flushInput();
    } catch {
      /* ignore flush faults; we still finalize what we captured */
    }
    if (this.ended) return;
    this.finishedInput = input;
    this.input = null;
    this.trySendAudio();
    if (this.socketOpen()) this.send({ type: 'finish', turnId: input.turnId, lastSeq: input.out.lastSeq });
    this.clearStall();
    this.partial = '';
    this.setPhase('thinking');
    this.emit();
  }

  private discardInput(notice?: string): void {
    this.audio?.clearInput();
    this.input = null;
    this.finishedInput = null;
    this.clearStall();
    this.partial = '';
    if (notice !== undefined) this.notice = notice;
    if (this.currentResponseId === null) this.setPhase(this.restingPhase());
    this.emit();
  }

  // --- response handling ----------------------------------------------------

  private adoptResponse(responseId: number): void {
    if (this.currentResponseId === null || responseId > this.currentResponseId) {
      this.currentResponseId = responseId;
    }
  }

  private isStaleResponse(responseId: number): boolean {
    return this.currentResponseId !== null && responseId < this.currentResponseId;
  }

  private appendAssistant(turnId: number, text: string): void {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const entry = this.messages[i];
      if (entry.role === 'assistant' && entry.turnId === turnId) {
        this.messages[i] = { ...entry, text: entry.text + text };
        return;
      }
      if (entry.role === 'user') break;
    }
    this.messages.push({ turnId, role: 'assistant', text });
  }

  private async completeResponse(responseId: number, lastSeq: number): Promise<void> {
    const audio = this.audio;
    const result = audio ? await audio.finishOutput(responseId, lastSeq) : 'played';
    if (this.ended) return;
    if (result === 'played') {
      this.send({ type: 'playback_done', responseId, lastSeq });
    } else if (result === 'interrupted') {
      // Explicit cancellation/fallback is acknowledged as skipped, never a
      // silent clock stall.
      this.send({ type: 'playback_done', responseId, lastSeq, skipped: true });
    } else {
      // Paused: withhold acknowledgement and expose a resume affordance.
      this.outputPaused = true;
    }
    if (this.currentResponseId === responseId) this.currentResponseId = null;
    if (!this.input && this.currentResponseId === null) this.setPhase(this.restingPhase());
    this.emit();
  }

  // --- transport ------------------------------------------------------------

  private connect(isReconnect: boolean): void {
    this.connection = isReconnect ? 'reconnecting' : 'connecting';
    this.emit();
    const socket = this.socketFactory(this.options.url);
    this.socket = socket;
    try {
      socket.binaryType = 'arraybuffer';
    } catch {
      /* some transports fix binaryType */
    }
    socket.onopen = (): void => {
      if (this.socket !== socket) return;
      // Preserve the known sessionId so the server reattaches context rather
      // than silently replacing it.
      this.send(this.sessionId ? { type: 'hello', version: 2, sessionId: this.sessionId } : { type: 'hello', version: 2 });
      if (isReconnect) {
        // Requeue only unacknowledged audio; accepted frames are never replayed.
        this.input?.out.resetForResend();
        this.finishedInput?.out.resetForResend();
      }
    };
    socket.onmessage = (event: MessageEvent): void => {
      if (this.socket !== socket) return;
      this.onMessage(event);
    };
    socket.onerror = (): void => {
      /* the matching close handler performs the reconnect */
    };
    socket.onclose = (): void => {
      if (this.socket !== socket) return;
      this.onSocketClosed();
    };
  }

  private onSocketClosed(): void {
    this.socket = null;
    if (this.ended || this.connection === 'expired') return;
    this.connection = 'reconnecting';
    this.emit();
    // A transient fault reconnects automatically; it never sends end or clears
    // retained conversation state.
    this.reconnectTimer = setTimeout(() => {
      void (async () => {
        try {
          await this.options.refreshAccess();
        } catch {
          /* attempt the reconnect regardless */
        }
        if (this.ended) return;
        this.connect(true);
      })();
    }, RECONNECT_DELAY_MS);
  }

  private onMessage(event: MessageEvent): void {
    const data = event.data;
    if (typeof data !== 'string') return; // server state travels as JSON text
    let parsed: RealtimeEvent;
    try {
      parsed = JSON.parse(data) as RealtimeEvent;
    } catch {
      return;
    }
    this.dispatch(parsed);
  }

  private dispatch(event: RealtimeEvent): void {
    switch (event.type) {
      case 'snapshot':
        this.reconcile(event.snapshot);
        return;
      case 'state':
        return; // local phase is authoritative for the view
      case 'input_ready':
        if (this.input?.turnId === event.turnId) {
          this.input.ready = true;
          this.armStall();
          this.trySendAudio();
        }
        return;
      case 'audio_ack': {
        const turn = this.input ?? this.finishedInput;
        if (turn?.turnId === event.turnId) {
          turn.out.ack(event.seq);
          if (this.input) this.armStall();
          else this.clearStall();
          this.trySendAudio();
        }
        return;
      }
      case 'input_aborted':
        if (this.input?.turnId === event.turnId || this.finishedInput?.turnId === event.turnId) {
          this.discardInput('That turn was cancelled. Please try again.');
        }
        return;
      case 'partial':
        if (this.input?.turnId === event.turnId) {
          this.partial = event.text;
          this.emit();
        }
        return;
      case 'user':
        this.messages.push({ turnId: event.turnId, role: 'user', text: event.text });
        this.partial = '';
        this.emit();
        return;
      case 'text':
        if (this.isStaleResponse(event.responseId)) return;
        this.adoptResponse(event.responseId);
        this.appendAssistant(event.turnId, event.text);
        this.tool = undefined;
        this.emit();
        return;
      case 'audio':
        if (this.isStaleResponse(event.responseId)) return;
        this.adoptResponse(event.responseId);
        this.audio?.enqueueOutput(event.audio, event.sampleRate, event.responseId, event.seq);
        if (!this.input) this.setPhase('speaking');
        this.emit();
        return;
      case 'response_done':
        if (this.isStaleResponse(event.responseId)) return;
        this.adoptResponse(event.responseId);
        void this.completeResponse(event.responseId, event.lastAudioSeq);
        return;
      case 'response_cancelled':
        this.audio?.cancelOutput(event.responseId);
        if (this.currentResponseId === event.responseId) this.currentResponseId = null;
        if (!this.input && this.currentResponseId === null) this.setPhase(this.restingPhase());
        this.emit();
        return;
      case 'tool':
        this.tool = event.status === 'running' ? { name: event.name, status: event.status } : undefined;
        this.emit();
        return;
      case 'capabilities':
        this.capabilities = event.capabilities;
        this.emit();
        return;
      case 'notice':
        this.notice = event.message;
        this.emit();
        return;
      case 'error':
        this.notice = event.message;
        if (event.fatal) {
          this.connection = event.code === 'expired' ? 'expired' : this.connection;
          void this.end();
        } else {
          this.emit();
        }
        return;
      case 'pong':
        return;
      case 'ended':
        void this.end();
        return;
    }
  }

  private reconcile(snapshot: import('../../shared/realtime.js').ConversationSnapshot): void {
    this.sessionId = snapshot.sessionId;
    this.messages = snapshot.messages.map((entry) => ({ ...entry }));
    this.turnCounter = Math.max(this.turnCounter, snapshot.lastTurnId);
    this.capabilities = snapshot.capabilities ?? this.capabilities;
    if (snapshot.notice !== undefined) this.notice = snapshot.notice;

    // Reconcile an in-flight input turn without replaying accepted commands.
    if (this.input && snapshot.input) {
      if (snapshot.input.turnId === this.input.turnId) {
        this.input.out.ack(snapshot.input.lastSeq);
        this.input.ready = true;
        if (snapshot.input.committed) {
          this.finishedInput = this.input;
          this.input = null;
          this.clearStall();
        }
      } else if (snapshot.input.turnId > this.input.turnId) {
        this.input = null;
        this.clearStall();
      }
    }
    if (snapshot.response && !snapshot.response.finished) {
      this.currentResponseId = snapshot.response.responseId;
    }

    this.connection = 'connected';
    if (!this.input && this.currentResponseId === null) this.setPhase(this.restingPhase());
    if (this.input) this.trySendAudio();
    this.emit();
  }

  // --- stall watchdog -------------------------------------------------------

  private armStall(): void {
    this.clearStall();
    this.stallSoft = setTimeout(() => {
      this.notice = 'The connection is slow; keep speaking.';
      this.emit();
    }, STALL_SOFT_MS);
    this.stallHard = setTimeout(() => {
      const input = this.input;
      if (!input) return;
      this.send({ type: 'abort_input', turnId: input.turnId, reason: 'discontinuity' });
      this.discardInput('We lost the connection to that turn. Please say it again.');
    }, STALL_HARD_MS);
  }

  private clearStall(): void {
    if (this.stallSoft) clearTimeout(this.stallSoft);
    if (this.stallHard) clearTimeout(this.stallHard);
    this.stallSoft = undefined;
    this.stallHard = undefined;
  }

  // --- helpers --------------------------------------------------------------

  private restingPhase(): ViewPhase {
    if (this.muted) return 'muted';
    if (this.outputPaused) return 'paused';
    return 'listening';
  }

  private desiredMode(): AudioMode {
    if (this.muted) return 'muted';
    if (this.outputPaused) return 'paused';
    return this.phase === 'speaking' ? 'barge' : 'listen';
  }

  private setPhase(phase: ViewPhase): void {
    this.phase = phase;
  }

  private send(command: RealtimeCommand): void {
    if (this.socketOpen()) this.socket!.send(JSON.stringify(command));
  }

  private socketOpen(): boolean {
    return this.socket?.readyState === WS_OPEN;
  }

  private syncMode(): void {
    // Only arm detection once the socket is attached; capture stays idle while
    // connecting or reconnecting.
    if (!this.audio || this.ended || this.connection !== 'connected') return;
    const mode = this.desiredMode();
    if (mode !== this.mode) {
      this.mode = mode;
      this.audio.setMode(mode);
    }
  }

  private emit(): void {
    this.syncMode();
    this.options.onChange(this.view());
  }

  private view(): ConversationView {
    return {
      connection: this.connection,
      phase: this.phase,
      messages: this.messages.map((entry) => ({ ...entry })),
      partial: this.partial,
      muted: this.muted,
      audioAvailable: this.audioAvailable && !this.ended,
      canSendText: this.connection === 'connected' && !this.ended,
      canResumeAudio: this.outputPaused && !this.ended,
      sessionId: this.sessionId,
      notice: this.notice,
      tool: this.tool,
      capabilities: this.capabilities,
    };
  }
}

export function createConversationClient(options: ConversationClientOptions): ConversationClient {
  return new Client(options);
}
