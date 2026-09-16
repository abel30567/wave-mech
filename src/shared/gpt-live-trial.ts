import type { DiagnosticSnapshot } from './diagnostics.js';

export interface GptLiveTrialConfig {
  enabled: boolean;
  maxSessionSeconds: number;
  budgetUsedUsd: number;
  budgetCapUsd: number;
}

export interface GptLiveSessionRequest {
  sdp: string;
}

export interface GptLiveSessionResponse {
  sessionId: string;
  sdp: string;
}

export interface GptLiveTrialStatus {
  enabled: boolean;
  hasApiKey: boolean;
  budgetRemainingUsd: number;
  maxSessionSeconds: number;
}

export interface GptLiveDelegationEvent {
  type: 'delegation.created';
  delegationId: string;
  offsetMs: number;
}

export interface GptLiveTranscriptEntry {
  role: 'user' | 'assistant' | 'system';
  text: string;
  source: 'voice-model' | 'backend';
  timestampMs: number;
}

/** Why the application stopped the session; distinct from the provider's closure reason. */
export type GptLiveStopCause = 'user_ended' | 'deadline' | 'budget_exceeded' | 'provider_closed'
  | 'sideband_error' | 'sideband_failure' | 'shutdown' | 'unknown';

export type GptLiveDelegationStatus = 'queued' | 'waiting_input' | 'no_input' | 'running' | 'delivered'
  | 'no_result' | 'failed' | 'unfinished';

/** Bounded, opaque delegation lifecycle record: identifiers and timing only, never task text. */
export interface GptLiveDelegationRecord {
  delegationId: string;
  offsetMs: number;
  createdAt: number;
  sentAt?: number;
  settledAt?: number;
  status: GptLiveDelegationStatus;
}

export interface GptLiveDiagnostics {
  sessionId: string | null;
  providerSessionId?: string | null;
  voiceModel: string;
  backendModel: string;
  cumulativeVoiceSeconds: number;
  estimatedCostUsd: number;
  closureConfirmed: boolean | null;
  closureReason: string | null;
  delegationsProcessed: number;
  delegationsSkipped: number;
  transcript: GptLiveTranscriptEntry[];
  /** Configured session ceiling in seconds. */
  maxSessionSeconds?: number;
  startedAt?: number | null;
  endedAt?: number | null;
  deadlineAt?: number | null;
  /** Local stop cause; `closureReason` above is what the provider reported. */
  stopCause?: GptLiveStopCause | null;
  /** True when the session stopped while a backend delegation was still queued or running. */
  unfinishedDelegation?: boolean;
  /** Model the Claude Code harness reported on init, if any. */
  backendReportedModel?: string | null;
  delegations?: GptLiveDelegationRecord[];
  /** Timestamped structured lifecycle/tool/error records, same contract as default mode. */
  diagnostics?: DiagnosticSnapshot;
}

export const GPT_LIVE_VOICE_MODEL = 'gpt-live-1';
export const GPT_LIVE_BACKEND_MODEL = 'claude-opus-4-6[1m]';
export const GPT_LIVE_PRICE_PER_MINUTE = 0.05;
export const GPT_LIVE_MAX_BUDGET_USD = 5.0;
export const GPT_LIVE_MAX_SESSION_SECONDS = 300;
