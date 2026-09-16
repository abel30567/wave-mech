import { describe, expect, it } from 'vitest';
import { createConversation } from './session.js';
import type { HarnessEvent } from '../../shared/contracts.js';
import type {
  RealtimeEvent,
  RealtimeHarness,
  RealtimeSpeech,
  RetainedConversation,
} from '../../shared/realtime.js';

// Deterministic coordinator tests for issue-15 narration gating. A hand-driven
// fake harness and fake speech adapter (no network, no CLI, no timers) let us
// order streamed text, tool starts, onResult and send resolution exactly and
// assert precisely what is synthesized.

interface Fakes {
  conv: RetainedConversation;
  events: RealtimeEvent[];
  emit(event: HarnessEvent): void;
  result(text: string): void;
  resolveSend(): void;
  rejectSend(): void;
  interruptCalls: number;
  speech: {
    writes: string[];
    finishCount: number;
    prewarmCount: number;
    cancelCount: number;
  };
  synthesized(): string;
}

function setup(): Fakes {
  const events: RealtimeEvent[] = [];
  let onEvent: (event: HarnessEvent) => void = () => {};
  let onResult: ((text: string) => void) | undefined;
  let resolveSend!: () => void;
  let rejectSend!: () => void;
  let interruptCalls = 0;

  const harness: RealtimeHarness = {
    start: async () => {},
    send: () =>
      new Promise<void>((resolve, reject) => {
        resolveSend = resolve;
        rejectSend = () => reject(new Error('send_failed'));
      }),
    interrupt: async () => {
      interruptCalls += 1;
    },
    close: async () => {},
  };

  const writes: string[] = [];
  let finishCount = 0;
  let prewarmCount = 0;
  let cancelCount = 0;
  let onAudio: (audio: string, sampleRate: number) => void = () => {};
  // Text written since the last finishSpeech; a finish "synthesizes" it as one
  // audio frame (base64 of the utf8 text) so the coordinator emits observable
  // audio without a real provider.
  let buffer = '';

  const speech: RealtimeSpeech = {
    startRecognition: async () => {},
    writeAudio: () => true,
    commitRecognition: async () => '',
    prewarm: () => {
      prewarmCount += 1;
    },
    writeText: (text: string) => {
      writes.push(text);
      buffer += text;
    },
    finishSpeech: async () => {
      finishCount += 1;
      if (buffer) {
        onAudio(Buffer.from(buffer, 'utf8').toString('base64'), 24000);
        buffer = '';
      }
    },
    cancelSpeech: () => {
      cancelCount += 1;
      buffer = '';
    },
    abortRecognition: () => {},
    close: () => {},
  };

  const conv = createConversation({
    id: 'gate-1',
    mode: 'fixture',
    harness: (event, result) => {
      onEvent = event;
      onResult = result;
      return harness;
    },
    speech: (callbacks) => {
      onAudio = callbacks.onAudio;
      return speech;
    },
  });
  conv.attach((event) => events.push(event));

  return {
    conv,
    events,
    emit: (event) => onEvent(event),
    result: (text) => onResult?.(text),
    resolveSend: () => resolveSend(),
    rejectSend: () => rejectSend(),
    get interruptCalls() {
      return interruptCalls;
    },
    speech: {
      writes,
      get finishCount() {
        return finishCount;
      },
      get prewarmCount() {
        return prewarmCount;
      },
      get cancelCount() {
        return cancelCount;
      },
    },
    synthesized: () =>
      events
        .filter((e): e is Extract<RealtimeEvent, { type: 'audio' }> => e.type === 'audio')
        .map((e) => Buffer.from(e.audio, 'base64').toString('utf8'))
        .join(''),
  };
}

/**
 * Flush microtasks until the response settles. Everything in these fakes is
 * timer-free (promises resolve on microtasks), so the inference chain completes
 * within a bounded number of `await` ticks — no real or virtual clock needed.
 */
async function settle(events: RealtimeEvent[]): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (events.some((e) => e.type === 'response_done' || e.type === 'response_cancelled')) return;
    await Promise.resolve();
  }
}

const diagCodes = (events: RealtimeEvent[]): string[] =>
  events
    .filter((e): e is Extract<RealtimeEvent, { type: 'diagnostic' }> => e.type === 'diagnostic')
    .map((e) => e.event.code);

describe('coordinator narration gating (issue 15)', () => {
  it('speaks the preamble, gates narration once a tool starts, then speaks only the final answer', async () => {
    const f = setup();
    await f.conv.start();
    const turn = f.conv.handle({ type: 'text', turnId: 1, text: 'go' });
    // Pre-tool narration is synthesized for fast first audio.
    f.emit({ type: 'text', text: 'Let me look that up. ' });
    // Tool starts: further streamed narration is gated and the preamble stream
    // is ended right away.
    f.emit({ type: 'tool', name: 'WebSearch', status: 'running', callId: 'c1' });
    f.emit({ type: 'text', text: 'The answer is 42.' }); // post-tool narration — gated
    f.result('The answer is 42.');
    f.resolveSend();
    await turn;
    await settle(f.events);

    // Only the preamble and the concise final answer were synthesized; the gated
    // streamed copy of the answer was not spoken twice.
    expect(f.speech.writes).toEqual(['Let me look that up. ', 'The answer is 42.']);
    expect(f.synthesized()).toBe('Let me look that up. The answer is 42.');
    // The preamble stream was ended at the tool, and a fresh stream flushed the final.
    expect(f.speech.finishCount).toBe(2);
    expect(f.speech.prewarmCount).toBe(1);
    // Transcript keeps ALL text, including the gated copy.
    const texts = f.events.filter((e) => e.type === 'text');
    expect(texts).toHaveLength(2);
    const codes = diagCodes(f.events);
    expect(codes).toContain('speech_gated');
    expect(codes).toContain('final_answer_synthesized');
  });

  it('leaves a no-tool turn on the existing streaming path (no gating, no re-speak)', async () => {
    const f = setup();
    await f.conv.start();
    const turn = f.conv.handle({ type: 'text', turnId: 1, text: 'go' });
    f.emit({ type: 'text', text: 'Simple direct answer.' });
    f.result('Simple direct answer.');
    f.resolveSend();
    await turn;
    await settle(f.events);

    // Streamed once, never re-synthesized from onResult.
    expect(f.speech.writes).toEqual(['Simple direct answer.']);
    expect(f.speech.finishCount).toBe(1);
    const codes = diagCodes(f.events);
    expect(codes).not.toContain('speech_gated');
    expect(codes).not.toContain('final_answer_synthesized');
  });

  it('tolerates an absent onResult after tools: says nothing more and reports it', async () => {
    const f = setup();
    await f.conv.start();
    const turn = f.conv.handle({ type: 'text', turnId: 1, text: 'go' });
    f.emit({ type: 'text', text: 'Working on it. ' });
    f.emit({ type: 'tool', name: 'WebSearch', status: 'running', callId: 'c1' });
    f.emit({ type: 'text', text: 'silent result' }); // gated
    // No onResult delivered at all.
    f.resolveSend();
    await turn;
    await settle(f.events);

    expect(f.speech.writes).toEqual(['Working on it. ']); // only the preamble
    expect(f.synthesized()).toBe('Working on it. ');
    // Reported rather than re-speaking the narration.
    expect(diagCodes(f.events)).toContain('final_answer_synthesized');
  });

  it('interrupt during the tool wait cancels both epochs and never speaks the late final', async () => {
    const f = setup();
    await f.conv.start();
    const turn = f.conv.handle({ type: 'text', turnId: 1, text: 'go' });
    f.emit({ type: 'text', text: 'Let me check. ' });
    f.emit({ type: 'tool', name: 'WebSearch', status: 'running', callId: 'c1' });

    // Barge-in while the tool is still running (send is pending).
    await f.conv.handle({ type: 'interrupt', responseId: 1 });
    expect(f.interruptCalls).toBe(1);
    expect(f.speech.cancelCount).toBeGreaterThanOrEqual(1);

    // A late final result and the eventual send resolution must not synthesize.
    f.result('Late final answer.');
    f.resolveSend();
    await turn;
    await settle(f.events);

    expect(f.speech.writes).not.toContain('Late final answer.');
    expect(f.synthesized()).not.toContain('Late final answer.');
    expect(f.events.some((e) => e.type === 'response_cancelled')).toBe(true);
    expect(f.events.some((e) => e.type === 'response_done')).toBe(false);
  });
});
