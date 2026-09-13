// Pure, transport-free byte buffers shared by the hands-free capture pipeline.
//
// Two bounded stages sit between the VAD and the conversation transport:
//
//  - `PreRoll` keeps the most recent pre-onset PCM so a confirmed utterance can
//    be prefixed with the audio that preceded detection. It is a ring bounded by
//    `PREROLL_BYTES`; the oldest chunks are evicted first.
//  - `ProducerBacklog` bounds the live frames buffered on the producer side
//    before the consumer (`onPcm`) drains them, using `PRODUCER_AUDIO_BYTES`.
//    Overflow here means the main thread stalled; the caller must treat it as a
//    discontinuity rather than silently committing a truncated prefix.
//
// Keeping these pure means the bounding maths are unit tested in Node without
// any browser globals, while `audio.ts` wires them to the real worklet/VAD.

export class PreRoll {
  private chunks: Uint8Array[] = [];
  private bytes = 0;

  constructor(private readonly limit: number) {}

  /** Append a captured chunk, evicting the oldest while over the byte budget. */
  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    // Keep at least one chunk even if a single frame exceeds the budget.
    while (this.bytes > this.limit && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()!.byteLength;
    }
  }

  /** Return the buffered pre-roll in capture order and reset the ring. */
  drain(): Uint8Array[] {
    const out = this.chunks;
    this.chunks = [];
    this.bytes = 0;
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.bytes = 0;
  }

  get size(): number {
    return this.bytes;
  }
}

export class ProducerBacklog {
  private queue: Uint8Array[] = [];
  private bytes = 0;
  private over = false;

  constructor(private readonly limit: number) {}

  /**
   * Queue a live frame. Returns false (and latches `overflowed`) when the
   * producer budget is exceeded, signalling a main-thread stall the caller must
   * surface as a discontinuity instead of forwarding a truncated prefix.
   */
  enqueue(chunk: Uint8Array): boolean {
    if (this.over) return false;
    if (this.bytes + chunk.byteLength > this.limit) {
      this.over = true;
      return false;
    }
    this.queue.push(chunk);
    this.bytes += chunk.byteLength;
    return true;
  }

  dequeue(): Uint8Array | undefined {
    const chunk = this.queue.shift();
    if (chunk) this.bytes -= chunk.byteLength;
    return chunk;
  }

  clear(): void {
    this.queue = [];
    this.bytes = 0;
    this.over = false;
  }

  get empty(): boolean {
    return this.queue.length === 0;
  }

  get size(): number {
    return this.bytes;
  }

  get overflowed(): boolean {
    return this.over;
  }
}
