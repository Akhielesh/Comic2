// Admin → Costs → Security: aggregate, privacy-safe security signals (ADR 0006 WS-8).
//
//   fetchCspCounts(...)          Analytics Engine SQL over the CSP report counts the Pages function writes
//                                (functions/csp-report.ts → binding CSP_REPORTS; dataset from
//                                CSP_REPORTS_DATASET, default `csp_reports`). Same read-only token as the
//                                Stream Studio tab. Dormant (an honest note) until the owner binds it.
//   loadSignInCounts(...)        Supabase `security_events` (server/sql/live_security_v2.sql): HEAD counts
//                                by kind — never a row, a user id, a user agent or an IP. Degrades to
//                                "not measured" while that SQL isn't applied.
//   buildSecuritySection(...)    PURE: the above + the live Worker's signal counts (shared/stream/signals.ts,
//                                read in the Stream Studio Analytics Engine query) → SecuritySection.
//
// Everything here is a COUNT. The CSP rows carry an origin or keyword, never a URL (the Pages function
// already cut them down); the signals carry a fixed name and a surface word. The runbook says what to do
// when one of the alerts fires: docs/infrastructure/live-security-runbook.md.

import type { CspViolationRow, SecuritySection, SecuritySignalRow, StreamAlertRow } from '../../../shared/types/costCentre.js';
import { SECURITY_SIGNALS, SIGNAL_LABEL, SIGNAL_TONE, sumSignal, type SignalRow } from '../../../shared/stream/signals.js';
import { analyticsEngineSqlUrl, cfPost, scrub, streamCredentialsFromEnv, type FetchLike, type StreamCredentials } from './streamCosts.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Analytics Engine keeps about three months. */
const AE_MAX_DAYS = 90;
export const CSP_ROW_LIMIT = 10_000;
export const DEFAULT_CSP_DATASET = 'csp_reports';

/** Alert thresholds (the runbook's "what fires and why"). */
export const SECURITY_THRESHOLDS = {
  /** One UTC day of a refusal signal at or past this is a flood worth a look (rate limits, origins, pre-auth, MFA). */
  floodPerDay: 500,
  /** Enforcing the CSP on Stream Studio needs this many hours with zero first-party violations. */
  cspCleanHours: 48
} as const;

/** The dataset the Pages function's binding writes to (a plain identifier; anything else → the default). */
export const cspDatasetFromEnv = (env: NodeJS.ProcessEnv = process.env): string => {
  const v = String(env.CSP_REPORTS_DATASET || '').trim();
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v) ? v : DEFAULT_CSP_DATASET;
};

// ─── CSP counts (Analytics Engine) ───────────────────────────────────────────────────────

export interface CspHourRow {
  /** Hour start, ms. */
  at: number;
  disposition: string;
  page: string;
  directive: string;
  blocked: string;
  firstParty: boolean;
  count: number;
}

/**
 * One query, hourly buckets: the Pages function writes blobs [disposition, page, directive, blocked,
 * source, 'first'|'extension'] and double1 = 1 per violation.
 */
export function cspSql(dataset: string, days: number): string {
  const n = Math.max(2, Math.min(AE_MAX_DAYS, Math.ceil(days)));
  return (
    `SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour, blob1 AS disposition, blob2 AS page, blob3 AS directive, blob4 AS blocked, blob6 AS party, ` +
    `SUM(_sample_interval * double1) AS n FROM ${dataset} WHERE timestamp > NOW() - INTERVAL '${n}' DAY ` +
    `GROUP BY hour, disposition, page, directive, blocked, party ORDER BY hour DESC LIMIT ${CSP_ROW_LIMIT} FORMAT JSON`
  );
}

const clip = (v: unknown, max: number) => String(v ?? '').slice(0, max);

export function parseCspRows(json: unknown): CspHourRow[] {
  const data = (json as { data?: Array<Record<string, unknown>> })?.data;
  if (!Array.isArray(data)) return [];
  const out: CspHourRow[] = [];
  for (const r of data) {
    // Analytics Engine answers 'YYYY-MM-DD HH:MM:SS' (UTC).
    const at = Date.parse(`${String(r.hour ?? '').replace(' ', 'T')}Z`);
    const count = Number(r.n);
    if (!Number.isFinite(at) || !Number.isFinite(count) || count <= 0) continue;
    const blocked = clip(r.blocked, 120);
    out.push({
      at,
      disposition: clip(r.disposition, 16) || 'unknown',
      page: clip(r.page, 16) || 'other',
      directive: clip(r.directive, 40) || 'unknown',
      // The function already reduced it to an origin or keyword; a path would never reach here, but cut any.
      blocked: /^[a-z]+:\/\/[^/]+/i.test(blocked) ? (blocked.match(/^[a-z]+:\/\/[^/?#]+/i)?.[0] ?? blocked) : blocked,
      firstParty: r.party !== 'extension',
      count
    });
  }
  return out;
}

export interface CspCounts {
  measured: boolean;
  rows: CspHourRow[];
  error?: string;
}

export async function fetchCspCounts(input: {
  nowMs: number;
  days: number;
  creds?: StreamCredentials | null;
  dataset?: string;
  fetchImpl?: FetchLike;
}): Promise<CspCounts | null> {
  const creds = input.creds === undefined ? streamCredentialsFromEnv() : input.creds;
  if (!creds) return null;
  const fetchImpl = input.fetchImpl ?? (fetch as unknown as FetchLike);
  try {
    const json = await cfPost(creds, analyticsEngineSqlUrl(creds.accountId), cspSql(input.dataset ?? cspDatasetFromEnv(), input.days), 'text/plain', fetchImpl);
    if (!Array.isArray((json as { data?: unknown })?.data)) throw new Error('unexpected answer (no data rows)');
    return { measured: true, rows: parseCspRows(json) };
  } catch (err) {
    return { measured: false, rows: [], error: scrub(scrub((err as Error)?.message || 'request failed', creds.token), creds.accountId) };
  }
}

// ─── Sign-in alerts (Supabase security_events, counts only) ──────────────────────────────

export interface SignInCounts {
  measured: boolean;
  newSessions: number | null;
  alertsEmailed: number | null;
  secured: number | null;
  devicesAdded: number | null;
  devicesRevoked: number | null;
  error?: string;
}

/** The slice of supabase-js the counter uses: `from(t).select(c, {count, head}).eq().gte().lt()` → {count, error}. */
type CountQuery = PromiseLike<{ count: number | null; error: { message?: string; code?: string } | null }> & {
  eq(col: string, v: unknown): CountQuery;
  gte(col: string, v: unknown): CountQuery;
  lt(col: string, v: unknown): CountQuery;
};
export interface CountClient {
  from(table: string): { select(cols: string, opts: { count: 'exact'; head: true }): CountQuery };
}

export async function loadSignInCounts(client: CountClient, fromMs: number, toMs: number): Promise<SignInCounts> {
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  const count = async (kind: string, extra?: (q: CountQuery) => CountQuery): Promise<number> => {
    let q = client.from('security_events').select('id', { count: 'exact', head: true }).eq('kind', kind).gte('at', from).lt('at', to);
    if (extra) q = extra(q);
    const { count: n, error } = await q;
    if (error) throw new Error(error.message || error.code || 'query failed');
    return n ?? 0;
  };
  try {
    const [newSessions, alertsEmailed, secured, devicesAdded, devicesRevoked] = await Promise.all([
      count('sign_in'),
      count('sign_in', (q) => q.eq('notified', true)),
      count('secured'),
      count('device_added'),
      count('device_revoked')
    ]);
    return { measured: true, newSessions, alertsEmailed, secured, devicesAdded, devicesRevoked };
  } catch (err) {
    return {
      measured: false,
      newSessions: null,
      alertsEmailed: null,
      secured: null,
      devicesAdded: null,
      devicesRevoked: null,
      error: String((err as Error)?.message || 'error').slice(0, 200)
    };
  }
}

// ─── Build (pure) ────────────────────────────────────────────────────────────────────────

export interface SecurityBuildInput {
  nowMs: number;
  range: { fromMs: number; toMs: number; prevFromMs: number; days: number };
  /** null = Cloudflare analytics not configured (nothing was asked). */
  csp: CspCounts | null;
  signIns: SignInCounts | null;
  /** The live Worker's signal rows (null = Analytics Engine not asked or didn't answer). */
  signals: SignalRow[] | null;
  /** First UTC day Analytics Engine rows cover (for the previous-period column). */
  aeFromMs?: number | null;
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;

export function buildSecuritySection(input: SecurityBuildInput): SecuritySection {
  const { nowMs } = input;
  const { fromMs, toMs, prevFromMs, days } = input.range;
  const notes: string[] = [];
  const alerts: StreamAlertRow[] = [];

  // ---- CSP ------------------------------------------------------------------------------------
  const cspRows = input.csp?.rows ?? [];
  const cspMeasured = !!input.csp?.measured;
  const inRange = (r: CspHourRow) => r.at >= fromMs && r.at < toMs;
  const liveFirst = (r: CspHourRow) => r.page === 'live' && r.firstParty;
  const sum = (rows: CspHourRow[]) => rows.reduce((s, r) => s + r.count, 0);
  const rangeRows = cspRows.filter(inRange);
  const since48 = nowMs - SECURITY_THRESHOLDS.cspCleanHours * HOUR_MS;
  const live48 = sum(cspRows.filter((r) => liveFirst(r) && r.at + HOUR_MS > since48));
  const liveEnforced = sum(rangeRows.filter((r) => liveFirst(r) && r.disposition === 'enforce'));
  const liveReportOnly = sum(rangeRows.filter((r) => liveFirst(r) && r.disposition !== 'enforce'));
  const buckets = new Map<string, CspViolationRow>();
  for (const r of rangeRows) {
    const key = [r.page, r.directive, r.blocked, r.disposition, r.firstParty].join('|');
    const b = buckets.get(key) ?? { page: r.page, directive: r.directive, blocked: r.blocked, disposition: r.disposition, firstParty: r.firstParty, count: 0 };
    b.count += r.count;
    buckets.set(key, b);
  }
  const top = [...buckets.values()]
    .sort((a, b) => Number(b.firstParty) - Number(a.firstParty) || b.count - a.count || a.page.localeCompare(b.page) || a.directive.localeCompare(b.directive))
    .slice(0, 25);
  if (cspMeasured && liveEnforced > 0) {
    alerts.push({
      id: 'csp_live_blocked',
      severity: 'critical',
      title: 'The enforced CSP blocked our own code on Stream Studio',
      cause: `${plural(liveEnforced, 'first-party violation')} on Stream Studio pages in this period were blocked for real. Something the monitor needs may have stopped (a sound worklet, a model, a socket). Check the top rows below, then fix the policy or set ENFORCE_LIVE back to false (runbook §CSP).`
    });
  } else if (cspMeasured && live48 > 0) {
    alerts.push({
      id: 'csp_live_violations',
      severity: 'warning',
      title: 'Stream Studio’s CSP isn’t clean yet',
      cause: `${plural(live48, 'first-party violation')} on Stream Studio pages in the last ${SECURITY_THRESHOLDS.cspCleanHours} h (report-only). Enforcing the policy waits for ${SECURITY_THRESHOLDS.cspCleanHours} clean hours.`
    });
  }
  const cspNote = !input.csp
    ? 'Cloudflare analytics is not connected, so CSP counts aren’t read (set CF_ANALYTICS_API_TOKEN and CLOUDFLARE_ACCOUNT_ID on the backend).'
    : !cspMeasured
      ? `CSP counts didn’t answer. Until the Pages project has the Analytics Engine binding CSP_REPORTS (dataset ${DEFAULT_CSP_DATASET}, or CSP_REPORTS_DATASET on the backend) and has received a report, the counts live only in the Pages Functions log (the 1st, 10th, 100th… of each kind).`
      : `Counts of browser reports, by app, directive and blocked origin — never a URL. “Extension” rows come from browser add-ons, not our code. Enforcing the policy on Stream Studio waits for ${SECURITY_THRESHOLDS.cspCleanHours} h with no first-party violations there.`;

  // ---- Sign-ins -------------------------------------------------------------------------------
  const si = input.signIns;
  if (si?.measured && (si.secured ?? 0) > 0) {
    alerts.push({
      id: 'not_you_used',
      severity: 'warning',
      title: '“Not you?” was used',
      cause: `${plural(si.secured ?? 0, 'person', 'people')} used “Not you? Secure my account” in this period — each is a suspected account takeover. Every session of theirs was ended; follow the playbook (runbook §Suspected account takeover) if they ask for help or it repeats.`
    });
  }
  const signInNote = !si
    ? 'Not read.'
    : si.measured
      ? '“New sign-ins” counts sessions the access-token hook saw for the first time (refreshes of older sessions and an account’s first session are recorded but never emailed); “alerts emailed” is how many got the new-sign-in email.'
      : 'Not measured: server/sql/live_security_v2.sql isn’t applied yet (or the table can’t be read). Sign-in alerts start once it is applied and the Custom Access Token hook is on (owner checklist §4).';

  // ---- Worker signals -------------------------------------------------------------------------
  const sig = input.signals;
  const prevCovered = input.aeFromMs != null && input.aeFromMs <= prevFromMs;
  const curDay = (d: string) => d >= dayKey(fromMs) && d <= dayKey(Math.max(fromMs, toMs - 1));
  const prevDay = (d: string) => d >= dayKey(prevFromMs) && d < dayKey(fromMs);
  const counted = !!sig && sig.some((r) => (SECURITY_SIGNALS as readonly string[]).includes(r.name));
  const rows: SecuritySignalRow[] = SECURITY_SIGNALS.map((name) => {
    const bySurface = new Map<string, number>();
    for (const r of sig ?? []) if (r.name === name && curDay(r.day)) bySurface.set(r.surface || 'other', (bySurface.get(r.surface || 'other') ?? 0) + r.count);
    return {
      id: name,
      label: SIGNAL_LABEL[name],
      count: sumSignal(sig, name, curDay),
      prevCount: sig && prevCovered ? sumSignal(sig, name, prevDay) : null,
      tone: SIGNAL_TONE[name],
      bySurface: [...bySurface].map(([surface, count]) => ({ surface, count })).sort((a, b) => b.count - a.count)
    };
  });
  // A flood: one UTC day of a refusal signal at or past the threshold.
  for (const name of SECURITY_SIGNALS) {
    if (SIGNAL_TONE[name] !== 'bad' || name === 'camera_spoof_refused') continue;
    const perDay = new Map<string, number>();
    for (const r of sig ?? []) if (r.name === name && curDay(r.day)) perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.count);
    const worst = [...perDay].sort((a, b) => b[1] - a[1])[0];
    if (worst && worst[1] >= SECURITY_THRESHOLDS.floodPerDay) {
      alerts.push({
        id: `flood:${name}`,
        severity: 'warning',
        title: `${SIGNAL_LABEL[name]}: ${plural(worst[1], 'time')} on ${worst[0]}`,
        cause: `At or past ${SECURITY_THRESHOLDS.floodPerDay} in one day. A client in a loop, a misconfigured origin, or someone probing — see runbook §Signals.`
      });
    }
  }
  const spoof = sumSignal(sig, 'camera_spoof_refused', curDay);
  if (spoof > 0) {
    alerts.push({
      id: 'camera_spoof',
      severity: 'warning',
      title: 'Someone tried to take over a running camera',
      cause: `${plural(spoof, 'refusal')}: an account other than the camera’s own tried to replace a running nursery camera. Usually a family member opening camera mode under their own account; repeated, it is worth a look (runbook §Signals).`
    });
  }
  const signalsMeasured = !!sig;
  const signalsNote = !signalsMeasured
    ? 'Not measured: the Stream Studio tab’s Analytics Engine read didn’t answer (or Cloudflare analytics isn’t connected).'
    : counted
      ? 'Counts from the live Worker (floors: a count still in an isolate’s memory when it is evicted is lost). Names and a socket kind only — never who.'
      : 'Nothing counted yet: the live Worker’s rooms and routes count these once ADR 0006 WS-7, WS-9 and WS-10 wire live-worker/src/signals.ts. Zero here means “not wired”, not “nothing happened”.';

  // ---- Notes ----------------------------------------------------------------------------------
  notes.push('Everything on this tab is a count. No account, nursery, device, IP address, token, email or page URL is read or shown.');
  notes.push('What to do when an alert fires: docs/infrastructure/live-security-runbook.md.');
  if (!prevCovered && signalsMeasured) notes.push('The previous period is older than Analytics Engine keeps (about 90 days) — no comparison column.');
  if (cspRows.length >= CSP_ROW_LIMIT) notes.push(`CSP counts hit the ${CSP_ROW_LIMIT.toLocaleString('en-US')}-row cap — the oldest hours are partial.`);

  return {
    range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), days },
    csp: {
      measured: cspMeasured,
      total: cspMeasured ? sum(rangeRows) : null,
      firstPartyLive48h: cspMeasured ? live48 : null,
      firstPartyLiveEnforced: cspMeasured ? liveEnforced : null,
      firstPartyLiveReportOnly: cspMeasured ? liveReportOnly : null,
      extension: cspMeasured ? sum(rangeRows.filter((r) => !r.firstParty)) : null,
      top: cspMeasured ? top : [],
      note: cspNote,
      ...(input.csp?.error ? { error: input.csp.error } : {})
    },
    signIns: {
      measured: !!si?.measured,
      newSessions: si?.newSessions ?? null,
      alertsEmailed: si?.alertsEmailed ?? null,
      secured: si?.secured ?? null,
      devicesAdded: si?.devicesAdded ?? null,
      devicesRevoked: si?.devicesRevoked ?? null,
      note: signInNote,
      ...(si?.error ? { error: si.error } : {})
    },
    signals: { measured: signalsMeasured, counted, rows, note: signalsNote },
    alerts: alerts.sort((a, b) => (a.severity === b.severity ? a.id.localeCompare(b.id) : a.severity === 'critical' ? -1 : 1)),
    notes
  };
}

/** Days the CSP query must cover: the range plus the 48 h gate, at least. */
export const cspQueryDays = (rangeDays: number) => Math.max(rangeDays + 1, Math.ceil((SECURITY_THRESHOLDS.cspCleanHours * HOUR_MS) / DAY_MS));
