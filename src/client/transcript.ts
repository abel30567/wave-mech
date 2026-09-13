import { safeDiagnostic, type DiagnosticSnapshot } from '../shared/diagnostics.js';
import type { TranscriptEntry } from '../shared/realtime.js';

export interface TranscriptReport {
  messages: TranscriptEntry[];
  diagnostics: DiagnosticSnapshot;
  capturedAt: number;
  mode?: 'live' | 'fixture';
  configuredModel?: string;
  reportedModel?: string;
  buildId?: string;
  browser?: { family: string; platform: string; online: boolean; visible: boolean; width: number; height: number };
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

function modelLabel(value?: string): string {
  return value && /^claude-[a-z0-9.[\]-]{1,80}$/.test(value) ? value : 'not reported';
}

export function formatTranscriptReport(report: TranscriptReport): string {
  const build = report.buildId && /^[a-zA-Z0-9_.+-]{1,100}$/.test(report.buildId) ? report.buildId : 'not reported';
  const lines = [
    'wave-mech — conversation and diagnostics',
    'Report format: 1',
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
    'This report contains only the conversation and diagnostic history still retained by this session.', '', 'CONVERSATION');
  if (!report.messages.length) lines.push('(No conversation text retained.)');
  for (const message of report.messages) {
    lines.push('', `[Turn ${message.turnId}] ${message.role === 'user' ? 'You' : 'wave-mech'}`, redactTranscript(message.text));
  }
  lines.push('', 'DIAGNOSTICS');
  if (report.diagnostics.dropped > 0) lines.push(`[History truncated: ${report.diagnostics.dropped} earlier diagnostic records omitted.]`);
  if (!report.diagnostics.entries.length) lines.push('(No diagnostic events retained.)');
  for (const event of report.diagnostics.entries.slice(-200)) {
    const metadata = safeDiagnostic(event);
    const time = Number.isFinite(event.at) && event.at >= 0 && event.at <= 8640000000000000 ? new Date(event.at).toISOString() : 'unknown-time';
    const id = /^(server|client|audio|speech):\d{1,12}$/.test(event.id) ? event.id : 'unknown';
    // Reconstruct from allowlisted fields instead of serializing the input object.
    lines.push(`${time} [${id}] ${redactTranscript(JSON.stringify(metadata))}`);
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
