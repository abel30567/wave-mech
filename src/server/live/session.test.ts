import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { GptLiveManager, type GptLiveSessionCallbacks, type HarnessFactory } from './session.js';
import type { LiveProvider, ProviderEventHandler, SidebandHandle } from './provider.js';
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
      async close() {
        started = false;
      },
    };
  };
}

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

function createMockProvider(options?: {
  sessionId?: string;
  answerSdp?: string;
  createError?: Error;
  hangupError?: Error;
  onAttachSideband?: (handler: ProviderEventHandler) => void;
}): { provider: LiveProvider; calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    createSession: [],
    attachSideband: [],
    sendThinking: [],
    sendCommentary: [],
    closeSession: [],
    hangup: [],
    destroy: [],
  };

  let sidebandHandler: ProviderEventHandler | null = null;

  const provider: LiveProvider = {
    async createSession(offerSdp, instructions, clientEventRestrictions) {
      calls.createSession.push([offerSdp, instructions, clientEventRestrictions]);
      if (options?.createError) throw options.createError;
      return {
        providerSessionId: options?.sessionId ?? 'prov-sess-123',
        answerSdp: options?.answerSdp ?? 'v=0\r\nfake-answer-sdp',
      };
    },
    async attachSideband(sessionId, handler) {
      calls.attachSideband.push([sessionId, handler]);
      sidebandHandler = handler;
      options?.onAttachSideband?.(handler);
      return {
        close() { /* no-op */ },
      };
    },
    sendThinking(content, delegationId) {
      calls.sendThinking.push([content, delegationId]);
    },
    sendCommentary(content, delegationId) {
      calls.sendCommentary.push([content, delegationId]);
    },
    closeSession() {
      calls.closeSession.push([]);
    },
    async hangup(sessionId) {
      calls.hangup.push([sessionId]);
      if (options?.hangupError) throw options.hangupError;
    },
    destroy() {
      calls.destroy.push([]);
    },
  };

  return { provider, calls };
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

  it('invokes SDK provider with exact model and client delegation', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdef', { mode: 0o600 });

    const { provider, calls } = createMockProvider({
      sessionId: 'prov-unique-answer-id',
      answerSdp: 'v=0\r\nunique-provider-answer',
    });

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory: createMockHarnessFactory(),
    });
    await manager.initialize();

    const callbacks = noopCallbacks();
    const result = await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks);

    expect(result.sdp).toBe('v=0\r\nunique-provider-answer');
    expect(calls.createSession).toHaveLength(1);
    expect(calls.createSession[0][0]).toBe('v=0\r\noffer');
    expect(manager.hasActiveSession).toBe(true);

    await manager.shutdown();
  });

  it('restricts browser client events to mute/unmute only', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdef', { mode: 0o600 });

    const { provider, calls } = createMockProvider();

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory: createMockHarnessFactory(),
    });
    await manager.initialize();

    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());

    const [, , clientEventRestrictions] = calls.createSession[0] as [string, string, string[]];
    expect(Array.isArray(clientEventRestrictions)).toBe(true);
    expect(clientEventRestrictions).not.toContain('session.update');
    expect(clientEventRestrictions).not.toContain('session.instructions.append');
    expect(clientEventRestrictions).not.toContain('session.close');
    expect(clientEventRestrictions).toContain('session.input_audio.mute');
    expect(clientEventRestrictions).toContain('session.input_audio.unmute');

    await manager.shutdown();
  });

  it('prevents duplicate/parallel session starts via synchronous slot', async () => {
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

    const p1 = manager.createSession('owner-1', 'v=0\r\noffer1', 'http://localhost', noopCallbacks());

    await new Promise(resolve => setTimeout(resolve, 50));

    const error = manager.validateSessionRequest('owner-2', 'v=0\r\noffer2');
    expect(error).toBe('A trial session is already active.');

    gate.resolve?.();
    await p1;
    await manager.shutdown();
  });

  it('sanitizes SDK errors so keys/SDP never reach browser', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdef', { mode: 0o600 });

    const { provider } = createMockProvider({
      createError: new Error('Invalid API key sk-proj-abc123 for sdp v=0\r\nsecret ice-ufrag'),
    });

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory: createMockHarnessFactory(),
    });
    await manager.initialize();

    await expect(
      manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks()),
    ).rejects.toThrow();

    try {
      await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain('sk-proj-abc123');
      expect(msg).not.toMatch(/v=0/);
    }
  });

  it('retains diagnostic snapshot after closure with valid final seconds', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdef', { mode: 0o600 });

    let sidebandHandler: ProviderEventHandler | null = null;
    const { provider } = createMockProvider({
      onAttachSideband: (handler) => { sidebandHandler = handler; },
    });

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory: createMockHarnessFactory(),
    });
    await manager.initialize();

    const callbacks = noopCallbacks();
    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks);

    const diag = manager.getDiagnostics();
    expect(diag.closureConfirmed).toBeNull();

    sidebandHandler!.onSessionClosed('close_requested', { seconds: 42 });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(manager.hasActiveSession).toBe(false);
    const diagAfter = manager.getDiagnostics();
    expect(diagAfter.closureConfirmed).toBe(true);
    expect(diagAfter.cumulativeVoiceSeconds).toBe(42);
    expect(diagAfter.closureReason).toBe('close_requested');
  });

  it('diagnostics return empty for non-owning caller after closure', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdef', { mode: 0o600 });

    let sidebandHandler: ProviderEventHandler | null = null;
    const { provider } = createMockProvider({
      onAttachSideband: (handler) => { sidebandHandler = handler; },
    });

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory: createMockHarnessFactory(),
    });
    await manager.initialize();

    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());

    sidebandHandler!.onSessionClosed('close_requested', { seconds: 42 });
    await new Promise(resolve => setTimeout(resolve, 50));

    const ownerDiag = manager.getDiagnostics('owner-1');
    expect(ownerDiag.closureConfirmed).toBe(true);

    const otherDiag = manager.getDiagnostics('other-owner');
    expect(otherDiag.sessionId).toBeNull();
    expect(otherDiag.transcript).toEqual([]);
  });

  it('accumulates usage by max, not sum', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdef', { mode: 0o600 });

    const { provider } = createMockProvider();

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory: createMockHarnessFactory(),
    });
    await manager.initialize();

    const callbacks = noopCallbacks();
    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks);

    manager.handleUsageUpdate(10);
    manager.handleUsageUpdate(20);
    manager.handleUsageUpdate(15);

    const diag = manager.getDiagnostics();
    expect(diag.cumulativeVoiceSeconds).toBe(20);

    await manager.shutdown();
  });

  it('prevents duplicate delegation processing', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdef', { mode: 0o600 });

    const { provider } = createMockProvider();

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory: createMockHarnessFactory(),
    });
    await manager.initialize();

    const callbacks = noopCallbacks();
    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks);

    manager.handleInputTranscript('hello world');

    manager.handleDelegationCreated('deleg-1', 1000);
    manager.handleDelegationCreated('deleg-1', 1000);

    expect(callbacks.onDelegationCreated).toHaveBeenCalledTimes(1);

    await manager.shutdown();
  });

  it('queues delegations and drains serialized', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdef', { mode: 0o600 });

    const { provider, calls } = createMockProvider();

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory: createMockHarnessFactory(),
    });
    await manager.initialize();

    const callbacks = noopCallbacks();
    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks);

    manager.handleInputTranscript('do something');

    manager.handleDelegationCreated('deleg-1', 1000);
    manager.handleDelegationCreated('deleg-2', 2000);

    expect(callbacks.onDelegationCreated).toHaveBeenCalledTimes(2);

    await manager.shutdown();
  });

  it('releases slot on provider creation failure', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdef', { mode: 0o600 });

    const { provider } = createMockProvider({
      createError: new Error('Network failure'),
    });

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory: createMockHarnessFactory(),
    });
    await manager.initialize();

    await expect(
      manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks()),
    ).rejects.toThrow();

    expect(manager.hasActiveSession).toBe(false);
    const canStart = manager.validateSessionRequest('owner-1', 'v=0\r\nnew-offer');
    expect(canStart).toBeNull();
  });

  it('closeSession sends session.close and hangup to provider', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdef', { mode: 0o600 });

    const { provider, calls } = createMockProvider({
      sessionId: 'prov-hangup-test',
    });

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory: createMockHarnessFactory(),
    });
    await manager.initialize();

    const callbacks = noopCallbacks();
    const result = await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks);

    await manager.closeSession(result.sessionId, 'user_ended');
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(calls.closeSession.length).toBeGreaterThanOrEqual(1);
    expect(calls.hangup.length).toBeGreaterThanOrEqual(1);
    expect(calls.hangup[0][0]).toBe('prov-hangup-test');
  });

  it('closure timeout keeps conservative reservation when no session.closed arrives', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdef', { mode: 0o600 });

    const { provider } = createMockProvider();

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory: createMockHarnessFactory(),
    });
    await manager.initialize();

    const callbacks = noopCallbacks();
    const result = await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks);

    manager.handleUsageUpdate(30);

    await manager.closeSession(result.sessionId, 'deadline');

    await vi.waitFor(() => {
      expect(manager.hasActiveSession).toBe(false);
    }, { timeout: 20_000 });

    expect(callbacks.onSessionClosed).toHaveBeenCalled();
    const [reason, confirmed] = (callbacks.onSessionClosed as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(confirmed).toBe(false);
  }, 25_000);

  it('rejects NaN/negative usage update values', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdef', { mode: 0o600 });
    const { provider } = createMockProvider();
    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory: createMockHarnessFactory(),
    });
    await manager.initialize();
    const callbacks = noopCallbacks();
    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks);

    manager.handleUsageUpdate(NaN);
    manager.handleUsageUpdate(-5);
    manager.handleUsageUpdate(Infinity);

    expect(manager.getDiagnostics().cumulativeVoiceSeconds).toBe(0);
    await manager.shutdown();
  });

  it('sideband failure triggers session close', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdef', { mode: 0o600 });

    const provider: LiveProvider = {
      async createSession() {
        return { providerSessionId: 'prov-sb-fail', answerSdp: 'v=0\r\nanswer' };
      },
      async attachSideband() {
        throw new Error('WebSocket connection failed');
      },
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
      providerFactory: () => provider,
      harnessFactory: createMockHarnessFactory(),
    });
    await manager.initialize();
    const callbacks = noopCallbacks();
    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks);

    await vi.waitFor(() => {
      expect(manager.hasActiveSession).toBe(false);
    }, { timeout: 20_000 });

    expect(callbacks.onError).toHaveBeenCalled();
  }, 25_000);

  it('sanitizeErrorMessage returns fixed safe categories, not raw SDK messages', async () => {
    const keyFile = path.join(workDir, 'test-api.key');
    await writeFile(keyFile, 'sk-test-key-12345-abcdef', { mode: 0o600 });

    const { provider } = createMockProvider({
      createError: new Error('Connection refused: sk-proj-abc123 at https://api.openai.com/v1/live/sessions with SDP v=0\\r\\n secret ice-ufrag=ABCD'),
    });

    const manager = new GptLiveManager({
      enabled: true,
      apiKeyFile: keyFile,
      budgetFile: path.join(workDir, 'budget.json'),
      maxSessionSeconds: 60,
      configuredModel: 'claude-opus-4-6[1m]',
      nodeExecutable: process.execPath,
      providerFactory: () => provider,
      harnessFactory: createMockHarnessFactory(),
    });
    await manager.initialize();

    try {
      await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', noopCallbacks());
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toBe('Session creation failed.');
      expect(msg).not.toContain('sk-proj');
      expect(msg).not.toContain('api.openai.com');
      expect(msg).not.toContain('SDP');
      expect(msg).not.toContain('ice-ufrag');
    }
  });
});
