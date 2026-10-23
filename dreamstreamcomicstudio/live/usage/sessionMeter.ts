/**
 * SessionMeter — this device's side of Stream Studio's usage (ADR 0007 D2 source 3;
 * feature doc §3.3, Phase B1).
 *
 * It keeps, for one live session (watching a nursery, a call, a meeting):
 *   - minutes per path — Home Wi-Fi (`lan`), Direct (`direct`), our relay (`turn`), our
 *     server (`server`, the monitor's relay picture) — from the path changes the app
 *     already knows about;
 *   - TURN bytes RECEIVED on the selected candidate pair when OUR candidate is the relay.
 *     That is exactly what Cloudflare bills (edge → TURN client). They are read from the
 *     `getStats()` reports the app already takes (the monitor viewer's path check, the call
 *     mesh's quality check, the studio link's path check). The meter never asks for stats
 *     itself and starts no timer: it is fed.
 *
 * Reports (monitor viewers only — the one room that takes them) are CUMULATIVE for the current
 * socket: `{t:'use', minutes:{lan,direct,turn}, turnBytes}`. They are sent when the path
 * changes, every 15 minutes, and on `pagehide`. Path-change reports are at least a minute
 * apart (a flapping network can't flood the room). A new socket starts a new baseline, because
 * the room keeps "last reported" per socket and caps it at the socket's age
 * (live-worker/src/usageMeter.ts `clampClientReport`). Our-server minutes are never sent: the
 * room measures those itself.
 *
 * Display only — these numbers drive the Usage card and receipts. They NEVER enforce a limit,
 * never cut a picture, a sound or an alert. No names, addresses or candidates are kept: only
 * minutes and byte counts.
 */
import { STREAM_PATHS, type StreamPath } from '@/shared/stream/usage';

/** How the monitor / call / studio code names a path (live/monitor/rtc.ts `NetPath`). */
export type NetPathLike = 'lan' | 'internet' | 'relay';

export const REPORT_EVERY_MS = 15 * 60_000;
/** Path-change reports are at least this far apart; the next tick sends a held one. */
export const MIN_REPORT_GAP_MS = 60_000;

/** The app's network path → the usage path (Home Wi-Fi · Direct · our relay). */
export function streamPathOf(p: NetPathLike | null | undefined): StreamPath | null {
  return p === 'lan' ? 'lan' : p === 'internet' ? 'direct' : p === 'relay' ? 'turn' : null;
}

/**
 * One path for a call with several people: a relay if anyone connected comes through one,
 * Home Wi-Fi only if everyone connected is on it, otherwise Direct. null while nobody is
 * connected (no minutes count then).
 */
export function callPathOf(peers: readonly { state: string; path: NetPathLike | null }[]): StreamPath | null {
  const up = peers.filter((p) => p.state === 'connected');
  if (!up.length) return null;
  if (up.some((p) => p.path === 'relay')) return 'turn';
  if (up.every((p) => p.path === 'lan')) return 'lan';
  return 'direct';
}

/** The slice of an RTCStatsReport this file reads. */
export interface StatsLike {
  forEach(cb: (r: Record<string, unknown> & { type: string; id: string }) => void): void;
  get(id: string): unknown;
}

/**
 * Bytes the TURN server has sent us on the selected candidate pair — only when OUR local
 * candidate is the relay (when only the other end relays, its received bytes are billed on
 * its side, not ours). null when the pair isn't relayed locally or isn't chosen yet.
 */
export function relayBytesFromReport(report: StatsLike | RTCStatsReport): { pair: string; bytes: number } | null {
  const stats = report as unknown as StatsLike;
  try {
    let pairId: string | undefined;
    stats.forEach((r) => {
      if (r.type === 'transport' && typeof r.selectedCandidatePairId === 'string') pairId = r.selectedCandidatePairId;
    });
    let pair: (Record<string, unknown> & { id: string }) | undefined;
    stats.forEach((r) => {
      if (r.type !== 'candidate-pair') return;
      if (pairId ? r.id === pairId : r.selected === true || (r.nominated === true && r.state === 'succeeded')) pair = r;
    });
    if (!pair || typeof pair.localCandidateId !== 'string') return null;
    const local = stats.get(pair.localCandidateId) as { candidateType?: string } | undefined;
    if (local?.candidateType !== 'relay') return null;
    const bytes = Number(pair.bytesReceived);
    return Number.isFinite(bytes) && bytes >= 0 ? { pair: pair.id, bytes } : null;
  } catch {
    return null;
  }
}

export type PathMs = Record<StreamPath, number>;

export const zeroPaths = (): PathMs => ({ lan: 0, direct: 0, turn: 0, server: 0 });

/** What the meter has counted so far (all of this session, not just this socket). */
export interface SessionTotals {
  /** Milliseconds per path. */
  ms: PathMs;
  /** TURN bytes received on our own relay candidate. */
  turnBytes: number;
  /** When the meter was made. */
  startedAt: number;
}

/** The report the monitor room takes (cumulative for this socket; never our-server minutes). */
export type UseReport = {
  t: 'use';
  minutes: { lan: number; direct: number; turn: number };
  turnBytes: number;
};

export interface SessionMeterOptions {
  /** Where `{t:'use'}` reports go (the open room socket). Omit to keep the meter local. */
  send?: (msg: UseReport) => void;
  now?: () => number;
  /** Periodic report interval (15 min). */
  everyMs?: number;
  /**
   * A tick that comes this late means the page was frozen (a locked phone): the time in
   * between isn't counted for any path. Off unless set — only for callers that tick often.
   */
  maxGapMs?: number;
  /** A closed stretch of time on one path (for the device's own night ledger). */
  onSegment?: (path: StreamPath, fromMs: number, toMs: number) => void;
  /** An open stretch is closed and handed to onSegment at least this often while ticking (5 min). */
  segmentEveryMs?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export class SessionMeter {
  private path: StreamPath | null = null;
  /** Start of the open stretch on `path`. */
  private since = 0;
  private ms: PathMs = zeroPaths();
  private turn = 0;
  private readonly pairsByObj = new WeakMap<object, { pair: string; bytes: number }>();
  private readonly pairsByKey = new Map<string, { pair: string; bytes: number }>();
  /** This socket's starting point (null: no socket — nothing is sent). */
  private base: { ms: PathMs; turn: number } | null = null;
  private lastSent = '';
  private lastSentAt = 0;
  private held = false;
  private lastTick = 0;
  readonly startedAt: number;

  constructor(private readonly opts: SessionMeterOptions = {}) {
    this.startedAt = this.now();
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  get current(): StreamPath | null {
    return this.path;
  }

  /** Close the open stretch at `at` (it keeps going on the same path from there). */
  private close(at: number): void {
    if (!this.path) return;
    const d = Math.max(0, at - this.since);
    if (d > 0) {
      this.ms[this.path] += d;
      try {
        this.opts.onSegment?.(this.path, this.since, at);
      } catch { /* display only */ }
    }
    this.since = at;
  }

  /** The path media takes now (null: none — not connected, nothing flowing). */
  setPath(p: StreamPath | null): void {
    if (p === this.path) return;
    const now = this.now();
    this.close(now);
    this.path = p;
    this.since = now;
    this.lastTick = now;
    this.report('path');
  }

  /**
   * A stats report this device already took for a peer connection. `source` tells one
   * connection's counters from another's (the RTCPeerConnection itself, or a string).
   */
  observe(stats: StatsLike | RTCStatsReport, source: object | string = 'main'): void {
    const r = relayBytesFromReport(stats);
    if (!r) return;
    const last = typeof source === 'string' ? this.pairsByKey.get(source) : this.pairsByObj.get(source);
    // A new pair (an ICE restart, a new connection) starts its own count from zero.
    const delta = last && last.pair === r.pair && r.bytes >= last.bytes ? r.bytes - last.bytes : r.bytes;
    if (typeof source === 'string') this.pairsByKey.set(source, r);
    else this.pairsByObj.set(source, r);
    if (delta > 0) this.turn += delta;
  }

  /** A clock that already runs (a 5 s screen tick): periodic reports, frozen-page guard, ledger. */
  tick(): void {
    const now = this.now();
    const gap = this.opts.maxGapMs;
    if (gap && this.path && this.lastTick && now - this.lastTick > gap) {
      // Frozen in between: count up to the last tick we saw, then start again from now.
      this.close(this.lastTick);
      this.since = now;
    }
    this.lastTick = now;
    if (this.path && now - this.since >= (this.opts.segmentEveryMs ?? 5 * 60_000)) this.close(now);
    if (!this.base) return;
    if (this.held && now - this.lastSentAt >= MIN_REPORT_GAP_MS) this.report('tick');
    else if (now - this.lastSentAt >= (this.opts.everyMs ?? REPORT_EVERY_MS)) this.report('tick');
  }

  /** The page is going away (pagehide): say what we have now. */
  flush(): void {
    this.close(this.now());
    this.report('flush');
  }

  /** A new socket is up (its hello): reports start from here, because the room counts per socket. */
  connected(): void {
    const now = this.now();
    this.close(now);
    this.base = { ms: { ...this.ms }, turn: this.turn };
    this.lastSent = '';
    this.lastSentAt = now;
    this.held = false;
  }

  /** The socket dropped: nothing is sent until the next one is up. */
  disconnected(): void {
    this.base = null;
    this.held = false;
  }

  totals(): SessionTotals {
    const ms = { ...this.ms };
    if (this.path) ms[this.path] += Math.max(0, this.now() - this.since);
    return { ms, turnBytes: this.turn, startedAt: this.startedAt };
  }

  /** What the room would get now for this socket (null: no socket). */
  pending(): UseReport | null {
    if (!this.base) return null;
    const t = this.totals();
    const min = (p: StreamPath) => round2(Math.max(0, t.ms[p] - this.base!.ms[p]) / 60_000);
    return { t: 'use', minutes: { lan: min('lan'), direct: min('direct'), turn: min('turn') }, turnBytes: Math.max(0, Math.round(t.turnBytes - this.base.turn)) };
  }

  private report(why: 'path' | 'tick' | 'flush'): void {
    const send = this.opts.send;
    const msg = this.pending();
    if (!send || !msg) return;
    const now = this.now();
    const key = JSON.stringify(msg);
    // Nothing new (or nothing at all — our-server minutes are never sent): no message, and
    // nothing to hold. A path change at the very start carries no minutes yet.
    if (key === this.lastSent || (msg.turnBytes === 0 && msg.minutes.lan + msg.minutes.direct + msg.minutes.turn === 0)) {
      if (why !== 'path') {
        this.held = false;
        this.lastSentAt = now;
      }
      return;
    }
    if (why === 'path' && now - this.lastSentAt < MIN_REPORT_GAP_MS) {
      this.held = true;
      return;
    }
    try {
      send(msg);
    } catch { /* display only — never break the screen */ }
    this.lastSent = key;
    this.lastSentAt = now;
    this.held = false;
  }
}

/** Several meters' totals together (one per guest in a meeting). */
export function sumTotals(list: readonly SessionTotals[]): SessionTotals {
  const ms = zeroPaths();
  let turnBytes = 0;
  let startedAt = Infinity;
  for (const t of list) {
    for (const p of STREAM_PATHS) ms[p] += t.ms[p];
    turnBytes += t.turnBytes;
    startedAt = Math.min(startedAt, t.startedAt);
  }
  return { ms, turnBytes, startedAt: Number.isFinite(startedAt) ? startedAt : 0 };
}

/** All minutes counted (any path). */
export const totalMs = (ms: PathMs): number => STREAM_PATHS.reduce((s, p) => s + ms[p], 0);

/**
 * Wire a monitor viewer's meter to the page lifecycle: `pagehide` flushes it. Returns the
 * cleanup. (No timer: the screen's own tick drives `tick()`.)
 */
export function flushOnPageHide(meter: SessionMeter): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const on = () => meter.flush();
  window.addEventListener('pagehide', on);
  return () => window.removeEventListener('pagehide', on);
}
