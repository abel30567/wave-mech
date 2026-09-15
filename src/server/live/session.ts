import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HarnessEvent, HarnessOptions, HarnessSession } from '../../shared/contracts.js';
import {
  GPT_LIVE_VOICE_MODEL,
  GPT_LIVE_BACKEND_MODEL,
  GPT_LIVE_MAX_SESSION_SECONDS,
  GPT_LIVE_PRICE_PER_MINUTE,
  type GptLiveTrialStatus,
  type GptLiveDiagnostics,
  type GptLiveTranscriptEntry,
} from '../../shared/gpt-live-trial.js';
import { GptLiveBudget } from './budget.js';
import { createHarness } from '../harness/index.js';
import { harnessEnvironmentOverrides } from '../harness-environment.js';
import { buildToolArguments, permissionHookSource } from '../security/access-policy.js';
import { createLiveProvider, type LiveProvider, type SidebandHandle } from './provider.js';

const MAX_TRANSCRIPT_ENTRIES = 500;
const CLOSURE_TIMEOUT_MS = 15_000;
const MAX_DELEGATION_QUEUE = 10;
const DELEGATION_INPUT_TIMEOUT_MS = 3_000;
const MAX_COMMENTARY_CHUNK_BYTES = 500;

export type HarnessFactory = (options: HarnessOptions) => HarnessSession;

export interface GptLiveManagerOptions {
  enabled: boolean;
  apiKeyFile: string;
  budgetFile: string;
  maxSessionSeconds: number;
  fermiUrl?: string;
  configuredModel: string;
  nodeExecutable: string;
  providerFactory?: (apiKey: string) => LiveProvider;
  harnessFactory?: HarnessFactory;
}

export interface GptLiveSessionCallbacks {
  onTranscriptDelta(entry: GptLiveTranscriptEntry): void;
  onDelegationCreated(delegationId: string, offsetMs: number): void;
  onUsageUpdate(voiceSeconds: number, estimatedCostUsd: number): void;
  onSessionClosed(reason: string, confirmed: boolean): void;
  onError(message: string): void;
}

interface ActiveTrialSession {
  sessionId: string;
  providerSessionId: string | null;
  ownerId: string;
  startedAt: number;
  deadline: ReturnType<typeof setTimeout>;
  harness: ReturnType<typeof createHarness> | null;
  workspace: string | null;
  harnessReady: boolean;
  pendingDelegation: string | null;
  delegationQueue: string[];
  processedDelegationIds: Set<string>;
  pendingResult: string | null;
  sendSettling: boolean;
  inputWaiters: Array<() => void>;
  transcript: GptLiveTranscriptEntry[];
  cumulativeVoiceSeconds: number;
  connectedTimeEstimate: number;
  closureConfirmed: boolean | null;
  closureReason: string | null;
  closing: boolean;
  closingPromise: Promise<void> | null;
  closingResolve: (() => void) | null;
  provider: LiveProvider | null;
  sidebandHandle: SidebandHandle | null;
  closureTimer: ReturnType<typeof setTimeout> | null;
  callbacks: GptLiveSessionCallbacks;
}

export class GptLiveManager {
  private readonly options: GptLiveManagerOptions;
  private readonly budget: GptLiveBudget;
  private apiKey: string | null = null;
  private active: ActiveTrialSession | null = null;
  private slotTaken = false;

  constructor(options: GptLiveManagerOptions) {
    this.options = {
      ...options,
      maxSessionSeconds: Math.min(
        options.maxSessionSeconds,
        GPT_LIVE_MAX_SESSION_SECONDS,
      ),
    };
    this.budget = new GptLiveBudget(options.budgetFile);
  }

  async initialize(): Promise<void> {
    await this.budget.load();
    const orphans = this.budget.reconcileOrphans();
    if (orphans > 0) await this.budget.save();
    if (this.options.enabled) {
      await this.loadApiKey();
    }
  }

  private async safeSave(): Promise<void> {
    try {
      await this.budget.save();
    } catch {
      // save() already latches _saveFailed, which blocks new sessions via hasUncertainClosure
    }
  }

  private async loadApiKey(): Promise<void> {
    try {
      const keyPath = this.options.apiKeyFile;
      const metadata = await stat(keyPath);
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
        return;
      }
      this.apiKey = (await readFile(keyPath, 'utf8')).trim();
      if (!this.apiKey || this.apiKey.length < 10) {
        this.apiKey = null;
      }
    } catch {
      this.apiKey = null;
    }
  }

  get status(): GptLiveTrialStatus {
    return {
      enabled: this.options.enabled,
      hasApiKey: this.apiKey !== null,
      budgetRemainingUsd: this.budget.remainingUsd,
      maxSessionSeconds: this.options.maxSessionSeconds,
    };
  }

  get isEnabled(): boolean {
    return this.options.enabled;
  }

  get hasActiveSession(): boolean {
    return this.active !== null || this.slotTaken;
  }

  validateSessionRequest(ownerId: string, sdp: string, durationSeconds?: number): string | null {
    if (!this.options.enabled) return 'GPT-Live trial is not enabled.';
    if (!this.apiKey) return 'GPT-Live API key is not configured.';
    if (this.active || this.slotTaken) {
      if (this.active && this.active.ownerId !== ownerId) return 'Another user owns the active trial session.';
      return 'A trial session is already active.';
    }
    if (!sdp || typeof sdp !== 'string' || sdp.length > 65536) {
      return 'Invalid session offer.';
    }
    if (durationSeconds !== undefined) {
      if (!Number.isInteger(durationSeconds) || durationSeconds <= 0 || durationSeconds > GPT_LIVE_MAX_SESSION_SECONDS) {
        return 'Invalid session duration.';
      }
    }
    if (this.budget.isReconciliationPending) {
      return 'Trial budget exhausted.';
    }
    if (!this.budget.canReserve(this.options.maxSessionSeconds)) {
      return 'Trial budget exhausted.';
    }
    return null;
  }

  async createSession(
    ownerId: string,
    sdp: string,
    origin: string,
    callbacks: GptLiveSessionCallbacks,
  ): Promise<{ sessionId: string; sdp: string }> {
    const validationError = this.validateSessionRequest(ownerId, sdp);
    if (validationError) throw new Error(validationError);

    this.slotTaken = true;

    const sessionId = randomUUID();
    this.budget.reserve(sessionId, this.options.maxSessionSeconds);
    await this.budget.save();

    let workspace: string | null = null;
    let harness: ReturnType<typeof createHarness> | null = null;
    let provider: LiveProvider | null = null;
    let creationAttempted = false;

    try {
      workspace = await mkdtemp(path.join(tmpdir(), 'wave-live-'));
      const hookFile = path.join(workspace, 'tool-policy.mjs');
      await writeFile(hookFile, permissionHookSource(), { mode: 0o600 });

      const harnessOptions: HarnessOptions = {
        command: process.env.WAVE_CLAUDE_BIN ?? 'claude',
        env: harnessEnvironmentOverrides(),
        onEvent: (event: HarnessEvent) => this.handleHarnessEvent(sessionId, event),
        onResult: (text: string) => this.handleHarnessResult(sessionId, text),
        args: [
          '-p', '--model', this.options.configuredModel,
          '--input-format', 'stream-json', '--output-format', 'stream-json',
          '--include-partial-messages', '--verbose', '--setting-sources', '',
          ...(this.options.fermiUrl
            ? buildToolArguments({
                fermiUrl: this.options.fermiUrl,
                nodeExecutable: this.options.nodeExecutable,
                hookFile,
              })
            : [
                '--tools', 'WebSearch,WebFetch',
                '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
                '--permission-mode', 'dontAsk',
                '--allowedTools', 'WebSearch', 'WebFetch',
              ]),
          '--append-system-prompt',
          'You are a concise, natural voice conversation partner. Keep replies short and speakable. The user authorizes automatic use of all registered Fermi tools for actions they request, including consequential actions; no app-layer tool confirmation is required. Local shell and filesystem tools are unavailable. Fermi service restrictions still apply. Use Fermi secure credential injection/references, never retrieve or print secret values. Report the actual tool failure honestly.',
        ],
        cwd: workspace,
      };

      const makeHarness = this.options.harnessFactory ?? createHarness;
      harness = makeHarness(harnessOptions);
      await harness.start();

      const factory = this.options.providerFactory ?? ((key: string) => createLiveProvider(key));
      provider = factory(this.apiKey!);

      const clientEventRestrictions: string[] = [
        'session.input_audio.mute',
        'session.input_audio.unmute',
      ];

      const instructions = [
        'You are a voice assistant backed by Claude Code. When a task requires computation, data retrieval, or external actions, delegate to the backend.',
        'Keep spoken responses concise. Do not repeat tool outputs verbatim.',
      ].join(' ');

      this.budget.markCreationAttempted(sessionId);
      await this.budget.save();
      creationAttempted = true;

      const result = await provider.createSession(sdp, instructions, clientEventRestrictions);

      this.budget.setProviderSessionId(sessionId, result.providerSessionId);
      await this.budget.save();

      const deadline = setTimeout(() => {
        void this.closeSession(sessionId, 'deadline');
      }, this.options.maxSessionSeconds * 1000);
      if (typeof deadline.unref === 'function') deadline.unref();

      this.active = {
        sessionId,
        providerSessionId: result.providerSessionId,
        ownerId,
        startedAt: Date.now(),
        deadline,
        harness,
        workspace,
        harnessReady: true,
        pendingDelegation: null,
        delegationQueue: [],
        processedDelegationIds: new Set(),
        pendingResult: null,
        sendSettling: false,
        inputWaiters: [],
        transcript: [],
        cumulativeVoiceSeconds: 0,
        connectedTimeEstimate: 0,
        closureConfirmed: null,
        closureReason: null,
        closing: false,
        closingPromise: null,
        closingResolve: null,
        provider,
        sidebandHandle: null,
        closureTimer: null,
        callbacks,
      };

      void this.attachSideband(sessionId);

      return { sessionId, sdp: result.answerSdp };
    } catch (error) {
      if (!creationAttempted) {
        this.budget.releaseUnstartedReservation(sessionId);
      } else {
        const hasProviderSession = this.budget.snapshot.reservations.some(
          r => r.sessionId === sessionId && r.providerSessionId !== null,
        );
        this.budget.finalize(sessionId, 0, !hasProviderSession);
      }
      try { await this.budget.save(); } catch { /* save failure already latched */ }
      if (provider) provider.destroy();
      if (harness) { try { await harness.close(); } catch { /* ignore */ } }
      if (workspace) await rm(workspace, { recursive: true, force: true });
      this.slotTaken = false;
      const safeMessage = error instanceof Error
        ? sanitizeErrorMessage(error.message)
        : 'Session creation failed.';
      throw new Error(safeMessage);
    }
  }

  private async attachSideband(sessionId: string): Promise<void> {
    if (!this.active || this.active.sessionId !== sessionId) return;
    const session = this.active;
    if (!session.provider || !session.providerSessionId) return;

    try {
      session.sidebandHandle = await session.provider.attachSideband(
        session.providerSessionId,
        {
          onInputTranscript: (delta) => {
            this.handleInputTranscript(delta);
          },
          onOutputTranscript: (delta) => {
            this.handleOutputTranscript(delta);
          },
          onDelegationCreated: (delegationId, offsetMs) => {
            this.handleDelegationCreated(delegationId, offsetMs);
          },
          onUsageUpdate: (seconds) => {
            this.handleUsageUpdate(seconds);
          },
          onSessionClosed: (reason, usage) => {
            this.handleProviderClosed(sessionId, reason, usage.seconds);
          },
          onError: (_code, _message) => {
            if (this.active && this.active.sessionId === sessionId) {
              session.callbacks.onError('Provider error occurred.');
              void this.closeSession(sessionId, 'sideband_error');
            }
          },
        },
      );
    } catch {
      session.callbacks.onError('Failed to attach sideband connection.');
      void this.closeSession(sessionId, 'sideband_failure');
    }
  }

  private handleProviderClosed(sessionId: string, reason: string, finalSeconds: number): void {
    if (!this.active || this.active.sessionId !== sessionId) return;
    const session = this.active;

    const validFinalSeconds = typeof finalSeconds === 'number'
      && Number.isFinite(finalSeconds) && finalSeconds >= 0;
    if (validFinalSeconds) {
      session.cumulativeVoiceSeconds = Math.max(session.cumulativeVoiceSeconds, finalSeconds);
    } else {
      session.closureConfirmed = false;
      session.closureReason = reason;
      this.budget.finalize(sessionId, 0, false);
      void this.safeSave();
      void this.finishCleanup(sessionId);
      return;
    }

    session.closureConfirmed = true;
    session.closureReason = reason;

    if (session.closureTimer) {
      clearTimeout(session.closureTimer);
      session.closureTimer = null;
    }

    this.budget.confirmClosure(sessionId, session.cumulativeVoiceSeconds);
    void this.safeSave();

    void this.finishCleanup(sessionId);
  }

  private handleHarnessEvent(sessionId: string, event: HarnessEvent): void {
    if (!this.active || this.active.sessionId !== sessionId) return;
    const session = this.active;

    switch (event.type) {
      case 'ready':
        session.harnessReady = true;
        break;
      case 'text': {
        const entry: GptLiveTranscriptEntry = {
          role: 'assistant',
          text: event.text,
          source: 'backend',
          timestampMs: Date.now(),
        };
        this.pushTranscript(session, entry);
        session.callbacks.onTranscriptDelta(entry);
        break;
      }
      case 'tool':
        if (session.pendingDelegation && session.provider) {
          session.provider.sendThinking(
            'Backend is processing a tool call...',
            session.pendingDelegation,
          );
        }
        break;
      case 'error':
        session.callbacks.onError('Backend processing encountered an issue.');
        break;
    }
  }

  private handleHarnessResult(sessionId: string, text: string): void {
    if (!this.active || this.active.sessionId !== sessionId) return;
    const session = this.active;
    if (!session.pendingDelegation) return;
    session.pendingResult = text;
  }

  private pushTranscript(session: ActiveTrialSession, entry: GptLiveTranscriptEntry): void {
    session.transcript.push(entry);
    if (session.transcript.length > MAX_TRANSCRIPT_ENTRIES) {
      session.transcript.splice(0, session.transcript.length - MAX_TRANSCRIPT_ENTRIES);
    }
  }

  handleDelegationCreated(delegationId: string, offsetMs: number): void {
    if (!this.active || this.active.closing) return;
    const session = this.active;

    if (session.processedDelegationIds.has(delegationId)) return;
    if (session.processedDelegationIds.size > 1000) return;
    session.processedDelegationIds.add(delegationId);

    session.callbacks.onDelegationCreated(delegationId, offsetMs);

    if (session.pendingDelegation || session.sendSettling) {
      if (session.delegationQueue.length < MAX_DELEGATION_QUEUE) {
        session.delegationQueue.push(delegationId);
      }
      return;
    }

    session.pendingDelegation = delegationId;
    void this.processDelegation(session.sessionId, delegationId);
  }

  private async drainDelegationQueue(sessionId: string): Promise<void> {
    if (!this.active || this.active.sessionId !== sessionId) return;
    const session = this.active;
    if (session.closing) return;

    while (session.delegationQueue.length > 0) {
      const next = session.delegationQueue.shift()!;
      if (session.processedDelegationIds.has(next) && session.pendingResult !== null) {
        continue;
      }
      session.pendingDelegation = next;
      await this.processDelegation(sessionId, next);
      return;
    }
    session.pendingDelegation = null;
  }

  private async processDelegation(sessionId: string, delegationId: string): Promise<void> {
    if (!this.active || this.active.sessionId !== sessionId) return;
    const session = this.active;

    if (!session.harness || !session.harnessReady || session.closing) {
      session.pendingDelegation = null;
      void this.drainDelegationQueue(sessionId);
      return;
    }

    let userContext = this.assembleUserContext(session);

    if (!userContext) {
      userContext = await this.waitForInput(session, DELEGATION_INPUT_TIMEOUT_MS);
      if (!this.active || this.active.sessionId !== sessionId || session.closing) return;
    }

    if (!userContext) {
      session.pendingDelegation = null;
      void this.drainDelegationQueue(sessionId);
      return;
    }

    if (session.provider) {
      session.provider.sendThinking(
        'Processing your request with the backend...',
        delegationId,
      );
    }

    session.sendSettling = true;
    session.pendingResult = null;
    try {
      await session.harness.send(userContext);
    } catch (err) {
      session.sendSettling = false;
      try { session.callbacks.onError('Backend delegation processing failed.'); } catch { /* safe */ }
      session.pendingDelegation = null;
      void this.drainDelegationQueue(sessionId);
      return;
    }

    // send() resolved — the turn is complete. Deliver stored result as commentary.
    session.sendSettling = false;
    if (!this.active || this.active.sessionId !== sessionId) return;
    const resultText = session.pendingResult;
    session.pendingResult = null;

    if (resultText && session.provider && session.pendingDelegation) {
      try {
        this.sendChunkedCommentary(session.provider, resultText, session.pendingDelegation);
      } catch { /* provider send error is non-fatal */ }
    }

    session.pendingDelegation = null;
    void this.drainDelegationQueue(sessionId);
  }

  private sendChunkedCommentary(provider: LiveProvider, text: string, delegationId: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const chunks = splitUtf8Chunks(trimmed, MAX_COMMENTARY_CHUNK_BYTES);
    for (const chunk of chunks) {
      provider.sendCommentary(chunk, delegationId);
    }
  }

  private waitForInput(session: ActiveTrialSession, timeoutMs: number): Promise<string> {
    const existing = this.assembleUserContext(session);
    if (existing) return Promise.resolve(existing);

    return new Promise<string>((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        const idx = session.inputWaiters.indexOf(notify);
        if (idx >= 0) session.inputWaiters.splice(idx, 1);
        resolve(this.assembleUserContext(session));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      const notify = () => {
        if (resolved) return;
        const ctx = this.assembleUserContext(session);
        if (!ctx) return;
        resolved = true;
        clearTimeout(timer);
        const idx = session.inputWaiters.indexOf(notify);
        if (idx >= 0) session.inputWaiters.splice(idx, 1);
        resolve(ctx);
      };
      session.inputWaiters.push(notify);
    });
  }

  private assembleUserContext(session: ActiveTrialSession): string {
    const userEntries = session.transcript.filter(t => t.role === 'user');
    if (userEntries.length === 0) return '';
    const parts: string[] = [];
    let byteLen = 0;
    for (let i = userEntries.length - 1; i >= 0 && byteLen < 2000; i--) {
      const t = userEntries[i].text;
      if (!t) continue;
      parts.unshift(t);
      byteLen += Buffer.byteLength(t, 'utf8');
    }
    const text = parts.join('').trim();
    return text.length > 2000 ? text.slice(-2000) : text;
  }

  handleInputTranscript(delta: string): void {
    if (!this.active) return;
    const session = this.active;
    const entry: GptLiveTranscriptEntry = {
      role: 'user',
      text: delta,
      source: 'voice-model',
      timestampMs: Date.now(),
    };
    this.pushTranscript(session, entry);
    session.callbacks.onTranscriptDelta(entry);
    for (const waiter of session.inputWaiters.slice()) {
      try { waiter(); } catch { /* safe */ }
    }
  }

  handleOutputTranscript(delta: string): void {
    if (!this.active) return;
    const entry: GptLiveTranscriptEntry = {
      role: 'assistant',
      text: delta,
      source: 'voice-model',
      timestampMs: Date.now(),
    };
    this.pushTranscript(this.active, entry);
    this.active.callbacks.onTranscriptDelta(entry);
  }

  handleUsageUpdate(seconds: number): void {
    if (!this.active) return;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return;
    this.active.cumulativeVoiceSeconds = Math.max(this.active.cumulativeVoiceSeconds, seconds);
    this.active.connectedTimeEstimate = (Date.now() - this.active.startedAt) / 1000;
    const estimatedCost = (this.active.cumulativeVoiceSeconds / 60) * GPT_LIVE_PRICE_PER_MINUTE;
    this.active.callbacks.onUsageUpdate(this.active.cumulativeVoiceSeconds, estimatedCost);

    if (this.active.cumulativeVoiceSeconds >= this.options.maxSessionSeconds && !this.active.closing) {
      void this.closeSession(this.active.sessionId, 'budget_exceeded');
    }
  }

  async closeSession(sessionId: string, reason: string): Promise<void> {
    if (!this.active || this.active.sessionId !== sessionId) return;
    const session = this.active;
    if (session.closing) return;
    session.closing = true;

    clearTimeout(session.deadline);

    session.closingPromise = new Promise<void>(r => { session.closingResolve = r; });

    session.closureTimer = setTimeout(() => {
      if (!this.active || this.active.sessionId !== sessionId) return;
      if (session.closureConfirmed !== null) return;

      session.closureConfirmed = false;
      session.closureReason = reason;

      const conservativeSeconds = Math.max(
        session.cumulativeVoiceSeconds,
        session.connectedTimeEstimate,
      );
      this.budget.finalize(sessionId, conservativeSeconds, false);
      void this.safeSave();

      void this.finishCleanup(sessionId);
    }, CLOSURE_TIMEOUT_MS);
    if (typeof session.closureTimer.unref === 'function') session.closureTimer.unref();

    if (session.provider && session.providerSessionId) {
      try {
        session.provider.closeSession();
      } catch { /* best effort */ }
    }

    if (session.provider && session.providerSessionId) {
      try {
        await session.provider.hangup(session.providerSessionId);
      } catch { /* hangup is best-effort fallback */ }
    }
  }

  private async finishCleanup(sessionId: string): Promise<void> {
    if (!this.active || this.active.sessionId !== sessionId) return;
    const session = this.active;

    if (session.closureTimer) {
      clearTimeout(session.closureTimer);
      session.closureTimer = null;
    }

    if (session.sidebandHandle) {
      try { session.sidebandHandle.close(); } catch { /* ignore */ }
    }
    if (session.provider) {
      try { session.provider.destroy(); } catch { /* ignore */ }
    }
    if (session.harness) {
      try { await session.harness.close(); } catch { /* ignore */ }
    }
    if (session.workspace) {
      await rm(session.workspace, { recursive: true, force: true });
    }

    await this.safeSave();

    const confirmed = session.closureConfirmed === true;
    const closureReason = session.closureReason ?? 'unknown';
    const resolve = session.closingResolve;
    session.callbacks.onSessionClosed(closureReason, confirmed);
    this.active = null;
    this.slotTaken = false;
    if (resolve) resolve();
  }

  getDiagnostics(): GptLiveDiagnostics {
    const session = this.active;
    return {
      sessionId: session?.sessionId ?? null,
      voiceModel: GPT_LIVE_VOICE_MODEL,
      backendModel: GPT_LIVE_BACKEND_MODEL,
      cumulativeVoiceSeconds: session?.cumulativeVoiceSeconds ?? 0,
      estimatedCostUsd: session
        ? (session.cumulativeVoiceSeconds / 60) * GPT_LIVE_PRICE_PER_MINUTE
        : 0,
      closureConfirmed: session?.closureConfirmed ?? null,
      closureReason: session?.closureReason ?? null,
      delegationsProcessed: session?.processedDelegationIds.size ?? 0,
      delegationsSkipped: 0,
      transcript: session
        ? session.transcript.map(t => ({ ...t }))
        : [],
    };
  }

  async shutdown(): Promise<void> {
    if (!this.active) return;
    const session = this.active;
    const sessionId = session.sessionId;

    await this.closeSession(sessionId, 'shutdown');

    if (this.active && this.active.sessionId === sessionId) {
      if (session.closureTimer) {
        clearTimeout(session.closureTimer);
        session.closureTimer = null;
      }
      if (session.closureConfirmed === null) {
        session.closureConfirmed = false;
        session.closureReason = 'shutdown';
        const conservativeSeconds = Math.max(
          session.cumulativeVoiceSeconds,
          session.connectedTimeEstimate,
        );
        this.budget.finalize(sessionId, conservativeSeconds, false);
        void this.safeSave();
      }
      await this.finishCleanup(sessionId);
    }
  }
}

type SafeErrorCategory = 'budget_exhausted' | 'provider_unavailable' | 'session_conflict'
  | 'invalid_request' | 'not_enabled' | 'internal_error';

const SAFE_ERROR_MAP: Array<[RegExp, SafeErrorCategory, string]> = [
  [/budget/i, 'budget_exhausted', 'Trial budget exhausted.'],
  [/not enabled/i, 'not_enabled', 'GPT-Live trial is not enabled.'],
  [/not configured/i, 'not_enabled', 'GPT-Live API key is not configured.'],
  [/already active|session is active/i, 'session_conflict', 'A trial session is already active.'],
  [/another user/i, 'session_conflict', 'Another user owns the active trial session.'],
  [/invalid.*offer|invalid.*sdp/i, 'invalid_request', 'Invalid session offer.'],
];

function sanitizeErrorMessage(message: string): string {
  for (const [pattern, , safeMessage] of SAFE_ERROR_MAP) {
    if (pattern.test(message)) return safeMessage;
  }
  return 'Session creation failed.';
}

export function splitUtf8Chunks(text: string, maxBytes: number): string[] {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return [text];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < buf.length) {
    let end = Math.min(offset + maxBytes, buf.length);
    // Don't split inside a multi-byte UTF-8 character: back up to a leading byte.
    while (end > offset && (buf[end] & 0xc0) === 0x80) end--;
    if (end === offset) end = Math.min(offset + maxBytes, buf.length);
    chunks.push(buf.subarray(offset, end).toString('utf8'));
    offset = end;
  }
  return chunks;
}

export function createGptLiveManager(
  overrides: Partial<GptLiveManagerOptions> = {},
): GptLiveManager {
  const enabled = process.env.WAVE_GPT_LIVE_TRIAL_ENABLED === '1';
  return new GptLiveManager({
    enabled,
    apiKeyFile: process.env.WAVE_GPT_LIVE_API_KEY_FILE
      ?? path.resolve('.wave-mech/openai-live.key'),
    budgetFile: process.env.WAVE_GPT_LIVE_BUDGET_FILE
      ?? path.resolve('.wave-mech/gpt-live-budget.json'),
    maxSessionSeconds: Math.min(
      Number(process.env.WAVE_GPT_LIVE_MAX_SESSION_SECONDS) || GPT_LIVE_MAX_SESSION_SECONDS,
      GPT_LIVE_MAX_SESSION_SECONDS,
    ),
    fermiUrl: undefined,
    configuredModel: GPT_LIVE_BACKEND_MODEL,
    nodeExecutable: process.execPath,
    ...overrides,
  });
}
