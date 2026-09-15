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
  seconds?: number;
  endAt?: number;
  /** The `when` argument passed to start(), i.e. the scheduled start time. */
  startAt?: number;
  connect(): void;
  disconnect(): void;
  start(when?: number): void;
  stop(): void;
}

class FakeAudioContext {
  state: 'running' | 'suspended' | 'closed' = 'running';
  currentTime = 0;
  readonly destination = {};
  readonly sampleRate: number;
  onstatechange: (() => void) | null = null;
  readonly live = new Set<FakeSourceNode>();
  /** Every source node created, in order, retained after cancel for assertions. */
  readonly created: FakeSourceNode[] = [];
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
      start(when?: number): void {
        // Record the scheduled start time so tests can assert new speech is not
        // delayed behind a stale playback fence and that survivor schedules are
        // preserved across a targeted cancel.
        node.startAt = when;
        ctx.live.add(node);
      },
      stop(): void {
        ctx.live.delete(node);
      },
    };
    this.created.push(node);
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

function makeOptions(): HandsFreeAudioOptions & { calls: Record<string, unknown[][]>; pcmBytes: number; diagnostics: import('../../shared/diagnostics.js').DiagnosticInput[] } {
  const calls: Record<string, unknown[][]> = {
    onSpeechStart: [],
    onSpeechEnd: [],
    onMisfire: [],
    onPcm: [],
    onState: [],
    onError: [],
    onDiscontinuity: [],
  };
  const diagnostics: import('../../shared/diagnostics.js').DiagnosticInput[] = [];
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
    onDiagnostic: (d: import('../../shared/diagnostics.js').DiagnosticInput) => diagnostics.push(d),
    onPcm(pcm: ArrayBuffer): void {
      calls.onPcm.push([pcm]);
      options.pcmBytes += pcm.byteLength;
    },
    calls,
    pcmBytes: 0,
    diagnostics,
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

// Regression coverage for the speech-breakup repair: a targeted cancel must not
// leave the playback fence (nextStartTime) stranded in the future, and uneven
// PCM arrival must not open silent underrun gaps. These assert on the scheduled
// start time each source is given, which the fake now records.
describe('createHandsFreeAudio output scheduling (breakup repair)', () => {
  const MARGIN = 0.06; // must match PREBUFFER_MARGIN_SECONDS in audio.ts

  it('does not delay new speech after a targeted cancel leaves no surviving source', async () => {
    const { audio, ctx } = await build();
    audio.enqueueOutput(outputBase64(16000), 16000, 1, 0); // 1 s, response 1

    // Playback advances partway through response 1, then it is cancelled (barge-in
    // on the only scheduled response).
    ctx.currentTime = 0.5;
    audio.cancelOutput(1);
    expect(ctx.live.size).toBe(0);

    // New speech arrives. Before the repair, nextStartTime was left at ~1.0 (the
    // end of the now-cancelled response) so this was scheduled ~0.5 s in the
    // future — audible dead air. It must now start near the playback clock,
    // strictly before the stale fence.
    audio.enqueueOutput(outputBase64(16000), 16000, 2, 0);
    const second = ctx.created[1];
    expect(second.startAt).toBeLessThan(1.0);
    expect(second.startAt).toBeCloseTo(0.5 + MARGIN);
  });

  it('preserves a surviving response schedule and appends new audio after it', async () => {
    const { audio, ctx } = await build();
    audio.enqueueOutput(outputBase64(16000), 16000, 1, 0); // response 1, 1 s
    audio.enqueueOutput(outputBase64(16000), 16000, 2, 0); // response 2 (survivor)
    const survivor = ctx.created[1];
    const survivorStart = survivor.startAt!; // == MARGIN + 1

    audio.cancelOutput(1); // cancel response 1; response 2 survives
    expect(ctx.live.size).toBe(1);
    // The survivor's already-scheduled start time is untouched.
    expect(survivor.startAt).toBe(survivorStart);

    // Further audio for the survivor appends contiguously after its end, not
    // reset back to the clock (which would overlap the still-playing survivor).
    audio.enqueueOutput(outputBase64(16000), 16000, 2, 1);
    const appended = ctx.created[2];
    expect(appended.startAt).toBeCloseTo(survivorStart + 1);
  });

  it('keeps jittered PCM arrival contiguous with a bounded pre-buffer margin', async () => {
    const { audio, ctx } = await build();
    // 0.1 s buffers. The first starts with headroom rather than exactly at 0.
    audio.enqueueOutput(outputBase64(1600), 16000, 1, 0);
    const a = ctx.created[0];
    expect(a.startAt).toBeCloseTo(MARGIN);

    // The next frame arrives late (0.12 s of wall-clock, past 0.1 s of playback),
    // but the margin kept the schedule ahead of the clock, so it lands
    // contiguously — zero silent underrun gap.
    ctx.currentTime = 0.12;
    audio.enqueueOutput(outputBase64(1600), 16000, 1, 1);
    const b = ctx.created[1];
    expect(b.startAt).toBeCloseTo(a.startAt! + 0.1);
    expect(b.startAt! - (a.startAt! + 0.1)).toBeCloseTo(0);
  });
});

describe('createHandsFreeAudio diagnostics', () => {
  it('emits first_playback_scheduled once per response', async () => {
    const { audio, opts } = await build();
    audio.enqueueOutput(outputBase64(8000), 16000, 1, 0);
    audio.enqueueOutput(outputBase64(8000), 16000, 1, 1);
    const firstPlayback = opts.diagnostics.filter((d) => d.code === 'first_playback_scheduled');
    expect(firstPlayback).toHaveLength(1);
    expect(firstPlayback[0].sampleRate).toBe(16000);
  });

  it('emits playback_cancelled on cancel', async () => {
    const { audio, opts } = await build();
    audio.enqueueOutput(outputBase64(8000), 16000, 1, 0);
    audio.cancelOutput(1);
    expect(opts.diagnostics.some((d) => d.code === 'playback_cancelled')).toBe(true);
  });

  it('emits playback_overflow when ceiling is exceeded', async () => {
    const { audio, opts } = await build();
    for (let i = 0; i < 40; i += 1) audio.enqueueOutput(outputBase64(16000), 16000, 5, i);
    expect(opts.diagnostics.some((d) => d.code === 'playback_overflow')).toBe(true);
  });

  it('does not break playback when diagnostic callback throws', async () => {
    const { createHandsFreeAudio } = await import('./audio.js');
    const opts = makeOptions();
    opts.onDiagnostic = () => { throw new Error('boom'); };
    const audio = await createHandsFreeAudio(opts);
    audio.enqueueOutput(outputBase64(8000), 16000, 1, 0);
    const ctx = contexts[0];
    expect(ctx.live.size).toBe(1);
    audio.cancelOutput(1);
    expect(ctx.live.size).toBe(0);
    await audio.close();
  });
});
