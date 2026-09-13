import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { HarnessEvent, HarnessOptions, HarnessSession } from '../../shared/contracts.js';
import { DiagnosticLog, type DiagnosticReason, type DiagnosticStatus } from '../../shared/diagnostics.js';

const DEFAULT_COMMAND = 'claude';

const DEFAULT_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
  '--verbose',
];

const DEFAULT_TIMEOUT_MS = 120_000;
const CLOSE_GRACE_MS = 2_000;
const INTERRUPT_RECEIPT_MS = 5_000;

const SAFE_MODEL_RE = /^claude-[a-z0-9][\w.-]{0,80}$/;

interface CliMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  tools?: unknown;
  mcp_servers?: unknown;
  model?: unknown;
  parent_tool_use_id?: string | null;
  event?: CliStreamEvent;
  message?: { role?: string; content?: unknown };
  request_id?: string;
  response?: { subtype?: string; request_id?: string; error?: unknown };
  is_error?: boolean;
  error?: unknown;
  result?: unknown;
}

interface PendingInterrupt {
  requestId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  receiptTimer: NodeJS.Timeout | undefined;
  settleTimer: NodeJS.Timeout | undefined;
  received: boolean;
  settled: boolean;
}

interface CliStreamEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string };
}

interface Pending {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
  settled: boolean;
}

interface ActiveTool {
  callId: string;
  name: string;
  startMs: number;
  terminal: boolean;
}

class ClaudeCliHarness implements HarnessSession {
  private readonly options: HarnessOptions;
  private readonly timeoutMs: number;
  private readonly diagnostics: DiagnosticLog;

  private child: ChildProcess | undefined;
  private readonly decoder = new StringDecoder('utf8');
  private stdoutBuffer = '';

  private startPromise: Promise<void> | undefined;
  private startSettle:
    | { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout | undefined }
    | undefined;
  private ready = false;

  private pending: Pending | undefined;

  private pendingInterrupt: PendingInterrupt | undefined;
  private controlSeq = 0;
  private suppressStream = false;

  private closePromise: Promise<void> | undefined;
  private closeResolve: (() => void) | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  private closing = false;
  private quarantined = false;

  private blockTypes = new Map<number, string | undefined>();
  private toolNames = new Map<string, string>();
  private activeTools = new Map<string, ActiveTool>();
  private callSeq = 0;

  constructor(options: HarnessOptions) {
    if (typeof options?.onEvent !== 'function') {
      throw new TypeError('createHarness requires an onEvent callback.');
    }
    this.options = options;
    this.timeoutMs =
      typeof options.timeoutMs === 'number' && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    this.diagnostics = new DiagnosticLog('harness');
  }

  get diagnostic(): DiagnosticLog {
    return this.diagnostics;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.closing) return Promise.reject(new Error('Harness is closed.'));

    const command = this.options.command ?? DEFAULT_COMMAND;
    const args = this.options.args ?? DEFAULT_ARGS;

    this.startPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settleStart(new Error('Harness did not become ready before the timeout.'));
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.startSettle = { resolve, reject, timer };

      let child: ChildProcess;
      try {
        child = spawn(command, args, {
          cwd: this.options.cwd,
          env: this.buildEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        });
      } catch (error) {
        this.settleStart(this.asError(error));
        return;
      }
      this.child = child;

      child.once('spawn', () => {
        if (this.closing) return;
        this.ready = true;
        this.settleStart(undefined);
      });

      child.on('error', (error) => {
        const wrapped = new Error(`Harness process failed to start: ${this.asError(error).message}`);
        this.settleStart(wrapped);
        this.failPending(wrapped);
        this.emit({ type: 'error', message: wrapped.message });
        this.finishClose();
      });

      child.on('exit', (code, signal) => this.onExit(code, signal));

      child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
      child.stderr?.resume();
      child.stdin?.on('error', () => {});
    });

    return this.startPromise;
  }

  send(text: string): Promise<void> {
    if (this.closing) {
      return Promise.reject(new Error('Harness is closed.'));
    }
    if (this.quarantined) {
      return Promise.reject(new Error('Harness was quarantined after an unconfirmed cancellation.'));
    }
    if (!this.child || !this.ready) {
      return Promise.reject(new Error('Harness is not ready; call start() first.'));
    }
    if (typeof text !== 'string' || !text.trim()) {
      return Promise.reject(new Error('Cannot send an empty turn.'));
    }
    if (this.pending) {
      return Promise.reject(new Error('A turn is already in progress.'));
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failPending(new Error('Harness turn timed out.'), { unproven: true });
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending = { resolve, reject, timer, settled: false };

      this.blockTypes.clear();
      this.suppressStream = false;

      const line = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      });
      const ok = this.child?.stdin?.write(`${line}\n`, (error) => {
        if (error) this.failPending(new Error('Failed to write turn to harness process.'), { unproven: true });
      });
      if (ok === false) {
        // Backpressure is fine; the callback above still fires on flush/error.
      }
    });
  }

  interrupt(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (!this.child || !this.ready) return Promise.resolve();
    if (!this.pending) return Promise.resolve();
    if (this.pendingInterrupt) return Promise.resolve();

    this.suppressStream = true;
    const requestId = `interrupt-${++this.controlSeq}`;

    return new Promise<void>((resolve, reject) => {
      const interrupt: PendingInterrupt = {
        requestId,
        resolve,
        reject,
        receiptTimer: undefined,
        settleTimer: undefined,
        received: false,
        settled: false,
      };
      this.pendingInterrupt = interrupt;

      interrupt.receiptTimer = setTimeout(() => {
        if (interrupt.received) return;
        this.failPending(
          new Error('Harness interrupt was not acknowledged before the timeout.'),
          { unproven: true },
        );
      }, Math.min(INTERRUPT_RECEIPT_MS, this.timeoutMs));
      if (typeof interrupt.receiptTimer.unref === 'function') interrupt.receiptTimer.unref();

      interrupt.settleTimer = setTimeout(() => {
        this.failPending(
          new Error('Harness interrupt did not settle the turn before the timeout.'),
          { unproven: true },
        );
      }, this.timeoutMs);
      if (typeof interrupt.settleTimer.unref === 'function') interrupt.settleTimer.unref();

      const line = JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'interrupt' },
      });
      this.child?.stdin?.write(`${line}\n`, (error) => {
        if (error) {
          this.failPending(new Error('Failed to write interrupt to harness process.'), { unproven: true });
        }
      });
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;

    this.closePromise = new Promise<void>((resolve) => {
      this.closeResolve = resolve;

      this.settleStart(new Error('Harness closed before it became ready.'));
      if (this.pendingInterrupt) {
        this.settleInterrupt(this.pendingInterrupt, new Error('Harness closed before the interrupt settled.'));
      }
      this.failPending(new Error('Harness closed before the turn completed.'));

      const child = this.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        this.finishClose();
        return;
      }

      try {
        child.stdin?.end();
      } catch {
        // stdin may already be gone.
      }

      child.kill('SIGTERM');
      this.killTimer = setTimeout(() => {
        if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
          this.child.kill('SIGKILL');
        }
      }, CLOSE_GRACE_MS);
      if (typeof this.killTimer.unref === 'function') this.killTimer.unref();
    });

    return this.closePromise;
  }

  // --- internals -----------------------------------------------------------

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += this.decoder.write(chunk);
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;
    let msg: CliMessage;
    try {
      msg = JSON.parse(line) as CliMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') this.handleInit(msg);
        return;
      case 'stream_event':
        this.handleStreamEvent(msg);
        return;
      case 'user':
        this.handleToolResults(msg);
        return;
      case 'assistant':
        return;
      case 'control_response':
        this.handleControlResponse(msg);
        return;
      case 'result':
        this.handleResult(msg);
        return;
      case 'error':
        this.handleErrorLine(msg);
        return;
      default:
        return;
    }
  }

  private handleInit(msg: CliMessage): void {
    this.ready = true;
    const tools = Array.isArray(msg.tools)
      ? msg.tools.filter((t): t is string => typeof t === 'string')
      : undefined;
    const mcp = this.readMcpServers(msg.mcp_servers);
    const model = this.validateModel(msg.model);
    const event: HarnessEvent = { type: 'ready' };
    if (typeof msg.session_id === 'string') event.sessionId = msg.session_id;
    if (tools) event.tools = tools;
    if (mcp) event.mcp = mcp;
    if (model) event.model = model;
    if (model) this.diagnostics.setModel(model);
    this.diagnostics.add({ kind: 'ready' });
    this.emit(event);
    this.settleStart(undefined);
  }

  private validateModel(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    if (!SAFE_MODEL_RE.test(value)) return undefined;
    return value;
  }

  private readMcpServers(value: unknown): Array<{ name: string; status: string }> | undefined {
    if (!Array.isArray(value)) return undefined;
    const servers: Array<{ name: string; status: string }> = [];
    for (const entry of value) {
      if (entry && typeof entry === 'object') {
        const name = (entry as { name?: unknown }).name;
        const status = (entry as { status?: unknown }).status;
        if (typeof name === 'string') {
          servers.push({ name, status: typeof status === 'string' ? status : 'unknown' });
        }
      }
    }
    return servers.length > 0 ? servers : undefined;
  }

  private handleControlResponse(msg: CliMessage): void {
    const interrupt = this.pendingInterrupt;
    if (!interrupt) return;
    const response = msg.response;
    const requestId = response?.request_id ?? msg.request_id;
    if (requestId !== interrupt.requestId) return;
    interrupt.received = true;
    if (interrupt.receiptTimer) {
      clearTimeout(interrupt.receiptTimer);
      interrupt.receiptTimer = undefined;
    }
    if (response?.subtype === 'error') {
      const message = typeof response.error === 'string' ? response.error : 'Harness rejected the interrupt.';
      this.settleInterrupt(interrupt, new Error(message));
      this.failPending(new Error(message), { unproven: true });
      return;
    }
    if (!this.pending) this.settleInterrupt(interrupt, undefined);
  }

  private handleStreamEvent(msg: CliMessage): void {
    if (msg.parent_tool_use_id != null) return;
    if (this.suppressStream) return;
    const ev = msg.event;
    if (!ev) return;

    switch (ev.type) {
      case 'message_start':
        this.blockTypes.clear();
        return;
      case 'content_block_start': {
        const index = typeof ev.index === 'number' ? ev.index : -1;
        const block = ev.content_block;
        this.blockTypes.set(index, block?.type);
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          const name = typeof block.name === 'string' ? block.name : 'tool';
          const callId = block.id;
          this.toolNames.set(callId, name);
          const active: ActiveTool = { callId, name, startMs: Date.now(), terminal: false };
          this.activeTools.set(callId, active);
          this.emit({ type: 'tool', name, status: 'running', callId });
        }
        return;
      }
      case 'content_block_delta': {
        const index = typeof ev.index === 'number' ? ev.index : -1;
        const delta = ev.delta;
        if (
          delta?.type === 'text_delta' &&
          this.blockTypes.get(index) === 'text' &&
          typeof delta.text === 'string' &&
          delta.text.length > 0
        ) {
          this.emit({ type: 'text', text: delta.text });
        }
        return;
      }
      default:
        return;
    }
  }

  private handleToolResults(msg: CliMessage): void {
    if (msg.parent_tool_use_id != null) return;
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'tool_result'
      ) {
        const id = (block as { tool_use_id?: unknown }).tool_use_id;
        if (typeof id === 'string') {
          const name = this.toolNames.get(id) ?? 'tool';
          this.toolNames.delete(id);
          const isError = (block as { is_error?: unknown }).is_error === true;
          const { status, reason, statusCode } = this.classifyToolResult(block, isError);
          const active = this.activeTools.get(id);
          const durationMs = active ? Math.round(Date.now() - active.startMs) : undefined;
          if (active) {
            active.terminal = true;
            this.activeTools.delete(id);
          }
          this.emit({ type: 'tool', name, status, callId: id, durationMs, reason: reason !== 'unknown' ? reason : undefined, statusCode });
          this.diagnostics.record({
            callId: id,
            name,
            status: status as DiagnosticStatus,
            durationMs,
            reason: reason as DiagnosticReason,
            statusCode,
          });
        }
      }
    }
  }

  private classifyToolResult(
    block: unknown,
    isError: boolean,
  ): { status: 'done' | 'failed' | 'denied' | 'pending'; reason: string; statusCode?: number } {
    if (!isError) return { status: 'done', reason: 'success' };

    const contentText = this.extractContentText(block);

    if (this.isDenial(contentText)) {
      return { status: 'denied', reason: 'policy_denied' };
    }

    const integrationError = this.parseIntegrationError(block);
    if (integrationError) {
      if (integrationError.pendingApproval) {
        return { status: 'pending', reason: 'approval_required', statusCode: integrationError.statusCode };
      }
      return { status: 'failed', reason: 'integration_error', statusCode: integrationError.statusCode };
    }

    return { status: 'failed', reason: 'unknown' };
  }

  private extractContentText(block: unknown): string {
    const content = (block as { content?: unknown }).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (c && typeof c === 'object' ? String((c as { text?: unknown }).text ?? '') : ''))
        .join(' ');
    }
    return '';
  }

  private isDenial(text: string): boolean {
    return /\b(denied|permission|not allowed|blocked)\b/i.test(text);
  }

  private parseIntegrationError(block: unknown): { pendingApproval: boolean; statusCode?: number } | undefined {
    const content = (block as { content?: unknown }).content;
    const text = typeof content === 'string' ? content : '';
    let parsed: Record<string, unknown> | undefined;
    try {
      if (text.startsWith('{')) parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // not JSON-shaped
    }
    if (!parsed) return undefined;
    if (parsed.ok === false || typeof parsed.error === 'string' || typeof parsed.status === 'string') {
      const pendingApproval = parsed.status === 'pending_approval';
      const statusCode = typeof parsed.status === 'number' ? parsed.status : undefined;
      return { pendingApproval, statusCode };
    }
    return undefined;
  }

  private handleResult(msg: CliMessage): void {
    if (msg.is_error === true || msg.subtype === 'error') {
      const message = this.readMessage(msg) ?? 'Harness turn failed.';
      this.emit({ type: 'error', message });
      this.failPending(new Error(message));
      return;
    }
    this.resolvePending();
  }

  private handleErrorLine(msg: CliMessage): void {
    const message = this.readMessage(msg) ?? 'Harness reported an error.';
    this.emit({ type: 'error', message });
    this.failPending(new Error(message));
  }

  private readMessage(msg: CliMessage): string | undefined {
    if (typeof msg.error === 'string') return msg.error;
    if (typeof msg.result === 'string' && msg.is_error === true) return msg.result;
    const nested = msg.message;
    if (nested && typeof (nested as { error?: unknown }).error === 'string') {
      return (nested as { error: string }).error;
    }
    return undefined;
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.ready = false;
    this.settleActiveTools('cancelled');
    if (this.pending) {
      const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.failPending(new Error(`Harness process exited (${detail}) before completing the turn.`));
    }
    this.settleStart(new Error('Harness process exited before it became ready.'));
    this.finishClose();
  }

  private settleActiveTools(status: 'cancelled'): void {
    for (const [id, active] of this.activeTools) {
      if (active.terminal) continue;
      active.terminal = true;
      const durationMs = Math.round(Date.now() - active.startMs);
      this.emit({ type: 'tool', name: active.name, status, callId: id, durationMs });
      this.diagnostics.record({
        callId: id,
        name: active.name,
        status,
        durationMs,
        reason: 'cancelled',
      });
    }
    this.activeTools.clear();
  }

  private finishClose(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }
    if (this.closing && this.closeResolve) {
      const resolve = this.closeResolve;
      this.closeResolve = undefined;
      resolve();
    }
  }

  private resolvePending(): void {
    const pending = this.pending;
    if (!pending || pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending = undefined;
    if (this.pendingInterrupt) this.settleInterrupt(this.pendingInterrupt, undefined);
    pending.resolve();
  }

  private failPending(error: Error, opts: { unproven?: boolean } = {}): void {
    const interrupt = this.pendingInterrupt;
    if (opts.unproven) {
      if (interrupt && !interrupt.settled) this.settleInterrupt(interrupt, error);
      this.quarantineProcess();
    } else if (interrupt) {
      this.settleInterrupt(interrupt, undefined);
    }
    this.settleActiveTools('cancelled');
    const pending = this.pending;
    if (!pending || pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending = undefined;
    pending.reject(error);
  }

  private quarantineProcess(): void {
    if (this.quarantined) return;
    this.quarantined = true;
    this.suppressStream = true;
    this.ready = false;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.stdin?.end();
    } catch {
      // stdin may already be gone.
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // already dead
    }
    const timer = setTimeout(() => {
      if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
        try {
          this.child.kill('SIGKILL');
        } catch {
          // already dead
        }
      }
    }, CLOSE_GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  private settleInterrupt(interrupt: PendingInterrupt, error: Error | undefined): void {
    if (interrupt.settled) return;
    interrupt.settled = true;
    if (interrupt.receiptTimer) clearTimeout(interrupt.receiptTimer);
    if (interrupt.settleTimer) clearTimeout(interrupt.settleTimer);
    if (this.pendingInterrupt === interrupt) this.pendingInterrupt = undefined;
    if (error) interrupt.reject(error);
    else interrupt.resolve();
  }

  private settleStart(error: Error | undefined): void {
    const settle = this.startSettle;
    if (!settle) return;
    this.startSettle = undefined;
    if (settle.timer) clearTimeout(settle.timer);
    if (error) settle.reject(error);
    else settle.resolve();
  }

  private emit(event: HarnessEvent): void {
    try {
      this.options.onEvent(event);
    } catch {
      // A faulty consumer callback must not tear down the harness.
    }
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const overrides = this.options.env;
    if (!overrides) return process.env;
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) merged[key] = value;
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    return merged;
  }

  private asError(error: unknown): Error {
    if (error instanceof Error) return error;
    return new Error(typeof error === 'string' ? error : 'Unknown harness error.');
  }
}

export function createHarness(options: HarnessOptions): HarnessSession {
  return new ClaudeCliHarness(options);
}
