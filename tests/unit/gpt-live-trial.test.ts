import { describe, expect, it } from 'vitest';
import {
  GPT_LIVE_VOICE_MODEL,
  GPT_LIVE_BACKEND_MODEL,
  GPT_LIVE_PRICE_PER_MINUTE,
  GPT_LIVE_MAX_BUDGET_USD,
  GPT_LIVE_MAX_SESSION_SECONDS,
  type GptLiveTrialConfig,
  type GptLiveTrialStatus,
  type GptLiveDiagnostics,
  type GptLiveTranscriptEntry,
} from '../../src/shared/gpt-live-trial.js';

describe('GPT-Live trial shared types and constants', () => {
  it('exports correct voice model identifier', () => {
    expect(GPT_LIVE_VOICE_MODEL).toBe('gpt-live-1');
  });

  it('exports correct backend model identifier', () => {
    expect(GPT_LIVE_BACKEND_MODEL).toBe('claude-opus-4-6[1m]');
  });

  it('uses documented price per minute', () => {
    expect(GPT_LIVE_PRICE_PER_MINUTE).toBe(0.05);
  });

  it('has $5 budget cap', () => {
    expect(GPT_LIVE_MAX_BUDGET_USD).toBe(5.0);
  });

  it('has 300 second maximum session duration', () => {
    expect(GPT_LIVE_MAX_SESSION_SECONDS).toBe(300);
  });

  it('calculates 5 minute session cost correctly', () => {
    const sessionMinutes = 5;
    const cost = sessionMinutes * GPT_LIVE_PRICE_PER_MINUTE;
    expect(cost).toBe(0.25);
    expect(cost).toBeLessThanOrEqual(GPT_LIVE_MAX_BUDGET_USD);
  });

  it('fills budget with exactly 100 minutes of voice', () => {
    const maxMinutes = GPT_LIVE_MAX_BUDGET_USD / GPT_LIVE_PRICE_PER_MINUTE;
    expect(maxMinutes).toBe(100);
  });

  it('creates valid trial status shape', () => {
    const status: GptLiveTrialStatus = {
      enabled: true,
      hasApiKey: true,
      budgetRemainingUsd: 4.75,
      maxSessionSeconds: 300,
    };
    expect(status.enabled).toBe(true);
    expect(status.maxSessionSeconds).toBeLessThanOrEqual(GPT_LIVE_MAX_SESSION_SECONDS);
  });

  it('creates valid diagnostics shape without secrets', () => {
    const diagnostics: GptLiveDiagnostics = {
      sessionId: 'test-session-id',
      voiceModel: GPT_LIVE_VOICE_MODEL,
      backendModel: GPT_LIVE_BACKEND_MODEL,
      cumulativeVoiceSeconds: 45.3,
      estimatedCostUsd: 0.0378,
      closureConfirmed: true,
      closureReason: 'close_requested',
      delegationsProcessed: 3,
      delegationsSkipped: 0,
      transcript: [
        { role: 'user', text: 'Hello', source: 'voice-model', timestampMs: 1000 },
        { role: 'assistant', text: 'Hi there', source: 'voice-model', timestampMs: 2000 },
        { role: 'assistant', text: 'Tool result', source: 'backend', timestampMs: 3000 },
      ],
    };
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('key');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('credential');
    expect(serialized).not.toContain('sdp');
    expect(serialized).not.toMatch(/\bICE\b/);
    expect(serialized).not.toMatch(/\bice_candidate\b/);
    expect(diagnostics.transcript).toHaveLength(3);
  });

  it('transcript entries distinguish voice model from backend source', () => {
    const voiceEntry: GptLiveTranscriptEntry = {
      role: 'assistant',
      text: 'Spoken by GPT-Live',
      source: 'voice-model',
      timestampMs: 1000,
    };
    const backendEntry: GptLiveTranscriptEntry = {
      role: 'assistant',
      text: 'Claude backend result',
      source: 'backend',
      timestampMs: 2000,
    };
    expect(voiceEntry.source).not.toBe(backendEntry.source);
  });

  it('disabled config does not require API key', () => {
    const config: GptLiveTrialConfig = {
      enabled: false,
      maxSessionSeconds: 300,
      budgetUsedUsd: 0,
      budgetCapUsd: 5,
    };
    expect(config.enabled).toBe(false);
  });
});
