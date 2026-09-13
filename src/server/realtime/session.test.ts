import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConversation } from './session.js';
import { createHarness } from '../harness/index.js';
import { createSpeech } from '../speech/index.js';
import { startFixture, type Fixture, type FixtureOptions } from '../speech/fixtures/eleven-labs.js';
import type {
  AudioFrame,
  RealtimeEvent,
  RealtimeHarness,
  RealtimeSpeech,
  RetainedConversation,
} from '../../shared/realtime.js';
import type { SpeechTokenKind } from '../../shared/contracts.js';

// Real subprocess CLI fixture + real WebSocket speech fixture. These tests
// exercise process/socket races and error paths, not return-value stubs.
const CLI_FIXTURE = fileURLToPath(new URL('../harness/fixtures/cli-fixture.mjs', import.meta.url));

interface Built {
  conv: RetainedConversation;
  events: RealtimeEvent[];
  tokenCalls: SpeechTokenKind[];
  attach(): void;
  cleanup: Array<() => void | Promise<void>>;
}

const active: Built[] = [];

interface BuildOptions {
  scenario?: string;
  harnessEnv?: Record<string, string | undefined>;
  fixtureOptions?: FixtureOptions;
  withSpeech?: boolean;
  harnessTimeoutMs?: number;
}

async function build(options: BuildOptions = {}): Promise<Built> {
  const events: RealtimeEvent[] = [];
  const tokenCalls: SpeechTokenKind[] = [];
  const withSpeech = options.withSpeech !== false;
  let fixture: Fixture | undefined;
  if (withSpeech) fixture = await startFixture(options.fixtureOptions);

  const conv = createConversation({
    id: 'sess-1',
    mode: 'fixture',
    harness: (onEvent) =>
      createHarness({
        command: process.execPath,
        args: [CLI_FIXTURE],
        env: { SCENARIO: options.scenario ?? 'basic', ...options.harnessEnv },
        onEvent,
        timeoutMs: options.harnessTimeoutMs ?? 3000,
      }) as RealtimeHarness,
    speech: fixture
      ? (callbacks) => {
          const s = createSpeech({
            voiceId: 'test-voice',
            getToken: async (kind) => {
              tokenCalls.push(kind);
              return `tok-${kind}`;
            },
            onPartial: callbacks.onPartial,
            onAudio: callbacks.onAudio,
            onError: callbacks.onError,
            endpoints: { stt: fixture!.sttEndpoint, tts: fixture!.ttsEndpoint },
            timeoutMs: 1000,
          });
          const realtime: RealtimeSpeech = {
            startRecognition: () => s.startRecognition(),
            writeAudio: (pcm) => s.acceptAudio!(pcm),
            commitRecognition: () => s.commitRecognition(),
            writeText: (text) => s.writeText(text),
            finishSpeech: () => s.finishSpeech(),
            close: () => s.close(),
            abortRecognition: () => s.abortRecognition!(),
            cancelSpeech: () => s.cancelSpeech!(),
          };
          return realtime;
        }
      : undefined,
  });

  const built: Built = {
    conv,
    events,
    tokenCalls,
    attach: () => conv.attach((event) => events.push(event)),
    cleanup: [],
  };
  if (fixture) built.cleanup.push(() => fixture!.close());
  built.cleanup.push(() => conv.close());
  active.push(built);
  return built;
}

afterEach(async () => {
  for (const built of active.splice(0)) {
    for (const cleanup of built.cleanup) {
      try {
        await cleanup();
      } catch {
        /* teardown is best-effort */
      }
    }
  }
});

function pcm(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

function frame(turnId: number, seq: number, text: string): AudioFrame {
  return { turnId, seq, pcm: pcm(text) };
}

const only = <T extends RealtimeEvent['type']>(events: RealtimeEvent[], type: T) =>
  events.filter((e): e is Extract<RealtimeEvent, { type: T }> => e.type === type);

describe('createConversation — happy path', () => {
  it('runs a full spoken turn: record, ack contiguous audio, commit, infer, and speak', async () => {
    const b = await build({ scenario: 'basic', fixtureOptions: { sttPartials: true } });
    b.attach();
    await b.conv.start();

    await b.conv.handle({ type: 'record', turnId: 1 });
    expect(only(b.events, 'input_ready').map((e) => e.turnId)).toEqual([1]);

    b.conv.audio(frame(1, 1, 'hello'));
    b.conv.audio(frame(1, 2, 'world'));
    expect(only(b.events, 'audio_ack').map((e) => e.seq)).toEqual([1, 2]);

    await b.conv.handle({ type: 'finish', turnId: 1, lastSeq: 2 });
    await vi.waitFor(() => expect(only(b.events, 'response_done')).toHaveLength(1));

    expect(only(b.events, 'user')).toEqual([{ type: 'user', turnId: 1, text: 'hello world' }]);
    expect(only(b.events, 'text').map((e) => e.text).join('')).toBe('Hello café 🌊 world');
    const audio = only(b.events, 'audio');
    expect(audio.length).toBeGreaterThan(0);
    expect(audio.every((a) => a.sampleRate === 24000 && a.responseId === 1)).toBe(true);
    const done = only(b.events, 'response_done')[0];
    expect(done.lastAudioSeq).toBe(audio.length);

    // Playback acknowledgement returns to idle.
    b.conv.handle({ type: 'playback_done', responseId: 1, lastSeq: done.lastAudioSeq });
    await vi.waitFor(() => expect(b.conv.snapshot().phase).toBe('idle'));
  });

  it('answers a typed turn without recognition', async () => {
    const b = await build({ scenario: 'basic' });
    b.attach();
    await b.conv.start();
    await b.conv.handle({ type: 'text', turnId: 1, text: 'type me' });
    await vi.waitFor(() => expect(only(b.events, 'response_done')).toHaveLength(1));
    expect(only(b.events, 'user')).toEqual([{ type: 'user', turnId: 1, text: 'type me' }]);
    expect(only(b.events, 'text').map((e) => e.text).join('')).toBe('Hello café 🌊 world');
    expect(b.tokenCalls).not.toContain('realtime_scribe');
  });

  it('reports web/fermi capabilities from harness init MCP metadata', async () => {
    const b = await build({ scenario: 'basic', harnessEnv: { MCP: '1' } });
    b.attach();
    await b.conv.start();
    await vi.waitFor(() => expect(only(b.events, 'capabilities')).toHaveLength(1));
    expect(only(b.events, 'capabilities')[0].capabilities).toEqual({
      web: false,
      fermi: 'connected',
      tools: ['Read', 'Bash'],
    });
  });
});

describe('createConversation — audio acceptance invariants', () => {
  it('re-ACKs a benign duplicate frame without feeding recognition twice', async () => {
    const b = await build();
    b.attach();
    await b.conv.start();
    await b.conv.handle({ type: 'record', turnId: 1 });

    b.conv.audio(frame(1, 1, 'a'));
    b.conv.audio(frame(1, 1, 'a')); // identical retransmit
    expect(only(b.events, 'audio_ack').filter((e) => e.seq === 1)).toHaveLength(2);
    expect(only(b.events, 'input_aborted')).toHaveLength(0);
  });

  it('drops a non-contiguous frame without ACK, then accepts the gap filler', async () => {
    const b = await build();
    b.attach();
    await b.conv.start();
    await b.conv.handle({ type: 'record', turnId: 1 });

    b.conv.audio(frame(1, 1, 'a'));
    b.conv.audio(frame(1, 3, 'c')); // gap: dropped, no ack
    b.conv.audio(frame(1, 2, 'b')); // fills the gap: accepted
    expect(only(b.events, 'audio_ack').map((e) => e.seq)).toEqual([1, 2]);
  });

  it('aborts the input on a conflicting reuse of an accepted sequence number', async () => {
    const b = await build();
    b.attach();
    await b.conv.start();
    await b.conv.handle({ type: 'record', turnId: 1 });

    b.conv.audio(frame(1, 1, 'a'));
    b.conv.audio(frame(1, 1, 'DIFFERENT')); // same seq, different bytes
    const aborted = only(b.events, 'input_aborted');
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).toMatchObject({ turnId: 1, reason: 'discontinuity' });
  });

  it('refuses to commit a truncated prefix when the declared last sequence was never received', async () => {
    const b = await build();
    b.attach();
    await b.conv.start();
    await b.conv.handle({ type: 'record', turnId: 1 });
    b.conv.audio(frame(1, 1, 'a'));

    await b.conv.handle({ type: 'finish', turnId: 1, lastSeq: 3 });
    expect(only(b.events, 'input_aborted')[0]).toMatchObject({ turnId: 1, reason: 'discontinuity' });
    expect(only(b.events, 'user')).toHaveLength(0);
    expect(only(b.events, 'response_done')).toHaveLength(0);
  });
});

describe('createConversation — turn ordering & idempotency', () => {
  it('treats a duplicate record of the open turn as an idempotent re-ready', async () => {
    const b = await build();
    b.attach();
    await b.conv.start();
    await b.conv.handle({ type: 'record', turnId: 1 });
    await b.conv.handle({ type: 'record', turnId: 1 });
    expect(only(b.events, 'input_ready')).toHaveLength(2);
    expect(only(b.events, 'notice')).toHaveLength(0);
  });

  it('rejects overlapping inference with a busy notice', async () => {
    const b = await build({ scenario: 'hang', harnessTimeoutMs: 1500 });
    b.attach();
    await b.conv.start();
    await b.conv.handle({ type: 'text', turnId: 1, text: 'first' });
    await b.conv.handle({ type: 'text', turnId: 2, text: 'second' });
    expect(only(b.events, 'notice').some((n) => n.code === 'busy')).toBe(true);
  });

  it('ignores an identical replayed text turn but rejects conflicting reuse', async () => {
    const b = await build({ scenario: 'hang', harnessTimeoutMs: 1500 });
    b.attach();
    await b.conv.start();
    await b.conv.handle({ type: 'text', turnId: 1, text: 'hello' });
    await b.conv.handle({ type: 'text', turnId: 1, text: 'hello' }); // exact replay -> idempotent
    expect(only(b.events, 'notice').filter((n) => n.code === 'stale_turn')).toHaveLength(0);
    await b.conv.handle({ type: 'text', turnId: 1, text: 'different' }); // conflicting reuse
    expect(only(b.events, 'notice').some((n) => n.code === 'stale_turn')).toBe(true);
  });
});

describe('createConversation — interruption', () => {
  it('barges in: cancels output, settles the interrupt, and never emits response_done', async () => {
    const b = await build({ scenario: 'interrupt', harnessTimeoutMs: 3000 });
    b.attach();
    await b.conv.start();
    await b.conv.handle({ type: 'text', turnId: 1, text: 'go' });
    await vi.waitFor(() => expect(only(b.events, 'text').some((e) => e.text.includes('Partial answer'))).toBe(true));

    await b.conv.handle({ type: 'interrupt', responseId: 1 });
    expect(only(b.events, 'response_cancelled')).toEqual([{ type: 'response_cancelled', responseId: 1 }]);
    expect(only(b.events, 'response_done')).toHaveLength(0);
    // Late fenced generation text must not have surfaced.
    expect(only(b.events, 'text').some((e) => e.text.includes('LATE-AFTER-INTERRUPT'))).toBe(false);
    expect(b.conv.snapshot().phase).toBe('idle');
  });

  it('ignores an interrupt for a stale response id', async () => {
    const b = await build({ scenario: 'interrupt', harnessTimeoutMs: 3000 });
    b.attach();
    await b.conv.start();
    await b.conv.handle({ type: 'text', turnId: 1, text: 'go' });
    await vi.waitFor(() => expect(only(b.events, 'text')).not.toHaveLength(0));
    await b.conv.handle({ type: 'interrupt', responseId: 999 });
    expect(only(b.events, 'response_cancelled')).toHaveLength(0);
  });
});

describe('createConversation — abort, ping, and lifecycle', () => {
  it('aborts recording on request and asks for a repeat', async () => {
    const b = await build();
    b.attach();
    await b.conv.start();
    await b.conv.handle({ type: 'record', turnId: 1 });
    b.conv.audio(frame(1, 1, 'a'));
    await b.conv.handle({ type: 'abort_input', turnId: 1, reason: 'muted' });
    expect(only(b.events, 'input_aborted')[0]).toMatchObject({ turnId: 1, reason: 'muted' });
    expect(only(b.events, 'notice').some((n) => n.code === 'repeat')).toBe(true);
    expect(b.conv.snapshot().phase).toBe('idle');
  });

  it('answers ping with pong', async () => {
    const b = await build({ withSpeech: false });
    b.attach();
    await b.conv.start();
    await b.conv.handle({ type: 'ping', id: 7 });
    expect(only(b.events, 'pong')).toEqual([{ type: 'pong', id: 7 }]);
  });

  it('notifies when recording without speech configured', async () => {
    const b = await build({ withSpeech: false });
    b.attach();
    await b.conv.start();
    await b.conv.handle({ type: 'record', turnId: 1 });
    expect(only(b.events, 'notice').some((n) => n.code === 'speech_unavailable')).toBe(true);
  });

  it('close() is idempotent and emits ended once', async () => {
    const b = await build({ withSpeech: false });
    b.attach();
    await b.conv.start();
    await b.conv.close();
    await b.conv.close();
    expect(only(b.events, 'ended')).toHaveLength(1);
    // Commands after close are ignored.
    await b.conv.handle({ type: 'ping', id: 1 });
    expect(only(b.events, 'pong')).toHaveLength(0);
  });
});

describe('createConversation — detach / attach recovery', () => {
  it('retains the transcript across reconnect and never replays audio', async () => {
    const b = await build({ scenario: 'basic' });
    b.attach();
    await b.conv.start();
    await b.conv.handle({ type: 'text', turnId: 1, text: 'hi there' });
    await vi.waitFor(() => expect(only(b.events, 'response_done')).toHaveLength(1));

    b.conv.detach();
    const resumeEvents: RealtimeEvent[] = [];
    b.conv.attach((e) => resumeEvents.push(e));

    const snap = only(resumeEvents, 'snapshot')[0].snapshot;
    expect(snap.messages).toEqual([
      { turnId: 1, role: 'user', text: 'hi there' },
      { turnId: 1, role: 'assistant', text: 'Hello café 🌊 world' },
    ]);
    // A resume carries transcript/status only — never replayed audio frames.
    expect(only(resumeEvents, 'audio')).toHaveLength(0);
  });

  it('finishes a detached response into retained text without unheard audio, and reports it interrupted', async () => {
    const b = await build({ scenario: 'basic', harnessEnv: { DELAY_MS: '250' } });
    b.attach();
    await b.conv.start();
    await b.conv.handle({ type: 'text', turnId: 1, text: 'slow one' });
    // Detach after text has streamed but before the delayed result settles.
    await vi.waitFor(() => expect(only(b.events, 'text')).not.toHaveLength(0));
    b.conv.detach();

    await vi.waitFor(() => expect(b.conv.snapshot().response?.finished).toBe(true), { timeout: 2000 });
    const snap = b.conv.snapshot();
    expect(snap.response?.audioInterrupted).toBe(true);
    expect(snap.response?.lastAudioSeq).toBe(0); // no unheard TTS was produced
    expect(snap.messages.some((m) => m.role === 'assistant' && m.text === 'Hello café 🌊 world')).toBe(true);
  });
});
