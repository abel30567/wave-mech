import { safeDiagnostic, type DiagnosticSnapshot } from '../shared/diagnostics.js';
import type { TranscriptEntry } from '../shared/realtime.js';
import type { GptLiveDiagnostics, GptLiveStopCause } from '../shared/gpt-live-trial.js';

export interface TranscriptReport {
  messages: TranscriptEntry[];
  diagnostics: DiagnosticSnapshot;
  capturedAt: number;
  mode?: 'live' | 'fixture';
  configuredModel?: string;
  reportedModel?: string;
  buildId?: string;
  browser?: { family: string; platform: string; online: boolean; visible: boolean; width: number; height: number };
  gptLiveTrial?: GptLiveDiagnostics;
}

/** Best-effort protection for conversation text; tool payloads never enter the report. */
export function redactTranscript(text: string): string {
  return text
    .replace(/https?:\/\/[^\s<>"')]+/gi, value => {
      try {
        const url = new URL(value);
        if (!url.username && !url.password && !url.search && !url.hash) return value;
        return `${url.origin}${url.pathname} [URL credentials/query/fragment omitted]`;
      } catch { return '[URL omitted]'; }
    })
    .replace(/\b(?:sk-(?:ant-)?[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,}|github_pat_[a-zA-Z0-9_]{12,}|xox[baprs]-[a-zA-Z0-9-]{12,})\b/g, '[credential redacted]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[token redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[a-zA-Z0-9+/_.=-]+/gi, '[authorization redacted]')
    .replace(/\b(?:authorization|cookie|set-cookie)\s*:[^\r\n]*/gi, '[header redacted]')
    .replace(/\b((?:[a-z0-9_]*(?:api[_-]?key|token|password|secret))\s*[=:]\s*)["']?[^\s,;"']+["']?/gi, '$1[redacted]');
}

/** Transcript entries that look like raw SDP/ICE or credential material are dropped outright. */
export function looksLikeRawPayload(text: string): boolean {
  return /v=0\r?\no=|a=candidate:|a=ice-ufrag:|a=ice-pwd:|a=fingerprint:/.test(text)
    || /sk-[a-zA-Z0-9_-]{8,}|Bearer [a-zA-Z0-9._-]+|authorization:\s/i.test(text);
}

function modelLabel(value?: string | null): string {
  return value && /^claude-[a-z0-9.[\]-]{1,80}$/.test(value) ? value : 'not reported';
}

const MAX_TIME = 8640000000000000;
function isoTime(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIME ? new Date(value).toISOString() : 'unknown-time';
}
function isoOrNone(value: unknown): string {
  return typeof value === 'number' ? isoTime(value) : 'not reported';
}
function offsetLabel(base: number | undefined, value: number | undefined): string {
  return typeof base === 'number' && typeof value === 'number' && Number.isFinite(value - base) ? `+${Math.max(0, Math.round(value - base))}ms` : 'none';
}
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const STOP_CAUSES: ReadonlySet<GptLiveStopCause> = new Set(['user_ended', 'deadline', 'budget_exceeded', 'provider_closed', 'sideband_error', 'sideband_failure', 'shutdown', 'unknown']);
const DELEGATION_STATUSES = new Set(['queued', 'waiting_input', 'no_input', 'running', 'delivered', 'no_result', 'failed', 'unfinished']);

function trialLines(trial: GptLiveDiagnostics): string[] {
  const seconds = Number.isFinite(trial.cumulativeVoiceSeconds) ? trial.cumulativeVoiceSeconds : 0;
  const cost = Number.isFinite(trial.estimatedCostUsd) ? trial.estimatedCostUsd : 0;
  const closureReason = typeof trial.closureReason === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(trial.closureReason) ? trial.closureReason : 'none';
  const stopCause = trial.stopCause && STOP_CAUSES.has(trial.stopCause) ? trial.stopCause : 'not reported';
  const lines = ['', 'GPT-LIVE TRIAL',
    `Voice model: ${trial.voiceModel === 'gpt-live-1' ? trial.voiceModel : 'not reported'}`,
    `Backend model: ${modelLabel(trial.backendModel)}`,
    `Backend-reported model: ${modelLabel(trial.backendReportedModel)}`,
    `Session: ${typeof trial.sessionId === 'string' && ID_RE.test(trial.sessionId) ? trial.sessionId : 'none'}`,
    `Session limit: ${typeof trial.maxSessionSeconds === 'number' && Number.isFinite(trial.maxSessionSeconds) ? `${Math.round(trial.maxSessionSeconds)}s` : 'not reported'}`,
    `Started: ${isoOrNone(trial.startedAt)}`,
    `Deadline: ${isoOrNone(trial.deadlineAt)}`,
    `Ended: ${isoOrNone(trial.endedAt)}`,
    `Stop cause (app): ${stopCause}`,
    `Provider closure reason: ${closureReason}`,
    `Closure confirmed: ${trial.closureConfirmed}`,
    `Unfinished backend task at stop: ${trial.unfinishedDelegation === true ? 'yes' : trial.unfinishedDelegation === false ? 'no' : 'not reported'}`,
    `Cumulative voice: ${seconds.toFixed(1)}s`,
    `Estimated cost: $${cost.toFixed(4)}`,
    `Delegations processed: ${Number.isFinite(trial.delegationsProcessed) ? trial.delegationsProcessed : 0}`,
    `Delegations skipped: ${Number.isFinite(trial.delegationsSkipped) ? trial.delegationsSkipped : 0}`,
  ];
  const delegations = Array.isArray(trial.delegations) ? trial.delegations.slice(-50) : [];
  if (delegations.length) {
    lines.push('', 'GPT-LIVE DELEGATIONS');
    for (const record of delegations) {
      const id = typeof record?.delegationId === 'string' && ID_RE.test(record.delegationId) ? record.delegationId : 'unknown';
      const status = DELEGATION_STATUSES.has(record?.status) ? record.status : 'unknown';
      const offset = Number.isFinite(record?.offsetMs) ? `${Math.round(record.offsetMs)}ms` : 'none';
      lines.push(`${isoTime(record?.createdAt)} [delegation:${id}] status=${status} offset=${offset} sent=${offsetLabel(record?.createdAt, record?.sentAt)} settled=${offsetLabel(record?.createdAt, record?.settledAt)}`);
    }
  }
  const transcript = Array.isArray(trial.transcript) ? trial.transcript.slice(-200) : [];
  if (transcript.length) {
    lines.push('', 'GPT-LIVE TRANSCRIPT');
    for (const entry of transcript) {
      if (typeof entry?.text !== 'string' || looksLikeRawPayload(entry.text)) continue;
      const source = entry.source === 'backend' ? 'backend' : 'voice-model';
      const role = entry.role === 'user' ? 'user' : entry.role === 'system' ? 'system' : 'assistant';
      lines.push(`${isoTime(entry.timestampMs)} [${source}] ${role}: ${redactTranscript(entry.text).slice(0, 2000)}`);
    }
  }
  return lines;
}

export function formatTranscriptReport(report: TranscriptReport): string {
  const build = report.buildId && /^[a-zA-Z0-9_.+-]{1,100}$/.test(report.buildId) ? report.buildId : 'not reported';
  const lines = [
    'wave-mech — conversation and diagnostics',
    'Report format: 2',
    `Captured: ${new Date(report.capturedAt).toISOString()}`,
    `Build: ${build}`,
    `Mode: ${report.mode === 'fixture' ? 'synthetic test' : report.mode === 'live' ? 'live' : 'not reported'}`,
    `Configured model: ${modelLabel(report.configuredModel)}${report.mode === 'live' ? ' (Anthropic via Claude Code)' : ''}`,
    `Harness-reported model: ${modelLabel(report.reportedModel)}`,
  ];
  if (report.browser) {
    const { family, platform, online, visible, width, height } = report.browser;
    const safeFamily = ['Safari', 'Chrome', 'Firefox', 'Edge', 'Other'].includes(family) ? family : 'Other';
    const safePlatform = ['iOS', 'Android', 'macOS', 'Windows', 'Linux', 'Other'].includes(platform) ? platform : 'Other';
    lines.push(`Browser: ${safeFamily}; platform: ${safePlatform}; online: ${!!online}; visible: ${!!visible}; viewport: ${Math.max(0, Math.min(20000, Math.round(width) || 0))}x${Math.max(0, Math.min(20000, Math.round(height) || 0))}`);
  }
  lines.push('', 'Review before sharing: conversation text may contain personal information.',
    'Raw tool inputs/results, credentials, headers, and audio are not included in diagnostics.',
    'Interrupted/cancelled execution does not prove that an external action was undone.',
    'This report contains only the conversation and diagnostic history still retained by this session.');
  if (report.messages.length || !report.gptLiveTrial) {
    lines.push('', 'CONVERSATION');
    if (!report.messages.length) lines.push('(No conversation text retained.)');
    for (const message of report.messages) {
      lines.push('', `[Turn ${message.turnId}] ${message.role === 'user' ? 'You' : 'wave-mech'}`, redactTranscript(message.text));
    }
  }
  if (report.gptLiveTrial) lines.push(...trialLines(report.gptLiveTrial));
  lines.push('', 'DIAGNOSTICS');
  if (report.diagnostics.dropped > 0) lines.push(`[History truncated: ${report.diagnostics.dropped} earlier diagnostic records omitted.]`);
  if (!report.diagnostics.entries.length) lines.push('(No diagnostic events retained.)');
  for (const event of report.diagnostics.entries.slice(-200)) {
    const metadata = safeDiagnostic(event);
    const id = /^(server|client|audio|speech):\d{1,12}$/.test(event.id) ? event.id : 'unknown';
    // Reconstruct from allowlisted fields instead of serializing the input object.
    lines.push(`${isoTime(event.at)} [${id}] ${redactTranscript(JSON.stringify(metadata))}`);
  }
  return lines.join('\n');
}

export function browserReport(): NonNullable<TranscriptReport['browser']> {
  const ua = navigator.userAgent;
  return {
    family: /Edg\//.test(ua) ? 'Edge' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Other',
    platform: /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Other',
    online: navigator.onLine, visible: document.visibilityState === 'visible', width: innerWidth, height: innerHeight,
  };
}
