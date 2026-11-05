// Pro Edit motion (master plan §2.5). STUB with fixed export names (PE-0): the motion engine (PE-MOTION-ENGINE: beats,
// easing, presets, sample, reduced, budget) adds its modules next to this file and re-exports them here.
//
// What is final now: the stored shape (types.ts) and the label words below. The normalizer that keeps stored motion
// valid is doc.ts normalizePageMotion; the ops are ops.ts `motion` / `page_motion` (behind PRO_EDIT_OPS_PATCHABLE).

export * from './types.js';
import type { CameraMoveId, MotionPresetId } from './types.js';

/** "Zoom punch", "Speed line scroll", "Pan left": a preset or camera move id in words (labels, undo, History). */
export const motionPresetWord = (id: MotionPresetId | CameraMoveId | string): string => {
  const words = String(id || '').replace(/-/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Animation';
};
