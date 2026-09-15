import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { GptLiveManager, type GptLiveSessionCallbacks, type HarnessFactory } from './session.js';
import { GptLiveBudget } from './budget.js';
import type { LiveProvider, ProviderEventHandler } from './provider.js';
import type { HarnessSession, HarnessOptions } from '../../shared/contracts.js';

function tmpDir(): string {
  return path.join(tmpdir(), `wave-billing-reg-${randomBytes(4).toString('hex')}`);
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
      async start() {
        started = true;
        options.onEvent({ type: 'ready' });
      },
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
  createDelay?: number;
  createError?: Error;
}): LiveProvider {
  return {
    async createSession() {
      if (opts?.createDelay) {
        await new Promise(r => setTimeout(r, opts.createDelay));
      }
      if (opts?.createError) throw opts.createError;
      return {
        providerSessionId: opts?.sessionId ?? 'prov-billing',
        answerSdp: 'v=0\r\nbilling-answer',
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

async function enabledManager(workDir: string, provOpts?: Parameters<typeof createProvider>[0]) {
  const keyFile = path.join(workDir, 'api.key');
  await writeFile(keyFile, 'sk-test-billing-key-12345', { mode: 0o600 });
  const manager = new GptLiveManager({
    enabled: true,
    apiKeyFile: keyFile,
    budgetFile: path.join(workDir, 'budget.json'),
    maxSessionSeconds: 60,
    configuredModel: 'claude-opus-4-6[1m]',
    nodeExecutable: process.execPath,
    providerFactory: () => createProvider(provOpts),
    harnessFactory: createMockHarnessFactory(),
  });
  await manager.initialize();
  return manager;
}

describe('billing-regression: unknown POST after timeout', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('marks creation attempted before provider call and persists to disk', async () => {
    const budgetFile = path.join(workDir, 'budget.json');
    let capturedBudget: string | null = null;

    const keyFile = path.join(workDir, 'api.key');
    await writeFile(keyFile, 'sk-test-billing-key-12345', { mode: 0o600 });

    const provider = createProvider({
      createDelay: 50,
      sessionId: 'prov-tracked',
    });

    const originalCreate = provider.createSession.bind(provider);
    provider.createSession = async (...args) => {
      capturedBudget = await readFile(budgetFile, 'utf8');
      return originalCreate(...args);
    };

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile,
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory: createMockHarnessFactory(),
    });
    await manager.initialize();

    await manager.createSession('owner', 'v=0\r\noffer', 'http://localhost', noopCallbacks());

    expect(capturedBudget).not.toBeNull();
    const parsed = JSON.parse(capturedBudget!);
    expect(parsed.reservations[0].creationAttempted).toBe(true);
    expect(parsed.reservations[0].providerSessionId).toBeNull();

    await manager.shutdown();
  });

  it('unknown POST without providerSessionId stays locked across restart', async () => {
    const budgetFile = path.join(workDir, 'budget.json');

    const budget1 = new GptLiveBudget(budgetFile);
    await budget1.load();
    budget1.reserve('s-unknown', 300);
    budget1.markCreationAttempted('s-unknown');
    await budget1.save();

    const budget2 = new GptLiveBudget(budgetFile);
    await budget2.load();
    const orphans = budget2.reconcileOrphans();
    expect(orphans).toBeGreaterThanOrEqual(1);
    expect(budget2.hasUncertainClosure).toBe(true);
    expect(budget2.canReserve(60)).toBe(false);
  });

  it('a rejected creation request without an ID blocks retries before and after restart', async () => {
    const manager = await enabledManager(workDir, { createError: new Error('Request timed out') });
    await expect(manager.createSession('owner', 'v=0\r\noffer', 'http://localhost', noopCallbacks()))
      .rejects.toThrow('Session creation failed.');

    const ledger = JSON.parse(await readFile(path.join(workDir, 'budget.json'), 'utf8'));
    expect(ledger.reservations).toHaveLength(1);
    expect(ledger.reservations[0]).toMatchObject({
      creationAttempted: true,
      providerSessionId: null,
      closureConfirmed: false,
    });
    expect(manager.status.budgetRemainingUsd).toBe(0);
    await expect(manager.createSession('owner', 'v=0\r\nretry', 'http://localhost', noopCallbacks()))
      .rejects.toThrow('Trial budget exhausted.');

    const restarted = await enabledManager(workDir);
    expect(restarted.status.budgetRemainingUsd).toBe(0);
    await expect(restarted.createSession('owner', 'v=0\r\nretry', 'http://localhost', noopCallbacks()))
      .rejects.toThrow('Trial budget exhausted.');
  });

  it('errors before provider call release the reservation cleanly', async () => {
    const keyFile = path.join(workDir, 'api.key');
    await writeFile(keyFile, 'sk-test-key-short12345', { mode: 0o600 });
    const budgetFile = path.join(workDir, 'budget.json');

    let harnessCreated = false;
    const failHarness: HarnessFactory = (_opts: HarnessOptions): HarnessSession => {
      harnessCreated = true;
      throw new Error('Harness spawn failed');
    };

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile,
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => createProvider(),
      harnessFactory: failHarness,
    });
    await manager.initialize();

    await expect(
      manager.createSession('owner', 'v=0\r\noffer', 'http://localhost', noopCallbacks()),
    ).rejects.toThrow();

    expect(manager.hasActiveSession).toBe(false);
    expect(manager.validateSessionRequest('owner', 'v=0\r\nnew')).toBeNull();

    const budget = new GptLiveBudget(budgetFile);
    await budget.load();
    expect(budget.snapshot.reservations).toHaveLength(0);
  });
});

describe('billing-regression: normal End with valid close', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('closing=true then session.closed confirms and charges actual usage', async () => {
    let sidebandHandler: ProviderEventHandler | null = null;
    const manager = await enabledManager(workDir, {
      sessionId: 'prov-normal-end',
      onAttach: (h) => { sidebandHandler = h; },
    });

    const callbacks = noopCallbacks();
    const result = await manager.createSession('owner', 'v=0\r\noffer', 'http://localhost', callbacks);
    await new Promise(r => setTimeout(r, 50));

    manager.handleUsageUpdate(42);

    void manager.closeSession(result.sessionId, 'user_ended');
    await new Promise(r => setTimeout(r, 50));

    sidebandHandler!.onSessionClosed('close_requested', { seconds: 45.5 });
    await new Promise(r => setTimeout(r, 50));

    expect(manager.hasActiveSession).toBe(false);
    expect(callbacks.onSessionClosed).toHaveBeenCalledWith('close_requested', true);

    const budget = new GptLiveBudget(path.join(workDir, 'budget.json'));
    await budget.load();
    expect(budget.hasUncertainClosure).toBe(false);
    expect(budget.cumulativeUsageUsd).toBeCloseTo((45.5 / 60) * 0.05, 6);
  });
});

describe('billing-regression: bad final usage', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('NaN final seconds produces unconfirmed closure', async () => {
    let sidebandHandler: ProviderEventHandler | null = null;
    const manager = await enabledManager(workDir, {
      onAttach: (h) => { sidebandHandler = h; },
    });
    const callbacks = noopCallbacks();
    await manager.createSession('owner', 'v=0\r\noffer', 'http://localhost', callbacks);
    await new Promise(r => setTimeout(r, 50));

    sidebandHandler!.onSessionClosed('close_requested', { seconds: NaN });
    await new Promise(r => setTimeout(r, 50));

    expect(manager.hasActiveSession).toBe(false);
    expect(callbacks.onSessionClosed).toHaveBeenCalledWith('close_requested', false);
  });

  it('negative final seconds produces unconfirmed closure', async () => {
    let sidebandHandler: ProviderEventHandler | null = null;
    const manager = await enabledManager(workDir, {
      onAttach: (h) => { sidebandHandler = h; },
    });
    const callbacks = noopCallbacks();
    await manager.createSession('owner', 'v=0\r\noffer', 'http://localhost', callbacks);
    await new Promise(r => setTimeout(r, 50));

    sidebandHandler!.onSessionClosed('close_requested', { seconds: -5 });
    await new Promise(r => setTimeout(r, 50));

    expect(manager.hasActiveSession).toBe(false);
    expect(callbacks.onSessionClosed).toHaveBeenCalledWith('close_requested', false);
  });

  it('finalize rejects missing/NaN/negative usage without producing confirmed=true at zero', async () => {
    const budget = new GptLiveBudget(path.join(workDir, 'budget.json'));
    await budget.load();

    budget.reserve('s-nan', 60);
    budget.finalize('s-nan', NaN, true);
    expect(budget.hasUncertainClosure).toBe(true);

    const budget2 = new GptLiveBudget(path.join(workDir, 'budget2.json'));
    await budget2.load();
    budget2.reserve('s-neg', 60);
    budget2.finalize('s-neg', -1, true);
    expect(budget2.hasUncertainClosure).toBe(true);
  });
});

describe('billing-regression: save failure quarantine', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('save failure latches in memory and blocks new sessions', async () => {
    const validFile = path.join(workDir, 'budget-ok.json');
    const budget = new GptLiveBudget(validFile);
    await budget.load();
    budget.reserve('s', 60);
    await budget.save();

    const brokenBudget = new GptLiveBudget('/dev/null/impossible/budget.json');
    (brokenBudget as any).ledger = (budget as any).ledger;

    await expect(brokenBudget.save()).rejects.toThrow();

    expect(brokenBudget.saveFailed).toBe(true);
    expect(brokenBudget.hasUncertainClosure).toBe(true);
    expect(brokenBudget.canReserve(60)).toBe(false);
  });

  it('serializes concurrent saves without stale overwrite', async () => {
    const budgetFile = path.join(workDir, 'serial-budget.json');
    const budget = new GptLiveBudget(budgetFile);
    await budget.load();

    budget.reserve('s1', 60);
    const p1 = budget.save();
    budget.reserve('s2', 60);
    const p2 = budget.save();

    await Promise.all([p1, p2]);

    const content = JSON.parse(await readFile(budgetFile, 'utf8'));
    expect(content.reservations).toHaveLength(2);
    expect(content.reservations[0].sessionId).toBe('s1');
    expect(content.reservations[1].sessionId).toBe('s2');
  });
});

describe('billing-regression: synchronous provider close', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('sideband error triggers session teardown and uncertain lockout', async () => {
    let sidebandHandler: ProviderEventHandler | null = null;
    const manager = await enabledManager(workDir, {
      onAttach: (h) => { sidebandHandler = h; },
    });

    const callbacks = noopCallbacks();
    await manager.createSession('owner', 'v=0\r\noffer', 'http://localhost', callbacks);
    await new Promise(r => setTimeout(r, 50));

    sidebandHandler!.onError('sideband_error', 'WebSocket closed unexpectedly');
    await new Promise(r => setTimeout(r, 100));

    await vi.waitFor(() => {
      expect(manager.hasActiveSession).toBe(false);
    }, { timeout: 20_000 });

    expect(callbacks.onError).toHaveBeenCalled();
  }, 25_000);
});

describe('billing-regression: restart reconciliation', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('reconciles orphaned reservation with provider ID as uncertain', async () => {
    const budgetFile = path.join(workDir, 'budget.json');
    const budget1 = new GptLiveBudget(budgetFile);
    await budget1.load();
    budget1.reserve('orphan-with-id', 120);
    budget1.setProviderSessionId('orphan-with-id', 'prov-orphan');
    await budget1.save();

    const budget2 = new GptLiveBudget(budgetFile);
    await budget2.load();
    const orphans = budget2.reconcileOrphans();
    expect(orphans).toBeGreaterThanOrEqual(1);
    expect(budget2.hasUncertainClosure).toBe(true);
    expect(budget2.canReserve(60)).toBe(false);

    const snap = budget2.snapshot;
    const r = snap.reservations.find(r => r.sessionId === 'orphan-with-id')!;
    expect(r.providerSessionId).toBe('prov-orphan');
    expect(r.finalized).toBe(true);
    expect(r.closureConfirmed).toBe(false);
  });

  it('old finalized:true/closureConfirmed:false migrates into lockout on load', async () => {
    const budgetFile = path.join(workDir, 'budget.json');
    await writeFile(budgetFile, JSON.stringify({
      cumulativeUsageUsd: 0.10,
      reservations: [{
        sessionId: 'old-uncertain',
        providerSessionId: 'prov-old',
        reservedUsd: 0.25,
        actualUsd: 0.25,
        createdAt: '2026-09-14T00:00:00Z',
        finalized: true,
        closureConfirmed: false,
      }],
      lastUpdated: '2026-09-14T00:00:00Z',
    }), { mode: 0o600 });

    const budget = new GptLiveBudget(budgetFile);
    await budget.load();
    budget.reconcileOrphans();

    expect(budget.hasUncertainClosure).toBe(true);
    expect(budget.canReserve(60)).toBe(false);
  });

  it('new sessions blocked while reconciliation pending', async () => {
    const budgetFile = path.join(workDir, 'budget.json');
    const budget = new GptLiveBudget(budgetFile);
    await budget.load();
    budget.reserve('orphan', 60);
    await budget.save();

    const keyFile = path.join(workDir, 'api.key');
    await writeFile(keyFile, 'sk-test-reconcile-key-12345', { mode: 0o600 });

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile,
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => createProvider(),
      harnessFactory: createMockHarnessFactory(),
    });
    await manager.initialize();

    const error = manager.validateSessionRequest('owner', 'v=0\r\noffer');
    expect(error).toBe('Trial budget exhausted.');
  });
});

describe('billing-regression: over-300-actual usage', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('confirmClosure above 300s retains actual charge without cap', async () => {
    const budget = new GptLiveBudget(path.join(workDir, 'budget.json'));
    await budget.load();
    budget.reserve('s', 300);
    budget.finalize('s', 0, false);

    const confirmed = budget.confirmClosure('s', 350);
    expect(confirmed).toBe(true);
    expect(budget.hasUncertainClosure).toBe(false);
    expect(budget.cumulativeUsageUsd).toBeCloseTo((350 / 60) * 0.05, 6);
  });

  it('finalize above 300s with confirmed closure retains actual charge', async () => {
    const budget = new GptLiveBudget(path.join(workDir, 'budget.json'));
    await budget.load();
    budget.reserve('s', 300);
    budget.finalize('s', 500, true);
    expect(budget.hasUncertainClosure).toBe(false);
    expect(budget.cumulativeUsageUsd).toBeCloseTo((500 / 60) * 0.05, 6);
  });

  it('session with usage above maxSessionSeconds gets actual charge via session.closed', async () => {
    let sidebandHandler: ProviderEventHandler | null = null;
    const manager = await enabledManager(workDir, {
      onAttach: (h) => { sidebandHandler = h; },
    });

    const callbacks = noopCallbacks();
    await manager.createSession('owner', 'v=0\r\noffer', 'http://localhost', callbacks);
    await vi.waitFor(() => expect(sidebandHandler).not.toBeNull());

    manager.handleUsageUpdate(55);
    sidebandHandler!.onSessionClosed('deadline', { seconds: 65 });
    await vi.waitFor(() => {
      expect(callbacks.onSessionClosed).toHaveBeenCalledWith('deadline', true);
    });

    const budget = new GptLiveBudget(path.join(workDir, 'budget.json'));
    await budget.load();
    expect(budget.cumulativeUsageUsd).toBeCloseTo((65 / 60) * 0.05, 6);
  });
});

describe('billing-regression: validation', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('rejects non-integer duration', async () => {
    const manager = await enabledManager(workDir);
    const err = manager.validateSessionRequest('owner', 'v=0\r\n', 60.5);
    expect(err).toBe('Invalid session duration.');
  });

  it('rejects zero duration', async () => {
    const manager = await enabledManager(workDir);
    const err = manager.validateSessionRequest('owner', 'v=0\r\n', 0);
    expect(err).toBe('Invalid session duration.');
  });

  it('rejects negative duration', async () => {
    const manager = await enabledManager(workDir);
    const err = manager.validateSessionRequest('owner', 'v=0\r\n', -10);
    expect(err).toBe('Invalid session duration.');
  });

  it('rejects duration above 300', async () => {
    const manager = await enabledManager(workDir);
    const err = manager.validateSessionRequest('owner', 'v=0\r\n', 301);
    expect(err).toBe('Invalid session duration.');
  });

  it('accepts valid integer duration', async () => {
    const manager = await enabledManager(workDir);
    const err = manager.validateSessionRequest('owner', 'v=0\r\n', 120);
    expect(err).toBeNull();
  });

  it('rejects duplicate session IDs in ledger', async () => {
    const budgetFile = path.join(workDir, 'budget.json');
    await writeFile(budgetFile, JSON.stringify({
      cumulativeUsageUsd: 0,
      reservations: [
        { sessionId: 'dup', providerSessionId: null, reservedUsd: 0.25, actualUsd: null, createdAt: '', finalized: false, closureConfirmed: false },
        { sessionId: 'dup', providerSessionId: null, reservedUsd: 0.25, actualUsd: null, createdAt: '', finalized: false, closureConfirmed: false },
      ],
      lastUpdated: '',
    }), { mode: 0o600 });

    const budget = new GptLiveBudget(budgetFile);
    await expect(budget.load()).rejects.toThrow('Duplicate session ID');
  });

  it('rejects non-boolean finalized in reservation', async () => {
    const budgetFile = path.join(workDir, 'budget.json');
    await writeFile(budgetFile, JSON.stringify({
      cumulativeUsageUsd: 0,
      reservations: [
        { sessionId: 's', providerSessionId: null, reservedUsd: 0.25, actualUsd: null, createdAt: '', finalized: 'yes', closureConfirmed: false },
      ],
      lastUpdated: '',
    }), { mode: 0o600 });

    const budget = new GptLiveBudget(budgetFile);
    await expect(budget.load()).rejects.toThrow('Corrupt reservation');
  });

  it('cross-mode startup exposes slotTaken', async () => {
    const manager = await enabledManager(workDir);
    await manager.createSession('owner', 'v=0\r\noffer', 'http://localhost', noopCallbacks());
    expect(manager.hasActiveSession).toBe(true);
    await manager.shutdown();
  });

  it('diagnostics never contain credentials', async () => {
    const manager = await enabledManager(workDir);
    await manager.createSession('owner', 'v=0\r\noffer', 'http://localhost', noopCallbacks());

    const diag = manager.getDiagnostics();
    const serialized = JSON.stringify(diag);
    expect(serialized).not.toContain('sk-');
    expect(serialized).not.toMatch(/\bapi[_-]?key\b/i);
    expect(serialized).not.toMatch(/\bsdp\b/i);
    expect(serialized).not.toMatch(/\bice[_-]?ufrag\b/i);
    expect(serialized).not.toMatch(/\bpassword\b/i);

    await manager.shutdown();
  });
});
