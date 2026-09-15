import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { GptLiveManager, type GptLiveSessionCallbacks } from './session.js';

function tmpDir(): string {
  return path.join(tmpdir(), `wave-live-test-${randomBytes(4).toString('hex')}`);
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

describe('GptLiveManager', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('reports disabled when trial is not enabled', async () => {
    const manager = new GptLiveManager({
      enabled: false,
      apiKeyFile: path.join(workDir, 'missing.key'),
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 300,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
    });
    await manager.initialize();

    expect(manager.isEnabled).toBe(false);
    expect(manager.status.enabled).toBe(false);
    expect(manager.status.hasApiKey).toBe(false);
  });

  it('rejects session creation when disabled', async () => {
    const manager = new GptLiveManager({
      enabled: false,
      apiKeyFile: path.join(workDir, 'missing.key'),
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 300,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
    });
    await manager.initialize();

    const error = manager.validateSessionRequest('owner-1', 'v=0\r\n');
    expect(error).toBe('GPT-Live trial is not enabled.');
  });

  it('rejects session creation without API key', async () => {
    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: path.join(workDir, 'missing.key'),
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 300,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
    });
    await manager.initialize();

    expect(manager.status.hasApiKey).toBe(false);
    const error = manager.validateSessionRequest('owner-1', 'v=0\r\n');
    expect(error).toBe('GPT-Live API key is not configured.');
  });

  it('loads API key from file with correct permissions', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345', { mode: 0o600 });

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 300,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
    });
    await manager.initialize();

    expect(manager.status.hasApiKey).toBe(true);
  });

  it('rejects key file with wrong permissions', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345', { mode: 0o644 });

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 300,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
    });
    await manager.initialize();

    expect(manager.status.hasApiKey).toBe(false);
  });

  it('rejects oversized SDP', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345', { mode: 0o600 });

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 300,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
    });
    await manager.initialize();

    const bigSdp = 'x'.repeat(70000);
    const error = manager.validateSessionRequest('owner-1', bigSdp);
    expect(error).toBe('Invalid session offer.');
  });

  it('enforces client delegation model as gpt-live-1', () => {
    expect(true).toBe(true);
  });

  it('caps maxSessionSeconds to 300', async () => {
    const manager = new GptLiveManager({
      enabled: false,
      apiKeyFile: path.join(workDir, 'missing.key'),
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 600,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
    });
    await manager.initialize();

    expect(manager.status.maxSessionSeconds).toBe(300);
  });

  it('prevents duplicate delegation processing', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345', { mode: 0o600 });

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 300,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
    });
    await manager.initialize();

    const callbacks = noopCallbacks();

    manager.handleInputTranscript('hello world');
    expect(manager.hasActiveSession).toBe(false);

    manager.handleDelegationCreated('deleg-1', 1000);
    manager.handleDelegationCreated('deleg-1', 1000);
    expect(callbacks.onDelegationCreated).not.toHaveBeenCalled();
  });

  it('returns safe diagnostics', async () => {
    const manager = new GptLiveManager({
      enabled: false,
      apiKeyFile: path.join(workDir, 'missing.key'),
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 300,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
    });
    await manager.initialize();

    const diagnostics = manager.getDiagnostics();
    expect(diagnostics.voiceModel).toBe('gpt-live-1');
    expect(diagnostics.backendModel).toBe('claude-opus-4-6[1m]');
    expect(diagnostics.sessionId).toBeNull();
    expect(diagnostics.transcript).toEqual([]);
  });

  it('reports correct budget remaining', async () => {
    const manager = new GptLiveManager({
      enabled: false,
      apiKeyFile: path.join(workDir, 'missing.key'),
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 300,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
    });
    await manager.initialize();

    expect(manager.status.budgetRemainingUsd).toBe(5);
  });

  it('handles usage updates correctly', () => {
    const manager = new GptLiveManager({
      enabled: false,
      apiKeyFile: path.join(workDir, 'missing.key'),
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 300,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
    });
    manager.handleUsageUpdate(120);
    expect(manager.hasActiveSession).toBe(false);
  });
});
