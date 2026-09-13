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

// A single confirmed utterance is capped so the VAD library's own internal
// segment retention (which otherwise grows unbounded until speech end) cannot
// hold more than ~120 s of audio. At 16 kHz PCM16 that is 2 bytes/sample.
const MAX_UTTERANCE_BYTES = PCM_RATE * 2 * 120;

// Playback is bounded so a slow or suspended AudioContext cannot retain an
// unlimited number of scheduled buffer sources. Once this many seconds of
// undrained output has been scheduled we stop allocating and mark the response
// so its completion reports honestly (interrupted, never "played").
const MAX_OUTPUT_SECONDS = 30;

interface OutputResponse {
  active: number;
  declared: boolean;
  cancelled: boolean;
  overflowed: boolean;
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
  // Bytes forwarded for the current confirmed utterance (pre-roll + live). Used
  // to bound the VAD library's own segment retention to MAX_UTTERANCE_BYTES.
  let utteranceBytes = 0;
  let vad: MicVAD;
  let resettingSegment = false;

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

  // Discard the VAD library's internally-retained partial segment using only
  // its public API. With `submitUserSpeechOnPause: false` a pause resets the
  // frame processor's audio buffer (no automatic partial-prefix commit); a
  // start resumes capture on the still-open shared stream. Used on overflow,
  // the 120 s cap, and explicit aborts so retention never grows without bound.
  const resetVadSegment = (): void => {
    if (resettingSegment || suppressed) return;
    resettingSegment = true;
    void (async () => {
      try {
        await vad.pause();
        if (!suppressed && !closed) await vad.start();
      } catch {
        /* a later mode change re-establishes capture */
      } finally {
        resettingSegment = false;
      }
    })();
  };

  // Abandon the in-flight utterance without claiming it was delivered: clear the
  // producer/pre-roll buffers, reset the VAD's internal segment, and surface the
  // discontinuity so the caller aborts rather than committing a truncated prefix.
  const abandonUtterance = (): void => {
    speaking = false;
    utteranceBytes = 0;
    backlog.clear();
    preRoll.clear();
    resetVadSegment();
    options.onDiscontinuity();
  };

  const emitLive = (bytes: Uint8Array): void => {
    if (!backlog.enqueue(bytes)) {
      // The consumer fell behind: the prefix is truncated, so flag a
      // discontinuity instead of forwarding a broken segment, and stop the
      // VAD retaining the rest of a segment we can no longer deliver.
      abandonUtterance();
      return;
    }
    utteranceBytes += bytes.byteLength;
    schedulePump();
    if (utteranceBytes >= MAX_UTTERANCE_BYTES) {
      // The talker never paused: bound the VAD's own retention at ~120 s rather
      // than let its internal segment grow without limit.
      abandonUtterance();
    }
  };

  const frameToBytes = (frame: Float32Array): Uint8Array => new Uint8Array(encodePcm16(frame));

  const vadOptions: Partial<RealTimeVADOptions> = {
    model: 'v5',
    audioContext: context,
    startOnLoad: false,
    // A pause must discard the internal segment, never auto-commit a partial
    // prefix as a finished utterance.
    submitUserSpeechOnPause: false,
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
      // Confirmed onset: notify synchronously, then hand the buffered pre-roll
      // to the pump as an ordered prefix ahead of live frames. The pre-roll is
      // already bounded to PREROLL_BYTES, so it is delivered without counting
      // against the (smaller) live producer budget — the previous synchronous
      // enqueue of a 20 KB pre-roll into a 16 KB backlog spuriously overflowed
      // and aborted the utterance before its microtask could drain.
      speaking = true;
      utteranceBytes = 0;
      options.onSpeechStart();
      const prefix = preRoll.drain();
      for (const chunk of prefix) utteranceBytes += chunk.byteLength;
      backlog.primePrefix(prefix);
      schedulePump();
    },
    onSpeechEnd: () => {
      // The returned whole-segment array is only an endpoint signal.
      speaking = false;
      utteranceBytes = 0;
      options.onSpeechEnd();
    },
    onVADMisfire: () => {
      speaking = false;
      utteranceBytes = 0;
      preRoll.clear();
      options.onMisfire();
    },
  };

  try {
    vad = await MicVAD.new(vadOptions);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
    throw error instanceof Error ? error : new Error('VAD initialization failed.');
  }

  // --- output playback ------------------------------------------------------

  let nextStartTime = 0;
  let queuedOutputSeconds = 0;
  const sources = new Set<AudioBufferSourceNode>();
  const responses = new Map<number, OutputResponse>();
  // Highest responseId ever seen and the highest that has been cancelled. Any
  // output/finish for an id at or below the fence is stale (a superseded
  // generation) and rejected even after its map entry has been cleaned up.
  let highestResponseId = -1;
  let staleFence = -1;
  let closed = false;

  const isStale = (responseId: number): boolean => responseId <= staleFence;

  const responseFor = (responseId: number): OutputResponse => {
    if (responseId > highestResponseId) highestResponseId = responseId;
    let response = responses.get(responseId);
    if (!response) {
      response = { active: 0, declared: false, cancelled: false, overflowed: false };
      responses.set(responseId, response);
    }
    return response;
  };

  // Resolve a pending completion and, for terminal results, drop the bookkeeping
  // so the response map cannot grow without bound. 'paused' is not terminal: the
  // entry is retained so a resumed drain can settle it.
  const finalize = (responseId: number, result: 'played' | 'interrupted' | 'paused'): void => {
    const response = responses.get(responseId);
    if (response?.settle) {
      response.settle(result);
      response.settle = undefined;
    }
    if (result !== 'paused') responses.delete(responseId);
  };

  const maybeSettle = (responseId: number): void => {
    const response = responses.get(responseId);
    if (!response?.settle) return;
    if (response.cancelled || response.overflowed) finalize(responseId, 'interrupted');
    else if (context.state !== 'running') finalize(responseId, 'paused');
    else if (response.declared && response.active === 0) finalize(responseId, 'played');
  };

  // Observe context state changes after a drain has begun — not only at the
  // initial finishOutput check. A mid-drain suspension (the playback clock
  // stops) settles every pending completion as 'paused' so the caller retains
  // its playback obligation rather than falsely advertising a finished turn.
  const onContextStateChange = (): void => {
    if (closed) return;
    options.onState(context.state === 'running' ? 'ready' : 'suspended');
    for (const id of [...responses.keys()]) maybeSettle(id);
  };
  if (typeof context.addEventListener === 'function') {
    context.addEventListener('statechange', onContextStateChange);
  } else {
    context.onstatechange = onContextStateChange;
  }

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
      // An abort must not leave the VAD retaining the abandoned segment.
      speaking = false;
      utteranceBytes = 0;
      preRoll.clear();
      backlog.clear();
      drainWaiters = [];
      resetVadSegment();
    },

    enqueueOutput(audio: string, sampleRate: number, responseId: number, seq: number): void {
      if (closed) return;
      void seq; // ordering is guaranteed by the server's sequential delivery
      // Reject output for a superseded generation even after its entry is gone.
      if (isStale(responseId)) return;
      const response = responseFor(responseId);
      if (response.cancelled) return;
      const samples = decodePcm16Base64(audio);
      if (samples.length === 0) return;
      const duration = samples.length / sampleRate;
      // Bound retention: a slow or suspended context must not accumulate an
      // unlimited number of scheduled nodes. Drop past the ceiling and flag the
      // response so its completion is reported honestly rather than as played.
      if (queuedOutputSeconds + duration > MAX_OUTPUT_SECONDS) {
        response.overflowed = true;
        maybeSettle(responseId);
        return;
      }
      const buffer = context.createBuffer(1, samples.length, sampleRate);
      buffer.getChannelData(0).set(samples);
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      // Tag the node so per-response cancellation can stop only its own sources
      // and reclaim the right amount of the output budget.
      (node as { responseId?: number; seconds?: number }).responseId = responseId;
      (node as { responseId?: number; seconds?: number }).seconds = duration;
      response.active += 1;
      queuedOutputSeconds += duration;
      sources.add(node);
      node.onended = (): void => {
        node.disconnect();
        sources.delete(node);
        response.active -= 1;
        queuedOutputSeconds = Math.max(0, queuedOutputSeconds - duration);
        maybeSettle(responseId);
      };
      const startAt = Math.max(context.currentTime, nextStartTime);
      node.start(startAt);
      nextStartTime = startAt + buffer.duration;
    },

    finishOutput(responseId: number, lastSeq: number): Promise<'played' | 'interrupted' | 'paused'> {
      void lastSeq;
      if (closed || isStale(responseId)) return Promise.resolve('interrupted');
      const response = responseFor(responseId);
      response.declared = true;
      if (response.cancelled || response.overflowed) {
        finalize(responseId, 'interrupted');
        return Promise.resolve('interrupted');
      }
      // Suspended at declaration time: keep the entry so a resumed drain can
      // still complete the obligation (do not delete on 'paused').
      if (context.state !== 'running') return Promise.resolve('paused');
      if (response.active === 0) {
        responses.delete(responseId);
        return Promise.resolve('played');
      }
      return new Promise((resolve) => {
        response.settle = resolve;
      });
    },

    cancelOutput(responseId?: number): void {
      for (const node of [...sources]) {
        const tagged = node as { responseId?: number; seconds?: number };
        if (responseId !== undefined && tagged.responseId !== responseId) continue;
        node.onended = null;
        try {
          node.stop();
        } catch {
          /* already stopped */
        }
        node.disconnect();
        sources.delete(node);
        queuedOutputSeconds = Math.max(0, queuedOutputSeconds - (tagged.seconds ?? 0));
      }
      // A full cancel clears the playback clock; a targeted cancel leaves any
      // surviving responses' scheduling intact.
      if (responseId === undefined) {
        nextStartTime = 0;
        queuedOutputSeconds = 0;
      }
      // Fence the cancelled generation so its late output/finish is rejected
      // even once the bookkeeping below removes the entry.
      staleFence = Math.max(staleFence, responseId ?? highestResponseId);
      for (const [id, response] of [...responses]) {
        if (responseId !== undefined && id !== responseId) continue;
        response.cancelled = true;
        response.active = 0;
        finalize(id, 'interrupted');
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
        for (const id of [...responses.keys()]) maybeSettle(id);
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (typeof context.removeEventListener === 'function') {
        context.removeEventListener('statechange', onContextStateChange);
      } else {
        context.onstatechange = null;
      }
      for (const id of [...responses.keys()]) finalize(id, 'interrupted');
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
