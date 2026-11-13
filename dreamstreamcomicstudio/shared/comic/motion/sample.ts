// Pro Edit motion: the evaluator (master plan §2.5 "Evaluator"; PE-MOTION-ENGINE). ONE pure function of time feeds the
// editor preview (PE-ANIMATE's MotionPlayer), the MP4 (PE-MOTION-EXPORT) and the reader (PE-READER-MOTION), so the
// preview and the export always agree.
//
// sampleAt(doc, page, beats, ms) → Map<motionTargetKey, Pose> for every drawn target that has a clip:
//   - a clip's time is its anchor (the line's reveal, a panel's shot, the page's start: beats.ts) plus its offset, so it
//     follows its reveal when dialogue grows;
//   - an entrance holds its first frame until it starts (hidden) and its last after it ends (as drawn); an exit holds
//     the object as drawn until it starts and gone after; both play exactly once (a stored repeat is ignored: replaying
//     would snap the object from shown back to hidden, a flash); an emphasis plays 1 + repeat times from rest back to
//     rest; a loop cycles for as long as the page shows;
//   - keyframes override the preset channel by channel (presets.ts clipCurveAt); every channel and timing is clamped
//     to the MOTION_LIMITS write bounds (the load normalizers keep any finite stored value, so players clamp);
//   - several clips on one target compose: offsets and turns add, scales and opacities multiply, the smallest reveal
//     wins;
//   - dangling targets are skipped (a clip whose line, panel or overlay is not on this page, or whose anchor panel is
//     gone, is inert, so undoing a delete brings it back), as are clips this build cannot play (an unknown preset or
//     ease) and lines with no balloon (in-art lettering, empty text);
//   - a linked balloon chain (svgMarkup `data-link-group`) is keyed and animated by its head: a clip on any member
//     moves the whole chain, timed from the head's reveal;
//   - the flash guard: a target, or a panel's area, whose clips would flash more often than MOTION_LIMITS.flashHzMax
//     keeps its visibility as drawn (opaque, revealed, never squeezed out of sight); its movement still plays. It reads
//     the same verdict as PE-SERVER's pageFlashCheck (budget.ts flashVerdict), with the player's own seed.
// Typewriter, word cascade and ink wipe return a reveal fraction plus the line's direction (right to left for Arabic
// and Urdu): the player masks the drawn lettering (revealSpans, revealWordCount, revealRect), never re-lays the text.
//
// Deterministic per seed (byte-identical JSON on repeat runs), DOM-free and clock-free. planMotion does the per-page work
// once; samplePlan is the cheap per-frame call.

import type { Box, ComicDoc, Line, Page, Panel } from '../doc.js';
import { knownLayersOf } from '../doc.js';
import { dirOf } from '../languages.js';
import { MOTION_LIMITS } from '../limits.js';
import { isLetteredText, lineChainHeads, lineRevealMs, panelBeatOf, REVEAL_LEAD_MS, type PageBeats } from './beats.js';
import { clipFlashSwings, flashVerdict, type FlashEntry } from './budget.js';
import { applyEase } from './easing.js';
import {
  cameraMoveOf,
  clampChannels,
  clipCurveAt,
  playableClip,
  REST_CHANNELS,
  resolvePresetParams,
  type CameraMoveDef,
  type MotionDir,
  type PlayableClip,
  type PresetChannels,
  type PresetParams,
  type RevealMask
} from './presets.js';
import { motionTargetKey, type CameraMove, type CameraMoveId, type MotionClip } from './types.js';

/** A drawn target's pose at one instant: presets.ts channels, plus the reveal mask and its direction while a reveal runs. */
export interface Pose extends PresetChannels {
  /** How the reveal uncovers the lettering (set while reveal < 1). */
  mask?: RevealMask;
  /** The direction the reveal runs in (set with `mask`): 'rtl' for an Arabic or Urdu line. */
  dir?: MotionDir;
}

/** As drawn. */
export const REST_POSE: Readonly<Pose> = REST_CHANNELS;

export interface SampleOptions {
  /** Mixed into every clip's seed (default 0): the same seed gives the same frames, byte for byte. */
  seed?: number;
  /** Plays only the clips this keeps (Calm motion, reduced motion and the poster: reduced.ts). */
  include?: (clip: MotionClip, def: PlayableClip['def']) => boolean;
  /** Plays only the camera moves this keeps (default: every known move). */
  includeCamera?: (move: CameraMove) => boolean;
  /** Every clip jumps to its last frame the moment it starts and nothing moves in between (reduced motion, poster). */
  instant?: boolean;
  /** Every kept clip is read at its end, whatever the time asked (the poster: a still has no clock). */
  settled?: boolean;
}

/** One clip ready to sample on its page. */
export interface PlannedClip {
  /** motionTargetKey of what is drawn (a chain's head for a line in a linked chain). */
  key: string;
  pc: PlayableClip;
  /** When it starts, ms from the page's start (its anchor + its offset). */
  startMs: number;
  dir: MotionDir;
  /** The flash guard: this clip keeps the object visible as drawn (opaque, revealed, never squeezed out of sight:
   *  presets.ts clipCurveAt); its movement still plays. */
  holdOpacity: boolean;
}

export interface PlannedCamera {
  panelId: string;
  move: CameraMoveId;
  def: CameraMoveDef;
  params: PresetParams;
  startMs: number;
  durMs: number;
  seed: number;
}

/** A page's motion resolved once: what plays, on which target, from when. */
export interface MotionPlan {
  pageId: string;
  clips: PlannedClip[];
  camera: PlannedCamera[];
  /** The keys of every target that has a clip, in first-clip order (the order of the pose map). */
  keys: string[];
  instant: boolean;
  /** Sampled as if every clip had ended (SampleOptions.settled). */
  settled: boolean;
  totalMs: number;
}

/** The camera's move at one instant: dx, dy shift the frame (page fractions), s zooms in, r turns it (no move does yet). */
export interface CameraPose {
  panelId: string;
  move: CameraMoveId;
  pose: Pick<PresetChannels, 'dx' | 'dy' | 's' | 'r'>;
}

// ── Targets ─────────────────────────────────────────────────────────────────

interface ResolvedTarget {
  key: string;
  /** The panel the target sits in (a line's panel, an overlay's clip panel, a panel itself). */
  panelId?: string;
  /** The line whose reveal a 'reveal' anchor reads (a chain's head). */
  lineId?: string;
  dir: MotionDir;
}

interface PageIndex {
  lines: Map<string, { line: Line; panel: Panel }>;
  panels: Set<string>;
  layers: Map<string, { clip?: string }>;
  heads: Map<string, string>;
  overlay: boolean;
  docLang: string;
}

const indexPage = (doc: Pick<ComicDoc, 'format'>, page: Page): PageIndex => {
  const lines = new Map<string, { line: Line; panel: Panel }>();
  const panels = new Set<string>();
  for (const panel of page.panels || []) {
    panels.add(panel.id);
    for (const line of panel.lines || []) if (!lines.has(line.id)) lines.set(line.id, { line, panel });
  }
  const layers = new Map<string, { clip?: string }>();
  for (const layer of knownLayersOf(page)) if (!layers.has(layer.id)) layers.set(layer.id, { clip: layer.clip });
  return { lines, panels, layers, heads: lineChainHeads(page), overlay: doc.format?.lettering === 'overlay', docLang: doc.format?.language || 'en' };
};

/** The lettering draws a balloon for a line whose text survives normalizeLetteringText (layout.ts planLettering). */
const hasText = (line: Line): boolean => isLetteredText(line.text);

/** What a clip's target is drawn as on this page, or undefined when it is not drawn here (inert). */
const resolveTarget = (index: PageIndex, target: MotionClip['target']): ResolvedTarget | undefined => {
  if (!target || typeof target.id !== 'string') return undefined;
  const docDir = dirOf(index.docLang);
  if (target.k === 'line') {
    // Only overlay lettering draws balloons; a line without text has none.
    const found = index.lines.get(target.id);
    if (!index.overlay || !found || !hasText(found.line)) return undefined;
    const headId = index.heads.get(target.id) ?? target.id;
    const head = index.lines.get(headId) ?? found;
    return { key: motionTargetKey({ k: 'line', id: headId }), panelId: head.panel.id, lineId: headId, dir: dirOf(head.line.lang || index.docLang) };
  }
  if (target.k === 'panel') return index.panels.has(target.id) ? { key: motionTargetKey(target), panelId: target.id, dir: docDir } : undefined;
  if (target.k === 'layer') {
    const layer = index.layers.get(target.id);
    if (!layer) return undefined;
    return { key: motionTargetKey(target), panelId: layer.clip && index.panels.has(layer.clip) ? layer.clip : undefined, dir: docDir };
  }
  return undefined;
};

/** When a clip's anchor falls, ms from the page's start, or undefined when it names a panel that is not here (inert). */
const anchorMs = (clip: MotionClip, t: ResolvedTarget, beats: PageBeats): number | undefined => {
  const anchor = clip.at?.anchor;
  const panelOf = (id: string | undefined) => (id ? panelBeatOf(beats, id) : undefined);
  if (anchor === 'page') return 0;
  if (anchor === 'panel') return panelOf(clip.at.panelId ?? t.panelId)?.startMs;
  if (anchor === 'reveal') {
    if (t.lineId) {
      const at = lineRevealMs(beats, t.lineId);
      if (at !== undefined) return at;
    }
    const panel = panelOf(t.lineId ? t.panelId : (clip.at.panelId ?? t.panelId));
    return panel ? panel.startMs + REVEAL_LEAD_MS : undefined;
  }
  return undefined;
};

// ── Plan ────────────────────────────────────────────────────────────────────

/**
 * A page's motion resolved for sampling: the first MOTION_LIMITS.clipsPerPage clips that this build can play, whose
 * target and anchor are on the page, each with its start and the flash guard; the camera moves of panels on the page.
 */
export const planMotion = (doc: Pick<ComicDoc, 'format'>, page: Page, beats: PageBeats, opts: SampleOptions = {}): MotionPlan => {
  const index = indexPage(doc, page);
  const seed = opts.seed ?? 0;
  const planned: PlannedClip[] = [];
  const entries: FlashEntry[] = [];
  const everyPanel = index.panels.size ? [...index.panels] : ['page'];
  const guard = !opts.instant && !opts.settled;
  for (const clip of (page.motion?.clips || []).slice(0, MOTION_LIMITS.clipsPerPage)) {
    const pc = playableClip(clip, seed);
    if (!pc) continue;
    if (opts.include && !opts.include(clip, pc.def)) continue;
    const t = resolveTarget(index, clip.target);
    if (!t) continue;
    const anchor = anchorMs(clip, t, beats);
    if (anchor === undefined) continue;
    planned.push({ key: t.key, pc, startMs: anchor + pc.offsetMs, dir: t.dir, holdOpacity: false });
    if (guard) entries.push({ clip, key: t.key, regions: t.panelId ? [t.panelId] : everyPanel, swings: clipFlashSwings(clip, seed) });
  }
  // The flash guard: whatever the verdict holds (a target or a panel area past the limit) keeps its visibility.
  if (guard) for (const i of flashVerdict(entries).held) planned[i].holdOpacity = true;
  const camera: PlannedCamera[] = [];
  if (!opts.instant && !opts.settled) {
    const seen = new Set<string>();
    for (const move of (page.motion?.camera || []).slice(0, MOTION_LIMITS.cameraMoves)) {
      if (!move || seen.has(move.panelId)) continue;
      seen.add(move.panelId);
      const def = cameraMoveOf(move.move);
      const beat = panelBeatOf(beats, move.panelId);
      if (!def || !beat || (opts.includeCamera && !opts.includeCamera(move))) continue;
      camera.push({ panelId: move.panelId, move: def.id, def, params: resolvePresetParams(def.params), startMs: beat.startMs, durMs: beat.durationMs, seed: seed | 0 });
    }
  }
  const keys: string[] = [];
  for (const p of planned) if (!keys.includes(p.key)) keys.push(p.key);
  return { pageId: page.id, clips: planned, camera, keys, instant: !!opts.instant || !!opts.settled, settled: !!opts.settled, totalMs: beats.totalMs };
};

// ── Sample ──────────────────────────────────────────────────────────────────

/** One planned clip's channels at page time `ms` (REST when it adds nothing at that moment). */
export const plannedClipAt = (p: PlannedClip, ms: number, instant = false): PresetChannels => {
  const { pc } = p;
  const role = pc.def.role;
  const ctx = { dir: p.dir };
  const tau = ms - p.startMs;
  const at = (phase: number) => clipCurveAt(pc, phase, ctx, p.holdOpacity);
  if (role === 'enter' || role === 'exit') {
    // Once: hidden (or as drawn) before, the curve during, its last frame after.
    if (!(tau >= 0)) return at(0);
    if (instant || tau >= pc.durMs) return at(1);
    return at(tau / pc.durMs);
  }
  if (instant || !(tau >= 0)) return { ...REST_CHANNELS };
  if (role === 'emphasis') {
    if (tau >= pc.durMs * (1 + pc.repeat)) return { ...REST_CHANNELS };
    return at((tau % pc.durMs) / pc.durMs);
  }
  // A loop cycles for as long as the page shows.
  return Number.isFinite(tau) ? at((tau % pc.durMs) / pc.durMs) : at(0);
};

const r6 = (v: number): number => {
  const out = Math.round(v * 1e6) / 1e6;
  return out === 0 ? 0 : out;
};

/** The pose map of a planned page at `ms` (ms from the page's start): NaN reads as the page's start, +Infinity as after
 *  everything (every entrance and exit done, loops at their first frame), −Infinity as before everything. */
export const samplePlan = (plan: MotionPlan, ms: number): Map<string, Pose> => {
  const t = plan.settled ? Number.POSITIVE_INFINITY : Number.isNaN(ms) ? 0 : ms;
  const acc = new Map<string, Pose>();
  for (const key of plan.keys) acc.set(key, { ...REST_POSE });
  for (const p of plan.clips) {
    const c = plannedClipAt(p, t, plan.instant);
    const pose = acc.get(p.key)!;
    pose.dx += c.dx;
    pose.dy += c.dy;
    pose.s *= c.s;
    pose.sy *= c.sy;
    pose.r += c.r;
    pose.o *= c.o;
    if (c.reveal < pose.reveal) {
      pose.reveal = c.reveal;
      if (p.pc.def.mask) {
        pose.mask = p.pc.def.mask;
        pose.dir = p.dir;
      }
    }
  }
  const out = new Map<string, Pose>();
  for (const [key, pose] of acc) {
    const c = clampChannels(pose);
    const next: Pose = { dx: r6(c.dx), dy: r6(c.dy), s: r6(c.s), sy: r6(c.sy), r: r6(c.r), o: r6(c.o), reveal: r6(c.reveal) };
    if (next.reveal < 1 && pose.mask) {
      next.mask = pose.mask;
      next.dir = pose.dir;
    }
    out.set(key, next);
  }
  return out;
};

/**
 * Every animated target's pose on `page` at `ms` (ms from the page's start, the beats' clock). Pure and deterministic:
 * the same doc, page, beats, ms and seed give the same map, byte for byte.
 */
export const sampleAt = (doc: Pick<ComicDoc, 'format'>, page: Page, beats: PageBeats, ms: number, opts: SampleOptions = {}): Map<string, Pose> =>
  samplePlan(planMotion(doc, page, beats, opts), ms);

/** The camera's move at `ms` ("With camera" mode): the move of the panel on screen, or undefined (none, or still). */
export const cameraPoseAt = (plan: MotionPlan, ms: number): CameraPose | undefined => {
  const cam = plan.camera.find((c) => ms >= c.startMs && ms < c.startMs + c.durMs);
  if (!cam || cam.move === 'still') return undefined;
  const p = cam.durMs > 0 ? (ms - cam.startMs) / cam.durMs : 1;
  const c = clampChannels(cam.def.at(applyEase(cam.def.ease, p), cam.params, cam.seed, { dir: 'ltr' }));
  return { panelId: cam.panelId, move: cam.move, pose: { dx: r6(c.dx), dy: r6(c.dy), s: r6(c.s), r: r6(c.r) } };
};

/** sampleAt's camera twin. */
export const cameraAt = (doc: Pick<ComicDoc, 'format'>, page: Page, beats: PageBeats, ms: number, opts: SampleOptions = {}): CameraPose | undefined =>
  cameraPoseAt(planMotion(doc, page, beats, opts), ms);

/** A pose map as plain JSON-ready entries, key order kept (tests, logs, the export's frame hash). */
export const poseEntries = (poses: Map<string, Pose>): [string, Pose][] => [...poses.entries()];

// ── Reveal masks (the player draws them over the lettering as laid out; nothing is re-laid) ───────────────────────

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

/**
 * Typewriter ('lines'): how much of each laid-out text line shows, in reading order, given each line's drawn width (from
 * the LetterPlan). Each fraction is measured from the line's start edge: the left for 'ltr', the right for 'rtl'.
 */
export const revealSpans = (widths: readonly number[], reveal: number): number[] => {
  const total = widths.reduce((n, w) => n + Math.max(0, w), 0);
  let budget = clamp01(reveal) * total;
  return widths.map((w) => {
    const width = Math.max(0, w);
    if (width <= 0) return budget > 0 || reveal >= 1 ? 1 : 0;
    const shown = Math.min(width, Math.max(0, budget));
    budget -= width;
    return shown / width;
  });
};

/** Word cascade ('words'): how many of `count` words show, in reading order. */
export const revealWordCount = (count: number, reveal: number): number => Math.min(count, Math.floor(clamp01(reveal) * count + 1e-9));

/**
 * Ink wipe ('wipe'): the visible part of an object's box. The wipe runs from the reading start: left to right for 'ltr',
 * right to left for 'rtl' (the shown part stays anchored on the right edge).
 */
export const revealRect = (box: Box, reveal: number, dir: MotionDir): Box => {
  const w = box.w * clamp01(reveal);
  return { x: dir === 'rtl' ? box.x + box.w - w : box.x, y: box.y, w, h: box.h };
};
