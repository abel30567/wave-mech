import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TTS_ENDPOINT,
  TTS_INACTIVITY_TIMEOUT_SECONDS,
  parseSttEvent,
  sttChunkFrame,
  ttsFlushFrame,
  ttsForceFlushFrame,
} from '../../src/server/speech/protocol.js';

// Provider-reference examples, deliberately independent of the WS fixture.
// https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
// https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input

it('ends TTS with empty text rather than combining EOS with a keep-open flush', () => {
  expect(JSON.parse(ttsFlushFrame())).toEqual({ text: '' });
});

it('forces generation with the documented flush flag without ending the stream', () => {
  // The keep-open flush is distinct from EOS: it carries the `flush` flag so a
  // short first sentence synthesizes immediately, and does not close generation.
  expect(JSON.parse(ttsForceFlushFrame())).toEqual({ text: '', flush: true });
});

it('requests the documented inactivity_timeout (<=180s) so a warm socket survives tool waits', () => {
  expect(TTS_INACTIVITY_TIMEOUT_SECONDS).toBeLessThanOrEqual(180);
  const url = new URL(DEFAULT_TTS_ENDPOINT.replace('{voiceId}', 'v'));
  expect(url.searchParams.get('inactivity_timeout')).toBe(String(TTS_INACTIVITY_TIMEOUT_SECONDS));
});

describe('documented ElevenLabs STT contract', () => {
  it('sends message_type, commit and sample_rate with audio chunks', () => {
    expect(JSON.parse(sttChunkFrame('AQI='))).toEqual({
      message_type: 'input_audio_chunk', audio_base_64: 'AQI=', commit: false, sample_rate: 16000,
    });
  });
  it('recognizes the documented partial event', () => {
    expect(parseSttEvent({ message_type: 'partial_transcript', text: 'hello' })).toEqual({ kind: 'partial', text: 'hello' });
  });
  it.each(['committed_transcript', 'committed_transcript_with_timestamps'])('recognizes %s', (message_type) => {
    expect(parseSttEvent({ message_type, text: 'hello world' })).toEqual({ kind: 'final', text: 'hello world' });
  });
  it('does not mistake a speculative legacy discriminator for a finalized turn', () => {
    expect(parseSttEvent({ type: 'final_transcript', text: 'legacy' })).toEqual({ kind: 'ignore' });
  });
});
