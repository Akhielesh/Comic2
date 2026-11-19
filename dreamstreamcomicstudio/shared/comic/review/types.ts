// The free whole-comic review (liveturn LT-10): what is wrong with the finished comic, where, and what fixes it. Types and
// thresholds only; the rules are in rules.ts. Every finding is free to find: no model, no network, no clock.
//
// A finding points at a place the reader can open: a line (LineRef, the same address the translation problems use:
// "page 4, panel 2, line 1") or a page and panel (PageRef). Its `fix` names the kind of help, never an op: the studio
// (LT-11) turns the free placement fixes into ops, asks the creator about the rest, and quotes every paid one first.

import type { LineRef } from '../translationProblems.js';

export type { LineRef };

/**
 * text_over_face      a balloon covers a face (or a speaker's head) the page check found
 * text_cut            the words do not fit their balloon (letter fit overflow), or it runs past the safe margin
 * balloon_overlap     a balloon still overlaps another balloon, or sits over another balloon's words
 * reading_order       a balloon (or a panel) is read out of turn, or sits outside its panel
 * tail_wrong_speaker  the tail points nearer another character's head than the speaker's
 * speaker_not_drawn   someone speaks in a panel the page check reads them as not drawn in
 * no_face_data        a lettered page checked before face checks: faces and tails cannot be checked for free
 * beats_out_of_order  a drawn panel shows another panel's moment
 * open_page_finding   a finding the page check stored that nobody has marked "Looks fine"
 * low_contrast        the words and their balloon's fill are too close in brightness to read well
 * tiny_text           words lettered smaller than their own look, too small to read on a phone
 * wrong_language      a line is not written in the comic's language (script check; names and sound effects aside)
 * too_many_words      a panel carries more words than this format's budget for its size
 * continuity          the continuity ledger contradicts itself, or what a drawn page carries changed since it was drawn
 */
export type ReviewRule =
  | 'text_over_face'
  | 'text_cut'
  | 'balloon_overlap'
  | 'reading_order'
  | 'tail_wrong_speaker'
  | 'speaker_not_drawn'
  | 'no_face_data'
  | 'beats_out_of_order'
  | 'open_page_finding'
  | 'low_contrast'
  | 'tiny_text'
  | 'wrong_language'
  | 'too_many_words'
  | 'continuity';

/** Every rule, in the order a page's findings are listed. */
export const REVIEW_RULES: readonly ReviewRule[] = [
  'text_over_face',
  'text_cut',
  'balloon_overlap',
  'reading_order',
  'tail_wrong_speaker',
  'speaker_not_drawn',
  'no_face_data',
  'beats_out_of_order',
  'open_page_finding',
  'low_contrast',
  'tiny_text',
  'wrong_language',
  'too_many_words',
  'continuity'
];

/**
 * blocking  a reader cannot read it as it is (words hidden under another balloon)
 * fix       wrong on the page; a free fix or the creator's choice settles it
 * note      worth a look; style, pacing and what the free review cannot see
 */
export type ReviewSeverity = 'blocking' | 'fix' | 'note';

/**
 * free_layout   move the balloon (free placement: off a face, off another balloon, back into its turn)
 * free_fit      fit the words (widen or re-letter the balloon; free)
 * free_tail     aim the tail at the speaker (free)
 * ask           only the creator can settle it (wording, the script, a pinned balloon, a colour)
 * paid_recheck  a paid page check would measure it (quoted and approved first)
 * paid_redraw   a paid redraw would fix it (quoted and approved first)
 * null          nothing to do
 *
 * A balloon the creator pinned or locked never gets a free_* fix: it is always `ask`.
 */
export type ReviewFix = 'free_layout' | 'free_fit' | 'free_tail' | 'ask' | 'paid_recheck' | 'paid_redraw' | null;

/** A page, or a panel on it. `page` = page.n, `panel` = panel.n. */
export interface PageRef {
  pageId: string;
  page: number;
  panel?: number;
}

export interface ReviewFinding {
  /** Stable: the same finding on the same comic always has the same id ('rv_' + 8 hex), whatever else changes. */
  id: string;
  rule: ReviewRule;
  severity: ReviewSeverity;
  ref: LineRef | PageRef;
  /** Plain words naming the place ("Page 4, panel 2, line 1: …"). Never quotes the line's words and never a price. */
  text: string;
  fix: ReviewFix;
}

export interface ReviewReport {
  v: 1;
  /** Pages in the comic. */
  pages: number;
  /** Pages reviewed: the drawn ones (a page with no art has nothing to review yet). */
  checked: number;
  /** In reading order (page, panel, line), then by REVIEW_RULES. */
  findings: ReviewFinding[];
  counts: { blocking: number; fix: number; note: number };
}

/** A finding about one line (its ref is a LineRef). */
export const isLineRef = (ref: LineRef | PageRef): ref is LineRef => typeof (ref as LineRef).lineId === 'string';

/**
 * The review's thresholds, one table. Fractions are of the page (boxes) or of the reading view (px).
 *
 * faceCover        a balloon covers more than this share of a face box (8 %)
 * headFaceR        the face box synthesized around a head with no face box (lettering/place.ts uses the same 0.045)
 * tailMargin       the tail is wrong only when another head is this much nearer than the speaker's (× the speaker's distance)
 * minContrast      text / fill contrast (WCAG ratio) below this reads poorly
 * minReadPx        text under this many px at the reading width is small on a phone
 * readWidthPx      the phone the review reads on: 360 × 640 px
 * ownLookShare     a line counts as lettered smaller than its own look below this share of it
 * guidedPad        the guided reader's padding around a panel (components/comicstudio/immersive/guidedModel.ts)
 * guidedMaxZoom    the guided reader's largest zoom
 * scriptShare      share of a line's letters that must be in the comic's script (the translation check uses 0.6)
 * minForeign       fewer foreign letters than this are ignored (a name, an "OK")
 * wordsOver        a panel is over its budget above this many times the format's own textBudget
 */
export const REVIEW_LIMITS = {
  faceCover: 0.08,
  headFaceR: 0.045,
  tailMargin: 0.85,
  minContrast: 3,
  minReadPx: 11,
  readWidthPx: 360,
  readHeightPx: 640,
  ownLookShare: 0.95,
  guidedPad: 0.05,
  guidedMaxZoom: 4,
  scriptShare: 0.6,
  minForeign: 4,
  wordsOver: 1.25
} as const;
