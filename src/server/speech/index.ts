import { WebSocket, type RawData } from 'ws';
import type { SpeechOptions, SpeechSession } from '../../shared/contracts.js';
import {
  DEFAULT_STT_ENDPOINT,
  DEFAULT_TTS_ENDPOINT,
  TTS_SAMPLE_RATE,
  parseSttEvent,
  parseTtsEvent,
  sttChunkFrame,
  sttCommitFrame,
  ttsFlushFrame,
  ttsInitFrame,
  ttsTextFrame,
  withSttToken,
  withTtsToken,
} from './protocol.js';

const DEFAULT_TIMEOUT_MS = 15_000;
// ElevenLabs' TTS `stream-input` socket closes after 20 s of inactivity (its
// default `inactivity_timeout`). During a long Fermi tool wait the model can
// open TTS with a preamble and then pause well past that window, so the socket
// is silently dropped and the eventual continuation fails. The documented
// keepalive is a single space, which resets the idle timer WITHOUT ending
// generation — an *empty* string would be the End-of-Sequence and close the
// stream, so it must never be used as a keepalive. We ping comfortably inside
// the window. (Bounded: it runs only while a TTS socket is open and is cleared
// on flush/cancel/teardown/close.)
const DEFAULT_TTS_KEEPALIVE_MS = 15_000;

/** Internal, non-contract tuning knobs (kept out of the shared SpeechOptions). */
export interface SpeechTuning {
  /** Interval between TTS idle keepalive pings; must stay below the server's idle timeout. */
  ttsKeepAliveMs?: number;
}
// Deliberately small: the caller drives one manual turn at a time, so a large
// backlog means the peer is unhealthy rather than merely slow.
const MAX_QUEUED_FRAMES = 256;
// Independent per-recognition ceiling (~120s of mono PCM16 @ 16 kHz). acceptAudio
// refuses frames past this rather than silently reporting success, so the
// coordinator's own bound is not the only line of defence.
const MAX_RECOGNITION_BYTES = 16_000 * 2 * 120;

interface Pending<T> {
  resolve(value: T): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A single ElevenLabs realtime socket with an outbound frame queue that holds
 * frames until the connection is open, then drains them in order. Tokens are
 * supplied by the caller and are never logged or surfaced in error messages.
 */
class SpeechSocket {
  private ws: WebSocket | undefined;
  private opening = false;
  private closed = false;
  private cancelConnect: (() => void) | undefined;
  private readonly queue: string[] = [];
  overflowed = false;

  constructor(
    private readonly onFrame: (raw: string) => void,
    private readonly onFailure: (message: string) => void,
  ) {}

  get isActive(): boolean {
    return this.opening || this.ws !== undefined;
  }

  async open(url: string, timeoutMs: number): Promise<void> {
    this.opening = true;
    let ws: WebSocket;
    try {
      ws = await connect(url, timeoutMs, (cancel) => { this.cancelConnect = cancel; });
    } catch (error) {
      this.opening = false;
      this.cancelConnect = undefined;
      throw error;
    }
    this.cancelConnect = undefined;
    this.opening = false;
    if (this.closed) { ws.close(); throw new Error('speech_closed'); }
    this.ws = ws;
    ws.on('message', (data: RawData) => this.onFrame(rawToString(data)));
    ws.on('error', () => this.fail('speech_socket_error'));
    ws.on('close', () => this.fail('speech_socket_closed'));
    this.drain();
  }

  private fail(message: string): void {
    if (this.ws === undefined) return;
    this.teardown();
    this.onFailure(message);
  }

  send(frame: string): void {
    if (this.closed) return;
    if (this.queue.length >= MAX_QUEUED_FRAMES || (this.ws?.bufferedAmount ?? 0) > 1024 * 1024) {
      this.overflowed = true;
      this.onFailure('speech_buffer_overflow');
      return;
    }
    this.queue.push(frame);
    this.drain();
  }

  private drain(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    while (this.queue.length > 0) {
      const frame = this.queue.shift() as string;
      this.ws.send(frame);
    }
  }

  teardown(): void {
    this.closed = true;
    this.cancelConnect?.();
    this.cancelConnect = undefined;
    const ws = this.ws;
    this.ws = undefined;
    this.opening = false;
    this.queue.length = 0;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      // close() is safe on any state; terminate lingering handshakes.
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close();
    }
  }
}

function connect(url: string, timeoutMs: number, registerCancel: (cancel: () => void) => void): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { maxPayload: 1024 * 1024 });
    ws.on('error', () => {});
    const timer = setTimeout(() => {
      cleanup();
      ws.terminate();
      reject(new Error('speech_connect_timeout'));
    }, timeoutMs);
    const onOpen = (): void => {
      cleanup();
      resolve(ws);
    };
    // Never forward the underlying error text: it can echo the tokenized URL.
    const onError = (): void => {
      cleanup();
      ws.terminate();
      reject(new Error('speech_connect_failed'));
    };
    function cleanup(): void {
      clearTimeout(timer);
      ws.off('open', onOpen);
      ws.off('error', onError);
    }
    ws.on('open', onOpen);
    ws.on('error', onError);
    registerCancel(() => {
      cleanup();
      ws.terminate();
      reject(new Error('speech_closed'));
    });
  });
}

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

export function createSpeech(options: SpeechOptions, tuning: SpeechTuning = {}): SpeechSession {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sttEndpoint = options.endpoints?.stt ?? DEFAULT_STT_ENDPOINT;
  const ttsEndpoint = options.endpoints?.tts ?? DEFAULT_TTS_ENDPOINT;
  const ttsKeepAliveMs = tuning.ttsKeepAliveMs ?? DEFAULT_TTS_KEEPALIVE_MS;

  let closed = false;

  // --- Speech-to-text (persistent across manual turns) ----------------------
  let stt: SpeechSocket | undefined;
  let pendingCommit: Pending<string> | undefined;
  let lastAudio: Uint8Array | undefined;
  let acceptedBytes = 0;
  // Recognition epoch: bumped on abort/close so a socket that opens (or a final
  // frame that arrives) after cancellation can never feed a replacement turn.
  let sttGeneration = 0;

  const handleSttFrame = (raw: string): void => {
    const event = parseSttEvent(raw);
    if (event.kind === 'partial') {
      options.onPartial(event.text);
    } else if (event.kind === 'final') {
      if (pendingCommit) {
        clearTimeout(pendingCommit.timer);
        const resolve = pendingCommit.resolve;
        pendingCommit = undefined;
        resolve(event.text);
      }
    } else if (event.kind === 'error') {
      settleCommit(new Error('speech_recognition_error'));
      options.onError(event.message);
    }
  };

  const settleCommit = (error: Error): void => {
    if (!pendingCommit) return;
    clearTimeout(pendingCommit.timer);
    const reject = pendingCommit.reject;
    pendingCommit = undefined;
    reject(error);
  };

  const startRecognition = async (): Promise<void> => {
    if (closed) throw new Error('speech_closed');
    if (stt?.isActive) return; // reuse the socket for the next manual turn
    acceptedBytes = 0;
    const generation = sttGeneration;
    const socket = new SpeechSocket(handleSttFrame, (message) => {
      settleCommit(new Error(message));
      options.onError(message);
      if (stt === socket) stt = undefined;
    });
    stt = socket;
    const token = await options.getToken('realtime_scribe');
    if (closed || generation !== sttGeneration || stt !== socket) {
      socket.teardown();
      throw new Error(closed ? 'speech_closed' : 'speech_recognition_aborted');
    }
    try {
      await socket.open(withSttToken(sttEndpoint, token), timeoutMs);
    } catch (error) {
      if (stt === socket) stt = undefined;
      throw error;
    }
    // A cancellation may have landed while the socket was opening; never let an
    // orphaned-but-open socket become the active recognition.
    if (closed || generation !== sttGeneration || stt !== socket) {
      socket.teardown();
      if (stt === socket) stt = undefined;
      throw new Error(closed ? 'speech_closed' : 'speech_recognition_aborted');
    }
  };

  const writeAudio = (pcm: Uint8Array): void => {
    if (closed || !stt || !pcm.byteLength) return;
    // Hold one small frame so Finish can commit actual final audio, without
    // relying on undocumented empty-audio commits or sending samples twice.
    if (lastAudio) stt.send(sttChunkFrame(Buffer.from(lastAudio).toString('base64')));
    lastAudio = new Uint8Array(pcm);
  };

  /**
   * Streaming-path audio ingest. Unlike writeAudio it reports whether the frame
   * was actually accepted so the coordinator only ACKs real progress. It refuses
   * — never silently succeeds — when closed, without an active socket, while a
   * commit is settling, past the per-recognition ceiling, or when the socket
   * cannot enqueue.
   */
  const acceptAudio = (pcm: Uint8Array): boolean => {
    // Bind the active socket locally: a flush below can overflow and detach the
    // socket mid-call, and we must never dereference a torn-down `stt`.
    const socket = stt;
    if (closed || !socket || !socket.isActive) return false;
    if (pendingCommit) return false;
    if (!pcm || !pcm.byteLength) return false;
    if (socket.overflowed) return false;
    if (acceptedBytes + pcm.byteLength > MAX_RECOGNITION_BYTES) return false;
    // Flush the previously held frame; hold the current one for the commit.
    if (lastAudio) socket.send(sttChunkFrame(Buffer.from(lastAudio).toString('base64')));
    // The flush may have overflowed the socket or detached it via onFailure. Do
    // not claim the current frame was accepted when it could not be enqueued —
    // a truthful false lets the coordinator withhold the ACK and ask for a repeat.
    if (socket.overflowed || stt !== socket) return false;
    lastAudio = new Uint8Array(pcm);
    acceptedBytes += pcm.byteLength;
    return true;
  };

  /**
   * Discard the unfinished recognition without committing. The socket is torn
   * down so no server-side accumulated audio can leak into the next turn, and
   * the epoch is bumped so a late final/open cannot resolve a replacement.
   */
  const abortRecognition = (): void => {
    if (closed) return;
    sttGeneration++;
    settleCommit(new Error('speech_recognition_aborted'));
    lastAudio = undefined;
    acceptedBytes = 0;
    stt?.teardown();
    stt = undefined;
  };

  const commitRecognition = (): Promise<string> => {
    if (closed) return Promise.reject(new Error('speech_closed'));
    if (!stt) return Promise.reject(new Error('speech_no_active_turn'));
    if (pendingCommit) return Promise.reject(new Error('speech_commit_in_progress'));
    if (!lastAudio) return Promise.resolve('');
    const audio = Buffer.from(lastAudio).toString('base64');
    lastAudio = undefined;
    acceptedBytes = 0;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCommit = undefined;
        reject(new Error('speech_commit_timeout'));
      }, timeoutMs);
      pendingCommit = { resolve, reject, timer };
      stt!.send(sttCommitFrame(audio));
    });
  };

  // --- Text-to-speech (one socket per response) -----------------------------
  let tts: SpeechSocket | undefined;
  let ttsStarting: Promise<void> | undefined;
  let pendingFinish: Pending<void> | undefined;
  let textBuffer = '';
  // Synthesis epoch: bumped on cancel/close so a socket that finishes opening —
  // or an audio frame that arrives — after cancellation cannot feed a replacement.
  let ttsGeneration = 0;
  let ttsKeepAlive: ReturnType<typeof setTimeout> | undefined;

  const clearTtsKeepAlive = (): void => {
    if (ttsKeepAlive) clearTimeout(ttsKeepAlive);
    ttsKeepAlive = undefined;
  };

  // Keep an open-but-idle TTS socket alive during a long tool wait. A single
  // space resets the server's idle timer without ending generation; we never
  // send an empty string here (that is EOS). Re-armed after each real frame and
  // after each ping; cleared whenever the socket is finishing or torn down so a
  // ping can never race a flush or land after EOS.
  const armTtsKeepAlive = (): void => {
    clearTtsKeepAlive();
    const socket = tts;
    if (closed || !socket) return;
    ttsKeepAlive = setTimeout(() => {
      if (closed || tts !== socket || pendingFinish) return;
      socket.send(ttsTextFrame(' '));
      armTtsKeepAlive();
    }, ttsKeepAliveMs);
    (ttsKeepAlive as { unref?: () => void }).unref?.();
  };

  const settleFinish = (error: Error): void => {
    if (!pendingFinish) return;
    clearTimeout(pendingFinish.timer);
    const reject = pendingFinish.reject;
    pendingFinish = undefined;
    reject(error);
  };

  const teardownTts = (): void => {
    clearTtsKeepAlive();
    tts?.teardown();
    tts = undefined;
    ttsStarting = undefined;
  };

  const handleTtsFrame = (raw: string): void => {
    const event = parseTtsEvent(raw);
    if (event.error) {
      settleFinish(new Error('speech_synthesis_error'));
      options.onError(event.error);
      return;
    }
    if (event.ignore) return;
    if (event.audio) options.onAudio(event.audio, TTS_SAMPLE_RATE);
    if (event.final && pendingFinish) {
      clearTimeout(pendingFinish.timer);
      const resolve = pendingFinish.resolve;
      pendingFinish = undefined;
      resolve();
      teardownTts();
    }
  };

  const ensureTts = (): void => {
    if (tts || ttsStarting) return;
    const generation = ttsGeneration;
    const socket = new SpeechSocket(handleTtsFrame, (message) => {
      settleFinish(new Error(message));
      options.onError(message);
      if (tts === socket) teardownTts();
    });
    tts = socket;
    socket.send(ttsInitFrame());
    armTtsKeepAlive();
    ttsStarting = (async () => {
      const token = await options.getToken('tts_websocket');
      if (closed || generation !== ttsGeneration || tts !== socket) {
        socket.teardown();
        return;
      }
      await socket.open(withTtsToken(ttsEndpoint, options.voiceId, token), timeoutMs);
      // Cancellation may have landed while opening; drop the orphaned socket.
      if (closed || generation !== ttsGeneration || tts !== socket) {
        socket.teardown();
        if (tts === socket) teardownTts();
      }
    })().catch((error) => {
      if (tts === socket) teardownTts();
      // A cancellation that raced the open is expected, not a synthesis failure.
      if (closed || generation !== ttsGeneration) return;
      settleFinish(error instanceof Error ? error : new Error('speech_synthesis_failed'));
      options.onError('speech_synthesis_failed');
    });
  };

  const writeText = (text: string): void => {
    if (closed || !text) return;
    textBuffer += text;
    if (textBuffer.length > 8192) throw new Error('speech_text_overflow');
    let end = textBuffer.length;
    while (end > 0 && !/\s/.test(textBuffer[end - 1])) end--;
    if (!end) return;
    ensureTts();
    tts?.send(ttsTextFrame(textBuffer.slice(0, end)));
    textBuffer = textBuffer.slice(end);
    // Real text resets the idle window; re-arm so the next tool wait is covered.
    armTtsKeepAlive();
  };

  const finishSpeech = (): Promise<void> => {
    if (closed) return Promise.reject(new Error('speech_closed'));
    if (pendingFinish) return Promise.reject(new Error('speech_finish_in_progress'));
    // No more idle: we are about to send EOS, so a keepalive space must not race it.
    clearTtsKeepAlive();
    if (textBuffer) {
      ensureTts();
      tts?.send(ttsTextFrame(`${textBuffer} `));
      textBuffer = '';
    }
    if (!tts) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingFinish = undefined;
        reject(new Error('speech_finish_timeout'));
      }, timeoutMs);
      pendingFinish = { resolve, reject, timer };
      tts!.send(ttsFlushFrame());
    });
  };

  /**
   * Abandon the in-flight synthesis for a barged-in/superseded response. The
   * socket is torn down and the epoch bumped so late audio or a socket that was
   * still opening cannot bleed into the replacement response.
   */
  const cancelSpeech = (): void => {
    if (closed) return;
    ttsGeneration++;
    settleFinish(new Error('speech_cancelled'));
    textBuffer = '';
    teardownTts();
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    sttGeneration++;
    ttsGeneration++;
    lastAudio = undefined;
    acceptedBytes = 0;
    textBuffer = '';
    settleCommit(new Error('speech_closed'));
    settleFinish(new Error('speech_closed'));
    stt?.teardown();
    stt = undefined;
    teardownTts();
  };

  return {
    startRecognition,
    writeAudio,
    acceptAudio,
    abortRecognition,
    cancelSpeech,
    commitRecognition,
    writeText,
    finishSpeech,
    close,
  };
}
