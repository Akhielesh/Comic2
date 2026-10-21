/**
 * The baby tracker's shared shapes — the app's mirror of
 * live-worker/src/trackerStore.ts (which clamps every field on the way in).
 */

export type TrackKind = 'breast' | 'bottle' | 'solids' | 'pump' | 'diaper' | 'sleep' | 'growth' | 'med' | 'temp' | 'activity' | 'note';

export interface TrackItem {
  id: string;
  kind: TrackKind;
  /** epoch ms */
  start: number;
  /** epoch ms; null = a running timer (breast, pump, sleep, activity) */
  end: number | null;
  /** Display name of who logged it. */
  by: string;
  data: TrackData;
  /** 'monitor' = sleep the camera detected by itself. */
  src?: 'manual' | 'monitor';
  updated?: number;
  deleted?: boolean;
}

export type TrackData = {
  // breast: seconds per side, which side was last/current
  left?: number;
  right?: number;
  side?: 'left' | 'right';
  // bottle: millilitres + what
  ml?: number;
  milk?: 'formula' | 'breast' | 'mixed' | 'other';
  // solids: comma-separated, e.g. "avocado, oatmeal" (new ones are spotted from history)
  foods?: string;
  amount?: 'taste' | 'some' | 'most' | 'all';
  reaction?: string;
  // pump: ml per side
  mlLeft?: number;
  mlRight?: number;
  // diaper
  pee?: boolean;
  poo?: boolean;
  color?: 'yellow' | 'green' | 'brown' | 'black' | 'red' | 'white' | 'orange';
  texture?: 'runny' | 'seedy' | 'soft' | 'formed' | 'hard';
  rash?: boolean;
  /** How much was in it. */
  load?: 'small' | 'medium' | 'large';
  // sleep
  where?: 'crib' | 'bassinet' | 'arms' | 'stroller' | 'car' | 'bed' | 'other';
  /** Camera-detected sleep: wakings during the session. */
  wakings?: number;
  /** The family says it's a night sleep (true) or a nap (false); unset = by the clock. */
  night?: boolean;
  /** How well: 1 restless … 5 great. */
  quality?: 1 | 2 | 3 | 4 | 5;
  // growth (metric)
  kg?: number;
  cm?: number;
  headCm?: number;
  // medicine
  name?: string;
  dose?: number;
  unit?: 'ml' | 'mg' | 'drops' | 'tablet' | 'puff';
  everyH?: number;
  /** A dose that was due but not given — kept for the record, never counted as given. */
  skipped?: boolean;
  // temperature (°C) + method
  c?: number;
  method?: 'rectal' | 'armpit' | 'ear' | 'forehead' | 'oral';
  // activity
  type?: 'tummy' | 'bath' | 'play' | 'outdoor' | 'reading' | 'skin' | 'teeth' | 'screen' | 'other';
  note?: string;
};

export interface BabyProfile {
  /** YYYY-MM-DD */
  birth: string | null;
  sex: 'f' | 'm' | null;
}
