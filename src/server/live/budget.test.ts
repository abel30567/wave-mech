import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { writeFile, unlink, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { GptLiveBudget } from './budget.js';

function tmpFile(): string {
  return path.join(tmpdir(), `wave-live-budget-test-${randomBytes(4).toString('hex')}.json`);
}

describe('GptLiveBudget', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpFile();
  });

  afterEach(async () => {
    try { await unlink(filePath); } catch { /* ok */ }
  });

  it('starts with empty ledger when file does not exist', async () => {
    const budget = new GptLiveBudget(filePath);
    await budget.load();
    expect(budget.cumulativeUsageUsd).toBe(0);
    expect(budget.remainingUsd).toBe(5);
  });

  it('reserves and finalizes a session with confirmed closure', async () => {
    const budget = new GptLiveBudget(filePath);
    await budget.load();

    expect(budget.canReserve(300)).toBe(true);
    budget.reserve('sess-1', 300);
    await budget.save();

    const remaining = budget.remainingUsd;
    expect(remaining).toBeLessThan(5);

    budget.finalize('sess-1', 60, true);
    await budget.save();

    expect(budget.cumulativeUsageUsd).toBeCloseTo(0.05, 4);
    expect(budget.remainingUsd).toBeCloseTo(4.95, 4);
  });

  it('uses reserved amount for unconfirmed closure', async () => {
    const budget = new GptLiveBudget(filePath);
    await budget.load();

    budget.reserve('sess-1', 300);
    budget.finalize('sess-1', 60, false);
    await budget.save();

    expect(budget.cumulativeUsageUsd).toBeCloseTo(0.25, 4);
  });

  it('persists and reloads from file', async () => {
    const budget1 = new GptLiveBudget(filePath);
    await budget1.load();
    budget1.reserve('sess-1', 120);
    budget1.finalize('sess-1', 60, true);
    await budget1.save();

    const budget2 = new GptLiveBudget(filePath);
    await budget2.load();
    expect(budget2.cumulativeUsageUsd).toBeCloseTo(budget1.cumulativeUsageUsd, 4);
  });

  it('reconciles orphaned reservations on load', async () => {
    const budget = new GptLiveBudget(filePath);
    await budget.load();
    budget.reserve('orphan-1', 120);
    await budget.save();

    const budget2 = new GptLiveBudget(filePath);
    await budget2.load();
    const orphans = budget2.reconcileOrphans();
    expect(orphans).toBe(1);
    expect(budget2.cumulativeUsageUsd).toBeGreaterThan(0);
  });

  it('prevents overspending the budget cap', async () => {
    const budget = new GptLiveBudget(filePath, 0.30);
    await budget.load();

    expect(budget.canReserve(300)).toBe(true);
    budget.reserve('sess-1', 300);
    expect(budget.canReserve(300)).toBe(false);
    expect(budget.canReserve(120)).toBe(false);
  });

  it('does not double-finalize a session', async () => {
    const budget = new GptLiveBudget(filePath);
    await budget.load();
    budget.reserve('sess-1', 120);
    budget.finalize('sess-1', 60, true);
    const usage1 = budget.cumulativeUsageUsd;
    expect(usage1).toBeGreaterThan(0);
    budget.finalize('sess-1', 60, true);
    const usage2 = budget.cumulativeUsageUsd;
    expect(usage2).toBeCloseTo(usage1, 6);
  });

  it('writes file with 0600 permissions', async () => {
    const budget = new GptLiveBudget(filePath);
    await budget.load();
    await budget.save();

    const { mode } = await import('node:fs').then(fs => fs.promises.stat(filePath));
    expect(mode & 0o777).toBe(0o600);
  });
});
