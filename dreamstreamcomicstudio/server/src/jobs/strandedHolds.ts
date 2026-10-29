// Stranded usage holds: settle what was paid, exactly once (UB-5 + the usage-billing new finding).
//
// Every metered call reserves a RESERVED generation_cost_events row (usage_budget_try_reserve) and
// settles it with the provider-reported cost when it lands. When that settle fails after the
// provider was paid (a database blip; comic/billing.ts retries and then logs
// comic_billing_settle_failed { stranded: true }, routes/text.ts logs text_settle_failed), the row
// stays RESERVED, and the usage budget stops counting it after 20 minutes
// (server/sql/user_usage_budgets.sql) — paid spend that silently never counts.
//
// This sweep runs from the nightly reconciliation job (jobs/dailyBillingReconciliation.ts, a
// GitHub Actions cron that talks to the database directly — it never wakes the API container).
// For each usage-budget hold of the comic studio, /api/text or /api/image older than 20 minutes:
//   - a SETTLE ledger entry already exists (the settle's first write landed): settle the row at that
//     entry's real provider cost;
//   - a RELEASE ledger entry already exists (the call failed and was released): mark it RELEASED —
//     nothing was spent, nothing is charged;
//   - otherwise: settle at its HELD provider cost, with the ledger entry a normal usage-budget settle
//     writes (walletSkipped: no wallet credit moves).
// The row update is a compare-and-set on status = 'RESERVED', so a second run settles nothing and a
// row settled meanwhile is untouched; the usage budget counts SETTLED rows, so it reflects each hold
// exactly once. Wallet (non-usage-budget) holds are never listed: their settle moves wallet credits
// (billing_settle_tokens), which is not safe to repeat. Holds older than the look-back are reported,
// not settled (the 20-minute rule promised they would not count; the owner decides on those).
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../lib/logger.js';

/** A hold younger than this may still be settling (usage_budget_try_reserve counts it as in flight). */
export const STRANDED_HOLD_MIN_AGE_MINUTES = 20;
/** Default look-back: a week covers missed nightly runs without reaching back into history. */
export const STRANDED_HOLD_DEFAULT_MAX_AGE_HOURS = 24 * 7;
const DEFAULT_LIMIT = 500;

export interface StrandedHoldRow {
  id: string;
  reservation_id: string;
  user_id: string;
  operation: string;
  provider: string;
  model: string;
  project_id: string | null;
  estimated_ct: number;
  /** The HELD provider cost (the reserve's estimate) while RESERVED. */
  provider_cost_usd: number;
  billable_usd: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface LedgerDecision {
  entryType: 'SETTLE' | 'RELEASE';
  providerCostUsd?: number | null;
  billableUsd?: number | null;
  metadata?: Record<string, unknown>;
}

export interface StrandedHoldStore {
  /** RESERVED, non-BYOK usage-budget holds created in [from, before), oldest first, at most `limit`. */
  listStranded(opts: { before: string; from: string; limit: number }): Promise<StrandedHoldRow[]>;
  /** How many such holds are older than `from` (left alone, reported). */
  countOlder(from: string): Promise<number>;
  /** The settle/release decision a ledger entry already recorded, by reservation id (SETTLE wins). */
  ledgerDecisions(reservationIds: string[]): Promise<Map<string, LedgerDecision>>;
  /** Patch the cost event only while it is still RESERVED; true when this call changed it. */
  finishIfReserved(key: { reservationId: string; userId: string }, patch: Record<string, unknown>): Promise<boolean>;
  /** The ledger entry a usage-budget settle writes (bookkeeping; the budget counts the row). */
  recordSettle(entry: {
    userId: string;
    reservationId: string;
    operation: string;
    provider: string;
    model: string;
    projectId: string | null;
    providerCostUsd: number;
    billableUsd: number;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

export interface StrandedHoldSweepResult {
  checked: number;
  settled: number;
  /** Settled at a cost a SETTLE ledger entry had already recorded (not the hold). */
  settledFromLedger: number;
  settledUsd: number;
  released: number;
  /** Settled or released by someone else between the read and the write. */
  raced: number;
  /** Usage holds of other surfaces (chat), left alone. */
  otherSurface: number;
  failed: number;
  /** Stale usage holds older than the look-back, left alone. */
  olderLeft: number;
  /** More holds were waiting than one run takes. */
  truncated: boolean;
  /** Reservation ids this run settled (first 50), for a manual check. */
  reservationIds: string[];
}

export type SweptSurface = 'comic_studio_v4' | 'api_text' | 'api_image';

/** The surfaces the sweep owns: the comic studio (its billing hooks tag the row), /api/text, /api/image. */
export const sweptSurfaceOf = (row: Pick<StrandedHoldRow, 'operation' | 'metadata'>): SweptSurface | null => {
  if (row.metadata?.surface === 'comic_studio_v4') return 'comic_studio_v4';
  if (/^text\./.test(row.operation || '')) return 'api_text';
  if (/^image\./.test(row.operation || '')) return 'api_image';
  return null;
};

const finite = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
/** Metered spend is never platform overhead (as billingLedger.withoutPlatformPaidMeta). */
const withoutPlatformPaid = (metadata: Record<string, unknown> | null | undefined): Record<string, unknown> => {
  const { platformPaid: _dropped, ...rest } = metadata && typeof metadata === 'object' ? metadata : {};
  return rest;
};

export async function sweepStrandedHolds(input: {
  store: StrandedHoldStore;
  now?: () => number;
  /** Holds older than this many hours are reported, not settled. */
  maxAgeHours?: number;
  limit?: number;
}): Promise<StrandedHoldSweepResult> {
  const now = (input.now ?? Date.now)();
  const maxAgeHours = finite(input.maxAgeHours) && (input.maxAgeHours as number) > 0 ? (input.maxAgeHours as number) : STRANDED_HOLD_DEFAULT_MAX_AGE_HOURS;
  const limit = Math.max(1, Math.min(5000, Math.floor(finite(input.limit) ?? DEFAULT_LIMIT)));
  const before = new Date(now - STRANDED_HOLD_MIN_AGE_MINUTES * 60_000).toISOString();
  const from = new Date(now - maxAgeHours * 3_600_000).toISOString();
  const sweptAt = new Date(now).toISOString();

  const res: StrandedHoldSweepResult = {
    checked: 0,
    settled: 0,
    settledFromLedger: 0,
    settledUsd: 0,
    released: 0,
    raced: 0,
    otherSurface: 0,
    failed: 0,
    olderLeft: 0,
    truncated: false,
    reservationIds: []
  };

  const listed = await input.store.listStranded({ before, from, limit });
  res.truncated = listed.length >= limit;
  res.olderLeft = await input.store.countOlder(from);
  const rows = listed.filter((r) => {
    if (sweptSurfaceOf(r)) return true;
    res.otherSurface += 1;
    return false;
  });
  res.checked = rows.length;
  const decisions = rows.length ? await input.store.ledgerDecisions(rows.map((r) => r.reservation_id)) : new Map<string, LedgerDecision>();

  for (const row of rows) {
    const key = { reservationId: row.reservation_id, userId: row.user_id };
    const decision = decisions.get(row.reservation_id);
    const base = withoutPlatformPaid(row.metadata);
    try {
      if (decision?.entryType === 'RELEASE') {
        const done = await input.store.finishIfReserved(key, {
          status: 'RELEASED',
          metadata: { ...base, releasedBy: 'sweep', sweptAt, releaseReason: decision.metadata?.reason ?? 'released' }
        });
        if (done) res.released += 1;
        else res.raced += 1;
        continue;
      }
      const fromLedger = decision?.entryType === 'SETTLE';
      const providerCostUsd = round6((fromLedger ? finite(decision?.providerCostUsd) : undefined) ?? finite(row.provider_cost_usd) ?? 0);
      const billableUsd = round6((fromLedger ? finite(decision?.billableUsd) : undefined) ?? finite(row.billable_usd) ?? 0);
      const actualCt = Math.max(0, Math.floor((fromLedger ? finite(decision?.metadata?.actualCt) : undefined) ?? finite(row.estimated_ct) ?? 0));
      const metadata = { ...base, settledBy: 'sweep', sweptAt, ...(fromLedger ? { settledFrom: 'ledger' } : { settledAt: 'hold' }) };
      const done = await input.store.finishIfReserved(key, {
        status: 'SETTLED',
        actual_ct: actualCt,
        provider_cost_usd: providerCostUsd,
        billable_usd: billableUsd,
        metadata
      });
      if (!done) {
        res.raced += 1;
        continue;
      }
      res.settled += 1;
      res.settledUsd = round6(res.settledUsd + providerCostUsd);
      if (res.reservationIds.length < 50) res.reservationIds.push(row.reservation_id);
      if (fromLedger) {
        res.settledFromLedger += 1;
        continue;
      }
      // The bookkeeping entry a normal usage-budget settle writes. The row above is what the budget
      // counts, so a failure here never double- or under-counts; it is logged for the books.
      try {
        await input.store.recordSettle({
          userId: row.user_id,
          reservationId: row.reservation_id,
          operation: row.operation,
          provider: row.provider,
          model: row.model,
          projectId: row.project_id,
          providerCostUsd,
          billableUsd,
          metadata: { ...base, settledBy: 'sweep', sweptAt, walletSkipped: true, estimatedCt: finite(row.estimated_ct) ?? 0, actualCt }
        });
      } catch (err) {
        logger.error('billing_stranded_hold_ledger_failed', { reservationId: row.reservation_id, message: (err as Error)?.message });
      }
    } catch (err) {
      res.failed += 1;
      logger.error('billing_stranded_hold_sweep_failed', { reservationId: row.reservation_id, userId: row.user_id, message: (err as Error)?.message });
    }
  }

  const { reservationIds: _ids, ...counts } = res;
  logger.info('billing_stranded_hold_sweep', { ...counts, before, from });
  return res;
}

const COST_EVENT_COLUMNS = 'id, user_id, reservation_id, operation, provider, model, project_id, estimated_ct, provider_cost_usd, billable_usd, metadata, created_at';
const ID_CHUNK = 100;

/** The production store: the service-role client over generation_cost_events + token_ledger_entries. */
export const supabaseStrandedHoldStore = (admin: SupabaseClient): StrandedHoldStore => {
  // RESERVED, metered through the usage budget (the reserve RPC tags `usageBudget`), not BYOK.
  const usageHolds = () =>
    admin
      .from('generation_cost_events')
      .select(COST_EVENT_COLUMNS)
      .eq('status', 'RESERVED')
      .eq('is_byok', false)
      .not('reservation_id', 'is', null)
      .eq('metadata->>usageBudget', 'true');
  return {
    async listStranded({ before, from, limit }) {
      const { data, error } = await usageHolds().lt('created_at', before).gte('created_at', from).order('created_at', { ascending: true }).limit(limit);
      if (error) throw error;
      return ((data || []) as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        reservation_id: String(r.reservation_id),
        user_id: String(r.user_id),
        operation: String(r.operation || ''),
        provider: String(r.provider || ''),
        model: String(r.model || ''),
        project_id: typeof r.project_id === 'string' ? r.project_id : null,
        estimated_ct: finite(r.estimated_ct) ?? 0,
        provider_cost_usd: finite(r.provider_cost_usd) ?? 0,
        billable_usd: finite(r.billable_usd) ?? 0,
        metadata: r.metadata && typeof r.metadata === 'object' ? (r.metadata as Record<string, unknown>) : {},
        created_at: String(r.created_at)
      }));
    },
    async countOlder(from) {
      const { count, error } = await admin
        .from('generation_cost_events')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'RESERVED')
        .eq('is_byok', false)
        .not('reservation_id', 'is', null)
        .eq('metadata->>usageBudget', 'true')
        .lt('created_at', from);
      if (error) throw error;
      return count || 0;
    },
    async ledgerDecisions(ids) {
      const out = new Map<string, LedgerDecision>();
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const { data, error } = await admin
          .from('token_ledger_entries')
          .select('reservation_id, entry_type, provider_cost_usd, billable_usd, metadata')
          .in('reservation_id', ids.slice(i, i + ID_CHUNK))
          .in('entry_type', ['SETTLE', 'RELEASE']);
        if (error) throw error;
        for (const e of (data || []) as Record<string, unknown>[]) {
          const id = String(e.reservation_id);
          if (out.get(id)?.entryType === 'SETTLE') continue;
          out.set(id, {
            entryType: e.entry_type === 'SETTLE' ? 'SETTLE' : 'RELEASE',
            providerCostUsd: finite(e.provider_cost_usd) ?? null,
            billableUsd: finite(e.billable_usd) ?? null,
            metadata: e.metadata && typeof e.metadata === 'object' ? (e.metadata as Record<string, unknown>) : {}
          });
        }
      }
      return out;
    },
    async finishIfReserved({ reservationId, userId }, patch) {
      const { data, error } = await admin
        .from('generation_cost_events')
        .update(patch)
        .eq('reservation_id', reservationId)
        .eq('user_id', userId)
        .eq('status', 'RESERVED')
        .select('id');
      if (error) throw error;
      return Array.isArray(data) && data.length > 0;
    },
    async recordSettle(entry) {
      const { error } = await admin.from('token_ledger_entries').insert({
        user_id: entry.userId,
        entry_type: 'SETTLE',
        ct_delta: 0,
        usd_delta: 0,
        provider_cost_usd: entry.providerCostUsd,
        billable_usd: entry.billableUsd,
        operation: entry.operation,
        provider: entry.provider,
        model: entry.model,
        project_id: entry.projectId,
        reservation_id: entry.reservationId,
        is_byok: false,
        metadata: entry.metadata
      });
      if (error) throw error;
    }
  };
};
