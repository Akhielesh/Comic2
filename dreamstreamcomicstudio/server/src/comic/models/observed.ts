// Our own per-call facts (models.md §4.5 S7, §2.3 observed price, §2.4 R4, §4.4 T2/T6/T7): pure statistics over
// `comic_image_calls` rows — the user's own rows (owner RLS) and the platform aggregate that the security-definer
// `comic_image_model_stats(p_since)` already suppresses below 5 distinct users (re-checked here, belt and braces).
// No fetching, no timers, no guesses: when n is too small the entry is simply absent and the UI shows the §4.6 copy.

import type { Resolution } from '../../../../shared/comic/doc.js';
import type { ImageJobKind } from '../../../../shared/comic/models.js';
import { OBSERVED_MIN_N, OBSERVED_WINDOW, QC_OBSERVED_MIN_N, type ObservedMedian } from './pricing.js';

/** Platform aggregates are shown only above this many distinct users (models.md §4.4 T7, §4.5 S7, AT-9). */
export const MIN_PLATFORM_USERS = 5;
export const NOT_ENOUGH_DATA_COPY = 'Not enough data yet';
export const RELIABILITY_WINDOW_H = 24 as const;

export type ObservedKind = ImageJobKind | 'qc';

/** One `comic_image_calls` row as the server reads it (camelCase; the SQL file has the column list). */
export interface ImageCallRow {
  userId?: string;
  projectId?: string | null;
  modelId: string;
  providerModel?: string | null;
  route?: 'openrouter' | 'gemini' | null;
  providerName?: string | null;
  kind: string;
  res: string | null;
  aspect?: string | null;
  refs?: number | null;
  outcome: 'ok' | 'failed' | 'blocked';
  httpStatus?: number | null;
  errorCode?: string | null;
  /** Provider-reported cost; null = not reported. */
  providerCostUsd: number | null;
  billedUsd?: number | null;
  byok?: boolean | null;
  latencyMs?: number | null;
  /** ISO timestamp. */
  createdAt: string;
}

/** One group from `comic_image_model_stats(p_since)` (already ≥ 5 distinct users). */
export interface PlatformStatRow {
  modelId: string;
  kind: string;
  res: string | null;
  calls: number;
  ok: number;
  failed: number;
  rateLimited: number;
  distinctUsers: number;
  /** ok calls with a provider-reported cost. */
  pricedCalls: number;
  /** How many of the newest ≤ 20 priced calls the cost figures cover (null = no cost shown: < 5 users there). */
  costN: number | null;
  medianCostUsd: number | null;
  minCostUsd: number | null;
  maxCostUsd: number | null;
  /** The time span of those ≤ 20 priced calls. */
  costFrom: string | null;
  costTo: string | null;
  firstAt: string | null;
  lastAt: string | null;
}

/** `model_usage_monthly` row for product 'comic_studio'. */
export interface MonthlyUsageRow {
  month: string;
  product: string;
  source: string;
  model: string;
  requests: number;
}

export interface ObservedEntry {
  kind: ObservedKind;
  res: Resolution;
  n: number;
  medianUsd: number;
  minUsd: number;
  maxUsd: number;
  from: string;
  to: string;
  scope: 'you' | 'platform';
}

export interface ReliabilityEntry {
  windowH: typeof RELIABILITY_WINDOW_H;
  calls: number;
  failed: number;
  rateLimited: number;
  scope: 'you' | 'platform';
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const RESOLUTIONS = new Set<string>(['512', '1K', '2K', '4K']);
export const asResolution = (res: string | null | undefined): Resolution | undefined => (res && RESOLUTIONS.has(res) ? (res as Resolution) : undefined);

/** Median of a list (average of the two middle values for even n); NaN-free: non-finite values are dropped. */
export const median = (values: number[]): number | null => {
  const nums = values.filter(isNum).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
};

const newestFirst = (rows: ImageCallRow[]) => [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

/** A row that reached the provider and settled with a reported cost (what an observed price is made of). */
const priced = (r: ImageCallRow) => r.outcome === 'ok' && isNum(r.providerCostUsd) && r.providerCostUsd >= 0;

/** A 429: the provider's status or our classified code. */
export const isRateLimited = (r: Pick<ImageCallRow, 'httpStatus' | 'errorCode'>): boolean => r.httpStatus === 429 || r.errorCode === 'RATE_LIMIT';

/**
 * The user's observed price for one (model, kind, res): median of the last ≤ 20 priced calls, or null below
 * OBSERVED_MIN_N (§4.6: "Observed n < 3 → only the list price").
 */
export const observedFor = (rows: ImageCallRow[], q: { modelId: string; kind: string; res: Resolution; limit?: number }): ObservedEntry | null => {
  const limit = q.limit ?? OBSERVED_WINDOW;
  const hits = newestFirst(rows)
    .filter((r) => r.modelId === q.modelId && r.kind === q.kind && r.res === q.res && priced(r))
    .slice(0, limit);
  if (hits.length < OBSERVED_MIN_N) return null;
  const costs = hits.map((r) => r.providerCostUsd as number);
  const med = median(costs);
  if (med === null) return null;
  return {
    kind: q.kind as ObservedKind,
    res: q.res,
    n: hits.length,
    medianUsd: round4(med),
    minUsd: round4(Math.min(...costs)),
    maxUsd: round4(Math.max(...costs)),
    from: hits[hits.length - 1].createdAt,
    to: hits[0].createdAt,
    scope: 'you'
  };
};

/**
 * Platform entries for a model: only groups the function already published (≥ 5 users) whose cost figures it
 * reported. `n` is the number of priced calls those figures cover (the newest ≤ 20, models.md §2.3), never the
 * group's ok count (which includes calls with no reported cost); from/to are that window's span.
 */
export const platformObservedFor = (stats: PlatformStatRow[], modelId: string): ObservedEntry[] =>
  stats
    .filter((s) => s.modelId === modelId && s.distinctUsers >= MIN_PLATFORM_USERS && isNum(s.costN) && s.costN >= OBSERVED_MIN_N && isNum(s.medianCostUsd) && asResolution(s.res))
    .map((s) => ({
      kind: s.kind as ObservedKind,
      res: asResolution(s.res)!,
      n: s.costN as number,
      medianUsd: round4(s.medianCostUsd as number),
      minUsd: round4(isNum(s.minCostUsd) ? s.minCostUsd : (s.medianCostUsd as number)),
      maxUsd: round4(isNum(s.maxCostUsd) ? s.maxCostUsd : (s.medianCostUsd as number)),
      from: s.costFrom ?? s.firstAt ?? '',
      to: s.costTo ?? s.lastAt ?? '',
      scope: 'platform' as const
    }));

/**
 * Every observed entry for a model: the user's own (kind × res groups with n ≥ 3), then platform groups the
 * user has no entry for. Kinds are whatever was recorded (page, sheet, cover, edit, place, style_option, qc).
 */
export const observedEntriesFor = (yours: ImageCallRow[], platform: PlatformStatRow[], modelId: string): ObservedEntry[] => {
  const groups = new Map<string, { kind: string; res: Resolution }>();
  for (const r of yours) {
    const res = asResolution(r.res);
    if (r.modelId === modelId && res && priced(r)) groups.set(`${r.kind}|${res}`, { kind: r.kind, res });
  }
  const own: ObservedEntry[] = [];
  for (const g of groups.values()) {
    const e = observedFor(yours, { modelId, kind: g.kind, res: g.res });
    if (e) own.push(e);
  }
  const have = new Set(own.map((e) => `${e.kind}|${e.res}`));
  const shared = platformObservedFor(platform, modelId).filter((e) => !have.has(`${e.kind}|${e.res}`));
  const order = (e: ObservedEntry) => `${e.kind}|${e.res}`;
  return [...own, ...shared].sort((a, b) => order(a).localeCompare(order(b)));
};

/** PriceBook input: observed medians for every model in the rows. */
export const observedMedians = (yours: ImageCallRow[], platform: PlatformStatRow[]): ObservedMedian[] => {
  const ids = new Set<string>([...yours.map((r) => r.modelId), ...platform.map((s) => s.modelId)].filter(Boolean));
  const out: ObservedMedian[] = [];
  for (const modelId of ids) {
    for (const e of observedEntriesFor(yours, platform, modelId)) out.push({ modelId, kind: e.kind, res: e.res, n: e.n, medianUsd: e.medianUsd, minUsd: e.minUsd, maxUsd: e.maxUsd, scope: e.scope });
  }
  return out;
};

/** Observed vision-QC cost per page: median of the user's last ≤ 20 priced 'qc' rows; null below QC_OBSERVED_MIN_N. */
export const qcObservedFor = (rows: ImageCallRow[]): { medianUsd: number; n: number } | null => {
  const hits = newestFirst(rows).filter((r) => r.kind === 'qc' && priced(r)).slice(0, OBSERVED_WINDOW);
  if (hits.length < QC_OBSERVED_MIN_N) return null;
  const med = median(hits.map((r) => r.providerCostUsd as number));
  return med === null ? null : { medianUsd: round4(med), n: hits.length };
};

/**
 * Success / 429 counts for a model inside a window (§2.4 R4). 'blocked' rows never reached a provider (preflight
 * stopped them) and are not calls. Null when the user made no call in the window.
 */
export const reliabilityFor = (rows: ImageCallRow[], q: { modelId: string; now: number; windowH?: number }): ReliabilityEntry | null => {
  const windowH = q.windowH ?? RELIABILITY_WINDOW_H;
  const since = q.now - windowH * 3_600_000;
  const hits = rows.filter((r) => r.modelId === q.modelId && r.outcome !== 'blocked' && Date.parse(r.createdAt) >= since && Date.parse(r.createdAt) <= q.now);
  if (!hits.length) return null;
  return {
    windowH: RELIABILITY_WINDOW_H,
    calls: hits.length,
    failed: hits.filter((r) => r.outcome === 'failed').length,
    rateLimited: hits.filter((r) => r.outcome === 'failed' && isRateLimited(r)).length,
    scope: 'you'
  };
};

/** The platform's reliability for a model from the (≥ 5 users) stats, summed over kinds and resolutions. */
export const platformReliabilityFor = (stats: PlatformStatRow[], modelId: string): ReliabilityEntry | null => {
  const hits = stats.filter((s) => s.modelId === modelId && s.distinctUsers >= MIN_PLATFORM_USERS);
  if (!hits.length) return null;
  const sum = (f: (s: PlatformStatRow) => number) => hits.reduce((a, s) => a + f(s), 0);
  const calls = sum((s) => s.calls);
  if (!calls) return null;
  return { windowH: RELIABILITY_WINDOW_H, calls, failed: sum((s) => s.failed), rateLimited: sum((s) => s.rateLimited), scope: 'platform' };
};

/** T2: the user's images per month per model (ok calls only). */
export const monthlyByModel = (rows: ImageCallRow[]): { month: string; modelId: string; images: number }[] => {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.outcome !== 'ok' || !r.modelId) continue;
    const month = r.createdAt.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const key = `${month}|${r.modelId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, images]) => {
      const [month, modelId] = key.split('|');
      return { month, modelId, images };
    })
    .sort((a, b) => a.month.localeCompare(b.month) || a.modelId.localeCompare(b.modelId));
};

/** T7: most used by DreamStream creators — hidden (null) unless every shown group has ≥ 5 distinct users. */
export const platformTopModels = (stats: PlatformStatRow[]): { modelId: string; calls: number; users: number }[] | null => {
  const byModel = new Map<string, { calls: number; users: number }>();
  for (const s of stats) {
    if (s.distinctUsers < MIN_PLATFORM_USERS) continue;
    const cur = byModel.get(s.modelId) ?? { calls: 0, users: 0 };
    cur.calls += s.calls;
    cur.users = Math.max(cur.users, s.distinctUsers);
    byModel.set(s.modelId, cur);
  }
  const list = [...byModel.entries()].map(([modelId, v]) => ({ modelId, ...v })).sort((a, b) => b.calls - a.calls || a.modelId.localeCompare(b.modelId));
  return list.length ? list : null;
};
