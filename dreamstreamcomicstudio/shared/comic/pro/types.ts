// Pro Edit: the shared words and shapes of the Easy | Pro editor (master plan §2.2, §2.6). PE-0 contract.
//
// Pro is a VIEW of the same editor, document and undo stack: switching never changes the document. Every Pro edit is
// free software ("no AI cost"); "Pro" is never "paid". Samples and recipes are ops bundles that double as goldens and
// QA scenes (graft 10). Type-only imports.

import type { DocOp } from '../ops.js';

/** The client parts of the Pro editor. Each part's folder starts as a stub whose `part.ready` is false; the shell
 *  (PE-SHELL) mounts a part only when it is ready AND its flag is on, so an unfinished part never shows. */
export const PRO_EDIT_PARTS = ['compose', 'render', 'kit', 'inspector', 'layers', 'assets', 'animate', 'stage'] as const;
export type ProEditPartId = (typeof PRO_EDIT_PARTS)[number];
export interface ProEditPart {
  id: ProEditPartId;
  ready: boolean;
}

/** Every Pro panel's footer (the pattern of the lettering inspector's free note). */
export const PRO_FREE_FOOTER = 'Free — done by the editor, no AI cost';
/** The one chip Easy shows on an object made in Pro: its advanced properties fold into it. */
export const MADE_IN_PRO_CHIP = 'Made in Pro · Open in Pro';
/** Why text, balloon and SFX tools are off on a comic whose lettering is drawn into the art. */
export const IN_ART_LETTERING_NOTE = "This comic's lettering is drawn into the art — switch to overlay lettering to add editable text.";
/** Warp on a script it may mis-shape (anything but Latin, Cyrillic and CJK editions). */
export const WARP_SCRIPT_NOTE = "Warp isn't available for this script yet";
/** The Layers panel's note on the band rule (lettering always stays above overlays). §2.4 says the panel "says so" but
 *  gives no words: this copy is PE-0's, LEAD TO CONFIRM. */
export const LETTERING_ON_TOP_NOTE = 'Lettering always stays on top, so a sticker or effect can never cover dialogue.';

/** What a sample is in the "Start from a sample" sheet and Assets › Recipes. */
export type ProSampleKind = 'recipe' | 'look' | 'sfx' | 'motion';

/**
 * A sample or recipe: free, client-patchable ops that make one undo entry ("Apply 'Action hit' · Free"). Stored as
 * shared/comic/pro/__fixtures__/samples/*.json (PE-ASSETS), which are also the render-parity goldens and QA scenes.
 * Ops name the page and objects they act on by placeholder ids that the applier maps onto the real page.
 */
export interface ProSample {
  id: string;
  kind: ProSampleKind;
  /** "Action hit". */
  name: string;
  /** The undo label ("Apply 'Action hit' · Free"). */
  label: string;
  ops: DocOp[];
}
