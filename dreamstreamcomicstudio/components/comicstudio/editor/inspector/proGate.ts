// The one switch every Pro lettering control reads (S2b lead decision, collisions C-9): a control that writes a NEW Pro
// field — the Pro text keys (gradient, strokes, glow, warp), a Pro shape, a Pro SFX effect, a Pro font, a new look,
// named styles and `styleId` — is not rendered while PRO_EDIT_OPS_PATCHABLE (shared/comic/ops.ts) is false, and no edit
// of this part sends one. Existing fields (x, y, w, rot, minH, sizes, spacing, colours, opacity, kind…) write as today.
// Tests flip the constant with vi.mock; the code default stays OFF until the owner signs D5 off.
//
// The switch itself, the Pro fonts and the Pro looks live in proSwitch.ts (the Easy path's font picker and look gallery
// read them there); they are re-exported here under their names. Only the lazily loaded Pro modules import this file.

import {
  DRAWN_PRO_SFX_EFFECTS,
  PRO_BUBBLE_SHAPES,
  type LetterStylePatch,
  type ProBubbleShape,
  type ProSfxEffect
} from '../../../../shared/comic/lettering/style';
import type { ScriptId } from '../../../../shared/comic/languages';
import { proFieldsWritable, stripProFields } from './proSwitch';

export { duplicateCopyOptions, proFieldsWritable, proFontIds, proLooks, stripProFields, PRO_LOOKS_EXPORT, PRO_LOOK_IDS_EXPORT, type DuplicateCopyOptions, type ProLook } from './proSwitch';

/** The SFX effects PE-LETTER draws in S2: its DRAWN_PRO_SFX_EFFECTS (halftone_fill needs canvas patterns: S3, PE-TONES). */
export const PRO_SFX_DRAWN: readonly ProSfxEffect[] = DRAWN_PRO_SFX_EFFECTS;

/** A Pro shape id (never a base one). */
export const isProShape = (v: unknown): v is ProBubbleShape => typeof v === 'string' && (PRO_BUBBLE_SHAPES as readonly string[]).includes(v);

/** A patch as this build may write it: whole when the switch is on, without its Pro fields when it is off. */
export const writablePatch = (patch: LetterStylePatch | null | undefined): LetterStylePatch | undefined =>
  proFieldsWritable() ? (patch && Object.keys(patch).length ? { ...patch } : undefined) : stripProFields(patch);

// ── Warp and scripts (master plan §2.4, §2.9) ────────────────────────────────

/** Scripts warp shapes correctly: Latin and the CJK editions (no Cyrillic edition exists yet; it joins when one does). */
export const WARP_SCRIPTS: ReadonlySet<ScriptId> = new Set<ScriptId>(['Latn', 'Jpan', 'Kore', 'Hans']);
export const warpAllowed = (script: ScriptId | undefined): boolean => WARP_SCRIPTS.has(script ?? 'Latn');
