import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HarnessEvent, HarnessOptions } from '../../shared/contracts.js';
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

export interface GptLiveManagerOptions {
  enabled: boolean;
  apiKeyFile: string;
  budgetFile: string;
  maxSessionSeconds: number;
  fermiUrl?: string;
  configuredModel: string;
  nodeExecutable: string;
  providerFactory?: (apiKey: string) => LiveProvider;
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
  transcript: GptLiveTranscriptEntry[];
  cumulativeVoiceSeconds: number;
  connectedTimeEstimate: number;
  closureConfirmed: boolean | null;
  closureReason: string | null;
  closing: boolean;
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
    return this.active !== null;
  }

  validateSessionRequest(ownerId: string, sdp: string): string | null {
    if (!this.options.enabled) return 'GPT-Live trial is not enabled.';
    if (!this.apiKey) return 'GPT-Live API key is not configured.';
    if (this.active || this.slotTaken) {
      if (this.active && this.active.ownerId !== ownerId) return 'Another user owns the active trial session.';
      return 'A trial session is already active.';
    }
    if (!sdp || typeof sdp !== 'string' || sdp.length > 65536) {
      return 'Invalid session offer.';
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

    try {
      workspace = await mkdtemp(path.join(tmpdir(), 'wave-live-'));
      const hookFile = path.join(workspace, 'tool-policy.mjs');
      await writeFile(hookFile, permissionHookSource(), { mode: 0o600 });

      const harnessOptions: HarnessOptions = {
        command: process.env.WAVE_CLAUDE_BIN ?? 'claude',
        env: harnessEnvironmentOverrides(),
        onEvent: (event: HarnessEvent) => this.handleHarnessEvent(sessionId, event),
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

      harness = createHarness(harnessOptions);
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
        transcript: [],
        cumulativeVoiceSeconds: 0,
        connectedTimeEstimate: 0,
        closureConfirmed: null,
        closureReason: null,
        closing: false,
        provider,
        sidebandHandle: null,
        closureTimer: null,
        callbacks,
      };

      void this.attachSideband(sessionId);

      return { sessionId, sdp: result.answerSdp };
    } catch (error) {
      this.budget.finalize(sessionId, 0, false);
      await this.budget.save();
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
          onError: (_code, message) => {
            if (this.active && this.active.sessionId === sessionId) {
              session.callbacks.onError('Provider error occurred.');
            }
          },
        },
      );
    } catch {
      session.callbacks.onError('Failed to attach sideband connection.');
    }
  }

  private handleProviderClosed(sessionId: string, reason: string, finalSeconds: number): void {
    if (!this.active || this.active.sessionId !== sessionId) return;
    const session = this.active;

    session.cumulativeVoiceSeconds = Math.max(session.cumulativeVoiceSeconds, finalSeconds);
    session.closureConfirmed = true;
    session.closureReason = reason;

    if (session.closureTimer) {
      clearTimeout(session.closureTimer);
      session.closureTimer = null;
    }

    this.budget.finalize(sessionId, session.cumulativeVoiceSeconds, true);
    void this.budget.save();

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

        if (session.pendingDelegation && session.provider && event.text.length > 0) {
          const commentary = event.text.slice(0, 2000);
          session.provider.sendCommentary(commentary, session.pendingDelegation);
          session.pendingDelegation = null;
          void this.drainDelegationQueue(sessionId);
        }
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

  private pushTranscript(session: ActiveTrialSession, entry: GptLiveTranscriptEntry): void {
    session.transcript.push(entry);
    if (session.transcript.length > MAX_TRANSCRIPT_ENTRIES) {
      session.transcript.splice(0, session.transcript.length - MAX_TRANSCRIPT_ENTRIES);
    }
  }

  handleDelegationCreated(delegationId: string, offsetMs: number): void {
    if (!this.active) return;
    const session = this.active;

    if (session.processedDelegationIds.has(delegationId)) return;
    session.processedDelegationIds.add(delegationId);

    session.callbacks.onDelegationCreated(delegationId, offsetMs);

    if (session.pendingDelegation) {
      session.delegationQueue.push(delegationId);
      return;
    }

    session.pendingDelegation = delegationId;
    void this.processDelegation(session.sessionId, delegationId);
  }

  private async drainDelegationQueue(sessionId: string): Promise<void> {
    if (!this.active || this.active.sessionId !== sessionId) return;
    const session = this.active;

    const next = session.delegationQueue.shift();
    if (!next) return;

    session.pendingDelegation = next;
    void this.processDelegation(sessionId, next);
  }

  private async processDelegation(sessionId: string, delegationId: string): Promise<void> {
    if (!this.active || this.active.sessionId !== sessionId) return;
    const session = this.active;

    if (!session.harness || !session.harnessReady) {
      session.pendingDelegation = null;
      void this.drainDelegationQueue(sessionId);
      return;
    }

    const userContext = session.transcript
      .filter(t => t.role === 'user')
      .slice(-3)
      .map(t => t.text)
      .join(' ')
      .trim();

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

    try {
      await session.harness.send(userContext);
    } catch {
      session.callbacks.onError('Backend delegation processing failed.');
      session.pendingDelegation = null;
      void this.drainDelegationQueue(sessionId);
    }
  }

  handleInputTranscript(delta: string): void {
    if (!this.active) return;
    const entry: GptLiveTranscriptEntry = {
      role: 'user',
      text: delta,
      source: 'voice-model',
      timestampMs: Date.now(),
    };
    this.pushTranscript(this.active, entry);
    this.active.callbacks.onTranscriptDelta(entry);
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
    this.active.cumulativeVoiceSeconds = Math.max(this.active.cumulativeVoiceSeconds, seconds);
    this.active.connectedTimeEstimate = (Date.now() - this.active.startedAt) / 1000;
    const estimatedCost = (this.active.cumulativeVoiceSeconds / 60) * GPT_LIVE_PRICE_PER_MINUTE;
    this.active.callbacks.onUsageUpdate(this.active.cumulativeVoiceSeconds, estimatedCost);
  }

  async closeSession(sessionId: string, reason: string): Promise<void> {
    if (!this.active || this.active.sessionId !== sessionId) return;
    const session = this.active;
    if (session.closing) return;
    session.closing = true;

    clearTimeout(session.deadline);

    if (session.provider && session.providerSessionId) {
      try {
        session.provider.closeSession();
      } catch { /* best effort */ }
    }

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
      void this.budget.save();

      void this.finishCleanup(sessionId);
    }, CLOSURE_TIMEOUT_MS);
    if (typeof session.closureTimer.unref === 'function') session.closureTimer.unref();

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

    const confirmed = session.closureConfirmed === true;
    const closureReason = session.closureReason ?? 'unknown';
    session.callbacks.onSessionClosed(closureReason, confirmed);
    this.active = null;
    this.slotTaken = false;
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
    if (this.active) {
      await this.closeSession(this.active.sessionId, 'shutdown');
    }
  }
}

function sanitizeErrorMessage(message: string): string {
  const redacted = message
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/v=0[\s\S]*?(?=\n\n|\r\n\r\n|$)/g, '[SDP_REDACTED]')
    .replace(/a=ice-[^\r\n]*/g, '[ICE_REDACTED]')
    .replace(/Bearer [^\s"]+/g, 'Bearer [REDACTED]');
  return redacted.length > 200 ? redacted.slice(0, 200) : redacted;
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
