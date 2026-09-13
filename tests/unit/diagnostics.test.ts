import { describe, expect, it } from 'vitest';
import { DiagnosticLog, safeDiagnostic, type DiagnosticEvent, type DiagnosticInput } from '../../src/shared/diagnostics.js';

const event = (sequence: number): DiagnosticEvent => ({ id: `server:${sequence}`, at: 1000 + sequence, source: 'server', code: 'tool_result', tool: 'mcp__fermi__execute', status: 'failed', reason: 'authentication', statusCode: 401 });

describe('bounded diagnostic metadata', () => {
  it('retains structured outcomes but never arbitrary payload fields', () => {
    const input = { ...event(1), arguments: { token: 'SENTINEL_TOKEN' }, result: 'SENTINEL_RESULT', message: 'SENTINEL_ERROR', url: 'https://host/?token=SENTINEL_URL', headers: { Authorization: 'SENTINEL_AUTH' } };
    const clean = safeDiagnostic(input);
    expect(clean).toMatchObject({ tool: 'mcp__fermi__execute', status: 'failed', reason: 'authentication', statusCode: 401 });
    expect(JSON.stringify(clean)).not.toContain('SENTINEL');
    expect(clean).not.toHaveProperty('arguments');
  });

  it('rejects free-text reasons, foreign tools, and invalid numeric metadata', () => {
    const clean = safeDiagnostic({ source: 'server', code: 'bad\nsecret', tool: 'mcp__unrelated__execute', reason: 'secret reason', durationMs: Infinity, gapMs: -5, callId: 'url?token=secret' } as unknown as DiagnosticInput);
    expect(clean).toEqual({ source: 'server', code: 'unknown' });
  });

  it('does not duplicate or resurrect evicted events after snapshot replay', () => {
    const log = new DiagnosticLog('client', () => 2000);
    for (let n = 1; n <= 250; n++) log.add(event(n));
    const retained = log.snapshot();
    expect(retained.entries).toHaveLength(200);
    expect(retained.dropped).toBe(50);
    log.merge({ entries: Array.from({ length: 250 }, (_, n) => event(n + 1)), dropped: 0 });
    expect(log.snapshot()).toEqual(retained);
    log.merge({ entries: retained.entries, dropped: 50 });
    expect(log.snapshot().dropped).toBe(50);
    expect(JSON.stringify(retained).length).toBeLessThan(65536);
  });

  it('keeps source sequences independent and returns defensive copies', () => {
    const log = new DiagnosticLog('client', () => 2000);
    log.add(event(25));
    log.record({ source: 'audio', code: 'playback_gap', responseId: 3, gapMs: 180 });
    const snapshot = log.snapshot();
    expect(snapshot.entries.map(e => e.id)).toEqual(['server:25', 'client:1']);
    snapshot.entries[0].code = 'mutated';
    expect(log.snapshot().entries[0].code).toBe('tool_result');
    expect(new DiagnosticLog('client').snapshot()).toEqual({ entries: [], dropped: 0 });
  });

  it('preserves remote truncation without counting the same snapshot repeatedly', () => {
    const log = new DiagnosticLog('client');
    const snapshot = { entries: [event(100)], dropped: 99 };
    log.merge(snapshot); log.merge(snapshot);
    expect(log.snapshot()).toEqual(snapshot);
  });
});
