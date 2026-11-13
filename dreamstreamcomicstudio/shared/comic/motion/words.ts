// Pro Edit motion: the words a preset or camera move is named by (labels, undo, History). A metadata-only leaf: it
// imports nothing but types, so History, undo and the reader chunk can name an animation without pulling in the motion
// engine (the preset tables and curves are Pro code: master plan §2.8, lazy, never in the reader's first load).
// The barrel (index.ts) re-exports it; a light caller imports this file directly.

import type { CameraMoveId, MotionPresetId } from './types.js';

/** "Zoom punch", "Speed line scroll", "Pan left": a preset or camera move id in words (labels, undo, History). */
export const motionPresetWord = (id: MotionPresetId | CameraMoveId | string): string => {
  const words = String(id || '').replace(/-/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Animation';
};
