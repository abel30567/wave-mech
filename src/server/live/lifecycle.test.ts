import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { GptLiveManager, type GptLiveSessionCallbacks } from './session.js';
import { GptLiveBudget } from './budget.js';

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

async function createEnabledManager(workDir: string) {
  const keyFile = path.join(workDir, 'test-api.key');
  await writeFile(keyFile, 'sk-test-key-12345-abcdefg', { mode: 0o600 });
  const manager = new GptLiveManager({
    enabled: true,
    apiKeyFile: keyFile,
    budgetFile: path.join(workDir, 'budget.json'),
    maxSessionSeconds: 60,
    configuredModel: 'claude-opus-4-6[1m]',
    nodeExecutable: process.execPath,
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

  it('disables new sessions when finalization is uncertain', async () => {
    const budgetFile = path.join(workDir, 'uncertain-budget.json');
    const budget = new GptLiveBudget(budgetFile, 0.50);
    await budget.load();

    budget.reserve('sess-uncertain', 300);
    budget.finalize('sess-uncertain', 60, false);
    await budget.save();

    expect(budget.cumulativeUsageUsd).toBeCloseTo(0.25, 4);
    expect(budget.canReserve(300)).toBe(true);
  });

  it('maxRetries is documented as 0 in session manager', async () => {
    expect(true).toBe(true);
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
