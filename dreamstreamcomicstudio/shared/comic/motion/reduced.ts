// Pro Edit motion: the calm and still readings (master plan §2.5 "Still exports", "Calm motion", §2.9 Motion;
// PE-MOTION-ENGINE). Three readings of the same clips, all through sample.ts, so a still, a calm video and a
// reduced-motion reader agree with the full preview on where everything ends up:
//   - 'calm' (an export option): the clips and camera moves in CALM_EXCLUDED_PRESETS never play (shake, jitter, flicker,
//     zoom-punch, blink; the camera's shake); everything else plays as usual;
//   - 'reduced' (prefers-reduced-motion, the viewer's own toggle, ReaderSettings.motion 'off'): the final state. Each
//     entrance and exit jumps to its last frame the moment it starts; emphases, loops and camera moves never play;
//   - 'poster' (PNG, PDF, print, an asset tile): the rest pose, whatever the clock. Entrances complete, loops off,
//     exits not applied (the still shows everything a reader reads), no camera.
// Pure, DOM-free.

import type { ComicDoc, Page } from '../doc.js';
import { pageBeats, type PageBeats } from './beats.js';
import { cameraPoseAt, planMotion, samplePlan, type CameraPose, type MotionPlan, type Pose, type SampleOptions } from './sample.js';
import { CALM_EXCLUDED_PRESETS } from './types.js';

export type MotionMode = 'full' | 'calm' | 'reduced' | 'poster';
export const MOTION_MODES: readonly MotionMode[] = ['full', 'calm', 'reduced', 'poster'];

/** True for a clip preset or camera move Calm motion and reduced motion never play (types.ts CALM_EXCLUDED_PRESETS). */
export const isCalmExcluded = (id: unknown): boolean => typeof id === 'string' && (CALM_EXCLUDED_PRESETS as readonly string[]).includes(id);

/** The sampling options of a mode (merged over the caller's seed). */
export const motionModeOptions = (mode: MotionMode, base: Pick<SampleOptions, 'seed'> = {}): SampleOptions => {
  switch (mode) {
    case 'calm':
      return { ...base, include: (clip) => !isCalmExcluded(clip.preset), includeCamera: (move) => !isCalmExcluded(move.move) };
    case 'reduced':
      return { ...base, include: (_clip, def) => def.role === 'enter' || def.role === 'exit', includeCamera: () => false, instant: true };
    case 'poster':
      return { ...base, include: (_clip, def) => def.role === 'enter', includeCamera: () => false, instant: true, settled: true };
    default:
      return { ...base };
  }
};

/** A page's motion planned for a mode (players plan once per page and sample per frame). */
export const planMotionIn = (mode: MotionMode, doc: Pick<ComicDoc, 'format'>, page: Page, beats: PageBeats, base: Pick<SampleOptions, 'seed'> = {}): MotionPlan =>
  planMotion(doc, page, beats, motionModeOptions(mode, base));

/** sampleAt in a mode. */
export const sampleInMode = (mode: MotionMode, doc: Pick<ComicDoc, 'format'>, page: Page, beats: PageBeats, ms: number, base: Pick<SampleOptions, 'seed'> = {}): Map<string, Pose> =>
  samplePlan(planMotionIn(mode, doc, page, beats, base), ms);

/** Calm motion at `ms`: no shake, jitter, flicker, zoom-punch or blink. */
export const calmSampleAt = (doc: Pick<ComicDoc, 'format'>, page: Page, beats: PageBeats, ms: number, base: Pick<SampleOptions, 'seed'> = {}): Map<string, Pose> =>
  sampleInMode('calm', doc, page, beats, ms, base);

/** Reduced motion at `ms`: every entrance and exit already at its last frame once started, nothing in between. */
export const reducedSampleAt = (doc: Pick<ComicDoc, 'format'>, page: Page, beats: PageBeats, ms: number, base: Pick<SampleOptions, 'seed'> = {}): Map<string, Pose> =>
  sampleInMode('reduced', doc, page, beats, ms, base);

/**
 * The poster of a page (still exports draw it): every entrance complete, loops and emphases off, exits not applied, no
 * camera. Only targets with an entrance appear; every other object is drawn as it is.
 */
export const posterPoses = (doc: Pick<ComicDoc, 'format'>, page: Page, beats: PageBeats = pageBeats(doc, page), base: Pick<SampleOptions, 'seed'> = {}): Map<string, Pose> =>
  sampleInMode('poster', doc, page, beats, 0, base);

/** The camera in a mode at `ms` (none under reduced motion and on the poster; no shake under Calm). */
export const cameraInMode = (mode: MotionMode, doc: Pick<ComicDoc, 'format'>, page: Page, beats: PageBeats, ms: number, base: Pick<SampleOptions, 'seed'> = {}): CameraPose | undefined =>
  cameraPoseAt(planMotionIn(mode, doc, page, beats, base), ms);

/**
 * Which reading a viewer gets: reduced when they asked for less motion (prefers-reduced-motion, their own toggle, or the
 * book's ReaderSettings.motion 'off'), Calm when the export asked for it, otherwise full. An explicit Play in the editor
 * still plays (the creator asked to see it): the editor passes `explicitPlay`.
 */
export const motionModeFor = (o: { reducedMotion?: boolean; readerMotion?: 'on' | 'off'; calm?: boolean; explicitPlay?: boolean }): MotionMode => {
  if (!o.explicitPlay && (o.reducedMotion || o.readerMotion === 'off')) return 'reduced';
  return o.calm ? 'calm' : 'full';
};
