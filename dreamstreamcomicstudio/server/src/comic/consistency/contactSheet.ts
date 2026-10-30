// The reference board for the page check v2 and for panel fixes (pro plan §4.3 B3). STUB with fixed export names
// (K2b): B3 replaces the bodies in place and owns this file from the moment K2b merges (pro plan §10 stub rule).
//
// Seams (jobs.ts):
//   - letterPage spreads boardForCheck(...) into analyzePageRender's arguments (B3's vision.ts reads `board`);
//   - prepare() resolves a compiled `__board__` reference with boardImage(...) (null: the job is compiled again
//     without it — a board is never worth failing a paid job).
// Software-drawn, never stored, never a paid call. Both must never throw past jobs.ts (it catches anyway).

import type { ComicDoc, Page } from '../../../../shared/comic/doc.js';
import type { StudioContext } from '../types.js';

export interface BoardInput {
  doc: ComicDoc;
  page: Page;
  signal?: AbortSignal;
}

/** Extra arguments for the page check (`{ board }` once B3 builds it). STUB: none. */
export async function boardForCheck(_ctx: StudioContext, _input: BoardInput): Promise<Record<string, unknown>> {
  return {};
}

/** The board as an image reference (a data URL), or null. STUB: null. */
export async function boardImage(_ctx: StudioContext, _input: BoardInput): Promise<string | null> {
  return null;
}
