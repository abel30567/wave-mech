// Scaffold-equivalent: this file should be replaced by the actual scaffold patch.
// Provides DiagnosticLog and supporting types for server-side tool diagnostics.

export type DiagnosticStatus = 'running' | 'done' | 'failed' | 'denied' | 'pending' | 'cancelled';

export type DiagnosticReason =
  | 'success'
  | 'policy_denied'
  | 'approval_required'
  | 'integration_error'
  | 'timeout'
  | 'cancelled'
  | 'unknown';

export interface DiagnosticInput {
  callId: string;
  name: string;
  status: DiagnosticStatus;
  durationMs?: number;
  reason?: DiagnosticReason;
  statusCode?: number;
  turnId?: number;
  responseId?: number;
}

export interface DiagnosticEvent {
  kind: string;
  detail?: string;
  ts?: number;
}

export interface DiagnosticSnapshot {
  owner: string;
  entries: DiagnosticInput[];
  events: DiagnosticEvent[];
  model?: string;
}

const MAX_ENTRIES = 200;
const MAX_EVENTS = 100;

export class DiagnosticLog {
  readonly owner: string;
  private readonly now: () => number;
  private readonly entries: DiagnosticInput[] = [];
  private readonly events: DiagnosticEvent[] = [];
  private model: string | undefined;

  constructor(owner: string, now?: () => number) {
    this.owner = owner;
    this.now = now ?? Date.now;
  }

  record(input: DiagnosticInput): void {
    this.entries.push(input);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
  }

  add(event: DiagnosticEvent): void {
    const e = event.ts !== undefined ? event : { ...event, ts: this.now() };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }

  setModel(model: string | undefined): void {
    this.model = model;
  }

  merge(snapshot: DiagnosticSnapshot): void {
    for (const entry of snapshot.entries) this.record(entry);
    for (const event of snapshot.events) this.add(event);
    if (snapshot.model) this.model = snapshot.model;
  }

  snapshot(): DiagnosticSnapshot {
    const snap: DiagnosticSnapshot = {
      owner: this.owner,
      entries: this.entries.map((e) => ({ ...e })),
      events: this.events.map((e) => ({ ...e })),
    };
    if (this.model) snap.model = this.model;
    return snap;
  }
}
