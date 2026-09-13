import { MAX_AUDIO_SEQUENCE, type AudioFrame } from '../../shared/realtime.js';

// Bounded outstanding-audio FIFO for one input turn.
//
// Frames are assigned strictly increasing sequence numbers starting at 1. A
// frame stays "in flight" (counted against the transport budget) until its
// sequence is covered by a cumulative `audio_ack`. Retransmission after a
// transient reconnect only replays frames above the acknowledged watermark; a
// reconnect never resets the turn or re-sends already-accepted audio.
//
// `limit` is the transport slice of the shared outstanding budget
// (`TRANSPORT_AUDIO_BYTES`), so pre-roll and producer stages keep their own
// separate budgets rather than each claiming the whole allowance.

interface Pending {
  seq: number;
  pcm: Uint8Array;
}

export type PushResult =
  | { status: 'queued'; seq: number }
  | { status: 'overflow' }
  | { status: 'exhausted' };

export class OutstandingAudio {
  private nextSeq = 1;
  private ackedSeq = 0;
  private unsent: Pending[] = [];
  private sent: Pending[] = [];

  constructor(
    private readonly limit: number,
    private readonly turnId: number,
  ) {}

  private get bytesInFlight(): number {
    let total = 0;
    for (const frame of this.unsent) total += frame.pcm.byteLength;
    for (const frame of this.sent) total += frame.pcm.byteLength;
    return total;
  }

  /**
   * Buffer a captured frame for eventual transmission. Overflow (budget
   * exceeded) and sequence exhaustion are reported rather than dropped silently
   * so the caller can abort the unfinished input and ask for a repeat.
   */
  push(pcm: Uint8Array): PushResult {
    if (this.nextSeq > MAX_AUDIO_SEQUENCE) return { status: 'exhausted' };
    if (this.bytesInFlight + pcm.byteLength > this.limit) return { status: 'overflow' };
    const seq = this.nextSeq++;
    this.unsent.push({ seq, pcm });
    return { status: 'queued', seq };
  }

  /** Move every buffered-but-unsent frame into the in-flight set to transmit. */
  takeSendable(): AudioFrame[] {
    const ready = this.unsent;
    this.unsent = [];
    this.sent.push(...ready);
    return ready.map((frame) => ({ turnId: this.turnId, seq: frame.seq, pcm: frame.pcm }));
  }

  /** Advance the cumulative acknowledgement, releasing covered frames. */
  ack(seq: number): void {
    if (seq <= this.ackedSeq) return;
    this.ackedSeq = seq;
    this.sent = this.sent.filter((frame) => frame.seq > seq);
    this.unsent = this.unsent.filter((frame) => frame.seq > seq);
  }

  /** Requeue unacknowledged frames for retransmission after a reconnect. */
  resetForResend(): void {
    const pending = [...this.sent, ...this.unsent].sort((a, b) => a.seq - b.seq);
    this.sent = [];
    this.unsent = pending;
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /** True while frames remain captured-but-not-yet-transmitted. */
  get hasUnsent(): boolean {
    return this.unsent.length > 0;
  }

  get ack_watermark(): number {
    return this.ackedSeq;
  }

  get fullyAcked(): boolean {
    return this.unsent.length === 0 && this.sent.length === 0;
  }

  get size(): number {
    return this.bytesInFlight;
  }
}
