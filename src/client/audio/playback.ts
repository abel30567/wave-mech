import type { PlaybackSession } from '../../shared/contracts.js';
import { decodePcm16Base64 } from './pcm.js';

/**
 * Gapless PCM16 playback. `enqueue` schedules each buffer immediately after the
 * previously queued audio so chunks play back-to-back and in order. `drain`
 * resolves once everything already queued has finished; `stop` cancels and
 * clears anything still pending.
 */
export async function createPlayback(): Promise<PlaybackSession> {
  const context = new AudioContext();
  if (context.state === 'suspended') {
    // Best effort; a gesture-driven resume elsewhere still unblocks playback.
    try {
      await context.resume();
    } catch {
      /* ignore — autoplay policy resolves on the next user gesture */
    }
  }

  let nextStartTime = 0;
  const active = new Set<AudioBufferSourceNode>();
  let drainWaiters: Array<() => void> = [];

  const resolveIfIdle = (): void => {
    if (active.size > 0) return;
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const waiter of waiters) waiter();
  };

  return {
    enqueue(audioBase64: string, sampleRate: number): void {
      const samples = decodePcm16Base64(audioBase64);
      if (samples.length === 0) return;
      const buffer = context.createBuffer(1, samples.length, sampleRate);
      // `.set` avoids the ArrayBuffer/SharedArrayBuffer variance friction that
      // `copyToChannel` has with a generically-typed source array.
      buffer.getChannelData(0).set(samples);

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = (): void => {
        active.delete(source);
        resolveIfIdle();
      };

      const startAt = Math.max(context.currentTime, nextStartTime);
      active.add(source);
      source.start(startAt);
      nextStartTime = startAt + buffer.duration;
    },

    drain(): Promise<void> {
      if (active.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        drainWaiters.push(resolve);
      });
    },

    stop(): void {
      nextStartTime = 0;
      for (const source of active) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          /* already stopped */
        }
        source.disconnect();
      }
      active.clear();
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const waiter of waiters) waiter();
    },
  };
}
