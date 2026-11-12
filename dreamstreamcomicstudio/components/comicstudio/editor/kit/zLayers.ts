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
