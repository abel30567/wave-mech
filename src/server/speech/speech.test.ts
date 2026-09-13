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
    expect(h.errors).toContain('speech_recognition_error');
  });

  it('times out a commit that never receives a final', async () => {
    const h = await makeHarness({ sttNoFinal: true }, { timeoutMs: 150 });
    await h.session.startRecognition();
    h.session.writeAudio(pcm('waiting'));
    await expect(h.session.commitRecognition()).rejects.toThrow(/commit_timeout/);
  });
});

describe('streaming audio ingest (acceptAudio)', () => {
  it('streams accepted frames and commits the final transcript', async () => {
    const h = await makeHarness();
    await h.session.startRecognition();
    expect(h.session.acceptAudio!(pcm('a'))).toBe(true);
    expect(h.session.acceptAudio!(pcm('b'))).toBe(true);
    expect(await h.session.commitRecognition()).toBe('a b');
  });

  it('refuses when there is no active recognition', async () => {
    const h = await makeHarness();
    expect(h.session.acceptAudio!(pcm('x'))).toBe(false);
  });

  it('refuses empty frames and refuses while a commit is settling', async () => {
    const h = await makeHarness({ sttNoFinal: true }, { timeoutMs: 200 });
    await h.session.startRecognition();
    expect(h.session.acceptAudio!(pcm(''))).toBe(false);
    expect(h.session.acceptAudio!(pcm('data'))).toBe(true);
    const pending = h.session.commitRecognition();
    pending.catch(() => undefined);
    expect(h.session.acceptAudio!(pcm('more'))).toBe(false);
    await expect(pending).rejects.toThrow(/commit_timeout/);
  });

  it('refuses frames beyond the per-recognition ceiling', async () => {
    const h = await makeHarness();
    await h.session.startRecognition();
    const overLimit = new Uint8Array(16_000 * 2 * 120 + 2);
    expect(h.session.acceptAudio!(overLimit)).toBe(false);
  });

  it('refuses after close', async () => {
    const h = await makeHarness();
    await h.session.startRecognition();
    h.session.close();
    expect(h.session.acceptAudio!(pcm('x'))).toBe(false);
  });
});

describe('recognition abort', () => {
  it('discards buffered audio and opens a fresh socket for the next turn', async () => {
    const h = await makeHarness();
    await h.session.startRecognition();
    h.session.acceptAudio!(pcm('leak-a'));
    h.session.acceptAudio!(pcm('leak-b'));
    h.session.abortRecognition!();

    await h.session.startRecognition();
    h.session.acceptAudio!(pcm('clean'));
    expect(await h.session.commitRecognition()).toBe('clean');
    // A brand new scribe socket/token was established after the abort.
    expect(h.tokenCalls.filter((k) => k === 'realtime_scribe')).toHaveLength(2);
  });

  it('rejects a pending commit', async () => {
    const h = await makeHarness({ sttNoFinal: true }, { timeoutMs: 2000 });
    await h.session.startRecognition();
    h.session.acceptAudio!(pcm('data'));
    const pending = h.session.commitRecognition();
    h.session.abortRecognition!();
    await expect(pending).rejects.toThrow(/aborted/);
  });
});

describe('speech synthesis (TTS)', () => {
  it('buffers split words without inserting spaces inside them', async () => {
    const h = await makeHarness();
    for (const fragment of ['hel', 'lo ', 'wo', 'rld']) h.session.writeText(fragment);
    await h.session.finishSpeech();
    expect(h.audio.map((value) => decode(value.audio)).join('')).toBe('hello world ');
  });

  it('streams incremental text and resolves after the final audio', async () => {
    const h = await makeHarness();
    h.session.writeText('Hello ');
    h.session.writeText('world');
    await h.session.finishSpeech();

    expect(h.audio.map((a) => decode(a.audio)).join('')).toBe('Hello world ');
    expect(h.audio.every((a) => a.sampleRate === 24000)).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it('opens a fresh socket and token for a subsequent response', async () => {
    const h = await makeHarness();
    h.session.writeText('one');
    await h.session.finishSpeech();
    h.session.writeText('two');
    await h.session.finishSpeech();

    expect(h.audio.map((a) => decode(a.audio))).toEqual(['one ', 'two ']);
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

describe('synthesis cancellation (cancelSpeech)', () => {
  it('rejects a pending finish', async () => {
    const h = await makeHarness({ ttsNeverFinal: true }, { timeoutMs: 2000 });
    h.session.writeText('hello ');
    const pending = h.session.finishSpeech();
    h.session.cancelSpeech!();
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it('lets a subsequent response synthesize on a fresh socket', async () => {
    const h = await makeHarness();
    h.session.writeText('a');
    const cancelled = h.session.finishSpeech();
    h.session.cancelSpeech!(); // cancel while the first socket is still opening
    await expect(cancelled).rejects.toThrow(/cancelled/);

    h.session.writeText('b');
    await h.session.finishSpeech();
    expect(h.audio.map((value) => decode(value.audio)).join('')).toBe('b ');
    // Fresh synthesis socket/token for the replacement response.
    expect(h.tokenCalls.filter((k) => k === 'tts_websocket')).toHaveLength(2);
    expect(h.errors).toEqual([]);
  });
});

describe('lifecycle and cleanup', () => {
  it('close() is idempotent and settles pending work', async () => {
    const h = await makeHarness();
    await h.session.startRecognition();
    h.session.writeAudio(pcm('pending'));
    const pending = h.session.commitRecognition();
    h.session.close();
    h.session.close(); // idempotent

    await expect(pending).rejects.toThrow(/closed/);
    await expect(h.session.commitRecognition()).rejects.toThrow(/closed/);
    expect(() => h.session.writeAudio(pcm('ignored'))).not.toThrow();
  });
});
