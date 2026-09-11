import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpeech } from './index.js';
import { startFixture, type Fixture, type FixtureOptions } from './fixtures/eleven-labs.js';
import type { SpeechOptions, SpeechTokenKind } from '../../shared/contracts.js';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

interface Harness {
  session: ReturnType<typeof createSpeech>;
  fixture: Fixture;
  partials: string[];
  audio: Array<{ audio: string; sampleRate: number }>;
  errors: string[];
  tokenCalls: SpeechTokenKind[];
}

async function makeHarness(
  fixtureOptions: FixtureOptions = {},
  overrides: Partial<SpeechOptions> = {},
): Promise<Harness> {
  const fixture = await startFixture(fixtureOptions);
  const partials: string[] = [];
  const audio: Array<{ audio: string; sampleRate: number }> = [];
  const errors: string[] = [];
  const tokenCalls: SpeechTokenKind[] = [];

  const session = createSpeech({
    voiceId: 'test-voice',
    getToken: async (kind) => {
      tokenCalls.push(kind);
      return `token-${kind}-${tokenCalls.length}`;
    },
    onPartial: (text) => partials.push(text),
    onAudio: (a, sampleRate) => audio.push({ audio: a, sampleRate }),
    onError: (message) => errors.push(message),
    endpoints: { stt: fixture.sttEndpoint, tts: fixture.ttsEndpoint },
    timeoutMs: 1000,
    ...overrides,
  });

  cleanups.push(() => session.close());
  cleanups.push(() => fixture.close());
  return { session, fixture, partials, audio, errors, tokenCalls };
}

function pcm(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

function decode(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8');
}

describe('speech recognition (STT)', () => {
  it('streams partials and commits the final transcript once', async () => {
    const h = await makeHarness({ sttPartials: true });
    await h.session.startRecognition();
    h.session.writeAudio(pcm('hello'));
    h.session.writeAudio(pcm('world'));

    const text = await h.session.commitRecognition();

    expect(text).toBe('hello world');
    expect(h.partials).toEqual(['hello', 'hello world']);
    expect(h.errors).toEqual([]);
    // The injected token reached the socket query string.
    expect(h.fixture.seenTokens).toContain('token-realtime_scribe-1');
  });

  it('resolves an empty commit to an empty string', async () => {
    const h = await makeHarness();
    await h.session.startRecognition();
    const text = await h.session.commitRecognition();
    expect(text).toBe('');
  });

  it('supports consecutive manual turns on one connection', async () => {
    const h = await makeHarness();
    await h.session.startRecognition();
    h.session.writeAudio(pcm('first'));
    expect(await h.session.commitRecognition()).toBe('first');

    await h.session.startRecognition();
    h.session.writeAudio(pcm('second'));
    expect(await h.session.commitRecognition()).toBe('second');

    // A single scribe token was fetched and reused across both turns.
    expect(h.tokenCalls.filter((k) => k === 'realtime_scribe')).toHaveLength(1);
  });

  it('ignores malformed frames yet still resolves the final transcript', async () => {
    const h = await makeHarness({ sttMalformedFirst: true });
    await h.session.startRecognition();
    h.session.writeAudio(pcm('ok'));
    expect(await h.session.commitRecognition()).toBe('ok');
    expect(h.errors).toEqual([]);
  });

  it('rejects the commit and reports an error frame', async () => {
    const h = await makeHarness({ sttErrorOnCommit: 'scribe_boom' });
    await h.session.startRecognition();
    h.session.writeAudio(pcm('x'));
    await expect(h.session.commitRecognition()).rejects.toThrow(/recognition_error/);
    expect(h.errors).toContain('scribe_boom');
  });

  it('times out a commit that never receives a final', async () => {
    const h = await makeHarness({ sttNoFinal: true }, { timeoutMs: 150 });
    await h.session.startRecognition();
    h.session.writeAudio(pcm('waiting'));
    await expect(h.session.commitRecognition()).rejects.toThrow(/commit_timeout/);
  });
});

describe('speech synthesis (TTS)', () => {
  it('streams incremental text and resolves after the final audio', async () => {
    const h = await makeHarness();
    h.session.writeText('Hello ');
    h.session.writeText('world');
    await h.session.finishSpeech();

    expect(h.audio.map((a) => decode(a.audio))).toEqual(['Hello ', 'world']);
    expect(h.audio.every((a) => a.sampleRate === 24000)).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it('opens a fresh socket and token for a subsequent response', async () => {
    const h = await makeHarness();
    h.session.writeText('one');
    await h.session.finishSpeech();
    h.session.writeText('two');
    await h.session.finishSpeech();

    expect(h.audio.map((a) => decode(a.audio))).toEqual(['one', 'two']);
    expect(h.tokenCalls.filter((k) => k === 'tts_websocket')).toHaveLength(2);
  });

  it('resolves immediately when nothing was spoken', async () => {
    const h = await makeHarness();
    await expect(h.session.finishSpeech()).resolves.toBeUndefined();
    expect(h.tokenCalls).toEqual([]);
  });

  it('reports synthesis errors and rejects finish', async () => {
    const h = await makeHarness({ ttsError: 'tts_boom' });
    h.session.writeText('boom');
    await expect(h.session.finishSpeech()).rejects.toThrow(/synthesis_error/);
    expect(h.errors).toContain('tts_boom');
  });

  it('times out finish when the final audio never arrives', async () => {
    const h = await makeHarness({ ttsNeverFinal: true }, { timeoutMs: 150 });
    h.session.writeText('stuck');
    await expect(h.session.finishSpeech()).rejects.toThrow(/finish_timeout/);
  });
});

describe('lifecycle and cleanup', () => {
  it('close() is idempotent and settles pending work', async () => {
    const h = await makeHarness();
    await h.session.startRecognition();
    const pending = h.session.commitRecognition();
    h.session.close();
    h.session.close(); // idempotent

    await expect(pending).rejects.toThrow(/closed/);
    await expect(h.session.commitRecognition()).rejects.toThrow(/closed/);
    expect(() => h.session.writeAudio(pcm('ignored'))).not.toThrow();
  });
});
