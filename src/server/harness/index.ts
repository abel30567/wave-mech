import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { HarnessEvent, HarnessOptions, HarnessSession } from '../../shared/contracts.js';

/**
 * P1 harness adapter.
 *
 * Owns a single, persistent Claude Code CLI subprocess that speaks newline
 * delimited JSON (NDJSON) on stdin/stdout. It is deliberately half-duplex:
 * one manual turn is admitted at a time and `send()` settles only when the
 * CLI reports a whole-turn `result`.
 *
 * Only eligible top-level assistant text is streamed as `text` events. Thinking
 * blocks, tool-input JSON, sub-agent (nested `parent_tool_use_id`) output and
 * the trailing completed-message/result duplication are intentionally not
 * re-emitted as speech.
 */

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

/** Loose view of a CLI NDJSON line. The concrete schema is owned by the CLI. */
interface CliMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  tools?: unknown;
  parent_tool_use_id?: string | null;
  event?: CliStreamEvent;
  message?: { role?: string; content?: unknown };
  is_error?: boolean;
  error?: unknown;
  result?: unknown;
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

  private closePromise: Promise<void> | undefined;
  private closeResolve: (() => void) | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  private closing = false;

  /** Per-message map of content-block index -> block type (text/thinking/tool_use). */
  private blockTypes = new Map<number, string | undefined>();
  /** tool_use id -> tool name, used to pair running/done status events. */
  private toolNames = new Map<string, string>();

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
        this.failPending(new Error('Harness turn timed out.'));
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending = { resolve, reject, timer, settled: false };

      // Reset per-turn parsing state so a prior turn cannot leak indices.
      this.blockTypes.clear();

      const line = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      });
      const ok = this.child?.stdin?.write(`${line}\n`, (error) => {
        if (error) this.failPending(new Error('Failed to write turn to harness process.'));
      });
      if (ok === false) {
        // Backpressure is fine; the callback above still fires on flush/error.
      }
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;

    this.closePromise = new Promise<void>((resolve) => {
      this.closeResolve = resolve;

      // Settle any outstanding start/turn work first.
      this.settleStart(new Error('Harness closed before it became ready.'));
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
    const event: HarnessEvent = { type: 'ready' };
    if (typeof msg.session_id === 'string') event.sessionId = msg.session_id;
    if (tools) event.tools = tools;
    this.emit(event);
    this.settleStart(undefined);
  }

  private handleStreamEvent(msg: CliMessage): void {
    // Ignore anything originating from a nested sub-agent turn.
    if (msg.parent_tool_use_id != null) return;
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
          this.toolNames.set(block.id, name);
          this.emit({ type: 'tool', name, status: 'running' });
        }
        return;
      }
      case 'content_block_delta': {
        const index = typeof ev.index === 'number' ? ev.index : -1;
        const delta = ev.delta;
        // Only genuine top-level assistant text — never thinking_delta or
        // input_json_delta (tool arguments).
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
          this.emit({ type: 'tool', name, status: 'done' });
        }
      }
    }
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
    if (this.pending) {
      const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.failPending(new Error(`Harness process exited (${detail}) before completing the turn.`));
    }
    this.settleStart(new Error('Harness process exited before it became ready.'));
    this.finishClose();
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
    pending.resolve();
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    if (!pending || pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending = undefined;
    pending.reject(error);
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
