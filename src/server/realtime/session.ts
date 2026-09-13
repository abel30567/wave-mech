import type { HarnessEvent } from '../../shared/contracts.js';
import { DiagnosticLog, type DiagnosticReason, type DiagnosticStatus } from '../../shared/diagnostics.js';
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

const MAX_INPUT_BYTES = PCM_RATE * 2 * 120;
const MAX_MESSAGES = 200;
const FINGERPRINT_WINDOW = 256;

const SAFE_SPEECH_CATEGORIES = new Set([
  'stt_error', 'tts_error', 'connection_lost', 'timeout', 'quota_exceeded',
]);

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
  private readonly turnSignatures = new Map<number, string>();
  private inference: Promise<void> | undefined;

  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  private readonly diagnostics: DiagnosticLog;
  private readonly onSpeechDiagnostic: ((category: string, detail?: string) => void) | undefined;

  constructor(private readonly options: ConversationOptions) {
    this.id = options.id;
    this.mode = options.mode;
    this.now = options.now ?? Date.now;
    this.speechConfigured = typeof options.speech === 'function';
    this.diagnostics = new DiagnosticLog('server', this.now);
    this.onSpeechDiagnostic = options.onSpeechDiagnostic;
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
    this.sink = send;
    send({ type: 'snapshot', snapshot: this.snapshot() });
  }

  detach(): void {
    this.sink = undefined;
    const response = this.response;
    if (response && !response.finished && !response.cancelled && !response.ttsSuppressed) {
      response.ttsSuppressed = true;
      response.audioInterrupted = true;
      try {
        this.speech?.cancelSpeech();
      } catch {
        /* best-effort */
      }
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.phase = 'closed';
    this.diagnostics.add({ kind: 'session_closed' });
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
      this.emitNotice('command_failed', 'That request could not be completed.');
    }
  }

  audio(frame: AudioFrame): void {
    if (this.closed) return;
    const input = this.input;
    if (!input || input.status !== 'recording' || frame.turnId !== input.turnId) return;
    if (frame.seq < 1 || frame.seq > MAX_AUDIO_SEQUENCE) return;

    const fp = fingerprint(frame.pcm);

    if (frame.seq <= input.receivedSeq) {
      const known = input.fingerprints.get(frame.seq);
      if (known === fp) {
        this.emit({ type: 'audio_ack', turnId: input.turnId, seq: frame.seq });
      } else if (known !== undefined) {
        this.failInput(input, 'discontinuity');
      }
      return;
    }

    if (frame.seq > input.receivedSeq + 1) {
      return;
    }

    if (input.bytes + frame.pcm.byteLength > MAX_INPUT_BYTES) {
      this.failInput(input, 'overflow');
      return;
    }

    const accepted = this.speech?.writeAudio(frame.pcm) ?? false;
    if (!accepted) {
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
    snapshot.diagnostics = this.diagnostics.snapshot();
    return snapshot;
  }

  // --- recording ------------------------------------------------------------

  private async onRecord(turnId: number): Promise<void> {
    if (!this.speechConfigured || !this.speech) {
      this.emitNotice('speech_unavailable', 'Speech is not configured. You can still type a message.');
      return;
    }
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
    if (this.turnSignatures.get(turnId) === `audio:${lastSeq}`) return;
    if (!input || input.turnId !== turnId) {
      this.emitNotice('stale_turn', 'There is no recording to finish.');
      return;
    }
    if (input.status !== 'recording') return;
    if (lastSeq !== input.receivedSeq) {
      this.failInput(input, 'discontinuity');
      return;
    }

    input.status = 'committing';
    input.declaredLastSeq = lastSeq;

    let text: string;
    try {
      text = (await this.speech!.commitRecognition()).trim();
    } catch {
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
    if (existing === signature) return;
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
    if (response.ttsSuppressed) response.audioInterrupted = true;
    this.response = response;
    this.input = undefined;
    this.setPhase('thinking');
    this.diagnostics.add({ kind: 'turn_start', detail: `turnId=${turnId} responseId=${response.responseId}` });
    this.inference = this.runInference(response, text);
  }

  private async runInference(response: ActiveResponse, text: string): Promise<void> {
    try {
      await this.harness!.send(text);
    } catch {
      response.inferenceActive = false;
      if (response.cancelled || this.closed) return;
      try {
        this.speech?.cancelSpeech();
      } catch {
        /* ignore */
      }
      if (this.response === response) this.setPhase('idle');
      this.diagnostics.add({ kind: 'inference_failed', detail: `turnId=${response.turnId}` });
      this.emit({ type: 'error', code: 'inference_failed', message: 'The response could not be completed.', fatal: false });
      return;
    }
    response.inferenceActive = false;
    if (response.cancelled || this.closed) return;

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
    if (!response || response.responseId !== responseId) return;
    if (response.cancelled) return;
    response.cancelled = true;
    response.audioInterrupted = true;
    this.setPhase('interrupting');
    this.diagnostics.add({ kind: 'interruption', detail: `responseId=${responseId}` });

    try {
      this.speech?.cancelSpeech();
    } catch {
      /* ignore */
    }

    if (response.inferenceActive && this.harness) {
      try {
        await this.harness.interrupt();
      } catch {
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
        const callId = event.callId;
        this.emit({ type: 'tool', responseId: response.responseId, name: event.name, status: event.status, callId });
        if (event.status !== 'running') {
          this.diagnostics.record({
            callId: callId ?? `unknown-${this.now()}`,
            name: event.name,
            status: event.status as DiagnosticStatus,
            durationMs: event.durationMs,
            reason: (event.reason as DiagnosticReason) ?? undefined,
            statusCode: event.statusCode,
            turnId: response.turnId,
            responseId: response.responseId,
          });
          this.emitDiagnostic();
        }
        return;
      }
      case 'error': {
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

    const safeCategory = this.classifySpeechError(message);
    if (this.onSpeechDiagnostic) {
      try {
        this.onSpeechDiagnostic(safeCategory);
      } catch {
        /* ignore callback errors */
      }
    }
    this.diagnostics.add({ kind: 'speech_error', detail: safeCategory });

    const input = this.input;
    if (input && input.status === 'recording') {
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
  }

  private classifySpeechError(message: string): string {
    const lower = message.toLowerCase();
    if (lower.includes('timeout')) return 'timeout';
    if (lower.includes('quota')) return 'quota_exceeded';
    if (lower.includes('connection') || lower.includes('disconnect')) return 'connection_lost';
    if (lower.includes('stt') || lower.includes('recognition') || lower.includes('transcri')) return 'stt_error';
    if (lower.includes('tts') || lower.includes('synthe') || lower.includes('speech')) return 'tts_error';
    return 'unknown';
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
    const model = event.model;
    this.capabilities = { web, fermi, tools: [...tools] };
    if (model) this.capabilities.model = model;
    if (model) this.diagnostics.setModel(model);
    this.diagnostics.add({ kind: 'connection_ready' });
    this.emit({ type: 'capabilities', capabilities: this.capabilities });
  }

  private isBusy(): boolean {
    const response = this.response;
    if (response) {
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

  private emitDiagnostic(): void {
    this.emit({ type: 'diagnostic', snapshot: this.diagnostics.snapshot() });
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
