import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { GPT_LIVE_MAX_BUDGET_USD, GPT_LIVE_MAX_SESSION_SECONDS, GPT_LIVE_PRICE_PER_MINUTE } from '../../shared/gpt-live-trial.js';

export interface BudgetLedger {
  cumulativeUsageUsd: number;
  reservations: BudgetReservation[];
  lastUpdated: string;
}

export interface BudgetReservation {
  sessionId: string;
  providerSessionId: string | null;
  reservedUsd: number;
  actualUsd: number | null;
  createdAt: string;
  finalized: boolean;
  closureConfirmed: boolean;
  creationAttempted?: boolean;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidReservationShape(r: unknown): r is BudgetReservation {
  if (r === null || typeof r !== 'object') return false;
  const rec = r as Record<string, unknown>;
  if (typeof rec.sessionId !== 'string') return false;
  if (rec.providerSessionId !== null && typeof rec.providerSessionId !== 'string') return false;
  if (!isFiniteNonNegative(rec.reservedUsd)) return false;
  if (rec.actualUsd !== null && !isFiniteNonNegative(rec.actualUsd)) return false;
  if (typeof rec.finalized !== 'boolean') return false;
  if (typeof rec.closureConfirmed !== 'boolean') return false;
  return true;
}

function emptyLedger(): BudgetLedger {
  return {
    cumulativeUsageUsd: 0,
    reservations: [],
    lastUpdated: new Date().toISOString(),
  };
}

export class GptLiveBudget {
  private ledger: BudgetLedger;
  private readonly budgetCapUsd: number;
  private corrupt = false;
  private saveInFlight: Promise<void> = Promise.resolve();
  private _saveFailed = false;

  constructor(
    private readonly filePath: string,
    budgetCapUsd: number = GPT_LIVE_MAX_BUDGET_USD,
  ) {
    this.budgetCapUsd = budgetCapUsd;
    this.ledger = emptyLedger();
  }

  get saveFailed(): boolean {
    return this._saveFailed;
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content) as BudgetLedger;
      if (!isFiniteNonNegative(parsed.cumulativeUsageUsd) || !Array.isArray(parsed.reservations)) {
        this.corrupt = true;
        throw new Error('Invalid budget ledger format.');
      }
      const seenIds = new Set<string>();
      for (const r of parsed.reservations) {
        if (!isValidReservationShape(r)) {
          this.corrupt = true;
          throw new Error('Corrupt reservation in budget ledger.');
        }
        if (seenIds.has(r.sessionId)) {
          this.corrupt = true;
          throw new Error('Duplicate session ID in budget ledger.');
        }
        seenIds.add(r.sessionId);
      }
      this.ledger = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.ledger = emptyLedger();
        return;
      }
      throw error;
    }
  }

  reconcileOrphans(): number {
    let orphanCount = 0;
    for (const reservation of this.ledger.reservations) {
      if (!reservation.finalized) {
        reservation.finalized = true;
        reservation.closureConfirmed = false;
        reservation.actualUsd = reservation.reservedUsd;
        this.ledger.cumulativeUsageUsd += reservation.reservedUsd;
        orphanCount++;
      }
      if (reservation.finalized && !reservation.closureConfirmed) {
        orphanCount = Math.max(orphanCount, 1);
      }
    }
    if (orphanCount > 0) {
      this.ledger.lastUpdated = new Date().toISOString();
    }
    return orphanCount;
  }

  get hasUncertainClosure(): boolean {
    if (this.corrupt) return true;
    if (this._saveFailed) return true;
    return this.ledger.reservations.some(r => r.finalized && !r.closureConfirmed);
  }

  get isReconciliationPending(): boolean {
    return this.hasUncertainClosure;
  }

  canReserve(durationSeconds: number): boolean {
    if (this.hasUncertainClosure) return false;
    const cost = (durationSeconds / 60) * GPT_LIVE_PRICE_PER_MINUTE;
    const pendingReservations = this.ledger.reservations
      .filter(r => !r.finalized)
      .reduce((sum, r) => sum + r.reservedUsd, 0);
    return (this.ledger.cumulativeUsageUsd + pendingReservations + cost) <= this.budgetCapUsd;
  }

  reserve(sessionId: string, durationSeconds: number): BudgetReservation {
    const cost = (durationSeconds / 60) * GPT_LIVE_PRICE_PER_MINUTE;
    const reservation: BudgetReservation = {
      sessionId,
      providerSessionId: null,
      reservedUsd: cost,
      actualUsd: null,
      createdAt: new Date().toISOString(),
      finalized: false,
      closureConfirmed: false,
      creationAttempted: false,
    };
    this.ledger.reservations.push(reservation);
    this.ledger.lastUpdated = new Date().toISOString();
    return reservation;
  }

  markCreationAttempted(sessionId: string): void {
    const reservation = this.ledger.reservations.find(
      r => r.sessionId === sessionId && !r.finalized,
    );
    if (reservation) {
      reservation.creationAttempted = true;
      this.ledger.lastUpdated = new Date().toISOString();
    }
  }

  setProviderSessionId(sessionId: string, providerSessionId: string): void {
    const reservation = this.ledger.reservations.find(
      r => r.sessionId === sessionId && !r.finalized,
    );
    if (reservation) {
      reservation.providerSessionId = providerSessionId;
      this.ledger.lastUpdated = new Date().toISOString();
    }
  }

  releaseUnstartedReservation(sessionId: string): boolean {
    const reservation = this.ledger.reservations.find(
      r => r.sessionId === sessionId && !r.finalized,
    );
    if (!reservation) return false;
    if (reservation.creationAttempted || reservation.providerSessionId) return false;
    const idx = this.ledger.reservations.indexOf(reservation);
    this.ledger.reservations.splice(idx, 1);
    this.ledger.lastUpdated = new Date().toISOString();
    return true;
  }

  finalize(sessionId: string, voiceSeconds: number, closureConfirmed: boolean): void {
    const reservation = this.ledger.reservations.find(
      r => r.sessionId === sessionId && !r.finalized,
    );
    if (!reservation) return;

    const validSeconds = isFiniteNonNegative(voiceSeconds) && voiceSeconds > 0;

    reservation.finalized = true;

    if (closureConfirmed && validSeconds) {
      const actualCost = (voiceSeconds / 60) * GPT_LIVE_PRICE_PER_MINUTE;
      reservation.actualUsd = actualCost;
      reservation.closureConfirmed = true;
      this.ledger.cumulativeUsageUsd += actualCost;
    } else if (closureConfirmed && voiceSeconds === 0) {
      reservation.actualUsd = 0;
      reservation.closureConfirmed = true;
    } else {
      reservation.actualUsd = reservation.reservedUsd;
      reservation.closureConfirmed = false;
      this.ledger.cumulativeUsageUsd += reservation.reservedUsd;
    }
    this.ledger.lastUpdated = new Date().toISOString();
  }

  confirmClosure(sessionId: string, voiceSeconds: number): boolean {
    const reservation = this.ledger.reservations.find(
      r => r.sessionId === sessionId && !r.finalized,
    ) ?? this.ledger.reservations.find(
      r => r.sessionId === sessionId && r.finalized && !r.closureConfirmed,
    );
    if (!reservation) return false;

    const validSeconds = isFiniteNonNegative(voiceSeconds) && voiceSeconds >= 0;
    if (!validSeconds) return false;

    const wasFinalized = reservation.finalized;
    const previousCharge = wasFinalized
      ? (reservation.actualUsd ?? reservation.reservedUsd)
      : 0;

    const actualCost = (voiceSeconds / 60) * GPT_LIVE_PRICE_PER_MINUTE;

    if (wasFinalized) {
      this.ledger.cumulativeUsageUsd -= previousCharge;
    }
    this.ledger.cumulativeUsageUsd += actualCost;

    reservation.finalized = true;
    reservation.actualUsd = actualCost;
    reservation.closureConfirmed = true;
    this.ledger.lastUpdated = new Date().toISOString();
    return true;
  }

  get remainingUsd(): number {
    if (this.hasUncertainClosure) return 0;
    const pendingReservations = this.ledger.reservations
      .filter(r => !r.finalized)
      .reduce((sum, r) => sum + r.reservedUsd, 0);
    return Math.max(0, this.budgetCapUsd - this.ledger.cumulativeUsageUsd - pendingReservations);
  }

  get cumulativeUsageUsd(): number {
    return this.ledger.cumulativeUsageUsd;
  }

  get snapshot(): BudgetLedger {
    return JSON.parse(JSON.stringify(this.ledger));
  }

  async save(): Promise<void> {
    const doSave = async (): Promise<void> => {
      try {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        const tmpPath = `${this.filePath}.${randomBytes(4).toString('hex')}.tmp`;
        const content = JSON.stringify(this.ledger, null, 2);
        await writeFile(tmpPath, content, { mode: 0o600 });
        await rename(tmpPath, this.filePath);
      } catch (err) {
        this._saveFailed = true;
        throw err;
      }
    };
    this.saveInFlight = this.saveInFlight.then(doSave, doSave);
    return this.saveInFlight;
  }
}
