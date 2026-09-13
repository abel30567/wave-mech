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

  it('delivers a primed pre-roll prefix ahead of live frames', () => {
    const backlog = new ProducerBacklog(16);
    backlog.primePrefix([chunk(4, 7), chunk(4, 8)]);
    expect(backlog.enqueue(chunk(4, 9))).toBe(true); // live frame after onset
    // Pre-roll drains first, then the live frame.
    expect(backlog.dequeue()?.[0]).toBe(7);
    expect(backlog.dequeue()?.[0]).toBe(8);
    expect(backlog.dequeue()?.[0]).toBe(9);
    expect(backlog.empty).toBe(true);
  });

  it('exempts the pre-roll prefix from the live-stall byte budget', () => {
    // A pre-roll larger than the whole live budget (the real 20480 vs 16384
    // regression) must not trip overflow: it is a bounded onset burst, not a
    // consumer stall.
    const backlog = new ProducerBacklog(16);
    backlog.primePrefix([chunk(40, 1)]);
    expect(backlog.overflowed).toBe(false);
    expect(backlog.size).toBe(0); // prefix is not counted against the budget
    expect(backlog.empty).toBe(false);
    // Live frames still honour their own budget on top of the prefix.
    expect(backlog.enqueue(chunk(16, 2))).toBe(true);
    expect(backlog.enqueue(chunk(1, 3))).toBe(false);
    expect(backlog.overflowed).toBe(true);
  });

  it('clears the primed prefix', () => {
    const backlog = new ProducerBacklog(16);
    backlog.primePrefix([chunk(4, 1)]);
    backlog.clear();
    expect(backlog.empty).toBe(true);
    expect(backlog.dequeue()).toBeUndefined();
  });
});
