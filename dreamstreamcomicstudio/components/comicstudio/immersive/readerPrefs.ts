// Reader preferences, reading position, intro and low-power memory (contract §13.5 storage keys).
// Every storage access is wrapped: private windows and blocked storage simply don't remember.

import { DEFAULT_READER, type ComicKind, type ReaderSettings } from '../../../shared/comic/doc';
import { layoutPrefFrom, type LayoutPref } from './readerLayout';

export const PREFS_KEY = 'comicstudio.reader.prefs.v1';
export const LAYOUT_KEY = 'comicstudio.reader.mode';
export const LANG_KEY = 'comicstudio.reader.lang';
export const posKey = (docId: string) => `comicstudio.reader.pos.${docId}`;
export const introKey = (docId: string) => `comicstudio.reader.intro.${docId}`;
export const LOW_POWER_KEY = 'comicstudio.reader.lowpower';

export type Tri = 'auto' | 'on' | 'off';
export type TurnPref = 'auto' | ReaderSettings['turn'];
export const WPM_OPTIONS = [170, 210, 260] as const;
export type Wpm = (typeof WPM_OPTIONS)[number];

export interface ReaderPrefs {
  /** 'auto' follows the creator's choice (doc.reader.turn). */
  turn: TurnPref;
  /** Synthesized page-turn sound (off by default). */
  sound: boolean;
  paper: Tri;
  ambient: Tri;
  guidedOverview: Tri;
  /** Guided autoplay reading speed (Slow / Normal / Fast). */
  wpm: Wpm;
  /** Fancy page turns on low-end devices ('auto' = measured). */
  fancyTurns: Tri;
  /** In-reader "Reduce motion" (adds to the OS setting, never overrides it). */
  reduceMotion: boolean;
  /** Guided View reveals balloons one by one. */
  balloonPop: boolean;
}

export const DEFAULT_PREFS: ReaderPrefs = {
  turn: 'auto',
  sound: false,
  paper: 'auto',
  ambient: 'auto',
  guidedOverview: 'auto',
  wpm: 210,
  fancyTurns: 'auto',
  reduceMotion: false,
  balloonPop: false
};

const store = (kind: 'local' | 'session'): Storage | null => {
  try {
    if (typeof window === 'undefined') return null;
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
};

const read = (kind: 'local' | 'session', key: string): string | null => {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

const write = (kind: 'local' | 'session', key: string, value: string | null) => {
  try {
    const s = store(kind);
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* not remembered */
  }
};

const tri = (v: unknown): Tri => (v === 'on' || v === 'off' ? v : 'auto');

/** Validate stored prefs (unknown keys and bad values fall back to the defaults). */
export const sanitizePrefs = (raw: unknown): ReaderPrefs => {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    turn: r.turn === 'paper' || r.turn === 'slide' || r.turn === 'fade' ? r.turn : 'auto',
    sound: r.sound === true,
    paper: tri(r.paper),
    ambient: tri(r.ambient),
    guidedOverview: tri(r.guidedOverview),
    wpm: (WPM_OPTIONS as readonly unknown[]).includes(r.wpm) ? (r.wpm as Wpm) : 210,
    fancyTurns: tri(r.fancyTurns),
    reduceMotion: r.reduceMotion === true,
    balloonPop: r.balloonPop === true
  };
};

export const readPrefs = (): ReaderPrefs => {
  const raw = read('local', PREFS_KEY);
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    return sanitizePrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PREFS };
  }
};

export const writePrefs = (prefs: ReaderPrefs): void => write('local', PREFS_KEY, JSON.stringify(sanitizePrefs(prefs)));

/** The layout choice shared with the inline reader ('page' is the old name of 'single'). */
export const readLayoutPref = (): LayoutPref => layoutPrefFrom(read('local', LAYOUT_KEY));
export const writeLayoutPref = (pref: LayoutPref): void =>
  write('local', LAYOUT_KEY, pref === 'auto' ? null : pref === 'single' ? 'page' : pref);

export const readReaderLang = (): string | null => read('local', LANG_KEY);
export const writeReaderLang = (lang: string): void => write('local', LANG_KEY, lang);

// ── Reading position ─────────────────────────────────────────────────────────

export interface ReadingPosition {
  /** Reader item key ('cover' or a page id). */
  key: string;
  /** Guided stop, when reading panel by panel. */
  panel?: number;
  at: number;
}

export const RESUME_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export const readPosition = (docId: string): ReadingPosition | null => {
  const raw = read('local', posKey(docId));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<ReadingPosition>;
    if (typeof p.key !== 'string' || !p.key || typeof p.at !== 'number') return null;
    return { key: p.key, at: p.at, ...(typeof p.panel === 'number' && p.panel >= 0 ? { panel: Math.round(p.panel) } : {}) };
  } catch {
    return null;
  }
};

export const writePosition = (docId: string, pos: ReadingPosition): void => write('local', posKey(docId), JSON.stringify(pos));
export const clearPosition = (docId: string): void => write('local', posKey(docId), null);

/** Offer "Continue from page N" only when it's more than one page in and under 30 days old. */
export const shouldOfferResume = (pos: ReadingPosition | null, itemIndex: number, now: number): boolean =>
  !!pos && itemIndex > 1 && now - pos.at >= 0 && now - pos.at < RESUME_MAX_AGE_MS;

// ── Session memory ───────────────────────────────────────────────────────────

/** The cover intro plays once per session per comic. */
export const introPlayed = (docId: string): boolean => read('session', introKey(docId)) === '1';
export const markIntroPlayed = (docId: string): void => write('session', introKey(docId), '1');

/** A measured slow first turn is remembered for the session. */
export const readMeasuredLowPower = (): boolean => read('session', LOW_POWER_KEY) === '1';
export const writeMeasuredLowPower = (on: boolean): void => write('session', LOW_POWER_KEY, on ? '1' : null);

// ── Effective settings ───────────────────────────────────────────────────────

export interface EffectiveReader {
  turn: ReaderSettings['turn'];
  paper: boolean;
  ambient: boolean;
  guidedOverview: boolean;
}

/** Creator settings (doc.reader) overridden locally by the viewer's prefs; paper is off for webtoon/strip. */
export const effectiveReader = (settings: ReaderSettings | undefined, prefs: ReaderPrefs, kind: ComicKind): EffectiveReader => {
  const s = settings ?? DEFAULT_READER;
  const pick = (t: Tri, base: boolean) => (t === 'on' ? true : t === 'off' ? false : base);
  return {
    turn: prefs.turn === 'auto' ? s.turn : prefs.turn,
    paper: kind === 'webtoon' || kind === 'strip' ? false : pick(prefs.paper, s.paperTexture),
    ambient: pick(prefs.ambient, s.ambient),
    guidedOverview: pick(prefs.guidedOverview, s.guidedOverview)
  };
};
