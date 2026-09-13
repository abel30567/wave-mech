import type { HarnessEvent } from '../../shared/contracts.js';
import {
  MAX_AUDIO_SEQUENCE,
  PCM_RATE,
  type AudioFrame,
  type ConversationOptions,
  type ConversationPhase,
  type ConversationSnapshot,
  type RealtimeCommand,
  type RealtimeEvent,
  type RealtimeHarness,
  type RealtimeSpeech,
  type RetainedConversation,
  type ToolCapabilities,
  type TranscriptEntry,
} from '../../shared/realtime.js';

/**
 * P2 conversation coordinator.
 *
 * Owns the durable conversational state for one authenticated session while
 * main owns authentication, the single-session registry, the connection epoch
 * and the 120-second detach expiry. Sockets attach and detach around this
 * coordinator; the transcript, turn state and the persistent Claude Code CLI
 * inference all survive a reconnection.
 *
 * Invariants enforced here (see docs/p2-worker-contract.md):
 *  - Turn ids strictly increase; ids/state are reserved before any await.
 *  - Input audio is contiguous, accepted at most once, and bounded; an ACK is
 *    emitted only once the speech adapter actually accepts a frame.
 *  - Commit, user text and inference happen exactly once per turn; duplicate
 *    calls with identical content are idempotent and conflicting reuse fails.
 *  - Never more than one inference in flight, and never continue past an
 *    unconfirmed interrupt settlement.
 *  - A disconnected response finishes into retained text without emitting
 *    unbounded unheard TTS, and resume never replays possibly heard audio.
 */

// ~120 seconds of mono PCM16 @ 16 kHz — the same recording ceiling P1 uses.
const MAX_INPUT_BYTES = PCM_RATE * 2 * 120;
// Bound the transcript we retain for snapshots. This does not reset the model's
// own context (the persistent CLI keeps that) — it only bounds resume payloads.
const MAX_MESSAGES = 200;
// Enough recent per-seq fingerprints to detect a conflicting duplicate frame
// without retaining the whole utterance.
const FINGERPRINT_WINDOW = 256;

type InputStatus = 'recording' | 'committing' | 'committed' | 'aborted' | 'failed';

interface ActiveInput {
  turnId: number;
  status: InputStatus;
  receivedSeq: number;
  declaredLastSeq?: number;
  bytes: number;
  fingerprints: Map<number, number>;
}

interface ActiveResponse {
  turnId: number;
  responseId: number;
  audioSeq: number;
  lastAudioSeq: number;
  finished: boolean;
  cancelled: boolean;
  audioInterrupted: boolean;
  ttsSuppressed: boolean;
  inferenceActive: boolean;
  awaitingPlayback: boolean;
  assistantIndex: number | undefined;
}

/** Cheap order-sensitive checksum used only to spot conflicting duplicate frames. */
function fingerprint(pcm: Uint8Array): number {
  let hash = 2166136261 >>> 0;
  hash = Math.imul(hash ^ pcm.byteLength, 16777619);
  for (let i = 0; i < pcm.byteLength; i++) hash = Math.imul(hash ^ pcm[i], 16777619);
  return hash >>> 0;
}

function textSignature(text: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}

class Conversation implements RetainedConversation {
  readonly id: string;
  private readonly mode: 'live' | 'fixture';
  private readonly now: () => number;

  private harness: RealtimeHarness | undefined;
  private speech: RealtimeSpeech | undefined;
  private readonly speechConfigured: boolean;

  private sink: ((event: RealtimeEvent) => void) | undefined;

  private phase: ConversationPhase = 'idle';
  private readonly messages: TranscriptEntry[] = [];
  private lastTurnId = 0;
  private capabilities: ToolCapabilities | undefined;
  private notice: string | undefined;

  private input: ActiveInput | undefined;
  private response: ActiveResponse | undefined;
  private nextResponseId = 0;
  /** turnId -> signature of the accepted command, for idempotent replay handling. */
  private readonly turnSignatures = new Map<number, string>();
  private inference: Promise<void> | undefined;

  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: ConversationOptions) {
    this.id = options.id;
    this.mode = options.mode;
    this.now = options.now ?? Date.now;
    this.speechConfigured = typeof options.speech === 'function';
  }

  // --- lifecycle ------------------------------------------------------------

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.closed) return Promise.reject(new Error('Conversation is closed.'));

    this.harness = this.options.harness((event) => this.onHarness(event));
    if (this.options.speech) {
      this.speech = this.options.speech({
        onPartial: (text) => this.onPartial(text),
        onAudio: (audio, sampleRate) => this.onAudio(audio, sampleRate),
        onError: (message) => this.onSpeechError(message),
      });
    }

    // Initialize the harness without a hidden inference warm-up.
    this.startPromise = this.harness.start().then(() => {
      if (this.closed) return;
      this.setPhase('idle');
    });
    return this.startPromise;
  }

  attach(send: (event: RealtimeEvent) => void): void {
    if (this.closed) {
      send({ type: 'ended' });
      return;
    }
    // A freshly attached socket is authoritative going forward; the previous
    // sink (if any) is dropped. Main only forwards commands from this one.
    this.sink = send;
    send({ type: 'snapshot', snapshot: this.snapshot() });
  }

  detach(): void {
    this.sink = undefined;
    // Suppress uncertain, unheard audio for an in-flight response, but let the
    // inference keep running into retained text. Do not touch input context.
    const response = this.response;
    if (response && !response.finished && !response.cancelled && !response.ttsSuppressed) {
      response.ttsSuppressed = true;
      response.audioInterrupted = true;
      try {
        this.speech?.cancelSpeech();
      } catch {
        /* best-effort: cancellation must not throw out of detach */
      }
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.phase = 'closed';
    this.closePromise = (async () => {
      try {
        this.speech?.close();
      } catch {
        /* continue releasing the harness */
      }
      try {
        await this.harness?.close();
      } catch {
        /* already gone */
      }
      this.emit({ type: 'ended' });
      this.sink = undefined;
    })();
    return this.closePromise;
  }

  // --- command handling -----------------------------------------------------

  async handle(command: RealtimeCommand): Promise<void> {
    if (this.closed && command.type !== 'end') return;
    try {
      switch (command.type) {
        case 'hello':
          // Authentication and attachment are main-owned; nothing to do here.
          return;
        case 'ping':
          this.emit({ type: 'pong', id: command.id });
          return;
        case 'record':
          await this.onRecord(command.turnId);
          return;
        case 'finish':
          await this.onFinish(command.turnId, command.lastSeq);
          return;
        case 'text':
          this.onText(command.turnId, command.text);
          return;
        case 'abort_input':
          this.onAbortInput(command.turnId, command.reason);
          return;
        case 'interrupt':
          await this.onInterrupt(command.responseId);
          return;
        case 'playback_done':
          this.onPlaybackDone(command.responseId, command.skipped === true);
          return;
        case 'end':
          await this.close();
          return;
      }
    } catch {
      // A handler must never reject into main; surface a non-fatal notice.
      this.emitNotice('command_failed', 'That request could not be completed.');
    }
  }

  audio(frame: AudioFrame): void {
    if (this.closed) return;
    const input = this.input;
    // Drop frames that do not belong to the current open recording turn: no ACK.
    if (!input || input.status !== 'recording' || frame.turnId !== input.turnId) return;
    if (frame.seq < 1 || frame.seq > MAX_AUDIO_SEQUENCE) return;

    const fp = fingerprint(frame.pcm);

    if (frame.seq <= input.receivedSeq) {
      // Possible retransmit of an already-accepted frame.
      const known = input.fingerprints.get(frame.seq);
      if (known === fp) {
        // Benign duplicate: re-ACK without feeding the recognizer twice.
        this.emit({ type: 'audio_ack', turnId: input.turnId, seq: frame.seq });
      } else if (known !== undefined) {
        // Conflicting reuse of a committed sequence number: abort and repeat.
        this.failInput(input, 'discontinuity');
      }
      return;
    }

    if (frame.seq > input.receivedSeq + 1) {
      // Gap: audio must be contiguous. Drop without ACK so the client resends
      // from above the cumulative ack rather than committing a truncated prefix.
      return;
    }

    // Contiguous next frame. Enforce the independent per-turn byte ceiling.
    if (input.bytes + frame.pcm.byteLength > MAX_INPUT_BYTES) {
      this.failInput(input, 'overflow');
      return;
    }

    const accepted = this.speech?.writeAudio(frame.pcm) ?? false;
    if (!accepted) {
      // The recognizer refused the frame (closed/over-limit/cannot enqueue).
      // Never ACK dropped PCM; abort the unfinished input and ask for a repeat.
      this.failInput(input, 'overflow');
      return;
    }
    input.receivedSeq = frame.seq;
    input.bytes += frame.pcm.byteLength;
    this.rememberFingerprint(input, frame.seq, fp);
    this.emit({ type: 'audio_ack', turnId: input.turnId, seq: frame.seq });
  }

  snapshot(): ConversationSnapshot {
    const snapshot: ConversationSnapshot = {
      sessionId: this.id,
      mode: this.mode,
      phase: this.phase,
      speechAvailable: this.speechConfigured,
      lastTurnId: this.lastTurnId,
      messages: this.messages.map((m) => ({ ...m })),
    };
    if (this.input) {
      snapshot.input = {
        turnId: this.input.turnId,
        lastSeq: this.input.declaredLastSeq ?? this.input.receivedSeq,
        committed: this.input.status === 'committed',
      };
    }
    if (this.response) {
      snapshot.response = {
        turnId: this.response.turnId,
        responseId: this.response.responseId,
        lastAudioSeq: this.response.lastAudioSeq,
        finished: this.response.finished,
        audioInterrupted: this.response.audioInterrupted,
      };
    }
    if (this.capabilities) snapshot.capabilities = this.capabilities;
    if (this.notice) snapshot.notice = this.notice;
    return snapshot;
  }

  // --- recording ------------------------------------------------------------

  private async onRecord(turnId: number): Promise<void> {
    if (!this.speechConfigured || !this.speech) {
      this.emitNotice('speech_unavailable', 'Speech is not configured. You can still type a message.');
      return;
    }
    // Idempotent re-record of the current open turn: just re-signal readiness.
    if (this.input && this.input.turnId === turnId && this.input.status === 'recording') {
      this.emit({ type: 'input_ready', turnId });
      return;
    }
    if (this.isBusy()) {
      this.emitNotice('busy', 'Wait for the current turn to finish.');
      return;
    }
    if (turnId <= this.lastTurnId) {
      this.emitNotice('stale_turn', 'That turn is no longer current.');
      return;
    }

    // Reserve turn state before the async recognition handshake.
    const input: ActiveInput = {
      turnId,
      status: 'recording',
      receivedSeq: 0,
      bytes: 0,
      fingerprints: new Map(),
    };
    this.input = input;
    this.lastTurnId = turnId;
    this.setPhase('opening-input');

    try {
      await this.speech.startRecognition();
    } catch {
      if (this.input === input) {
        input.status = 'failed';
        this.input = undefined;
        this.setPhase('idle');
      }
      this.emitNotice('recognition_unavailable', 'Could not start listening. Try again or type your message.');
      return;
    }
    if (this.closed || this.input !== input) return;
    this.setPhase('recording');
    this.emit({ type: 'input_ready', turnId });
  }

  private async onFinish(turnId: number, lastSeq: number): Promise<void> {
    const input = this.input;
    // Idempotent finish of an already-committed turn (e.g. a reconnect replay).
    if (this.turnSignatures.get(turnId) === `audio:${lastSeq}`) return;
    if (!input || input.turnId !== turnId) {
      this.emitNotice('stale_turn', 'There is no recording to finish.');
      return;
    }
    if (input.status !== 'recording') return; // already committing/committed
    if (lastSeq !== input.receivedSeq) {
      // A declared last sequence we never fully received means missing tail
      // audio; refuse to commit a truncated prefix and ask for a repeat.
      this.failInput(input, 'discontinuity');
      return;
    }

    input.status = 'committing';
    input.declaredLastSeq = lastSeq;

    let text: string;
    try {
      text = (await this.speech!.commitRecognition()).trim();
    } catch {
      // STT failure resets only this unfinished input; no inference ran so
      // nothing is replayed.
      if (this.input === input) {
        input.status = 'failed';
        this.input = undefined;
        this.setPhase('idle');
      }
      this.emit({ type: 'input_aborted', turnId, reason: 'stt_error' });
      this.emitNotice('repeat', 'That did not come through. Please say it again.');
      return;
    }
    if (this.closed || this.input !== input) return;

    if (!text) {
      input.status = 'aborted';
      this.input = undefined;
      this.turnSignatures.set(turnId, `audio:${lastSeq}`);
      this.trimTurnSignatures();
      this.setPhase('idle');
      this.emitNotice('no_speech', 'No speech was recognized. Try again or type your message.');
      return;
    }

    input.status = 'committed';
    this.turnSignatures.set(turnId, `audio:${lastSeq}`);
    this.trimTurnSignatures();
    this.recordUser(turnId, text);
    this.beginInference(turnId, text);
  }

  private onText(turnId: number, text: string): void {
    const signature = `text:${textSignature(text)}`;
    const existing = this.turnSignatures.get(turnId);
    if (existing === signature) return; // idempotent replay
    if (existing !== undefined || turnId <= this.lastTurnId) {
      this.emitNotice('stale_turn', 'That turn is no longer current.');
      return;
    }
    if (this.isBusy()) {
      this.emitNotice('busy', 'Wait for the current turn to finish.');
      return;
    }
    this.lastTurnId = turnId;
    this.turnSignatures.set(turnId, signature);
    this.trimTurnSignatures();
    this.recordUser(turnId, text);
    this.beginInference(turnId, text);
  }

  private onAbortInput(turnId: number, reason: string): void {
    const input = this.input;
    if (!input || input.turnId !== turnId) return;
    if (input.status !== 'recording' && input.status !== 'committing') return;
    try {
      this.speech?.abortRecognition();
    } catch {
      /* best-effort */
    }
    input.status = 'aborted';
    this.input = undefined;
    this.setPhase('idle');
    this.emit({ type: 'input_aborted', turnId, reason });
    this.emitNotice('repeat', 'Recording stopped. Please repeat your message.');
  }

  // --- inference / response -------------------------------------------------

  private beginInference(turnId: number, text: string): void {
    if (this.closed || !this.harness) return;
    // Reserve the response id/state before the long-running send await.
    const response: ActiveResponse = {
      turnId,
      responseId: ++this.nextResponseId,
      audioSeq: 0,
      lastAudioSeq: 0,
      finished: false,
      cancelled: false,
      audioInterrupted: false,
      ttsSuppressed: this.sink === undefined,
      inferenceActive: true,
      awaitingPlayback: false,
      assistantIndex: undefined,
    };
    // A response created while detached has no audience for TTS; suppress it up
    // front so we never synthesize unheard audio.
    if (response.ttsSuppressed) response.audioInterrupted = true;
    this.response = response;
    this.input = undefined;
    this.setPhase('thinking');
    // Run detached so interrupts can be handled while inference is in flight.
    this.inference = this.runInference(response, text);
  }

  private async runInference(response: ActiveResponse, text: string): Promise<void> {
    try {
      await this.harness!.send(text);
    } catch {
      response.inferenceActive = false;
      if (response.cancelled || this.closed) return;
      // Inference failed on its own. Cancel any partial synthesis and reset.
      try {
        this.speech?.cancelSpeech();
      } catch {
        /* ignore */
      }
      if (this.response === response) this.setPhase('idle');
      this.emit({ type: 'error', code: 'inference_failed', message: 'The response could not be completed.', fatal: false });
      return;
    }
    response.inferenceActive = false;
    if (response.cancelled || this.closed) return;

    // Flush and await final TTS unless output was suppressed (detached / no audience).
    if (this.speech && !response.ttsSuppressed) {
      try {
        await this.speech.finishSpeech();
      } catch {
        if (response.cancelled || this.closed) return;
        response.audioInterrupted = true;
      }
    }
    if (response.cancelled || this.closed) return;

    response.finished = true;
    response.lastAudioSeq = response.audioSeq;
    if (response.lastAudioSeq > 0 && !response.ttsSuppressed) {
      response.awaitingPlayback = true;
      this.setPhase('speaking');
    } else {
      this.setPhase('idle');
    }
    this.emit({
      type: 'response_done',
      turnId: response.turnId,
      responseId: response.responseId,
      lastAudioSeq: response.lastAudioSeq,
    });
  }

  private async onInterrupt(responseId: number): Promise<void> {
    const response = this.response;
    if (!response || response.responseId !== responseId) return; // stale/unknown
    if (response.cancelled) return;
    response.cancelled = true;
    response.audioInterrupted = true;
    this.setPhase('interrupting');

    // Clear unheard output immediately on a separate synthesis epoch.
    try {
      this.speech?.cancelSpeech();
    } catch {
      /* ignore */
    }

    // Only wait for a real inference settlement; playback-only has no result.
    if (response.inferenceActive && this.harness) {
      try {
        await this.harness.interrupt();
      } catch {
        // The interrupt could not be confirmed: the harness has quarantined the
        // still-live generation and can no longer serve turns. Do NOT announce a
        // settled cancellation or reopen admission — that would fabricate
        // continuity over generation that may still complete. Keep the fence
        // (response stays cancelled/uncleared) and surface a fatal, closed
        // recovery outcome instead.
        response.audioInterrupted = true;
        this.emit({ type: 'error', code: 'interrupt_failed', message: 'Could not stop the response cleanly.', fatal: true });
        void this.close();
        return;
      }
    }
    response.inferenceActive = false;
    response.finished = true;
    this.emit({ type: 'response_cancelled', responseId });
    if (!this.closed) this.setPhase('idle');
  }

  private onPlaybackDone(responseId: number, skipped: boolean): void {
    const response = this.response;
    if (!response || response.responseId !== responseId || !response.awaitingPlayback) return;
    response.awaitingPlayback = false;
    if (skipped) response.audioInterrupted = true;
    if (!this.closed && this.phase === 'speaking') this.setPhase('idle');
  }

  // --- harness / speech callbacks ------------------------------------------

  private onHarness(event: HarnessEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case 'ready':
        this.captureCapabilities(event);
        return;
      case 'text': {
        const response = this.response;
        if (!response || !response.inferenceActive || response.cancelled) return;
        this.appendAssistant(response, event.text);
        this.emit({ type: 'text', turnId: response.turnId, responseId: response.responseId, text: event.text });
        if (this.speech && !response.ttsSuppressed) {
          try {
            this.speech.writeText(event.text);
          } catch {
            response.audioInterrupted = true;
            this.emitNotice('tts_error', 'Speech output failed for this response.');
          }
        }
        return;
      }
      case 'tool': {
        const response = this.response;
        if (!response || response.cancelled) return;
        this.emit({ type: 'tool', responseId: response.responseId, name: event.name, status: event.status });
        return;
      }
      case 'error': {
        // A turn-scoped error also rejects harness.send(), which runInference
        // handles. Only an error with no inference in flight is session-fatal.
        if (this.response?.inferenceActive) return;
        this.emit({ type: 'error', code: 'harness_failed', message: 'The local inference process failed.', fatal: true });
        void this.close();
        return;
      }
    }
  }

  private onPartial(text: string): void {
    if (this.closed) return;
    const input = this.input;
    if (input && input.status === 'recording') {
      this.emit({ type: 'partial', turnId: input.turnId, text });
    }
  }

  private onAudio(audio: string, sampleRate: number): void {
    if (this.closed) return;
    const response = this.response;
    // Epoch fence: drop audio for a cancelled/suppressed or superseded response.
    if (!response || response.cancelled || response.ttsSuppressed || response.finished) return;
    const seq = ++response.audioSeq;
    response.lastAudioSeq = seq;
    if (this.phase === 'thinking') this.setPhase('speaking');
    this.emit({
      type: 'audio',
      turnId: response.turnId,
      responseId: response.responseId,
      seq,
      audio,
      sampleRate,
    });
  }

  private onSpeechError(message: string): void {
    if (this.closed) return;
    const input = this.input;
    if (input && input.status === 'recording') {
      // STT dropped before commit: reset only the unfinished input.
      input.status = 'failed';
      this.input = undefined;
      this.setPhase('idle');
      this.emit({ type: 'input_aborted', turnId: input.turnId, reason: 'stt_error' });
      this.emitNotice('repeat', 'That did not come through. Please say it again.');
      return;
    }
    const response = this.response;
    if (response && !response.cancelled) {
      response.audioInterrupted = true;
      this.emitNotice('tts_error', 'Speech output failed for this response.');
      return;
    }
    this.emitNotice('speech_error', 'The speech connection reported a problem.');
    void message;
  }

  // --- helpers --------------------------------------------------------------

  private captureCapabilities(event: Extract<HarnessEvent, { type: 'ready' }>): void {
    const tools = event.tools ?? [];
    const web = tools.includes('WebSearch') || tools.includes('WebFetch');
    let fermi: ToolCapabilities['fermi'] = 'pending';
    if (event.mcp) {
      const server = event.mcp.find((m) => m.name === 'fermi');
      fermi = server ? (server.status === 'connected' ? 'connected' : 'unavailable') : 'unavailable';
    }
    this.capabilities = { web, fermi, tools: [...tools] };
    this.emit({ type: 'capabilities', capabilities: this.capabilities });
  }

  /** True when a turn is being recorded, committed, or answered. */
  private isBusy(): boolean {
    const response = this.response;
    if (response) {
      // Busy for the whole response lifecycle: inference, TTS synthesis
      // finalization (the window after inference resolves but before
      // finishSpeech settles), and playback acknowledgement. Admitting a new
      // turn during synthesis finalization would retag the previous response's
      // trailing audio.
      if (!response.finished && !response.cancelled) return true;
      if (response.awaitingPlayback) return true;
    }
    if (this.input && (this.input.status === 'recording' || this.input.status === 'committing')) return true;
    return this.phase === 'interrupting';
  }

  private failInput(input: ActiveInput, reason: 'overflow' | 'discontinuity'): void {
    try {
      this.speech?.abortRecognition();
    } catch {
      /* best-effort */
    }
    input.status = 'aborted';
    if (this.input === input) {
      this.input = undefined;
      this.setPhase('idle');
    }
    this.emit({ type: 'input_aborted', turnId: input.turnId, reason });
    this.emitNotice('repeat', 'That did not come through. Please repeat your message.');
  }

  private recordUser(turnId: number, text: string): void {
    this.pushMessage({ turnId, role: 'user', text });
    this.emit({ type: 'user', turnId, text });
  }

  private appendAssistant(response: ActiveResponse, text: string): void {
    if (response.assistantIndex === undefined) {
      this.pushMessage({ turnId: response.turnId, role: 'assistant', text });
      response.assistantIndex = this.messages.length - 1;
    } else {
      const entry = this.messages[response.assistantIndex];
      if (entry && entry.role === 'assistant' && entry.turnId === response.turnId) {
        entry.text += text;
      } else {
        // The entry was trimmed away; start a fresh one.
        this.pushMessage({ turnId: response.turnId, role: 'assistant', text });
        response.assistantIndex = this.messages.length - 1;
      }
    }
  }

  private pushMessage(entry: TranscriptEntry): void {
    this.messages.push(entry);
    if (this.messages.length > MAX_MESSAGES) {
      const dropped = this.messages.length - MAX_MESSAGES;
      this.messages.splice(0, dropped);
      // Keep the current assistant pointer valid after trimming from the front.
      if (this.response?.assistantIndex !== undefined) {
        this.response.assistantIndex = Math.max(0, this.response.assistantIndex - dropped);
      }
    }
  }

  private rememberFingerprint(input: ActiveInput, seq: number, fp: number): void {
    input.fingerprints.set(seq, fp);
    if (input.fingerprints.size > FINGERPRINT_WINDOW) {
      const oldest = input.fingerprints.keys().next().value;
      if (oldest !== undefined) input.fingerprints.delete(oldest);
    }
  }

  private trimTurnSignatures(): void {
    // Keep only the most recent turn signatures for idempotent replay handling.
    while (this.turnSignatures.size > 16) {
      const oldest = this.turnSignatures.keys().next().value;
      if (oldest === undefined) break;
      this.turnSignatures.delete(oldest);
    }
  }

  private setPhase(phase: ConversationPhase): void {
    if (this.phase === phase || this.closed) return;
    this.phase = phase;
    this.emit({ type: 'state', phase });
  }

  private emitNotice(code: string, message: string): void {
    this.notice = message;
    this.emit({ type: 'notice', code, message });
  }

  private emit(event: RealtimeEvent): void {
    const sink = this.sink;
    if (!sink) return;
    try {
      sink(event);
    } catch {
      // A faulty sink must not tear down the coordinator.
    }
  }
}

export function createConversation(options: ConversationOptions): RetainedConversation {
  if (typeof options?.harness !== 'function') {
    throw new TypeError('createConversation requires a harness factory.');
  }
  return new Conversation(options);
}
