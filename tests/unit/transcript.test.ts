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

describe('GPT-Live trial report', () => {
  const started = Date.UTC(2026, 8, 16, 14, 0, 0);
  const trial = {
    sessionId: 'sess-1', voiceModel: 'gpt-live-1', backendModel: 'claude-opus-4-6[1m]', backendReportedModel: 'claude-opus-4-6[1m]',
    cumulativeVoiceSeconds: 89, estimatedCostUsd: 0.0742, closureConfirmed: true, closureReason: 'close_requested',
    delegationsProcessed: 1, delegationsSkipped: 0, maxSessionSeconds: 300, startedAt: started, deadlineAt: started + 300_000,
    endedAt: started + 89_000, stopCause: 'deadline' as const, unfinishedDelegation: true,
    delegations: [{ delegationId: 'dlg_1', offsetMs: 1500, createdAt: started + 1500, sentAt: started + 1620, status: 'unfinished' as const, settledAt: started + 89_000 }],
    transcript: [
      { role: 'user' as const, text: 'What is my balance? token=USER_SECRET', source: 'voice-model' as const, timestampMs: started + 1000 },
      { role: 'system' as const, text: 'v=0\r\no=- 1 IN IP4 127.0.0.1\r\na=ice-ufrag:ICE_SENTINEL', source: 'voice-model' as const, timestampMs: started + 1100 },
      { role: 'assistant' as const, text: 'Looking that up.', source: 'backend' as const, timestampMs: started + 3000 },
    ],
    diagnostics: { entries: [
      { id: 'server:7', at: started + 1620, source: 'server' as const, code: 'delegation_started', delegationId: 'dlg_1' },
      { id: 'server:8', at: started + 2000, source: 'server' as const, code: 'tool_start', delegationId: 'dlg_1', callId: 'toolu_9', tool: 'mcp__fermi__mac_browser_action', status: 'running' as const },
      { id: 'server:9', at: started + 89_000, source: 'server' as const, code: 'stop_deadline', count: 1 },
    ], dropped: 0 },
  };

  it('renders timestamped lifecycle, delegation, tool and transcript records with the app stop cause separate from the provider reason', () => {
    const text = formatTranscriptReport({ messages: [], diagnostics: trial.diagnostics, capturedAt: started + 90_000, mode: 'live', configuredModel: trial.backendModel, reportedModel: trial.backendReportedModel, gptLiveTrial: trial });
    expect(text).toContain('Session limit: 300s');
    expect(text).toContain(`Started: ${new Date(started).toISOString()}`);
    expect(text).toContain(`Deadline: ${new Date(started + 300_000).toISOString()}`);
    expect(text).toContain('Stop cause (app): deadline');
    expect(text).toContain('Provider closure reason: close_requested');
    expect(text).toContain('Unfinished backend task at stop: yes');
    expect(text).toContain(`${new Date(started + 1500).toISOString()} [delegation:dlg_1] status=unfinished offset=1500ms sent=+120ms settled=+87500ms`);
    expect(text).toContain(`${new Date(started + 1000).toISOString()} [voice-model] user: What is my balance? token=[redacted]`);
    expect(text).toContain(`${new Date(started + 3000).toISOString()} [backend] assistant: Looking that up.`);
    expect(text).toContain(`${new Date(started + 2000).toISOString()} [server:8] {"source":"server","code":"tool_start","tool":"mcp__fermi__mac_browser_action","callId":"toolu_9","delegationId":"dlg_1","status":"running"}`);
    expect(text).toContain('[server:9] {"source":"server","code":"stop_deadline","count":1}');
    expect(text).not.toContain('CONVERSATION');
    for (const value of ['USER_SECRET', 'ICE_SENTINEL', 'ice-ufrag', 'v=0']) expect(text).not.toContain(value);
  });

  it('tolerates an older diagnostics shape without timestamps or records', () => {
    const legacy = { sessionId: 'sess-2', voiceModel: 'gpt-live-1', backendModel: 'claude-opus-4-6[1m]', cumulativeVoiceSeconds: 12.5, estimatedCostUsd: 0.0104, closureConfirmed: true, closureReason: 'user_ended', delegationsProcessed: 1, delegationsSkipped: 0, transcript: [{ role: 'user' as const, text: 'Hello test', source: 'voice-model' as const, timestampMs: 1000 }] };
    const text = formatTranscriptReport({ messages: [], diagnostics: { entries: [], dropped: 0 }, capturedAt: started, gptLiveTrial: legacy });
    expect(text).toContain('Stop cause (app): not reported');
    expect(text).toContain('Started: not reported');
    expect(text).toContain('1970-01-01T00:00:01.000Z [voice-model] user: Hello test');
    expect(text).toContain('(No diagnostic events retained.)');
  });
});
