// The Pro switch as the page editor's Easy path reads it (S2b lead decision, collisions C-9; split out of proGate.ts so
// the font picker and the look gallery can ask "may a Pro field be written?" without loading the Pro inspector):
// PRO_EDIT_OPS_PATCHABLE (shared/comic/ops.ts) stays false until the owner signs D5 off; tests flip it with vi.mock.
//
// Also here: the Pro fonts (PE-FONTS's PRO_FONT_IDS) and the Pro looks the lettering module ships (PE-LETTER's
// PRO_LETTERING_PRESETS), as named imports since PE-LETTER and PE-FONTS merged (S2b integration, PE-INSPECT wave
// note 9), so style.ts still tree-shakes. editor/inspector/easyPath.test.ts pins the Easy-path import rules.

import { PRO_EDIT_OPS_PATCHABLE } from '../../../../shared/comic/ops';
import { PRO_LETTERING_PRESETS, PRO_LETTERING_PRESET_IDS, type LetteringPreset } from '../../../../shared/comic/lettering/style';
import { PRO_FONT_IDS } from '../../../../shared/comic/lettering/proFonts';

/** True once the lead flips PRO_EDIT_OPS_PATCHABLE: only then may a control write a Pro field. */
export const proFieldsWritable = (): boolean => Boolean(PRO_EDIT_OPS_PATCHABLE as boolean);

/** The Pro fonts the font picker lists (PE-FONTS fills PRO_FONT_IDS; empty until then). */
export const proFontIds = (): readonly string[] => PRO_FONT_IDS as readonly string[];

// ── Pro looks (PE-LETTER: 8 → 24) ────────────────────────────────────────────

/** One Pro look as the gallery reads it (PE-LETTER's ProLetteringPreset: a LetteringPreset with a Pro id). */
export interface ProLook extends Omit<LetteringPreset, 'id'> {
  id: string;
}

/** The export names PE-LETTER gives the Pro looks (shared/comic/lettering/style.ts). */
export const PRO_LOOKS_EXPORT = 'PRO_LETTERING_PRESETS';
export const PRO_LOOK_IDS_EXPORT = 'PRO_LETTERING_PRESET_IDS';

/** PE-LETTER's Pro looks, under the export names proLooks reads (a test may hand it another module's). */
const shippedLooks = (): Record<string, unknown> => ({
  [PRO_LOOKS_EXPORT]: PRO_LETTERING_PRESETS,
  [PRO_LOOK_IDS_EXPORT]: PRO_LETTERING_PRESET_IDS
});

/** The Pro looks this build's lettering module ships, in its order ([] before PE-LETTER). */
export function proLooks(mod: Record<string, unknown> = shippedLooks()): ProLook[] {
  const table = mod[PRO_LOOKS_EXPORT] as Record<string, ProLook> | undefined;
  const ids = mod[PRO_LOOK_IDS_EXPORT] as readonly string[] | undefined;
  if (!table || typeof table !== 'object') return [];
  const order = Array.isArray(ids) ? ids : Object.keys(table);
  return order.map((id) => table[id]).filter((p): p is ProLook => !!p && typeof p === 'object' && typeof p.name === 'string' && !!p.base);
}
