import { MAX_AUDIO_SEQUENCE, REALTIME_VERSION, type AudioFrame, type RealtimeCommand } from './realtime.js';

const HEADER = 12;
const uint = (value: unknown, min = 0, max = 0xffffffff): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export function encodeAudio(frame: AudioFrame): ArrayBuffer {
  if (!uint(frame.turnId, 1) || !uint(frame.seq, 1, MAX_AUDIO_SEQUENCE) || !frame.pcm.byteLength || frame.pcm.byteLength > 32768 || frame.pcm.byteLength % 2) throw new Error('Invalid audio frame.');
  const buffer = new ArrayBuffer(HEADER + frame.pcm.byteLength);
  const view = new DataView(buffer);
  view.setUint16(0, 0x574d); view.setUint8(2, REALTIME_VERSION);
  view.setUint32(4, frame.turnId); view.setUint32(8, frame.seq);
  new Uint8Array(buffer, HEADER).set(frame.pcm);
  return buffer;
}

export function decodeAudio(input: ArrayBuffer | Uint8Array): AudioFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < HEADER + 2 || bytes.byteLength > HEADER + 32768 || (bytes.byteLength - HEADER) % 2) throw new Error('Invalid audio frame length.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== 0x574d || view.getUint8(2) !== REALTIME_VERSION || view.getUint8(3) !== 0) throw new Error('Unsupported audio protocol.');
  const turnId = view.getUint32(4), seq = view.getUint32(8);
  if (!uint(turnId, 1) || !uint(seq, 1, MAX_AUDIO_SEQUENCE)) throw new Error('Invalid audio sequence.');
  return { turnId, seq, pcm: bytes.slice(HEADER) };
}

export function parseRealtimeCommand(value: unknown): RealtimeCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid conversation command.');
  const command = value as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    hello: ['type', 'version', 'sessionId'], record: ['type', 'turnId'], finish: ['type', 'turnId', 'lastSeq'],
    text: ['type', 'turnId', 'text'], abort_input: ['type', 'turnId', 'reason'], interrupt: ['type', 'responseId'],
    playback_done: ['type', 'responseId', 'lastSeq', 'skipped'], ping: ['type', 'id'], end: ['type'],
  };
  if (typeof command.type !== 'string' || !Object.hasOwn(fields, command.type)) throw new Error('Unknown conversation command.');
  if (Object.keys(command).some(key => !fields[command.type as string].includes(key))) throw new Error('Unexpected command fields.');
  if (['record', 'finish', 'text', 'abort_input'].includes(command.type) && !uint(command.turnId, 1)) throw new Error('Invalid turn identifier.');
  if (['interrupt', 'playback_done'].includes(command.type) && !uint(command.responseId, 1)) throw new Error('Invalid response identifier.');
  if (['finish', 'playback_done'].includes(command.type) && !uint(command.lastSeq, 0, MAX_AUDIO_SEQUENCE)) throw new Error('Invalid completion sequence.');
  if (command.type === 'hello' && (command.version !== REALTIME_VERSION || (command.sessionId !== undefined && (typeof command.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.sessionId))))) throw new Error('Unsupported session handshake.');
  if (command.type === 'text' && (typeof command.text !== 'string' || !command.text.trim() || command.text.length > 12000)) throw new Error('Invalid message text.');
  if (command.type === 'abort_input' && !['overflow', 'muted', 'interrupted', 'discontinuity'].includes(command.reason as string)) throw new Error('Invalid input cancellation.');
  if (command.type === 'playback_done' && command.skipped !== undefined && typeof command.skipped !== 'boolean') throw new Error('Invalid playback acknowledgement.');
  if (command.type === 'ping' && !uint(command.id)) throw new Error('Invalid heartbeat.');
  return command as unknown as RealtimeCommand;
}
