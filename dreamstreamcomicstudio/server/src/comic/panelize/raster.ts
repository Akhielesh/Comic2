// Raster work for one-panel fixes, region edits and flattening (pro plan §4.4 B8). STUB with fixed export names (K2b):
// B8 replaces the bodies in place and owns this file from the moment K2b merges (pro plan §10 stub rule). Every body
// is a no-op that keeps today's behaviour:
//   - cropForPanel → null: no `__panel__` reference can be made (a fix_panel job fails before any spend);
//   - pasteIntoCut → null: nothing is pasted (a fix_panel result is never stored as a page);
//   - pasteRegion → the model's whole image, as edit_page stores it today;
//   - bakeComposition → null.
// All of them run inside withSharpSlot once real; jobs.ts never lets one fail or hang a paid run without saying so.

import type { Box } from '../../../../shared/comic/doc.js';

/** Context kept around a panel's cut when it is cropped for a fix (pro plan §4.4: cut + 4%). */
export const PANEL_CROP_CONTEXT = 0.04;
/** Feather of a region paste-back (pro plan §4.4: 2%). */
export const REGION_FEATHER = 0.02;

export interface PanelCropInput {
  /** The page's current drawing. */
  dataUrl: string;
  /** The panel's cut on that drawing (image-normalized). */
  box: Box;
  context?: number;
}

/** The panel's crop of the drawing (Image 1 of a panel fix), or null. STUB: null. */
export async function cropForPanel(_input: PanelCropInput): Promise<string | null> {
  return null;
}

export interface PasteInput {
  /** The drawing pasted into (the page's current drawing, a copy: the stored one never changes). */
  base: string;
  /** What the model drew. */
  drawn: string;
  /** Where it goes (image-normalized). */
  box: Box;
}

/** The base with `drawn` covering `box` (fix_panel: the cut), or null when it can't be made. STUB: null. */
export async function pasteIntoCut(_input: PasteInput): Promise<string | null> {
  return null;
}

export interface RegionPasteInput {
  /** The page before the edit (loaded only when a body needs it). */
  base: () => Promise<string>;
  drawn: string;
  /** The marked region (image-normalized). */
  region: Box;
  feather?: number;
}

export interface RegionPasteResult {
  /** The image to store as the new version. */
  dataUrl: string;
  /** Pasted into the region (false: the whole edited image, today's behaviour). */
  pasted: boolean;
  /** The geometry guard moved a panel edge (IoU < 0.9): stored as a separate version instead. */
  separate?: boolean;
}

/** An edit pasted back into its marked region with a feather. STUB: the whole edited image (today's behaviour). */
export async function pasteRegion(input: RegionPasteInput): Promise<RegionPasteResult> {
  return { dataUrl: input.drawn, pasted: false };
}

/** The page's frames, art and printed overlays baked into one raster (flatten, "Bring my drawn comic"). STUB: null. */
export async function bakeComposition(_input: { dataUrl: string; frames: Box[] }): Promise<string | null> {
  return null;
}
