/**
 * UsageMeter — Stream Studio's in-room usage counters (ADR 0007 D2; feature doc §3.3).
 *
 * Cheap by construction:
 *   - Hot paths (a relay frame, a segment) only bump a number in memory: no `await`, no storage,
 *     never throws.
 *   - Long-lived per-socket totals ride that socket's WebSocket attachment (`a.u`), which survives
 *     hibernation and is not a storage write. A room that wakes re-derives what is still owed from
 *     the attachments: cumulative `c` minus already-written `f`.
 *   - A room can instead hand flush() a `collect` callback over totals it already keeps durably
 *     (EventRoom: segment bytes ride its existing putMeta). The watermark of what was counted is
 *     saved IN the usage row, so a flush is idempotent and can be put off without losing anything.
 *   - flush() writes AT MOST ONE storage row per object per hour — `use:YYYY-MM` — plus one
 *     Analytics Engine data point per kind (non-blocking, no storage row, skipped when the
 *     STREAM_USAGE binding is absent). The hourly bound holds across hibernation and eviction: the
 *     row's own `updatedAt` is checked before writing.
 *   - Fails open: a metering error never breaks the room, never cuts a picture, a sound or an alert.
 *   - Independent of BILLING_ENABLED and of any payment system.
 *
 * Privacy: scope ids are internal nursery / event / account UUIDs. No names, emails, IPs, SDP or
 * guest identities are ever recorded (feature doc §6).
 */

import {
  addUsage,
  compactUsage,
  dominantPath,
  emptyCounters,
  isEmptyUsage,
  maxUsage,
  monthKey,
  monthsBefore,
  prevMonthKey,
  sanitizeMonth,
  sanitizeUsage,
  subUsage,
  USAGE_KINDS,
  usageToDoubles,
  type ScalarField,
  type UsageCounters,
  type UsageDelta,
  type UsageKind,
  type UsageMonth,
  type UsageScope,
} from '../../shared/stream/usage';

export const FLUSH_EVERY_MS = 60 * 60_000;
/** Monthly rows are kept this many months (a year-on-year view), then pruned. */
export const KEEP_MONTHS = 13;
export const usageKey = (month: string) => `use:${month}`;

/** The Workers Analytics Engine binding, as much of it as the meter uses (optional everywhere). */
export interface UsageSink {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

/** The slice of Durable Object storage the meter uses (KV API). */
export interface MeterStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete?(key: string): Promise<boolean | void>;
}

/** Per-socket usage in its WebSocket attachment: cumulative `c`, already written `f`, per kind. */
export type SocketUsage = Partial<Record<UsageKind, { c: UsageDelta; f?: UsageDelta }>>;
/** Anything with a usage slot (a room's socket attachment). */
export interface UsageCarrier {
  u?: SocketUsage;
}
/** A socket's attachment plus how to save it back (serializeAttachment). */
export interface CarrierRef {
  a: UsageCarrier;
  save(): void;
}

/** The stored row: a UsageMonth plus the watermark of `collect` sources already counted. */
export interface StoredUsageRow extends UsageMonth {
  src?: unknown;
}

export interface Collected {
  /** What the durable sources added since the watermark. */
  delta: Partial<Record<UsageKind, UsageDelta>>;
  /** The new watermark (saved in the same row write). */
  src: unknown;
}

export interface FlushOptions {
  /** The nursery / event / account UUID ('' or null: nothing is written). */
  scopeId: string | null | undefined;
  /** The owning account (blob 3 in Analytics Engine): the event owner, the account itself. */
  account?: string | null;
  /** Sockets whose attachments carry usage (their unwritten part is written, then marked). */
  carriers?: CarrierRef[];
  /** Totals the room keeps durably: return what changed since `prevSrc` and the new watermark. */
  collect?: (prevSrc: unknown) => Collected | Promise<Collected>;
  /** Write even if the last write was under an hour ago (tests only; the rooms never pass it). */
  force?: boolean;
}

export type FlushResult = 'written' | 'empty' | 'too_soon' | 'no_scope' | 'error';

const kindsOf = (u: SocketUsage | undefined): UsageKind[] => (u ? USAGE_KINDS.filter((k) => u[k]) : []);

export class UsageMeter {
  private pending = new Map<UsageKind, UsageCounters>();
  /** When the row was last written (memory; null = unknown → the row itself is asked). */
  private lastWrite: number | null = null;
  readonly everyMs: number;

  constructor(
    private readonly opts: {
      storage: MeterStorage;
      sink?: UsageSink | null;
      scope: UsageScope;
      everyMs?: number;
    },
  ) {
    this.everyMs = opts.everyMs ?? FLUSH_EVERY_MS;
  }

  // ------------------------------------------------------------- hot paths (sync)
  /** +n on one scalar counter. The cheapest call there is: use it per frame / per segment. */
  bump(kind: UsageKind, field: ScalarField, n = 1): void {
    try {
      let c = this.pending.get(kind);
      if (!c) this.pending.set(kind, (c = emptyCounters()));
      if (Number.isFinite(n) && n > 0) c[field] += n;
    } catch { /* fail open */ }
  }

  /** Add a delta in memory. */
  add(kind: UsageKind, delta: UsageDelta): void {
    try {
      this.pending.set(kind, addUsage(this.pending.get(kind) ?? emptyCounters(), delta));
    } catch { /* fail open */ }
  }

  /** Add straight into a socket's attachment (the caller saves it, as it would anyway). */
  addTo(a: UsageCarrier, kind: UsageKind, delta: UsageDelta): void {
    try {
      const slot = ((a.u ??= {})[kind] ??= { c: {} });
      slot.c = compactUsage(addUsage(sanitizeUsage(slot.c), delta));
    } catch { /* fail open */ }
  }

  /**
   * A client's CUMULATIVE totals for this socket (Phase B `{t:'use'}`). Kept monotonic per field,
   * so a resent or out-of-order report never double counts. Display only — never enforcement.
   */
  report(a: UsageCarrier, kind: UsageKind, cumulative: UsageDelta): void {
    try {
      const slot = ((a.u ??= {})[kind] ??= { c: {} });
      slot.c = compactUsage(maxUsage(sanitizeUsage(slot.c), sanitizeUsage(cumulative)));
    } catch { /* fail open */ }
  }

  /** Move everything pending in memory into this attachment (so it survives hibernation). */
  stash(a: UsageCarrier): boolean {
    let moved = false;
    try {
      for (const [kind, c] of this.pending) {
        if (isEmptyUsage(c)) continue;
        this.addTo(a, kind, c);
        moved = true;
      }
      if (moved) this.pending.clear();
    } catch { /* fail open */ }
    return moved;
  }

  /** A socket is going: what it carried but nobody wrote yet goes back to memory. */
  release(a: UsageCarrier): void {
    try {
      for (const kind of kindsOf(a.u)) {
        const owed = this.owed(a, kind);
        if (!isEmptyUsage(owed)) this.add(kind, owed);
      }
      delete a.u;
    } catch { /* fail open */ }
  }

  private owed(a: UsageCarrier, kind: UsageKind): UsageCounters {
    const slot = a.u?.[kind];
    return slot ? subUsage(sanitizeUsage(slot.c), sanitizeUsage(slot.f)) : emptyCounters();
  }

  /** What memory and these sockets hold that is not written yet, per kind. */
  pendingTotals(carriers: CarrierRef[] = []): Map<UsageKind, UsageCounters> {
    const out = new Map<UsageKind, UsageCounters>();
    for (const [kind, c] of this.pending) out.set(kind, c);
    for (const { a } of carriers) {
      for (const kind of kindsOf(a.u)) out.set(kind, addUsage(out.get(kind) ?? emptyCounters(), this.owed(a, kind)));
    }
    for (const [kind, c] of out) if (isEmptyUsage(c)) out.delete(kind);
    return out;
  }

  /** May a flush write now, as far as memory knows (no I/O)? */
  due(now: number): boolean {
    return this.lastWrite == null || now - this.lastWrite >= this.everyMs;
  }

  // ------------------------------------------------------------------ flush
  /**
   * Write what is owed: one row (`use:YYYY-MM`), one Analytics Engine point per kind. At most once
   * an hour per object — a call inside the hour does nothing and costs nothing. Never throws.
   */
  async flush(now: number, opts: FlushOptions): Promise<FlushResult> {
    try {
      if (!opts.force && !this.due(now)) return 'too_soon';
      const scopeId = opts.scopeId || '';
      const carriers = opts.carriers ?? [];
      if (!scopeId) return 'no_scope';
      if (!opts.collect && this.pendingTotals(carriers).size === 0) return 'empty';

      const month = monthKey(now);
      const row = (await this.opts.storage.get<StoredUsageRow>(usageKey(month))) ?? null;
      // The row knows when it was last written, even after hibernation or eviction.
      if (!opts.force && row?.updatedAt && now - row.updatedAt < this.everyMs) {
        this.lastWrite = row.updatedAt;
        return 'too_soon';
      }

      // Durable sources: what changed since the watermark in the row (or last month's, at a rollover).
      let collected: Collected | null = null;
      if (opts.collect) {
        const prevSrc = row ? row.src : (await this.opts.storage.get<StoredUsageRow>(usageKey(prevMonthKey(month))))?.src;
        collected = await opts.collect(prevSrc ?? null);
      }

      const owed = this.pendingTotals(carriers);
      // A snapshot of memory: only what it holds now is written (and then taken off).
      const memSnap = new Map<UsageKind, UsageCounters>();
      for (const [kind, c] of this.pending) memSnap.set(kind, c);
      if (collected) for (const kind of USAGE_KINDS) if (collected.delta[kind]) owed.set(kind, addUsage(owed.get(kind) ?? emptyCounters(), collected.delta[kind]));
      for (const [kind, c] of owed) if (isEmptyUsage(c)) owed.delete(kind);
      // Nothing new (a meeting that never went live, a quiet hour): no row, no point.
      if (owed.size === 0) return 'empty';

      const base = sanitizeMonth(row) ?? { month, scope: this.opts.scope, counters: {}, updatedAt: 0 };
      const counters = { ...base.counters };
      for (const [kind, c] of owed) counters[kind] = addUsage(counters[kind] ?? emptyCounters(), c);
      const next: StoredUsageRow = { month, scope: this.opts.scope, counters: compactCounters(counters), updatedAt: now };
      if (collected) next.src = collected.src;
      await this.opts.storage.put(usageKey(month), next);
      this.lastWrite = now;

      // Written: take the snapshot off memory, and mark every socket's part as written.
      for (const [kind, c] of memSnap) {
        const left = subUsage(this.pending.get(kind) ?? emptyCounters(), c);
        if (isEmptyUsage(left)) this.pending.delete(kind);
        else this.pending.set(kind, left);
      }
      for (const ref of carriers) {
        if (!ref.a.u) continue;
        for (const kind of kindsOf(ref.a.u)) ref.a.u[kind]!.f = ref.a.u[kind]!.c;
        try {
          ref.save();
        } catch { /* closing */ }
      }

      for (const [kind, c] of owed) this.point(kind, this.opts.scope, scopeId, opts.account ?? '', c);
      return 'written';
    } catch {
      return 'error'; // fail open: the counters stay owed for the next flush
    }
  }

  /** One Analytics Engine data point right now (a call that ended). No storage. Never throws. */
  point(kind: UsageKind, scope: UsageScope, scopeId: string, account: string, c: UsageCounters): void {
    try {
      if (isEmptyUsage(c)) return;
      this.opts.sink?.writeDataPoint({ indexes: [kind], blobs: [scope, scopeId, account || '', dominantPath(c)], doubles: usageToDoubles(c) });
    } catch { /* fail open: analytics is best-effort */ }
  }

  // -------------------------------------------------------------- read path
  /** This month as written so far plus what is still owed (memory + sockets). No writes. */
  async month(now: number, carriers: CarrierRef[] = []): Promise<UsageMonth> {
    const month = monthKey(now);
    let base: UsageMonth = { month, scope: this.opts.scope, counters: {}, updatedAt: 0 };
    try {
      base = sanitizeMonth(await this.opts.storage.get(usageKey(month))) ?? base;
    } catch { /* show what memory has */ }
    const counters = { ...base.counters };
    for (const [kind, c] of this.pendingTotals(carriers)) counters[kind] = addUsage(counters[kind] ?? emptyCounters(), c);
    return { month, scope: this.opts.scope, counters, updatedAt: base.updatedAt };
  }

  /** Drop the row that just aged out (13 months). Only touches storage when that row exists. */
  async prune(now: number): Promise<boolean> {
    try {
      const old = usageKey(monthsBefore(monthKey(now), KEEP_MONTHS));
      if ((await this.opts.storage.get(old)) === undefined) return false;
      await this.opts.storage.delete?.(old);
      return true;
    } catch {
      return false;
    }
  }
}

function compactCounters(byKind: Partial<Record<UsageKind, UsageCounters>>): Partial<Record<UsageKind, UsageCounters>> {
  // Rows keep full counter shapes (sanitizeMonth reads either), minus kinds that are all zero.
  const out: Partial<Record<UsageKind, UsageCounters>> = {};
  for (const k of USAGE_KINDS) if (byKind[k] && !isEmptyUsage(byKind[k])) out[k] = byKind[k];
  return out;
}

/** A socket attachment that may run a "picture through our server since" clock (`rs`, ms). */
export interface ClockCarrier extends UsageCarrier {
  rs?: number;
}

/**
 * Start, restart or stop a socket's server-relay clock: the minutes it ran go into the socket's own
 * attachment (survives hibernation), and the clock restarts at `now` when `on`. No storage.
 */
export function relayClock(meter: UsageMeter, a: ClockCarrier, kind: UsageKind, on: boolean, now: number): void {
  if (a.rs != null && now > a.rs) meter.addTo(a, kind, { minutes: { server: (now - a.rs) / 60_000 } });
  if (on) a.rs = now;
  else delete a.rs;
}

/**
 * The sockets whose attachments carry usage, with any running relay clock brought up to `now` (on
 * a copy — saved only if the flush writes). `save(a)` persists one (serializeAttachment).
 */
export function carriersOf<A extends ClockCarrier>(meter: UsageMeter, sockets: { a: A; save(a: A): void }[], kind: UsageKind, now: number): CarrierRef[] {
  const out: CarrierRef[] = [];
  for (const s of sockets) {
    if (!s.a.u && s.a.rs == null) continue;
    const a = structuredClone(s.a);
    if (a.rs != null) relayClock(meter, a, kind, true, now);
    out.push({ a, save: () => s.save(a) });
  }
  return out;
}

/** Highest believable client media rate: 100 Mbps. */
const MAX_CLIENT_BYTES_PER_S = 12.5e6;

/**
 * A client's cumulative `{t:'use'}` report (Phase B), made believable: paths it can know (Home
 * Wi-Fi, Direct, TURN) capped at the socket's age, TURN bytes capped at 100 Mbps for that long.
 * Our-server minutes are the room's own measurement and are never taken from a client.
 */
export function clampClientReport(msg: Record<string, unknown>, socketAgeMs: number): UsageDelta {
  const ageMin = Math.max(0, socketAgeMs) / 60_000 + 1;
  const m = (msg.minutes && typeof msg.minutes === 'object' ? msg.minutes : {}) as Record<string, unknown>;
  const cap = (v: unknown, hi: number) => Math.min(hi, Math.max(0, Number.isFinite(Number(v)) ? Number(v) : 0));
  return {
    minutes: { lan: cap(m.lan, ageMin), direct: cap(m.direct, ageMin), turn: cap(m.turn, ageMin) },
    turnBytes: cap(msg.turnBytes, (Math.max(0, socketAgeMs) / 1000 + 60) * MAX_CLIENT_BYTES_PER_S),
  };
}

/**
 * Turn a finished family or direct call's record into usage, charged to the CALLER's account
 * (owner decision): minutes per participant on the path they reported. Participants who never
 * reported a path aren't counted in the path split (honest: unknown).
 */
export function callUsage(rec: { secs: number; stats?: { path: 'lan' | 'internet' | 'relay' | null }[] }): UsageCounters {
  let c = emptyCounters();
  const minutes = Math.max(0, Number(rec.secs) || 0) / 60;
  if (!(minutes > 0)) return c;
  for (const s of rec.stats ?? []) {
    const path = s.path === 'lan' ? 'lan' : s.path === 'internet' ? 'direct' : s.path === 'relay' ? 'turn' : null;
    if (path) c = addUsage(c, { minutes: { [path]: minutes } });
  }
  return c;
}
