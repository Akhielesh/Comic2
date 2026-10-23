// Page editor model (mobile.md §5.6; P2-EDITOR). Pure: no DOM, so every rule here is unit-tested and the
// page editor, its bottom toolbar and its tools sheet agree on one answer.
//
//  - editorLayoutFor(): which of the six editor layouts a window gets (phone, phone landscape, tablet
//    portrait, desktop / tablet landscape, and the two foldable postures).
//  - toolsSheetHeights() / nextToolsDetent(): the tools sheet's detents (peek = Edit with AI,
//    half = actions, quality check and versions, full = the script).
//  - editorImageWidth(): which image variant the editor stage asks for (contract §13.4 "Variants").
//  - editionViewDoc() / editionOps(): editing a translated edition. The art is shared; text edits
//    become `translation` ops and geometry becomes `edition_balloon` ops, so the source dialogue and
//    the source balloon positions are never overwritten from another language.
//  - swipeTurn(): a horizontal swipe on the editor header turns the page on phones.

import type { Balloon, BalloonGeometryOverride, ComicDoc, Line, Page } from '../../../../shared/comic/doc';
import type { DocOp } from '../../../../shared/comic/ops';
import { i18nOf, lineSourceHash, localizeDoc } from '../../../../shared/comic/i18n';
import { sameLanguage } from '../../../../shared/comic/languages';
import type { FormFactor } from '../formFactor';
import { snapDetent } from '../sheets/snap';
import { variantWidthFor } from '../media/imageVariants';

// ── Layout ───────────────────────────────────────────────────────────────────

export type EditorLayoutKind = 'phone' | 'phone-landscape' | 'tablet-portrait' | 'desktop' | 'fold-book' | 'fold-tabletop';

export interface EditorLayout {
  kind: EditorLayoutKind;
  /** Where the page tools live: a bottom sheet, a collapsible side sheet, today's aside, or the second screen. */
  tools: 'sheet' | 'side' | 'aside' | 'segment';
  /** Where Move / Mark up, undo / redo and the lettering tools live. */
  toolbar: 'bottom' | 'rail' | 'top';
  /** Width (px) of the aside or side sheet (0 for sheets and stacked segments). */
  toolsWidth: number;
  /** Edge to edge: no backdrop to tap, safe areas padded by the editor itself. */
  fullBleed: boolean;
  /** The lettering inspector is a bottom sheet (else it floats beside the selection). */
  compactInspector: boolean;
  /** The mini filmstrip sits under the stage, or at the top of the tools. */
  filmstrip: 'stage' | 'tools';
  /** Dual-segment foldables: the first segment's size and the hinge gap (px). */
  split?: { axis: 'columns' | 'rows'; first: number; gap: number };
}

type LayoutInput = Pick<FormFactor, 'width' | 'height' | 'widthClass' | 'heightClass' | 'coarse' | 'orientation' | 'segments'>;

/** Below this width the editor has no room for a backdrop (it fills the window). */
export const EDITOR_INSET_MIN_WIDTH = 1024;
/** Side sheet on landscape phones (mobile.md §5.6), aside on tablets / desktop. */
export const SIDE_SHEET_W = 320;
export const ASIDE_W = 360;
export const ASIDE_W_LARGE = 400;

export function editorLayoutFor(ff: LayoutInput): EditorLayout {
  const w = Number.isFinite(ff.width) && ff.width > 0 ? ff.width : 1024;
  const h = Number.isFinite(ff.height) && ff.height > 0 ? ff.height : 768;
  const seg = ff.segments;
  if (seg && seg.count === 2 && seg.axis) {
    const hinge = seg.hinge;
    if (seg.axis === 'horizontal') {
      // Book posture: the page on the left screen, the tools on the right one.
      const first = hinge ? Math.max(0, Math.round(hinge.start)) : Math.round(w / 2);
      const gap = hinge ? Math.max(0, Math.round(hinge.end - hinge.start)) : 0;
      return { kind: 'fold-book', tools: 'segment', toolbar: 'top', toolsWidth: Math.max(0, w - first - gap), fullBleed: true, compactInspector: false, filmstrip: 'stage', split: { axis: 'columns', first, gap } };
    }
    // Tabletop: the page on the top screen, the tools (and the mode row) on the bottom one.
    const first = hinge ? Math.max(0, Math.round(hinge.start)) : Math.round(h / 2);
    const gap = hinge ? Math.max(0, Math.round(hinge.end - hinge.start)) : 0;
    return { kind: 'fold-tabletop', tools: 'segment', toolbar: 'top', toolsWidth: 0, fullBleed: true, compactInspector: false, filmstrip: 'tools', split: { axis: 'rows', first, gap } };
  }
  if (ff.heightClass === 'compact') {
    return { kind: 'phone-landscape', tools: 'side', toolbar: 'rail', toolsWidth: SIDE_SHEET_W, fullBleed: true, compactInspector: false, filmstrip: 'tools' };
  }
  if (ff.widthClass === 'compact') {
    return { kind: 'phone', tools: 'sheet', toolbar: 'bottom', toolsWidth: 0, fullBleed: true, compactInspector: true, filmstrip: 'tools' };
  }
  const portrait = ff.orientation === 'portrait' || h > w;
  if (portrait && (w < EDITOR_INSET_MIN_WIDTH || ff.coarse)) {
    return { kind: 'tablet-portrait', tools: 'sheet', toolbar: 'top', toolsWidth: 0, fullBleed: w < EDITOR_INSET_MIN_WIDTH || ff.coarse, compactInspector: false, filmstrip: 'tools' };
  }
  return { kind: 'desktop', tools: 'aside', toolbar: 'top', toolsWidth: w >= 1200 ? ASIDE_W_LARGE : ASIDE_W, fullBleed: w < EDITOR_INSET_MIN_WIDTH, compactInspector: false, filmstrip: 'stage' };
}

// ── Tools sheet detents ──────────────────────────────────────────────────────

export type ToolsDetent = 'peek' | 'half' | 'full';
export const TOOLS_DETENTS: readonly ToolsDetent[] = ['peek', 'half', 'full'];
/** Peek shows the "Edit with AI" field and its Apply button. */
export const TOOLS_PEEK_MIN_PX = 208;

/** Sheet heights (px) for an available body height: peek ≥ 208 px (≈ 30 %), half 50 %, full = all of it. */
export function toolsSheetHeights(avail: number): Record<ToolsDetent, number> {
  const a = Math.max(0, Math.round(Number.isFinite(avail) ? avail : 0));
  const peek = Math.min(a, Math.max(TOOLS_PEEK_MIN_PX, Math.round(a * 0.3)));
  const half = Math.min(a, Math.max(peek, Math.round(a * 0.5)));
  return { peek, half, full: a };
}

/**
 * Where a released sheet drag lands: a detent, or null to close it (only when `dismissible`).
 * `velocity` is px/s, positive = moving down (shrinking).
 */
export function nextToolsDetent(h: number, velocity: number, avail: number, dismissible: boolean): ToolsDetent | null {
  const heights = toolsSheetHeights(avail);
  const order = TOOLS_DETENTS.filter((d, i) => i === 0 || heights[d] > heights[TOOLS_DETENTS[i - 1]] + 1);
  const i = snapDetent(h, velocity, order.map((d) => heights[d]), { dismissible });
  return i < 0 ? null : order[i] ?? 'peek';
}

/** The next detent for the grabber button (peek → half → full → peek). */
export const cycleToolsDetent = (d: ToolsDetent): ToolsDetent => TOOLS_DETENTS[(TOOLS_DETENTS.indexOf(d) + 1) % TOOLS_DETENTS.length];

// ── Images ───────────────────────────────────────────────────────────────────

/**
 * The CSS width to ask `urlFor` for on the editor stage, or undefined for the original:
 * ≤ 1080w on phones at fit, the original on tablets/desktop or past 1.6× zoom, 480w under saveData
 * (1080w once zoomed). The width is divided by the (capped) DPR so `variantFor` never upgrades a
 * 1080w cap to the original on a 2× screen.
 */
export function editorImageWidth(ff: Pick<FormFactor, 'widthClass' | 'heightClass' | 'saveData'>, zoom: number, pageCssWidth: number | undefined, dpr = 1): number | undefined {
  const cap = variantWidthFor('editor', ff, zoom);
  if (!cap) return undefined;
  const ratio = Math.min(2, Math.max(1, Number.isFinite(dpr) ? dpr : 1));
  const css = pageCssWidth && pageCssWidth > 0 ? Math.min(pageCssWidth, cap / ratio) : cap / ratio;
  return Math.max(1, Math.floor(css));
}

// ── Editions ─────────────────────────────────────────────────────────────────

/** Is `lang` a translated edition of this comic (not the source)? */
export const isEditionLang = (doc: ComicDoc, lang?: string | null): lang is string =>
  !!lang && !sameLanguage(lang, doc.format.language) && !!i18nOf(doc).editions[lang];

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * The doc as the `lang` edition draws — exactly what a reader and the export of that edition draw:
 * `localizeDoc` (shared/comic/i18n), which applies the edition's balloon overrides over stored source
 * balloons AND appends the edition's own positions for software-placed lines (no stored source balloon).
 * The source language (or a language with no edition) is the doc itself.
 */
export function editionViewDoc(doc: ComicDoc, lang: string): ComicDoc {
  return isEditionLang(doc, lang) ? localizeDoc(doc, lang) : doc;
}

const GEOMETRY_KEYS = ['x', 'y', 'w', 'tailX', 'tailY'] as const;
const SHARED_BALLOON_KEYS = ['z', 'locked', 'linkTo'] as const;

const findLine = (doc: ComicDoc, pageId: string, lineId: string): Line | undefined => {
  const page = doc.pages.find((p) => p.id === pageId);
  for (const panel of page?.panels || []) {
    const l = panel.lines.find((x) => x.id === lineId);
    if (l) return l;
  }
  return undefined;
};

const geometryOf = (patch: Partial<Balloon>): BalloonGeometryOverride => {
  const out: BalloonGeometryOverride = {};
  for (const k of GEOMETRY_KEYS) {
    const v = patch[k];
    if (finite(v)) out[k] = v;
  }
  if (typeof patch.pinned === 'boolean') out.pinned = patch.pinned;
  return out;
};

/**
 * The `translation` op for a typed edition text (the server forces status/at/sourceHash too). Null for a
 * "don't translate" line: every edition draws its original text, so a translation would never show.
 */
export function translationEditOp(doc: ComicDoc, lang: string, pageId: string, lineId: string, text: string, now = Date.now()): DocOp | null {
  const line = findLine(doc, pageId, lineId);
  const t = text.trim();
  if (!line || !t || line.noTranslate === true) return null;
  return { op: 'translation', lang, lineId, patch: { text: t, status: 'edited', sourceHash: lineSourceHash(line), at: now } };
}

/**
 * Rewrite lettering ops made on an edition's view so they land in that edition:
 *  - `balloon` geometry (x, y, w, tail, pinned) → `edition_balloon`; stacking / lock / link stay on the
 *    shared source balloon, but only when it is stored (otherwise the op would invent a default one);
 *  - `balloons` (Tidy on this language) → one `edition_balloon` per placed line;
 *  - `line` text → `translation`; any other `line` change (kind, speaker, delete, move) belongs to the
 *    original and is dropped (counted, so the editor can say so);
 *  - `line_style` / `letter_style` pass through: style is shared by every language.
 */
export function editionOps(ops: readonly DocOp[], lang: string, sourceDoc: ComicDoc, now = Date.now()): { ops: DocOp[]; dropped: number } {
  const out: DocOp[] = [];
  let dropped = 0;
  for (const op of ops) {
    switch (op.op) {
      case 'balloon': {
        const geo = geometryOf(op.patch || {});
        if (Object.keys(geo).length) out.push({ op: 'edition_balloon', lang, lineId: op.lineId, patch: geo });
        const shared: Partial<Balloon> = {};
        for (const k of SHARED_BALLOON_KEYS) if (op.patch && k in op.patch) (shared as Record<string, unknown>)[k] = (op.patch as Record<string, unknown>)[k];
        if (Object.keys(shared).length) {
          const stored = sourceDoc.pages.find((p) => p.id === op.pageId)?.balloons.some((b) => b.lineId === op.lineId);
          if (stored) out.push({ op: 'balloon', pageId: op.pageId, lineId: op.lineId, patch: shared });
          else dropped += 1;
        } else if (!Object.keys(geo).length) dropped += 1;
        break;
      }
      case 'balloons':
        for (const b of op.balloons) {
          const geo = geometryOf(b);
          delete geo.pinned;
          if (Object.keys(geo).length) out.push({ op: 'edition_balloon', lang, lineId: b.lineId, patch: geo });
        }
        break;
      case 'line': {
        const keys = op.patch ? Object.keys(op.patch) : [];
        if (op.patch && keys.length === 1 && keys[0] === 'text' && typeof op.patch.text === 'string') {
          const t = translationEditOp(sourceDoc, lang, op.pageId, op.id, op.patch.text, now);
          if (t) out.push(t);
          else dropped += 1;
        } else dropped += 1;
        break;
      }
      case 'line_style':
      case 'letter_style':
        out.push(op);
        break;
      default:
        dropped += 1;
    }
  }
  return { ops: out, dropped };
}

// ── Gestures ─────────────────────────────────────────────────────────────────

/** A header swipe of ≥ 60 px that is mostly horizontal turns the page: -1 = previous, 1 = next. */
export const SWIPE_TURN_PX = 60;
export function swipeTurn(dx: number, dy: number, rtl = false): -1 | 0 | 1 {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) < SWIPE_TURN_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  const dir: -1 | 1 = dx < 0 ? 1 : -1; // swipe left → next page (like turning a page)
  return rtl ? (dir === 1 ? -1 : 1) : dir;
}

// ── Selection vs. a covering sheet ───────────────────────────────────────────

/**
 * How many px of the stage a fixed bottom sheet covers (0 when it sits below the stage). Used to shrink
 * the stage while the phone lettering inspector is open, so the selected balloon is never under it.
 */
export const coveredByBottomSheet = (stageBottom: number, sheetTop: number): number =>
  Number.isFinite(stageBottom) && Number.isFinite(sheetTop) ? Math.max(0, Math.round(stageBottom - sheetTop)) : 0;

/**
 * Is a selection (viewport px) out of the visible stage? Judged by its centre, so a big balloon that
 * merely overhangs a zoomed view (the user zoomed in on it) is not "lost".
 */
export const selectionOutOfView = (sel: { top: number; bottom: number; left: number; right: number } | null, view: { top: number; bottom: number; left: number; right: number } | null): boolean => {
  if (!sel || !view) return false;
  const cx = (sel.left + sel.right) / 2;
  const cy = (sel.top + sel.bottom) / 2;
  return cx < view.left || cx > view.right || cy < view.top || cy > view.bottom;
};

/** localStorage: the one-time touch coach mark was dismissed ('1'). */
export const COACH_KEY = 'cs.coach.editor';
/** localStorage: the phone tools sheet was closed ('closed') or left open. */
export const TOOLS_SHEET_KEY = 'cs.editor.tools';

export const readFlag = (key: string): string | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
export const writeFlag = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode / blocked storage: the flag just doesn't stick */
  }
};

/** The page a header swipe turns to (sorted by n), or undefined at either end. */
export const turnTarget = (pages: readonly Page[], currentId: string, dir: -1 | 0 | 1): Page | undefined => {
  if (!dir) return undefined;
  const sorted = [...pages].sort((a, b) => a.n - b.n);
  const i = sorted.findIndex((p) => p.id === currentId);
  return i < 0 ? undefined : sorted[i + dir];
};
