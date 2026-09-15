import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { GPT_LIVE_MAX_BUDGET_USD, GPT_LIVE_PRICE_PER_MINUTE } from '../../shared/gpt-live-trial.js';

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

  constructor(
    private readonly filePath: string,
    budgetCapUsd: number = GPT_LIVE_MAX_BUDGET_USD,
  ) {
    this.budgetCapUsd = budgetCapUsd;
    this.ledger = emptyLedger();
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content) as BudgetLedger;
      if (typeof parsed.cumulativeUsageUsd !== 'number' || !Array.isArray(parsed.reservations)) {
        throw new Error('Invalid budget ledger format.');
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
      if (!reservation.finalized && !reservation.closureConfirmed) {
        reservation.finalized = true;
        reservation.actualUsd = reservation.reservedUsd;
        this.ledger.cumulativeUsageUsd += reservation.reservedUsd;
        orphanCount++;
      }
    }
    if (orphanCount > 0) {
      this.ledger.lastUpdated = new Date().toISOString();
    }
    return orphanCount;
  }

  canReserve(durationSeconds: number): boolean {
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
    };
    this.ledger.reservations.push(reservation);
    this.ledger.lastUpdated = new Date().toISOString();
    return reservation;
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

  finalize(sessionId: string, voiceSeconds: number, closureConfirmed: boolean): void {
    const reservation = this.ledger.reservations.find(
      r => r.sessionId === sessionId && !r.finalized,
    );
    if (!reservation) return;

    const actualCost = (voiceSeconds / 60) * GPT_LIVE_PRICE_PER_MINUTE;
    reservation.actualUsd = actualCost;
    reservation.finalized = true;
    reservation.closureConfirmed = closureConfirmed;

    if (closureConfirmed) {
      this.ledger.cumulativeUsageUsd += actualCost;
    } else {
      this.ledger.cumulativeUsageUsd += reservation.reservedUsd;
    }
    this.ledger.lastUpdated = new Date().toISOString();
  }

  get remainingUsd(): number {
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
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${randomBytes(4).toString('hex')}.tmp`;
    const content = JSON.stringify(this.ledger, null, 2);
    await writeFile(tmpPath, content, { mode: 0o600 });
    await rename(tmpPath, this.filePath);
  }
}
