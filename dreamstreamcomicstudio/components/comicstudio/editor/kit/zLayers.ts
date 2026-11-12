// The Pro editor's stacking recipe (master plan §2.7 "Editor z values come from --ds-z-*"; PE-SHELL kit). The editor
// takes ladder LAYERS, never numbers (studioDesign `Z`, index.css `--ds-z-*`): the full-screen editor itself, its
// chrome (rail, dock, top bar), popovers (swatches, the shortcut sheet), sheets and their scrim, toasts and tooltips.
// Inside the stage the page's own layers (art, lettering, handles) keep their local 1–30 stacking within the page box
// and never need a ladder step.

import { Z } from '../../../chat/studioDesign';

export const EDITOR_Z = {
  /** The full-screen page editor (70). */
  editor: Z.editor,
  /** The rail, the dock and the top bar inside it (40). */
  chrome: Z.chrome,
  /** A bottom sheet's scrim (85) and the sheet (86). */
  scrim: Z.scrim,
  sheet: Z.sheet,
  /** Swatch popovers, the shortcut sheet, menus (90). */
  popover: Z.popover,
  toast: Z.toast,
  tooltip: Z.tooltip
} as const;

export type EditorZLayer = keyof typeof EDITOR_Z;

/** The class for an editor layer. */
export const editorZ = (layer: EditorZLayer): string => EDITOR_Z[layer];

/**
 * The page box's OWN stacking (local to the page, inside the ladder's stage rung 0–30; never a ladder step and never a
 * class): the balloon layer's hit boxes sit at 1 (5 selected), the art-side layers (mark-up, the Shapes place layer) at
 * 3, and every handle at 6 — the same rungs as the balloon layer's tail and width handles (`z-[6]` in BalloonLayer.tsx,
 * counted by the z-ladder ratchet). The Pro handles and layers set these as an inline zIndex, so the ratchet's counts
 * stay what they are and the rungs are named in one place (kit.test.tsx pins them inside 1–30).
 */
export const PAGE_Z = {
  /** The Shapes tool's place layer (over the art and the mark-up layer, under the balloons' handles). */
  place: 3,
  /** The rotate and height handles (with the tail and width handles). */
  handles: 6
} as const;
