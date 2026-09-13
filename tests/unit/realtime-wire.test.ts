import { describe, expect, it } from 'vitest';
import { decodeAudio, encodeAudio, parseRealtimeCommand } from '../../src/shared/realtime-wire.js';

describe('versioned conversation wire contract', () => {
  it('round trips bounded PCM with turn and sequence identity, copying accepted bytes', () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const encoded = encodeAudio({ turnId: 7, seq: 3, pcm });
    const padded = new Uint8Array(encoded.byteLength + 5); padded.set(new Uint8Array(encoded), 5);
    const decoded = decodeAudio(padded.subarray(5));
    expect(decoded).toEqual({ turnId: 7, seq: 3, pcm });
    padded.fill(0);
    expect(decoded.pcm).toEqual(pcm);
  });
  it('rejects malformed, oversized and unsupported audio frames', () => {
    expect(() => decodeAudio(new Uint8Array(3))).toThrow();
    expect(() => encodeAudio({ turnId: 0, seq: 1, pcm: new Uint8Array(2) })).toThrow();
    expect(() => encodeAudio({ turnId: 1, seq: 1, pcm: new Uint8Array(32770) })).toThrow();
    const frame = new Uint8Array(encodeAudio({ turnId: 1, seq: 1, pcm: new Uint8Array(2) }));
    frame[2] = 1; expect(() => decodeAudio(frame)).toThrow();
  });
  it('accepts explicit handshakes and commit boundaries', () => {
    expect(parseRealtimeCommand({ type: 'hello', version: 2, sessionId: 'session-1' })).toEqual({ type: 'hello', version: 2, sessionId: 'session-1' });
    expect(parseRealtimeCommand({ type: 'finish', turnId: 1, lastSeq: 3 })).toEqual({ type: 'finish', turnId: 1, lastSeq: 3 });
  });
  it.each([null, [], { type: 'finish', turnId: 1 }, { type: 'hello', version: 1 },
    { type: 'playback_done', responseId: 1, lastSeq: 1, skipped: 'yes' },
    { type: 'record', turnId: 1, owner: 'spoofed' }, { type: '__proto__' },
  ])('rejects invalid controls: %j', (value) => { expect(() => parseRealtimeCommand(value)).toThrow(); });
});
