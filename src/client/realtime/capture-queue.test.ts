import { describe, expect, it } from 'vitest';
import { PreRoll, ProducerBacklog } from './capture-queue.js';

const chunk = (bytes: number, fill = 1): Uint8Array => new Uint8Array(bytes).fill(fill);

describe('PreRoll ring', () => {
  it('keeps the most recent chunks within the byte budget, evicting the oldest', () => {
    const roll = new PreRoll(10);
    roll.push(chunk(4, 1));
    roll.push(chunk(4, 2));
    roll.push(chunk(4, 3)); // 12 bytes > 10: oldest (fill 1) evicted
    const drained = roll.drain();
    expect(drained.map((c) => c[0])).toEqual([2, 3]);
    expect(roll.size).toBe(0);
  });

  it('retains a single oversized chunk rather than dropping everything', () => {
    const roll = new PreRoll(10);
    roll.push(chunk(20, 9));
    expect(roll.drain().map((c) => c.byteLength)).toEqual([20]);
  });
});

describe('ProducerBacklog', () => {
  it('dequeues in FIFO order while within budget', () => {
    const backlog = new ProducerBacklog(100);
    expect(backlog.enqueue(chunk(10, 1))).toBe(true);
    expect(backlog.enqueue(chunk(10, 2))).toBe(true);
    expect(backlog.dequeue()?.[0]).toBe(1);
    expect(backlog.dequeue()?.[0]).toBe(2);
    expect(backlog.empty).toBe(true);
  });

  it('latches overflow and refuses further frames until cleared', () => {
    const backlog = new ProducerBacklog(16);
    expect(backlog.enqueue(chunk(16))).toBe(true);
    expect(backlog.enqueue(chunk(2))).toBe(false);
    expect(backlog.overflowed).toBe(true);
    // Still latched even though there would now be room after a dequeue.
    backlog.dequeue();
    expect(backlog.enqueue(chunk(2))).toBe(false);
    backlog.clear();
    expect(backlog.overflowed).toBe(false);
    expect(backlog.enqueue(chunk(2))).toBe(true);
  });
});
