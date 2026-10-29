// Stream Studio usage and cost model — ONE place for the shapes, the list prices and the maths.
//
// Pure and dependency-free: the live Worker's Durable Objects (live-worker/src/usageMeter.ts),
// the backend's Admin → Costs (server/src/services/streamCosts.ts), the daily GitHub cost watch
// (scripts/ops/streamCostWatch.mjs) and, in Phase B, the app's Usage card all import it.
// Design: docs/features/stream-studio-costs.md §2–§4 · decision: ADR 0007.
//
// Honesty rules baked in here:
//   - Every $ derived from these counters is an ESTIMATE at list price (`estimated: true`); the
//     measured control total is Cloudflare's own GraphQL analytics.
//   - Prices carry the date they were checked (STREAM_UNIT_PRICES.checkedOn).
//   - Counters are aggregates only — minutes, bytes, counts. Never a name, IP, SDP or guest id.
//   - Nothing here is a charge: Stream Studio does not bill users (ADR 0007 D1).

// ─── Paths and kinds ─────────────────────────────────────────────────────────────────────

/** How media travelled. Home Wi-Fi · Direct · through our relay (TURN) · through our server (DO relay). */
export const STREAM_PATHS = ['lan', 'direct', 'turn', 'server'] as const;
export type StreamPath = (typeof STREAM_PATHS)[number];

/** The three user words (feature doc §4.3); `turn` and `server` are never called free. */
export const PATH_LABEL: Readonly<Record<StreamPath, string>> = {
  lan: 'Home Wi-Fi',
  direct: 'Direct',
  turn: 'Through our relay',
  server: 'Through our server'
};

/** Paths that cost DreamStream nothing for the media itself. */
export const FREE_PATHS: ReadonlySet<StreamPath> = new Set<StreamPath>(['lan', 'direct']);

export const USAGE_KINDS = ['monitor', 'call', 'meeting', 'broadcast', 'cloud_copy', 'drive_save'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export const USAGE_KIND_LABEL: Readonly<Record<UsageKind, string>> = {
  monitor: 'Baby monitor',
  call: 'Family & direct calls',
  meeting: 'Meetings',
  broadcast: 'Broadcasts',
  cloud_copy: 'Cloud copies (7-day)',
  drive_save: 'Drive saves'
};

/**
 * Who a month of usage belongs to. Monitor relay counts against the NURSERY (parents decide who
 * watches); calls count against the CALLER's account; broadcasts and cloud copies against the EVENT
 * (and its owner's account). Owner decision, 2026-10-22.
 */
export type UsageScope = 'nursery' | 'account' | 'event';

/**
 * Analytics Engine index of a room's once-a-day "active" mark (a nursery with a camera connected that
 * UTC day). Not a usage kind and carries no counters: it is the denominator of the per-active-nursery-day
 * KPIs, which can't come from the usage points because a nursery that never uses the server relay owes
 * nothing and writes none.
 */
export const ACTIVE_MARK = 'active';

export const isUsageKind = (v: unknown): v is UsageKind => typeof v === 'string' && (USAGE_KINDS as readonly string[]).includes(v);
export const isStreamPath = (v: unknown): v is StreamPath => typeof v === 'string' && (STREAM_PATHS as readonly string[]).includes(v);

// ─── Counters ────────────────────────────────────────────────────────────────────────────

export interface UsageCounters {
  /** Participant / viewer minutes by path. */
  minutes: Record<StreamPath, number>;
  /** Edge → client TURN bytes (what Cloudflare bills). Client-reported (Phase B) or 0 = unknown. */
  turnBytes: number;
  /** Monitor server relay: incoming camera frames (each is a billed WebSocket message, 20:1). */
  relayFrames: number;
  /** Broadcast: bytes and count of segments stored in R2. */
  segBytes: number;
  segCount: number;
  /** Broadcast: viewer-minutes from the room's own viewer curve. */
  viewerMinutes: number;
  /** Recordings: kept 7 days in R2 / saved to the user's Drive / saved on the device. */
  cloudCopyBytes: number;
  driveBytes: number;
  deviceBytes: number;
  /** Requests and rows the room knows it caused (estimates; GraphQL is the control total). */
  doRequestsEst: number;
  rowsWrittenEst: number;
  /** Worker requests the room knows it caused (segment uploads). Viewer GETs are derived. */
  workerRequestsEst: number;
}

/** Scalar counters, in the fixed order they are written to Analytics Engine (append only — never reorder). */
export const SCALAR_FIELDS = [
  'turnBytes',
  'relayFrames',
  'segBytes',
  'segCount',
  'viewerMinutes',
  'cloudCopyBytes',
  'driveBytes',
  'deviceBytes',
  'doRequestsEst',
  'rowsWrittenEst',
  'workerRequestsEst'
] as const;
export type ScalarField = (typeof SCALAR_FIELDS)[number];

/**
 * The Analytics Engine `doubles` layout: minutes by path, then the scalars. 15 of the 20 allowed.
 * double1 = minutes.lan … double4 = minutes.server, double5 = turnBytes … double15 = workerRequestsEst.
 */
export const USAGE_DOUBLES: readonly string[] = [...STREAM_PATHS.map((p) => `minutes.${p}`), ...SCALAR_FIELDS];

/** A partial change to counters (what hot paths add). */
export type UsageDelta = { minutes?: Partial<Record<StreamPath, number>> } & Partial<Record<ScalarField, number>>;

/** One month of usage for one nursery, account or event (the `use:YYYY-MM` row). */
export interface UsageMonth {
  /** 'YYYY-MM' (UTC). */
  month: string;
  scope: UsageScope;
  counters: Partial<Record<UsageKind, UsageCounters>>;
  /** When the row was last written (ms). */
  updatedAt: number;
}

export const emptyCounters = (): UsageCounters => ({
  minutes: { lan: 0, direct: 0, turn: 0, server: 0 },
  turnBytes: 0,
  relayFrames: 0,
  segBytes: 0,
  segCount: 0,
  viewerMinutes: 0,
  cloudCopyBytes: 0,
  driveBytes: 0,
  deviceBytes: 0,
  doRequestsEst: 0,
  rowsWrittenEst: 0,
  workerRequestsEst: 0
});

const finite = (n: unknown): number => {
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? v : 0;
};

/** a + sign·d, per field, never below 0, ignoring junk. Returns a new object. */
export function addUsage(a: UsageCounters, d: UsageDelta | UsageCounters | null | undefined, sign: 1 | -1 = 1): UsageCounters {
  const out = cloneCounters(a);
  if (!d) return out;
  const m = (d as UsageDelta).minutes;
  if (m) for (const p of STREAM_PATHS) out.minutes[p] = Math.max(0, out.minutes[p] + sign * finite(m[p]));
  for (const f of SCALAR_FIELDS) {
    const v = (d as UsageDelta)[f];
    if (v != null) out[f] = Math.max(0, out[f] + sign * finite(v));
  }
  return out;
}

/** a − b, clamped at 0 per field (what is still owed when b was already written). */
export const subUsage = (a: UsageCounters, b: UsageCounters | UsageDelta | null | undefined): UsageCounters => addUsage(a, b, -1);

/** Per-field maximum (cumulative reports only ever move forward — a resend never double counts). */
export function maxUsage(a: UsageCounters, b: UsageCounters): UsageCounters {
  const out = cloneCounters(a);
  for (const p of STREAM_PATHS) out.minutes[p] = Math.max(out.minutes[p], finite(b.minutes[p]));
  for (const f of SCALAR_FIELDS) out[f] = Math.max(out[f], finite(b[f]));
  return out;
}

export function cloneCounters(a: UsageCounters): UsageCounters {
  return { ...a, minutes: { ...a.minutes } };
}

export function isEmptyUsage(c: UsageCounters | null | undefined): boolean {
  if (!c) return true;
  return STREAM_PATHS.every((p) => !(c.minutes[p] > 0)) && SCALAR_FIELDS.every((f) => !(c[f] > 0));
}

const round = (n: number, dp = 3): number => {
  const r = Number(n.toFixed(dp));
  return r === 0 ? 0 : r;
};

/** Only the non-zero fields (small rows, small WebSocket attachments). */
export function compactUsage(c: UsageCounters): UsageDelta {
  const out: UsageDelta = {};
  const minutes: Partial<Record<StreamPath, number>> = {};
  for (const p of STREAM_PATHS) if (c.minutes[p] > 0) minutes[p] = round(c.minutes[p]);
  if (Object.keys(minutes).length) out.minutes = minutes;
  for (const f of SCALAR_FIELDS) if (c[f] > 0) out[f] = round(c[f]);
  return out;
}

/** Anything (a stored row, a JSON body) → valid counters. Negative and non-finite values become 0. */
export function sanitizeUsage(x: unknown): UsageCounters {
  const src = (x && typeof x === 'object' ? x : {}) as UsageDelta;
  return addUsage(emptyCounters(), src);
}

/** Sanitize a stored month row (anything) into a UsageMonth, or null. */
export function sanitizeMonth(x: unknown): UsageMonth | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Partial<UsageMonth>;
  if (typeof r.month !== 'string' || !/^\d{4}-\d{2}$/.test(r.month)) return null;
  const scope: UsageScope = r.scope === 'account' || r.scope === 'event' ? r.scope : 'nursery';
  const counters: Partial<Record<UsageKind, UsageCounters>> = {};
  for (const k of USAGE_KINDS) {
    const c = (r.counters as Record<string, unknown> | undefined)?.[k];
    if (c) counters[k] = sanitizeUsage(c);
  }
  return { month: r.month, scope, counters, updatedAt: finite(r.updatedAt) };
}

export function usageToDoubles(c: UsageCounters): number[] {
  return [...STREAM_PATHS.map((p) => round(c.minutes[p], 4)), ...SCALAR_FIELDS.map((f) => round(c[f], 4))];
}

export function usageFromDoubles(d: ArrayLike<unknown>): UsageCounters {
  const c = emptyCounters();
  STREAM_PATHS.forEach((p, i) => (c.minutes[p] = Math.max(0, finite(d[i]))));
  SCALAR_FIELDS.forEach((f, i) => (c[f] = Math.max(0, finite(d[STREAM_PATHS.length + i]))));
  return c;
}

/** The path that carried the most minutes ('' when none) — a filter label for Analytics Engine. */
export function dominantPath(c: UsageCounters): StreamPath | '' {
  let best: StreamPath | '' = '';
  let max = 0;
  for (const p of STREAM_PATHS) {
    if (c.minutes[p] > max) {
      max = c.minutes[p];
      best = p;
    }
  }
  return best;
}

/** Sum counters over kinds (path mix, totals). */
export function totalUsage(byKind: Partial<Record<UsageKind, UsageCounters>>): UsageCounters {
  let out = emptyCounters();
  for (const k of USAGE_KINDS) if (byKind[k]) out = addUsage(out, byKind[k]!);
  return out;
}

/** Share (0–1) of path minutes on free paths; null when no minutes were recorded. */
export function freePathShare(c: UsageCounters): number | null {
  const total = STREAM_PATHS.reduce((s, p) => s + c.minutes[p], 0);
  if (!(total > 0)) return null;
  return (c.minutes.lan + c.minutes.direct) / total;
}

// ─── Months ──────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** 'YYYY-MM' (UTC) for an instant. */
export const monthKey = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

/** The month before 'YYYY-MM'. */
export function prevMonthKey(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return monthKey(Date.UTC(y, m - 2, 1));
}

/** The month `n` months before 'YYYY-MM'. */
export function monthsBefore(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  return monthKey(Date.UTC(y, m - 1 - n, 1));
}

/** UTC month containing `ms`: its start, end (exclusive) and length in days. */
export function monthBounds(ms: number): { startMs: number; endMs: number; daysInMonth: number } {
  const d = new Date(ms);
  const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const endMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { startMs, endMs, daysInMonth: Math.round((endMs - startMs) / DAY_MS) };
}

// ─── List prices and allowances (Workers Paid account) ───────────────────────────────────

/**
 * List prices, checked 2026-10-22 against developers.cloudflare.com (feature doc §2.1, §9).
 * The ONE price table for Stream Studio — same idea as shared/comic/models.ts.
 */
export const STREAM_UNIT_PRICES = {
  checkedOn: '2026-10-22',
  /** Realtime TURN / SFU egress (edge → client). */
  turnPerGb: 0.05,
  doReqPerM: 0.15,
  rowsPerM: 1,
  gbSecPerM: 12.5,
  doStoredGbMonth: 0.2,
  r2GbMonth: 0.015,
  r2APerM: 4.5,
  r2BPerM: 0.36,
  workerReqPerM: 0.3,
  emailPer1k: 0.35,
  /** One 15-minute backend container wake-up (basic instance), beyond the included 25 GiB-h. */
  containerWakeUsd: 0.0027
} as const;

/** What the Workers Paid plan includes each month — ACCOUNT-WIDE (shared with every Worker on the account). */
export const STREAM_ALLOWANCES = {
  checkedOn: '2026-10-22',
  doRequests: 1_000_000,
  doGbSeconds: 400_000,
  doRowsWritten: 50_000_000,
  doStoredGb: 5,
  r2StoredGb: 10,
  r2ClassA: 1_000_000,
  r2ClassB: 10_000_000,
  turnGb: 1000,
  workerRequests: 10_000_000,
  emails: 3000,
  containerGibHours: 25
} as const;

/** Metered dimensions with a free allowance and a unit price beyond it. */
export type MeterId = 'doRequests' | 'doGbSeconds' | 'doRowsWritten' | 'doStoredGb' | 'r2StoredGb' | 'r2ClassA' | 'r2ClassB' | 'turnGb' | 'workerRequests';
export const METER_IDS: readonly MeterId[] = ['doRequests', 'doGbSeconds', 'doRowsWritten', 'doStoredGb', 'r2StoredGb', 'r2ClassA', 'r2ClassB', 'turnGb', 'workerRequests'];

export interface MeterSpec {
  label: string;
  unit: string;
  allowance: number;
  /** $ per unit beyond the allowance. */
  usdPerUnit: number;
}

export const STREAM_METERS: Readonly<Record<MeterId, MeterSpec>> = {
  doRequests: { label: 'Durable Object requests', unit: 'requests', allowance: STREAM_ALLOWANCES.doRequests, usdPerUnit: STREAM_UNIT_PRICES.doReqPerM / 1e6 },
  doGbSeconds: { label: 'Durable Object duration', unit: 'GB-s', allowance: STREAM_ALLOWANCES.doGbSeconds, usdPerUnit: STREAM_UNIT_PRICES.gbSecPerM / 1e6 },
  doRowsWritten: { label: 'Durable Object rows written', unit: 'rows', allowance: STREAM_ALLOWANCES.doRowsWritten, usdPerUnit: STREAM_UNIT_PRICES.rowsPerM / 1e6 },
  // A level, not a running total (like R2 storage): the latest day's stored bytes, all Durable Objects on the account.
  doStoredGb: { label: 'Durable Object storage', unit: 'GB-month', allowance: STREAM_ALLOWANCES.doStoredGb, usdPerUnit: STREAM_UNIT_PRICES.doStoredGbMonth },
  r2StoredGb: { label: 'R2 storage', unit: 'GB-month', allowance: STREAM_ALLOWANCES.r2StoredGb, usdPerUnit: STREAM_UNIT_PRICES.r2GbMonth },
  r2ClassA: { label: 'R2 Class A operations', unit: 'operations', allowance: STREAM_ALLOWANCES.r2ClassA, usdPerUnit: STREAM_UNIT_PRICES.r2APerM / 1e6 },
  r2ClassB: { label: 'R2 Class B operations', unit: 'operations', allowance: STREAM_ALLOWANCES.r2ClassB, usdPerUnit: STREAM_UNIT_PRICES.r2BPerM / 1e6 },
  turnGb: { label: 'TURN relay egress', unit: 'GB', allowance: STREAM_ALLOWANCES.turnGb, usdPerUnit: STREAM_UNIT_PRICES.turnPerGb },
  workerRequests: { label: 'Worker requests', unit: 'requests', allowance: STREAM_ALLOWANCES.workerRequests, usdPerUnit: STREAM_UNIT_PRICES.workerReqPerM / 1e6 }
};

/**
 * Fair-use allowances users see (owner decision 2026-10-22; feature doc §4.7). Not prices: nobody is
 * charged. At 100% relay data the monitor keeps SOUND and ALERTS and falls back to direct / Home Wi-Fi
 * picture — never silently to the not-yet-end-to-end server relay.
 */
export const FAIR_USE = {
  relayDataGbPerAccountMonth: 10,
  relayDataGbPerNurseryMonth: 10,
  serverPictureHoursPerNurseryDay: 16,
  cloudCopyGbRolling: 10,
  /** Notices at these shares of an allowance. */
  noticeAt: [0.8, 1] as const
} as const;

/** Owner alert: TURN on course for this many dollars in a month (owner decision 2026-10-22). */
export const TURN_ALERT_USD_MONTH = 10;

/**
 * Estimation constants, each from the feature doc's cost model (§2.2). They turn counters into
 * list-price $ when a direct measurement isn't available. Labelled "est." wherever shown.
 */
export const STREAM_ESTIMATES = {
  /** Incoming WebSocket messages are billed as DO requests at 20:1. */
  wsMessagesPerRequest: 20,
  /** A flowing relay keeps the room active: ≈ 69 GB-s per 540k frames (10 h at 15 fps). */
  gbSecPerRelayFrame: 69 / 540_000,
  /**
   * TURN bytes per path-minute when only minutes are known (devices report measured bytes where they can):
   * monitor relay picture capped at 400 kbps + sound ≈ 0.45 Mbps (C5); 1:1 call video capped at 700 kbps on a
   * relay + sound and overhead ≈ 0.82 Mbps (C7, ≈ 0.37 GB per relayed call-hour); meeting guest receiving the
   * 700 kbps return feed + sound ≈ 0.75 Mbps (C7).
   */
  turnBytesPerMinute: {
    monitor: (0.45e6 / 8) * 60,
    call: (0.82e6 / 8) * 60,
    meeting: (0.75e6 / 8) * 60,
    broadcast: 0,
    cloud_copy: 0,
    drive_save: 0
  } as Readonly<Record<UsageKind, number>>,
  /** Broadcast viewers fetch one 6 s segment every 6 s, each through the Worker (config.ts:34). */
  segmentGetsPerViewerMinute: 10,
  /** Segments are CDN-cached: ≈ one R2 read per segment. */
  r2ReadsPerSegment: 1,
  /** Replay kept 24 h; cloud copies 7 days (eventRoom.ts:131,133). */
  segRetentionDays: 1,
  cloudCopyRetentionDays: 7,
  /** Recording parts are 16 MiB (live/api.ts:238): one Class A each, plus create + complete. */
  cloudCopyPartBytes: 16 * 1024 * 1024
} as const;

const GB = 1e9;

export interface ListValueLine {
  id: 'turn' | 'doRequests' | 'doDuration' | 'rows' | 'r2Storage' | 'r2Ops' | 'workerRequests';
  label: string;
  units: number;
  unit: string;
  usd: number;
}

export interface ListValue {
  usd: number;
  lines: ListValueLine[];
  estimated: true;
}

/** TURN bytes for these counters: measured when reported, else minutes × the kind's relay bitrate. */
export function turnBytesOf(c: UsageCounters, kind: UsageKind): { bytes: number; measured: boolean } {
  if (c.turnBytes > 0) return { bytes: c.turnBytes, measured: true };
  return { bytes: c.minutes.turn * STREAM_ESTIMATES.turnBytesPerMinute[kind], measured: false };
}

/**
 * What these counters would cost at LIST PRICE with no free tier — the planning number, never a
 * charge. `kind` decides how TURN minutes become bytes when no bytes were reported.
 */
export function listValueUsd(c: UsageCounters, kind: UsageKind): ListValue {
  const e = STREAM_ESTIMATES;
  const p = STREAM_UNIT_PRICES;
  const lines: ListValueLine[] = [];
  const push = (line: ListValueLine) => {
    if (line.units > 0) lines.push({ ...line, usd: round(line.usd, 6) });
  };

  const turn = turnBytesOf(c, kind);
  push({ id: 'turn', label: turn.measured ? 'TURN relay' : 'TURN relay (from minutes)', units: turn.bytes / GB, unit: 'GB', usd: (turn.bytes / GB) * p.turnPerGb });

  const requests = c.doRequestsEst + c.relayFrames / e.wsMessagesPerRequest;
  push({ id: 'doRequests', label: 'Durable Object requests', units: requests, unit: 'requests', usd: (requests / 1e6) * p.doReqPerM });

  const gbSec = c.relayFrames * e.gbSecPerRelayFrame;
  push({ id: 'doDuration', label: 'Durable Object duration (server relay)', units: gbSec, unit: 'GB-s', usd: (gbSec / 1e6) * p.gbSecPerM });

  push({ id: 'rows', label: 'Durable Object rows written', units: c.rowsWrittenEst, unit: 'rows', usd: (c.rowsWrittenEst / 1e6) * p.rowsPerM });

  const gbMonth = (c.segBytes / GB) * (e.segRetentionDays / 30) + (c.cloudCopyBytes / GB) * (e.cloudCopyRetentionDays / 30);
  push({ id: 'r2Storage', label: 'R2 storage', units: gbMonth, unit: 'GB-month', usd: gbMonth * p.r2GbMonth });

  const classA = c.segCount + (c.cloudCopyBytes > 0 ? Math.ceil(c.cloudCopyBytes / e.cloudCopyPartBytes) + 2 : 0);
  const classB = c.segCount * e.r2ReadsPerSegment;
  push({ id: 'r2Ops', label: 'R2 operations', units: classA + classB, unit: 'operations', usd: (classA / 1e6) * p.r2APerM + (classB / 1e6) * p.r2BPerM });

  const workerReq = c.workerRequestsEst + c.viewerMinutes * e.segmentGetsPerViewerMinute;
  push({ id: 'workerRequests', label: 'Worker requests', units: workerReq, unit: 'requests', usd: (workerReq / 1e6) * p.workerReqPerM });

  return { usd: round(lines.reduce((s, l) => s + l.usd, 0), 6), lines, estimated: true };
}

/** List value of a whole month (every kind). */
export function listValueOfMonth(byKind: Partial<Record<UsageKind, UsageCounters>>): ListValue {
  const lines = new Map<ListValueLine['id'], ListValueLine>();
  for (const k of USAGE_KINDS) {
    const c = byKind[k];
    if (!c) continue;
    for (const l of listValueUsd(c, k).lines) {
      const cur = lines.get(l.id);
      lines.set(l.id, cur ? { ...cur, units: cur.units + l.units, usd: cur.usd + l.usd, label: cur.label === l.label ? cur.label : l.label.replace(/ \(.*\)$/, '') } : { ...l });
    }
  }
  const out = [...lines.values()].map((l) => ({ ...l, usd: round(l.usd, 6) }));
  return { usd: round(out.reduce((s, l) => s + l.usd, 0), 6), lines: out, estimated: true };
}

// ─── Overage allocation (the free tier is consumed account-wide first) ──────────────────

export interface MeterAllocation {
  id: MeterId;
  label: string;
  unit: string;
  /** Account-wide use this month. */
  used: number;
  allowance: number;
  /** Units past the allowance (0 while inside the free tier). */
  overage: number;
  /** What the account pays for this meter beyond the allowance, at list price. */
  overageUsd: number;
  /** This product's share of the meter's use (0–1). */
  share: number;
  /** This product's share of the overage $ — its marginal cost. */
  productUsd: number;
}

/**
 * Split the account's OVERAGE (not its usage) between products. Allowances are account-wide: the
 * free tier is used up by everyone together first, and only what is past it costs money; each
 * product then carries its share of that overage. While the account is inside every allowance, the
 * marginal cost of every product is $0 — however much list value it used.
 */
export function allocateOverage(
  accountTotals: Partial<Record<MeterId, number>>,
  allowances: Partial<Record<MeterId, number>> = {},
  productShares: Partial<Record<MeterId, number>> = {}
): { meters: MeterAllocation[]; accountOverageUsd: number; productUsd: number } {
  const meters: MeterAllocation[] = [];
  for (const id of METER_IDS) {
    const used = accountTotals[id];
    if (used == null || !Number.isFinite(used)) continue;
    const spec = STREAM_METERS[id];
    const allowance = allowances[id] ?? spec.allowance;
    const overage = Math.max(0, used - allowance);
    const overageUsd = overage * spec.usdPerUnit;
    const share = Math.min(1, Math.max(0, finite(productShares[id])));
    meters.push({ id, label: spec.label, unit: spec.unit, used, allowance, overage, overageUsd: round(overageUsd, 6), share, productUsd: round(overageUsd * share, 6) });
  }
  return {
    meters,
    accountOverageUsd: round(meters.reduce((s, m) => s + m.overageUsd, 0), 6),
    productUsd: round(meters.reduce((s, m) => s + m.productUsd, 0), 6)
  };
}

// ─── Month-end projection ────────────────────────────────────────────────────────────────

export interface MonthProjection {
  /** Linear projection of the month-to-date value to the end of the month. */
  projected: number;
  perDay: number;
  daysElapsed: number;
  daysInMonth: number;
  /** projected ÷ limit × 100 (null without a limit). */
  pctOfLimit: number | null;
  /** UTC day ('YYYY-MM-DD') the run-rate crosses `limit` this month; null if it doesn't. */
  crossesOn: string | null;
  /** Already past the limit. */
  crossed: boolean;
}

/**
 * Stream Studio's projections (headroom, the alerts, the daily watch) treat at least this many days of
 * the month as elapsed. Usage is bunched at night: the daily watch runs at 06:17 UTC, so on the 1st a
 * straight line through ~6 hours of mostly night-time monitoring would be multiplied ×118 and raise a
 * false "on course for" alert every month. With the floor, a real spike still shows (it is large by
 * construction), and the TURN-leak rule (500 GB before the 15th) uses month-to-date actuals, not this.
 */
export const PROJECTION_MIN_DAYS = 3;

/**
 * Straight-line projection of a month-to-date counter: today's run-rate × days in the month. At
 * least one hour of the month counts as elapsed (or `minDays`, when given), so the first hours don't
 * explode the rate.
 */
export function projectMonthEnd(monthToDate: number, nowMs: number, limit?: number | null, opts: { minDays?: number } = {}): MonthProjection {
  const { startMs, endMs, daysInMonth } = monthBounds(nowMs);
  const floorMs = Math.max(3_600_000, Math.min(endMs - startMs, (Number(opts.minDays) || 0) * DAY_MS));
  const elapsedMs = Math.max(floorMs, Math.min(endMs - startMs, nowMs - startMs));
  const daysElapsed = elapsedMs / DAY_MS;
  const used = Math.max(0, finite(monthToDate));
  const perDay = used / daysElapsed;
  const projected = perDay * daysInMonth;
  let crossesOn: string | null = null;
  const crossed = limit != null && limit > 0 && used >= limit;
  if (limit != null && limit > 0) {
    if (crossed) crossesOn = new Date(nowMs).toISOString().slice(0, 10);
    else if (perDay > 0) {
      const at = startMs + (limit / perDay) * DAY_MS;
      if (at < endMs) crossesOn = new Date(at).toISOString().slice(0, 10);
    }
  }
  return {
    projected: round(projected, 4),
    perDay: round(perDay, 4),
    daysElapsed: round(daysElapsed, 3),
    daysInMonth,
    pctOfLimit: limit != null && limit > 0 ? round((projected / limit) * 100, 1) : null,
    crossesOn,
    crossed
  };
}

// ─── Alerts (pure; the Cost centre badge and the daily GitHub watch use the same rules) ──

/**
 * The simulated 12 h night that meets ADR 0006's Phase 0 budgets: one camera and two viewers,
 * live-worker/src/monitorRoom.night.test.ts (`NIGHT_OUT=<file> npx vitest run …night.test.ts`, re-run
 * 2026-10-29). Billed requests (Cloudflare pricing) = alarms + upgrades + incoming messages ÷ 20, with
 * the app's auto-answered pings counted too (the conservative reading) = 542.
 */
export const NIGHT_SIM = { alarms: 216, upgrades: 6, delivered: 1212, autoAnsweredPings: 5180, billedRequests: 542 } as const;

/** ADR 0006 Phase 0: ≤ 1,000 BILLED Durable Object requests per active nursery-day (incoming WebSocket messages 20:1). */
export const PHASE0_BILLED_REQUESTS = 1000;

/**
 * The same budget in the unit Cloudflare's analytics MEASURE. `durableObjectsInvocationsAdaptiveGroups`
 * counts alarms, upgrades and every incoming message on a hibernatable socket 1:1 ("the 20:1 ratio does
 * not affect Durable Object metrics and analytics, which reflect actual usage" — DO pricing page), and
 * it can't split messages from alarms. So the billed budget is converted at the simulated night's mix:
 * that night is 216 + 6 + 1,212 = 1,434 invocations for 542 billed, so 1,000 billed ≈ 2,646
 * invocations, rounded down to 2,600. (Auto-answered pings wake nothing, so they are not invocations.)
 *
 * The mix matters: at 2,600 invocations a night whose extra traffic is all messages bills ≈ 340
 * requests, one whose extra is all alarms or reconnects ≈ 1,450. Alarm loops also re-arm (a row
 * written each), so `write_diet` and `hibernation` catch those first.
 */
export const PHASE0_DO_INVOCATIONS = Math.floor(((NIGHT_SIM.alarms + NIGHT_SIM.upgrades + NIGHT_SIM.delivered) * PHASE0_BILLED_REQUESTS) / NIGHT_SIM.billedRequests / 100) * 100;

export type StreamAlertSeverity = 'warning' | 'critical';

export interface StreamAlert {
  /** Stable id (the daily watch diffs alert state by id). */
  id: string;
  severity: StreamAlertSeverity;
  title: string;
  /** The cause, in plain words. */
  cause: string;
}

export interface HeadroomInput {
  id: string;
  label: string;
  /** Month to date. */
  used: number;
  allowance: number;
  /** Month-end projection. */
  projected: number;
}

export interface StreamAlertInput {
  nowMs: number;
  /** One per allowance (feature doc §2.4). */
  headroom?: HeadroomInput[];
  /** TURN egress this month, GB (account-wide, measured). */
  turnGbMonthToDate?: number | null;
  /** Largest single TURN identifier in a day, GB (needs per-socket identifiers — P2 guardrails). */
  turnTopIdentifierGbDay?: number | null;
  /** DO GB-s per active nursery-day, oldest first (last few days). */
  gbSecPerNurseryDay?: number[] | null;
  /** DO rows written per active nursery-day — the 7-day median when known, else month to date (applies after ADR 0006 Phase 0 ships). */
  rowsPerNurseryDay?: number | null;
  /**
   * DO INVOCATIONS per active nursery-day as Cloudflare's analytics count them (every incoming WebSocket
   * message 1:1, not the billed 20:1) — the 7-day median (applies after ADR 0006 Phase 0 ships).
   */
  doInvocationsPerNurseryDay?: number | null;
  phase0Shipped?: boolean;
  /** Our-server share (0–1) of monitor viewer-minutes over the last 7 days. */
  serverShare7d?: number | null;
  /** R2 stored now, GB. */
  r2StoredGb?: number | null;
  /** Emails sent this month (every DreamStream app). */
  emailsMonthToDate?: number | null;
  /** Backend container awake hours this month. */
  containerAwakeHours?: number | null;
}

/** Thresholds (feature doc §3.2 item 9, plus the owner's $10 TURN alert). */
export const ALERT_THRESHOLDS = {
  freeTierWarnPct: 80,
  freeTierCritPct: 100,
  gbSecPerNurseryDay: 40,
  gbSecDaysInARow: 2,
  rowsPerNurseryDay: 1800,
  /** ADR 0006 Phase 0 budget in measured invocations per active nursery-day (7-day median): PHASE0_DO_INVOCATIONS. */
  doInvocationsPerNurseryDay: PHASE0_DO_INVOCATIONS,
  turnIdentifierGbDay: 20,
  turnGbBeforeThe15th: 500,
  serverShare7d: 0.1,
  r2StoredGb: 8,
  emails: 2400,
  containerAwakeHours: 20,
  turnUsdMonth: TURN_ALERT_USD_MONTH
} as const;

const fmtNum = (n: number, dp = 0) => n.toLocaleString('en-US', { maximumFractionDigits: dp, minimumFractionDigits: 0 });
const fmtUsd2 = (n: number) => `$${n.toFixed(2)}`;

/** Every alert that fires for these inputs, most severe first. Missing inputs never fire. */
export function evaluateStreamAlerts(input: StreamAlertInput): StreamAlert[] {
  const t = ALERT_THRESHOLDS;
  const out: StreamAlert[] = [];
  const day = new Date(input.nowMs).getUTCDate();

  for (const h of input.headroom ?? []) {
    if (!(h.allowance > 0)) continue;
    const pct = (h.projected / h.allowance) * 100;
    if (pct < t.freeTierWarnPct) continue;
    const critical = pct >= t.freeTierCritPct;
    out.push({
      id: `free_tier:${h.id}`,
      severity: critical ? 'critical' : 'warning',
      title: `${h.label}: free tier ${critical ? 'will run out' : 'filling'} this month`,
      cause: `${fmtNum(h.used)} used so far, on course for ${fmtNum(h.projected)} of the ${fmtNum(h.allowance)} included (${Math.round(pct)}%). The allowance is shared by every Worker on the Cloudflare account.`
    });
  }

  if (input.turnGbMonthToDate != null && input.turnGbMonthToDate >= 0) {
    const proj = projectMonthEnd(input.turnGbMonthToDate, input.nowMs, null, { minDays: PROJECTION_MIN_DAYS });
    const listUsd = proj.projected * STREAM_UNIT_PRICES.turnPerGb;
    const billableUsd = Math.max(0, proj.projected - STREAM_ALLOWANCES.turnGb) * STREAM_UNIT_PRICES.turnPerGb;
    if (billableUsd >= t.turnUsdMonth) {
      out.push({
        id: 'turn_spend',
        severity: 'critical',
        title: `TURN on course for ${fmtUsd2(billableUsd)} this month`,
        cause: `${fmtNum(input.turnGbMonthToDate, 1)} GB of TURN egress so far, projected ${fmtNum(proj.projected)} GB — past the free ${fmtNum(STREAM_ALLOWANCES.turnGb)} GB. Check for a leaked credential and which calls or viewers relay.`
      });
    } else if (listUsd >= t.turnUsdMonth) {
      out.push({
        id: 'turn_spend',
        severity: 'warning',
        title: `TURN on course for ${fmtUsd2(listUsd)} at list price this month`,
        cause: `${fmtNum(input.turnGbMonthToDate, 1)} GB of TURN egress so far, projected ${fmtNum(proj.projected)} GB. Still inside the free ${fmtNum(STREAM_ALLOWANCES.turnGb)} GB, which every app on the account shares.`
      });
    }
    if (day < 15 && input.turnGbMonthToDate > t.turnGbBeforeThe15th) {
      out.push({
        id: 'turn_leak',
        severity: 'critical',
        title: 'TURN leak suspected',
        cause: `${fmtNum(input.turnGbMonthToDate)} GB of TURN egress before the 15th (threshold ${t.turnGbBeforeThe15th} GB).`
      });
    }
  }
  if (input.turnTopIdentifierGbDay != null && input.turnTopIdentifierGbDay > t.turnIdentifierGbDay && !out.some((a) => a.id === 'turn_leak')) {
    out.push({
      id: 'turn_leak',
      severity: 'critical',
      title: 'TURN leak suspected',
      cause: `One TURN identifier relayed ${fmtNum(input.turnTopIdentifierGbDay, 1)} GB in a day (threshold ${t.turnIdentifierGbDay} GB).`
    });
  }

  const gbs = input.gbSecPerNurseryDay ?? [];
  const recent = gbs.slice(-t.gbSecDaysInARow);
  if (recent.length === t.gbSecDaysInARow && recent.every((v) => v > t.gbSecPerNurseryDay)) {
    out.push({
      id: 'hibernation',
      severity: 'critical',
      title: 'Hibernation looks broken',
      cause: `Durable Object duration per active nursery-day was ${recent.map((v) => fmtNum(v)).join(' and ')} GB-s (threshold ${t.gbSecPerNurseryDay}) for ${t.gbSecDaysInARow} days in a row — a timer or held-open request may be keeping rooms awake.`
    });
  }

  if (input.phase0Shipped && input.rowsPerNurseryDay != null && input.rowsPerNurseryDay > t.rowsPerNurseryDay) {
    out.push({
      id: 'write_diet',
      severity: 'warning',
      title: 'MonitorRoom write diet regressed',
      cause: `${fmtNum(input.rowsPerNurseryDay)} rows written per active nursery-day (budget ${fmtNum(t.rowsPerNurseryDay)}).`
    });
  }

  if (input.phase0Shipped && input.doInvocationsPerNurseryDay != null && input.doInvocationsPerNurseryDay > t.doInvocationsPerNurseryDay) {
    out.push({
      id: 'request_diet',
      severity: 'warning',
      title: 'MonitorRoom request budget exceeded',
      cause: `${fmtNum(input.doInvocationsPerNurseryDay)} Durable Object invocations per active nursery-day, as Cloudflare's analytics count them (each incoming WebSocket message once; the bill counts 20 as one request). Budget ${fmtNum(t.doInvocationsPerNurseryDay)} — the ADR's ${fmtNum(PHASE0_BILLED_REQUESTS)} billed requests at the simulated night's mix. Look for a chatty client: status sent more often than on change, a reconnect loop, or relay frames to hidden viewers.`
    });
  }

  if (input.serverShare7d != null && input.serverShare7d > t.serverShare7d) {
    out.push({
      id: 'relay_creep',
      severity: 'warning',
      title: 'Relay creep',
      cause: `${Math.round(input.serverShare7d * 100)}% of monitor viewer-minutes went through our server over the last 7 days (threshold ${t.serverShare7d * 100}%).`
    });
  }

  if (input.r2StoredGb != null && input.r2StoredGb > t.r2StoredGb) {
    out.push({
      id: 'r2_near_free',
      severity: input.r2StoredGb >= STREAM_ALLOWANCES.r2StoredGb ? 'critical' : 'warning',
      title: 'R2 storage near the free 10 GB',
      cause: `${fmtNum(input.r2StoredGb, 1)} GB stored (threshold ${t.r2StoredGb} GB).`
    });
  }

  if (input.emailsMonthToDate != null && input.emailsMonthToDate > t.emails) {
    out.push({
      id: 'email_near_free',
      severity: input.emailsMonthToDate >= STREAM_ALLOWANCES.emails ? 'critical' : 'warning',
      title: 'Email near the free 3,000',
      cause: `${fmtNum(input.emailsMonthToDate)} emails sent this month by every DreamStream app (threshold ${fmtNum(t.emails)}).`
    });
  }

  if (input.containerAwakeHours != null && input.containerAwakeHours > t.containerAwakeHours) {
    out.push({
      id: 'container_awake',
      severity: 'warning',
      title: 'Backend container awake a lot',
      cause: `${fmtNum(input.containerAwakeHours, 1)} awake hours this month (threshold ${t.containerAwakeHours}).`
    });
  }

  return out.sort((a, b) => (a.severity === b.severity ? a.id.localeCompare(b.id) : a.severity === 'critical' ? -1 : 1));
}
