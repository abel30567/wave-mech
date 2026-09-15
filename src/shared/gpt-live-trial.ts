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

export interface GptLiveDiagnostics {
  sessionId: string | null;
  voiceModel: string;
  backendModel: string;
  cumulativeVoiceSeconds: number;
  estimatedCostUsd: number;
  closureConfirmed: boolean | null;
  closureReason: string | null;
  delegationsProcessed: number;
  delegationsSkipped: number;
  transcript: GptLiveTranscriptEntry[];
}

export const GPT_LIVE_VOICE_MODEL = 'gpt-live-1';
export const GPT_LIVE_BACKEND_MODEL = 'claude-opus-4-6[1m]';
export const GPT_LIVE_PRICE_PER_MINUTE = 0.05;
export const GPT_LIVE_MAX_BUDGET_USD = 5.0;
export const GPT_LIVE_MAX_SESSION_SECONDS = 300;
