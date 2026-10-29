// Panel-count and panel-size rules for page plans (plan §4.1, §5.1): fewer, larger panels so the art and the
// words both have room. Pure, shared by the writer prompt and validator, the page-plan check, the breakdown card,
// the lettering engine, the editor and the director, so every surface states the same numbers.
//
// It imports only types, languages.ts and textLayout.ts — none of which import density.ts, lettering/layout.ts or
// this file — so the lettering engine can read PANEL_LIMITS and wordBudget from here without an import cycle.
//
// The owner's provisional defaults (iter2 decisions PD-1, PD-2) each sit behind one named constant in
// PLAN_POLICY, so changing one is a one-line edit.

import type { ComicKind, Format, Panel, ShotType } from './doc.js';
import { lineLengthRule } from './languages.js';
import { graphemes } from './textLayout.js';

/**
 * The single table of plan limits. Areas are fractions of the page; fits are a panel's lettering need divided
 * by its area (density.ts). Names are the contract shared with the lettering engine (coverCap) and the UI.
 */
export const PANEL_LIMITS = {
  /** Auto pages usually plan 3 big panels. */
  autoTypical: 3,
  /** Auto pages: 2–4 panels … */
  autoMin: 2,
  autoUsualMax: 4,
  /** … and 5 only for a fast sequence with at most `fastSequenceWords` words on the whole page. */
  autoMax: 5,
  fastSequenceWords: 12,
  /** Panel counts offered in Format (the fit check still applies). */
  uiChoices: [2, 3, 4, 5, 6] as readonly number[],
  /** Storybooks: 1–3 large panels, usually 2. */
  storybookTypical: 2,
  storybookMax: 3,
  /** Webtoon segments: 2–5 full-width panels, usually 3. */
  webtoonMax: 5,
  /** Strips: one row of 3–4 panels. */
  stripMin: 3,
  stripMax: 4,
  /** Hard ceiling, kept for authors' own scripts and old docs. */
  codeMax: 9,
  /** Minimum panel area (page fraction); a silent insert, reaction or close-up may go down to minInsertArea. */
  minArea: 0.15,
  minInsertArea: 0.08,
  /** Fit states: ≤ fitRoomy roomy, ≤ fitTarget fits, ≤ fitHard tight (amber, allowed), above it overfull. */
  fitRoomy: 0.18,
  fitTarget: 0.22,
  fitHard: 0.3,
  /** Children's books are overfull sooner (larger type, early readers). */
  fitHardKids: 0.25,
  /** No panel is budgeted more than this many words, however big. */
  wordsCap: 40,
  /** Rendered balloon coverage cap per panel (lettering engine, A4). */
  coverCap: 0.3,
  coverCapKids: 0.25,
  /** At most one splash page per this many pages, never two in a row. */
  splashEvery: 4,
  /** A pov or insert panel carries at most this many lines, of at most this many words. */
  quietShotMaxLines: 1,
  quietShotMaxWords: 12
} as const;

/** Owner decisions applied as provisional defaults (one constant each). */
export const PLAN_POLICY = {
  /** PD-1: overfull pages are held back from "Render all" (free fixes + "Draw anyway"), never refused. */
  holdBackOverfull: true,
  /** PD-2: a storybook set to more than 3 panels per page plans NEW pages with at most 3 (with a note). */
  clampStorybook: true
} as const;

/** "Recurring" being: on at least this many pages and in at least this many panels (plan §3 C7). */
export const RECURRING = { minPages: 2, minPanels: 3 } as const;

/** Shots where a speaker may stay off-panel (heard, not drawn): the writer never forces them into the cast (§3 C6). */
export const OFF_PANEL_SHOTS: ReadonlySet<ShotType> = new Set<ShotType>(['pov', 'insert', 'establishing']);
/** Shots that carry at most one short line ("shot sense"). */
export const QUIET_SHOTS: ReadonlySet<ShotType> = new Set<ShotType>(['pov', 'insert']);
/** Shots that may be small (≥ minInsertArea) when silent. */
const SMALL_OK_SHOTS: ReadonlySet<ShotType> = new Set<ShotType>(['insert', 'close_up', 'extreme_close_up']);

/** How many panels a page of this format should plan. */
export interface PanelCountRule {
  /** What the writer aims for. */
  typical: number;
  min: number;
  /** Most panels allowed without a reason. */
  max: number;
  /** The author fixed the count (Format); pages should have exactly this many. */
  exact?: number;
  /** Auto only: the count allowed for a fast, near-silent sequence, and its page word limit. */
  fast?: { panels: number; maxWords: number };
  /** The format asked for more than the kind allows (storybook > 3): the number it asked for. */
  clampedFrom?: number;
}

const kindRule = (kind: ComicKind): PanelCountRule => {
  switch (kind) {
    case 'storybook':
      return { typical: PANEL_LIMITS.storybookTypical, min: 1, max: PANEL_LIMITS.storybookMax };
    case 'strip':
      return { typical: 3, min: PANEL_LIMITS.stripMin, max: PANEL_LIMITS.stripMax };
    case 'webtoon':
      return { typical: 3, min: 2, max: PANEL_LIMITS.webtoonMax };
    default:
      return {
        typical: PANEL_LIMITS.autoTypical,
        min: PANEL_LIMITS.autoMin,
        max: PANEL_LIMITS.autoUsualMax,
        fast: { panels: PANEL_LIMITS.autoMax, maxWords: PANEL_LIMITS.fastSequenceWords }
      };
  }
};

/** The panel-count rule for a format (plan §4.1 table). */
export function panelCountRule(format: Pick<Format, 'kind' | 'panelsPerPage'>): PanelCountRule {
  const ppp = format.panelsPerPage;
  if (typeof ppp === 'number' && Number.isFinite(ppp) && ppp > 0) {
    const asked = Math.min(PANEL_LIMITS.codeMax, Math.max(1, Math.round(ppp)));
    if (format.kind === 'storybook' && PLAN_POLICY.clampStorybook && asked > PANEL_LIMITS.storybookMax) {
      const n = PANEL_LIMITS.storybookMax;
      return { typical: n, min: n, max: n, exact: n, clampedFrom: asked };
    }
    return { typical: asked, min: asked, max: asked, exact: asked };
  }
  return kindRule(format.kind);
}

/** The visible note when a storybook's fixed panel count is clamped for new pages (decision 4), else undefined. */
export function panelCountNote(format: Pick<Format, 'kind' | 'panelsPerPage'>): string | undefined {
  const rule = panelCountRule(format);
  if (rule.clampedFrom === undefined) return undefined;
  return `Storybook pages hold at most ${PANEL_LIMITS.storybookMax} large panels, so new pages are planned with ${rule.exact} (your format asks for ${rule.clampedFrom}). Pages already planned keep theirs.`;
}

/**
 * Most panels a re-planned EXISTING page may keep under a fixed count. The storybook clamp is for new pages only
 * (PD-2): a page planned before it keeps up to its own count (never more than the format asks for). Otherwise the
 * rule's own limit (for auto formats, the usual maximum; the fast-sequence exception is panelCountProblem's).
 */
export function revisionPanelLimit(format: Pick<Format, 'kind' | 'panelsPerPage'>, existing?: number): number {
  const rule = panelCountRule(format);
  const limit = rule.exact ?? rule.max;
  if (rule.clampedFrom === undefined || !(typeof existing === 'number' && existing > limit)) return limit;
  return Math.min(rule.clampedFrom, Math.round(existing));
}

// ── Word budget (the speech oracle; density.ts measures, this states) ────────

/** Speech-balloon oracle used for word budgets (page fractions): a balloon costs BALLOON_BASE plus WORD_COST a word. */
export const BALLOON_BASE = 0.0029;
export const WORD_COST = 0.0014;

/**
 * Words a panel of this area holds in `balloons` balloons at the target fit:
 * ⌊(0.22·area − 0.0029·balloons) / 0.0014⌋, never below 0, capped at 40 (English words; see textBudget).
 */
export function wordBudget(area: number, balloons = 1): number {
  if (!(area > 0)) return 0;
  const b = Math.max(1, Math.round(Number.isFinite(balloons) ? balloons : 1));
  const raw = (PANEL_LIMITS.fitTarget * area - BALLOON_BASE * b) / WORD_COST;
  return Math.max(0, Math.min(PANEL_LIMITS.wordsCap, Math.floor(raw + 1e-9)));
}

// ── Text units (words, or characters for Japanese and Chinese) ───────────────

/**
 * How a language counts lettering in the plan rules: words, or characters (graphemes) for Japanese and Chinese
 * (lineLengthRule), and `k` = its per-balloon limit ÷ English's 25 words — the ratio the writer prompt scales every
 * budget and limit by, so the prompt, the validator, the card and the director state the same numbers.
 */
export interface TextUnit {
  unit: 'words' | 'chars';
  /** 'word' or 'character', for sentences. */
  noun: 'word' | 'character';
  k: number;
  /** Language the text is segmented in. */
  lang: string;
}

/** The text unit of a language (default English words, k = 1). */
export function textUnitFor(language?: string): TextUnit {
  const lang = typeof language === 'string' && language.trim() ? language.trim() : 'en';
  const rule = lineLengthRule(lang, false);
  return { unit: rule.unit, noun: rule.unit === 'chars' ? 'character' : 'word', k: rule.perLine / 25, lang };
}

const WORDS_UNIT: TextUnit = { unit: 'words', noun: 'word', k: 1, lang: 'en' };

/** "1 word", "29 words", "17 characters". */
export const unitCount = (n: number, unit: TextUnit = WORDS_UNIT): string => `${n} ${unit.noun}${n === 1 ? '' : 's'}`;

/** An English word limit in this unit (rounded, at least 1): 12 words → 19 Japanese characters. */
export const scaledLimit = (words: number, unit: TextUnit = WORDS_UNIT): number => Math.max(1, Math.round(words * unit.k));

/** What a panel of this area holds in this unit (wordBudget scaled by k, as the writer prompt states it). */
export const textBudget = (area: number, balloons = 1, unit: TextUnit = WORDS_UNIT): number => Math.floor(wordBudget(area, balloons) * unit.k + 1e-9);

const SPOKEN_OR_CAPTION = (kind: string) => kind !== 'sfx';
const wordsIn = (text: string) => (String(text || '').match(/\S+/g) || []).length;
/** Characters a line letters (whitespace excluded), as grapheme clusters. */
const charsIn = (text: string, lang: string) => graphemes(String(text || ''), lang).filter((g) => /\S/u.test(g)).length;

/** Words (or, for Japanese and Chinese, characters) in one text. */
export const countText = (text: string, unit: TextUnit = WORDS_UNIT): number => (unit.unit === 'chars' ? charsIn(text, unit.lang) : wordsIn(text));

/** Words a panel carries in balloons and captions (sound effects excluded); characters for char-unit languages. */
export const panelWords = (panel: Pick<Panel, 'lines'>, unit: TextUnit = WORDS_UNIT): number =>
  (panel.lines || []).filter((l) => SPOKEN_OR_CAPTION(l.kind)).reduce((n, l) => n + countText(l.text, unit), 0);

/** Lettered words on a page (balloons and captions), in the unit given. */
export const pageWords = (panels: Pick<Panel, 'lines'>[], unit: TextUnit = WORDS_UNIT): number => panels.reduce((n, p) => n + panelWords(p, unit), 0);

/**
 * The smallest area (page fraction) a panel should get: a silent insert, reaction or close-up may be small
 * (minInsertArea); anything with dialogue, captions or a wider shot needs minArea.
 */
export function minAreaFor(panel: Pick<Panel, 'shot' | 'lines'>): number {
  return SMALL_OK_SHOTS.has(panel.shot) && panelWords(panel) === 0 ? PANEL_LIMITS.minInsertArea : PANEL_LIMITS.minArea;
}

/**
 * Is a panel count allowed for this format? Auto pages: 2–4, or 5 for a fast sequence with ≤ 12 words (in the
 * language's unit: `fastWords`); a single panel is a splash (the splash rule applies). Explicit counts: at most the
 * chosen number — or, re-planning an existing page (`existing` = its panel count), up to revisionPanelLimit.
 */
export function panelCountProblem(
  format: Pick<Format, 'kind' | 'panelsPerPage'>,
  panels: Pick<Panel, 'lines'>[],
  opts: { unit?: TextUnit; existing?: number } = {}
): { max: number; words: number; rule: PanelCountRule; fastWords?: number } | undefined {
  const rule = panelCountRule(format);
  const unit = opts.unit ?? WORDS_UNIT;
  const n = panels.length;
  if (rule.exact !== undefined) {
    const limit = revisionPanelLimit(format, opts.existing);
    return n > limit ? { max: limit, words: pageWords(panels, unit), rule } : undefined;
  }
  if (n <= rule.max) return undefined;
  const words = pageWords(panels, unit);
  const fastWords = rule.fast ? scaledLimit(rule.fast.maxWords, unit) : undefined;
  if (rule.fast && fastWords !== undefined && n <= rule.fast.panels && words <= fastWords) return undefined;
  return { max: rule.fast && fastWords !== undefined && words <= fastWords ? rule.fast.panels : rule.max, words, rule, ...(fastWords !== undefined ? { fastWords } : {}) };
}
