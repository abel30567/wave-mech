import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PREROLL_BYTES,
  PRODUCER_AUDIO_BYTES,
  type HandsFreeAudio,
  type HandsFreeAudioOptions,
} from '../../shared/realtime.js';
import { encodePcm16 } from '../audio/pcm.js';

// --- injected browser / VAD boundaries ------------------------------------
//
// These fakes stand in for the real AudioContext, MediaStream and
// @ricky0123/vad-web MicVAD so the *production* createHandsFreeAudio helper is
// exercised end to end in Node against deterministic frame/state boundaries.
// They are clearly synthetic and are NOT a substitute for the real VAD/acoustic
// startup asset test that lives in the browser suite.

const vadHandle = vi.hoisted(() => ({
  options: undefined as Partial<import('@ricky0123/vad-web').RealTimeVADOptions> | undefined,
  instance: undefined as { starts: number; pauses: number; destroys: number; listening: boolean } | undefined,
}));

vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: {
    new: async (options: Partial<import('@ricky0123/vad-web').RealTimeVADOptions>) => {
      vadHandle.options = options;
      const instance = {
        starts: 0,
        pauses: 0,
        destroys: 0,
        listening: false,
        async start(): Promise<void> {
          this.listening = true;
          this.starts += 1;
        },
        async pause(): Promise<void> {
          this.listening = false;
          this.pauses += 1;
        },
        async destroy(): Promise<void> {
          this.destroys += 1;
        },
      };
      vadHandle.instance = instance;
      return instance;
    },
  },
}));

class FakeAudioBuffer {
  readonly duration: number;
  private readonly data: Float32Array;
  constructor(_channels: number, readonly length: number, readonly sampleRate: number) {
    this.duration = length / sampleRate;
    this.data = new Float32Array(length);
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}

interface FakeSourceNode {
  buffer: FakeAudioBuffer | null;
  onended: (() => void) | null;
  responseId?: number;
  connect(): void;
  disconnect(): void;
  start(): void;
  stop(): void;
}

class FakeAudioContext {
  state: 'running' | 'suspended' | 'closed' = 'running';
  currentTime = 0;
  readonly destination = {};
  readonly sampleRate: number;
  onstatechange: (() => void) | null = null;
  readonly live = new Set<FakeSourceNode>();
  private readonly listeners: Array<() => void> = [];

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 48000;
  }
  createBuffer(channels: number, length: number, rate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, rate);
  }
  createBufferSource(): FakeSourceNode {
    const ctx = this;
    const node: FakeSourceNode = {
      buffer: null,
      onended: null,
      connect(): void {},
      disconnect(): void {},
      start(): void {
        ctx.live.add(node);
      },
      stop(): void {
        ctx.live.delete(node);
      },
    };
    return node;
  }
  addEventListener(_type: 'statechange', fn: () => void): void {
    this.listeners.push(fn);
  }
  removeEventListener(_type: 'statechange', fn: () => void): void {
    const i = this.listeners.indexOf(fn);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  async resume(): Promise<void> {
    this.state = 'running';
    this.emit();
  }
  async close(): Promise<void> {
    this.state = 'closed';
  }
  // --- test helpers ---
  suspend(): void {
    this.state = 'suspended';
    this.emit();
  }
  finishAll(): void {
    for (const node of [...this.live]) {
      this.live.delete(node);
      node.onended?.();
    }
  }
  private emit(): void {
    for (const fn of [...this.listeners]) fn();
    this.onstatechange?.();
  }
}

let contexts: FakeAudioContext[] = [];
let micTrack: { stop: ReturnType<typeof vi.fn>; enabled: boolean };

function makeOptions(): HandsFreeAudioOptions & { calls: Record<string, unknown[][]>; pcmBytes: number } {
  const calls: Record<string, unknown[][]> = {
    onSpeechStart: [],
    onSpeechEnd: [],
    onMisfire: [],
    onPcm: [],
    onState: [],
    onError: [],
    onDiscontinuity: [],
  };
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      calls[name].push(args);
    };
  const options = {
    onSpeechStart: record('onSpeechStart'),
    onSpeechEnd: record('onSpeechEnd'),
    onMisfire: record('onMisfire'),
    onState: record('onState'),
    onError: record('onError'),
    onDiscontinuity: record('onDiscontinuity'),
    onPcm(pcm: ArrayBuffer): void {
      calls.onPcm.push([pcm]);
      options.pcmBytes += pcm.byteLength;
    },
    calls,
    pcmBytes: 0,
  };
  return options;
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const frame = (samples: number, fill = 0.2): Float32Array => new Float32Array(samples).fill(fill);

// base64 PCM16 for `samples` mono samples at the given (arbitrary) rate.
function outputBase64(samples: number): string {
  const bytes = new Uint8Array(encodePcm16(frame(samples, 0.1)));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

beforeEach(() => {
  contexts = [];
  micTrack = { stop: vi.fn(), enabled: true };
  const stream = { getTracks: () => [micTrack], getAudioTracks: () => [micTrack] };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream } });
  vi.stubGlobal(
    'AudioContext',
    class extends FakeAudioContext {
      constructor(options?: { sampleRate?: number }) {
        super(options);
        contexts.push(this);
      }
    },
  );
  vadHandle.options = undefined;
  vadHandle.instance = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function build(): Promise<{ audio: HandsFreeAudio; opts: ReturnType<typeof makeOptions>; ctx: FakeAudioContext }> {
  const { createHandsFreeAudio } = await import('./audio.js');
  const opts = makeOptions();
  const audio = await createHandsFreeAudio(opts);
  return { audio, opts, ctx: contexts[0] };
}

describe('createHandsFreeAudio capture', () => {
  it('delivers a full 640 ms pre-roll on normal onset without overflowing the producer backlog', async () => {
    const { opts } = await build();
    const vad = vadHandle.options!;
    // 512-sample frames == 1024 PCM16 bytes each. Fill the pre-roll ring right
    // up to PREROLL_BYTES (20480) before onset — larger than the 16384 live
    // producer budget, which is exactly the regression that used to abort.
    const frameSamples = 512;
    const frameBytes = frameSamples * 2;
    const preRollFrames = PREROLL_BYTES / frameBytes;
    for (let i = 0; i < preRollFrames; i += 1) vad.onFrameProcessed!({} as never, frame(frameSamples));

    vad.onSpeechRealStart!();
    await flush();

    expect(opts.calls.onSpeechStart).toHaveLength(1);
    expect(opts.calls.onDiscontinuity).toHaveLength(0);
    // The whole pre-roll (20480 bytes) was forwarded, first syllables intact.
    expect(opts.pcmBytes).toBe(PREROLL_BYTES);
    expect(opts.pcmBytes).toBeGreaterThan(PRODUCER_AUDIO_BYTES);
  });

  it('forwards live frames after the pre-roll prefix in order', async () => {
    const { opts } = await build();
    const vad = vadHandle.options!;
    vad.onFrameProcessed!({} as never, frame(256)); // one pre-roll frame (512 bytes)
    vad.onSpeechRealStart!();
    vad.onFrameProcessed!({} as never, frame(256)); // one live frame (512 bytes)
    await flush();
    expect(opts.calls.onDiscontinuity).toHaveLength(0);
    expect(opts.pcmBytes).toBe(1024);
  });

  it('abandons the utterance and resets the VAD segment on a producer stall', async () => {
    const { opts } = await build();
    const vad = vadHandle.options!;
    vad.onSpeechRealStart!();
    // Live frames faster than the (un-pumped) consumer: 17 * 1024 > 16384.
    for (let i = 0; i < 17; i += 1) vad.onFrameProcessed!({} as never, frame(512));
    await flush();
    expect(opts.calls.onDiscontinuity).toHaveLength(1);
    // The VAD's internal segment is reset (pause+start) so it stops retaining.
    expect(vadHandle.instance!.pauses).toBeGreaterThanOrEqual(1);
    expect(vadHandle.instance!.starts).toBeGreaterThanOrEqual(1);
  });

  it('bounds the VAD utterance retention at ~120 s and resets on overflow', async () => {
    const { opts, audio } = await build();
    const vad = vadHandle.options!;
    vad.onSpeechRealStart!();
    // Feed drainable 16384-byte frames (== live budget) and pump between each so
    // the producer never stalls; retention still hits the 120 s byte cap.
    const bytesPerFrame = 16384;
    const framesToCap = Math.ceil((16000 * 2 * 120) / bytesPerFrame) + 1;
    for (let i = 0; i < framesToCap; i += 1) {
      vad.onFrameProcessed!({} as never, frame(bytesPerFrame / 2));
      await audio.flushInput();
    }
    await flush();
    expect(opts.calls.onDiscontinuity.length).toBeGreaterThanOrEqual(1);
    expect(vadHandle.instance!.pauses).toBeGreaterThanOrEqual(1);
  });

  it('resets the VAD segment when input is cleared while listening', async () => {
    const { audio } = await build();
    audio.setMode('listen');
    await flush();
    const before = vadHandle.instance!.pauses;
    audio.clearInput();
    await flush();
    expect(vadHandle.instance!.pauses).toBeGreaterThan(before);
  });
});

describe('createHandsFreeAudio output', () => {
  it('settles a mid-drain suspension as paused and completes after resume', async () => {
    const { audio, ctx } = await build();
    audio.enqueueOutput(outputBase64(8000), 16000, 1, 0);
    const finished = audio.finishOutput(1, 0);
    ctx.suspend(); // playback clock stops mid-drain
    await expect(finished).resolves.toBe('paused');

    await audio.resume();
    const again = audio.finishOutput(1, 0);
    ctx.finishAll();
    await expect(again).resolves.toBe('played');
  });

  it('bounds scheduled output nodes and reports overflow honestly (never played)', async () => {
    const { audio, ctx } = await build();
    // One-second buffers that never drain: past the 30 s ceiling, allocation
    // stops so a slow/suspended context cannot retain unlimited nodes.
    for (let i = 0; i < 40; i += 1) audio.enqueueOutput(outputBase64(16000), 16000, 5, i);
    expect(ctx.live.size).toBe(30);
    await expect(audio.finishOutput(5, 39)).resolves.toBe('interrupted');
  });

  it('fences a cancelled generation so its late output is rejected', async () => {
    const { audio, ctx } = await build();
    audio.enqueueOutput(outputBase64(8000), 16000, 1, 0);
    expect(ctx.live.size).toBe(1);
    audio.cancelOutput(1);
    expect(ctx.live.size).toBe(0);
    // Late audio for the cancelled response must not schedule a new node.
    audio.enqueueOutput(outputBase64(8000), 16000, 1, 1);
    expect(ctx.live.size).toBe(0);
    await expect(audio.finishOutput(1, 1)).resolves.toBe('interrupted');
    // A fresh, higher generation still plays.
    audio.enqueueOutput(outputBase64(8000), 16000, 2, 0);
    expect(ctx.live.size).toBe(1);
  });

  it('cancels only the targeted response, leaving others scheduled', async () => {
    const { audio, ctx } = await build();
    audio.enqueueOutput(outputBase64(8000), 16000, 1, 0);
    audio.enqueueOutput(outputBase64(8000), 16000, 2, 0);
    expect(ctx.live.size).toBe(2);
    audio.cancelOutput(1);
    expect(ctx.live.size).toBe(1);
    const done = audio.finishOutput(2, 0);
    ctx.finishAll();
    await expect(done).resolves.toBe('played');
  });

  it('completes a normal drain as played and stops advertising work', async () => {
    const { audio, ctx } = await build();
    audio.enqueueOutput(outputBase64(8000), 16000, 3, 0);
    const done = audio.finishOutput(3, 0);
    ctx.finishAll();
    await expect(done).resolves.toBe('played');
    // A subsequent stale finish for the same generation is not re-played.
    audio.cancelOutput(3);
    await expect(audio.finishOutput(3, 0)).resolves.toBe('interrupted');
  });
});
