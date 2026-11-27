// Reader preferences, reading position, intro and low-power memory (contract §13.5 storage keys).
// Every storage access is wrapped: private windows and blocked storage simply don't remember.

import { DEFAULT_READER, PAGE_TURN_STYLES, creatorTurnOf, type ComicKind, type PageTurnStyle, type ReaderSettings } from '../../../shared/comic/doc';
import { layoutPrefFrom, type LayoutPref } from './readerLayout';
import { PREFS_KEY, storedTurnPick } from './readerMotionPref';

export { PREFS_KEY };
export const LAYOUT_KEY = 'comicstudio.reader.mode';
export const LANG_KEY = 'comicstudio.reader.lang';
export const posKey = (docId: string) => `comicstudio.reader.pos.${docId}`;
export const introKey = (docId: string) => `comicstudio.reader.intro.${docId}`;
export const LOW_POWER_KEY = 'comicstudio.reader.lowpower';

export type Tri = 'auto' | 'on' | 'off';
export type RoomLight = 'night' | 'day';
export type TurnPref = 'auto' | PageTurnStyle;

export interface ReaderPrefs {
  /** 'auto' follows the creator's choice (doc.reader.turn, creatorTurnOf); flip, paper, slide or fade is the reader's own. */
  turn: TurnPref;
  /**
   * The reader picked `turn` in "Page turn style". Release #316's Reading mode switch wrote turn 'paper' whenever a
   * reader went back to turning pages: that was never a pick, so a stored 'paper' without this mark reads as 'auto'
   * (the creator's style, else the flip). Slide and fade could only ever be picked, so they keep without it.
   */
  turnPicked?: true;
  /** Synthesized page-turn sound (off by default). */
  sound: boolean;
  paper: Tri;
  ambient: Tri;
  room: RoomLight;
  /** Fancy page turns on low-end devices ('auto' = measured). */
  fancyTurns: Tri;
  /** In-reader "Reduce motion" (adds to the OS setting, never overrides it). */
  reduceMotion: boolean;
}

export const DEFAULT_PREFS: ReaderPrefs = {
  turn: 'auto',
  sound: false,
  paper: 'auto',
  ambient: 'auto',
  room: 'night',
  fancyTurns: 'auto',
  reduceMotion: false
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
  // The reader's own pick (storedTurnPick: an unmarked 'paper' was never one), else 'auto'.
  const turn: TurnPref = storedTurnPick(r) ?? 'auto';
  return {
    turn,
    ...(r.turnPicked === true && turn !== 'auto' ? { turnPicked: true as const } : {}),
    sound: r.sound === true,
    paper: tri(r.paper),
    ambient: tri(r.ambient),
    room: r.room === 'day' ? 'day' : 'night',
    fancyTurns: tri(r.fancyTurns),
    reduceMotion: r.reduceMotion === true
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
  at: number;
}

export const RESUME_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export const readPosition = (docId: string): ReadingPosition | null => {
  const raw = read('local', posKey(docId));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<ReadingPosition>;
    if (typeof p.key !== 'string' || !p.key || typeof p.at !== 'number') return null;
    return { key: p.key, at: p.at };
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
  turn: PageTurnStyle;
  paper: boolean;
  ambient: boolean;
}

const TURN_STYLE_WORDS: Record<PageTurnStyle, { label: string; title: string; creatorTitle?: string }> = {
  flip: { label: 'Flip', title: 'The new page swings in from the spine' },
  paper: { label: 'Paper', title: 'Drag the page and it folds like paper', creatorTitle: 'Readers drag the page and it folds like paper' },
  slide: { label: 'Slide', title: 'Pages slide across' },
  fade: { label: 'Fade', title: 'A soft crossfade' }
};
/**
 * The four page-turn styles as every picker lists them (PAGE_TURN_STYLES order, the flip first): the reader's settings
 * sheet, the creator's Reader look panel (`creatorTitle`, worded for readers of their comic) and the QA scene.
 */
export const PAGE_TURN_OPTIONS: readonly { value: PageTurnStyle; label: string; title: string; creatorTitle: string }[] = PAGE_TURN_STYLES.map((value) => {
  const w = TURN_STYLE_WORDS[value];
  return { value, label: w.label, title: w.title, creatorTitle: w.creatorTitle ?? w.title };
});
export const pageTurnLabel = (style: PageTurnStyle): string => TURN_STYLE_WORDS[style].label;

/**
 * The page-turn style a reader gets: their own explicit choice, else the creator's (creatorTurnOf: a comic that never
 * chose, including every comic that stored the old default 'paper', flips), else the flip.
 */
export const turnStyleFor = (settings: Partial<ReaderSettings> | undefined, pref: TurnPref): PageTurnStyle =>
  pref !== 'auto' ? pref : creatorTurnOf(settings);

/** Creator settings (doc.reader) overridden locally by the viewer's prefs; paper is off for webtoon/strip. */
export const effectiveReader = (settings: ReaderSettings | undefined, prefs: ReaderPrefs, kind: ComicKind): EffectiveReader => {
  const s = settings ?? DEFAULT_READER;
  const pick = (t: Tri, base: boolean) => (t === 'on' ? true : t === 'off' ? false : base);
  return {
    turn: turnStyleFor(settings, prefs.turn),
    paper: kind === 'webtoon' || kind === 'strip' ? false : pick(prefs.paper, s.paperTexture),
    ambient: pick(prefs.ambient, s.ambient)
  };
};
