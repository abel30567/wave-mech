// Pure, transport-free helpers for the ElevenLabs realtime speech protocols.
//
// These functions build the outbound JSON frames and interpret the inbound
// frames for the documented endpoints:
//   STT: wss://api.elevenlabs.io/v1/speech-to-text/realtime
//        ?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=manual&token=...
//   TTS: wss://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream-input
//        ?model_id=eleven_flash_v2_5&output_format=pcm_24000&single_use_token=...
//
// Keeping the wire logic here (with no socket dependency) lets the unit tests
// exercise every branch — partial vs. final transcripts, empty commits,
// incremental TTS text, and malformed/error/final frames — without a network.

export const DEFAULT_STT_ENDPOINT =
  'wss://api.elevenlabs.io/v1/speech-to-text/realtime' +
  '?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=manual';

export const DEFAULT_TTS_ENDPOINT =
  'wss://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream-input' +
  '?model_id=eleven_flash_v2_5&output_format=pcm_24000';

export const TTS_SAMPLE_RATE = 24000;
export const STT_SAMPLE_RATE = 16000;

/** Append the auth token as a query parameter without mutating other params. */
export function withSttToken(endpoint: string, token: string): string {
  const url = new URL(endpoint);
  url.searchParams.set('token', token);
  return url.toString();
}

/** Append the single-use TTS token and substitute the voice id path segment. */
export function withTtsToken(endpoint: string, voiceId: string, token: string): string {
  const substituted = endpoint.includes('{voiceId}')
    ? endpoint.replace('{voiceId}', encodeURIComponent(voiceId))
    : endpoint;
  const url = new URL(substituted);
  url.searchParams.set('single_use_token', token);
  return url.toString();
}

// ---- STT outbound frames ---------------------------------------------------

export function sttChunkFrame(audioBase64: string, sampleRate = STT_SAMPLE_RATE): string {
  return JSON.stringify({
    message_type: 'input_audio_chunk',
    audio_base_64: audioBase64,
    sample_rate: sampleRate,
    commit: false,
  });
}

export function sttCommitFrame(audioBase64: string): string {
  return JSON.stringify({
    message_type: 'input_audio_chunk', audio_base_64: audioBase64,
    sample_rate: STT_SAMPLE_RATE, commit: true,
  });
}

// ---- STT inbound frames ----------------------------------------------------

export type SttEvent =
  | { kind: 'partial'; text: string }
  | { kind: 'final'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'ignore' };

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Interpret an inbound STT frame. Partial transcripts are display-only; a final
 * transcript (including an empty one after an empty commit) settles the turn.
 */
export function parseSttEvent(raw: unknown): SttEvent {
  let msg: Record<string, unknown>;
  try {
    msg = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>);
  } catch {
    return { kind: 'ignore' };
  }
  if (!msg || typeof msg !== 'object') return { kind: 'ignore' };

  const type = asString(msg.message_type);
  if (type === 'insufficient_audio_activity') return { kind: 'final', text: '' };
  if (typeof msg.error === 'string') return { kind: 'error', message: 'speech_recognition_error' };
  const text = asString(msg.text);
  if (type === 'committed_transcript' || type === 'committed_transcript_with_timestamps') {
    return { kind: 'final', text };
  }
  if (type === 'partial_transcript') return { kind: 'partial', text };
  return { kind: 'ignore' };
}

// ---- TTS outbound frames ---------------------------------------------------

/** First frame opens generation; a single space is the documented primer. */
export function ttsInitFrame(): string {
  return JSON.stringify({ text: ' ' });
}

/** Incremental text is forwarded verbatim so tokenization/spacing is preserved. */
export function ttsTextFrame(text: string): string {
  return JSON.stringify({ text });
}

/** Empty text is the documented end-of-input signal; flush alone keeps the stream open. */
export function ttsFlushFrame(): string {
  return JSON.stringify({ text: '' });
}

// ---- TTS inbound frames ----------------------------------------------------

export interface TtsEvent {
  /** base64 PCM16 audio to schedule, if any. */
  audio: string | null;
  /** true once the server signals the response is complete. */
  final: boolean;
  /** present when the server reports an error. */
  error?: string;
  /** true for frames with no actionable content. */
  ignore?: boolean;
}

export function parseTtsEvent(raw: unknown): TtsEvent {
  let msg: Record<string, unknown>;
  try {
    msg = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>);
  } catch {
    return { audio: null, final: false, ignore: true };
  }
  if (!msg || typeof msg !== 'object') return { audio: null, final: false, ignore: true };

  if (asString(msg.type) === 'error' || typeof msg.error === 'string') {
    return {
      audio: null,
      final: false,
      error: asString(msg.message) || asString(msg.error) || 'tts_error',
    };
  }

  const audio = typeof msg.audio === 'string' && msg.audio.length > 0 ? msg.audio : null;
  const final = msg.isFinal === true || msg.is_final === true;
  if (audio === null && !final) return { audio: null, final: false, ignore: true };
  return { audio, final };
}
