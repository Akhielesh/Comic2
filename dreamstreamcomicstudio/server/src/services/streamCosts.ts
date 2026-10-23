// Admin → Costs → Stream Studio: what Stream Studio and the baby monitor cost, on real data.
//
//   fetchStreamAnalytics(...)   Live reads, only when CF_ANALYTICS_API_TOKEN + CLOUDFLARE_ACCOUNT_ID exist
//                               (the same read-only token as the Workers card; + Account Analytics Read
//                               covers Analytics Engine). ≤ 4 GraphQL queries + 1 Analytics Engine
//                               query per load, month to date; every dataset degrades on its own.
//   buildStreamSection(...)     PURE: raw analytics in → StreamCostSection out (unit-tested).
//
// Provenance, as everywhere in the Cost centre:
//   measured  — Cloudflare's own GraphQL analytics (the control total): DO requests / duration / rows,
//               R2 operations, TURN egress, Worker requests — ACCOUNT-WIDE, month to date.
//   estimated — the rooms' in-room counters (live-worker/src/usageMeter.ts → Analytics Engine) × the
//               list prices in shared/stream/usage.ts. Attribution per feature, nursery, account, event.
//   fixed     — plan fees (FIXED_COSTS in costCentre.ts).
//
// Stream Studio does not charge users (ADR 0007 D1): every $ here is DreamStream's cost. Counters are
// accurate estimates, not billing-grade. Design: docs/features/stream-studio-costs.md §3.

import type {
  CloudflareSection,
  CostSource,
  StreamConsumerRow,
  StreamCostSection,
  StreamFeatureRow,
  StreamHeadroomRow,
  StreamPathKey
} from '../../../shared/types/costCentre.js';
import {
  ACTIVE_MARK,
  addUsage,
  allocateOverage,
  emptyCounters,
  evaluateStreamAlerts,
  freePathShare,
  isUsageKind,
  listValueOfMonth,
  listValueUsd,
  monthBounds,
  PROJECTION_MIN_DAYS,
  projectMonthEnd,
  STREAM_ALLOWANCES,
  STREAM_METERS,
  STREAM_PATHS,
  STREAM_UNIT_PRICES,
  turnBytesOf,
  USAGE_DOUBLES,
  USAGE_KIND_LABEL,
  USAGE_KINDS,
  usageFromDoubles,
  type MeterId,
  type UsageCounters,
  type UsageKind,
  type UsageScope
} from '../../../shared/stream/usage.js';

const DAY_MS = 86_400_000;
const GB = 1e9;
const TIMEOUT_MS = 8_000;
/** Durable Objects bill duration for 128 MB per object (pricing example: s × 128 MB / 1 GB). */
const DO_GB = 0.128;
/** Analytics Engine keeps about three months. */
const AE_MAX_DAYS = 90;
export const AE_ROW_LIMIT = 10_000;
export const AE_DATASET = 'stream_usage';
export const LIVE_SCRIPT = 'dreamstream-live';
export const LIVE_BUCKET = 'dreamstream-live';
/** The Durable Object classes that are Stream Studio (all in dreamstream-live). */
export const STREAM_DO_CLASSES = ['MonitorRoom', 'EventRoom', 'UserLine', 'CallRoom'] as const;

export const CLOUDFLARE_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
export const analyticsEngineSqlUrl = (accountId: string) => `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`;

export interface StreamCredentials {
  token: string;
  accountId: string;
}

/** Same env as the Workers card. Values never leave this module. */
export const streamCredentialsFromEnv = (env: NodeJS.ProcessEnv = process.env): StreamCredentials | null => {
  const token = String(env.CF_ANALYTICS_API_TOKEN || '').trim();
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  return token && accountId ? { token, accountId } : null;
};

/**
 * Optional, non-secret: which Durable Object namespace is which room — `MonitorRoom=<id>,EventRoom=<id>,…`
 * (32-hex namespace ids, from Cloudflare dashboard → Durable Objects). Without it, DO totals stay
 * account-wide (and are labelled so).
 */
export const namespaceLabelsFromEnv = (env: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of String(env.STREAM_DO_NAMESPACES || '').split(',')) {
    const [cls, id] = part.split('=').map((s) => s.trim());
    if (cls && id && /^[0-9a-f]{32}$/i.test(id)) out[id.toLowerCase()] = cls;
  }
  return out;
};

// ─── Cloudflare GraphQL (measured, month to date) ─────────────────────────────────────────
// Dataset and field names per developers.cloudflare.com (DO metrics-and-analytics, R2 metrics,
// Realtime TURN analytics; checked 2026-10-22). Each query is separate so a field the account's
// schema doesn't have fails only its own panel. Verify with GraphQL introspection if one errors.

const Q_REQUESTS = `query StreamRequests($accountTag: string!, $start: Time!, $end: Time!, $startDate: Date!, $endDate: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }) {
        dimensions { scriptName }
        sum { requests }
      }
      durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { date_geq: $startDate, date_leq: $endDate }) {
        dimensions { date namespaceId }
        sum { requests }
      }
    }
  }
}`;

const Q_DO_PERIODIC = `query StreamDoPeriodic($accountTag: string!, $startDate: Date!, $endDate: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      durableObjectsPeriodicGroups(limit: 10000, filter: { date_geq: $startDate, date_leq: $endDate }) {
        dimensions { date namespaceId }
        sum { activeTime rowsWritten }
      }
    }
  }
}`;

const Q_R2 = `query StreamR2($accountTag: string!, $start: Time!, $end: Time!, $storageStart: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) {
        dimensions { actionType bucketName }
        sum { requests }
      }
      r2StorageAdaptiveGroups(limit: 1000, filter: { datetime_geq: $storageStart, datetime_leq: $end }, orderBy: [datetime_DESC]) {
        dimensions { bucketName datetime }
        max { payloadSize }
      }
    }
  }
}`;

// Account total only: one query, no per-identifier fan-out (Cloudflare's advice for sampling).
const Q_TURN = `query StreamTurn($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      callsTurnUsageAdaptiveGroups(limit: 1, filter: { datetimeMinute_gt: $start, datetimeMinute_lt: $end }) {
        sum { egressBytes }
      }
    }
  }
}`;

/** R2 Class A operations (pricing page); free ones never bill; anything unknown counts as A (conservative). */
const R2_CLASS_B = new Set(['HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors', 'GetBucketLifecycleConfiguration']);
const R2_FREE = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload', 'DeleteObjects']);
export const r2OperationClass = (action: string): 'A' | 'B' | 'free' => (R2_FREE.has(action) ? 'free' : R2_CLASS_B.has(action) ? 'B' : 'A');

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text?: () => Promise<string> }>;

const scrub = (message: string, token: string) => message.split(token).join('[redacted]').slice(0, 240);

async function cfPost(creds: StreamCredentials, url: string, body: string, contentType: string, fetchImpl: FetchLike): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': contentType, Accept: 'application/json' },
      body,
      signal: controller.signal
    });
    const json = (await res.json().catch(() => ({}))) as { errors?: Array<{ message?: string }> | null };
    if (!res.ok) throw new Error(`HTTP ${res.status}${json?.errors?.[0]?.message ? `: ${json.errors[0].message}` : ''}`);
    if (Array.isArray(json?.errors) && json.errors.length > 0) throw new Error(json.errors[0]?.message || 'query failed');
    return json;
  } catch (err) {
    const message = (err as Error)?.name === 'AbortError' ? `timed out after ${TIMEOUT_MS / 1000}s` : (err as Error)?.message || 'request failed';
    throw new Error(scrub(message, creds.token));
  } finally {
    clearTimeout(timer);
  }
}

async function graphql(creds: StreamCredentials, query: string, variables: Record<string, string>, fetchImpl: FetchLike): Promise<Record<string, any>> {
  const json = (await cfPost(creds, CLOUDFLARE_GRAPHQL_URL, JSON.stringify({ query, variables: { accountTag: creds.accountId, ...variables } }), 'application/json', fetchImpl)) as {
    data?: { viewer?: { accounts?: Array<Record<string, any>> } };
  };
  // An answer with no account is not "zero usage": a wrong CLOUDFLARE_ACCOUNT_ID or a token without
  // access to it must read as a failure, never as all clear.
  const account = json?.data?.viewer?.accounts?.[0];
  if (!account || typeof account !== 'object') throw new Error('no account in the answer — check CLOUDFLARE_ACCOUNT_ID and that the token can read that account');
  return account;
}

/** A dataset's rows, or a failure: a field missing from the answer is "couldn't measure", never 0. */
function rowsOf(account: Record<string, any>, field: string): any[] {
  const v = account?.[field];
  if (!Array.isArray(v)) throw new Error(`${field} missing from the answer`);
  return v;
}

/** The five reads (each fails alone). The daily watch keeps the last state of every alert a failed one feeds. */
export const STREAM_DATASETS = ['requests', 'periodic', 'r2', 'turn', 'ae'] as const;
export type StreamDatasetId = (typeof STREAM_DATASETS)[number];
export const STREAM_DATASET_LABEL: Readonly<Record<StreamDatasetId, string>> = {
  requests: 'Worker + Durable Object requests',
  periodic: 'Durable Object duration + rows written',
  r2: 'R2 operations + storage',
  turn: 'TURN egress',
  ae: `Analytics Engine (${AE_DATASET})`
};

// ─── Analytics Engine (estimated: the rooms' hourly points) ──────────────────────────────

export interface AeUsageRow {
  /** UTC day 'YYYY-MM-DD'. */
  day: string;
  kind: UsageKind;
  scope: UsageScope;
  scopeId: string;
  account: string;
  counters: UsageCounters;
}

/** One query: per day × kind × scope × id, sample-weighted sums of every counter. */
export function aeUsageSql(days: number): string {
  const sums = USAGE_DOUBLES.map((_, i) => `SUM(_sample_interval * double${i + 1}) AS d${i + 1}`).join(', ');
  const n = Math.max(1, Math.min(AE_MAX_DAYS, Math.ceil(days)));
  return (
    `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, index1 AS kind, blob1 AS scope, blob2 AS scope_id, blob3 AS account, ${sums} ` +
    `FROM ${AE_DATASET} WHERE timestamp > NOW() - INTERVAL '${n}' DAY ` +
    `GROUP BY day, kind, scope, scope_id, account ORDER BY day DESC LIMIT ${AE_ROW_LIMIT} FORMAT JSON`
  );
}

export function parseAeRows(json: unknown): AeUsageRow[] {
  const data = (json as { data?: Array<Record<string, unknown>> })?.data;
  if (!Array.isArray(data)) return [];
  const out: AeUsageRow[] = [];
  for (const r of data) {
    const kind = r.kind;
    if (!isUsageKind(kind)) continue;
    const scope: UsageScope = r.scope === 'account' || r.scope === 'event' ? r.scope : 'nursery';
    const day = String(r.day ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    out.push({
      day,
      kind,
      scope,
      scopeId: String(r.scope_id ?? '').slice(0, 64),
      account: String(r.account ?? '').slice(0, 64),
      counters: usageFromDoubles(USAGE_DOUBLES.map((_, i) => Number(r[`d${i + 1}`]) || 0))
    });
  }
  return out;
}

/** A room's once-a-day activity mark (ACTIVE_MARK): this scope had a camera connected on this UTC day. */
export interface AeActiveMark {
  day: string;
  scope: UsageScope;
  scopeId: string;
}

/** The activity marks in the same Analytics Engine answer (index1 = ACTIVE_MARK). */
export function parseAeActive(json: unknown): AeActiveMark[] {
  const data = (json as { data?: Array<Record<string, unknown>> })?.data;
  if (!Array.isArray(data)) return [];
  const out: AeActiveMark[] = [];
  for (const r of data) {
    if (r.kind !== ACTIVE_MARK) continue;
    const day = String(r.day ?? '').slice(0, 10);
    const scopeId = String(r.scope_id ?? '').slice(0, 64);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !scopeId) continue;
    out.push({ day, scope: r.scope === 'account' || r.scope === 'event' ? r.scope : 'nursery', scopeId });
  }
  return out;
}

// ─── Fetch ───────────────────────────────────────────────────────────────────────────────

export interface StreamAnalytics {
  /** Credentials present (GraphQL + Analytics Engine were asked). */
  configured: boolean;
  nowMs: number;
  /** First UTC day the Analytics Engine rows cover. */
  aeFromMs: number;
  workersMtd?: { script: string; requests: number }[];
  doRequests?: { date: string; namespaceId: string; requests: number }[];
  doPeriodic?: { date: string; namespaceId: string; activeTimeUs: number; rowsWritten: number }[];
  r2Ops?: { bucket: string; actionType: string; requests: number }[];
  /** Latest stored bytes per bucket. */
  r2Storage?: { bucket: string; payloadBytes: number }[];
  turnEgressBytes?: number;
  ae?: AeUsageRow[];
  /** The rooms' daily activity marks (the per-active-nursery-day denominator), from the same query. */
  aeActive?: AeActiveMark[];
  /** Per-dataset failures, already scrubbed of the token. */
  errors: string[];
  /** The same failures by dataset (absent from callers that predate it: failedDatasets() also reads the shape). */
  failures?: Partial<Record<StreamDatasetId, string>>;
}

/**
 * The datasets that were asked and didn't answer. Unconfigured → none (nothing was asked). Read from
 * the shape too, so a dataset missing for any reason counts as unmeasured — never as zero.
 */
export function failedDatasets(a: StreamAnalytics | null | undefined): StreamDatasetId[] {
  if (!a?.configured) return [];
  const missing: Record<StreamDatasetId, boolean> = {
    requests: a.doRequests === undefined || a.workersMtd === undefined,
    periodic: a.doPeriodic === undefined,
    r2: a.r2Ops === undefined,
    turn: a.turnEgressBytes === undefined,
    ae: a.ae === undefined
  };
  return STREAM_DATASETS.filter((d) => missing[d] || a.failures?.[d] !== undefined);
}

/**
 * The datasets an alert is evaluated from. When one of them fails, the alert can't be checked: the
 * daily watch keeps its last state instead of calling it cleared. An unknown id depends on all of them.
 */
export function alertDatasets(alertId: string): StreamDatasetId[] {
  const id = String(alertId);
  if (id === 'free_tier:doRequests' || id === 'free_tier:workerRequests') return ['requests'];
  if (id === 'free_tier:doGbSeconds' || id === 'free_tier:doRowsWritten') return ['periodic'];
  if (id === 'free_tier:r2ClassA' || id === 'free_tier:r2ClassB' || id === 'free_tier:r2StoredGb' || id === 'r2_near_free') return ['r2'];
  if (id === 'free_tier:turnGb' || id === 'turn_spend' || id === 'turn_leak') return ['turn'];
  // Per active nursery-day: Cloudflare's duration / rows over the rooms' activity marks.
  if (id === 'hibernation' || id === 'write_diet') return ['periodic', 'ae'];
  if (id === 'relay_creep') return ['ae'];
  // Not from Cloudflare (email_log, container hours): no Cloudflare outage hides them.
  if (id === 'free_tier:emails' || id === 'email_near_free' || id === 'container_awake') return [];
  return [...STREAM_DATASETS];
}

const iso = (ms: number) => new Date(ms).toISOString();
const dayKey = (ms: number) => iso(ms).slice(0, 10);
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export async function fetchStreamAnalytics(input: {
  nowMs: number;
  /** Earliest instant the owner view needs from Analytics Engine (previous period start). */
  fromMs: number;
  creds?: StreamCredentials | null;
  fetchImpl?: FetchLike;
}): Promise<StreamAnalytics> {
  const creds = input.creds === undefined ? streamCredentialsFromEnv() : input.creds;
  const { startMs } = monthBounds(input.nowMs);
  const aeFromMs = Math.max(Date.UTC(new Date(input.fromMs).getUTCFullYear(), new Date(input.fromMs).getUTCMonth(), new Date(input.fromMs).getUTCDate()), input.nowMs - AE_MAX_DAYS * DAY_MS);
  const out: StreamAnalytics = { configured: !!creds, nowMs: input.nowMs, aeFromMs, errors: [] };
  if (!creds) return out;
  const fetchImpl = input.fetchImpl ?? (fetch as unknown as FetchLike);
  const vars = { start: iso(startMs), end: iso(input.nowMs), startDate: dayKey(startMs), endDate: dayKey(input.nowMs) };

  const [requests, periodic, r2, turn, ae] = await Promise.allSettled([
    graphql(creds, Q_REQUESTS, vars, fetchImpl),
    graphql(creds, Q_DO_PERIODIC, { startDate: vars.startDate, endDate: vars.endDate }, fetchImpl),
    graphql(creds, Q_R2, { start: vars.start, end: vars.end, storageStart: iso(input.nowMs - DAY_MS) }, fetchImpl),
    graphql(creds, Q_TURN, { start: vars.start, end: vars.end }, fetchImpl),
    cfPost(creds, analyticsEngineSqlUrl(creds.accountId), aeUsageSql((input.nowMs - aeFromMs) / DAY_MS + 1), 'text/plain', fetchImpl)
  ]);

  out.failures = {};
  // Each dataset parses into locals and is assigned whole, or fails whole: never half a dataset.
  const settle = (id: StreamDatasetId, r: PromiseSettledResult<any>, apply: (value: any) => void) => {
    try {
      if (r.status === 'rejected') throw r.reason;
      apply(r.value);
    } catch (err) {
      // Token AND account id out: the daily watch posts these to an issue on a public repo.
      const message = scrub(scrub((err as Error)?.message || 'request failed', creds.token), creds.accountId);
      out.failures![id] = message;
      out.errors.push(`${STREAM_DATASET_LABEL[id]}: ${message}`);
    }
  };

  settle('requests', requests, (v) => {
    const workersMtd = rowsOf(v, 'workersInvocationsAdaptive').map((r) => ({ script: String(r?.dimensions?.scriptName || ''), requests: num(r?.sum?.requests) }));
    const doRequests = rowsOf(v, 'durableObjectsInvocationsAdaptiveGroups').map((r) => ({
      date: String(r?.dimensions?.date || ''),
      namespaceId: String(r?.dimensions?.namespaceId || '').toLowerCase(),
      requests: num(r?.sum?.requests)
    }));
    Object.assign(out, { workersMtd, doRequests });
  });

  settle('periodic', periodic, (v) => {
    out.doPeriodic = rowsOf(v, 'durableObjectsPeriodicGroups').map((r) => ({
      date: String(r?.dimensions?.date || ''),
      namespaceId: String(r?.dimensions?.namespaceId || '').toLowerCase(),
      activeTimeUs: num(r?.sum?.activeTime),
      rowsWritten: num(r?.sum?.rowsWritten)
    }));
  });

  settle('r2', r2, (v) => {
    const r2Ops = rowsOf(v, 'r2OperationsAdaptiveGroups').map((r) => ({
      bucket: String(r?.dimensions?.bucketName || ''),
      actionType: String(r?.dimensions?.actionType || ''),
      requests: num(r?.sum?.requests)
    }));
    const latest = new Map<string, { at: number; bytes: number }>();
    for (const r of rowsOf(v, 'r2StorageAdaptiveGroups')) {
      const bucket = String(r?.dimensions?.bucketName || '');
      const at = Date.parse(String(r?.dimensions?.datetime || '')) || 0;
      if (bucket && (latest.get(bucket)?.at ?? -1) < at) latest.set(bucket, { at, bytes: num(r?.max?.payloadSize) });
    }
    Object.assign(out, { r2Ops, r2Storage: [...latest].map(([bucket, x]) => ({ bucket, payloadBytes: x.bytes })) });
  });

  settle('turn', turn, (v) => {
    out.turnEgressBytes = rowsOf(v, 'callsTurnUsageAdaptiveGroups').reduce((s: number, r) => s + num(r?.sum?.egressBytes), 0);
  });

  settle('ae', ae, (v) => {
    if (!Array.isArray((v as { data?: unknown })?.data)) throw new Error('unexpected answer (no data rows)');
    Object.assign(out, { ae: parseAeRows(v), aeActive: parseAeActive(v) });
  });

  return out;
}

// ─── Build (pure) ────────────────────────────────────────────────────────────────────────

export interface StreamBuildInput {
  nowMs: number;
  /** The Cost centre range: [fromMs, toMs), and the equal period before it. */
  range: { fromMs: number; toMs: number; prevFromMs: number; days: number };
  analytics: StreamAnalytics | null;
  /** The Workers card's data (R2 storage now). */
  cloudflare?: CloudflareSection;
  /** Emails sent this month by every DreamStream app (email_log). */
  emailsMonthToDate?: number | null;
  /** Admin-console-only name lookups: nursery id → name + owner email; account id → email. */
  nurseryNames?: Map<string, { name: string; owner: string | null }>;
  emails?: Map<string, string | null>;
  /** namespaceId → class (STREAM_DO_NAMESPACES). */
  namespaceLabels?: Record<string, string>;
  /** ADR 0006 Phase 0 shipped (the rows-per-nursery-day budget applies). */
  phase0Shipped?: boolean;
}

const round = (n: number, dp = 4): number => {
  const r = Number((Number.isFinite(n) ? n : 0).toFixed(dp));
  return r === 0 ? 0 : r;
};

type ByKind = Partial<Record<UsageKind, UsageCounters>>;
const addTo = (m: ByKind, kind: UsageKind, c: UsageCounters) => (m[kind] = addUsage(m[kind] ?? emptyCounters(), c));
const sumMinutes = (c: UsageCounters) => STREAM_PATHS.reduce((s, p) => s + c.minutes[p], 0);

/** Top consumers of one scope in the rows (by list value, then minutes). Exported for name lookups. */
export function topConsumers(rows: AeUsageRow[], scope: UsageScope, limit = 10): { id: string; account: string; byKind: ByKind }[] {
  const by = new Map<string, { id: string; account: string; byKind: ByKind }>();
  for (const r of rows) {
    if (r.scope !== scope || !r.scopeId) continue;
    const cur = by.get(r.scopeId) ?? { id: r.scopeId, account: r.account, byKind: {} };
    addTo(cur.byKind, r.kind, r.counters);
    if (!cur.account && r.account) cur.account = r.account;
    by.set(r.scopeId, cur);
  }
  return [...by.values()]
    .map((x) => ({ x, usd: listValueOfMonth(x.byKind).usd, minutes: USAGE_KINDS.reduce((s, k) => s + (x.byKind[k] ? sumMinutes(x.byKind[k]!) : 0), 0) }))
    .sort((a, b) => b.usd - a.usd || b.minutes - a.minutes || a.x.id.localeCompare(b.x.id))
    .slice(0, limit)
    .map((y) => y.x);
}

/** The rows of the selected range (current) — the slice the top-consumer lookups need. */
export const rowsInRange = (rows: AeUsageRow[] | undefined, fromMs: number, toMs: number) =>
  (rows ?? []).filter((r) => r.day >= dayKey(fromMs) && r.day <= dayKey(Math.max(fromMs, toMs - 1)));

const shortId = (id: string) => (id.length > 10 ? `${id.slice(0, 8)}…` : id);

export function buildStreamSection(input: StreamBuildInput): StreamCostSection {
  const a = input.analytics;
  const nowMs = input.nowMs;
  const { startMs: monthStartMs, daysInMonth } = monthBounds(nowMs);
  const daysElapsed = Math.max(1 / 24, (nowMs - monthStartMs) / DAY_MS);
  const labels = input.namespaceLabels ?? {};
  const labelled = Object.keys(labels).length > 0;
  const notes: string[] = [];
  const errors = [...(a?.errors ?? [])];
  const ae = a?.ae;
  const aeOk = !!ae;
  const gqlOk = !!a?.configured && (a.doRequests !== undefined || a.doPeriodic !== undefined || a.r2Ops !== undefined || a.turnEgressBytes !== undefined);

  // ---- in-room counters (Analytics Engine): range, previous range, month, last 7 days ------
  const cur = rowsInRange(ae, input.range.fromMs, input.range.toMs);
  const prev = (ae ?? []).filter((r) => r.day >= dayKey(input.range.prevFromMs) && r.day < dayKey(input.range.fromMs));
  const curByKind: ByKind = {};
  for (const r of cur) addTo(curByKind, r.kind, r.counters);
  const prevByKind: ByKind = {};
  for (const r of prev) addTo(prevByKind, r.kind, r.counters);
  const listValue = listValueOfMonth(curByKind).usd;
  const prevCovered = !!a && a.aeFromMs <= input.range.prevFromMs;
  const prevListValue = aeOk && prevCovered ? listValueOfMonth(prevByKind).usd : null;

  // ---- active nursery-days: the rooms' once-a-day marks (a camera connected that UTC day) ----------
  // The usage rows alone can't be the denominator: a nursery that never used the server relay owes
  // nothing and writes no row, so dividing by them divides every nursery's cost by the few on the
  // relay. Only days that carry marks count, on both sides of every per-nursery figure; with no marks
  // those figures are unknown (null) and the alerts built on them stay off.
  const activeByDay = new Map<string, Set<string>>();
  const addActive = (day: string, id: string) => (activeByDay.get(day) ?? activeByDay.set(day, new Set()).get(day)!).add(id);
  for (const m of a?.aeActive ?? []) if (m.scope === 'nursery') addActive(m.day, m.scopeId);
  const markedDays = new Set(activeByDay.keys());
  for (const r of ae ?? []) if (r.scope === 'nursery' && r.scopeId && markedDays.has(r.day)) addActive(r.day, r.scopeId); // a relay user was active too
  const nurseryDaysWhere = (pick: (day: string) => boolean) => [...activeByDay].reduce((s, [day, ids]) => s + (pick(day) ? ids.size : 0), 0);
  const rangeFrom = dayKey(input.range.fromMs);
  const rangeTo = dayKey(Math.max(input.range.fromMs, input.range.toMs - 1));
  const inRange = (day: string) => day >= rangeFrom && day <= rangeTo;

  const activeNurseries = new Set([
    ...cur.filter((r) => r.scope === 'nursery').map((r) => r.scopeId),
    ...(a?.aeActive ?? []).filter((m) => m.scope === 'nursery' && inRange(m.day)).map((m) => m.scopeId)
  ]).size;
  const events = new Set(cur.filter((r) => r.scope === 'event').map((r) => r.scopeId)).size;

  const monitor = curByKind.monitor ?? emptyCounters();
  const broadcast = curByKind.broadcast ?? emptyCounters();
  let monitorMarked = emptyCounters();
  for (const r of cur) if (r.kind === 'monitor' && markedDays.has(r.day)) monitorMarked = addUsage(monitorMarked, r.counters);
  const rangeNurseryDays = nurseryDaysWhere(inRange);
  const perNurseryMonthUsd = rangeNurseryDays > 0 ? round(listValueUsd(monitorMarked, 'monitor').usd / (rangeNurseryDays / 30), 6) : null;
  const broadcastHours = (broadcast.segCount * 6) / 3600;
  const perBroadcastHourUsd = broadcastHours > 0 ? round(listValueUsd(broadcast, 'broadcast').usd / broadcastHours, 6) : null;

  // Monitor viewer minutes on Home Wi-Fi / Direct / TURN only arrive with the apps' path reports
  // (Phase B `{t:'use'}`); the room measures only its own our-server minutes. Until some reports
  // arrive there is no denominator, so no share is computed — not a false 100%.
  const offServer = (c: UsageCounters) => c.minutes.lan + c.minutes.direct + c.minutes.turn;
  const monitorPathsReported = offServer(monitor) > 0;

  const pathKinds: UsageKind[] = ['monitor', 'call', 'meeting'];
  let pathTotal = emptyCounters();
  for (const k of pathKinds) {
    if (!curByKind[k] || (k === 'monitor' && !monitorPathsReported)) continue;
    pathTotal = addUsage(pathTotal, { minutes: curByKind[k]!.minutes });
  }
  const freeShare = freePathShare(pathTotal);
  const pathMix = pathKinds.map((k) => ({ kind: k, label: USAGE_KIND_LABEL[k], minutes: { ...(curByKind[k]?.minutes ?? emptyCounters().minutes) } as Record<StreamPathKey, number> }));

  const sevenDays = (ae ?? []).filter((r) => r.kind === 'monitor' && r.day >= dayKey(nowMs - 7 * DAY_MS));
  let monitor7 = emptyCounters();
  for (const r of sevenDays) monitor7 = addUsage(monitor7, { minutes: r.counters.minutes });
  const minutes7 = sumMinutes(monitor7);
  const serverShare7d = minutes7 > 0 && offServer(monitor7) > 0 ? monitor7.minutes.server / minutes7 : null;
  const monitorMinutes = sumMinutes(monitor);
  const serverShare = monitorMinutes > 0 && monitorPathsReported ? monitor.minutes.server / monitorMinutes : null;

  // ---- features --------------------------------------------------------------------------
  const FEATURE_NOTES: Partial<Record<UsageKind, string>> = {
    monitor: 'Server relay frames (20 incoming messages = 1 billed request) and relay minutes; P2P media is free. Room bookkeeping shows in the KPIs below.',
    call: 'Minutes per path from each call’s connection report, charged to the caller. TURN GB from minutes until apps report bytes (Phase B).',
    meeting: 'Meeting guests connect peer-to-peer; per-path minutes arrive with the app’s usage reports (Phase B).',
    broadcast: 'Segments stored (24 h replay), uploads, viewer segment fetches through the Worker. R2 egress is $0.',
    cloud_copy: '7-day copies at the size R2 stored; storage for a week + multipart writes.',
    drive_save: 'Browser → Google Drive: no bytes through us. Not metered yet.'
  };
  const features: StreamFeatureRow[] = USAGE_KINDS.map((kind) => {
    const c = curByKind[kind] ?? emptyCounters();
    const v = listValueUsd(c, kind);
    const units = v.lines.map((l) => ({ label: l.label, value: round(l.units, 4), unit: l.unit }));
    const minutes = sumMinutes(c);
    if (minutes > 0) units.unshift({ label: 'Minutes (all paths)', value: round(minutes, 1), unit: 'min' });
    return { id: kind, label: USAGE_KIND_LABEL[kind], units, listValueUsd: v.usd, source: 'estimated' as CostSource, note: FEATURE_NOTES[kind] };
  });
  features.push({ id: 'push', label: 'Push alerts', units: [], listValueUsd: 0, source: 'fixed', note: 'Web Push is a Worker subrequest — not billed. Alerts and sound are never limited to save money.' });

  // ---- top consumers (admin console only; guests are counted inside their nursery/event) ----
  const consumer = (scope: UsageScope, x: { id: string; account: string; byKind: ByKind }): StreamConsumerRow => {
    let server = 0;
    let turnBytes = 0;
    let minutes = 0;
    for (const k of USAGE_KINDS) {
      const c = x.byKind[k];
      if (!c) continue;
      server += c.minutes.server;
      turnBytes += turnBytesOf(c, k).bytes;
      minutes += sumMinutes(c);
    }
    const nursery = scope === 'nursery' ? input.nurseryNames?.get(x.id) : undefined;
    const email = scope === 'account' ? input.emails?.get(x.id) : scope === 'event' && x.account ? input.emails?.get(x.account) : nursery?.owner;
    const label = scope === 'nursery' ? nursery?.name || `Nursery ${shortId(x.id)}` : scope === 'account' ? email || `Account ${shortId(x.id)}` : `Event ${x.id}`;
    return {
      scope,
      id: x.id,
      label,
      owner: scope === 'account' ? null : email ?? null,
      listValueUsd: listValueOfMonth(x.byKind).usd,
      serverMinutes: round(server, 1),
      turnGb: round(turnBytes / GB, 3),
      minutes: round(minutes, 1)
    };
  };
  const top = {
    nurseries: topConsumers(cur, 'nursery').map((x) => consumer('nursery', x)),
    accounts: topConsumers(cur, 'account').map((x) => consumer('account', x)),
    events: topConsumers(cur, 'event').map((x) => consumer('event', x))
  };

  // ---- measured month to date (GraphQL, account-wide) → headroom, overage, KPIs ------------
  const totals: Partial<Record<MeterId, number>> = {};
  const shares: Partial<Record<MeterId, number>> = {};
  const isStreamNs = (id: string) => !labelled || (STREAM_DO_CLASSES as readonly string[]).includes(labels[id] ?? '');
  const monitorNs = Object.entries(labels).find(([, cls]) => cls === 'MonitorRoom')?.[0] ?? null;
  const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

  if (a?.doRequests) {
    const total = a.doRequests.reduce((s, r) => s + r.requests, 0);
    totals.doRequests = total;
    shares.doRequests = share(a.doRequests.filter((r) => isStreamNs(r.namespaceId)).reduce((s, r) => s + r.requests, 0), total);
  }
  if (a?.doPeriodic) {
    const gbs = a.doPeriodic.reduce((s, r) => s + (r.activeTimeUs / 1e6) * DO_GB, 0);
    const rows = a.doPeriodic.reduce((s, r) => s + r.rowsWritten, 0);
    totals.doGbSeconds = gbs;
    totals.doRowsWritten = rows;
    const streamRows = a.doPeriodic.filter((r) => isStreamNs(r.namespaceId));
    shares.doGbSeconds = share(streamRows.reduce((s, r) => s + (r.activeTimeUs / 1e6) * DO_GB, 0), gbs);
    shares.doRowsWritten = share(streamRows.reduce((s, r) => s + r.rowsWritten, 0), rows);
  }
  if (a?.r2Ops) {
    let classA = 0;
    let classB = 0;
    let liveA = 0;
    let liveB = 0;
    for (const r of a.r2Ops) {
      const cls = r2OperationClass(r.actionType);
      if (cls === 'A') {
        classA += r.requests;
        if (r.bucket === LIVE_BUCKET) liveA += r.requests;
      } else if (cls === 'B') {
        classB += r.requests;
        if (r.bucket === LIVE_BUCKET) liveB += r.requests;
      }
    }
    totals.r2ClassA = classA;
    totals.r2ClassB = classB;
    shares.r2ClassA = share(liveA, classA);
    shares.r2ClassB = share(liveB, classB);
  }
  const r2Buckets = a?.r2Storage?.length ? a.r2Storage : input.cloudflare?.r2;
  if (r2Buckets && r2Buckets.length) {
    const all = r2Buckets.reduce((s, b) => s + b.payloadBytes, 0);
    totals.r2StoredGb = all / GB;
    shares.r2StoredGb = share(r2Buckets.filter((b) => b.bucket === LIVE_BUCKET).reduce((s, b) => s + b.payloadBytes, 0), all);
  }
  if (a?.turnEgressBytes !== undefined) {
    totals.turnGb = a.turnEgressBytes / GB;
    shares.turnGb = 1; // only the live Worker mints TURN credentials
  }
  if (a?.workersMtd) {
    const all = a.workersMtd.reduce((s, w) => s + w.requests, 0);
    totals.workerRequests = all;
    shares.workerRequests = share(a.workersMtd.filter((w) => w.script === LIVE_SCRIPT).reduce((s, w) => s + w.requests, 0), all);
  }
  const allocation = allocateOverage(totals, {}, shares);

  // Projections count at least PROJECTION_MIN_DAYS of the month as elapsed: one night on the 1st is not the month's trend.
  const projOpts = { minDays: PROJECTION_MIN_DAYS };
  const headroom: StreamHeadroomRow[] = allocation.meters.map((m) => {
    const level = m.id === 'r2StoredGb'; // storage is a level, not a running total
    const p = projectMonthEnd(m.used, nowMs, m.allowance, projOpts);
    const projected = level ? m.used : p.projected;
    return {
      id: m.id,
      label: m.label,
      unit: m.unit,
      used: round(m.used, 4),
      allowance: m.allowance,
      projected: round(projected, 4),
      projectedPct: m.allowance > 0 ? round((projected / m.allowance) * 100, 1) : 0,
      crossesOn: level ? (m.used >= m.allowance ? dayKey(nowMs) : null) : p.crossesOn,
      overageUsd: m.overageUsd,
      source: 'measured',
      note: `Account-wide: shared with every Worker on the Cloudflare account. Stream Studio ≈ ${Math.round(m.share * 100)}%.`
    };
  });
  if (input.emailsMonthToDate != null) {
    const p = projectMonthEnd(input.emailsMonthToDate, nowMs, STREAM_ALLOWANCES.emails, projOpts);
    headroom.push({
      id: 'emails',
      label: 'Emails',
      unit: 'emails',
      used: input.emailsMonthToDate,
      allowance: STREAM_ALLOWANCES.emails,
      projected: p.projected,
      projectedPct: p.pctOfLimit ?? 0,
      crossesOn: p.crossesOn,
      overageUsd: round((Math.max(0, input.emailsMonthToDate - STREAM_ALLOWANCES.emails) / 1000) * STREAM_UNIT_PRICES.emailPer1k, 6),
      source: 'measured',
      note: 'Shared by every DreamStream app (auth emails sent by the Supabase hook are not in email_log).'
    });
  }

  // ---- ADR 0006 per-active-nursery-day KPIs (month to date, over the days that carry marks) ---
  const mtdMarked = new Set([...markedDays].filter((d) => d >= dayKey(monthStartMs)));
  const mtdNurseryDays = nurseryDaysWhere((d) => mtdMarked.has(d));
  const pickNs = (id: string) => (monitorNs ? id === monitorNs : true);
  const onMarked = <T extends { date: string; namespaceId: string }>(rows: T[]) => rows.filter((r) => mtdMarked.has(r.date) && pickNs(r.namespaceId));
  const perND = (v: number) => (mtdNurseryDays > 0 ? round(v / mtdNurseryDays, 1) : null);
  const kpiRequests = a?.doRequests ? perND(onMarked(a.doRequests).reduce((s, r) => s + r.requests, 0)) : null;
  const kpiRows = a?.doPeriodic ? perND(onMarked(a.doPeriodic).reduce((s, r) => s + r.rowsWritten, 0)) : null;
  const kpiGbs = a?.doPeriodic ? perND(onMarked(a.doPeriodic).reduce((s, r) => s + (r.activeTimeUs / 1e6) * DO_GB, 0)) : null;
  const gbSecSeries: number[] = [];
  if (monitorNs && a?.doPeriodic) {
    for (const day of [...mtdMarked].sort()) {
      if (day >= dayKey(nowMs)) continue; // today is partial
      const n = activeByDay.get(day)?.size ?? 0;
      const gbs = a.doPeriodic.filter((r) => r.date === day && r.namespaceId === monitorNs).reduce((s, r) => s + (r.activeTimeUs / 1e6) * DO_GB, 0);
      if (n > 0) gbSecSeries.push(gbs / n);
    }
  }

  // ---- projection at scale (list price, today's per-nursery cost) --------------------------
  const bookkeeping =
    kpiRequests != null || kpiRows != null || kpiGbs != null
      ? ((kpiRequests ?? 0) * STREAM_METERS.doRequests.usdPerUnit + (kpiRows ?? 0) * STREAM_METERS.doRowsWritten.usdPerUnit + (kpiGbs ?? 0) * STREAM_METERS.doGbSeconds.usdPerUnit) * 30
      : 0;
  const perNurseryMonthAll = perNurseryMonthUsd != null ? perNurseryMonthUsd + (monitorNs ? bookkeeping : 0) : null;

  // ---- alerts -----------------------------------------------------------------------------
  const r2StoredGb = totals.r2StoredGb ?? null;
  const alerts = evaluateStreamAlerts({
    nowMs,
    headroom: headroom.map((h) => ({ id: h.id, label: h.label, used: h.used, allowance: h.allowance, projected: h.projected })),
    turnGbMonthToDate: totals.turnGb ?? null,
    gbSecPerNurseryDay: gbSecSeries.length ? gbSecSeries : null,
    rowsPerNurseryDay: monitorNs ? kpiRows : null,
    phase0Shipped: input.phase0Shipped,
    serverShare7d,
    r2StoredGb,
    emailsMonthToDate: input.emailsMonthToDate ?? null,
    containerAwakeHours: null
  }).filter((x) => !(x.id === 'r2_near_free' && headroom.some((h) => h.id === 'r2StoredGb' && h.projectedPct >= 80))); // one R2 alert, not two

  // ---- notes: every assumption, in plain words --------------------------------------------
  notes.push(`Estimates use list prices checked ${STREAM_UNIT_PRICES.checkedOn} (shared/stream/usage.ts). Nothing here is charged to users: Stream Studio meters but does not bill.`);
  notes.push('Free allowances are account-wide — the backend container, every dreamstream-* Worker and the non-DreamStream Workers on the same Cloudflare account (atlasd, the personal website) share them.');
  if (!a?.configured) {
    notes.push('Cloudflare analytics is not connected: set CF_ANALYTICS_API_TOKEN (read-only, Account Analytics Read) and CLOUDFLARE_ACCOUNT_ID on the backend for measured totals, headroom and the in-room counters.');
  } else {
    if (!labelled) notes.push('Durable Object figures are account-wide: set STREAM_DO_NAMESPACES (MonitorRoom=<id>,EventRoom=<id>,UserLine=<id>,CallRoom=<id>) on the backend to split them by room and get exact per-nursery KPIs.');
    if (aeOk && !ae!.length && !a?.aeActive?.length) notes.push(`No in-room usage points yet — the ${LIVE_SCRIPT} Worker writes them (at most hourly per room) once deployed with the STREAM_USAGE binding.`);
    if (aeOk && markedDays.size === 0) {
      notes.push(
        `Per-nursery figures (cost per nursery-month, the ADR 0006 KPIs, the hibernation and write-diet alerts, the scale projection) need the rooms' daily activity marks, which the ${LIVE_SCRIPT} Worker writes once a day per nursery with a camera on. None yet, so they show — and those alerts are off, rather than divide every nursery's cost by the few that used the server relay.`
      );
    }
    if (aeOk && monitor.minutes.server > 0 && !monitorPathsReported) {
      notes.push(
        'Baby-monitor viewers don’t report their Home Wi-Fi / Direct / relay minutes yet (Phase B), so only our-server minutes are known: the our-server share and the relay-creep alert are off, and “Minutes on free paths” counts calls and meetings only.'
      );
    }
    if (ae && ae.length >= AE_ROW_LIMIT) notes.push(`Analytics Engine returned the ${AE_ROW_LIMIT.toLocaleString('en-US')}-row cap — the oldest days of the range are partial.`);
    if (!prevCovered) notes.push('The previous period is older than Analytics Engine keeps (about 90 days) — no list-value delta.');
  }
  notes.push('In-room counters are written at most once an hour per room, so the latest hour can lag; Cloudflare’s own figures are the control total. Estimates are not billing-grade.');
  notes.push('TURN is the account total. Per-socket figures need per-socket credentials with a custom identifier (TURN guardrails, P2); until then call TURN GB is estimated from minutes on the relay path.');
  notes.push(`Marginal cost is month to date: Stream Studio's share of what the account owes past each free allowance — $0 while the account stays inside them, whatever the list value.`);
  notes.push(`Month-end projections are straight-line, counting at least ${PROJECTION_MIN_DAYS} days of the month as elapsed, so one night early in the month isn't read as the month's trend. The TURN-leak alert uses actual GB, not a projection.`);
  if (!input.phase0Shipped) notes.push('The ADR 0006 per-nursery-day budgets (≤ 1,000 requests, ≤ 1,800 rows, ≤ 40 GB-s) apply after Phase 0 ships; until then the KPIs are the baseline.');

  const kpiSource: CostSource = monitorNs ? 'measured' : 'estimated';
  return {
    sources: { graphql: gqlOk, analyticsEngine: aeOk },
    configured: !!a?.configured,
    month: { from: iso(monthStartMs), to: iso(nowMs), daysElapsed: round(daysElapsed, 2), daysInMonth },
    marginalUsd: allocation.productUsd,
    listValueUsd: listValue,
    prevListValueUsd: prevListValue,
    perNurseryMonthUsd,
    perBroadcastHourUsd,
    freePathShare: freeShare == null ? null : round(freeShare, 4),
    activeNurseries,
    events,
    features,
    pathMix,
    top,
    headroom,
    projection: {
      perNurseryMonthUsd: perNurseryMonthAll == null ? null : round(perNurseryMonthAll, 6),
      at1k: perNurseryMonthAll == null ? null : round(perNurseryMonthAll * 1000, 2),
      at10k: perNurseryMonthAll == null ? null : round(perNurseryMonthAll * 10_000, 2),
      source: 'estimated'
    },
    kpis: {
      activeNurseryDays: mtdNurseryDays,
      doRequests: kpiRequests,
      rowsWritten: kpiRows,
      gbSeconds: kpiGbs,
      serverShare: serverShare == null ? null : round(serverShare, 4),
      source: kpiSource,
      note:
        (monitorNs
          ? 'MonitorRoom namespace, month to date, ÷ active nursery-days'
          : 'Upper bound: every Durable Object on the account ÷ active nursery-days (set STREAM_DO_NAMESPACES for the MonitorRoom figure)') +
        ` — a nursery with a camera on that day, from the rooms' daily activity marks; only days with marks count (${mtdMarked.size} this month).`
    },
    alerts,
    pricesCheckedOn: STREAM_UNIT_PRICES.checkedOn,
    notes,
    errors
  };
}

/** The product row's one-line verdict. */
export function streamVerdict(s: StreamCostSection, formatUsd: (n: number) => string): string {
  if (!s.sources.graphql && !s.sources.analyticsEngine) {
    return s.configured
      ? 'Not measured — Cloudflare analytics is set up but no dataset answered (the Stream Studio tab says why).'
      : 'Not measured yet — connect Cloudflare analytics (Stream Studio tab) for real figures.';
  }
  const marginal = `${formatUsd(s.marginalUsd)} marginal${s.marginalUsd === 0 ? ' (inside free tiers)' : ' (past a free tier)'}`;
  return `${marginal} · ${formatUsd(s.listValueUsd)} at list price, est. · ${s.activeNurseries} ${s.activeNurseries === 1 ? 'nursery' : 'nurseries'}, ${s.events} ${s.events === 1 ? 'event' : 'events'}`;
}

/** For the Cost centre loader: ids worth a name lookup (top nurseries in the range). */
export function topNurseryIds(analytics: StreamAnalytics | null, fromMs: number, toMs: number): string[] {
  return topConsumers(rowsInRange(analytics?.ae, fromMs, toMs), 'nursery').map((x) => x.id).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
}
