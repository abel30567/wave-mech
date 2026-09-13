import { describe, expect, it, vi } from 'vitest';
import { VoiceSession } from '../../src/server/session.js';
import type { HarnessEvent, HarnessSession, ServerMessage, SpeechSession } from '../../src/shared/contracts.js';

function setup(withSpeech = false) {
  const messages: ServerMessage[] = [];
  let event: (value: HarnessEvent) => void = () => {};
  let resolveTurn!: () => void;
  const pending = new Promise<void>((resolve) => { resolveTurn = resolve; });
  const harness: HarnessSession = {
    start: vi.fn(async () => {}), send: vi.fn(() => pending),
    close: vi.fn(async () => { resolveTurn(); }),
  };
  const speech: SpeechSession = {
    startRecognition: vi.fn(async () => {}), writeAudio: vi.fn(),
    commitRecognition: vi.fn(async () => 'a spoken turn'), writeText: vi.fn(),
    finishSpeech: vi.fn(async () => {}), close: vi.fn(),
  };
  const session = new VoiceSession({
    mode: 'fixture', send: (message) => messages.push(message),
    harness: (callback) => { event = callback; return harness; },
    speech: withSpeech ? () => speech : undefined,
  });
  return { session, harness, speech, messages, resolveTurn, emit: (value: HarnessEvent) => event(value) };
}

describe('manual-turn session', () => {
  it('allows text without speech and rejects overlap until playback is acknowledged', async () => {
    const s = setup();
    await s.session.handle({ type: 'start' });
    expect(s.messages[0]).toMatchObject({ type: 'ready', speechAvailable: false });
    const turn = s.session.handle({ type: 'text', text: 'hello' });
    await s.session.handle({ type: 'text', text: 'duplicate' });
    expect(s.harness.send).toHaveBeenCalledTimes(1);
    s.emit({ type: 'text', text: 'Hello back.' });
    s.resolveTurn();
    await turn;
    await s.session.handle({ type: 'text', text: 'too early' });
    expect(s.harness.send).toHaveBeenCalledTimes(1);
    await s.session.handle({ type: 'playback_done' });
    await s.session.handle({ type: 'text', text: 'next turn' });
    expect(s.harness.send).toHaveBeenCalledTimes(2);
  });

  it('commits manually exactly once and accepts PCM only during recording', async () => {
    const s = setup(true);
    await s.session.handle({ type: 'start' });
    s.session.audio(new Uint8Array(8));
    expect(s.speech.writeAudio).not.toHaveBeenCalled();
    await s.session.handle({ type: 'record' });
    s.session.audio(new Uint8Array(8));
    const finishing = s.session.handle({ type: 'finish' });
    await s.session.handle({ type: 'finish' });
    expect(s.speech.commitRecognition).toHaveBeenCalledTimes(1);
    expect(s.speech.writeAudio).toHaveBeenCalledTimes(1);
    s.emit({ type: 'text', text: 'Spoken reply.' });
    s.resolveTurn();
    await finishing;
    expect(s.harness.send).toHaveBeenCalledWith('a spoken turn');
    expect(s.speech.finishSpeech).toHaveBeenCalledTimes(1);
  });

  it('does not invoke inference for an empty committed transcript', async () => {
    const s = setup(true);
    vi.mocked(s.speech.commitRecognition).mockResolvedValue('  ');
    await s.session.handle({ type: 'start' });
    await s.session.handle({ type: 'record' });
    await s.session.handle({ type: 'finish' });
    expect(s.harness.send).not.toHaveBeenCalled();
    expect(s.messages.at(-1)).toEqual({ type: 'idle' });
  });

  it('releases resources once and ignores late inference output', async () => {
    const s = setup(true);
    await s.session.handle({ type: 'start' });
    const turn = s.session.handle({ type: 'text', text: 'hello' });
    await s.session.close();
    await s.session.close();
    await turn;
    s.emit({ type: 'text', text: 'must not be played' });
    expect(s.harness.close).toHaveBeenCalledTimes(1);
    expect(s.speech.close).toHaveBeenCalledTimes(1);
    expect(s.messages.filter((message) => message.type === 'text')).toEqual([]);
    expect(s.messages.filter((message) => message.type === 'response_done')).toEqual([]);
  });

  it('fails closed on malformed audio without forwarding it', async () => {
    const s = setup(true);
    await s.session.handle({ type: 'start' });
    await s.session.handle({ type: 'record' });
    s.session.audio(new Uint8Array(3));
    expect(s.speech.writeAudio).not.toHaveBeenCalled();
    expect(s.messages).toContainEqual(expect.objectContaining({ type: 'error', fatal: true }));
    await vi.waitFor(() => expect(s.harness.close).toHaveBeenCalledTimes(1));
  });
});
