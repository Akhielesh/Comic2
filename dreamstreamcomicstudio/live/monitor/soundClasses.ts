/**
 * The baby monitor's sound vocabulary: what the nursery camera listens for,
 * how each category is scored from YAMNet's 521 AudioSet classes, and how the
 * family's devices present it (label, icon, colour, alert behaviour).
 *
 * Shared by the camera (scoring + events) and viewers (alerts + log), so both
 * sides always agree on names and severities.
 */

export type SoundCat =
  | 'cry'
  | 'fuss'
  | 'cough'
  | 'babble'
  | 'laugh'
  | 'voices'
  | 'music'
  | 'alarm'
  | 'crash'
  | 'loud'
  | 'dog';

/** Context classes that never alert but explain the room (and raise the floor). */
export type ContextCat = 'ambient' | 'silence';

/** How urgent a category is for the family. */
export type Severity = 'urgent' | 'high' | 'medium' | 'info';

export interface SoundCatInfo {
  label: string;
  /** Log/alert headline; {baby} is replaced with the baby's name. */
  headline: string;
  icon: string;
  /** CSS tone used by chips, glow and timeline. */
  tone: 'red' | 'amber' | 'blue' | 'green' | 'violet' | 'neutral';
  severity: Severity;
  /** Default: does this category alert (sound/vibrate/push) on viewers? */
  alertByDefault: boolean;
  /** Seconds the sound must persist before it becomes an event. */
  minSecs: number;
  /** Minimum minutes between two logged events of this category. */
  gapMin: number;
}

export const SOUND_CATS: SoundCat[] = ['cry', 'fuss', 'cough', 'alarm', 'crash', 'loud', 'babble', 'laugh', 'voices', 'music', 'dog'];

export const SOUND_INFO: Record<SoundCat, SoundCatInfo> = {
  cry: { label: 'Crying', headline: '{baby} is crying', icon: 'baby', tone: 'red', severity: 'high', alertByDefault: true, minSecs: 2, gapMin: 0 },
  fuss: { label: 'Fussing', headline: '{baby} is fussing', icon: 'baby', tone: 'amber', severity: 'medium', alertByDefault: false, minSecs: 6, gapMin: 5 },
  cough: { label: 'Coughing', headline: '{baby} is coughing', icon: 'wind', tone: 'amber', severity: 'medium', alertByDefault: true, minSecs: 1, gapMin: 3 },
  alarm: { label: 'Alarm (smoke / CO)', headline: 'Alarm sounding in the nursery — check for smoke or CO', icon: 'siren', tone: 'red', severity: 'urgent', alertByDefault: true, minSecs: 2, gapMin: 2 },
  crash: { label: 'Bang / crash', headline: 'Loud bang or crash in the nursery', icon: 'zap', tone: 'amber', severity: 'medium', alertByDefault: true, minSecs: 0, gapMin: 5 },
  loud: { label: 'Loud sound', headline: 'Loud sound in the nursery', icon: 'volume', tone: 'amber', severity: 'medium', alertByDefault: false, minSecs: 1, gapMin: 10 },
  babble: { label: 'Babbling', headline: '{baby} is awake and babbling', icon: 'smile', tone: 'blue', severity: 'info', alertByDefault: false, minSecs: 4, gapMin: 20 },
  laugh: { label: 'Laughing', headline: '{baby} is laughing', icon: 'smile', tone: 'green', severity: 'info', alertByDefault: false, minSecs: 1, gapMin: 20 },
  voices: { label: 'Voices', headline: 'Someone is talking in the nursery', icon: 'users', tone: 'violet', severity: 'info', alertByDefault: false, minSecs: 5, gapMin: 30 },
  music: { label: 'Music / TV', headline: 'Music or TV playing in the nursery', icon: 'music', tone: 'neutral', severity: 'info', alertByDefault: false, minSecs: 8, gapMin: 60 },
  dog: { label: 'Dog barking', headline: 'Dog barking near the nursery', icon: 'volume', tone: 'neutral', severity: 'info', alertByDefault: false, minSecs: 1, gapMin: 15 },
};

export function soundHeadline(cat: SoundCat, baby: string | null | undefined): string {
  return SOUND_INFO[cat].headline.replace('{baby}', (baby || '').trim() || 'Baby');
}

/* ------------------------------------------------------- YAMNet mapping */

/** [YAMNet class index, weight] — score = max(weight × class score). */
const MAP: Record<SoundCat | ContextCat, [number, number][]> = {
  // 20 "Baby cry, infant cry", 19 "Crying, sobbing", 11 "Screaming", 22 "Wail, moan"
  cry: [[20, 1], [19, 0.9], [11, 0.7], [22, 0.6]],
  // 21 "Whimper", 22 "Wail, moan", 33 "Groan"
  fuss: [[21, 1], [22, 0.5], [33, 0.4]],
  // 42 "Cough"
  cough: [[42, 1]],
  // 4 "Babbling", 1 "Child speech", 29 "Child singing"
  babble: [[4, 1], [1, 0.75], [29, 0.5]],
  // 14 "Baby laughter", 15 "Giggle", 13 "Laughter", 17 "Belly laugh"
  laugh: [[14, 1], [15, 0.9], [13, 0.75], [17, 0.6]],
  // 0 "Speech", 2 "Conversation", 3 "Narration", 12 "Whispering"
  voices: [[0, 1], [2, 0.9], [3, 0.8], [12, 0.7]],
  // 132 "Music", 518 "Television", 519 "Radio", 247 "Music for children", 24 "Singing"
  music: [[132, 1], [518, 0.9], [519, 0.9], [247, 0.9], [24, 0.7]],
  // 393 "Smoke detector", 394 "Fire alarm"; the generic 382 "Alarm" / 392 "Buzzer"
  // are down-weighted because street sirens and alarm clocks light them up too.
  alarm: [[393, 1], [394, 1], [382, 0.25], [392, 0.2]],
  // 463 "Smash, crash", 437 "Shatter", 460 "Bang", 454 "Thump, thud", 352 "Slam", 435 "Glass"
  crash: [[463, 1], [437, 1], [460, 0.9], [454, 0.8], [352, 0.8], [435, 0.5]],
  // 70 "Bark", 69 "Dog"
  dog: [[70, 1], [69, 0.8]],
  // Energy-based (no model class): a sustained loud sound nothing else explains.
  loud: [],
  // Benign background the model can name — explains a loud room without alarming anyone:
  // white/pink noise, static, fan, A/C, hum, rain, stream, ocean, traffic, sirens outside,
  // kitchen & bathroom appliances, vacuum, hair dryer, and a soothing heartbeat track.
  ambient: [
    [514, 1], [515, 1], [509, 0.8], [406, 0.8], [407, 0.8], [490, 0.5],
    [283, 1], [284, 0.9], [285, 1], [286, 0.9], [288, 0.9], [289, 0.9], [321, 0.9],
    [390, 1], [317, 1], [318, 1], [319, 1],
    [361, 0.9], [362, 0.9], [363, 0.9], [364, 0.9], [367, 0.9], [368, 0.9], [371, 1], [59, 0.8],
  ],
  // 494 "Silence"
  silence: [[494, 1]],
};

export const YAMNET_CLASSES = 521;

export type CatScores = Record<SoundCat | ContextCat, number>;

/** Collapse one YAMNet output row (521 sigmoid scores) into our categories. */
export function scoreRow(row: ArrayLike<number>): CatScores {
  const out = {} as CatScores;
  for (const [cat, pairs] of Object.entries(MAP) as [SoundCat | ContextCat, [number, number][]][]) {
    let best = 0;
    for (const [i, w] of pairs) {
      const v = (row[i] ?? 0) * w;
      if (v > best) best = v;
    }
    out[cat] = best;
  }
  return out;
}

/** Max over several rows (YAMNet emits one row per 0.48 s hop). */
export function scoreRows(scores: ArrayLike<number>, rows: number): CatScores {
  let acc: CatScores | null = null;
  for (let r = 0; r < rows; r++) {
    const row = Array.prototype.slice.call(scores, r * YAMNET_CLASSES, (r + 1) * YAMNET_CLASSES) as number[];
    const s = scoreRow(row);
    if (!acc) acc = s;
    else for (const k of Object.keys(s) as (keyof CatScores)[]) acc[k] = Math.max(acc[k], s[k]);
  }
  return acc ?? scoreRow([]);
}

/* ----------------------------------------------------------- thresholds */

export type Sensitivity = 'low' | 'medium' | 'high';

/**
 * Per-category "on" thresholds on the 0–1 category score, by sensitivity.
 * Tuned on ESC-50 (crying_baby / coughing / laughing vs. 14 other household
 * classes) so Medium keeps false alarms rare while catching nearly all cries.
 * The model's alarm score is only a backup — the beep-pattern detector
 * (alarmTone.ts) is the primary smoke/CO path — so alone it must be sure.
 * `loud` has no model class (energy-based), hence the unreachable 1.
 */
const ON: Record<Sensitivity, Record<SoundCat, number>> = {
  high: { cry: 0.18, fuss: 0.16, cough: 0.22, babble: 0.2, laugh: 0.22, voices: 0.5, music: 0.45, alarm: 0.45, crash: 0.3, loud: 1, dog: 0.35 },
  medium: { cry: 0.28, fuss: 0.24, cough: 0.3, babble: 0.28, laugh: 0.3, voices: 0.6, music: 0.55, alarm: 0.55, crash: 0.4, loud: 1, dog: 0.45 },
  low: { cry: 0.42, fuss: 0.36, cough: 0.42, babble: 0.38, laugh: 0.4, voices: 0.7, music: 0.65, alarm: 0.65, crash: 0.55, loud: 1, dog: 0.55 },
};

/**
 * How many of the last 3 model hops (0.48 s each) must clear "on". Cries and
 * coughing fits need 2 so a single sneeze or squeal doesn't alert; bangs and
 * barks are one-shot by nature. Measured on ESC-50 at Medium: cry 93 % caught
 * with ≤3 % false positives on 14 other household sounds; cough 63 % caught
 * (fits, not single coughs) with 0 % on breathing and 13 % on sneezes.
 */
export const HITS_NEEDED: Record<SoundCat, number> = {
  cry: 2, fuss: 2, cough: 2, babble: 2, laugh: 1, voices: 3, music: 3, alarm: 2, crash: 1, loud: 1, dog: 1,
};

export function onThreshold(cat: SoundCat, s: Sensitivity): number {
  return ON[s][cat];
}

/** Hysteresis: a category stays active until it falls below this fraction of "on". */
export const OFF_RATIO = 0.6;
