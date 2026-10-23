/**
 * Reading this month's usage — only when someone looks (ADR 0007 D2; feature doc §4.5, B6).
 * Over sockets that are already open, never on a timer:
 *
 *   - the member's own month: their personal call line (UserLine) — `{t:'usage_get'}` →
 *     `{t:'usage', usage, allowances}`. The call center owns that socket and plugs it in here
 *     (`setAccountLine`, `accountLineUp`), so the Usage card needs no socket of its own. A
 *     question asked while the line is still connecting is sent the moment it says hello;
 *   - a nursery's month, for parents: the monitor socket's query channel —
 *     `{t:'q', q:'usage'}` → `{t:'r', q:'usage', usage, allowances}` (caregivers, viewers and
 *     guests get `error: 'forbidden'`);
 *   - 7-day copies in use: the cloud-copy quota read the save sheet already makes, against the
 *     most recent event this device hosts (the quota is per account).
 *
 * Plus the fair-use notices at 80% and 100% (in the app only, once per level per month).
 * Display only: nothing here enforces a limit, or can pause a picture, a sound or an alert.
 */
import { emptyCounters, FAIR_USE, monthKey, sanitizeMonth, turnBytesOf, type UsageMonth } from '@/shared/stream/usage';
import { fetchCloudCopyQuota, type CloudCopyQuota } from '../cloudCopy';
import { allowanceLevel, relayNotice, type AllowanceLevel } from '../costCopy';
import { listMyEvents } from '../events';

export interface AccountUsage {
  usage: UsageMonth;
  allowances: { relayDataGb: number; cloudCopyGb: number };
}

export interface NurseryUsage {
  usage: UsageMonth;
  allowances: { relayDataGb: number; serverPictureHoursPerDay: number };
}

const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt);

export function parseAccountUsage(m: unknown): AccountUsage | null {
  const o = m as { t?: unknown; usage?: unknown; allowances?: Record<string, unknown> } | null;
  if (!o || o.t !== 'usage') return null;
  const usage = sanitizeMonth(o.usage);
  if (!usage) return null;
  return {
    usage,
    allowances: {
      relayDataGb: num(o.allowances?.relayDataGb, FAIR_USE.relayDataGbPerAccountMonth),
      cloudCopyGb: num(o.allowances?.cloudCopyGb, FAIR_USE.cloudCopyGbRolling),
    },
  };
}

export function parseNurseryUsage(m: unknown): NurseryUsage | 'forbidden' | null {
  const o = m as { q?: unknown; error?: unknown; usage?: unknown; allowances?: Record<string, unknown> } | null;
  if (!o) return null;
  if (o.error === 'forbidden') return 'forbidden';
  const usage = sanitizeMonth(o.usage);
  if (!usage) return null;
  return {
    usage,
    allowances: {
      relayDataGb: num(o.allowances?.relayDataGb, FAIR_USE.relayDataGbPerNurseryMonth),
      serverPictureHoursPerDay: num(o.allowances?.serverPictureHoursPerDay, FAIR_USE.serverPictureHoursPerNurseryDay),
    },
  };
}

/* ------------------------------------------------- the account's line */

/** Sends on the personal line; false when it isn't connected (yet). */
type LineSend = (msg: Record<string, unknown>) => boolean;
let line: LineSend | null = null;
let waiters: { resolve: (v: AccountUsage | null) => void; timer: ReturnType<typeof setTimeout> }[] = [];
/** A `usage_get` is out and its answer not back yet. */
let asked = false;

function settle(v: AccountUsage | null): void {
  const all = waiters;
  waiters = [];
  asked = false;
  for (const w of all) {
    clearTimeout(w.timer);
    w.resolve(v);
  }
}

/** Ask now if someone is waiting and nobody has asked yet. */
function ask(): void {
  if (!waiters.length || asked || !line) return;
  if (line({ t: 'usage_get' })) asked = true;
}

/** The call center plugs its personal line in (null: there is none — anyone waiting hears "unknown"). */
export function setAccountLine(send: LineSend | null): void {
  line = send;
  asked = false;
  if (!send) settle(null);
  else ask();
}

/** The personal line said hello: a question asked while it was connecting goes out now. */
export function accountLineUp(): void {
  asked = false;
  ask();
}

/** The line's `{t:'usage'}` answer (the call center hands it over). */
export function acceptAccountUsage(m: unknown): void {
  settle(parseAccountUsage(m));
}

/**
 * This month's account usage, or null (signed out, no line, no answer in time). One request
 * serves everyone asking at the same time. The timeout is a one-off for this request, not a
 * poll; nothing is ever asked again on its own.
 */
export function requestAccountUsage(timeoutMs = 10_000): Promise<AccountUsage | null> {
  if (!line) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w.timer !== timer);
      if (!waiters.length) asked = false;
      resolve(null);
    }, timeoutMs);
    waiters.push({ resolve, timer });
    ask();
  });
}

/** Tests: forget the line and anyone waiting. */
export function resetAccountLineForTests(): void {
  for (const w of waiters) clearTimeout(w.timer);
  waiters = [];
  line = null;
  asked = false;
}

/* ------------------------------------------------------ a nursery's */

/** The monitor socket's query channel (live/monitor/query.ts MonQuery). */
export interface QueryLike {
  ask<T>(q: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T | null>;
}

export async function requestNurseryUsage(query: QueryLike | null | undefined, nid?: string): Promise<NurseryUsage | 'forbidden' | null> {
  if (!query) return null;
  try {
    const r = parseNurseryUsage(await query.ask<unknown>('usage'));
    if (r && r !== 'forbidden' && nid) rememberNurseryRelay(nid, r);
    return r;
  } catch {
    return null;
  }
}

/* ------------------------------------------------- 7-day copies */

/** The account's 7-day copies in use, read through the most recent event this device hosts (null: unknown). */
export async function fetchAccountCloudQuota(fetchImpl: typeof fetch = fetch): Promise<CloudCopyQuota | null> {
  const ev = listMyEvents().find((e) => e.id && e.hostKey);
  if (!ev) return null;
  return fetchCloudCopyQuota(ev.id, ev.hostKey, undefined, fetchImpl);
}

/* ------------------------------------- relay data, and its notices */

/** Relay data in a month for one kind: measured where apps reported it, else ≈ from minutes. */
export function relayDataOf(usage: UsageMonth, kind: 'monitor' | 'call'): { bytes: number; measured: boolean } {
  const c = usage.counters[kind] ?? emptyCounters();
  const r = turnBytesOf(c, kind);
  return { bytes: r.bytes, measured: r.measured };
}

export interface RelayKnown {
  month: string;
  bytes: number;
  limitGb: number;
  measured: boolean;
}

const RELAY_KEY = (nid: string) => `ds-usage-relay-${nid}`;

/** A parent read the nursery's month: keep its relay data for the relay pill's tooltip. */
function rememberNurseryRelay(nid: string, r: NurseryUsage): void {
  const d = relayDataOf(r.usage, 'monitor');
  const v: RelayKnown = { month: r.usage.month, bytes: d.bytes, limitGb: r.allowances.relayDataGb, measured: d.measured };
  try {
    localStorage.setItem(RELAY_KEY(nid), JSON.stringify(v));
  } catch { /* storage unavailable */ }
}

/** This month's relay data for a nursery as last read on this device (parents only; null: unknown). */
export function knownNurseryRelay(nid: string, now = Date.now()): RelayKnown | null {
  try {
    const raw = localStorage.getItem(RELAY_KEY(nid));
    const v = raw ? (JSON.parse(raw) as Partial<RelayKnown>) : null;
    if (!v || v.month !== monthKey(now) || !(Number(v.bytes) >= 0) || !(Number(v.limitGb) > 0)) return null;
    return { month: v.month, bytes: Number(v.bytes), limitGb: Number(v.limitGb), measured: v.measured !== false };
  } catch {
    return null;
  }
}

const NOTICE_KEY = (k: string) => `ds-usage-notice-${k}`;

/** True the first time this notice is due on this device (then remembered). */
export function noticeOnce(key: string): boolean {
  try {
    if (localStorage.getItem(NOTICE_KEY(key))) return false;
    localStorage.setItem(NOTICE_KEY(key), '1');
    return true;
  } catch {
    return false;
  }
}

export interface RelayNotice {
  level: AllowanceLevel;
  text: string;
}

/** The notice for a month's relay data, if one is due now (once per level per month per device). */
export function dueRelayNotice(scope: 'account' | 'nursery', id: string, usage: UsageMonth, limitGb: number): RelayNotice | null {
  const used = relayDataOf(usage, scope === 'nursery' ? 'monitor' : 'call').bytes;
  const level = allowanceLevel(used, limitGb * 1e9);
  const text = relayNotice(level, used, limitGb, usage.month, scope);
  if (!text || !noticeOnce(`${scope}:${id}:${usage.month}:${level}`)) return null;
  return { level, text };
}

const CHECK_KEY = (nid: string) => `ds-usage-checked-${nid}`;
/** A parent's monitor screen looks at the nursery's allowance at most this often. */
export const NURSERY_CHECK_EVERY_MS = 12 * 60 * 60_000;

/**
 * A parent opened the monitor: at most twice a day, read the nursery's month once (one
 * query over the open socket) and say so in the app if relay data is at 80% or 100%.
 */
export async function checkNurseryAllowance(query: QueryLike | null | undefined, nid: string, say: (text: string, level: AllowanceLevel) => void, now = Date.now()): Promise<void> {
  if (!query) return;
  try {
    const last = Number(localStorage.getItem(CHECK_KEY(nid)) || 0);
    if (now - last >= 0 && now - last < NURSERY_CHECK_EVERY_MS) return;
    localStorage.setItem(CHECK_KEY(nid), String(now));
  } catch {
    return;
  }
  const r = await requestNurseryUsage(query, nid);
  if (!r || r === 'forbidden' || r.usage.month !== monthKey(now)) return;
  const n = dueRelayNotice('nursery', nid, r.usage, r.allowances.relayDataGb);
  if (n) say(n.text, n.level);
}
