import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { createHarness } from '../../src/server/harness/index.js';
import { GptLiveManager, splitUtf8Chunks, type GptLiveSessionCallbacks, type HarnessFactory } from '../../src/server/live/session.js';
import type { LiveProvider, ProviderEventHandler } from '../../src/server/live/provider.js';
import type { HarnessEvent, HarnessOptions, HarnessSession } from '../../src/shared/contracts.js';

const FIXTURE = fileURLToPath(
  new URL('../../src/server/harness/fixtures/cli-fixture.mjs', import.meta.url),
);

// --- helpers ----------------------------------------------------------------

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
): {
  session: Harness;
  events: HarnessEvent[];
  texts: () => string;
  results: string[];
} {
  const events: HarnessEvent[] = [];
  const results: string[] = [];
  const session = createHarness({
    command: 'node',
    args: [FIXTURE],
    env: { SCENARIO: scenario, ...extraEnv },
    onEvent: (e) => events.push(e),
    onResult: (text) => results.push(text),
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
    results,
  };
}

afterEach(async () => {
  await Promise.all(openSessions.splice(0).map((s) => s.close().catch(() => {})));
});

function tmpDir(): string {
  return path.join(tmpdir(), `wave-deleg-test-${randomBytes(4).toString('hex')}`);
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

// --- Issue 1: harness handleResult uses msg.result --------------------------

describe('harness handleResult uses msg.result (issue 1)', () => {
  it('multi-tool rounds: onResult gets only final result, not interim narration', async () => {
    const { session, results, texts } = build('multi_tool_rounds');
    await session.start();
    await session.send('go');
    expect(results).toHaveLength(1);
    expect(results[0]).toBe('The verified answer is 7.');
    expect(texts()).toContain('Let me check that for you.');
    expect(texts()).toContain('I found something, let me verify.');
    expect(texts()).toContain('The verified answer is 7.');
  });

  it('result-only turn (no streamed text): onResult still fires', async () => {
    const { session, results, texts } = build('result_only');
    await session.start();
    await session.send('go');
    expect(results).toHaveLength(1);
    expect(results[0]).toBe('Result-only answer.');
    expect(texts()).toBe('');
  });

  it('tool_then_result: onResult is exactly msg.result, not heuristic strip', async () => {
    const { session, results } = build('tool_then_result');
    await session.start();
    await session.send('go');
    expect(results).toHaveLength(1);
    expect(results[0]).toBe('The answer is 42.');
  });

  it('error result does not invoke onResult', async () => {
    const { session, results } = build('error');
    await session.start();
    await expect(session.send('go')).rejects.toThrow();
    expect(results).toHaveLength(0);
  });

  it('duplicate result after settlement is dropped', async () => {
    const { session, results } = build('text_only');
    await session.start();
    await session.send('go');
    expect(results).toHaveLength(1);
  });
});

// --- Issue 2: delegation serialization and send settlement ------------------

describe('delegation serialization holds until send settles (issue 2)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('two sequential delegations: second waits for first send to settle', async () => {
    let sendCount = 0;
    let concurrentSends = 0;
    let maxConcurrent = 0;
    let sendGate: (() => void) | null = null;

    const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send(text: string) {
        sendCount++;
        concurrentSends++;
        maxConcurrent = Math.max(maxConcurrent, concurrentSends);
        await new Promise<void>(resolve => { sendGate = resolve; });
        concurrentSends--;
        if (options.onResult) options.onResult(`Result for: ${text}`);
      },
      async close() {},
    });

    const commentaryCalls: [string, string | null][] = [];
    const provider: LiveProvider = {
      async createSession() {
        return { providerSessionId: 'prov-serial', answerSdp: 'v=0\r\nanswer' };
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

    const keyFile = path.join(workDir, 'test.key');
    await writeFile(keyFile, 'sk-test-key-serial-12345', { mode: 0o600 });

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

    const callbacks = noopCallbacks();
    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks);

    manager.handleInputTranscript('do task one');
    manager.handleDelegationCreated('deleg-s1', 1000);

    // Wait for send to be called
    await vi.waitFor(() => expect(sendCount).toBe(1));

    // Queue second delegation while first is in progress
    manager.handleInputTranscript(' and also task two');
    manager.handleDelegationCreated('deleg-s2', 2000);

    // First send still in progress — second must not have started
    expect(sendCount).toBe(1);
    expect(maxConcurrent).toBe(1);

    // Settle first send
    sendGate!();
    await vi.waitFor(() => expect(commentaryCalls.length).toBeGreaterThanOrEqual(1));

    // Wait for second send
    await vi.waitFor(() => expect(sendCount).toBe(2));

    // Settle second
    sendGate!();
    await vi.waitFor(() => expect(commentaryCalls.length).toBeGreaterThanOrEqual(2));

    // Never had concurrent sends
    expect(maxConcurrent).toBe(1);

    await manager.shutdown();
  });

  it('streaming preamble does NOT trigger commentary and does NOT start second send', async () => {
    let sendCount = 0;
    const commentaryCalls: string[] = [];
    let sendGate: (() => void) | null = null;

    const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send(text: string) {
        sendCount++;
        options.onEvent({ type: 'text', text: 'Thinking about it...' });
        await new Promise<void>(resolve => { sendGate = resolve; });
        if (options.onResult) options.onResult('The actual answer.');
      },
      async close() {},
    });

    const provider: LiveProvider = {
      async createSession() {
        return { providerSessionId: 'prov-preamble', answerSdp: 'v=0\r\nanswer' };
      },
      async attachSideband() { return { close() {} }; },
      sendThinking() {},
      sendCommentary(content) { commentaryCalls.push(content); },
      closeSession() {},
      async hangup() {},
      destroy() {},
    };

    const keyFile = path.join(workDir, 'test.key');
    await writeFile(keyFile, 'sk-test-key-preamble-12345', { mode: 0o600 });

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
    manager.handleInputTranscript('question');
    manager.handleDelegationCreated('deleg-p1', 1000);

    await vi.waitFor(() => expect(sendCount).toBe(1));

    // No commentary yet — only preamble has been emitted
    expect(commentaryCalls).toHaveLength(0);

    // Settle
    sendGate!();
    await vi.waitFor(() => expect(commentaryCalls.length).toBeGreaterThanOrEqual(1));

    expect(commentaryCalls[0]).toBe('The actual answer.');
    expect(commentaryCalls[0]).not.toContain('Thinking about it');

    await manager.shutdown();
  });

  it('callback exception in onResult is contained safely', async () => {
    let resultCalled = false;
    const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send(text: string) {
        if (options.onResult) {
          resultCalled = true;
          options.onResult('answer');
        }
      },
      async close() {},
    });

    const provider: LiveProvider = {
      async createSession() {
        return { providerSessionId: 'prov-ex', answerSdp: 'v=0\r\nanswer' };
      },
      async attachSideband() { return { close() {} }; },
      sendThinking() {},
      sendCommentary() { throw new Error('Provider send exploded'); },
      closeSession() {},
      async hangup() {},
      destroy() {},
    };

    const keyFile = path.join(workDir, 'test.key');
    await writeFile(keyFile, 'sk-test-key-exception-12345', { mode: 0o600 });

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

    const callbacks = noopCallbacks();
    await manager.createSession('owner-1', 'v=0\r\noffer', 'http://localhost', callbacks);
    manager.handleInputTranscript('go');
    manager.handleDelegationCreated('deleg-ex', 1000);

    await vi.waitFor(() => expect(resultCalled).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 100));

    // Should not have crashed — can still shut down cleanly
    await manager.shutdown();
  });

  it('late callback after session close is fenced', async () => {
    let sendGate: (() => void) | null = null;
    let onResultFn: ((text: string) => void) | undefined;

    const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send(text: string) {
        onResultFn = options.onResult;
        await new Promise<void>(resolve => { sendGate = resolve; });
        if (options.onResult) options.onResult('late result');
      },
      async close() {
        // Resolve any pending send on close
        sendGate?.();
      },
    });

    const commentaryCalls: string[] = [];
    const provider: LiveProvider = {
      async createSession() {
        return { providerSessionId: 'prov-fence', answerSdp: 'v=0\r\nanswer' };
      },
      async attachSideband() { return { close() {} }; },
      sendThinking() {},
      sendCommentary(content) { commentaryCalls.push(content); },
      closeSession() {},
      async hangup() {},
      destroy() {},
    };

    const keyFile = path.join(workDir, 'test.key');
    await writeFile(keyFile, 'sk-test-key-fence-12345', { mode: 0o600 });

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

    const callbacks = noopCallbacks();
    const { sessionId } = await manager.createSession(
      'owner-1', 'v=0\r\noffer', 'http://localhost', callbacks,
    );
    manager.handleInputTranscript('go');
    manager.handleDelegationCreated('deleg-fence', 1000);

    // Wait for send to be in progress
    await vi.waitFor(() => expect(sendGate).not.toBeNull());

    // Close session while send is in progress
    await manager.closeSession(sessionId, 'test_close');
    await new Promise(resolve => setTimeout(resolve, 100));

    // Commentary from the late result should not have been sent to the
    // provider since session was closed
    expect(commentaryCalls).toHaveLength(0);
  });
});

// --- Issue 3: chunked commentary -------------------------------------------

describe('chunked commentary respects byte limits (issue 3)', () => {
  it('splits text into <=500 byte chunks', () => {
    const longText = 'A'.repeat(1200);
    const chunks = splitUtf8Chunks(longText, 500);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(500);
    }
    expect(chunks.join('')).toBe(longText);
  });

  it('does not lose characters with multi-byte UTF-8', () => {
    // Each emoji is 4 bytes. 126 emojis = 504 bytes, should split into 2 chunks.
    const emojis = '\u{1F30A}'.repeat(126);
    const chunks = splitUtf8Chunks(emojis, 500);
    expect(chunks.length).toBe(2);
    expect(chunks.join('')).toBe(emojis);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(500);
      // No broken surrogate pairs
      expect(chunk).not.toContain('�');
    }
  });

  it('does not split text shorter than limit', () => {
    const short = 'Hello world';
    const chunks = splitUtf8Chunks(short, 500);
    expect(chunks).toEqual([short]);
  });

  it('handles 2-byte and 3-byte UTF-8 characters at boundaries', () => {
    // 'é' is 2 bytes, '€' is 3 bytes
    const text = 'é'.repeat(250) + '€'.repeat(10);
    const chunks = splitUtf8Chunks(text, 500);
    const rejoined = chunks.join('');
    expect(rejoined).toBe(text);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(500);
    }
  });

  it('sends multiple commentary chunks for long results via session', async () => {
    const workDir = tmpDir();
    await mkdir(workDir, { recursive: true });

    try {
      const commentaryCalls: [string, string | null][] = [];

      const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
        async start() { options.onEvent({ type: 'ready' }); },
        async send(text: string) {
          if (options.onResult) options.onResult('X'.repeat(1200));
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

      const keyFile = path.join(workDir, 'test.key');
      await writeFile(keyFile, 'sk-test-key-chunk-12345', { mode: 0o600 });

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
      manager.handleInputTranscript('question');
      manager.handleDelegationCreated('deleg-chunk', 1000);

      await vi.waitFor(() => expect(commentaryCalls.length).toBeGreaterThanOrEqual(2));

      // All chunks go to same delegation
      for (const [, delegationId] of commentaryCalls) {
        expect(delegationId).toBe('deleg-chunk');
      }
      // All chunks are within byte limit
      for (const [content] of commentaryCalls) {
        expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(500);
      }
      // All text is preserved
      const fullText = commentaryCalls.map(([c]) => c).join('');
      expect(fullText).toBe('X'.repeat(1200));

      await manager.shutdown();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// --- Issue 4: event-driven pending-input queue ------------------------------

describe('event-driven input queue replaces sleep/drop (issue 4)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = tmpDir();
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('delegation waits for transcript then processes', async () => {
    let sendText: string | null = null;

    const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send(text: string) {
        sendText = text;
        if (options.onResult) options.onResult(`Done: ${text}`);
      },
      async close() {},
    });

    const provider: LiveProvider = {
      async createSession() {
        return { providerSessionId: 'prov-wait', answerSdp: 'v=0\r\nanswer' };
      },
      async attachSideband() { return { close() {} }; },
      sendThinking() {},
      sendCommentary() {},
      closeSession() {},
      async hangup() {},
      destroy() {},
    };

    const keyFile = path.join(workDir, 'test.key');
    await writeFile(keyFile, 'sk-test-key-wait-12345', { mode: 0o600 });

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

    // Delegation arrives BEFORE any transcript
    manager.handleDelegationCreated('deleg-wait', 500);

    // Give it a moment — no send yet because no transcript
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sendText).toBeNull();

    // Transcript arrives 800ms later (well past old 500ms sleep)
    await new Promise(resolve => setTimeout(resolve, 800));
    manager.handleInputTranscript('Delayed user input');

    // Should now process
    await vi.waitFor(() => expect(sendText).not.toBeNull(), { timeout: 2000 });
    expect(sendText).toContain('Delayed user input');

    await manager.shutdown();
  });

  it('times out and drops delegation if no transcript arrives', async () => {
    let sendCalled = false;

    const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send() { sendCalled = true; },
      async close() {},
    });

    const provider: LiveProvider = {
      async createSession() {
        return { providerSessionId: 'prov-timeout', answerSdp: 'v=0\r\nanswer' };
      },
      async attachSideband() { return { close() {} }; },
      sendThinking() {},
      sendCommentary() {},
      closeSession() {},
      async hangup() {},
      destroy() {},
    };

    const keyFile = path.join(workDir, 'test.key');
    await writeFile(keyFile, 'sk-test-key-timeout-12345', { mode: 0o600 });

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

    // Delegation with no transcript ever
    manager.handleDelegationCreated('deleg-drop', 500);

    // Wait for the timeout (3s + margin)
    await new Promise(resolve => setTimeout(resolve, 4000));

    // Should have dropped without sending
    expect(sendCalled).toBe(false);

    await manager.shutdown();
  }, 10000);

  it('does not fabricate text from empty transcript', async () => {
    let sendTexts: string[] = [];

    const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send(text: string) {
        sendTexts.push(text);
        if (options.onResult) options.onResult('ok');
      },
      async close() {},
    });

    const provider: LiveProvider = {
      async createSession() {
        return { providerSessionId: 'prov-empty', answerSdp: 'v=0\r\nanswer' };
      },
      async attachSideband() { return { close() {} }; },
      sendThinking() {},
      sendCommentary() {},
      closeSession() {},
      async hangup() {},
      destroy() {},
    };

    const keyFile = path.join(workDir, 'test.key');
    await writeFile(keyFile, 'sk-test-key-empty-12345', { mode: 0o600 });

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

    // Only whitespace transcript
    manager.handleInputTranscript('   ');
    manager.handleDelegationCreated('deleg-empty', 500);

    await new Promise(resolve => setTimeout(resolve, 4000));

    // Should not have sent — empty/whitespace is not a valid request
    expect(sendTexts).toHaveLength(0);

    await manager.shutdown();
  }, 10000);

  it('coherent fragmented input is joined without spurious spaces', async () => {
    let sentText: string | null = null;

    const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send(text: string) {
        sentText = text;
        if (options.onResult) options.onResult('ok');
      },
      async close() {},
    });

    const provider: LiveProvider = {
      async createSession() {
        return { providerSessionId: 'prov-frag', answerSdp: 'v=0\r\nanswer' };
      },
      async attachSideband() { return { close() {} }; },
      sendThinking() {},
      sendCommentary() {},
      closeSession() {},
      async hangup() {},
      destroy() {},
    };

    const keyFile = path.join(workDir, 'test.key');
    await writeFile(keyFile, 'sk-test-key-frag-12345', { mode: 0o600 });

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

    // Simulate fragmented transcript deltas (as from real-time voice)
    manager.handleInputTranscript('What is ');
    manager.handleInputTranscript('the weather ');
    manager.handleInputTranscript('today?');
    manager.handleDelegationCreated('deleg-frag', 1000);

    await vi.waitFor(() => expect(sentText).not.toBeNull(), { timeout: 2000 });

    // Should be coherent concatenation, no spurious spaces between fragments
    expect(sentText).toBe('What is the weather today?');

    await manager.shutdown();
  });

  it('duplicate delegation IDs are deduped while preserving delayed task', async () => {
    let sendCount = 0;

    const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send() {
        sendCount++;
        if (options.onResult) options.onResult('ok');
      },
      async close() {},
    });

    const provider: LiveProvider = {
      async createSession() {
        return { providerSessionId: 'prov-dedup', answerSdp: 'v=0\r\nanswer' };
      },
      async attachSideband() { return { close() {} }; },
      sendThinking() {},
      sendCommentary() {},
      closeSession() {},
      async hangup() {},
      destroy() {},
    };

    const keyFile = path.join(workDir, 'test.key');
    await writeFile(keyFile, 'sk-test-key-dedup-12345', { mode: 0o600 });

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
    manager.handleInputTranscript('hello');

    // Same ID sent twice
    manager.handleDelegationCreated('deleg-dup', 1000);
    manager.handleDelegationCreated('deleg-dup', 1000);

    // Different ID follows
    manager.handleDelegationCreated('deleg-new', 2000);

    await vi.waitFor(() => expect(sendCount).toBeGreaterThanOrEqual(2), { timeout: 3000 });

    // Only 2 sends: deleg-dup once, deleg-new once
    expect(sendCount).toBe(2);

    await manager.shutdown();
  });

  it('closing session fences pending delegations', async () => {
    let sendCount = 0;
    let sendGate: (() => void) | null = null;

    const harnessFactory: HarnessFactory = (options: HarnessOptions): HarnessSession => ({
      async start() { options.onEvent({ type: 'ready' }); },
      async send() {
        sendCount++;
        await new Promise<void>(resolve => { sendGate = resolve; });
        if (options.onResult) options.onResult('ok');
      },
      async close() { sendGate?.(); },
    });

    const provider: LiveProvider = {
      async createSession() {
        return { providerSessionId: 'prov-close', answerSdp: 'v=0\r\nanswer' };
      },
      async attachSideband() { return { close() {} }; },
      sendThinking() {},
      sendCommentary() {},
      closeSession() {},
      async hangup() {},
      destroy() {},
    };

    const keyFile = path.join(workDir, 'test.key');
    await writeFile(keyFile, 'sk-test-key-close-12345', { mode: 0o600 });

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

    const callbacks = noopCallbacks();
    const { sessionId } = await manager.createSession(
      'owner-1', 'v=0\r\noffer', 'http://localhost', callbacks,
    );

    manager.handleInputTranscript('task');
    manager.handleDelegationCreated('deleg-c1', 1000);

    await vi.waitFor(() => expect(sendCount).toBe(1));

    // Queue second delegation
    manager.handleDelegationCreated('deleg-c2', 2000);

    // Close before first delegation settles
    await manager.closeSession(sessionId, 'user_ended');
    await new Promise(resolve => setTimeout(resolve, 200));

    // Second delegation should not have been sent
    expect(sendCount).toBe(1);
  });
});
