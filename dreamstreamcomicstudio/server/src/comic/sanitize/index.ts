// Client-patch sanitizer registry (contract §5.4 / §12.1; created in wave 0 by P0-B, FROZEN in wave 1).
//
// jobs.ts sanitizePatchOps() keeps the sanitizers for the 17 original patchable ops and
// dispatches every other CLIENT_PATCHABLE_OPS member through OP_SANITIZERS; then the
// PATCH_SCREENS run over the whole batch. An op that is patchable but has no sanitizer is
// rejected (400), so nothing reaches the doc unvalidated.

import { createKeyedRegistry, type OpSanitizer, type PatchScreen } from '../extensions.js';
import { I18N_SANITIZERS } from './i18n.js';
import { LETTERING_SANITIZERS } from './lettering.js';
import { MODELS_SANITIZERS } from './models.js';
import { READER_SANITIZERS } from './reader.js';
import { REFS_SANITIZERS } from './refs.js';
import { SAFETY_SANITIZERS, safetyPatchScreen } from './safety.js';
import { TIMELINE_SANITIZERS } from './timeline.js';

/** Ops whose client patches jobs.ts sanitizes itself (P1-JOBS extends their new fields there). */
export const CORE_PATCH_OPS: ReadonlySet<string> = new Set([
  'brief', 'note_add', 'format', 'settings', 'source', 'style', 'character', 'character_remove', 'place',
  'place_remove', 'page', 'panel', 'line', 'line_move', 'balloons', 'balloon', 'cover', 'plan_status'
]);

const registry = createKeyedRegistry<OpSanitizer>({
  what: 'op sanitizer',
  keyOf: (s) => s.op,
  reserved: CORE_PATCH_OPS,
  // MODELS_SANITIZERS is empty on purpose (image_model is never client-patchable; models.md §3.4) and listed for symmetry.
  lists: () => [LETTERING_SANITIZERS, TIMELINE_SANITIZERS, SAFETY_SANITIZERS, I18N_SANITIZERS, REFS_SANITIZERS, READER_SANITIZERS, MODELS_SANITIZERS]
});

/** op → sanitizer for every feature op (null-prototype object). */
export const OP_SANITIZERS: Record<string, OpSanitizer> = registry.table;

/** The sanitizer for a feature op, or undefined (core and unknown ops). Prototype-safe. */
export const opSanitizerFor = (op: string): OpSanitizer | undefined => registry.get(op);

/** Whole-batch screens, in order, after the per-op sanitizers. */
export function patchScreens(): PatchScreen[] {
  return [safetyPatchScreen];
}
