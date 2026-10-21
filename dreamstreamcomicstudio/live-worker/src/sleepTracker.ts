/**
 * Sleep tracking from the camera's per-minute measurements — actigraphy for
 * a nursery: still + quiet minutes are sleep, sustained movement or baby
 * sounds are wakefulness.
 *
 *   idle ──(10 quiet min)──► asleep ──(3 active min)──► awake ─┐
 *     ▲    or "Down for sleep" ► settling ─(10 quiet)─┘  ▲   (10 quiet: back asleep)
 *     └────────── ended: 30 min awake, "Woke up", or camera gone 30 min ───┘
 *
 * Brief stirs (< 3 active minutes) count as sleep. Sessions under 15 minutes
 * of sleep are discarded. Pure functions: the room persists the state.
 */

export interface SleepMinute {
  m: number;
  /** Worst baby-state rank in the minute (1 calm … 5 crying), null if unknown. */
  state: number | null;
  /** Whole-picture motion 0–100. */
  motion: number | null;
  /** Motion in the crib zone (preferred when the parent marked one). */
  crib: number | null;
  /** Seconds each sound category was heard. */
  sounds: Record<string, number>;
  /** An adult was in the room. */
  visit: number;
}

export type SleepPhase = 'idle' | 'settling' | 'asleep' | 'awake';

export interface Waking {
  at: number;
  mins: number;
  cried: boolean;
}

export interface SleepSm {
  phase: SleepPhase;
  session: string | null;
  start: number | null;
  onset: number | null;
  source: 'auto' | 'manual';
  lastM: number | null;
  quietRun: number;
  quietSince: number | null;
  activeRun: number;
  activeSince: number | null;
  awakeSince: number | null;
  awakeCried: boolean;
  asleepMin: number;
  awakeMin: number;
  stretch: number;
  longest: number;
  cryMin: number;
  wakings: Waking[];
}

/** A finished session's numbers (captured before the state machine resets). */
export interface SleepStats {
  start: number | null;
  onset: number | null;
  source: 'auto' | 'manual';
  asleepMin: number;
  awakeMin: number;
  longest: number;
  cryMin: number;
  wakings: Waking[];
}

export type SleepEvent =
  | { type: 'started'; session: string; at: number; source: 'auto' | 'manual' }
  | { type: 'asleep'; session: string; at: number }
  | { type: 'woke'; session: string; at: number }
  | { type: 'resettled'; session: string; at: number; mins: number }
  | { type: 'ended'; session: string; end: number; discarded: boolean; stats: SleepStats };

export const ONSET_MIN = 10;
export const WAKE_MIN = 3;
export const END_AWAKE_MIN = 30;
export const GAP_END_MIN = 30;
export const MIN_SESSION_SLEEP = 15;
const MINUTE = 60_000;

export function newSleepSm(): SleepSm {
  return {
    phase: 'idle', session: null, start: null, onset: null, source: 'auto', lastM: null,
    quietRun: 0, quietSince: null, activeRun: 0, activeSince: null, awakeSince: null, awakeCried: false,
    asleepMin: 0, awakeMin: 0, stretch: 0, longest: 0, cryMin: 0, wakings: [],
  };
}

const BABY_SOUNDS = ['cry', 'fuss', 'babble', 'laugh'];

export function classifyMinute(x: SleepMinute): 'quiet' | 'active' | 'neutral' {
  const state = x.state ?? 1;
  const mv = x.crib ?? x.motion ?? 0;
  const baby = BABY_SOUNDS.reduce((a, k) => a + (x.sounds[k] ?? 0), 0);
  if (state >= 4 || baby >= 10 || mv >= 25 || (state >= 2 && mv >= 12)) return 'active';
  if (state <= 1 && mv < 8 && baby < 3 && !x.visit) return 'quiet';
  return 'neutral';
}

function resetSession(sm: SleepSm): void {
  Object.assign(sm, { ...newSleepSm(), lastM: sm.lastM, quietRun: sm.quietRun, quietSince: sm.quietSince });
}

/** Close the open session at `end`. */
export function endSession(sm: SleepSm, end: number): SleepEvent[] {
  if (!sm.session) return [];
  const session = sm.session;
  // The final wake-up isn't a night waking — it's the end.
  if (sm.phase === 'awake' && sm.awakeSince != null) {
    const tail = Math.max(0, Math.round((end - sm.awakeSince) / MINUTE));
    sm.awakeMin = Math.max(0, sm.awakeMin - tail);
    end = sm.awakeSince;
    if (sm.wakings.length) sm.wakings.pop();
  }
  const discarded = sm.asleepMin < MIN_SESSION_SLEEP;
  const stats: SleepStats = {
    start: sm.start, onset: sm.onset, source: sm.source, asleepMin: sm.asleepMin, awakeMin: sm.awakeMin,
    longest: Math.max(sm.longest, sm.stretch), cryMin: sm.cryMin, wakings: [...sm.wakings],
  };
  resetSession(sm);
  return [{ type: 'ended', session, end, discarded, stats }];
}

/** Parent tapped "Down for sleep": open a session now (if none). */
export function manualSleep(sm: SleepSm, at: number, id: string): SleepEvent[] {
  if (sm.session) return [];
  Object.assign(sm, { phase: 'settling', session: id, start: at, onset: null, source: 'manual', asleepMin: 0, awakeMin: 0, stretch: 0, longest: 0, cryMin: 0, wakings: [] });
  return [{ type: 'started', session: id, at, source: 'manual' }];
}

/** Parent tapped "Woke up". */
export function manualWake(sm: SleepSm, at: number): SleepEvent[] {
  if (!sm.session) return [];
  if (sm.phase === 'asleep') {
    sm.phase = 'awake';
    sm.awakeSince = at;
    sm.wakings.push({ at, mins: 0, cried: false });
  }
  return endSession(sm, at);
}

/** Feed the next minute. `newId` names a new session if one starts. */
export function stepSleep(sm: SleepSm, x: SleepMinute, newId: () => string): SleepEvent[] {
  const out: SleepEvent[] = [];
  // A long gap (camera stopped) closes the session where the data stopped,
  // and nothing from before the gap counts toward what comes after it.
  if (sm.lastM != null && x.m - sm.lastM > GAP_END_MIN * MINUTE) {
    if (sm.session) out.push(...endSession(sm, sm.lastM + MINUTE));
    sm.quietRun = 0;
    sm.quietSince = null;
    sm.activeRun = 0;
    sm.activeSince = null;
  }
  if (sm.lastM != null && x.m <= sm.lastM) return out;
  sm.lastM = x.m;

  const kind = classifyMinute(x);
  if (kind === 'quiet') {
    if (!sm.quietRun) sm.quietSince = x.m;
    sm.quietRun++;
  } else {
    sm.quietRun = 0;
    sm.quietSince = null;
  }
  if (kind === 'active') {
    if (!sm.activeRun) sm.activeSince = x.m;
    sm.activeRun++;
  }
  const cried = (x.sounds.cry ?? 0) >= 5 || (x.state ?? 1) >= 5;
  if (sm.session && cried) sm.cryMin++;

  switch (sm.phase) {
    case 'idle':
      if (sm.quietRun >= ONSET_MIN && sm.quietSince != null) {
        const id = newId();
        Object.assign(sm, { phase: 'asleep', session: id, start: sm.quietSince, onset: sm.quietSince, source: 'auto', asleepMin: ONSET_MIN, awakeMin: 0, stretch: ONSET_MIN, longest: ONSET_MIN, cryMin: 0, wakings: [] });
        out.push({ type: 'started', session: id, at: sm.quietSince, source: 'auto' }, { type: 'asleep', session: id, at: sm.quietSince });
      }
      break;
    case 'settling':
      if (sm.quietRun >= ONSET_MIN && sm.quietSince != null) {
        sm.phase = 'asleep';
        sm.onset = sm.quietSince;
        sm.asleepMin = ONSET_MIN;
        sm.stretch = ONSET_MIN;
        sm.longest = ONSET_MIN;
        out.push({ type: 'asleep', session: sm.session!, at: sm.quietSince });
      }
      break;
    case 'asleep':
      if (kind === 'active') {
        if (sm.activeRun >= WAKE_MIN && sm.activeSince != null) {
          // Woke: the active minutes so far were awake, not asleep.
          sm.phase = 'awake';
          sm.awakeSince = sm.activeSince;
          sm.awakeCried = cried;
          sm.asleepMin = Math.max(0, sm.asleepMin - (WAKE_MIN - 1));
          sm.stretch = Math.max(0, sm.stretch - (WAKE_MIN - 1));
          sm.longest = Math.max(sm.longest, sm.stretch);
          sm.awakeMin += WAKE_MIN;
          sm.stretch = 0;
          sm.wakings.push({ at: sm.activeSince, mins: 0, cried });
          out.push({ type: 'woke', session: sm.session!, at: sm.activeSince });
        } else {
          sm.asleepMin++;
          sm.stretch++;
        }
      } else {
        sm.activeRun = 0;
        sm.activeSince = null;
        sm.asleepMin++;
        sm.stretch++;
        sm.longest = Math.max(sm.longest, sm.stretch);
      }
      break;
    case 'awake': {
      sm.awakeMin++;
      if (cried) sm.awakeCried = true;
      const w = sm.wakings[sm.wakings.length - 1];
      if (w) {
        w.mins = Math.round((x.m + MINUTE - (sm.awakeSince ?? x.m)) / MINUTE);
        w.cried ||= cried;
      }
      if (sm.quietRun >= ONSET_MIN && sm.quietSince != null) {
        // Back to sleep: the quiet minutes were sleep after all.
        sm.phase = 'asleep';
        sm.awakeMin = Math.max(0, sm.awakeMin - ONSET_MIN);
        sm.asleepMin += ONSET_MIN;
        sm.stretch = ONSET_MIN;
        sm.longest = Math.max(sm.longest, sm.stretch);
        if (w) w.mins = Math.max(1, Math.round((sm.quietSince - (sm.awakeSince ?? sm.quietSince)) / MINUTE));
        const mins = w?.mins ?? 0;
        sm.activeRun = 0;
        sm.activeSince = null;
        sm.awakeSince = null;
        out.push({ type: 'resettled', session: sm.session!, at: sm.quietSince, mins });
      } else if (sm.awakeSince != null && x.m + MINUTE - sm.awakeSince >= END_AWAKE_MIN * MINUTE) {
        out.push(...endSession(sm, x.m + MINUTE));
      }
      break;
    }
  }
  if (kind !== 'active' && sm.phase !== 'awake') {
    sm.activeRun = 0;
    sm.activeSince = null;
  }
  return out;
}

/** Night or nap, from where the session started in the nursery's day. */
export function sessionKind(startLocalHour: number, asleepMin: number): 'night' | 'nap' {
  if (asleepMin >= 240) return 'night';
  return startLocalHour >= 18 || startLocalHour < 5 ? 'night' : 'nap';
}
