import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from './index.js';
import type { HarnessEvent, HarnessOptions } from '../../shared/contracts.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/cli-fixture.mjs', import.meta.url));

interface Harness {
  start(): Promise<void>;
  send(text: string): Promise<void>;
  close(): Promise<void>;
}

const openSessions: Harness[] = [];

function build(
  scenario: string,
  extraEnv: Record<string, string | undefined> = {},
  overrides: Partial<HarnessOptions> = {},
): { session: Harness; events: HarnessEvent[]; texts: () => string; tools: () => HarnessEvent[] } {
  const events: HarnessEvent[] = [];
  const session = createHarness({
    command: 'node',
    args: [FIXTURE],
    env: { SCENARIO: scenario, ...extraEnv },
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  openSessions.push(session);
  return {
    session,
    events,
    texts: () =>
      events
        .filter((e): e is Extract<HarnessEvent, { type: 'text' }> => e.type === 'text')
        .map((e) => e.text)
        .join(''),
    tools: () => events.filter((e) => e.type === 'tool'),
  };
}

afterEach(async () => {
  await Promise.all(openSessions.splice(0).map((s) => s.close().catch(() => {})));
});

describe('createHarness', () => {
  it('accepts initialization emitted only after the first user input', async () => {
    const { session, texts } = build('basic', {}, {
      command: process.execPath,
      args: [fileURLToPath(new URL('../../../tests/fixtures/harness.mjs', import.meta.url))],
      timeoutMs: 300,
    });
    await session.start();
    await session.send('first input');
    expect(texts()).toContain('Turn 1:');
  });

  it('spawns without warm-up and reports session/tool metadata on ready', async () => {
    const { session, events } = build('basic');
    await session.start();
    await vi.waitFor(() => {
      expect(events.find((e) => e.type === 'ready')).toEqual({
        type: 'ready', sessionId: 'fixture-session', tools: ['Read', 'Bash'],
      });
    });
    // No inference happened just from starting.
    expect(events.some((e) => e.type === 'text')).toBe(false);
  });

  it('streams only eligible top-level assistant text and drops thinking/tool-json/nested output', async () => {
    const { session, texts, events } = build('basic');
    await session.start();
    await session.send('hi');
    expect(texts()).toBe('Hello café 🌊 world');
    expect(texts()).not.toContain('secret reasoning');
    expect(texts()).not.toContain('passwd');
    expect(texts()).not.toContain('NESTED-LEAK');
    // Exactly two deltas -> two text events (no completed-message duplication).
    expect(events.filter((e) => e.type === 'text')).toHaveLength(2);
  });

  it('emits tool running/done status', async () => {
    const { session, tools } = build('basic');
    await session.start();
    await session.send('hi');
    expect(tools()).toEqual([
      { type: 'tool', name: 'Read', status: 'running' },
      { type: 'tool', name: 'Read', status: 'done' },
    ]);
  });

  it('reassembles multi-byte UTF-8 text fragmented across chunk boundaries', async () => {
    const { session, texts } = build('basic', { FRAGMENT: '1' });
    await session.start();
    await session.send('hi');
    expect(texts()).toBe('Hello café 🌊 world');
  });

  it('handles two sequential turns on the same persistent process', async () => {
    const { session, events } = build('basic');
    await session.start();
    await session.send('first');
    await session.send('second');
    expect(events.filter((e) => e.type === 'text')).toHaveLength(4);
    expect(events.filter((e) => e.type === 'ready')).toHaveLength(1);
  });

  it('rejects an overlapping turn while one is in progress', async () => {
    const { session } = build('basic', { DELAY_MS: '150' });
    await session.start();
    const first = session.send('one');
    await expect(session.send('two')).rejects.toThrow(/already in progress/i);
    await expect(first).resolves.toBeUndefined();
  });

  it('rejects empty turns and turns before start', async () => {
    const { session } = build('basic');
    await expect(session.send('hi')).rejects.toThrow(/not ready/i);
    await session.start();
    await expect(session.send('   ')).rejects.toThrow(/empty/i);
  });

  it('rejects the turn and emits an error event on a CLI error result', async () => {
    const { session, events } = build('error');
    await session.start();
    await expect(session.send('hi')).rejects.toThrow(/synthetic turn failure/i);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('rejects the pending turn when the process exits (EOF)', async () => {
    const { session } = build('crash');
    await session.start();
    await expect(session.send('hi')).rejects.toThrow(/exited/i);
  });

  it('rejects the turn on timeout', async () => {
    const { session } = build('hang', {}, { timeoutMs: 250 });
    await session.start();
    await expect(session.send('hi')).rejects.toThrow(/timed out/i);
  });

  it('rejects start() when the process cannot be spawned', async () => {
    const events: HarnessEvent[] = [];
    const session = createHarness({
      command: 'definitely-not-a-real-command-xyz',
      args: [],
      timeoutMs: 2000,
      onEvent: (e) => events.push(e),
    });
    openSessions.push(session);
    await expect(session.start()).rejects.toThrow(/failed to start/i);
  });

  it('close() is idempotent and settles a pending turn', async () => {
    const { session } = build('hang');
    await session.start();
    const pending = session.send('hi');
    const closed = session.close();
    await expect(pending).rejects.toThrow(/closed/i);
    await expect(closed).resolves.toBeUndefined();
    // Idempotent: a second close resolves too.
    await expect(session.close()).resolves.toBeUndefined();
    // Sending after close is rejected.
    await expect(session.send('again')).rejects.toThrow(/closed/i);
  });

  it('reports MCP connection metadata from system/init', async () => {
    const { session, events } = build('basic', { MCP: '1' });
    await session.start();
    await vi.waitFor(() => {
      const ready = events.find((e) => e.type === 'ready');
      expect(ready).toBeDefined();
      expect((ready as Extract<HarnessEvent, { type: 'ready' }>).mcp).toEqual([
        { name: 'fermi', status: 'connected' },
        { name: 'offline', status: 'failed' },
      ]);
    });
  });

  it('maps an errored tool_result to failed, not done', async () => {
    const { session, tools } = build('basic', { TOOL_ERROR: 'failed' });
    await session.start();
    await session.send('hi');
    expect(tools()).toEqual([
      { type: 'tool', name: 'Read', status: 'running' },
      { type: 'tool', name: 'Read', status: 'failed' },
    ]);
  });

  it('maps a permission-denied tool_result to denied', async () => {
    const { session, tools } = build('basic', { TOOL_ERROR: 'denied' });
    await session.start();
    await session.send('hi');
    expect(tools().at(-1)).toEqual({ type: 'tool', name: 'Read', status: 'denied' });
  });

  it('interrupt() with no active turn resolves without a control_request', async () => {
    const { session } = build('basic');
    await session.start();
    // Casting: interrupt is a P2 compatibility method on the adapter.
    await expect((session as unknown as { interrupt(): Promise<void> }).interrupt()).resolves.toBeUndefined();
  });

  it('interrupt() acknowledges, settles the turn, and fences late generation text', async () => {
    const built = build('interrupt', {}, { timeoutMs: 2000 });
    const session = built.session as unknown as { interrupt(): Promise<void> } & typeof built.session;
    await session.start();
    const turn = session.send('go');
    // Wait until the fixture has streamed its first (pre-interrupt) delta.
    await vi.waitFor(() => expect(built.texts()).toContain('Partial answer'));
    await session.interrupt();
    // The aborted turn settles (resolve or reject is acceptable) rather than hanging.
    await turn.then(() => undefined, () => undefined);
    // Late text emitted after the interrupt request must be fenced out.
    expect(built.texts()).not.toContain('LATE-AFTER-INTERRUPT');
  });

  it('interrupt() rejects when the control_request is never acknowledged', async () => {
    const built = build('interrupt', { INTERRUPT_NOACK: '1' }, { timeoutMs: 8000 });
    const session = built.session as unknown as { interrupt(): Promise<void> } & typeof built.session;
    await session.start();
    // The hanging turn is settled by afterEach close(); swallow its rejection.
    const turn = session.send('go');
    turn.catch(() => undefined);
    await vi.waitFor(() => expect(built.texts()).toContain('Partial answer'));
    await expect(session.interrupt()).rejects.toThrow(/not acknowledged/i);
  });

  it('quarantines after an unacknowledged interrupt so a replacement send is refused', async () => {
    const built = build('interrupt', { INTERRUPT_NOACK: '1' }, { timeoutMs: 400 });
    const session = built.session as unknown as { interrupt(): Promise<void> } & typeof built.session;
    await session.start();
    const turn = session.send('go');
    turn.catch(() => undefined);
    await vi.waitFor(() => expect(built.texts()).toContain('Partial answer'));
    // A short timeout collides the receipt and turn timers; either way the
    // interrupt rejects (never resolves as a clean cancel) and quarantines.
    await expect(session.interrupt()).rejects.toThrow();
    // The turn itself fails locally rather than resolving as a clean cancel.
    await expect(turn).rejects.toThrow();
    // A replacement send must not lift the fence over possibly-live generation.
    await expect(session.send('replacement')).rejects.toThrow(/quarantined/i);
  });

  it('rejects and quarantines when an acknowledged interrupt never settles the turn (ACK / no result)', async () => {
    const built = build('interrupt', { INTERRUPT_NO_RESULT: '1' }, { timeoutMs: 500 });
    const session = built.session as unknown as { interrupt(): Promise<void> } & typeof built.session;
    await session.start();
    const turn = session.send('go');
    turn.catch(() => undefined);
    await vi.waitFor(() => expect(built.texts()).toContain('Partial answer'));
    // Acknowledged but no terminal result: a local settle timeout is not proven
    // cancellation, so the interrupt rejects rather than resolving as success.
    await expect(session.interrupt()).rejects.toThrow();
    await expect(turn).rejects.toThrow();
    // The fence stays raised: the fixture's post-ACK delta never surfaces.
    expect(built.texts()).not.toContain('LATE-AFTER-INTERRUPT');
    await expect(session.send('replacement')).rejects.toThrow(/quarantined/i);
  });

  it('rejects, fences, and quarantines when the process explicitly refuses the interrupt', async () => {
    const built = build('interrupt', { INTERRUPT_REJECT: '1' }, { timeoutMs: 2000 });
    const session = built.session as unknown as { interrupt(): Promise<void> } & typeof built.session;
    await session.start();
    const turn = session.send('go');
    turn.catch(() => undefined);
    await vi.waitFor(() => expect(built.texts()).toContain('Partial answer'));
    // The refusal rejects the interrupt and the turn; the late old-generation
    // result must NOT resolve the turn as a clean completion.
    await expect(session.interrupt()).rejects.toThrow(/interrupt refused/i);
    await expect(turn).rejects.toThrow(/interrupt refused/i);
    // Give the fixture's late old-generation output time to arrive over stdout.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(built.texts()).not.toContain('LATE-AFTER-INTERRUPT');
    await expect(session.send('replacement')).rejects.toThrow(/quarantined/i);
  });

  it('never surfaces late old-generation deltas after an unconfirmed interrupt', async () => {
    // ACK arrives, then the settle timeout quarantines before the deferred late
    // result would arrive: no old-generation text or result may resurface.
    const built = build(
      'interrupt',
      { INTERRUPT_NO_RESULT: '1', INTERRUPT_LATE_RESULT: '1', LATE_MS: '400' },
      { timeoutMs: 250 },
    );
    const session = built.session as unknown as { interrupt(): Promise<void> } & typeof built.session;
    await session.start();
    const turn = session.send('go');
    turn.catch(() => undefined);
    await vi.waitFor(() => expect(built.texts()).toContain('Partial answer'));
    await expect(session.interrupt()).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(built.texts()).not.toContain('LATE-AFTER-INTERRUPT');
    expect(built.texts()).not.toContain('LATE-OLD-GENERATION');
    await expect(session.send('replacement')).rejects.toThrow(/quarantined/i);
  });
});
