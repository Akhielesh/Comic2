/**
 * When the glance sequence `q` bumps (ADR 0006 D2) — the rules that keep a night to about
 * 20–60 bumps, so watches, complications, Live Activities and pushes update only when a
 * parent would see a difference.
 *
 * | Change                                                         | Bump                        |
 * |----------------------------------------------------------------|-----------------------------|
 * | Mood rises to fussing or above; camera offline / back / none   | at once                     |
 * | Any other mood change                                          | after 15 s of stability     |
 * | Sleep phase                                                    | at once                     |
 * | dB band (`dbb`); the dB number alone never bumps               | after 30 s sustained        |
 * | Alert opened, answered or resolved; duty; soothing; talk       | at once                     |
 * | Cameras online count; picture paused / resumed                 | at once                     |
 * | Battery crossing 20 % or 10 %                                  | at once                     |
 * | Nursery renamed                                                | at once                     |
 *
 * Refinements (recorded in the ADR's WS-2 notes):
 * - Between bumps the published glance is frozen: a bump publishes a snapshot of every
 *   current fact, and pending changes are cleared because they are now shown. Same `q`,
 *   same content (only `at` differs), so an ETag on `q` is honest.
 * - The dB band has 2 dB of hysteresis around each edge, and the battery 3 points on the
 *   way up, so a fan at 55 dB or a phone hovering at 20 % doesn't flap.
 * - A resolved alert ageing out of the glance (after 30 min) waits for the next bump.
 * - Safety first: nothing here ever delays crying, fussing, an alert or a camera going
 *   offline — those are immediate whatever else is pending.
 *
 * Pure: the room (WS-9 `room/glanceState.ts`), the apps and, from Phase 4, the nursery hub
 * run the same function and must produce the same bumps on fixtures/glance/night-*.json.
 */
import { dbBand, MOOD_RANK, type DbBand, type GlanceFacts, type GlanceRoomState, type Mood } from './glance';

export const BUMP_RULES = {
  /** A non-urgent mood change must hold this long. */
  moodStableMs: 15_000,
  /** A dB band change must hold this long. */
  dbbSustainMs: 30_000,
  /** dB the level must clear a band edge by before the band moves. */
  dbHysteresis: 2,
  /** Battery edges (%): a bump when crossing either. */
  batteryEdges: [20, 10] as const,
  /** Battery points above an edge before it counts as back over it (charging). */
  batteryHysteresis: 3,
} as const;

export type BumpReason = 'start' | 'mood' | 'urgent' | 'camera' | 'sleep' | 'db' | 'alert' | 'duty' | 'soothe' | 'talk' | 'battery' | 'name';

/** Battery bucket: 2 = 20 % or more · 1 = 10–19 % · 0 = under 10 %. */
export type BatteryBucket = 0 | 1 | 2;

export interface BumpState {
  q: number;
  /** When `q` last bumped (ms). */
  at: number;
  /** The facts as published at the last bump: the glance between bumps is exactly this. */
  facts: GlanceFacts;
  /** The dB band as published (with hysteresis). */
  dbb: DbBand | null;
  /** The battery bucket as published (with hysteresis). */
  bb: BatteryBucket | null;
  /** Changes waiting out their stability window: the new value and since when it has held. */
  pend: { m?: { v: Mood; since: number }; dbb?: { v: DbBand | null; since: number } };
}

export interface BumpStep {
  state: BumpState;
  bumped: boolean;
  reasons: BumpReason[];
  /**
   * Run `nextBump` again at this time even with no news (same facts): a pending change is
   * due then. Null when nothing is pending. A room schedules it with its alarm.
   */
  recheckAt: number | null;
}

/** The first published state (a room's first sight of its facts). `lastQ`: the persisted `q`, if any. */
export function startBump(facts: GlanceFacts, now: number, lastQ = 0): BumpState {
  return { q: lastQ + 1, at: now, facts, dbb: dbBand(facts.db), bb: batteryBucket(facts.cam.bat, null), pend: {} };
}

/** The published state, ready for `composeGlance`. */
export function glanceRoomState(nid: string, s: BumpState, now: number): GlanceRoomState {
  return { nid, q: s.q, at: now, facts: s.facts, dbb: s.dbb };
}

const offlineish = (m: Mood): boolean => m === 'offline' || m === 'unknown';

/** The dB band of `db`, moving off `prev` only once the level clears the edge by `dbHysteresis`. */
export function dbBandFrom(db: number | null | undefined, prev: DbBand | null): DbBand | null {
  const raw = dbBand(db);
  if (raw == null || prev == null || raw === prev) return raw;
  const h = BUMP_RULES.dbHysteresis;
  return raw > prev ? (Math.max(prev, dbBand(db! - h)!) as DbBand) : (Math.min(prev, dbBand(db! + h)!) as DbBand);
}

/** The battery bucket of `bat`: down at once when crossing an edge, back up only `batteryHysteresis` points above it. */
export function batteryBucket(bat: number | null | undefined, prev: BatteryBucket | null): BatteryBucket | null {
  if (bat == null || !Number.isFinite(bat)) return null;
  const [hi, lo] = BUMP_RULES.batteryEdges;
  const of = (b: number): BatteryBucket => (b >= hi ? 2 : b >= lo ? 1 : 0);
  const raw = of(bat);
  if (prev == null || raw <= prev) return raw;
  return Math.max(prev, of(bat - BUMP_RULES.batteryHysteresis)) as BatteryBucket;
}

const alertKey = (a: GlanceFacts['al']): string => (a ? `${a.id}|${a.st}|${a.by ?? ''}` : '');
const dutyKey = (d: GlanceFacts['du']): string => (d ? `${d.uid}|${d.u}|${d.nm}` : '');

/**
 * One step: the published state `prev`, the facts now, the time now. Returns the new state,
 * whether `q` bumped (send `{t:'glance'}` frames and pushes then), why, and when to look again.
 */
export function nextBump(prev: BumpState, next: GlanceFacts, now: number): BumpStep {
  const shown = prev.facts;
  const reasons: BumpReason[] = [];
  const pend: BumpState['pend'] = {};

  if (next.nm !== shown.nm) reasons.push('name');
  if (next.cam.on !== shown.cam.on || (next.cam.pz ?? null) !== (shown.cam.pz ?? null)) reasons.push('camera');

  if (next.m !== shown.m) {
    const urgent = offlineish(next.m) || offlineish(shown.m) || (MOOD_RANK[next.m] >= MOOD_RANK.fussing && MOOD_RANK[next.m] > MOOD_RANK[shown.m]);
    if (urgent) reasons.push('urgent');
    else {
      const was = prev.pend.m;
      const since = was && was.v === next.m ? was.since : Number.isFinite(next.ms) ? Math.min(next.ms, now) : now;
      pend.m = { v: next.m, since };
      if (now - since >= BUMP_RULES.moodStableMs) reasons.push('mood');
    }
  }

  if ((next.sl?.p ?? null) !== (shown.sl?.p ?? null)) reasons.push('sleep');

  const dbb = dbBandFrom(next.db, prev.dbb);
  if (dbb !== prev.dbb) {
    const was = prev.pend.dbb;
    const since = was && was.v === dbb ? was.since : now;
    pend.dbb = { v: dbb, since };
    if (now - since >= BUMP_RULES.dbbSustainMs) reasons.push('db');
  }

  if (alertKey(next.al) !== alertKey(shown.al)) {
    // A resolved alert ageing out (→ none) is the only quiet change; anything else is news.
    const agedOut = !next.al && shown.al?.st === 'resolved';
    if (!agedOut) reasons.push('alert');
  }
  if (dutyKey(next.du) !== dutyKey(shown.du)) reasons.push('duty');
  if ((next.so ?? null) !== (shown.so ?? null)) reasons.push('soothe');
  if ((next.tk ?? null) !== (shown.tk ?? null)) reasons.push('talk');

  const bb = batteryBucket(next.cam.bat, prev.bb);
  // Battery appearing or disappearing comes with a camera change; only a crossing bumps.
  if (bb != null && prev.bb != null && bb !== prev.bb) reasons.push('battery');

  if (reasons.length) {
    return {
      state: { q: prev.q + 1, at: now, facts: next, dbb, bb, pend: {} },
      bumped: true,
      reasons,
      recheckAt: null,
    };
  }
  const due = [pend.m ? pend.m.since + BUMP_RULES.moodStableMs : Infinity, pend.dbb ? pend.dbb.since + BUMP_RULES.dbbSustainMs : Infinity];
  const recheckAt = Math.min(...due);
  return {
    // The battery bucket follows quietly (e.g. 55 % → 40 %: same bucket, nothing to show).
    state: { ...prev, bb: bb ?? prev.bb, pend },
    bumped: false,
    reasons,
    recheckAt: Number.isFinite(recheckAt) ? recheckAt : null,
  };
}

/* ----------------------------------------------------------------- replay */

/** A change to the facts: top-level fields replace; `cam` is merged field by field. */
export type FactsPatch = Partial<Omit<GlanceFacts, 'cam'>> & { cam?: Partial<GlanceFacts['cam']> };

export function applyFactsPatch(f: GlanceFacts, p: FactsPatch): GlanceFacts {
  const { cam, ...rest } = p;
  return { ...f, ...rest, cam: cam ? { ...f.cam, ...cam } : f.cam };
}

export interface ReplayBump {
  /** Time (ms). */
  t: number;
  q: number;
  reasons: BumpReason[];
}

/**
 * Replay a recorded night: `observations` are `[ms since t0, patch]` in time order. Every
 * observation runs `nextBump`; so does every `recheckAt` that falls before the next one —
 * exactly what a room does with its alarm. Returns every bump.
 */
export function replayObservations(t0: number, initial: GlanceFacts, observations: readonly (readonly [number, FactsPatch])[], endMs?: number): { bumps: ReplayBump[]; state: BumpState } {
  let facts = initial;
  let state = startBump(facts, t0);
  const bumps: ReplayBump[] = [{ t: t0, q: state.q, reasons: ['start'] }];
  let recheck: number | null = null;
  const step = (t: number) => {
    const r = nextBump(state, facts, t);
    state = r.state;
    // A re-check is always later than now; the guard only keeps a faulty port from looping.
    recheck = r.recheckAt != null && r.recheckAt > t ? r.recheckAt : null;
    if (r.bumped) bumps.push({ t, q: state.q, reasons: r.reasons });
  };
  const until = (t: number) => {
    while (recheck != null && recheck <= t) step(recheck);
  };
  for (const [dt, patch] of observations) {
    const t = t0 + dt;
    until(t);
    facts = applyFactsPatch(facts, patch);
    step(t);
  }
  if (endMs != null) until(t0 + endMs);
  return { bumps, state };
}
