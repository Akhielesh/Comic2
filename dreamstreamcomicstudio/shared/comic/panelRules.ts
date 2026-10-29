// Panel-count and panel-size rules for page plans (plan §4.1, §5.1): fewer, larger panels so the art and the
// words both have room. Pure and dependency-free (types only), shared by the writer prompt and validator, the
// page-plan check, the breakdown card, the editor and the director, so every surface states the same numbers.
//
// The owner's provisional defaults (iter2 decisions PD-1, PD-2) each sit behind one named constant in
// PLAN_POLICY, so changing one is a one-line edit.

import type { ComicKind, Format, Panel, ShotType } from './doc.js';

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

const SPOKEN_OR_CAPTION = (kind: string) => kind !== 'sfx';
const wordsIn = (text: string) => (String(text || '').match(/\S+/g) || []).length;

/** Words a panel carries in balloons and captions (sound effects excluded). */
export const panelWords = (panel: Pick<Panel, 'lines'>): number =>
  (panel.lines || []).filter((l) => SPOKEN_OR_CAPTION(l.kind)).reduce((n, l) => n + wordsIn(l.text), 0);

/** Lettered words on a page (balloons and captions). */
export const pageWords = (panels: Pick<Panel, 'lines'>[]): number => panels.reduce((n, p) => n + panelWords(p), 0);

/**
 * The smallest area (page fraction) a panel should get: a silent insert, reaction or close-up may be small
 * (minInsertArea); anything with dialogue, captions or a wider shot needs minArea.
 */
export function minAreaFor(panel: Pick<Panel, 'shot' | 'lines'>): number {
  return SMALL_OK_SHOTS.has(panel.shot) && panelWords(panel) === 0 ? PANEL_LIMITS.minInsertArea : PANEL_LIMITS.minArea;
}

/**
 * Is a panel count allowed for this format? Auto pages: 2–4, or 5 for a fast sequence with ≤ 12 words; a single
 * panel is a splash (the splash rule applies). Explicit counts: at most the chosen number.
 */
export function panelCountProblem(
  format: Pick<Format, 'kind' | 'panelsPerPage'>,
  panels: Pick<Panel, 'lines'>[]
): { max: number; words: number; rule: PanelCountRule } | undefined {
  const rule = panelCountRule(format);
  const n = panels.length;
  if (rule.exact !== undefined) return n > rule.exact ? { max: rule.exact, words: pageWords(panels), rule } : undefined;
  if (n <= rule.max) return undefined;
  const words = pageWords(panels);
  if (rule.fast && n <= rule.fast.panels && words <= rule.fast.maxWords) return undefined;
  return { max: rule.fast && words <= rule.fast.maxWords ? rule.fast.panels : rule.max, words, rule };
}
