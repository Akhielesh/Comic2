// Room and edge signals — aggregate, privacy-safe COUNTS for Admin → Costs (ADR 0006 WS-8).
//
// The live Worker and its rooms count a handful of named things — a socket kicked by "Sign out
// everywhere", a token refused because two-step sign-in wasn't completed, a Glance bump, a push handed
// to Apple — and write the counts to the `stream_usage` Analytics Engine dataset the rooms already
// write their usage points to (binding STREAM_USAGE). The backend's Cost centre reads them back in the
// SAME Analytics Engine query as the usage points (no extra query, no new binding, no SQL).
//
// Privacy by construction: a signal is a NAME from the fixed list below, an optional SURFACE word
// (which kind of socket or push transport) and a count. Never an account, nursery, device, IP, token,
// email or name — the writer has no field to put one in, and the reader drops anything it doesn't know.
//
// Cost by construction: the writer coalesces. The first occurrence of a (name, surface) writes at once;
// further ones in the next minute are added up in memory and written with the next occurrence after the
// minute, or by flush() (rooms call it from their hourly usage flush and when they go idle). A flood of
// refusals is therefore ≤ 1 point per minute per isolate per signal, never one point per request.
// Counts that are still in memory when an isolate is evicted are lost, so every figure is a FLOOR —
// the Cost centre says so.
//
// Layout in Analytics Engine (index1 is what the usage query calls `kind`):
//   indexes: ['sig']   blobs: [name, surface, '', '']   doubles: [count]
// so the existing usage query (… index1 AS kind, blob1 AS scope, blob2 AS scope_id …,
// SUM(_sample_interval * double1) AS d1 …) returns signal rows as kind='sig', scope=name,
// scope_id=surface, d1=count. parseAeSignals() reads exactly that.

/** Analytics Engine index for signal points (the usage points use their usage kind). */
export const SIGNAL_INDEX = 'sig';

/** Security signals: who was refused or disconnected, and why — counts only. */
export const SECURITY_SIGNALS = [
  'kick',
  'kick_closed',
  'removed_closed',
  'mfa_refused',
  'session_expired',
  'session_revoked',
  'reauth_ok',
  'rate_limited',
  'origin_refused',
  'preauth_evicted',
  'guest_lockout',
  'camera_spoof_refused',
  'device_revoked_closed'
] as const;

/** Cost / watch-readiness signals (the ADR 0006 KPIs "Glance bumps per night" and "pushes per night"). */
export const OPS_SIGNALS = ['glance_bump', 'push_sent', 'push_gone', 'push_failed'] as const;

export const SIGNAL_NAMES = [...SECURITY_SIGNALS, ...OPS_SIGNALS] as const;
export type SecuritySignal = (typeof SECURITY_SIGNALS)[number];
export type OpsSignal = (typeof OPS_SIGNALS)[number];
export type SignalName = (typeof SIGNAL_NAMES)[number];

/** What each signal counts, in the words the Cost centre shows (and the producer must match). */
export const SIGNAL_LABEL: Readonly<Record<SignalName, string>> = {
  kick: '“Sign out everywhere” / “Not you?” requests',
  kick_closed: 'Sockets closed by a sign-out-everywhere',
  removed_closed: 'Sockets closed because the person was removed (4004)',
  mfa_refused: 'Refused: two-step sign-in not completed (aal1 with a factor, 4003)',
  session_expired: 'Sockets closed at token expiry + 120 s (4001)',
  session_revoked: 'Refused: the session had been ended',
  reauth_ok: 'Tokens renewed on an open socket',
  rate_limited: 'Refused by an edge rate limit (4008 / 429)',
  origin_refused: 'WebSocket upgrades from an origin not on the allowlist',
  preauth_evicted: 'Unauthenticated sockets evicted by the pre-auth cap',
  guest_lockout: 'Share-link lockouts after wrong passcodes',
  camera_spoof_refused: 'Refused: another account tried to take over a running camera',
  device_revoked_closed: 'Sockets closed because their device was revoked',
  glance_bump: 'Glance bumps (a visible change on watches and widgets)',
  push_sent: 'Pushes handed to a provider',
  push_gone: 'Push targets pruned as gone (410 / unregistered)',
  push_failed: 'Pushes that failed on our side (config / fatal)'
};

/**
 * Which way "more" points. `bad` signals going up deserve a look (refusals, lockouts, spoof attempts);
 * `neutral` ones are expected traffic (renewals, sign-outs people asked for).
 */
export const SIGNAL_TONE: Readonly<Record<SecuritySignal, 'bad' | 'neutral'>> = {
  kick: 'neutral',
  kick_closed: 'neutral',
  removed_closed: 'neutral',
  mfa_refused: 'bad',
  session_expired: 'neutral',
  session_revoked: 'bad',
  reauth_ok: 'neutral',
  rate_limited: 'bad',
  origin_refused: 'bad',
  preauth_evicted: 'bad',
  guest_lockout: 'bad',
  camera_spoof_refused: 'bad',
  device_revoked_closed: 'neutral'
};

export const isSignalName = (v: unknown): v is SignalName => typeof v === 'string' && (SIGNAL_NAMES as readonly string[]).includes(v);
export const isSecuritySignal = (v: unknown): v is SecuritySignal => typeof v === 'string' && (SECURITY_SIGNALS as readonly string[]).includes(v);

/**
 * Where a signal happened: the kind of socket or route, or the push transport. A fixed list, so an id
 * can never ride in this field — anything else becomes ''.
 */
export const SIGNAL_SURFACES = [
  'monitor',
  'camera',
  'line',
  'call',
  'glance',
  'admin',
  'guest',
  'edge',
  'account',
  'device',
  'webpush',
  'apns',
  'apns-la',
  'apns-voip',
  'fcm'
] as const;
export type SignalSurface = (typeof SIGNAL_SURFACES)[number];

export function signalSurface(v: unknown): SignalSurface | '' {
  if (typeof v !== 'string') return '';
  const s = v.trim().toLowerCase();
  return (SIGNAL_SURFACES as readonly string[]).includes(s) ? (s as SignalSurface) : '';
}

/** The Workers Analytics Engine binding, as much of it as the writer uses. */
export interface SignalSink {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

export interface SignalPoint {
  name: SignalName;
  surface: SignalSurface | '';
  count: number;
}

/** The data point for one (name, surface, count). */
export function signalPoint(p: SignalPoint): { indexes: string[]; blobs: string[]; doubles: number[] } {
  return { indexes: [SIGNAL_INDEX], blobs: [p.name, p.surface, '', ''], doubles: [p.count] };
}

/**
 * Coalescing counter. One per isolate (module scope in the live Worker). Never throws: an observer
 * must never break a room, a sign-out or an alert.
 */
export class SignalCounter {
  private readonly pending = new Map<string, SignalPoint>();
  private readonly lastWrite = new Map<string, number>();
  private readonly minGapMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(opts: { minGapMs?: number; maxKeys?: number; now?: () => number } = {}) {
    this.minGapMs = Math.max(0, opts.minGapMs ?? 60_000);
    this.maxKeys = Math.max(1, opts.maxKeys ?? 128);
    this.now = opts.now ?? (() => Date.now());
  }

  /** Count `n` of `name` (on `surface`). Writes at once when this key hasn't written for a minute. */
  bump(sink: SignalSink | null | undefined, name: SignalName, surface?: string, n = 1): void {
    try {
      if (!sink || !isSignalName(name)) return;
      const count = Number.isFinite(n) && n > 0 ? Math.min(n, 1e6) : 0;
      if (!count) return;
      const s = signalSurface(surface ?? '');
      const key = `${name}|${s}`;
      const cur = this.pending.get(key);
      if (!cur && this.pending.size >= this.maxKeys) this.flush(sink);
      const next = { name, surface: s, count: (cur?.count ?? 0) + count };
      const t = this.now();
      const last = this.lastWrite.get(key);
      if (last === undefined || t - last >= this.minGapMs) {
        this.pending.delete(key);
        this.write(sink, key, next, t);
      } else {
        this.pending.set(key, next);
      }
    } catch {
      /* never let counting break the caller */
    }
  }

  /** Write everything still in memory (the rooms' hourly flush, idle, close). */
  flush(sink: SignalSink | null | undefined): number {
    if (!sink) return 0;
    let wrote = 0;
    const t = this.now();
    for (const [key, p] of [...this.pending]) {
      this.pending.delete(key);
      if (this.write(sink, key, p, t)) wrote++;
    }
    return wrote;
  }

  /** Counts waiting in memory (tests, and a room deciding whether a flush is worth it). */
  pendingTotal(): number {
    let n = 0;
    for (const p of this.pending.values()) n += p.count;
    return n;
  }

  private write(sink: SignalSink, key: string, p: SignalPoint, t: number): boolean {
    this.lastWrite.set(key, t);
    if (this.lastWrite.size > this.maxKeys * 4) {
      // Keep the bookkeeping bounded: drop the oldest half of the timestamps.
      const keep = [...this.lastWrite].sort((a, b) => b[1] - a[1]).slice(0, this.maxKeys * 2);
      this.lastWrite.clear();
      for (const [k, v] of keep) this.lastWrite.set(k, v);
    }
    try {
      sink.writeDataPoint(signalPoint(p));
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Reading (backend) ─────────────────────────────────────────────────────────────────────

export interface SignalRow {
  /** UTC day 'YYYY-MM-DD'. */
  day: string;
  name: SignalName;
  surface: SignalSurface | '';
  count: number;
}

/**
 * The signal rows in an Analytics Engine answer to the usage query (kind='sig'). Unknown names and
 * malformed rows are dropped; a surface that isn't a surface word becomes ''.
 */
export function parseAeSignals(json: unknown): SignalRow[] {
  const data = (json as { data?: Array<Record<string, unknown>> })?.data;
  if (!Array.isArray(data)) return [];
  const out: SignalRow[] = [];
  for (const r of data) {
    if (r?.kind !== SIGNAL_INDEX) continue;
    const name = r.scope;
    if (!isSignalName(name)) continue;
    const day = String(r.day ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const count = Number(r.d1);
    if (!Number.isFinite(count) || count <= 0) continue;
    out.push({ day, name, surface: signalSurface(r.scope_id), count });
  }
  return out;
}

/** Sum of a signal over the rows whose day passes `pick` (optionally one surface). */
export function sumSignal(rows: readonly SignalRow[] | null | undefined, name: SignalName, pick: (day: string) => boolean = () => true, surface?: string): number {
  let n = 0;
  for (const r of rows ?? []) if (r.name === name && pick(r.day) && (surface === undefined || r.surface === surface)) n += r.count;
  return n;
}
