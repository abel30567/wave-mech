import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { GptLiveManager, type GptLiveSessionCallbacks, type HarnessFactory } from './session.js';
import { GptLiveBudget } from './budget.js';
import type { LiveProvider, ProviderEventHandler } from './provider.js';
import type { HarnessSession, HarnessOptions } from '../../shared/contracts.js';

function createMockHarnessFactory(): HarnessFactory {
  return (options: HarnessOptions): HarnessSession => {
    let started = false;
    return {
      async start() {
        started = true;
        options.onEvent({ type: 'ready' });
      },
      async send(text: string) {
        if (!started) throw new Error('Not started');
        options.onEvent({ type: 'text', text: `Response to: ${text}` });
        if (options.onResult) options.onResult(`Response to: ${text}`);
      },
      async close() { started = false; },
    };
  };
}

function tmpDir(): string {
  return path.join(tmpdir(), `wave-live-lifecycle-${randomBytes(4).toString('hex')}`);
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

function createSimpleProvider(options?: {
  sessionId?: string;
  answerSdp?: string;
  onAttachSideband?: (handler: ProviderEventHandler) => void;
}): LiveProvider {
  return {
    async createSession() {
      return {
        providerSessionId: options?.sessionId ?? 'prov-lifecycle',
        answerSdp: options?.answerSdp ?? 'v=0\r\nlifecycle-answer',
      };
    },
    async attachSideband(_sid, handler) {
      options?.onAttachSideband?.(handler);
      return { close() {} };
    },
    sendThinking() {},
    sendCommentary() {},
    closeSession() {},
    async hangup() {},
    destroy() {},
  };
}

async function createEnabledManager(workDir: string, providerOpts?: Parameters<typeof createSimpleProvider>[0]) {
  const keyFile = path.join(workDir, 'test-api.key');
  await writeFile(keyFile, 'sk-test-key-12345-abcdefg', { mode: 0o600 });
  const manager = new GptLiveManager({
    enabled: true,
    apiKeyFile: keyFile,
    budgetFile: path.join(workDir, 'budget.json'),
    maxSessionSeconds: 60,
    configuredModel: 'claude-opus-4-6[1m]',
    nodeExecutable: process.execPath,
    providerFactory: () => createSimpleProvider(providerOpts),
    harnessFactory: createMockHarnessFactory(),
  });
  await manager.initialize();
  return manager;
}

describe('GptLive lifecycle and race conditions', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('rejects concurrent session creation from different owners', async () => {
    const manager = await createEnabledManager(workDir);
    const callbacks = noopCallbacks();

    const error1 = manager.validateSessionRequest('owner-1', 'v=0\r\n');
    expect(error1).toBeNull();

    const error2 = manager.validateSessionRequest('owner-2', 'v=0\r\n');
    expect(error2).toBeNull();
  });

  it('closeSession is idempotent', async () => {
    const manager = await createEnabledManager(workDir);
    await manager.closeSession('non-existent', 'test');
    await manager.closeSession('non-existent', 'test');
    expect(manager.hasActiveSession).toBe(false);
  });

  it('shutdown cleans up active session', async () => {
    const manager = await createEnabledManager(workDir);
    await manager.shutdown();
    expect(manager.hasActiveSession).toBe(false);
  });

  it('transcript entries accumulate correctly', async () => {
    const manager = await createEnabledManager(workDir);
    manager.handleInputTranscript('hello');
    manager.handleInputTranscript('world');
    manager.handleOutputTranscript('hi there');

    const diagnostics = manager.getDiagnostics();
    expect(diagnostics.transcript).toHaveLength(0);
  });

  it('handles usage updates when no session is active', () => {
    const manager = new GptLiveManager({
      enabled: false,
      apiKeyFile: '/dev/null',
      budgetFile: '/tmp/no-budget.json',
      maxSessionSeconds: 300,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
    });
    manager.handleUsageUpdate(120);
    expect(manager.getDiagnostics().cumulativeVoiceSeconds).toBe(0);
  });

  it('forces delegation to client type', () => {
    const diagnostics = new GptLiveManager({
      enabled: false,
      apiKeyFile: '/dev/null',
      budgetFile: '/tmp/no-budget.json',
      maxSessionSeconds: 300,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
    }).getDiagnostics();
    expect(diagnostics.backendModel).toBe('claude-opus-4-6[1m]');
    expect(diagnostics.voiceModel).toBe('gpt-live-1');
  });

  it('budget persists reservation atomically with 0600 permissions', async () => {
    const budgetFile = path.join(workDir, 'atomic-budget.json');
    const budget = new GptLiveBudget(budgetFile);
    await budget.load();

    budget.reserve('session-1', 120);
    await budget.save();

    const { stat } = await import('node:fs/promises');
    const info = await stat(budgetFile);
    expect(info.mode & 0o777).toBe(0o600);

    const content = JSON.parse(await readFile(budgetFile, 'utf8'));
    expect(content.reservations).toHaveLength(1);
    expect(content.reservations[0].sessionId).toBe('session-1');
  });

  it('reconciles orphaned reservations before allowing new sessions', async () => {
    const budgetFile = path.join(workDir, 'orphan-budget.json');
    const budget1 = new GptLiveBudget(budgetFile, 0.50);
    await budget1.load();
    budget1.reserve('orphan-1', 600);
    await budget1.save();

    const budget2 = new GptLiveBudget(budgetFile, 0.50);
    await budget2.load();
    const orphans = budget2.reconcileOrphans();
    expect(orphans).toBe(1);
    expect(budget2.remainingUsd).toBe(0);
    expect(budget2.canReserve(60)).toBe(false);
  });

  it('locks out new sessions when finalization is uncertain', async () => {
    const budgetFile = path.join(workDir, 'uncertain-budget.json');
    const budget = new GptLiveBudget(budgetFile, 0.50);
    await budget.load();

    budget.reserve('sess-uncertain', 300);
    budget.finalize('sess-uncertain', 60, false);
    await budget.save();

    expect(budget.cumulativeUsageUsd).toBeCloseTo(0.25, 4);
    expect(budget.hasUncertainClosure).toBe(true);
    expect(budget.canReserve(300)).toBe(false);
    expect(budget.remainingUsd).toBe(0);
  });

  it('provider factory receives the loaded API key', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-unique-api-key', { mode: 0o600 });

    let receivedKey: string | null = null;
    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      harnessFactory: createMockHarnessFactory(),
      providerFactory: (key) => {
        receivedKey = key;
        return createSimpleProvider();
      },
    });
    await manager.initialize();

    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());
    expect(receivedKey).toBe('sk-test-unique-api-key');
    await manager.shutdown();
  });

  it('provider session.closed event confirms closure with final usage', async () => {
    let sidebandHandler: ProviderEventHandler | null = null;
    const manager = await createEnabledManager(workDir, {
      onAttachSideband: (handler) => { sidebandHandler = handler; },
    });

    const callbacks = noopCallbacks();
    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks);

    await new Promise(resolve => setTimeout(resolve, 50));

    sidebandHandler!.onSessionClosed('close_requested', { seconds: 42.5 });
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(manager.hasActiveSession).toBe(false);
    expect(callbacks.onSessionClosed).toHaveBeenCalledWith('close_requested', true);
  });
});

describe('GptLive hasActiveSession covers startup slot', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('hasActiveSession returns true during slow provider creation', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdef', { mode: 0o600 });

    const gate = { resolve: null as (() => void) | null };
    const slowProvider: LiveProvider = {
      async createSession() {
        await new Promise<void>(resolve => { gate.resolve = resolve; });
        return { providerSessionId: 'prov-1', answerSdp: 'v=0\r\nanswer' };
      },
      async attachSideband() { return { close() {} }; },
      sendThinking() {},
      sendCommentary() {},
      closeSession() {},
      async hangup() {},
      destroy() {},
    };

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => slowProvider,
      harnessFactory: createMockHarnessFactory(),
    });
    await manager.initialize();

    const p = manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(manager.hasActiveSession).toBe(true);

    gate.resolve?.();
    await p;
    await manager.shutdown();
  });
});

describe('GptLive final result and delegation', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('sends final result as commentary (not preamble text)', async () => {
    let sidebandHandler: ProviderEventHandler | null = null;
    const commentaryCalls: [string, string | null][] = [];
    const thinkingCalls: [string, string | null][] = [];

    const provider: LiveProvider = {
      async createSession() {
        return { providerSessionId: 'prov-result', answerSdp: 'v=0\r\nanswer' };
      },
      async attachSideband(_sid, handler) {
        sidebandHandler = handler;
        return { close() {} };
      },
      sendThinking(content, delegationId) {
        thinkingCalls.push([content, delegationId]);
      },
      sendCommentary(content, delegationId) {
        commentaryCalls.push([content, delegationId]);
      },
      closeSession() {},
      async hangup() {},
      destroy() {},
    };

    const resultFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => {
      let started = false;
      return {
        async start() { started = true; options.onEvent({ type: 'ready' }); },
        async send(text: string) {
          options.onEvent({ type: 'text', text: 'Let me check...' });
          options.onEvent({ type: 'tool', name: 'WebSearch', status: 'running' });
          options.onEvent({ type: 'tool', name: 'WebSearch', status: 'done' });
          options.onEvent({ type: 'text', text: 'The final answer is 42.' });
          if (options.onResult) options.onResult('The final answer is 42.');
        },
        async close() { started = false; },
      };
    };

    const manager = await createEnabledManager(workDir, {
      onAttachSideband: (handler) => { sidebandHandler = handler; },
    });
    // Replace manager with one using our custom factories
    const keyFile = path.join(workDir, 'test-api2.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdefgh', { mode: 0o600 });
    const customManager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget-result.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory: resultFactory,
    });
    await customManager.initialize();

    const callbacks = noopCallbacks();
    await customManager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks);

    await new Promise(resolve => setTimeout(resolve, 50));

    customManager.handleInputTranscript('What is the answer?');
    customManager.handleDelegationCreated('deleg-result-1', 1000);

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(commentaryCalls.length).toBeGreaterThanOrEqual(1);
    const lastCommentary = commentaryCalls[commentaryCalls.length - 1];
    expect(lastCommentary[0]).toContain('The final answer is 42.');
    expect(lastCommentary[0]).not.toContain('Let me check');

    await customManager.shutdown();
  });

  it('does not discard delegation when transcript arrives late', async () => {
    const provider: LiveProvider = {
      async createSession() {
        return { providerSessionId: 'prov-late', answerSdp: 'v=0\r\nanswer' };
      },
      async attachSideband() { return { close() {} }; },
      sendThinking() {},
      sendCommentary() {},
      closeSession() {},
      async hangup() {},
      destroy() {},
    };

    let sendCalled = false;
    const waitingFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send(text: string) {
        sendCalled = true;
        if (options.onResult) options.onResult(`Got: ${text}`);
      },
      async close() {},
    });

    const keyFile = path.join(workDir, 'test-api3.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdefghi', { mode: 0o600 });
    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget-late.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory: waitingFactory,
    });
    await manager.initialize();

    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());

    // Delegation arrives before any transcript
    manager.handleDelegationCreated('deleg-late-1', 500);
    await new Promise(resolve => setTimeout(resolve, 100));

    // Now transcript arrives
    manager.handleInputTranscript('Do something');
    await new Promise(resolve => setTimeout(resolve, 600));

    expect(sendCalled).toBe(true);
    await manager.shutdown();
  });
});

describe('GptLive budget lockout across restart', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('reproduces the fail-closed regression: reserve/finalize(unconfirmed)/reload blocks new sessions', async () => {
    const budgetFile = path.join(workDir, 'regression-budget.json');

    const budget1 = new GptLiveBudget(budgetFile);
    await budget1.load();
    budget1.reserve('s', 300);
    budget1.setProviderSessionId('s', 'p');
    budget1.finalize('s', 0, false);
    await budget1.save();

    const budget2 = new GptLiveBudget(budgetFile);
    await budget2.load();
    budget2.reconcileOrphans();

    expect(budget2.canReserve(300)).toBe(false);
    expect(budget2.hasUncertainClosure).toBe(true);
  });

  it('unfinalized orphan also blocks new sessions after reconciliation', async () => {
    const budgetFile = path.join(workDir, 'orphan-regression.json');

    const budget1 = new GptLiveBudget(budgetFile);
    await budget1.load();
    budget1.reserve('orphan', 300);
    await budget1.save();

    const budget2 = new GptLiveBudget(budgetFile);
    await budget2.load();
    budget2.reconcileOrphans();

    expect(budget2.canReserve(60)).toBe(false);
    expect(budget2.hasUncertainClosure).toBe(true);
  });

  it('confirmClosure resolves lockout after authentic session.closed', async () => {
    const budgetFile = path.join(workDir, 'confirm-regression.json');

    const budget = new GptLiveBudget(budgetFile);
    await budget.load();
    budget.reserve('s', 300);
    budget.setProviderSessionId('s', 'p');
    budget.finalize('s', 0, false);
    await budget.save();

    expect(budget.canReserve(300)).toBe(false);

    budget.confirmClosure('s', 42);
    expect(budget.canReserve(300)).toBe(true);
    expect(budget.hasUncertainClosure).toBe(false);
  });
});

describe('GptLive privacy and diagnostics', () => {
  it('diagnostics exclude SDP and ICE credentials', () => {
    const manager = new GptLiveManager({
      enabled: false,
      apiKeyFile: '/dev/null',
      budgetFile: '/tmp/no-budget.json',
      maxSessionSeconds: 300,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
    });
    const diagnostics = manager.getDiagnostics();
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toMatch(/\bsdp\b/i);
    expect(serialized).not.toMatch(/\bcandidate\b/i);
    expect(serialized).not.toMatch(/\bpassword\b/i);
    expect(serialized).not.toMatch(/\bsecret\b/i);
    expect(serialized).not.toContain('sk-');
  });

  it('transcript redacts credentials in diagnostic text', () => {
    const manager = new GptLiveManager({
      enabled: false,
      apiKeyFile: '/dev/null',
      budgetFile: '/tmp/no-budget.json',
      maxSessionSeconds: 300,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
    });
    const diagnostics = manager.getDiagnostics();
    expect(diagnostics.transcript).toEqual([]);
    expect(diagnostics.sessionId).toBeNull();
  });

  it('correctly distinguishes voice model from backend model', () => {
    const manager = new GptLiveManager({
      enabled: false,
      apiKeyFile: '/dev/null',
      budgetFile: '/tmp/no-budget.json',
      maxSessionSeconds: 300,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
    });
    const diagnostics = manager.getDiagnostics();
    expect(diagnostics.voiceModel).not.toBe(diagnostics.backendModel);
    expect(diagnostics.voiceModel).toBe('gpt-live-1');
    expect(diagnostics.backendModel).toBe('claude-opus-4-6[1m]');
  });
});
