export type DiagnosticToolStatus = 'running' | 'done' | 'failed' | 'denied' | 'pending' | 'cancelled';
export type DiagnosticReason = 'policy_denied' | 'approval_required' | 'authentication' | 'not_found' | 'rate_limited' | 'timeout' | 'network' | 'provider' | 'cancelled' | 'unknown';
export type DiagnosticSource = 'server' | 'client' | 'audio' | 'speech';

/** Only structured metadata belongs here: never raw inputs, results, URLs or errors. */
export interface DiagnosticInput {
  source: DiagnosticSource;
  code: string;
  turnId?: number;
  responseId?: number;
  callId?: string;
  tool?: string;
  status?: DiagnosticToolStatus;
  reason?: DiagnosticReason;
  statusCode?: number;
  durationMs?: number;
  bufferedMs?: number;
  gapMs?: number;
  count?: number;
  sampleRate?: number;
}
export interface DiagnosticEvent extends DiagnosticInput { id: string; at: number }
export interface DiagnosticSnapshot { entries: DiagnosticEvent[]; dropped: number }

const SOURCES = new Set<DiagnosticSource>(['server', 'client', 'audio', 'speech']);
const STATUSES = new Set<DiagnosticToolStatus>(['running', 'done', 'failed', 'denied', 'pending', 'cancelled']);
const REASONS = new Set<DiagnosticReason>(['policy_denied', 'approval_required', 'authentication', 'not_found', 'rate_limited', 'timeout', 'network', 'provider', 'cancelled', 'unknown']);
const NUMBERS = ['turnId', 'responseId', 'statusCode', 'durationMs', 'bufferedMs', 'gapMs', 'count', 'sampleRate'] as const;

export function safeDiagnostic(input: DiagnosticInput): DiagnosticInput {
  const result: DiagnosticInput = {
    source: SOURCES.has(input.source) ? input.source : 'client',
    code: typeof input.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(input.code) ? input.code : 'unknown',
  };
  for (const key of NUMBERS) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) result[key] = value;
  }
  if (input.tool && /^(Read|Write|Edit|Bash|Grep|Glob|Agent|Task|Skill|WebSearch|WebFetch|ToolSearch|mcp__fermi__[a-z][a-z0-9_]{0,99})$/.test(input.tool)) result.tool = input.tool;
  if (input.callId && /^[a-zA-Z0-9_-]{1,100}$/.test(input.callId)) result.callId = input.callId;
  if (input.status && STATUSES.has(input.status)) result.status = input.status;
  if (input.reason && REASONS.has(input.reason)) result.reason = input.reason;
  return result;
}

/** Bounded metadata retention, with source watermarks to prevent reconnect replay. */
export class DiagnosticLog {
  private entries: DiagnosticEvent[] = [];
  private bytes = 0;
  private remoteDropped = 0;
  private sequence = 0;
  private readonly seen = new Map<DiagnosticSource, number>();

  constructor(private readonly owner: DiagnosticSource, private readonly now: () => number = Date.now) {}

  record(input: DiagnosticInput): DiagnosticEvent {
    const event = { ...safeDiagnostic(input), id: `${this.owner}:${++this.sequence}`, at: this.now() };
    this.add(event);
    return event;
  }

  add(input: DiagnosticEvent): void {
    const match = /^(server|client|audio|speech):(\d{1,12})$/.exec(input.id);
    if (!match || !Number.isFinite(input.at) || input.at < 0) return;
    const owner = match[1] as DiagnosticSource, sequence = Number(match[2]);
    if (sequence <= (this.seen.get(owner) ?? 0)) return;
    this.seen.set(owner, sequence);
    const event = { ...safeDiagnostic(input), id: input.id, at: input.at };
    this.entries.push(event);
    this.bytes += JSON.stringify(event).length;
    while (this.entries.length > 200 || this.bytes > 65536) {
      this.bytes -= JSON.stringify(this.entries.shift()).length;
    }
  }

  merge(snapshot: DiagnosticSnapshot): void {
    for (const entry of snapshot.entries) this.add(entry);
    if (Number.isFinite(snapshot.dropped) && snapshot.dropped > this.remoteDropped) this.remoteDropped = snapshot.dropped;
  }

  snapshot(): DiagnosticSnapshot {
    // Watermarks include omitted prefixes; adding upstream truncation to local
    // eviction would double-count the same server records after reconnect.
    const omitted = [...this.seen.values()].reduce((total, sequence) => total + sequence, 0) - this.entries.length;
    return { entries: this.entries.map(entry => ({ ...entry })), dropped: Math.max(omitted, this.remoteDropped) };
  }
}
