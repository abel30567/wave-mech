import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PCM_RATE, type ConversationView, type RealtimeCommand, type RealtimeEvent } from '../../shared/realtime.js';
import { decodeAudio } from '../../shared/realtime-wire.js';
import { createConversationClient } from './client.js';
import { createConversation } from '../../server/realtime/session.js';
import type { HarnessEvent } from '../../shared/contracts.js';
import type { RealtimeHarness, RealtimeSpeech } from '../../shared/realtime.js';

// Full coupling of the ACTUAL client controller + audio scheduler to the server
// coordinator over an in-memory transport. 45–90 s of generated audio is
// delivered much faster than realtime and must arrive complete, in order, with
// bounded buffers at every stage, no silent tail loss, no false `played`
// acknowledgement, and observable progress-driven release.

// --- browser boundary fakes (AudioContext / MediaStream / VAD) --------------

vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: {
    new: async () => ({
      async start(): Promise<void> {},
      async pause(): Promise<void> {},
      async destroy(): Promise<void> {},
    }),
  },
}));

class FakeSourceNode {
  buffer: { duration: number; length: number; sampleRate: number; getChannelData(): Float32Array } | null = null;
  onended: (() => void) | null = null;
  responseId?: number;
  seconds?: number;
  seq?: number;
  endAt?: number;
  constructor(private readonly ctx: FakeAudioContext) {}
  connect(): void {}
  disconnect(): void {}
  start(): void {
    this.ctx.live.add(this);
  }
  stop(): void {
    this.ctx.live.delete(this);
  }
}

class FakeAudioContext {
  state: 'running' | 'suspended' | 'closed' = 'running';
  currentTime = 0;
  readonly destination = {};
  readonly sampleRate: number;
  onstatechange: (() => void) | null = null;
  readonly live = new Set<FakeSourceNode>();
  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 48000;
  }
  createBuffer(_channels: number, length: number, rate: number): { duration: number; length: number; sampleRate: number; getChannelData(): Float32Array } {
    const data = new Float32Array(length);
    return { duration: length / rate, length, sampleRate: rate, getChannelData: () => data };
  }
  createBufferSource(): FakeSourceNode {
    return new FakeSourceNode(this);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  async resume(): Promise<void> {
    this.state = 'running';
  }
  async close(): Promise<void> {
    this.state = 'closed';
  }
  /** Play (end) every scheduled node, advancing the playback clock. */
  playAll(): void {
    for (const node of [...this.live]) {
      this.currentTime = Math.max(this.currentTime, node.endAt ?? this.currentTime);
      this.live.delete(node);
      node.onended?.();
    }
  }
}

let contexts: FakeAudioContext[] = [];

beforeEach(() => {
  contexts = [];
  const micTrack = { stop: vi.fn(), enabled: true };
  const stream = { getTracks: () => [micTrack], getAudioTracks: () => [micTrack] };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream } });
  vi.stubGlobal('AudioContext', class extends FakeAudioContext {
    constructor(options?: { sampleRate?: number }) {
      super(options);
      contexts.push(this);
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- in-memory transport bridging client socket <-> server coordinator ------

const SAMPLE_RATE = 24000;
function audioFrame(ms: number): string {
  return Buffer.alloc(Math.round((ms / 1000) * SAMPLE_RATE * 2), 1).toString('base64');
}

interface Bridge {
  client: ReturnType<typeof createConversationClient>;
  emitAudio(ms: number): void;
  resolveSend(): void;
  pump(): Promise<void>;
  advance(ms: number): void;
  serverAudioSeqs(): number[];
  view(): ConversationView;
}

async function bridge(): Promise<Bridge> {
  let clock = 0;
  const toClient: RealtimeEvent[] = [];
  const toServer: Array<RealtimeCommand | { audio: ReturnType<typeof decodeAudio> }> = [];
  const serverAudioSeqs: number[] = [];

  const harness: RealtimeHarness = {
    start: async () => {},
    send: () => new Promise<void>((resolve) => { resolveSend = resolve; }),
    interrupt: async () => {},
    close: async () => {},
  };
  let resolveSend: () => void = () => {};
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
    id: 'itg-1',
    mode: 'fixture',
    now: () => clock,
    harness: (_e: (event: HarnessEvent) => void) => harness,
    speech: (callbacks) => {
      onAudio = callbacks.onAudio;
      return speech;
    },
  });
  await conv.start();
  conv.attach((event) => {
    if (event.type === 'audio') serverAudioSeqs.push(event.seq);
    toClient.push(event);
  });

  // A minimal WebSocket stand-in that routes client output to the coordinator.
  let socketRef: { onopen: (() => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null } | null = null;
  const socketFactory = (): WebSocket => {
    const socket = {
      readyState: 1,
      binaryType: 'arraybuffer',
      onopen: null as (() => void) | null,
      onmessage: null as ((e: { data: unknown }) => void) | null,
      onclose: null as (() => void) | null,
      onerror: null as (() => void) | null,
      send(data: string | ArrayBuffer): void {
        if (typeof data === 'string') toServer.push(JSON.parse(data) as RealtimeCommand);
        else toServer.push({ audio: decodeAudio(data) });
      },
      close(): void {},
    };
    socketRef = socket;
    queueMicrotask(() => socket.onopen?.());
    return socket as unknown as WebSocket;
  };

  const views: ConversationView[] = [];
  const client = createConversationClient({
    url: 'wss://local/itg',
    speechAvailable: true,
    refreshAccess: async () => {},
    onChange: (view) => views.push(view),
    socketFactory,
    audioFactory: (opts) => import('./audio.js').then((m) => m.createHandsFreeAudio(opts)),
  });

  async function pump(): Promise<void> {
    // Drain both directions until stable; delivery is queued (never reentrant).
    for (let guard = 0; guard < 10000; guard++) {
      if (toServer.length > 0) {
        const msg = toServer.shift()!;
        if ('audio' in msg) conv.audio(msg.audio);
        else await conv.handle(msg);
        continue;
      }
      if (toClient.length > 0) {
        const event = toClient.shift()!;
        socketRef?.onmessage?.({ data: JSON.stringify(event) });
        continue;
      }
      // Let any awaited microtasks (audio creation, finishOutput) settle.
      await Promise.resolve();
      if (toServer.length === 0 && toClient.length === 0) return;
    }
    throw new Error('pump did not settle');
  }

  await client.start();
  await pump();
  // The real hands-free audio is created asynchronously (dynamic import + a few
  // awaits). Wait until the AudioContext exists so no output frame is dropped
  // before playback is ready.
  for (let i = 0; i < 200 && contexts.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await pump();
  }
  await pump();

  return {
    client,
    emitAudio: (ms) => onAudio(audioFrame(ms), SAMPLE_RATE),
    resolveSend: () => resolveSend(),
    pump,
    advance: (ms) => { clock += ms; },
    serverAudioSeqs: () => serverAudioSeqs,
    view: () => views[views.length - 1],
  };
}

describe('client <-> coordinator output flow control integration (issue 15)', () => {
  it('delivers ~60s of audio complete, ordered and bounded, much faster than realtime', async () => {
    const b = await bridge();

    // Start a typed turn; the coordinator opens a response.
    b.client.sendText('play a long answer');
    await b.pump();

    // Generate 60 seconds of audio in 1 s frames while the client has played none.
    const TOTAL = 60;
    for (let i = 0; i < TOTAL; i++) b.emitAudio(1000);
    await b.pump();

    // The server released only a bounded window up front (never all 60s).
    expect(b.serverAudioSeqs().length).toBeGreaterThan(0);
    expect(b.serverAudioSeqs().length).toBeLessThan(TOTAL);
    // The client scheduled only a bounded look-ahead of live nodes.
    const ctx = contexts[0];
    expect(ctx.live.size).toBeLessThanOrEqual(12);
    let maxLive = ctx.live.size;

    // Finish inference: the coordinator declares the response and keeps draining.
    b.resolveSend();
    await b.pump();

    // Drive playback much faster than realtime. Fake timers let the throttled
    // progress reports and the server's time-based drain fire deterministically.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      for (let guard = 0; guard < 500; guard++) {
        ctx.playAll(); // play everything scheduled -> onended -> progress
        b.advance(2000); // also exercise the server realtime-fallback window
        vi.advanceTimersByTime(600); // fire throttled progress + drain timers
        await b.pump(); // deliver progress -> server releases the next window
        maxLive = Math.max(maxLive, ctx.live.size);
        if (b.view().phase !== 'speaking' && b.view().phase !== 'thinking') break;
      }
    } finally {
      vi.useRealTimers();
    }

    // Every generated sequence was delivered by the server, exactly once, in order.
    const delivered = b.serverAudioSeqs();
    expect(delivered).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
    // Buffers stayed bounded at every stage (never the full 60 s at once).
    expect(maxLive).toBeLessThanOrEqual(12);
    expect(ctx.live.size).toBe(0);
    // The turn completed as a genuine played drain (listening again), not stalled,
    // and progress-driven release was observed throughout.
    expect(['listening', 'muted', 'paused']).toContain(b.view().phase);

    await b.client.end();
  });
});
