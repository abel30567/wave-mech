import { describe, expect, it } from 'vitest';
import { createConversation } from './session.js';
import type { HarnessEvent } from '../../shared/contracts.js';
import type {
  RealtimeEvent,
  RealtimeHarness,
  RealtimeSpeech,
  RetainedConversation,
} from '../../shared/realtime.js';

// Deterministic server-side output flow-control tests. A controllable clock and
// a captured onAudio callback let us inject exact amounts of generated audio and
// assert the bounded, consumption-based release without any timers or network.

const SAMPLE_RATE = 24000;
// A base64 frame whose decoded PCM16 length is exactly `ms` of audio.
function audioFrame(ms: number): string {
  const bytes = Math.round((ms / 1000) * SAMPLE_RATE * 2);
  return Buffer.alloc(bytes, 1).toString('base64');
}

interface Rig {
  conv: RetainedConversation;
  events: RealtimeEvent[];
  emitAudio(ms: number): void;
  setNow(ms: number): void;
  audioSeqs(): number[];
  diagCodes(): string[];
  diag(code: string): Extract<RealtimeEvent, { type: 'diagnostic' }>['event'] | undefined;
}

async function rig(): Promise<Rig> {
  const events: RealtimeEvent[] = [];
  let clock = 0;

  const harness: RealtimeHarness = {
    start: async () => {},
    send: () => new Promise<void>(() => {}), // stays pending: response stays active
    interrupt: async () => {},
    close: async () => {},
  };

  let onAudio: (audio: string, sampleRate: number) => void = () => {};
  const speech: RealtimeSpeech = {
    startRecognition: async () => {},
    writeAudio: () => true,
    commitRecognition: async () => '',
    prewarm: () => {},
    writeText: () => {},
    finishSpeech: async () => {},
    cancelSpeech: () => {},
    abortRecognition: () => {},
    close: () => {},
  };

  const conv = createConversation({
    id: 'flow-1',
    mode: 'fixture',
    now: () => clock,
    harness: (_event: (event: HarnessEvent) => void) => harness,
    speech: (callbacks) => {
      onAudio = callbacks.onAudio;
      return speech;
    },
  });
  conv.attach((event) => events.push(event));
  await conv.start();
  await conv.handle({ type: 'text', turnId: 1, text: 'go' });

  return {
    conv,
    events,
    emitAudio: (ms) => onAudio(audioFrame(ms), SAMPLE_RATE),
    setNow: (ms) => {
      clock = ms;
    },
    audioSeqs: () =>
      events.filter((e): e is Extract<RealtimeEvent, { type: 'audio' }> => e.type === 'audio').map((e) => e.seq),
    diagCodes: () =>
      events.filter((e): e is Extract<RealtimeEvent, { type: 'diagnostic' }> => e.type === 'diagnostic').map((e) => e.event.code),
    diag: (code) =>
      events
        .filter((e): e is Extract<RealtimeEvent, { type: 'diagnostic' }> => e.type === 'diagnostic')
        .map((e) => e.event)
        .find((e) => e.code === code),
  };
}

describe('server output flow control (issue 15)', () => {
  it('forwards only within the unplayed window and releases more on playback_progress', async () => {
    const r = await rig();
    // Generate 20s of audio in 1s frames while the client has played nothing.
    for (let i = 0; i < 20; i++) r.emitAudio(1000);
    // At most the 12s window is forwarded up front; the rest is held.
    expect(r.audioSeqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // The client reports playing through seq 6 (6s): the window frees by 6s.
    await r.conv.handle({ type: 'playback_progress', responseId: 1, seq: 6 });
    expect(r.audioSeqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);

    // Playing through the end releases everything.
    await r.conv.handle({ type: 'playback_progress', responseId: 1, seq: 20 });
    expect(r.audioSeqs()).toHaveLength(20);
  });

  it('drains for an old client that never reports progress via the realtime time-based window', async () => {
    const r = await rig();
    for (let i = 0; i < 20; i++) r.emitAudio(1000);
    expect(r.audioSeqs()).toHaveLength(12); // window-bounded at first

    // No progress ever arrives; realtime advances 6s. A pump (any progress ping,
    // here the benign seq 0) applies the time-based estimate so delivery does not
    // stall for an old client.
    r.setNow(6000);
    await r.conv.handle({ type: 'playback_progress', responseId: 1, seq: 0 });
    expect(r.audioSeqs()).toHaveLength(18);

    r.setNow(20000);
    await r.conv.handle({ type: 'playback_progress', responseId: 1, seq: 0 });
    expect(r.audioSeqs()).toHaveLength(20);
  });

  it('lets consumption alone govern release once the client has reported progress (a paused client is not flooded)', async () => {
    const r = await rig();
    for (let i = 0; i < 40; i++) r.emitAudio(1000);
    expect(r.audioSeqs()).toHaveLength(12);
    // The client reports real progress through seq 4, then pauses (no further reports).
    await r.conv.handle({ type: 'playback_progress', responseId: 1, seq: 4 });
    expect(r.audioSeqs()).toHaveLength(16);
    // Wall-clock keeps running but consumption does not: nothing more is released,
    // so the paused client's bounded hold queue cannot overflow.
    r.setNow(60_000);
    await r.conv.handle({ type: 'playback_progress', responseId: 1, seq: 4 });
    expect(r.audioSeqs()).toHaveLength(16);
    expect(r.diagCodes()).not.toContain('output_truncated');
    // Resuming consumption releases the next window.
    await r.conv.handle({ type: 'playback_progress', responseId: 1, seq: 16 });
    expect(r.audioSeqs()).toHaveLength(28);
  });

  it('truncates explicitly with a bufferedMs diagnostic when the outbox bound is exceeded', async () => {
    const r = await rig();
    // 15 frames of 10s each = 150s generated; the client plays nothing, so the
    // held outbox exceeds the 120s bound and the response is truncated once.
    for (let i = 0; i < 15; i++) r.emitAudio(10_000);

    expect(r.diagCodes().filter((c) => c === 'output_truncated')).toHaveLength(1); // coalesced
    const truncated = r.diag('output_truncated');
    expect(truncated).toBeDefined();
    expect(truncated!.bufferedMs).toBeGreaterThanOrEqual(100_000);
    // Nothing beyond the bound was forwarded, and it was not dropped silently.
    expect(r.conv.snapshot().response?.audioInterrupted).toBe(true);
  });
});
