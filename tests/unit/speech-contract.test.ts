import { describe, expect, it } from 'vitest';
import { parseSttEvent, sttChunkFrame, ttsFlushFrame } from '../../src/server/speech/protocol.js';

// Provider-reference examples, deliberately independent of the WS fixture.
// https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime

it('ends TTS with empty text rather than combining EOS with a keep-open flush', () => {
  expect(JSON.parse(ttsFlushFrame())).toEqual({ text: '' });
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
