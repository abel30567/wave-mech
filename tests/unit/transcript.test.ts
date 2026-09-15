import { describe, expect, it } from 'vitest';
import { formatTranscriptReport, redactTranscript, type TranscriptReport } from '../../src/client/transcript.js';

const report: TranscriptReport = {
  capturedAt: Date.UTC(2026, 8, 13), mode: 'live', buildId: 'a536de62+working',
  configuredModel: 'claude-opus-4-6[1m]', reportedModel: 'claude-opus-4-6',
  messages: [{ turnId: 1, role: 'user', text: 'Check wave-mech.' }, { turnId: 1, role: 'assistant', text: 'I will check GitHub.' }],
  diagnostics: { entries: [
    { id: 'server:1', at: 1000, source: 'server', code: 'tool_start', turnId: 1, responseId: 1, callId: 'toolu_test', tool: 'mcp__fermi__execute', status: 'running' },
    { id: 'server:2', at: 1200, source: 'server', code: 'tool_result', turnId: 1, responseId: 1, callId: 'toolu_test', tool: 'mcp__fermi__execute', status: 'denied', reason: 'policy_denied', durationMs: 200 },
    { id: 'client:1', at: 1300, source: 'audio', code: 'playback_gap', responseId: 1, gapMs: 75 },
  ], dropped: 0 },
};

describe('copyable conversation report', () => {
  it('combines conversation, model provenance, tool outcomes and audio diagnostics', () => {
    const text = formatTranscriptReport(report);
    expect(text).toContain('[Turn 1] You\nCheck wave-mech.');
    expect(text).toContain('[Turn 1] wave-mech\nI will check GitHub.');
    expect(text).toContain('Configured model: claude-opus-4-6[1m]');
    expect(text).toContain('Harness-reported model: claude-opus-4-6');
    expect(text).toContain('Build: a536de62+working');
    for (const term of ['mcp__fermi__execute', 'policy_denied', 'toolu_test', 'playback_gap', 'gapMs', 'Review before sharing']) expect(text).toContain(term);
  });

  it('labels synthetic, unavailable and truncated evidence honestly', () => {
    const text = formatTranscriptReport({ ...report, mode: 'fixture', reportedModel: undefined, diagnostics: { entries: [], dropped: 20 } });
    expect(text).toContain('Mode: synthetic test');
    expect(text).toContain('Harness-reported model: not reported');
    expect(text).toContain('20 earlier diagnostic records omitted');
    expect(text).not.toContain('"status":"done"');
  });

  it('does not serialize raw payloads smuggled into a diagnostic event', () => {
    const injected = { ...report.diagnostics.entries[0], arguments: 'ARG_SECRET_SENTINEL', output: 'RESULT_SECRET_SENTINEL', headers: { authorization: 'AUTH_SECRET_SENTINEL' } };
    const text = formatTranscriptReport({ ...report, diagnostics: { entries: [injected], dropped: 0 } });
    expect(text).not.toContain('SECRET_SENTINEL');
    expect(text).not.toContain('"arguments"');
  });

  it('removes common credentials, JWTs, auth headers and URL secrets from conversation text', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuv';
    const input = `Try https://user:pass@example.com/repos/test?token=URL_SENTINEL#PRIVATE\nAuthorization: Bearer HEADER_SENTINEL\n${secret}\nGITHUB_TOKEN=TOKEN_SENTINEL\npassword="PASSWORD_SENTINEL"\neyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.signature`;
    const text = redactTranscript(input);
    expect(text).toContain('https://example.com/repos/test');
    expect(text).toContain('redacted');
    for (const value of [secret, 'user:pass', 'URL_SENTINEL', 'HEADER_SENTINEL', 'TOKEN_SENTINEL', 'PASSWORD_SENTINEL', 'eyJhbGci']) expect(text).not.toContain(value);
  });

  it('does not transform ordinary prose or source URLs without secrets', () => {
    const text = 'The test word is coral. See https://github.com/abel30567/wave-mech for details.';
    expect(redactTranscript(text)).toBe(text);
  });
});
