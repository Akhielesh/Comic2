// What planning, style directions and translation really cost (docs/features/pricing.md § Text rates).
//
// Every text call is already reserved and settled in the usage ledger (token_ledger_entries SETTLE / BYOK_SETTLED
// rows: the provider's cost and whether it reported one). The calls of one text OPERATION — a page plan (an outline,
// its chunks and the plan check's repair), a style-directions proposal, one language of a translation — carry the
// same tag in their ledger metadata (`textOp`, see textOpTag): the operation's id, its kind, how many units it
// covered and `baseUsd`, the provider estimate the constants (or, for translation, the token count) give it. That
// base is always the constant estimate, never a calibrated quote, so an observed rate never feeds on itself.
//
// From those rows:
//   factor of one operation = Σ provider cost of its calls ÷ baseUsd (only when EVERY call reported its cost: a
//                             stopped or timed-out call settles as an estimate, unreported, so its operation is left
//                             out); a repair round's call (tagged `repair`) is not part of one pass and does not count;
//                             the factor is clipped to [1 / MAX_OP_FACTOR, MAX_OP_FACTOR] on both sides alike — a
//                             cheap operation is a real observation, and a bad row only ever moves the median one step;
//   rate of a kind          = the median factor of the newest ≤ TEXT_RATE_WINDOW operations — the person's own when
//                             they have ≥ TEXT_RATE_MIN_N, else everyone's when those come from ≥ MIN_PLATFORM_USERS
//                             people, else nothing observed;
//   quoted                  = constant × max(1, rate): the constants are the floor and the fallback.
//
// One bounded read (the newest ≤ READ_LIMIT tagged rows of the last LOOKBACK_DAYS, DB_READ_TIMEOUT_MS; indexed by
// server/sql/token_ledger_text_ops.sql) serves every quote for TEXT_RATES_TTL_MS: a quote is never a hot database query, and a failed read keeps the last good batch
// (else the constants) and is not retried for FAILURE_BACKOFF_MS. Nothing here runs on a timer: a read happens only
// when a quote asks and the batch is stale.

import { newId } from '../../../../shared/comic/doc.js';
import {
  FLOOR_TEXT_RATES,
  TEXT_FLOOR_USD,
  TEXT_OP_KINDS,
  sanitizeTextRates,
  type TextOpKind,
  type TextRateBasis,
  type TextRates
} from '../../../../shared/comic/priceBook.js';
import { logger } from '../../lib/logger.js';
import { getSupabaseAdmin, getSupabaseCapabilityStatus } from '../../services/supabase.js';
import { median, MIN_PLATFORM_USERS } from './observed.js';

export type { TextOpKind, TextRates };

/** Operations needed before a rate is observed (own, or everyone's). */
export const TEXT_RATE_MIN_N = 5;
/** The newest operations a rate is the median of. */
export const TEXT_RATE_WINDOW = 20;
/** A single operation counts at most this many times its estimate, and at least its reciprocal (symmetric clip). */
export const MAX_OP_FACTOR = 10;
export const MIN_OP_FACTOR = 1 / MAX_OP_FACTOR;
export const TEXT_RATES_TTL_MS = 10 * 60_000;
export const FAILURE_BACKOFF_MS = 2 * 60_000;
export const LOOKBACK_DAYS = 30;
export const READ_LIMIT = 1000;
export const DB_READ_TIMEOUT_MS = 5_000;

const DAY_MS = 86_400_000;
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

// ── The tag ──────────────────────────────────────────────────────────────────

/** Rides on every ledger row of one text operation's calls (metadata.textOp). Ids and numbers only. */
export interface TextOpTag {
  id: string;
  kind: TextOpKind;
  /** Pages planned (plan), 1 (style directions, one language of a translation). */
  units: number;
  /** The provider estimate the constants / token count give this operation (USD, before markup). */
  baseUsd: number;
  /**
   * This call is a repair round (writer.ts completeStructured sends a reply back once with its problems). Left out of
   * the operation's cost: the rate is what one pass costs, and a quote bounds the repair on top of it.
   */
  repair?: true;
}

const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

/**
 * A new operation's tag. `baseUsd` defaults to the kind's constant × units (plan, style directions); a translation
 * passes its token estimate. Undefined when there is no positive base to compare a bill with.
 */
export const textOpTag = (kind: TextOpKind, units: number, baseUsd?: number): TextOpTag | undefined => {
  const n = isNum(units) && units >= 1 ? Math.floor(units) : 1;
  const base = isNum(baseUsd) ? baseUsd : kind === 'translate' ? NaN : TEXT_FLOOR_USD[kind] * n;
  if (!isNum(base) || base <= 0) return undefined;
  return { id: newId('op'), kind, units: n, baseUsd: round6(base) };
};

const KINDS = new Set<string>(TEXT_OP_KINDS);

/** A tag read back from a ledger row (anything malformed → undefined). */
export const parseTextOpTag = (value: unknown): TextOpTag | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id || v.id.length > 64 || typeof v.kind !== 'string' || !KINDS.has(v.kind)) return undefined;
  const units = Number(v.units);
  const baseUsd = Number(v.baseUsd);
  if (!isNum(units) || units < 1 || !isNum(baseUsd) || baseUsd <= 0) return undefined;
  return { id: v.id, kind: v.kind as TextOpKind, units: Math.floor(units), baseUsd, ...(v.repair === true ? { repair: true as const } : {}) };
};

// ── From ledger rows to rates (pure) ─────────────────────────────────────────

/** One settled ledger row of a tagged text call. */
export interface TextOpCallRow {
  userId: string;
  providerCostUsd: number | null;
  /** The provider reported this call's cost (metadata.providerCostReported). */
  reported: boolean;
  op: TextOpTag;
  /** ISO time. */
  createdAt: string;
}

/** One finished operation: whose, which kind, what it cost against its estimate, and when it ended. */
export interface TextOpObservation {
  userId: string;
  kind: TextOpKind;
  factor: number;
  at: number;
}

/**
 * Calls → operations: grouped by tag id; an operation with any unreported or unpriced call is left out, and a repair
 * round's call is not counted (the rate is one pass; quotes bound the repair on top).
 */
export const operationsFromCalls = (rows: readonly TextOpCallRow[]): TextOpObservation[] => {
  const ops = new Map<string, { userId: string; op: TextOpTag; cost: number; at: number; ok: boolean }>();
  for (const r of rows) {
    if (r.op.repair) continue;
    const key = `${r.userId}|${r.op.id}`;
    const at = Date.parse(r.createdAt);
    const cur = ops.get(key) ?? { userId: r.userId, op: r.op, cost: 0, at: 0, ok: true };
    if (!r.reported || !isNum(r.providerCostUsd) || r.providerCostUsd < 0) cur.ok = false;
    else cur.cost += r.providerCostUsd;
    if (isNum(at) && at > cur.at) cur.at = at;
    ops.set(key, cur);
  }
  const out: TextOpObservation[] = [];
  for (const o of ops.values()) {
    if (!o.ok || !(o.op.baseUsd > 0)) continue;
    const factor = o.cost / o.op.baseUsd;
    if (!isNum(factor)) continue;
    out.push({ userId: o.userId, kind: o.op.kind, factor: Math.min(MAX_OP_FACTOR, Math.max(MIN_OP_FACTOR, factor)), at: o.at });
  }
  return out.sort((a, b) => b.at - a.at);
};

/** The observed factor of one kind for a person: theirs first, then everyone's (≥ MIN_PLATFORM_USERS people). */
export const observedFactor = (ops: readonly TextOpObservation[], kind: TextOpKind, userId?: string): { factor: number; basis: TextRateBasis } | null => {
  const ofKind = ops.filter((o) => o.kind === kind);
  const own = userId ? ofKind.filter((o) => o.userId === userId).slice(0, TEXT_RATE_WINDOW) : [];
  if (own.length >= TEXT_RATE_MIN_N) {
    const m = median(own.map((o) => o.factor));
    if (m !== null) return { factor: m, basis: { source: 'observed', n: own.length, scope: 'you' } };
  }
  const everyone = ofKind.slice(0, TEXT_RATE_WINDOW);
  if (everyone.length >= TEXT_RATE_MIN_N && new Set(everyone.map((o) => o.userId)).size >= MIN_PLATFORM_USERS) {
    const m = median(everyone.map((o) => o.factor));
    if (m !== null) return { factor: m, basis: { source: 'observed', n: everyone.length, scope: 'platform' } };
  }
  return null;
};

/** The text rates for a person: each constant × max(1, the observed factor). */
export const textRatesFrom = (ops: readonly TextOpObservation[], userId?: string): TextRates => {
  const basis: NonNullable<TextRates['basis']> = {};
  const factorOf = (kind: TextOpKind): number => {
    const seen = observedFactor(ops, kind, userId);
    // The higher of observed and the constant: an observation only ever raises a quote.
    if (seen && seen.factor > 1) {
      basis[kind] = seen.basis;
      return seen.factor;
    }
    basis[kind] = seen ? { ...seen.basis, source: 'floor' } : { source: 'floor' };
    return 1;
  };
  return sanitizeTextRates({
    planPerPageUsd: TEXT_FLOOR_USD.plan * factorOf('plan'),
    styleDirectionsUsd: TEXT_FLOOR_USD.style_directions * factorOf('style_directions'),
    translateFactor: factorOf('translate'),
    basis
  });
};

// ── The ledger read ──────────────────────────────────────────────────────────

export interface TextRatesDb {
  /** The newest tagged, settled text-call rows since `sinceIso` (all people; service role), at most `limit`. */
  recentTaggedCalls(sinceIso: string, limit: number): Promise<TextOpCallRow[]>;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A token_ledger_entries row → TextOpCallRow (untagged or malformed → null). */
export const textOpCallFromDb = (r: Record<string, unknown>): TextOpCallRow | null => {
  const meta = (r.metadata && typeof r.metadata === 'object' ? r.metadata : {}) as Record<string, unknown>;
  const op = parseTextOpTag(meta.textOp);
  const userId = typeof r.user_id === 'string' ? r.user_id : '';
  const createdAt = typeof r.created_at === 'string' ? r.created_at : '';
  if (!op || !userId || !createdAt) return null;
  return { userId, providerCostUsd: num(r.provider_cost_usd), reported: meta.providerCostReported === true, op, createdAt };
};

/** The usage ledger behind the rates (service role; settled rows only). Null when the database is not configured. */
export const createSupabaseTextRatesDb = (): TextRatesDb | null => {
  if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) return null;
  return {
    async recentTaggedCalls(sinceIso, limit) {
      const { data, error } = await getSupabaseAdmin()
        .from('token_ledger_entries')
        .select('user_id, provider_cost_usd, metadata, created_at')
        .in('entry_type', ['SETTLE', 'BYOK_SETTLED'])
        .gte('created_at', sinceIso)
        .not('metadata->textOp', 'is', null)
        .order('created_at', { ascending: false })
        .limit(limit)
        .abortSignal(AbortSignal.timeout(DB_READ_TIMEOUT_MS));
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => textOpCallFromDb(r as Record<string, unknown>)).filter((r): r is TextOpCallRow => !!r);
    }
  };
};

// ── The in-memory cache ──────────────────────────────────────────────────────

export interface TextRateSource {
  /** The person's rates; waits at most `maxWaitMs` for a stale batch to refresh (then the last batch, else the constants). */
  forUser(userId?: string, opts?: { maxWaitMs?: number }): Promise<TextRates>;
}

export interface TextRateSourceDeps {
  db: TextRatesDb | null;
  now?: () => number;
  ttlMs?: number;
}

export const createTextRateSource = (deps: TextRateSourceDeps): TextRateSource => {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? TEXT_RATES_TTL_MS;
  let batch: TextOpObservation[] | null = null;
  let at = -Infinity;
  let failedAt = -Infinity;
  let inflight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    if (!deps.db) return Promise.resolve();
    const t = now();
    if (batch && t - at < ttl) return Promise.resolve();
    if (t - failedAt < FAILURE_BACKOFF_MS) return Promise.resolve();
    if (inflight) return inflight;
    const since = new Date(t - LOOKBACK_DAYS * DAY_MS).toISOString();
    inflight = Promise.resolve()
      .then(() => deps.db!.recentTaggedCalls(since, READ_LIMIT))
      .then(
        (rows) => {
          batch = operationsFromCalls(rows);
          at = now();
        },
        (err: unknown) => {
          failedAt = now();
          // An error, not a warning: until a read succeeds again every text quote stands on the constants.
          logger.error('comic_text_rates_read_failed', { message: (err as Error)?.message, lastGoodAt: Number.isFinite(at) ? new Date(at).toISOString() : null });
        }
      )
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    async forUser(userId, opts = {}) {
      const pending = refresh();
      const wait = opts.maxWaitMs;
      if (isNum(wait) && wait >= 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([pending, new Promise<void>((resolve) => (timer = setTimeout(resolve, wait)))]);
        if (timer) clearTimeout(timer);
      } else await pending;
      return batch ? textRatesFrom(batch, userId) : FLOOR_TEXT_RATES;
    }
  };
};

let processSource: TextRateSource | null = null;

/** The one source per process (lazy: nothing is read at import). */
export const textRateSource = (): TextRateSource => (processSource ??= createTextRateSource({ db: createSupabaseTextRatesDb() }));

/** Tests swap the process source (null = rebuild lazily on next use). */
export const setTextRateSource = (source: TextRateSource | null): void => {
  processSource = source;
};
