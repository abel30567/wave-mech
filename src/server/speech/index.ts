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
// Deliberately small: the caller drives one manual turn at a time, so a large
// backlog means the peer is unhealthy rather than merely slow.
const MAX_QUEUED_FRAMES = 256;

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
      ws = await connect(url, timeoutMs);
    } catch (error) {
      this.opening = false;
      throw error;
    }
    this.opening = false;
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
    if (this.queue.length >= MAX_QUEUED_FRAMES) {
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
    const ws = this.ws;
    this.ws = undefined;
    this.opening = false;
    this.queue.length = 0;
    if (ws) {
      ws.removeAllListeners();
      // close() is safe on any state; terminate lingering handshakes.
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close();
    }
  }
}

function connect(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
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
  });
}

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

export function createSpeech(options: SpeechOptions): SpeechSession {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sttEndpoint = options.endpoints?.stt ?? DEFAULT_STT_ENDPOINT;
  const ttsEndpoint = options.endpoints?.tts ?? DEFAULT_TTS_ENDPOINT;

  let closed = false;

  // --- Speech-to-text (persistent across manual turns) ----------------------
  let stt: SpeechSocket | undefined;
  let pendingCommit: Pending<string> | undefined;

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
    const socket = new SpeechSocket(handleSttFrame, (message) => {
      settleCommit(new Error(message));
      options.onError(message);
      if (stt === socket) stt = undefined;
    });
    stt = socket;
    const token = await options.getToken('realtime_scribe');
    if (closed) {
      socket.teardown();
      throw new Error('speech_closed');
    }
    try {
      await socket.open(withSttToken(sttEndpoint, token), timeoutMs);
    } catch (error) {
      if (stt === socket) stt = undefined;
      throw error;
    }
  };

  const writeAudio = (pcm: Uint8Array): void => {
    if (closed || !stt) return;
    stt.send(sttChunkFrame(Buffer.from(pcm).toString('base64')));
  };

  const commitRecognition = (): Promise<string> => {
    if (closed) return Promise.reject(new Error('speech_closed'));
    if (!stt) return Promise.reject(new Error('speech_no_active_turn'));
    if (pendingCommit) return Promise.reject(new Error('speech_commit_in_progress'));
    stt.send(sttCommitFrame());
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCommit = undefined;
        reject(new Error('speech_commit_timeout'));
      }, timeoutMs);
      pendingCommit = { resolve, reject, timer };
    });
  };

  // --- Text-to-speech (one socket per response) -----------------------------
  let tts: SpeechSocket | undefined;
  let ttsStarting: Promise<void> | undefined;
  let pendingFinish: Pending<void> | undefined;

  const settleFinish = (error: Error): void => {
    if (!pendingFinish) return;
    clearTimeout(pendingFinish.timer);
    const reject = pendingFinish.reject;
    pendingFinish = undefined;
    reject(error);
  };

  const teardownTts = (): void => {
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
    const socket = new SpeechSocket(handleTtsFrame, (message) => {
      settleFinish(new Error(message));
      options.onError(message);
      if (tts === socket) teardownTts();
    });
    tts = socket;
    socket.send(ttsInitFrame());
    ttsStarting = (async () => {
      const token = await options.getToken('tts_websocket');
      if (closed) {
        socket.teardown();
        return;
      }
      await socket.open(withTtsToken(ttsEndpoint, options.voiceId, token), timeoutMs);
    })().catch((error) => {
      if (tts === socket) teardownTts();
      settleFinish(error instanceof Error ? error : new Error('speech_synthesis_failed'));
      options.onError('speech_synthesis_failed');
    });
  };

  const writeText = (text: string): void => {
    if (closed) return;
    ensureTts();
    tts?.send(ttsTextFrame(text));
  };

  const finishSpeech = (): Promise<void> => {
    if (closed) return Promise.reject(new Error('speech_closed'));
    if (!tts) return Promise.resolve(); // nothing was spoken this turn
    if (pendingFinish) return Promise.reject(new Error('speech_finish_in_progress'));
    tts.send(ttsFlushFrame());
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingFinish = undefined;
        reject(new Error('speech_finish_timeout'));
      }, timeoutMs);
      pendingFinish = { resolve, reject, timer };
    });
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    settleCommit(new Error('speech_closed'));
    settleFinish(new Error('speech_closed'));
    stt?.teardown();
    stt = undefined;
    teardownTts();
  };

  return {
    startRecognition,
    writeAudio,
    commitRecognition,
    writeText,
    finishSpeech,
    close,
  };
}
