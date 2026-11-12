// Pro Edit motion (master plan §2.5). The stored shape (types.ts, PE-0) and the pure motion engine (PE-MOTION-ENGINE):
// reading beats (beats.ts), easing, the presets and their param schemas, the evaluator (sample.ts sampleAt), the calm,
// reduced and poster readings (reduced.ts) and the budgets PE-SERVER's sanitizer shares (budget.ts).
//
// The normalizer that keeps stored motion valid is doc.ts normalizePageMotion; the ops are ops.ts `motion` /
// `page_motion` (behind PRO_EDIT_OPS_PATCHABLE). Nothing here writes ops.

export * from './types.js';
export * from './easing.js';
export * from './beats.js';
export * from './presets.js';
export * from './budget.js';
export * from './sample.js';
export * from './reduced.js';
import type { CameraMoveId, MotionPresetId } from './types.js';

/** "Zoom punch", "Speed line scroll", "Pan left": a preset or camera move id in words (labels, undo, History). */
export const motionPresetWord = (id: MotionPresetId | CameraMoveId | string): string => {
  const words = String(id || '').replace(/-/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Animation';
};
