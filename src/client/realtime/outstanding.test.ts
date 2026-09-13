import { describe, expect, it } from 'vitest';
import { OutstandingAudio } from './outstanding.js';

const pcm = (bytes: number): Uint8Array => new Uint8Array(bytes);

describe('OutstandingAudio', () => {
  it('assigns increasing sequences from 1 and sends buffered frames once', () => {
    const out = new OutstandingAudio(1000, 7);
    expect(out.push(pcm(10))).toEqual({ status: 'queued', seq: 1 });
    expect(out.push(pcm(10))).toEqual({ status: 'queued', seq: 2 });
    const frames = out.takeSendable();
    expect(frames.map((f) => f.seq)).toEqual([1, 2]);
    expect(frames.every((f) => f.turnId === 7)).toBe(true);
    expect(out.lastSeq).toBe(2);
    // Nothing left to send until more is pushed.
    expect(out.takeSendable()).toEqual([]);
  });

  it('reports overflow when the transport budget is exceeded', () => {
    const out = new OutstandingAudio(20, 1);
    expect(out.push(pcm(20)).status).toBe('queued');
    expect(out.push(pcm(2)).status).toBe('overflow');
  });

  it('releases in-flight bytes on cumulative ack', () => {
    const out = new OutstandingAudio(30, 1);
    out.push(pcm(10));
    out.push(pcm(10));
    out.takeSendable();
    expect(out.size).toBe(20);
    out.ack(1);
    expect(out.size).toBe(10);
    expect(out.fullyAcked).toBe(false);
    out.ack(2);
    expect(out.fullyAcked).toBe(true);
  });

  it('retransmits only unacknowledged frames after a reconnect', () => {
    const out = new OutstandingAudio(1000, 3);
    out.push(pcm(10));
    out.push(pcm(10));
    out.push(pcm(10));
    out.takeSendable();
    out.ack(1); // seq 1 accepted
    out.resetForResend();
    const resent = out.takeSendable().map((f) => f.seq);
    expect(resent).toEqual([2, 3]); // seq 1 is never replayed
  });
});
