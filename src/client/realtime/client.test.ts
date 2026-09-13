import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRANSPORT_AUDIO_BYTES, type ConversationSnapshot, type ConversationView } from '../../shared/realtime.js';
import { createConversationClient } from './client.js';
import { FakeSocket, makeFakeAudio } from './fixtures/fakes.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options?: { failCreate?: boolean; speechAvailable?: boolean }) {
  const sockets: FakeSocket[] = [];
  const views: ConversationView[] = [];
  const { factory, control } = makeFakeAudio({ failCreate: options?.failCreate });
  let audioFactoryCalls = 0;
  const refreshAccess = vi.fn(async () => {});
  const client = createConversationClient({
    url: 'wss://local/session',
    speechAvailable: options?.speechAvailable ?? true,
    refreshAccess,
    onChange: (view) => views.push(view),
    audioFactory: (opts) => {
      audioFactoryCalls += 1;
      return factory(opts);
    },
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return {
    client,
    sockets,
    views,
    control,
    refreshAccess,
    audioFactoryCalls: () => audioFactoryCalls,
    last: () => views[views.length - 1],
  };
}

const snapshot = (over: Partial<ConversationSnapshot> = {}): { type: 'snapshot'; snapshot: ConversationSnapshot } => ({
  type: 'snapshot',
  snapshot: {
    sessionId: 'sess-1',
    mode: 'fixture',
    phase: 'idle',
    speechAvailable: true,
    lastTurnId: 0,
    messages: [],
    ...over,
  },
});

async function connected(h: ReturnType<typeof setup>): Promise<FakeSocket> {
  await h.client.start();
  const socket = h.sockets[0];
  socket.open();
  socket.receive(snapshot());
  await tick();
  return socket;
}

const frame = (bytes = 1024): ArrayBuffer => new ArrayBuffer(bytes);

afterEach(() => {
  vi.useRealTimers();
});

describe('conversation client: connection lifecycle', () => {
  it('creates audio before connecting, sends hello, and arms listening on snapshot', async () => {
    const h = setup();
    await h.client.start();
    // Audio is created in the gesture before the socket exists.
    expect(h.control().modes).toEqual([]);
    expect(h.sockets).toHaveLength(1);
    expect(h.refreshAccess).toHaveBeenCalledTimes(1);

    const socket = h.sockets[0];
    socket.open();
    expect(socket.commands()[0]).toEqual({ type: 'hello', version: 2 });

    socket.receive(snapshot({ sessionId: 'sess-1' }));
    await tick();
    expect(h.last().connection).toBe('connected');
    expect(h.last().phase).toBe('listening');
    expect(h.last().sessionId).toBe('sess-1');
    expect(h.control().modes.at(-1)).toBe('listen');
  });

  it('still connects for text when microphone creation fails', async () => {
    const h = setup({ failCreate: true });
    await h.client.start();
    expect(h.sockets).toHaveLength(1);
    expect(h.last().audioAvailable).toBe(false);
    expect(h.last().notice).toMatch(/type a message/i);
  });
});

describe('conversation client: hands-free turn', () => {
  it('buffers audio until input_ready then sends frames once with rising sequence', async () => {
    const h = setup();
    const socket = await connected(h);
    const audio = h.control().options;

    audio.onSpeechStart();
    expect(socket.commands()).toContainEqual({ type: 'record', turnId: 1 });
    expect(h.last().phase).toBe('recording');

    audio.onPcm(frame()); // buffered: not ready yet
    expect(socket.audioFrames()).toHaveLength(0);

    socket.receive({ type: 'input_ready', turnId: 1 });
    expect(socket.audioFrames().map((f) => f.seq)).toEqual([1]);

    audio.onPcm(frame());
    expect(socket.audioFrames().map((f) => f.seq)).toEqual([1, 2]);
    expect(socket.audioFrames().every((f) => f.turnId === 1)).toBe(true);

    audio.onSpeechEnd();
    await tick();
    expect(socket.commands().some((command) => command.type === 'finish')).toBe(false);
    socket.receive({ type: 'audio_ack', turnId: 1, seq: 2 });
    expect(socket.commands()).toContainEqual({ type: 'finish', turnId: 1, lastSeq: 2 });
    expect(h.last().phase).toBe('thinking');
  });

  it('does not admit an overlapping turn or duplicate the finish', async () => {
    const h = setup();
    const socket = await connected(h);
    const audio = h.control().options;

    audio.onSpeechStart();
    audio.onSpeechStart(); // ignored while a turn is live
    expect(socket.commands().filter((c) => c.type === 'record')).toHaveLength(1);

    socket.receive({ type: 'input_ready', turnId: 1 });
    audio.onSpeechEnd();
    audio.onSpeechEnd(); // idempotent
    await tick();
    expect(socket.commands().filter((c) => c.type === 'finish')).toHaveLength(1);
  });

  it('releases in-flight bytes as cumulative acks arrive', async () => {
    const h = setup();
    const socket = await connected(h);
    const audio = h.control().options;
    audio.onSpeechStart();
    socket.receive({ type: 'input_ready', turnId: 1 });
    audio.onPcm(frame());
    audio.onPcm(frame());
    socket.receive({ type: 'audio_ack', turnId: 1, seq: 2 });
    // Further capture still flows after the ack without error.
    audio.onPcm(frame());
    expect(socket.audioFrames().map((f) => f.seq)).toEqual([1, 2, 3]);
  });
});

describe('conversation client: bounded overflow', () => {
  it('aborts the unfinished input and asks for a repeat on overflow', async () => {
    const h = setup();
    const socket = await connected(h);
    const audio = h.control().options;
    audio.onSpeechStart();
    // Fill past the transport budget with max-size frames (never acked).
    const big = 32768;
    const needed = Math.floor(TRANSPORT_AUDIO_BYTES / big) + 1;
    for (let i = 0; i <= needed; i += 1) audio.onPcm(frame(big));

    const abort = socket.commands().find((c) => c.type === 'abort_input');
    expect(abort).toEqual({ type: 'abort_input', turnId: 1, reason: 'overflow' });
    expect(h.last().notice).toMatch(/say it again/i);
    expect(h.last().phase).toBe('listening');
    expect(h.control().clearCount).toBeGreaterThan(0);
  });
});

describe('conversation client: stall watchdog', () => {
  it('warns at 2s and aborts the truncated input at 5s without an ack', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.client.start();
    const socket = h.sockets[0];
    socket.open();
    socket.receive(snapshot());
    const audio = h.control().options;
    audio.onSpeechStart();
    socket.receive({ type: 'input_ready', turnId: 1 });
    audio.onPcm(frame());

    vi.advanceTimersByTime(2000);
    expect(h.last().notice).toMatch(/slow/i);

    vi.advanceTimersByTime(3000);
    expect(socket.commands()).toContainEqual({ type: 'abort_input', turnId: 1, reason: 'discontinuity' });
    expect(h.last().phase).toBe('listening');
  });
});

describe('conversation client: reconnect', () => {
  it('reconnects after a transient drop, refreshing access and replaying only unacked audio', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.client.start();
    const first = h.sockets[0];
    first.open();
    first.receive(snapshot({ sessionId: 'sess-9' }));
    const audio = h.control().options;
    audio.onSpeechStart();
    first.receive({ type: 'input_ready', turnId: 1 });
    audio.onPcm(frame());
    audio.onPcm(frame());
    audio.onPcm(frame());
    first.receive({ type: 'audio_ack', turnId: 1, seq: 1 });
    expect(first.audioFrames().map((f) => f.seq)).toEqual([1, 2, 3]);

    first.drop();
    expect(h.last().connection).toBe('reconnecting');
    h.refreshAccess.mockClear();

    await vi.advanceTimersByTimeAsync(750);
    expect(h.refreshAccess).toHaveBeenCalledTimes(1);
    expect(h.sockets).toHaveLength(2);
    const second = h.sockets[1];
    second.open();
    // Reconnect never sends end or clears retained state.
    expect(second.commands()[0]).toEqual({ type: 'hello', version: 2, sessionId: 'sess-9' });
    expect(first.commands().some((c) => c.type === 'end')).toBe(false);

    second.receive(snapshot({ sessionId: 'sess-9', lastTurnId: 1, input: { turnId: 1, lastSeq: 1, committed: false } }));
    // Only the unacknowledged frames (2, 3) are retransmitted.
    expect(second.audioFrames().map((f) => f.seq)).toEqual([2, 3]);
  });
});

describe('conversation client: snapshot reconciliation', () => {
  it('adopts authoritative transcript and turn counter without rerunning commands', async () => {
    const h = setup();
    const socket = await connected(h);
    socket.receive(
      snapshot({
        lastTurnId: 5,
        messages: [
          { turnId: 4, role: 'user', text: 'hello' },
          { turnId: 4, role: 'assistant', text: 'hi there' },
        ],
      }),
    );
    await tick();
    expect(h.last().messages).toHaveLength(2);
    // No record/finish/text were re-emitted from reconciliation.
    expect(socket.commands().filter((c) => ['record', 'finish', 'text'].includes(c.type))).toHaveLength(0);

    // Next spoken turn continues after the server's last turn id.
    h.control().options.onSpeechStart();
    expect(socket.commands()).toContainEqual({ type: 'record', turnId: 6 });
  });
});

describe('conversation client: responses and barge-in', () => {
  it('plays audio, acknowledges a completed response, and drops stale events', async () => {
    const h = setup();
    const socket = await connected(h);
    socket.receive({ type: 'audio', turnId: 2, responseId: 5, seq: 1, audio: 'AAA=', sampleRate: 16000 });
    expect(h.last().phase).toBe('speaking');
    expect(h.control().enqueued).toContainEqual({ responseId: 5, seq: 1 });

    // A stale (older) response's audio is ignored.
    socket.receive({ type: 'audio', turnId: 1, responseId: 4, seq: 1, audio: 'AAA=', sampleRate: 16000 });
    expect(h.control().enqueued).toHaveLength(1);

    socket.receive({ type: 'response_done', turnId: 2, responseId: 5, lastAudioSeq: 1 });
    h.control().settleFinish('played');
    await tick();
    expect(socket.commands()).toContainEqual({ type: 'playback_done', responseId: 5, lastSeq: 1 });
    expect(h.last().phase).toBe('listening');
  });

  it('acknowledges an explicitly cancelled drain as skipped but not a paused one', async () => {
    const h = setup();
    const socket = await connected(h);
    socket.receive({ type: 'audio', turnId: 2, responseId: 5, seq: 1, audio: 'AAA=', sampleRate: 16000 });
    socket.receive({ type: 'response_done', turnId: 2, responseId: 5, lastAudioSeq: 1 });
    h.control().settleFinish('interrupted');
    await tick();
    expect(socket.commands()).toContainEqual({ type: 'playback_done', responseId: 5, lastSeq: 1, skipped: true });

    // A paused drain withholds acknowledgement and exposes resume.
    socket.receive({ type: 'audio', turnId: 4, responseId: 7, seq: 1, audio: 'AAA=', sampleRate: 16000 });
    socket.receive({ type: 'response_done', turnId: 4, responseId: 7, lastAudioSeq: 1 });
    h.control().settleFinish('paused');
    await tick();
    expect(socket.commands().filter((c) => c.type === 'playback_done' && c.responseId === 7)).toHaveLength(0);
    expect(h.last().canResumeAudio).toBe(true);
    expect(h.last().phase).toBe('paused');

    await h.client.resumeAudio();
    expect(h.last().canResumeAudio).toBe(false);
  });

  it('clears playback and interrupts on barge-in but defers record until settlement', async () => {
    const h = setup();
    const socket = await connected(h);
    socket.receive({ type: 'audio', turnId: 2, responseId: 5, seq: 1, audio: 'AAA=', sampleRate: 16000 });
    expect(h.last().phase).toBe('speaking');

    const audio = h.control().options;
    audio.onSpeechStart();
    // Playback is dropped and interrupt is sent immediately...
    expect(h.control().cancels.length).toBeGreaterThan(0);
    expect(socket.commands()).toContainEqual({ type: 'interrupt', responseId: 5 });
    expect(h.last().phase).toBe('recording');
    // ...but the replacement record is withheld while the server is still busy.
    expect(socket.commands().some((c) => c.type === 'record')).toBe(false);

    // Replacement speech captured meanwhile is buffered (bounded), not sent.
    audio.onPcm(frame());
    expect(socket.audioFrames()).toHaveLength(0);

    // The server settles the interrupted response; only now is record admitted.
    socket.receive({ type: 'response_cancelled', responseId: 5 });
    expect(socket.commands()).toContainEqual({ type: 'record', turnId: 1 });

    // Buffered replacement speech flushes once the server acknowledges record.
    socket.receive({ type: 'input_ready', turnId: 1 });
    expect(socket.audioFrames().map((f) => f.seq)).toEqual([1]);
    expect(socket.audioFrames().every((f) => f.turnId === 1)).toBe(true);
  });

  it('admits a deferred barge-in record when speech ends before cancellation settles', async () => {
    const h = setup();
    const socket = await connected(h);
    socket.receive({ type: 'audio', turnId: 2, responseId: 5, seq: 1, audio: 'AAA=', sampleRate: 16000 });
    const audio = h.control().options;

    audio.onSpeechStart(); // barge-in: record deferred
    audio.onPcm(frame());
    audio.onSpeechEnd(); // speech ends while cancellation is still pending
    await tick();
    // No record/finish leak out before the server settles.
    expect(socket.commands().some((c) => c.type === 'record')).toBe(false);
    expect(socket.commands().some((c) => c.type === 'finish')).toBe(false);

    socket.receive({ type: 'response_cancelled', responseId: 5 });
    expect(socket.commands()).toContainEqual({ type: 'record', turnId: 1 });

    socket.receive({ type: 'input_ready', turnId: 1 });
    // Readiness permits transmission, but finalization still needs receipt.
    expect(socket.audioFrames().map((f) => f.seq)).toEqual([1]);
    expect(socket.commands().some((command) => command.type === 'finish')).toBe(false);
    socket.receive({ type: 'audio_ack', turnId: 1, seq: 1 });
    expect(socket.commands()).toContainEqual({ type: 'finish', turnId: 1, lastSeq: 1 });
  });
});

describe('conversation client: mute, text, and cleanup', () => {
  it('mutes by aborting the live input and disabling capture mode', async () => {
    const h = setup();
    const socket = await connected(h);
    const audio = h.control().options;
    audio.onSpeechStart();
    h.client.mute(true);
    expect(socket.commands()).toContainEqual({ type: 'abort_input', turnId: 1, reason: 'muted' });
    expect(h.control().modes.at(-1)).toBe('muted');
    expect(h.last().muted).toBe(true);
    h.client.mute(false);
    expect(h.control().modes.at(-1)).toBe('listen');
  });

  it('sends a typed turn, pre-empting any half-captured speech', async () => {
    const h = setup();
    const socket = await connected(h);
    h.control().options.onSpeechStart();
    h.client.sendText('  explain this  ');
    expect(socket.commands()).toContainEqual({ type: 'abort_input', turnId: 1, reason: 'interrupted' });
    expect(socket.commands()).toContainEqual({ type: 'text', turnId: 2, text: 'explain this' });
  });

  it('ends once, closing the socket and audio even if closed twice', async () => {
    const h = setup();
    const socket = await connected(h);
    await h.client.end();
    await h.client.end();
    expect(socket.closed).toBe(true);
    expect(socket.commands()).toContainEqual({ type: 'end' });
    expect(h.control().closeCount).toBe(1);
    expect(h.last().phase).toBe('ended');
  });

  it('closes asynchronously-created audio when ended mid-start', async () => {
    const sockets: FakeSocket[] = [];
    const { factory, control } = makeFakeAudio();
    let resolved = false;
    const client = createConversationClient({
      url: 'wss://local/session',
      speechAvailable: true,
      refreshAccess: async () => {},
      onChange: () => {},
      audioFactory: async (opts) => {
        await tick();
        resolved = true;
        return factory(opts);
      },
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const starting = client.start();
    await client.end(); // ends before audio creation resolves
    await starting;
    expect(resolved).toBe(true);
    expect(control().closeCount).toBe(1);
    // Never connected, since end won the race.
    expect(sockets).toHaveLength(0);
  });
});

describe('conversation client: pending-input lifecycle', () => {
  it('withholds finish until input_ready, then flushes buffered audio and finishes once', async () => {
    const h = setup();
    const socket = await connected(h);
    const audio = h.control().options;

    audio.onSpeechStart();
    audio.onPcm(frame());
    audio.onPcm(frame());
    // Speech ends before the server acknowledges the turn.
    audio.onSpeechEnd();
    await tick();
    // Nothing captured is sent and finish is withheld until readiness.
    expect(socket.audioFrames()).toHaveLength(0);
    expect(socket.commands().some((c) => c.type === 'finish')).toBe(false);
    expect(h.last().phase).toBe('thinking');

    socket.receive({ type: 'input_ready', turnId: 1 });
    // Captured audio is transmitted first; finish waits for every sample's ACK.
    expect(socket.audioFrames().map((f) => f.seq)).toEqual([1, 2]);
    expect(socket.commands().some((command) => command.type === 'finish')).toBe(false);
    socket.receive({ type: 'audio_ack', turnId: 1, seq: 1 });
    expect(socket.commands().some((command) => command.type === 'finish')).toBe(false);
    socket.receive({ type: 'audio_ack', turnId: 1, seq: 2 });
    expect(socket.commands()).toContainEqual({ type: 'finish', turnId: 1, lastSeq: 2 });
    expect(socket.commands().filter((c) => c.type === 'finish')).toHaveLength(1);
  });

  it('never emits finish while captured audio is still unsent', async () => {
    const h = setup();
    const socket = await connected(h);
    const audio = h.control().options;
    audio.onSpeechStart();
    // Ready, but capture some audio and finalize in the same synchronous burst.
    socket.receive({ type: 'input_ready', turnId: 1 });
    audio.onPcm(frame());
    audio.onPcm(frame());
    audio.onSpeechEnd();
    await tick();
    // Frame receipt, not just send(), precedes the finish barrier.
    expect(socket.commands().some((command) => command.type === 'finish')).toBe(false);
    socket.receive({ type: 'audio_ack', turnId: 1, seq: 2 });
    const commands = socket.commands();
    const finish = commands.find((c) => c.type === 'finish');
    expect(finish).toEqual({ type: 'finish', turnId: 1, lastSeq: 2 });
    expect(socket.audioFrames().map((f) => f.seq)).toEqual([1, 2]);
  });

  it('redelivers unacked audio and re-drives finish after a reconnect (lost ack)', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.client.start();
    const first = h.sockets[0];
    first.open();
    first.receive(snapshot({ sessionId: 'sess-2' }));
    const audio = h.control().options;
    audio.onSpeechStart();
    first.receive({ type: 'input_ready', turnId: 1 });
    audio.onPcm(frame());
    audio.onPcm(frame());
    audio.onPcm(frame());
    // Only seq 1 is acknowledged; acks for 2 and 3 are lost.
    first.receive({ type: 'audio_ack', turnId: 1, seq: 1 });
    audio.onSpeechEnd();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.commands().some((command) => command.type === 'finish')).toBe(false);

    first.drop();
    await vi.advanceTimersByTimeAsync(750);
    const second = h.sockets[1];
    second.open();
    second.receive(snapshot({ sessionId: 'sess-2', lastTurnId: 1, input: { turnId: 1, lastSeq: 1, committed: false } }));
    // Unacked frames replay; the retained finish waits for their receipt.
    expect(second.audioFrames().map((f) => f.seq)).toEqual([2, 3]);
    expect(second.commands().some((command) => command.type === 'finish')).toBe(false);
    second.receive({ type: 'audio_ack', turnId: 1, seq: 3 });
    expect(second.commands()).toContainEqual({ type: 'finish', turnId: 1, lastSeq: 3 });
  });

  it('preserves the finish intent when speech ends while offline', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.client.start();
    const first = h.sockets[0];
    first.open();
    first.receive(snapshot({ sessionId: 'sess-3' }));
    const audio = h.control().options;
    audio.onSpeechStart();
    first.receive({ type: 'input_ready', turnId: 1 });
    audio.onPcm(frame()); // seq 1 sent

    first.drop(); // endpoint goes offline
    audio.onSpeechEnd(); // speech ends while there is no socket
    await vi.advanceTimersByTimeAsync(0);
    // The finish is not lost; it is retained rather than dropped.
    expect(first.commands().some((c) => c.type === 'finish')).toBe(false);
    expect(h.last().phase).toBe('thinking');

    await vi.advanceTimersByTimeAsync(750);
    const second = h.sockets[1];
    second.open();
    second.receive(snapshot({ sessionId: 'sess-3', lastTurnId: 1, input: { turnId: 1, lastSeq: 0, committed: false } }));
    // The unsent tail is retransmitted; its ACK releases the retained finish.
    expect(second.audioFrames().map((f) => f.seq)).toEqual([1]);
    expect(second.commands().some((command) => command.type === 'finish')).toBe(false);
    second.receive({ type: 'audio_ack', turnId: 1, seq: 1 });
    expect(second.commands()).toContainEqual({ type: 'finish', turnId: 1, lastSeq: 1 });
  });
});

describe('conversation client: paused completion', () => {
  it('retains the playback obligation across pause and acknowledges only on resume drain', async () => {
    const h = setup();
    const socket = await connected(h);
    socket.receive({ type: 'audio', turnId: 2, responseId: 7, seq: 1, audio: 'AAA=', sampleRate: 16000 });
    socket.receive({ type: 'response_done', turnId: 2, responseId: 7, lastAudioSeq: 1 });
    h.control().settleFinish('paused');
    await tick();
    // Paused: no acknowledgement, and never advertises listening.
    expect(socket.commands().filter((c) => c.type === 'playback_done')).toHaveLength(0);
    expect(h.last().phase).toBe('paused');
    expect(h.last().canResumeAudio).toBe(true);

    // Resume re-establishes the completion waiter; playback_done follows the
    // genuine drain, carrying the retained responseId/lastSeq.
    await h.client.resumeAudio();
    expect(h.last().canResumeAudio).toBe(false);
    h.control().settleFinish('played');
    await tick();
    expect(socket.commands()).toContainEqual({ type: 'playback_done', responseId: 7, lastSeq: 1 });
    expect(h.last().phase).toBe('listening');
  });
});

describe('conversation client: audio availability and independence', () => {
  it('skips audio/VAD entirely when speech is unavailable but still connects for text', async () => {
    const h = setup({ speechAvailable: false });
    await h.client.start();
    expect(h.audioFactoryCalls()).toBe(0);
    expect(h.sockets).toHaveLength(1);
    const socket = h.sockets[0];
    socket.open();
    socket.receive(snapshot());
    await tick();
    expect(h.last().audioAvailable).toBe(false);
    expect(h.last().canSendText).toBe(true);
  });

  it('connects for typed chat while the microphone permission is still pending', async () => {
    const sockets: FakeSocket[] = [];
    const { factory } = makeFakeAudio();
    let releaseAudio!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAudio = resolve;
    });
    const views: ConversationView[] = [];
    const client = createConversationClient({
      url: 'wss://local/session',
      speechAvailable: true,
      refreshAccess: async () => {},
      onChange: (view) => views.push(view),
      audioFactory: async (opts) => {
        await gate; // an unanswered permission prompt / slow WASM load
        return factory(opts);
      },
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    await client.start();
    // The connection did not wait for the still-pending microphone.
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    sockets[0].receive({
      type: 'snapshot',
      snapshot: { sessionId: 's', mode: 'fixture', phase: 'idle', speechAvailable: true, lastTurnId: 0, messages: [] },
    });
    await tick();
    client.sendText('hello there');
    expect(sockets[0].commands()).toContainEqual({ type: 'text', turnId: 1, text: 'hello there' });

    releaseAudio();
    await client.end();
  });
});

describe('conversation client: transcript rendering', () => {
  it('does not re-emit or clone the transcript on audio-only frames after the first', async () => {
    const h = setup();
    const socket = await connected(h);
    socket.receive({ type: 'audio', turnId: 2, responseId: 5, seq: 1, audio: 'AAA=', sampleRate: 16000 });
    expect(h.last().phase).toBe('speaking');
    const emissionsAfterFirst = h.views.length;

    socket.receive({ type: 'audio', turnId: 2, responseId: 5, seq: 2, audio: 'AAA=', sampleRate: 16000 });
    socket.receive({ type: 'audio', turnId: 2, responseId: 5, seq: 3, audio: 'AAA=', sampleRate: 16000 });
    // No view change was pushed for the audio-only frames...
    expect(h.views.length).toBe(emissionsAfterFirst);
    // ...but the audio was still enqueued for playback.
    expect(h.control().enqueued.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});
