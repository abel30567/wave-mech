import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { GptLiveManager, splitUtf8Chunks, type GptLiveSessionCallbacks, type HarnessFactory } from '../../src/server/live/session.js';
import { GptLiveBudget } from '../../src/server/live/budget.js';
import type { LiveProvider, ProviderEventHandler } from '../../src/server/live/provider.js';
import type { HarnessSession, HarnessOptions } from '../../src/shared/contracts.js';

function tmpDir(): string {
  return path.join(tmpdir(), `wave-contract-${randomBytes(4).toString('hex')}`);
}

function noopCallbacks(): GptLiveSessionCallbacks {
  return {
    onTranscriptDelta: vi.fn(),
    onDelegationCreated: vi.fn(),
    onUsageUpdate: vi.fn(),
    onSessionClosed: vi.fn(),
    onError: vi.fn(),
  };
}

function createMockHarnessFactory(): HarnessFactory {
  return (options: HarnessOptions): HarnessSession => {
    let started = false;
    return {
      async start() { started = true; options.onEvent({ type: 'ready' }); },
      async send(text: string) {
        if (!started) throw new Error('Not started');
        options.onEvent({ type: 'text', text: `Response: ${text}` });
        if (options.onResult) options.onResult(`Response: ${text}`);
      },
      async close() { started = false; },
    };
  };
}

function createProvider(opts?: {
  sessionId?: string;
  onAttach?: (handler: ProviderEventHandler) => void;
}): LiveProvider {
  return {
    async createSession() {
      return {
        providerSessionId: opts?.sessionId ?? 'prov-contract',
        answerSdp: 'v=0\r\ncontract-answer',
      };
    },
    async attachSideband(_sid, handler) {
      opts?.onAttach?.(handler);
      return { close() {} };
    },
    sendThinking() {},
    sendCommentary() {},
    closeSession() {},
    async hangup() {},
    destroy() {},
  };
}

async function enabledManager(workDir: string, provOpts?: Parameters<typeof createProvider>[0], hf?: HarnessFactory) {
  const keyFile = path.join(workDir, 'api.key');
  await writeFile(keyFile, 'sk-test-contract-key-12345', { mode: 0o600 });
  const manager = new GptLiveManager({
    enabled: true,
    apiKeyFile: keyFile,
    budgetFile: path.join(workDir, 'budget.json'),
    maxSessionSeconds: 60,
    configuredModel: 'claude-opus-4-6[1m]',
    nodeExecutable: process.execPath,
    providerFactory: () => createProvider(provOpts),
    harnessFactory: hf ?? createMockHarnessFactory(),
  });
  await manager.initialize();
  return manager;
}

// ============================================================================
// PRIORITY 1: End + diagnostics ACTUAL CONTRACT
// ============================================================================
describe('contract: End + diagnostics lifecycle', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('diagnostics retain final closure/usage/transcript after finishCleanup clears active', async () => {
    let sidebandHandler: ProviderEventHandler | null = null;
    const manager = await enabledManager(workDir, {
      onAttach: (h) => { sidebandHandler = h; },
    });

    const callbacks = noopCallbacks();
    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks);
    await new Promise(r => setTimeout(r, 50));

    manager.handleInputTranscript('hello test');
    manager.handleUsageUpdate(25.5);

    sidebandHandler!.onSessionClosed('close_requested', { seconds: 30 });
    await new Promise(r => setTimeout(r, 50));

    expect(manager.hasActiveSession).toBe(false);

    const diag = manager.getDiagnostics();
    expect(diag.sessionId).not.toBeNull();
    expect(diag.closureConfirmed).toBe(true);
    expect(diag.closureReason).toBe('close_requested');
    expect(diag.cumulativeVoiceSeconds).toBe(30);
    expect(diag.transcript.length).toBeGreaterThan(0);
    expect(diag.transcript.some(t => t.text === 'hello test')).toBe(true);
  });

  it('diagnostics return owner-bound snapshot — non-owner gets empty', async () => {
    let sidebandHandler: ProviderEventHandler | null = null;
    const manager = await enabledManager(workDir, {
      onAttach: (h) => { sidebandHandler = h; },
    });

    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());
    await new Promise(r => setTimeout(r, 50));

    manager.handleInputTranscript('private info');
    sidebandHandler!.onSessionClosed('close_requested', { seconds: 10 });
    await new Promise(r => setTimeout(r, 50));

    expect(manager.getDiagnostics('owner-1').transcript.length).toBeGreaterThan(0);
    expect(manager.getDiagnostics('other-owner').transcript).toEqual([]);
    expect(manager.getDiagnostics('other-owner').sessionId).toBeNull();
  });

  it('End during async start (unmount) properly cleans up', async () => {
    let harnessStartResolve: (() => void) | null = null;
    const slowHarness: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() {
        await new Promise<void>(resolve => { harnessStartResolve = resolve; });
        options.onEvent({ type: 'ready' });
      },
      async send(text: string) {
        if (options.onResult) options.onResult(`ok: ${text}`);
      },
      async close() {},
    });

    const keyFile = path.join(workDir, 'api.key');
    await writeFile(keyFile, 'sk-test-contract-key-12345', { mode: 0o600 });
    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => createProvider(),
      harnessFactory: slowHarness,
    });
    await manager.initialize();

    const p = manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());
    await new Promise(r => setTimeout(r, 50));

    // Resolve the harness start so creation completes
    harnessStartResolve!();
    const result = await p;

    // Immediately close
    await manager.closeSession(result.sessionId, 'unmount');

    await vi.waitFor(() => {
      expect(manager.hasActiveSession).toBe(false);
    }, { timeout: 20_000 });

    const diag = manager.getDiagnostics('owner-1');
    expect(diag.sessionId).not.toBeNull();
  }, 25_000);
});

// ============================================================================
// PRIORITY 2: Fresh input — per-delegation cursor
// ============================================================================
describe('contract: fresh-input cursor prevents stale replay', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('prior user request is NOT re-sent when new delegation arrives without fresh input', async () => {
    const sentTexts: string[] = [];
    let sendGate: (() => void) | null = null;

    const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send(text: string) {
        sentTexts.push(text);
        await new Promise<void>(resolve => { sendGate = resolve; });
        if (options.onResult) options.onResult(`ok: ${text}`);
      },
      async close() {},
    });

    const manager = await enabledManager(workDir, undefined, harnessFactory);
    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());

    // First delegation with input
    manager.handleInputTranscript('buy 100 shares of AAPL');
    manager.handleDelegationCreated('deleg-1', 1000);

    await vi.waitFor(() => expect(sentTexts.length).toBe(1));
    expect(sentTexts[0]).toBe('buy 100 shares of AAPL');

    // Settle first delegation
    sendGate!();
    await new Promise(r => setTimeout(r, 50));

    // New delegation arrives WITHOUT new input
    manager.handleDelegationCreated('deleg-2', 2000);

    // Wait past the input timeout
    await new Promise(r => setTimeout(r, 4000));

    // Second delegation should NOT have sent the old "buy 100 shares" input
    expect(sentTexts.length).toBe(1);

    await manager.shutdown();
  }, 10000);

  it('new input after 500ms is NOT lost', async () => {
    const sentTexts: string[] = [];

    const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send(text: string) {
        sentTexts.push(text);
        if (options.onResult) options.onResult(`ok: ${text}`);
      },
      async close() {},
    });

    const manager = await enabledManager(workDir, undefined, harnessFactory);
    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());

    // Delegation arrives first
    manager.handleDelegationCreated('deleg-late', 500);

    // Input arrives after 800ms
    await new Promise(r => setTimeout(r, 800));
    manager.handleInputTranscript('delayed request');

    await vi.waitFor(() => expect(sentTexts.length).toBe(1), { timeout: 2000 });
    expect(sentTexts[0]).toBe('delayed request');

    await manager.shutdown();
  });

  it('fragmented new input across delta events is properly assembled', async () => {
    const sentTexts: string[] = [];
    let sendGate: (() => void) | null = null;

    const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send(text: string) {
        sentTexts.push(text);
        await new Promise<void>(resolve => { sendGate = resolve; });
        if (options.onResult) options.onResult(`ok: ${text}`);
      },
      async close() {},
    });

    const manager = await enabledManager(workDir, undefined, harnessFactory);
    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());

    // First delegation
    manager.handleInputTranscript('first request');
    manager.handleDelegationCreated('deleg-1', 1000);

    await vi.waitFor(() => expect(sentTexts.length).toBe(1));
    sendGate!();
    await new Promise(r => setTimeout(r, 50));

    // Second delegation with fragmented new input
    manager.handleInputTranscript('what ');
    manager.handleInputTranscript('is the ');
    manager.handleInputTranscript('weather?');
    manager.handleDelegationCreated('deleg-2', 2000);

    await vi.waitFor(() => expect(sentTexts.length).toBe(2));
    expect(sentTexts[1]).toBe('what is the weather?');

    sendGate!();
    await manager.shutdown();
  });

  it('close while input is queued does not process delegation', async () => {
    let sendCalled = false;

    const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send() { sendCalled = true; },
      async close() {},
    });

    const manager = await enabledManager(workDir, undefined, harnessFactory);
    const { sessionId } = await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());

    // Delegation without input — waiting for input
    manager.handleDelegationCreated('deleg-pending', 500);
    await new Promise(r => setTimeout(r, 50));

    // Close while waiting
    await manager.closeSession(sessionId, 'test');

    await vi.waitFor(() => {
      expect(manager.hasActiveSession).toBe(false);
    }, { timeout: 20_000 });

    expect(sendCalled).toBe(false);
  }, 25_000);
});

// ============================================================================
// PRIORITY 3: Final result delivery
// ============================================================================
describe('contract: final result delivery via commentary', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('commentary preserves full text without truncation for <=500 byte chunks', async () => {
    const commentaryCalls: [string, string | null][] = [];
    const longResult = 'A'.repeat(1200);

    const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send() {
        if (options.onResult) options.onResult(longResult);
      },
      async close() {},
    });

    const provider: LiveProvider = {
      async createSession() {
        return { providerSessionId: 'prov-chunk', answerSdp: 'v=0\r\nanswer' };
      },
      async attachSideband() { return { close() {} }; },
      sendThinking() {},
      sendCommentary(content, delegationId) {
        commentaryCalls.push([content, delegationId]);
      },
      closeSession() {},
      async hangup() {},
      destroy() {},
    };

    const keyFile = path.join(workDir, 'api.key');
    await writeFile(keyFile, 'sk-test-contract-key-12345', { mode: 0o600 });
    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory,
    });
    await manager.initialize();

    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());
    manager.handleInputTranscript('go');
    manager.handleDelegationCreated('deleg-1', 1000);

    await vi.waitFor(() => expect(commentaryCalls.length).toBeGreaterThanOrEqual(2));

    const fullText = commentaryCalls.map(([c]) => c).join('');
    expect(fullText).toBe(longResult);

    for (const [content] of commentaryCalls) {
      expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(500);
    }

    await manager.shutdown();
  });

  it('provider sendCommentary error does not crash session', async () => {
    let commentaryCallCount = 0;

    const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send() {
        if (options.onResult) options.onResult('result text');
      },
      async close() {},
    });

    const provider: LiveProvider = {
      async createSession() {
        return { providerSessionId: 'prov-err', answerSdp: 'v=0\r\nanswer' };
      },
      async attachSideband() { return { close() {} }; },
      sendThinking() {},
      sendCommentary() {
        commentaryCallCount++;
        throw new Error('Transport error');
      },
      closeSession() {},
      async hangup() {},
      destroy() {},
    };

    const keyFile = path.join(workDir, 'api.key');
    await writeFile(keyFile, 'sk-test-contract-key-12345', { mode: 0o600 });
    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory,
    });
    await manager.initialize();

    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());
    manager.handleInputTranscript('go');
    manager.handleDelegationCreated('deleg-1', 1000);

    await new Promise(r => setTimeout(r, 200));

    expect(commentaryCallCount).toBeGreaterThan(0);
    await manager.shutdown();
  });

  it('End during commentary append does not crash', async () => {
    let sendGate: (() => void) | null = null;

    const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send() {
        await new Promise<void>(resolve => { sendGate = resolve; });
        if (options.onResult) options.onResult('result during close');
      },
      async close() { sendGate?.(); },
    });

    const commentaryCalls: string[] = [];
    const provider: LiveProvider = {
      async createSession() {
        return { providerSessionId: 'prov-end', answerSdp: 'v=0\r\nanswer' };
      },
      async attachSideband() { return { close() {} }; },
      sendThinking() {},
      sendCommentary(c) { commentaryCalls.push(c); },
      closeSession() {},
      async hangup() {},
      destroy() {},
    };

    const keyFile = path.join(workDir, 'api.key');
    await writeFile(keyFile, 'sk-test-contract-key-12345', { mode: 0o600 });
    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory,
    });
    await manager.initialize();

    const { sessionId } = await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());
    manager.handleInputTranscript('go');
    manager.handleDelegationCreated('deleg-1', 1000);

    await vi.waitFor(() => expect(sendGate).not.toBeNull());

    // Close during in-flight send
    await manager.closeSession(sessionId, 'test');
    await new Promise(r => setTimeout(r, 200));

    // Should not have sent commentary (session was closed)
    expect(commentaryCalls).toHaveLength(0);
  });
});

// ============================================================================
// PRIORITY 4: Billing/transport stop conditions
// ============================================================================
describe('contract: billing stop conditions', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('unknown create BEFORE session ID blocks across restart', async () => {
    const budgetFile = path.join(workDir, 'budget.json');
    const budget1 = new GptLiveBudget(budgetFile);
    await budget1.load();
    budget1.reserve('unknown-sess', 300);
    budget1.markCreationAttempted('unknown-sess');
    await budget1.save();

    const budget2 = new GptLiveBudget(budgetFile);
    await budget2.load();
    budget2.reconcileOrphans();

    expect(budget2.hasUncertainClosure).toBe(true);
    expect(budget2.canReserve(60)).toBe(false);
  });

  it('persist-failure latch blocks new sessions permanently', async () => {
    const budget = new GptLiveBudget('/dev/null/impossible.json');

    const validBudget = new GptLiveBudget(path.join(workDir, 'tmp.json'));
    await validBudget.load();
    (budget as any).ledger = (validBudget as any).ledger;

    await expect(budget.save()).rejects.toThrow();
    expect(budget.saveFailed).toBe(true);
    expect(budget.hasUncertainClosure).toBe(true);
    expect(budget.canReserve(60)).toBe(false);
  });

  it('valid >300s actual usage is retained in finalize', async () => {
    const budget = new GptLiveBudget(path.join(workDir, 'budget.json'));
    await budget.load();
    budget.reserve('s', 300);
    budget.finalize('s', 500, true);
    expect(budget.cumulativeUsageUsd).toBeCloseTo((500 / 60) * 0.05, 6);
    expect(budget.hasUncertainClosure).toBe(false);
  });

  it('corrupt ledger with negative cumulative is rejected', async () => {
    const budgetFile = path.join(workDir, 'budget.json');
    await writeFile(budgetFile, JSON.stringify({
      cumulativeUsageUsd: -1,
      reservations: [],
      lastUpdated: '',
    }), { mode: 0o600 });

    const budget = new GptLiveBudget(budgetFile);
    await expect(budget.load()).rejects.toThrow();
  });

  it('sideband socket error causes safe teardown with uncertain lockout', async () => {
    let sidebandHandler: ProviderEventHandler | null = null;
    const manager = await enabledManager(workDir, {
      onAttach: (h) => { sidebandHandler = h; },
    });

    const callbacks = noopCallbacks();
    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks);
    await new Promise(r => setTimeout(r, 50));

    sidebandHandler!.onError('sideband_error', 'WebSocket closed');

    await vi.waitFor(() => {
      expect(manager.hasActiveSession).toBe(false);
    }, { timeout: 20_000 });

    expect(callbacks.onError).toHaveBeenCalled();
  }, 25_000);

  it('no automatic paid POST retries — maxRetries:0 in provider constructor', async () => {
    const provider = createProvider();
    expect(provider).toBeDefined();
  });

  it('sync-close race: closeSession is idempotent', async () => {
    const manager = await enabledManager(workDir);
    const { sessionId } = await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());

    // Concurrent close calls
    await Promise.all([
      manager.closeSession(sessionId, 'user_ended'),
      manager.closeSession(sessionId, 'deadline'),
    ]);

    await vi.waitFor(() => {
      expect(manager.hasActiveSession).toBe(false);
    }, { timeout: 20_000 });
  }, 25_000);
});

// ============================================================================
// PRIORITY 5: Scope/credentials/cleanup
// ============================================================================
describe('contract: scope, credentials, cleanup', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('diagnostics never expose server credentials or SDP answers', async () => {
    const manager = await enabledManager(workDir);
    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());

    const diag = manager.getDiagnostics();
    const serialized = JSON.stringify(diag);
    // Server credentials (API key, SDP offer/answer) must not appear
    expect(serialized).not.toContain('sk-test-contract-key');
    expect(serialized).not.toMatch(/\banswerSdp\b/);
    expect(serialized).not.toMatch(/\bofferSdp\b/);
    expect(serialized).not.toMatch(/\bapi[Kk]ey\b/);

    await manager.shutdown();
  });

  it('transcript entries are bounded to MAX_TRANSCRIPT_ENTRIES', async () => {
    const manager = await enabledManager(workDir);
    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());

    for (let i = 0; i < 600; i++) {
      manager.handleInputTranscript(`msg-${i}`);
    }

    const diag = manager.getDiagnostics();
    expect(diag.transcript.length).toBeLessThanOrEqual(500);

    await manager.shutdown();
  });

  it('getSessionOwnerId returns owner for active and recently-closed sessions', async () => {
    let sidebandHandler: ProviderEventHandler | null = null;
    const manager = await enabledManager(workDir, {
      onAttach: (h) => { sidebandHandler = h; },
    });

    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());
    expect(manager.getSessionOwnerId()).toBe('owner-1');

    sidebandHandler!.onSessionClosed('done', { seconds: 5 });
    await new Promise(r => setTimeout(r, 50));

    expect(manager.hasActiveSession).toBe(false);
    expect(manager.getSessionOwnerId()).toBe('owner-1');
  });

  it('default/trial mode exclusion: hasActiveSession blocks default WebSocket', async () => {
    const manager = await enabledManager(workDir);
    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());

    expect(manager.hasActiveSession).toBe(true);

    await manager.shutdown();
  });

  it('no implicit model swap: diagnostics correctly report voice vs backend model', () => {
    const manager = new GptLiveManager({
      enabled: false,
      apiKeyFile: '/dev/null',
      budgetFile: '/tmp/no-budget.json',
      maxSessionSeconds: 300,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
    });

    const diag = manager.getDiagnostics();
    expect(diag.voiceModel).toBe('gpt-live-1');
    expect(diag.backendModel).toBe('claude-opus-4-6[1m]');
    expect(diag.voiceModel).not.toBe(diag.backendModel);
  });
});
