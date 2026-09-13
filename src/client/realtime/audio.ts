import type { MicVAD, RealTimeVADOptions } from '@ricky0123/vad-web';
import {
  PREROLL_BYTES,
  PRODUCER_AUDIO_BYTES,
  PCM_RATE,
  type AudioMode,
  type HandsFreeAudio,
  type HandsFreeAudioOptions,
} from '../../shared/realtime.js';
import { decodePcm16Base64, encodePcm16 } from '../audio/pcm.js';
import { PreRoll, ProducerBacklog } from './capture-queue.js';

// Assets (the v5 Silero model and onnx WASM) are copied to `/vad/` by main's
// build. We never fetch from a CDN and pin a single WASM thread.
const ASSET_BASE = '/vad/';

interface OutputResponse {
  active: number;
  declared: boolean;
  cancelled: boolean;
  settle?: (result: 'played' | 'interrupted' | 'paused') => void;
}

/**
 * Hands-free capture + playback over one shared microphone stream and
 * AudioContext that live for the whole session. A confirmed VAD onset prefixes
 * the utterance with bounded pre-roll, then live frames are forwarded once each
 * through a bounded producer backlog. The whole-utterance array the VAD returns
 * at speech end is treated purely as an endpoint signal, never re-sent.
 *
 * Browser-only modules (`@ricky0123/vad-web`) are imported dynamically so Node
 * unit tests can drive the conversation client with an injected fake instead.
 */
export async function createHandsFreeAudio(options: HandsFreeAudioOptions): Promise<HandsFreeAudio> {
  const { MicVAD } = await import('@ricky0123/vad-web');

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const context = new AudioContext({ sampleRate: PCM_RATE });
  options.onState(context.state === 'running' ? 'ready' : 'suspended');

  // --- capture pipeline -----------------------------------------------------

  const preRoll = new PreRoll(PREROLL_BYTES);
  const backlog = new ProducerBacklog(PRODUCER_AUDIO_BYTES);
  let speaking = false;
  let suppressed = false;
  let pumpScheduled = false;
  let drainWaiters: Array<() => void> = [];

  const pump = (): void => {
    pumpScheduled = false;
    for (let chunk = backlog.dequeue(); chunk; chunk = backlog.dequeue()) {
      const copy = chunk.slice();
      options.onPcm(copy.buffer);
    }
    if (backlog.empty) {
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };
  const schedulePump = (): void => {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(pump);
  };
  const emitLive = (bytes: Uint8Array): void => {
    if (!backlog.enqueue(bytes)) {
      // The consumer fell behind: the prefix is truncated, so flag a
      // discontinuity instead of forwarding a broken segment.
      backlog.clear();
      options.onDiscontinuity();
      return;
    }
    schedulePump();
  };

  const frameToBytes = (frame: Float32Array): Uint8Array => new Uint8Array(encodePcm16(frame));

  const vadOptions: Partial<RealTimeVADOptions> = {
    model: 'v5',
    audioContext: context,
    startOnLoad: false,
    baseAssetPath: ASSET_BASE,
    onnxWASMBasePath: ASSET_BASE,
    getStream: async () => stream,
    // Keep the single shared stream open across turns: pausing the VAD must not
    // close the microphone.
    pauseStream: async () => {},
    resumeStream: async () => stream,
    ortConfig: (ort) => {
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = 'error';
    },
    onFrameProcessed: (_probs, frame) => {
      if (suppressed) return;
      const bytes = frameToBytes(frame);
      if (speaking) emitLive(bytes);
      else preRoll.push(bytes);
    },
    onSpeechRealStart: () => {
      if (suppressed) return;
      // Confirmed onset: notify synchronously, then emit the buffered pre-roll
      // before any live sample so the onset is never clipped.
      speaking = true;
      options.onSpeechStart();
      for (const chunk of preRoll.drain()) emitLive(chunk);
    },
    onSpeechEnd: () => {
      // The returned whole-segment array is only an endpoint signal.
      speaking = false;
      options.onSpeechEnd();
    },
    onVADMisfire: () => {
      speaking = false;
      preRoll.clear();
      options.onMisfire();
    },
  };

  let vad: MicVAD;
  try {
    vad = await MicVAD.new(vadOptions);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
    throw error instanceof Error ? error : new Error('VAD initialization failed.');
  }

  // --- output playback ------------------------------------------------------

  let nextStartTime = 0;
  const sources = new Set<AudioBufferSourceNode>();
  const responses = new Map<number, OutputResponse>();
  let closed = false;

  const responseFor = (responseId: number): OutputResponse => {
    let response = responses.get(responseId);
    if (!response) {
      response = { active: 0, declared: false, cancelled: false };
      responses.set(responseId, response);
    }
    return response;
  };
  const maybeSettle = (responseId: number): void => {
    const response = responses.get(responseId);
    if (!response?.settle) return;
    if (response.cancelled) {
      response.settle('interrupted');
      response.settle = undefined;
    } else if (context.state !== 'running') {
      response.settle('paused');
      response.settle = undefined;
    } else if (response.declared && response.active === 0) {
      response.settle('played');
      response.settle = undefined;
    }
  };

  // --- mode control ---------------------------------------------------------

  let mode: AudioMode = 'paused';
  const applyMode = async (next: AudioMode): Promise<void> => {
    mode = next;
    const listening = next === 'listen' || next === 'barge';
    suppressed = !listening;
    if (next === 'muted') stream.getAudioTracks().forEach((track) => (track.enabled = false));
    else stream.getAudioTracks().forEach((track) => (track.enabled = true));
    try {
      if (listening) await vad.start();
      else {
        await vad.pause();
        speaking = false;
      }
    } catch (error) {
      options.onError(error instanceof Error ? error.message : 'Audio mode change failed.');
    }
  };

  return {
    setMode(next: AudioMode): void {
      if (closed || next === mode) return;
      void applyMode(next);
    },

    flushInput(): Promise<void> {
      schedulePump();
      if (backlog.empty) return Promise.resolve();
      return new Promise<void>((resolve) => drainWaiters.push(resolve));
    },

    clearInput(): void {
      speaking = false;
      preRoll.clear();
      backlog.clear();
      drainWaiters = [];
    },

    enqueueOutput(audio: string, sampleRate: number, responseId: number, seq: number): void {
      if (closed) return;
      void seq; // ordering is guaranteed by the server's sequential delivery
      const response = responseFor(responseId);
      if (response.cancelled) return;
      const samples = decodePcm16Base64(audio);
      if (samples.length === 0) return;
      const buffer = context.createBuffer(1, samples.length, sampleRate);
      buffer.getChannelData(0).set(samples);
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      response.active += 1;
      sources.add(node);
      node.onended = (): void => {
        node.disconnect();
        sources.delete(node);
        response.active -= 1;
        maybeSettle(responseId);
      };
      const startAt = Math.max(context.currentTime, nextStartTime);
      node.start(startAt);
      nextStartTime = startAt + buffer.duration;
    },

    finishOutput(responseId: number, lastSeq: number): Promise<'played' | 'interrupted' | 'paused'> {
      void lastSeq;
      if (closed) return Promise.resolve('interrupted');
      const response = responseFor(responseId);
      response.declared = true;
      if (response.cancelled) return Promise.resolve('interrupted');
      if (context.state !== 'running') return Promise.resolve('paused');
      if (response.active === 0) return Promise.resolve('played');
      return new Promise((resolve) => {
        response.settle = resolve;
      });
    },

    cancelOutput(responseId?: number): void {
      nextStartTime = 0;
      for (const node of [...sources]) {
        node.onended = null;
        try {
          node.stop();
        } catch {
          /* already stopped */
        }
        node.disconnect();
        sources.delete(node);
      }
      for (const [id, response] of responses) {
        if (responseId !== undefined && id !== responseId) continue;
        response.cancelled = true;
        response.active = 0;
        if (response.settle) {
          response.settle('interrupted');
          response.settle = undefined;
        }
      }
    },

    async resume(): Promise<void> {
      if (closed) return;
      try {
        await context.resume();
      } catch {
        /* a later gesture retries */
      }
      if (context.state === 'running') {
        options.onState('ready');
        for (const id of responses.keys()) maybeSettle(id);
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const response of responses.values()) {
        if (response.settle) {
          response.settle('interrupted');
          response.settle = undefined;
        }
      }
      try {
        await vad.destroy();
      } catch {
        /* best effort */
      }
      stream.getTracks().forEach((track) => track.stop());
      try {
        await context.close();
      } catch {
        /* already closed */
      }
      options.onState('closed');
    },
  };
}
