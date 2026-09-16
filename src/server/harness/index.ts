import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { HarnessEvent, HarnessOptions, HarnessSession } from '../../shared/contracts.js';
import type { DiagnosticReason, DiagnosticToolStatus } from '../../shared/diagnostics.js';

const DEFAULT_COMMAND = 'claude';

// Non-interactive streaming session with partial-message deltas enabled. The
// default intentionally does NOT grant broad tools or skip permissions — the
// live coordinator supplies approved flags via `args`.
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
// Bounded receipt window for a control_request. The CLI acknowledges an
// interrupt with a control_response well before the aborted turn settles, so a
// missing acknowledgement means the control channel — not just the turn — is
// unhealthy and cancellation must be reported as failed rather than assumed.
const INTERRUPT_RECEIPT_MS = 5_000;

const SAFE_MODEL_RE = /^claude-[a-z0-9][a-z0-9.\[\]-]{0,80}$/;

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
  duration_ms?: unknown;
  num_turns?: unknown;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
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
}

class ClaudeCliHarness implements HarnessSession {
  private readonly options: HarnessOptions;
  private readonly timeoutMs: number;

  private child: ChildProcess | undefined;
  private readonly decoder = new StringDecoder('utf8');
  private stdoutBuffer = '';

  private startPromise: Promise<void> | undefined;
  private startSettle:
    | { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout | undefined }
    | undefined;
  private ready = false;

  private pending: Pending | undefined;

  /** Outstanding CLI control_request interrupt, if any. */
  private pendingInterrupt: PendingInterrupt | undefined;
  private controlSeq = 0;
  /**
   * Generation fence: while an interrupt is settling, streamed text/tool events
   * belong to the turn being cancelled and must not surface. Reset when a new
   * turn is admitted so the replacement generation streams normally.
   */
  private suppressStream = false;

  private closePromise: Promise<void> | undefined;
  private closeResolve: (() => void) | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  private closing = false;
  /**
   * Set once an interrupt (or turn) failed locally without a proven process-side
   * settlement. The subprocess generation is then unconfirmed: its output stays
   * fenced and it may never serve another turn, so `send()` rejects rather than
   * lift the fence over possibly-live old generation.
   */
  private quarantined = false;

  /** Per-message map of content-block index -> block type (text/thinking/tool_use). */
  private blockTypes = new Map<number, string | undefined>();
  private activeTools = new Map<string, ActiveTool>();
  private seenToolIds = new Set<string>();
  private turnText = '';
  private turnHadTool = false;
  private lastTextBeforeTool = '';

  constructor(options: HarnessOptions) {
    if (typeof options?.onEvent !== 'function') {
      throw new TypeError('createHarness requires an onEvent callback.');
    }
    this.options = options;
    this.timeoutMs =
      typeof options.timeoutMs === 'number' && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS;
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
        // Claude can wait for its first input before emitting system/init.
        // Readiness here means the pipe is writable, not that MCP is connected.
        if (this.closing) return;
        this.ready = true;
        this.settleStart(undefined);
      });

      child.on('error', (error) => {
        // Spawn failure (e.g. command not found) — never surface env contents.
        const wrapped = new Error(`Harness process failed to start: ${this.asError(error).message}`);
        this.settleStart(wrapped);
        this.failPending(wrapped);
        this.emit({ type: 'error', message: wrapped.message });
        this.finishClose();
      });

      child.on('exit', (code, signal) => this.onExit(code, signal));

      child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
      // Drain stderr to avoid backpressure; never echo it (may contain secrets).
      child.stderr?.resume();
      // Avoid unhandled EPIPE if the child dies while we are writing.
      child.stdin?.on('error', () => {});
    });

    return this.startPromise;
  }

  send(text: string): Promise<void> {
    if (this.closing) {
      return Promise.reject(new Error('Harness is closed.'));
    }
    if (this.quarantined) {
      // An unconfirmed cancellation left the previous generation possibly live.
      // Refuse before touching the fence so old output can never bleed into a
      // replacement turn; the coordinator must start a fresh harness/session.
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
        // A local timeout is not a proven process-side settlement.
        this.failPending(new Error('Harness turn timed out.'), { unproven: true });
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending = { resolve, reject, timer, settled: false };

      this.blockTypes.clear();
      this.seenToolIds.clear();
      this.suppressStream = false;
      this.turnText = '';
      this.turnHadTool = false;
      this.lastTextBeforeTool = '';

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

  /**
   * Interrupt the in-flight turn using the CLI's supported streaming
   * `control_request` interrupt. Cancellation is only real once the CLI both
   * acknowledges the request (bounded receipt) and settles the whole turn;
   * rejecting the local send Promise alone would leave the model generating.
   * With no active inference there is nothing to cancel, so it resolves.
   */
  interrupt(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (!this.child || !this.ready) return Promise.resolve();
    if (!this.pending) return Promise.resolve();
    if (this.pendingInterrupt) return Promise.resolve();

    // Fence the generation being cancelled: any text/tool events that arrive
    // between now and settlement belong to the aborted turn.
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
        // No acknowledgement: the control channel is unhealthy and cancellation
        // is unproven. Reject the interrupt, fail the turn, and quarantine the
        // still-live generation rather than assuming it stopped.
        this.failPending(
          new Error('Harness interrupt was not acknowledged before the timeout.'),
          { unproven: true },
        );
      }, Math.min(INTERRUPT_RECEIPT_MS, this.timeoutMs));
      if (typeof interrupt.receiptTimer.unref === 'function') interrupt.receiptTimer.unref();

      interrupt.settleTimer = setTimeout(() => {
        // Acknowledged but the turn never terminally settled. This is a local
        // timeout, not proven settlement: reject the interrupt and quarantine
        // the process so old generation output can never resurface.
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
          // The interrupt never reached the process: unproven cancellation.
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

      // Settle any outstanding start/turn work first. Reject a pending interrupt
      // explicitly before failing the turn so it never resolves as a successful
      // cancellation on the way out.
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
    // Decode incrementally so multi-byte UTF-8 characters split across chunk
    // boundaries are reassembled correctly.
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
      // Non-JSON stray output — ignore rather than crash the stream.
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
        // Completed assistant message duplicates already-streamed deltas.
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
      // The process refused to cancel: its current generation keeps running.
      // Reject the interrupt, fail the turn, and quarantine so that old output
      // can neither surface nor be attributed to a replacement turn.
      this.settleInterrupt(interrupt, new Error(message));
      this.failPending(new Error(message), { unproven: true });
      return;
    }
    // Acknowledged. The turn still has to settle; that settlement (or the
    // bounded settle timer) is what finally resolves the interrupt.
    if (!this.pending) this.settleInterrupt(interrupt, undefined);
  }

  private handleStreamEvent(msg: CliMessage): void {
    // Ignore anything originating from a nested sub-agent turn.
    if (msg.parent_tool_use_id != null) return;
    // Fence a generation that is being interrupted: its late deltas belong to
    // the aborted turn, not to any replacement.
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
          if (this.seenToolIds.has(callId)) return;
          this.seenToolIds.add(callId);
          const active: ActiveTool = { callId, name, startMs: Date.now() };
          this.activeTools.set(callId, active);
          if (!this.turnHadTool) {
            this.lastTextBeforeTool = this.turnText;
          }
          this.turnHadTool = true;
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
          this.turnText += delta.text;
        }
        return;
      }
      default:
        return;
    }
  }

  private handleToolResults(msg: CliMessage): void {
    if (msg.parent_tool_use_id != null || this.suppressStream) return;
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
          const active = this.activeTools.get(id);
          if (!active) continue; // duplicate, cancelled, or unrelated result
          this.activeTools.delete(id);
          const isError = (block as { is_error?: unknown }).is_error === true;
          const { status, reason, statusCode } = this.classifyToolResult(block, isError);
          const durationMs = Math.max(0, Date.now() - active.startMs);
          this.emit({ type: 'tool', name: active.name, status, callId: id, durationMs, reason, statusCode });
        }
      }
    }
  }

  private classifyToolResult(
    block: unknown,
    isError: boolean,
  ): { status: DiagnosticToolStatus; reason?: DiagnosticReason; statusCode?: number } {
    const content = (block as { content?: unknown }).content;
    const texts = typeof content === 'string' ? [content] : Array.isArray(content)
      ? content.flatMap(value => value && typeof value.text === 'string' ? [value.text] : []) : [];
    // A successful MCP transport can still carry an integration failure or a
    // pending approval. Inspect structured envelopes before trusting is_error.
    for (const text of texts) {
      let value: unknown;
      try { value = JSON.parse(text); } catch { continue; }
      for (let depth = 0; depth < 3 && value && typeof value === 'object' && !Array.isArray(value); depth++) {
        const item = value as Record<string, unknown>;
        const statusCode = [item.statusCode, item.status, item.http_status].find(code => typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599) as number | undefined;
        if (item.status === 'pending_approval' || item.status === 'approval_required') {
          return { status: 'pending', reason: 'approval_required', statusCode };
        }
        const failed = item.ok === false || item.success === false || (item.error != null && item.error !== false && item.error !== '')
          || ['error', 'failed', 'denied'].includes(String(item.status)) || (statusCode !== undefined && statusCode >= 400);
        if (failed) {
          const error = item.error && typeof item.error === 'object' ? item.error as Record<string, unknown> : undefined;
          const code = typeof error?.code === 'string' ? error.code : typeof item.code === 'string' ? item.code : '';
          const reason: DiagnosticReason = statusCode === 401 || statusCode === 403 || /auth|unauthorized/i.test(code) ? 'authentication'
            : statusCode === 404 ? 'not_found' : statusCode === 429 || /rate_limit/i.test(code) ? 'rate_limited'
            : /timeout/i.test(code) ? 'timeout' : /network|connection/i.test(code) ? 'network'
            : statusCode && statusCode >= 500 ? 'provider' : 'unknown';
          return { status: item.status === 'denied' || statusCode === 403 ? 'denied' : 'failed', reason, statusCode };
        }
        value = item.result;
      }
    }
    if (!isError) return { status: 'done' };
    const text = texts.join(' ');
    if (/\b(denied|not allowed|blocked)\b|tool not permitted/i.test(text)) return { status: 'denied', reason: 'policy_denied' };
    return { status: 'failed', reason: 'unknown' };
  }

  private handleResult(msg: CliMessage): void {
    if (msg.is_error === true || msg.subtype === 'error') {
      const message = this.readMessage(msg) ?? 'Harness turn failed.';
      this.emit({ type: 'error', message });
      this.failPending(new Error(message));
      return;
    }
    if (!this.pending) {
      // Duplicate or stale result after the turn already settled — drop it.
      return;
    }
    if (this.quarantined || this.suppressStream) {
      this.failPending(new Error('Result arrived on a quarantined or interrupted generation.'));
      return;
    }
    // Timing/turn metadata mirrors the CLI transcript record; never the text or usage payload.
    this.emit({ type: 'result', durationMs: safeCount(msg.duration_ms), numTurns: safeCount(msg.num_turns) });
    if (this.options.onResult) {
      const resultText = typeof msg.result === 'string' ? msg.result.trim() : '';
      if (resultText.length > 0) {
        try { this.options.onResult(resultText); } catch { /* consumer error */ }
      }
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

  private settleActiveTools(status: 'cancelled' | 'failed'): void {
    for (const [id, active] of this.activeTools) {
      const durationMs = Math.max(0, Date.now() - active.startMs);
      this.emit({ type: 'tool', name: active.name, status, callId: id, durationMs, reason: status === 'cancelled' ? 'cancelled' : 'unknown' });
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
    this.settleActiveTools(this.pendingInterrupt ? 'cancelled' : 'failed');
    const pending = this.pending;
    if (!pending || pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending = undefined;
    // A turn that finishes on its own also completes a pending interrupt.
    if (this.pendingInterrupt) this.settleInterrupt(this.pendingInterrupt, undefined);
    pending.resolve();
  }

  /**
   * Fail the pending turn. `unproven` marks a local failure (turn/interrupt
   * timeout, failed write, explicit interrupt rejection) that is NOT proven
   * process-side settlement: cancellation cannot be assumed, so any outstanding
   * interrupt is rejected and the subprocess is quarantined. A proven
   * settlement (a real result/error line/exit from the process) instead
   * completes an outstanding interrupt successfully.
   */
  private failPending(error: Error, opts: { unproven?: boolean } = {}): void {
    const interrupt = this.pendingInterrupt;
    if (opts.unproven) {
      if (interrupt && !interrupt.settled) this.settleInterrupt(interrupt, error);
      this.quarantineProcess();
    } else if (interrupt) {
      // The aborted turn has genuinely settled: the interrupt is complete.
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

  /**
   * Tear down a subprocess whose current generation was never confirmed to have
   * stopped. The stream fence stays raised so any straggler output is dropped,
   * and the harness is marked unusable so a replacement `send()` cannot lift the
   * fence over still-live old generation.
   */
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

  /** Resolve or reject an outstanding interrupt exactly once, clearing timers. */
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
