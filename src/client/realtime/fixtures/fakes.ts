import type {
  HandsFreeAudio,
  HandsFreeAudioOptions,
  RealtimeCommand,
  RealtimeEvent,
} from '../../../shared/realtime.js';
import { decodeAudio } from '../../../shared/realtime-wire.js';

// Deterministic in-memory doubles for the injected socket/audio factories. They
// carry no browser globals, so the conversation controller is exercised end to
// end in Node.

export class FakeSocket {
  static readonly OPEN = 1;
  readyState = 0;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  /** Frames and JSON commands the client has sent, in order. */
  readonly sent: Array<RealtimeCommand | { audio: ReturnType<typeof decodeAudio> }> = [];
  closed = false;

  constructor(public readonly url: string) {}

  send(data: string | ArrayBuffer): void {
    if (typeof data === 'string') this.sent.push(JSON.parse(data) as RealtimeCommand);
    else this.sent.push({ audio: decodeAudio(data) });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }

  // --- test helpers ---------------------------------------------------------

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  /** Simulate an abrupt transport drop (not an explicit end). */
  drop(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onerror?.();
    this.onclose?.();
  }

  receive(event: RealtimeEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  commands(): RealtimeCommand[] {
    return this.sent.filter((entry) => !('audio' in entry)) as RealtimeCommand[];
  }

  audioFrames(): Array<ReturnType<typeof decodeAudio>> {
    return this.sent.filter((entry) => 'audio' in entry).map((entry) => (entry as { audio: ReturnType<typeof decodeAudio> }).audio);
  }
}

export interface FakeAudioControl {
  options: HandsFreeAudioOptions;
  audio: HandsFreeAudio;
  modes: string[];
  enqueued: Array<{ responseId: number; seq: number }>;
  cancels: Array<number | undefined>;
  closeCount: number;
  clearCount: number;
  /** Resolve the next pending finishOutput with the given result. */
  settleFinish(result: 'played' | 'interrupted' | 'paused'): void;
}

export function makeFakeAudio(overrides?: { failCreate?: boolean }): {
  factory: (options: HandsFreeAudioOptions) => Promise<HandsFreeAudio>;
  control: () => FakeAudioControl;
} {
  let control: FakeAudioControl | undefined;
  const factory = async (options: HandsFreeAudioOptions): Promise<HandsFreeAudio> => {
    if (overrides?.failCreate) throw new Error('mic denied');
    const modes: string[] = [];
    const enqueued: Array<{ responseId: number; seq: number }> = [];
    const cancels: Array<number | undefined> = [];
    let finishResolvers: Array<(r: 'played' | 'interrupted' | 'paused') => void> = [];
    const state = { closeCount: 0, clearCount: 0 };
    let closedOnce = false;
    const audio: HandsFreeAudio = {
      setMode: (mode) => modes.push(mode),
      flushInput: () => Promise.resolve(),
      clearInput: () => {
        state.clearCount += 1;
      },
      enqueueOutput: (_audio, _rate, responseId, seq) => enqueued.push({ responseId, seq }),
      finishOutput: () => new Promise((resolve) => finishResolvers.push(resolve)),
      cancelOutput: (responseId) => cancels.push(responseId),
      resume: () => Promise.resolve(),
      close: () => {
        // Idempotent, as the real implementation guarantees.
        if (!closedOnce) {
          closedOnce = true;
          state.closeCount += 1;
        }
        return Promise.resolve();
      },
    };
    control = {
      options,
      audio,
      modes,
      enqueued,
      cancels,
      get closeCount() {
        return state.closeCount;
      },
      get clearCount() {
        return state.clearCount;
      },
      settleFinish: (result) => {
        const resolvers = finishResolvers;
        finishResolvers = [];
        for (const resolve of resolvers) resolve(result);
      },
    };
    return audio;
  };
  return { factory, control: () => control! };
}
