/**
 * SoundBrain — turns everything the nursery camera hears into clean events.
 *
 * Inputs, ~10× a second:
 *  - the AI sound model's category scores (YAMNet, every 0.48 s when loaded),
 *  - the pitch/rhythm cry analyser (cryDetector.ts) — always on, and the only
 *    cry signal on devices that can't run the model,
 *  - the smoke/CO alarm beep-pattern detector (alarmTone.ts),
 *  - loudness above the room's own noise floor, and motion.
 *
 * Output: start/end events per sound category (with persistence, hysteresis,
 * loudness gating so a TV two rooms away doesn't count, priority masking so a
 * cry isn't also logged as "babbling", and per-category cooldowns), plus the
 * live mood the family sees ("Crying", "Awake & babbling", "Calm"…).
 */

import type { DetectorState } from './cryDetector';
import { HITS_NEEDED, OFF_RATIO, SOUND_CATS, SOUND_INFO, onThreshold, type CatScores, type Sensitivity, type SoundCat } from './soundClasses';

export type Mood = 'calm' | 'stirring' | 'awake' | 'noisy' | 'fussing' | 'crying';
export type Via = 'ai' | 'cry-analyser' | 'alarm-pattern' | 'loudness';

export interface BrainEvent {
  phase: 'start' | 'end';
  cat: SoundCat;
  /** 0–100. */
  conf: number;
  /** On 'end': how long it lasted. */
  secs?: number;
  via: Via;
}

export interface BrainFrame {
  /** dB above the room's adaptive noise floor. */
  level: number;
  /** The cry analyser's state. */
  heur: DetectorState;
  heurCryConf: number;
  /** The alarm beep pattern is currently matched. */
  alarmTone: boolean;
  /** 0–100 movement score from the camera. */
  motion: number;
  /** A new model result since the previous frame, if any. */
  scores?: CatScores | null;
}

export interface BrainState {
  mood: Mood;
  /** The most important sound happening now, if any. */
  sound: SoundCat | null;
  conf: number;
  /** What the model hears right now [category, 0–100], strongest first. */
  top: [SoundCat, number][];
  /** True while the AI model is feeding results. */
  ai: boolean;
}

/** How long a category must be absent before it ends. */
const HOLD_MS: Record<SoundCat, number> = {
  cry: 8000, fuss: 8000, cough: 6000, alarm: 8000, crash: 2500, loud: 3000, babble: 6000, laugh: 4000, voices: 8000, music: 12000, dog: 5000,
};

/**
 * Loudness needed (dB above the floor, peak of the last 1.5 s). A sound the
 * model recognizes but that's barely audible is in another room — not news.
 */
const MIN_LEVEL: Record<SoundCat, number> = {
  cry: 6, fuss: 5, cough: 6, alarm: 8, crash: 14, loud: 26, babble: 5, laugh: 5, voices: 6, music: 6, dog: 8,
};

const MODEL_STALE_MS = 3000;
const LOUD_HOLD_MS = 1200;
const LEVEL_WINDOW_MS = 1500;
const BABY_SOUNDS = new Set<SoundCat>(['cry', 'fuss', 'cough', 'babble', 'laugh']);
/** Ignored while a parent talks through the speaker or soothing sounds play. */
const MUTABLE = new Set<SoundCat>(['cry', 'fuss', 'cough', 'babble', 'laugh', 'voices', 'music', 'loud']);
const SEVERITY_RANK = { urgent: 4, high: 3, medium: 2, info: 1 } as const;

interface Active {
  since: number;
  peak: number;
  via: Via;
  /** Started inside the category's cooldown: tracked for mood, not announced. */
  silent: boolean;
}

export class SoundBrain {
  sensitivity: Sensitivity = 'medium';
  private hist = new Map<SoundCat, number[]>();
  private lastScores: CatScores | null = null;
  private lastScoresAt = -Infinity;
  private levels: { t: number; v: number }[] = [];
  private candSince = new Map<SoundCat, number>();
  private lastCand = new Map<SoundCat, number>();
  private active = new Map<SoundCat, Active>();
  private lastAnnounced = new Map<SoundCat, number>();
  private suppressedUntil = 0;
  private loudSince: number | null = null;
  private motion = 0;
  private heur: DetectorState = 'calm';

  /** Ignore the baby/voice categories for a while (talk-back, soothing sounds). */
  suppress(ms: number, now: number): void {
    this.suppressedUntil = Math.max(this.suppressedUntil, now + ms);
  }

  aiActive(now: number): boolean {
    return now - this.lastScoresAt < MODEL_STALE_MS;
  }

  update(f: BrainFrame, now: number): BrainEvent[] {
    this.motion = f.motion;
    this.heur = f.heur;
    this.levels.push({ t: now, v: f.level });
    while (this.levels.length && now - this.levels[0].t > LEVEL_WINDOW_MS) this.levels.shift();
    const peak = this.levels.reduce((m, l) => Math.max(m, l.v), 0);

    if (f.scores) {
      this.lastScores = f.scores;
      this.lastScoresAt = now;
      for (const cat of SOUND_CATS) {
        const h = this.hist.get(cat) ?? [];
        h.push(f.scores[cat] ?? 0);
        if (h.length > 3) h.shift();
        this.hist.set(cat, h);
      }
    }
    const ai = this.aiActive(now);
    const cand = new Map<SoundCat, { conf: number; via: Via }>();
    const maxOf = (cat: SoundCat) => Math.max(0, ...(this.hist.get(cat) ?? []));

    // 1. The AI model, with hysteresis: entering needs HITS_NEEDED hops over
    //    "on"; staying needs one hop over OFF_RATIO × "on".
    if (ai) {
      for (const cat of SOUND_CATS) {
        if (cat === 'loud') continue;
        const h = this.hist.get(cat) ?? [];
        const on = onThreshold(cat, this.sensitivity);
        const isActive = this.active.has(cat);
        const th = isActive ? on * OFF_RATIO : on;
        const need = isActive ? 1 : HITS_NEEDED[cat];
        if (h.filter((v) => v >= th).length >= need && peak >= MIN_LEVEL[cat]) {
          cand.set(cat, { conf: Math.round(Math.max(...h) * 100), via: 'ai' });
        }
      }
    }

    // 2. The cry analyser: the cry signal on its own when the model isn't
    //    running; with the model, it can confirm a borderline cry as long as
    //    the model doesn't hear adult voices or music instead.
    if (f.heur === 'crying' && !cand.has('cry')) {
      if (!ai) cand.set('cry', { conf: Math.max(55, f.heurCryConf), via: 'cry-analyser' });
      else if (maxOf('cry') >= onThreshold('cry', this.sensitivity) * 0.5 && maxOf('voices') < 0.6 && maxOf('music') < 0.5) {
        cand.set('cry', { conf: Math.max(Math.round(maxOf('cry') * 100), f.heurCryConf), via: 'cry-analyser' });
      }
    }

    // 3. Smoke / CO alarm beep pattern — independent of everything else.
    if (f.alarmTone) cand.set('alarm', { conf: 95, via: 'alarm-pattern' });

    // 4. A sustained loud sound nothing else explains. With the model running,
    //    anything it can name (rain, a vacuum, a white-noise machine, a TV…)
    //    explains the noise; without it, the analyser's "noisy" counts too.
    const explained =
      ai && this.lastScores != null && ((this.lastScores.ambient ?? 0) >= 0.25 || SOUND_CATS.some((c) => c !== 'loud' && (this.lastScores![c] ?? 0) >= 0.3));
    if (!explained && (f.level >= MIN_LEVEL.loud || (!ai && f.heur === 'noisy'))) this.loudSince ??= now;
    else this.loudSince = null;
    if (this.loudSince != null && now - this.loudSince >= LOUD_HOLD_MS && cand.size === 0) {
      cand.set('loud', { conf: Math.min(100, Math.round(40 + f.level)), via: 'loudness' });
    }

    // Talk-back / soothing sounds: the speaker is playing on purpose.
    if (now < this.suppressedUntil) for (const c of [...cand.keys()]) if (MUTABLE.has(c)) cand.delete(c);

    // Priority masking: one sound, one name. Cry-like audio (even below the
    // cry threshold) isn't also "laughing" or "a dog".
    const cryish = cand.has('cry') || (ai && maxOf('cry') >= onThreshold('cry', this.sensitivity) * 0.5);
    if (cryish) {
      for (const c of ['babble', 'laugh', 'voices', 'dog'] as SoundCat[]) cand.delete(c);
      if (cand.has('cry')) cand.delete('fuss');
    }
    if (cand.has('fuss')) cand.delete('babble');
    if (cand.has('alarm')) for (const c of ['loud', 'music'] as SoundCat[]) cand.delete(c);
    if (cand.has('crash')) cand.delete('loud');

    const events: BrainEvent[] = [];
    for (const cat of SOUND_CATS) {
      const c = cand.get(cat);
      const act = this.active.get(cat);
      if (c) {
        this.lastCand.set(cat, now);
        if (!this.candSince.has(cat)) this.candSince.set(cat, now);
        if (act) {
          act.peak = Math.max(act.peak, c.conf);
          continue;
        }
        const since = this.candSince.get(cat)!;
        if (now - since < SOUND_INFO[cat].minSecs * 1000) continue;
        const cooled = now - (this.lastAnnounced.get(cat) ?? -Infinity) >= SOUND_INFO[cat].gapMin * 60_000;
        this.active.set(cat, { since, peak: c.conf, via: c.via, silent: !cooled });
        if (cooled) {
          this.lastAnnounced.set(cat, now);
          events.push({ phase: 'start', cat, conf: c.conf, via: c.via });
        }
      } else {
        this.candSince.delete(cat);
        if (act && now - (this.lastCand.get(cat) ?? now) > HOLD_MS[cat]) {
          this.active.delete(cat);
          if (!act.silent) {
            const secs = Math.max(1, Math.round(((this.lastCand.get(cat) ?? now) - act.since) / 1000));
            events.push({ phase: 'end', cat, conf: act.peak, secs, via: act.via });
          }
        }
      }
    }
    return events;
  }

  isActive(cat: SoundCat): boolean {
    return this.active.has(cat);
  }

  state(now: number): BrainState {
    const has = (c: SoundCat) => this.active.has(c);
    const mood: Mood = has('cry')
      ? 'crying'
      : has('fuss')
        ? 'fussing'
        : has('alarm') || has('crash') || has('loud') || has('music') || has('dog')
          ? 'noisy'
          : has('babble') || has('laugh')
            ? 'awake'
            : has('cough') || has('voices') || this.motion > 35 || this.heur === 'stirring'
              ? 'stirring'
              : 'calm';
    let sound: SoundCat | null = null;
    let conf = 0;
    for (const [cat, a] of this.active) {
      const better =
        !sound ||
        SEVERITY_RANK[SOUND_INFO[cat].severity] > SEVERITY_RANK[SOUND_INFO[sound].severity] ||
        (SOUND_INFO[cat].severity === SOUND_INFO[sound].severity && a.peak > conf);
      if (better) {
        sound = cat;
        conf = a.peak;
      }
    }
    const ai = this.aiActive(now);
    // "Hearing now" follows the same one-sound-one-name rule as the alerts:
    // while it's a cry, it isn't also "laughing" or "voices".
    const cryish = has('cry') || (ai && Math.max(0, ...(this.hist.get('cry') ?? [])) >= onThreshold('cry', this.sensitivity) * 0.5);
    const masked = new Set<SoundCat>(cryish ? ['laugh', 'babble', 'voices', 'dog', 'loud'] : ['loud']);
    let top: [SoundCat, number][] =
      ai && this.lastScores
        ? SOUND_CATS.filter((c) => !masked.has(c))
            .map((c) => [c, Math.round((this.lastScores![c] ?? 0) * 100)] as [SoundCat, number])
            .filter(([, v]) => v >= 10)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
        : [];
    // The sound we're alerting on always leads, at its episode peak.
    if (sound && sound !== 'loud') top = [[sound, Math.max(conf, top.find(([c]) => c === sound)?.[1] ?? 0)] as [SoundCat, number], ...top.filter(([c]) => c !== sound)].slice(0, 3);
    return { mood, sound, conf, top, ai };
  }

  /** True when one of the baby's own sounds is active (for "awake" logic). */
  babyActive(): boolean {
    for (const c of this.active.keys()) if (BABY_SOUNDS.has(c)) return true;
    return false;
  }
}
