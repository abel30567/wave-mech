import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { GptLiveManager, type GptLiveSessionCallbacks, type HarnessFactory } from './session.js';
import type { LiveProvider, ProviderEventHandler } from './provider.js';
import type { HarnessOptions, HarnessSession } from '../../shared/contracts.js';

const USER_TEXT = 'What is my checking balance right now?';
const ANSWER_TEXT = 'Your checking balance is four hundred dollars.';

/** Harness that behaves like a tool-using Claude Code turn, or hangs forever. */
function instrumentedHarness(behaviour: 'tools' | 'hang' | 'fail'): HarnessFactory {
  return (options: HarnessOptions): HarnessSession => ({
    async start() {
      options.onEvent({ type: 'ready', model: 'claude-opus-4-6[1m]', tools: ['WebSearch'], mcp: [{ name: 'fermi', status: 'connected' }] });
    },
    async send() {
      if (behaviour === 'hang') return new Promise<void>(() => {});
      if (behaviour === 'fail') throw new Error('synthetic backend failure');
      options.onEvent({ type: 'tool', name: 'mcp__fermi__execute', status: 'running', callId: 'toolu_1' });
      await new Promise(resolve => setTimeout(resolve, 5));
      options.onEvent({ type: 'tool', name: 'mcp__fermi__execute', status: 'pending', callId: 'toolu_1', reason: 'approval_required', durationMs: 5 });
      options.onEvent({ type: 'text', text: 'Let me check. ' });
      options.onEvent({ type: 'tool', name: 'mcp__fermi__execute', status: 'running', callId: 'toolu_2' });
      options.onEvent({ type: 'tool', name: 'mcp__fermi__execute', status: 'done', callId: 'toolu_2', durationMs: 7 });
      options.onEvent({ type: 'result', durationMs: 40, numTurns: 3 });
      options.onResult?.(ANSWER_TEXT);
    },
    async close() {},
  });
}

function createProvider(opts: { createError?: Error } = {}) {
  let handler: ProviderEventHandler | null = null;
  const calls = { sendCommentary: [] as Array<[string, string | null]>, closeSession: 0, hangup: 0 };
  const provider: LiveProvider = {
    async createSession() {
      if (opts.createError) throw opts.createError;
      return { providerSessionId: 'prov-diag', answerSdp: 'v=0\r\nanswer' };
    },
    async attachSideband(_sid, h) { handler = h; return { close() {} }; },
    sendThinking() {},
    sendCommentary(content, delegationId) { calls.sendCommentary.push([content, delegationId]); },
    closeSession() { calls.closeSession++; },
    async hangup() { calls.hangup++; },
    destroy() {},
  };
  return { provider, calls, handler: () => handler };
}

function callbacks(): GptLiveSessionCallbacks {
  return { onTranscriptDelta: vi.fn(), onDelegationCreated: vi.fn(), onUsageUpdate: vi.fn(), onSessionClosed: vi.fn(), onError: vi.fn() };
}

describe('GPT-Live diagnostics parity', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = path.join(tmpdir(), `wave-live-diag-${randomBytes(4).toString('hex')}`);
    await mkdir(workDir, { recursive: true });
  });
  afterEach(async () => { await rm(workDir, { recursive: true, force: true }); });

  async function manager(harness: HarnessFactory, provider: LiveProvider, maxSessionSeconds = 60): Promise<GptLiveManager> {
    const keyFile = path.join(workDir, 'api.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdefg', { mode: 0o600 });
    const created = new GptLiveManager({
      enabled: true, apiKeyFile: keyFile, budgetFile: path.join(workDir, 'budget.json'), maxSessionSeconds,
      configuredModel: 'claude-opus-4-6[1m]', nodeExecutable: process.execPath, providerFactory: () => provider, harnessFactory: harness,
    });
    await created.initialize();
    return created;
  }

  it('records timestamped lifecycle, delegation, tool and result metadata without task text', async () => {
    const live = createProvider();
    const m = await manager(instrumentedHarness('tools'), live.provider);
    const before = Date.now();
    const { sessionId } = await m.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks());
    await vi.waitFor(() => expect(live.handler()).not.toBeNull());

    const active = m.getDiagnostics('owner-1');
    expect(active.startedAt).toBeGreaterThanOrEqual(before);
    expect(active.deadlineAt).toBe(active.startedAt! + 60_000);
    expect(active.maxSessionSeconds).toBe(60);
    expect(active.backendReportedModel).toBe('claude-opus-4-6[1m]');
    expect(active.stopCause).toBeNull();
    expect(active.diagnostics!.entries.map(e => e.code)).toEqual(['session_requested', 'connection_ready', 'provider_session_created', 'sideband_attached']);

    live.handler()!.onInputTranscript(USER_TEXT);
    live.handler()!.onDelegationCreated('dlg_1', 1500);
    await vi.waitFor(() => expect(m.getDiagnostics('owner-1').delegations![0].status).toBe('delivered'));

    const during = m.getDiagnostics('owner-1');
    const codes = during.diagnostics!.entries.map(e => e.code);
    expect(codes.slice(4)).toEqual(['delegation_created', 'delegation_started', 'tool_start', 'tool_result', 'tool_start', 'tool_result', 'backend_result', 'commentary_sent']);
    const entries = during.diagnostics!.entries;
    for (const entry of entries) {
      expect(entry.id).toMatch(/^server:\d+$/);
      expect(entry.at).toBeGreaterThanOrEqual(before);
    }
    expect(entries.find(e => e.code === 'tool_result' && e.callId === 'toolu_1')).toMatchObject({ delegationId: 'dlg_1', tool: 'mcp__fermi__execute', status: 'pending', reason: 'approval_required', durationMs: 5 });
    expect(entries.find(e => e.code === 'tool_result' && e.callId === 'toolu_2')).toMatchObject({ status: 'done', durationMs: 7 });
    expect(entries.find(e => e.code === 'backend_result')).toMatchObject({ delegationId: 'dlg_1', count: 3 });
    expect(entries.find(e => e.code === 'commentary_sent')).toMatchObject({ delegationId: 'dlg_1', count: 1 });
    expect(during.delegations).toHaveLength(1);
    expect(during.delegations![0]).toMatchObject({ delegationId: 'dlg_1', offsetMs: 1500, status: 'delivered' });
    expect(during.delegations![0].sentAt).toBeGreaterThanOrEqual(during.delegations![0].createdAt);
    expect(during.delegations![0].settledAt).toBeGreaterThanOrEqual(during.delegations![0].sentAt!);
    // Structured records never carry the user's request or the backend answer.
    const structured = JSON.stringify({ diagnostics: during.diagnostics, delegations: during.delegations });
    expect(structured).not.toContain('balance');
    expect(structured).not.toContain('hundred');
    expect(live.calls.sendCommentary).toEqual([[ANSWER_TEXT, 'dlg_1']]);

    await m.closeSession(sessionId, 'user_ended');
    live.handler()!.onSessionClosed('close_requested', { seconds: 30 });
    await vi.waitFor(() => expect(m.hasActiveSession).toBe(false));

    const final = m.getDiagnostics('owner-1');
    expect(final.stopCause).toBe('user_ended');
    expect(final.closureReason).toBe('close_requested');
    expect(final.closureConfirmed).toBe(true);
    expect(final.unfinishedDelegation).toBe(false);
    expect(final.endedAt).toBeGreaterThanOrEqual(final.startedAt!);
    const finalCodes = final.diagnostics!.entries.map(e => e.code);
    expect(finalCodes.slice(-3)).toEqual(['stop_user_ended', 'closure_confirmed', 'session_closed']);
    expect(final.diagnostics!.entries.find(e => e.code === 'closure_confirmed')).toMatchObject({ durationMs: 30_000 });
    expect(m.getDiagnostics('someone-else').diagnostics!.entries).toEqual([]);
  });

  it('marks a running delegation unfinished when the deadline stops the session and keeps that after cleanup', async () => {
    const live = createProvider();
    const m = await manager(instrumentedHarness('hang'), live.provider, 1);
    await m.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks());
    await vi.waitFor(() => expect(live.handler()).not.toBeNull());
    live.handler()!.onInputTranscript(USER_TEXT);
    live.handler()!.onDelegationCreated('dlg_slow', 900);
    await vi.waitFor(() => expect(m.getDiagnostics('owner-1').delegations![0].status).toBe('running'));

    await vi.waitFor(() => expect(live.calls.closeSession).toBe(1), { timeout: 3000 });
    const stopped = m.getDiagnostics('owner-1');
    expect(stopped.stopCause).toBe('deadline');
    expect(stopped.unfinishedDelegation).toBe(true);
    expect(stopped.delegations![0].status).toBe('unfinished');
    expect(stopped.diagnostics!.entries.find(e => e.code === 'stop_deadline')).toMatchObject({ count: 1 });

    live.handler()!.onSessionClosed('close_requested', { seconds: 1 });
    await vi.waitFor(() => expect(m.hasActiveSession).toBe(false));
    const retained = m.getDiagnostics('owner-1');
    expect(retained.stopCause).toBe('deadline');
    expect(retained.closureReason).toBe('close_requested');
    expect(retained.unfinishedDelegation).toBe(true);
    expect(retained.delegations![0].status).toBe('unfinished');
    expect(live.calls.sendCommentary).toEqual([]);
  });

  it('attributes a closure the app never requested to the provider and records a backend failure', async () => {
    const live = createProvider();
    const m = await manager(instrumentedHarness('fail'), live.provider);
    await m.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks());
    await vi.waitFor(() => expect(live.handler()).not.toBeNull());
    live.handler()!.onInputTranscript(USER_TEXT);
    live.handler()!.onDelegationCreated('dlg_fail', 100);
    await vi.waitFor(() => expect(m.getDiagnostics('owner-1').delegations![0].status).toBe('failed'));
    expect(m.getDiagnostics('owner-1').diagnostics!.entries.find(e => e.code === 'backend_failed')).toMatchObject({ delegationId: 'dlg_fail', reason: 'unknown' });

    live.handler()!.onSessionClosed('server_closed', { seconds: 4 });
    await vi.waitFor(() => expect(m.hasActiveSession).toBe(false));
    const final = m.getDiagnostics('owner-1');
    expect(final.stopCause).toBe('provider_closed');
    expect(final.closureReason).toBe('server_closed');
    expect(final.delegationsSkipped).toBe(1);
  });

  it('retains startup records for the owner when provider creation fails', async () => {
    const live = createProvider({ createError: new Error('provider unavailable') });
    const m = await manager(instrumentedHarness('tools'), live.provider);
    await expect(m.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks())).rejects.toThrow();
    const failed = m.getDiagnostics('owner-1');
    expect(failed.sessionId).not.toBeNull();
    expect(failed.stopCause).toBe('unknown');
    expect(failed.diagnostics!.entries.map(e => e.code)).toEqual(['session_requested', 'connection_ready', 'session_create_failed']);
    expect(failed.diagnostics!.entries.at(-1)).toMatchObject({ reason: 'provider' });
    expect(m.getDiagnostics('other').diagnostics!.entries).toEqual([]);
  });
});
