import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from './index.js';
import type { HarnessEvent, HarnessOptions } from '../../shared/contracts.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/cli-fixture.mjs', import.meta.url));

interface Harness {
  start(): Promise<void>;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
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
  }) as unknown as Harness;
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
      const ready = events.find((e) => e.type === 'ready');
      expect(ready).toBeDefined();
      expect(ready).toMatchObject({
        type: 'ready', sessionId: 'fixture-session', tools: ['Read', 'Bash'],
      });
    });
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
    expect(events.filter((e) => e.type === 'text')).toHaveLength(2);
  });

  it('emits tool running/done status with callId and durationMs', async () => {
    const { session, tools } = build('basic');
    await session.start();
    await session.send('hi');
    const toolEvents = tools() as Array<Extract<HarnessEvent, { type: 'tool' }>>;
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]).toMatchObject({ type: 'tool', name: 'Read', status: 'running', callId: 'tool-1' });
    expect(toolEvents[1]).toMatchObject({ type: 'tool', name: 'Read', status: 'done', callId: 'tool-1' });
    expect(toolEvents[1].durationMs).toBeTypeOf('number');
    expect(toolEvents[1].durationMs).toBeGreaterThanOrEqual(0);
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
    openSessions.push(session as unknown as Harness);
    await expect(session.start()).rejects.toThrow(/failed to start/i);
  });

  it('close() is idempotent and settles a pending turn', async () => {
    const { session } = build('hang');
    await session.start();
    const pending = session.send('hi');
    const closed = session.close();
    await expect(pending).rejects.toThrow(/closed/i);
    await expect(closed).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();
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
    const toolEvents = tools() as Array<Extract<HarnessEvent, { type: 'tool' }>>;
    expect(toolEvents[1]).toMatchObject({ type: 'tool', name: 'Read', status: 'failed' });
  });

  it('maps a permission-denied tool_result to denied', async () => {
    const { session, tools } = build('basic', { TOOL_ERROR: 'denied' });
    await session.start();
    await session.send('hi');
    const last = tools().at(-1) as Extract<HarnessEvent, { type: 'tool' }>;
    expect(last).toMatchObject({ type: 'tool', name: 'Read', status: 'denied' });
    expect(last.reason).toBe('policy_denied');
  });

  it('interrupt() with no active turn resolves without a control_request', async () => {
    const { session } = build('basic');
    await session.start();
    await expect(session.interrupt()).resolves.toBeUndefined();
  });

  it('interrupt() acknowledges, settles the turn, and fences late generation text', async () => {
    const built = build('interrupt', {}, { timeoutMs: 2000 });
    const session = built.session;
    await session.start();
    const turn = session.send('go');
    await vi.waitFor(() => expect(built.texts()).toContain('Partial answer'));
    await session.interrupt();
    await turn.then(() => undefined, () => undefined);
    expect(built.texts()).not.toContain('LATE-AFTER-INTERRUPT');
  });

  it('interrupt() rejects when the control_request is never acknowledged', async () => {
    const built = build('interrupt', { INTERRUPT_NOACK: '1' }, { timeoutMs: 8000 });
    const session = built.session;
    await session.start();
    const turn = session.send('go');
    turn.catch(() => undefined);
    await vi.waitFor(() => expect(built.texts()).toContain('Partial answer'));
    await expect(session.interrupt()).rejects.toThrow(/not acknowledged/i);
  });

  it('quarantines after an unacknowledged interrupt so a replacement send is refused', async () => {
    const built = build('interrupt', { INTERRUPT_NOACK: '1' }, { timeoutMs: 400 });
    const session = built.session;
    await session.start();
    const turn = session.send('go');
    turn.catch(() => undefined);
    await vi.waitFor(() => expect(built.texts()).toContain('Partial answer'));
    await expect(session.interrupt()).rejects.toThrow();
    await expect(turn).rejects.toThrow();
    await expect(session.send('replacement')).rejects.toThrow(/quarantined/i);
  });

  it('rejects and quarantines when an acknowledged interrupt never settles the turn (ACK / no result)', async () => {
    const built = build('interrupt', { INTERRUPT_NO_RESULT: '1' }, { timeoutMs: 500 });
    const session = built.session;
    await session.start();
    const turn = session.send('go');
    turn.catch(() => undefined);
    await vi.waitFor(() => expect(built.texts()).toContain('Partial answer'));
    await expect(session.interrupt()).rejects.toThrow();
    await expect(turn).rejects.toThrow();
    expect(built.texts()).not.toContain('LATE-AFTER-INTERRUPT');
    await expect(session.send('replacement')).rejects.toThrow(/quarantined/i);
  });

  it('rejects, fences, and quarantines when the process explicitly refuses the interrupt', async () => {
    const built = build('interrupt', { INTERRUPT_REJECT: '1' }, { timeoutMs: 2000 });
    const session = built.session;
    await session.start();
    const turn = session.send('go');
    turn.catch(() => undefined);
    await vi.waitFor(() => expect(built.texts()).toContain('Partial answer'));
    await expect(session.interrupt()).rejects.toThrow(/interrupt refused/i);
    await expect(turn).rejects.toThrow(/interrupt refused/i);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(built.texts()).not.toContain('LATE-AFTER-INTERRUPT');
    await expect(session.send('replacement')).rejects.toThrow(/quarantined/i);
  });

  it('never surfaces late old-generation deltas after an unconfirmed interrupt', async () => {
    const built = build(
      'interrupt',
      { INTERRUPT_NO_RESULT: '1', INTERRUPT_LATE_RESULT: '1', LATE_MS: '400' },
      { timeoutMs: 250 },
    );
    const session = built.session;
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

describe('createHarness — onResult callback', () => {
  it('invokes onResult with final text only (not preamble) when tools are used', async () => {
    const results: string[] = [];
    const { session, texts } = build('tool_then_result', {}, {
      onResult: (text) => results.push(text),
    });
    await session.start();
    await session.send('hi');
    expect(results).toHaveLength(1);
    expect(results[0]).toBe('The answer is 42.');
    expect(texts()).toContain('Let me look that up.');
    expect(texts()).toContain('The answer is 42.');
  });

  it('invokes onResult with full text when no tools are used', async () => {
    const results: string[] = [];
    const { session } = build('text_only', {}, {
      onResult: (text) => results.push(text),
    });
    await session.start();
    await session.send('hi');
    expect(results).toHaveLength(1);
    expect(results[0]).toBe('Simple direct answer.');
  });

  it('does not invoke onResult on error result', async () => {
    const results: string[] = [];
    const { session } = build('error', {}, {
      onResult: (text) => results.push(text),
    });
    await session.start();
    await expect(session.send('hi')).rejects.toThrow();
    expect(results).toHaveLength(0);
  });

  it('does not invoke onResult when process crashes', async () => {
    const results: string[] = [];
    const { session } = build('crash', {}, {
      onResult: (text) => results.push(text),
    });
    await session.start();
    await expect(session.send('hi')).rejects.toThrow();
    expect(results).toHaveLength(0);
  });
});

describe('createHarness — model validation', () => {
  it('preserves a safe Claude model identifier from system/init', async () => {
    const { session, events } = build('basic', { MODEL: 'claude-opus-4-6' });
    await session.start();
    await vi.waitFor(() => {
      const ready = events.find((e) => e.type === 'ready') as Extract<HarnessEvent, { type: 'ready' }>;
      expect(ready?.model).toBe('claude-opus-4-6');
    });
  });

  it('rejects a model identifier that does not match the safe pattern', async () => {
    const { session, events } = build('basic', { MODEL: '../../../etc/passwd' });
    await session.start();
    await vi.waitFor(() => {
      const ready = events.find((e) => e.type === 'ready') as Extract<HarnessEvent, { type: 'ready' }>;
      expect(ready?.model).toBeUndefined();
    });
  });

  it('rejects a model that does not start with claude-', async () => {
    const { session, events } = build('basic', { MODEL: 'gpt-4o' });
    await session.start();
    await vi.waitFor(() => {
      const ready = events.find((e) => e.type === 'ready') as Extract<HarnessEvent, { type: 'ready' }>;
      expect(ready?.model).toBeUndefined();
    });
  });

  it('reports the explicit 1M model without discarding its context suffix', async () => {
    const { session, events } = build('basic', { MODEL: 'claude-opus-4-6[1m]' });
    await session.start();
    await vi.waitFor(() => {
      expect(events.find(e => e.type === 'ready')).toMatchObject({ model: 'claude-opus-4-6[1m]' });
    });
  });
});

describe('createHarness — NDJSON fixture regressions', () => {
  it('handles repeated/concurrent tool names with distinct callIds', async () => {
    const built = build('concurrent_tools');
    await built.session.start();
    await built.session.send('go');
    const toolEvents = built.tools() as Array<Extract<HarnessEvent, { type: 'tool' }>>;
    const running = toolEvents.filter((t) => t.status === 'running');
    const done = toolEvents.filter((t) => t.status === 'done');
    expect(running).toHaveLength(2);
    expect(done).toHaveLength(2);
    expect(running[0].callId).toBe('ct-1');
    expect(running[1].callId).toBe('ct-2');
    expect(done[0].callId).toBe('ct-1');
    expect(done[1].callId).toBe('ct-2');
    expect(running[0].callId).not.toBe(running[1].callId);
  });

  it('classifies service failure despite is_error:false integration JSON as failed/provider', async () => {
    const built = build('service_failure');
    await built.session.start();
    await built.session.send('go');
    const toolEvents = built.tools() as Array<Extract<HarnessEvent, { type: 'tool' }>>;
    const terminal = toolEvents.find((t) => t.status === 'failed');
    expect(terminal).toBeDefined();
    expect(terminal?.callId).toBe('sf-1');
    expect(terminal?.reason).toBe('provider');
    expect(terminal?.statusCode).toBe(503);
  });

  it('classifies pending_approval status as pending/approval_required', async () => {
    const built = build('pending_approval');
    await built.session.start();
    await built.session.send('go');
    const toolEvents = built.tools() as Array<Extract<HarnessEvent, { type: 'tool' }>>;
    const terminal = toolEvents.find((t) => t.status === 'pending');
    expect(terminal).toBeDefined();
    expect(terminal?.reason).toBe('approval_required');
  });

  it('never emits raw arguments/results/errors/tokens in diagnostics for secret payloads', async () => {
    const built = build('secret_sentinel');
    await built.session.start();
    await built.session.send('go');
    const entries = built.tools() as Array<Extract<HarnessEvent, { type: 'tool' }>>;
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('sk-ant-XXXX');
    expect(serialized).not.toContain('secret-token-value');
    const entry = entries.find(e => e.callId === 'sec-1' && e.status === 'done');
    expect(entry).toBeDefined();
    expect(entry?.name).toBe('mcp__fermi__secret_resolve');
    expect(entry?.status).toBe('done');
  });

  it('settles unresolved active tool attempts on exit/cancellation', async () => {
    const built = build('tool_crash');
    await built.session.start();
    await expect(built.session.send('go')).rejects.toThrow(/exited/i);
    const entries = built.tools() as Array<Extract<HarnessEvent, { type: 'tool' }>>;
    expect(entries.filter(e => e.status === 'cancelled')).toEqual([expect.objectContaining({ callId: 'crash-tool', reason: 'cancelled' })]);
    expect(entries.filter(e => e.status === 'done')).toEqual([]);
  });

  it('emits tool outcomes for the coordinator diagnostic log', async () => {
    const built = build('basic');
    await built.session.start();
    await built.session.send('go');
    const entries = (built.tools() as Array<Extract<HarnessEvent, { type: 'tool' }>>).filter(e => e.status !== 'running');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ callId: 'tool-1', name: 'Read', status: 'done' });
    expect(entries[0].durationMs).toBeTypeOf('number');
  });

  it('deduplicates repeated tool starts and results from the stream', async () => {
    const built = build('duplicate_tools');
    await built.session.start();
    await built.session.send('go');
    const toolEvents = built.tools() as Array<Extract<HarnessEvent, { type: 'tool' }>>;
    const terminal = toolEvents.filter((t) => t.status !== 'running');
    expect(terminal).toHaveLength(1);
    expect(terminal[0].status).toBe('done');
  });
});
