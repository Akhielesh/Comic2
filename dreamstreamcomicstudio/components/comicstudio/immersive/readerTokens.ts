// Reader motion tokens (reader.md §5.1, RD-0): the JS side of `readerDesigns.css`. The CSS block on the
// reader root (`[data-reader-root]`) is the one source of truth for turn durations, riffle timing, the
// chain factor and the paper / camera / entrance curves; the turn engine, the guided camera and the cover
// intro read the COMPUTED values once per reader mount (`readReaderTokens`), and fall back to the TS
// defaults below wherever a value is missing or unreadable (tests, SSR, an old browser). A test pins the
// CSS defaults to these defaults, so the two never drift.

import { CAMERA_EASE, CHAIN_FACTOR, PAPER_EASE, TURN_MS } from './flipPhysics';

export type Bezier = readonly [number, number, number, number];

export interface ReaderMotionTokens {
  /** Paper turn, one page (ms). */
  turn: number;
  /** Paper turn across a spread (ms). */
  turnSpread: number;
  /** Hardcover board turn (ms). */
  turnBoard: number;
  /** Slide turn (strip comics, low power, the creator's "slide"). */
  turnSlide: number;
  /** Fade turn (the creator's "fade"; the reduced-motion drag). */
  turnFade: number;
  /** One riffle leaf (ms) and the stagger between leaves (ms). */
  riffleLeaf: number;
  riffleStep: number;
  /** A turn chained onto a running one plays this much faster. */
  chain: number;
  /** Paper, pans and the cover nudge. */
  easePaper: Bezier;
  /** Zoom-changing guided-camera moves. */
  easeCamera: Bezier;
  /** HUD show / hide (the skinned --ds-motion-medium). */
  hud: number;
  /** Page-edge stacks and the progress hairline (the skinned --ds-motion-slow). */
  edge: number;
  /** The cover intro's rise (ms) and its curve (--ds-ease-enter). */
  introRise: number;
  introEase: Bezier;
  /** Ambient room cross-fade (ms). */
  ambientFade: number;
  /** The guided spotlight's opacity fade, with and without reduced motion (ms). */
  spotFade: number;
  spotFadeReduced: number;
  /** The guided spotlight's room dimming (0–1). */
  spot: number;
  /** A stand-in → page swap cross-fade (ms). */
  standInSwap: number;
  /** Longest a tapped turn waits for its pages to decode before turning anyway (ms). */
  turnGate: number;
}

/** The skinned DS values the CSS builds on (Atlas: the reader root carries data-ds-skin="atlas"). */
const ATLAS_MOTION_MEDIUM = 150;
const ATLAS_MOTION_SLOW = 200;
const DS_EASE_ENTER: Bezier = [0.16, 1, 0.3, 1];

export const READER_TOKEN_DEFAULTS: ReaderMotionTokens = {
  turn: TURN_MS.single,
  turnSpread: TURN_MS.spread,
  turnBoard: TURN_MS.board,
  turnSlide: TURN_MS.slide,
  turnFade: TURN_MS.fade,
  riffleLeaf: TURN_MS.riffleLeaf,
  riffleStep: TURN_MS.riffleStagger,
  chain: CHAIN_FACTOR,
  easePaper: PAPER_EASE,
  easeCamera: CAMERA_EASE,
  hud: ATLAS_MOTION_MEDIUM,
  edge: ATLAS_MOTION_SLOW,
  introRise: 700,
  introEase: DS_EASE_ENTER,
  ambientFade: 900,
  spotFade: 220,
  spotFadeReduced: 140,
  spot: 0.78,
  standInSwap: 120,
  turnGate: 300
};

/** The CSS custom property behind each token (readerDesigns.css). */
export const READER_TOKEN_NAMES: Record<keyof ReaderMotionTokens, string> = {
  turn: '--ds-reader-turn',
  turnSpread: '--ds-reader-turn-spread',
  turnBoard: '--ds-reader-turn-board',
  turnSlide: '--ds-reader-turn-slide',
  turnFade: '--ds-reader-turn-fade',
  riffleLeaf: '--ds-reader-riffle-leaf',
  riffleStep: '--ds-reader-riffle-step',
  chain: '--ds-reader-chain',
  easePaper: '--ds-reader-ease-paper',
  easeCamera: '--ds-reader-ease-camera',
  hud: '--ds-reader-hud-motion',
  edge: '--ds-reader-edge-motion',
  introRise: '--ds-reader-intro-rise',
  introEase: '--ds-reader-intro-ease',
  ambientFade: '--ds-reader-ambient-fade',
  spotFade: '--ds-reader-spot-fade',
  spotFadeReduced: '--ds-reader-spot-fade-reduced',
  spot: '--ds-reader-spot',
  standInSwap: '--ds-reader-standin-swap',
  turnGate: '--ds-reader-turn-gate'
};

const BEZIER_KEYS = new Set<keyof ReaderMotionTokens>(['easePaper', 'easeCamera', 'introEase']);
const NUMBER_KEYS = new Set<keyof ReaderMotionTokens>(['chain', 'spot']);

/** A CSS time ("560ms", "0.42s", " 280ms ") in ms; null when it is not one. */
export const parseMs = (value: string | null | undefined): number | null => {
  const m = /^\s*(-?\d*\.?\d+)\s*(ms|s)\s*$/i.exec(value || '');
  if (!m) return null;
  const n = Number(m[1]) * (m[2].toLowerCase() === 's' ? 1000 : 1);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) / 1000 : null;
};

/** `cubic-bezier(a, b, c, d)` → its four numbers (x values clamped to CSS's 0–1); null otherwise. */
export const parseBezier = (value: string | null | undefined): Bezier | null => {
  const m = /^\s*cubic-bezier\(\s*([^)]*)\)\s*$/i.exec(value || '');
  if (!m) return null;
  const n = m[1].split(',').map((s) => Number(s.trim()));
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x)) || n[0] < 0 || n[0] > 1 || n[2] < 0 || n[2] > 1) return null;
  return [n[0], n[1], n[2], n[3]];
};

/** A plain number (the chain factor, the spotlight alpha); null otherwise. */
export const parseNumber = (value: string | null | undefined): number | null => {
  if (!value || !/^\s*-?\d*\.?\d+\s*$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** The WAAPI / CSS spelling of a curve. */
export const bezierCss = (b: Bezier): string => `cubic-bezier(${b.join(',')})`;

/**
 * Parse one raw value for a token (as getComputedStyle returns it); null when unreadable. Exposed for the
 * CSS-default test, which resolves var() chains itself.
 */
export const parseTokenValue = <K extends keyof ReaderMotionTokens>(key: K, raw: string | null | undefined): ReaderMotionTokens[K] | null => {
  if (BEZIER_KEYS.has(key)) return parseBezier(raw) as ReaderMotionTokens[K] | null;
  if (NUMBER_KEYS.has(key)) {
    const n = parseNumber(raw);
    return (n !== null && n >= 0 && n <= 1 ? n : null) as ReaderMotionTokens[K] | null;
  }
  return parseMs(raw) as ReaderMotionTokens[K] | null;
};

type StyleReader = (el: Element) => Pick<CSSStyleDeclaration, 'getPropertyValue'>;

/**
 * The reader's motion tokens as computed on `el` (custom properties inherit, so any element inside the
 * reader root works). Read once per mount: never per frame. Every value that is missing or does not parse
 * keeps its TS default.
 */
export const readReaderTokens = (el: Element | null | undefined, style?: StyleReader): ReaderMotionTokens => {
  if (!el) return READER_TOKEN_DEFAULTS;
  let cs: Pick<CSSStyleDeclaration, 'getPropertyValue'> | null = null;
  try {
    cs = style ? style(el) : typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
  } catch {
    cs = null;
  }
  if (!cs) return READER_TOKEN_DEFAULTS;
  const out = { ...READER_TOKEN_DEFAULTS } as Record<keyof ReaderMotionTokens, unknown>;
  for (const key of Object.keys(READER_TOKEN_NAMES) as (keyof ReaderMotionTokens)[]) {
    let raw = '';
    try {
      raw = cs.getPropertyValue(READER_TOKEN_NAMES[key]);
    } catch {
      raw = '';
    }
    const v = parseTokenValue(key, raw);
    if (v !== null) out[key] = v;
  }
  return out as unknown as ReaderMotionTokens;
};
