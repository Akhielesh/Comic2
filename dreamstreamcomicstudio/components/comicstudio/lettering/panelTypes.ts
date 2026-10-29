// Shared props of the Easy and Pro lettering panels (the inspector passes the same bundle to either).

import type { ComicDoc, Line, Page } from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import type { LetterPlan } from '../../../shared/comic/lettering/layout';
import type { PatchOptions } from '../types';
import type { Placements } from './useLetterPlans';

export interface LetteringPanelProps {
  doc: ComicDoc;
  page: Page;
  /** Selected lines (reading order). */
  lines: Line[];
  /** The page's plans (current, not drafts). */
  plans: LetterPlan[];
  placements: Placements;
  /** Page height in plan units (width is 1000). */
  H: number;
  /** Patch with undo (every lettering edit is free). */
  apply(ops: DocOp[], opts?: PatchOptions): void;
  onEditText(lineId: string): void;
  /** Send a chat message about the selection (the director answers; chat cost only). */
  onAskAI?(text: string): void;
  /** Clear the selection (after delete). */
  onDeselect(): void;
  /** The translated edition being edited (undefined in the original language): line styles stay the original's. */
  editionLang?: string;
}

/** Text colours offered everywhere (plus the comic's palette). */
export const TEXT_SWATCHES = ['#111111', '#ffffff', '#e63946', '#2a6fdb', '#2e8b57', '#6a4c93'];
/** Bubble fills offered everywhere (plus the comic's palette). */
export const FILL_SWATCHES = ['#ffffff', '#fff6c8', '#ffd84a', '#ffe0e9', '#d8ecff', '#111111'];
/** Outline colours. */
export const BORDER_SWATCHES = ['#111111', '#6b4f3a', '#2a6fdb', '#e63946', '#ffffff'];

/** The comic's own palette (StyleBible.palette) so lettering colours match the art. */
export const paletteOf = (doc: ComicDoc): string[] => {
  const p = (doc.style as { palette?: unknown } | undefined)?.palette;
  return Array.isArray(p) ? p.filter((c): c is string => typeof c === 'string').slice(0, 6) : [];
};
