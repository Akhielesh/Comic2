// @vitest-environment node
// The stranded-hold sweep (UB-5 second half + the usage-billing new finding). A settle that fails
// after the provider was paid leaves a RESERVED generation_cost_events row that the usage budget
// stops counting after 20 minutes (user_usage_budgets.sql) — paid spend nothing counts. The nightly
// reconciliation now settles such holds at their held provider cost, through the same rows the usage
// budget counts, exactly once. Fake store only: no database, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STRANDED_HOLD_MIN_AGE_MINUTES, sweepStrandedHolds, sweptSurfaceOf, type StrandedHoldRow, type StrandedHoldStore } from './strandedHolds.js';

type Row = StrandedHoldRow & { status: string; is_byok: boolean; actual_ct: number };
type Ledger = {
  entry_type: string;
  reservation_id: string;
  user_id: string;
  provider_cost_usd: number | null;
  billable_usd: number | null;
  metadata: Record<string, unknown>;
};

const NOW = Date.parse('2026-10-29T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
let seq = 0;
const row = (o: Partial<Row> & { minutes: number }): Row => {
  seq += 1;
  const { minutes, ...rest } = o;
  return {
    id: `ev-${seq}`,
    reservation_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    user_id: 'user-a',
    operation: 'comic.image.page',
    provider: 'openrouter',
    model: 'google/gemini-nano-banana-2.1',
    project_id: 'proj-1',
    estimated_ct: 910,
    provider_cost_usd: 0.07,
    billable_usd: 0.091,
    metadata: { surface: 'comic_studio_v4', stage: 'page', usageBudget: true },
    created_at: minutesAgo(minutes),
    status: 'RESERVED',
    is_byok: false,
    actual_ct: 0,
    ...rest
  };
};

/** In-memory generation_cost_events + token_ledger_entries with the real store's semantics. */
const fakeStore = (rows: Row[], ledger: Ledger[] = []) => {
  const usageRow = (r: Row) => r.status === 'RESERVED' && !r.is_byok && !!r.reservation_id && r.metadata?.usageBudget === true;
  const store: StrandedHoldStore & { rows: Row[]; ledger: Ledger[]; beforeFinish?: (r: Row) => void; failOn?: string } = {
    rows,
    ledger,
    async listStranded({ before, from, limit }) {
      return rows
        .filter((r) => usageRow(r) && r.created_at < before && r.created_at >= from)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, limit)
        .map((r) => ({ ...r, metadata: { ...r.metadata } }));
    },
    async countOlder(from) {
      return rows.filter((r) => usageRow(r) && r.created_at < from).length;
    },
    async ledgerDecisions(ids) {
      const out = new Map();
      for (const e of ledger) {
        if (!ids.includes(e.reservation_id) || (e.entry_type !== 'SETTLE' && e.entry_type !== 'RELEASE')) continue;
        if (out.get(e.reservation_id)?.entryType === 'SETTLE') continue;
        out.set(e.reservation_id, { entryType: e.entry_type, providerCostUsd: e.provider_cost_usd, billableUsd: e.billable_usd, metadata: e.metadata });
      }
      return out;
    },
    async finishIfReserved({ reservationId, userId }, patch) {
      const r = rows.find((x) => x.reservation_id === reservationId && x.user_id === userId);
      if (!r) return false;
      if (store.failOn === reservationId) throw new Error('database unavailable');
      store.beforeFinish?.(r);
      if (r.status !== 'RESERVED') return false;
      Object.assign(r, patch);
      return true;
    },
    async recordSettle(entry) {
      ledger.push({
        entry_type: 'SETTLE',
        reservation_id: entry.reservationId,
        user_id: entry.userId,
        provider_cost_usd: entry.providerCostUsd,
        billable_usd: entry.billableUsd,
        metadata: entry.metadata
      });
    }
  };
  return store;
};

/** What usage_budget_try_reserve / usage_budget_status count: SETTLED + RESERVED younger than 20 minutes. */
const usedUsd = (rows: Row[], userId: string) =>
  rows
    .filter((r) => r.user_id === userId && !r.is_byok && r.reservation_id && r.metadata?.platformPaid !== true)
    .filter((r) => r.status === 'SETTLED' || (r.status === 'RESERVED' && Date.parse(r.created_at) > NOW - 20 * 60_000))
    .reduce((s, r) => s + r.provider_cost_usd, 0);

const logs: string[] = [];
beforeEach(() => {
  seq = 0;
  logs.length = 0;
  for (const m of ['info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((line: unknown) => void logs.push(String(line)));
});
afterEach(() => vi.restoreAllMocks());

const run = (store: StrandedHoldStore, opts: Partial<Parameters<typeof sweepStrandedHolds>[0]> = {}) => sweepStrandedHolds({ store, now: () => NOW, ...opts });

describe('sweepStrandedHolds', () => {
  it('settles stale usage holds of the comic studio, /api/text and /api/image at their held provider cost, and logs the count', async () => {
    const comic = row({ minutes: 45 });
    const text = row({ minutes: 90, operation: 'text.analyze_script', provider: 'openrouter', provider_cost_usd: 0.004, billable_usd: 0.0052, estimated_ct: 52, metadata: { route: '/analyze-script', usageBudget: true } });
    const image = row({ minutes: 600, operation: 'image.gemini.generate', provider: 'gemini', provider_cost_usd: 0.039, billable_usd: 0.0507, metadata: { route: '/api/image/gemini', usageBudget: true } });
    const fresh = row({ minutes: 5 });
    const chat = row({ minutes: 60, operation: 'chat.completion', metadata: { route: '/', usageBudget: true } });
    const wallet = row({ minutes: 60, metadata: { surface: 'comic_studio_v4' } });
    const store = fakeStore([comic, text, image, fresh, chat, wallet]);
    // Before: the stale holds count for nothing.
    expect(usedUsd(store.rows, 'user-a')).toBeCloseTo(0.07, 9);

    const res = await run(store);

    expect(res).toMatchObject({ settled: 3, released: 0, settledFromLedger: 0, raced: 0, failed: 0, otherSurface: 1 });
    expect(res.settledUsd).toBeCloseTo(0.07 + 0.004 + 0.039, 9);
    for (const r of [comic, text, image]) {
      expect(r.status).toBe('SETTLED');
      expect(r.metadata).toMatchObject({ settledBy: 'sweep' });
      expect(r.actual_ct).toBe(r.estimated_ct);
    }
    // At the HELD figures, untouched.
    expect(comic.provider_cost_usd).toBe(0.07);
    expect(text.provider_cost_usd).toBe(0.004);
    // A hold still in flight, another surface and a wallet (non-usage-budget) hold are left alone.
    expect(fresh.status).toBe('RESERVED');
    expect(chat.status).toBe('RESERVED');
    expect(wallet.status).toBe('RESERVED');
    // The ledger entry a normal usage-budget settle writes (no wallet CT moves), one per hold.
    expect(store.ledger).toHaveLength(3);
    expect(store.ledger.find((e) => e.reservation_id === comic.reservation_id)).toMatchObject({
      entry_type: 'SETTLE',
      user_id: 'user-a',
      provider_cost_usd: 0.07,
      billable_usd: 0.091,
      metadata: expect.objectContaining({ settledBy: 'sweep', walletSkipped: true })
    });
    // The usage now reflects the held spend.
    expect(usedUsd(store.rows, 'user-a')).toBeCloseTo(0.07 + 0.07 + 0.004 + 0.039, 9);
    const line = logs.map((l) => JSON.parse(l)).find((l) => l.event === 'billing_stranded_hold_sweep');
    expect(line).toMatchObject({ settled: 3, failed: 0 });
  });

  it('is idempotent: a second run settles nothing, and the usage counts each hold exactly once', async () => {
    const store = fakeStore([row({ minutes: 45 }), row({ minutes: 30, user_id: 'user-b' })]);
    await run(store);
    const usedA = usedUsd(store.rows, 'user-a');
    const ledgerAfter = store.ledger.length;
    const again = await run(store);
    expect(again).toMatchObject({ checked: 0, settled: 0 });
    expect(store.ledger).toHaveLength(ledgerAfter);
    expect(usedUsd(store.rows, 'user-a')).toBe(usedA);
    expect(usedA).toBeCloseTo(0.07, 9);
  });

  it('a hold settled meanwhile (by its own late settle) is untouched and writes nothing', async () => {
    const late = row({ minutes: 25 });
    const store = fakeStore([late]);
    store.beforeFinish = (r) => Object.assign(r, { status: 'SETTLED', provider_cost_usd: 0.055 });
    const res = await run(store);
    expect(res).toMatchObject({ settled: 0, raced: 1 });
    expect(late.provider_cost_usd).toBe(0.055);
    expect(late.metadata.settledBy).toBeUndefined();
    expect(store.ledger).toHaveLength(0);
  });

  it('a hold whose settle already wrote its ledger entry settles at that real cost — no second entry', async () => {
    const half = row({ minutes: 40 });
    const store = fakeStore([half], [
      { entry_type: 'SETTLE', reservation_id: half.reservation_id, user_id: 'user-a', provider_cost_usd: 0.031, billable_usd: 0.0403, metadata: { actualCt: 403, walletSkipped: true } }
    ]);
    const res = await run(store);
    expect(res).toMatchObject({ settled: 1, settledFromLedger: 1 });
    expect(half).toMatchObject({ status: 'SETTLED', provider_cost_usd: 0.031, billable_usd: 0.0403, actual_ct: 403 });
    expect(store.ledger).toHaveLength(1);
  });

  it('a hold whose release already wrote its ledger entry is released, never charged', async () => {
    const failed = row({ minutes: 40 });
    const store = fakeStore([failed], [
      { entry_type: 'RELEASE', reservation_id: failed.reservation_id, user_id: 'user-a', provider_cost_usd: null, billable_usd: null, metadata: { reason: 'image_failed', walletSkipped: true } }
    ]);
    const res = await run(store);
    expect(res).toMatchObject({ settled: 0, released: 1 });
    expect(failed.status).toBe('RELEASED');
    expect(failed.metadata).toMatchObject({ releasedBy: 'sweep', releaseReason: 'image_failed' });
    expect(usedUsd(store.rows, 'user-a')).toBe(0);
    expect(store.ledger).toHaveLength(1);
  });

  it('holds older than the look-back are reported, not settled', async () => {
    const ancient = row({ minutes: 60 * 24 * 30 });
    const recent = row({ minutes: 60 });
    const store = fakeStore([ancient, recent]);
    const res = await run(store, { maxAgeHours: 24 * 7 });
    expect(res).toMatchObject({ settled: 1, olderLeft: 1 });
    expect(ancient.status).toBe('RESERVED');
  });

  it('one row that fails does not stop the rest; it stays RESERVED for the next run', async () => {
    const bad = row({ minutes: 50 });
    const good = row({ minutes: 45 });
    const store = fakeStore([bad, good]);
    store.failOn = bad.reservation_id;
    const res = await run(store);
    expect(res).toMatchObject({ settled: 1, failed: 1 });
    expect(bad.status).toBe('RESERVED');
    expect(good.status).toBe('SETTLED');
    expect(logs.some((l) => l.includes('billing_stranded_hold_sweep_failed') && l.includes(bad.reservation_id))).toBe(true);
  });

  it('never touches a hold younger than 20 minutes', () => {
    expect(STRANDED_HOLD_MIN_AGE_MINUTES).toBe(20);
  });

  it('knows the three swept surfaces', () => {
    expect(sweptSurfaceOf({ operation: 'comic.text.writer', metadata: { surface: 'comic_studio_v4' } })).toBe('comic_studio_v4');
    expect(sweptSurfaceOf({ operation: 'text.story_outline', metadata: {} })).toBe('api_text');
    expect(sweptSurfaceOf({ operation: 'image.openrouter.generate', metadata: {} })).toBe('api_image');
    expect(sweptSurfaceOf({ operation: 'chat.completion', metadata: {} })).toBeNull();
  });
});
