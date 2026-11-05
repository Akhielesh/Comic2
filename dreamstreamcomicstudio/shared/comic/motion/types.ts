// Pro Edit motion: the data a page's animation is stored as (master plan §2.3 "Motion", §2.5). PE-0 contract.
//
// `Page.motion` holds the page's clips (each animates one line, overlay or panel), an optional camera move per panel and
// a hold. Every field is optional on the page and NEVER enters a spec hash: animating a balloon never marks the art out
// of date. Times are anchored to reading beats (a line's reveal, a panel's shot, the page), so when dialogue grows the
// clip moves with its reveal.
//
// Dependency-free: no imports. doc.ts re-exports these types and holds the normalizer (normalizePageMotion); the
// motion engine (beats, easing, presets, sample, reduced, budget: PE-MOTION-ENGINE) implements the presets named here.
// A clip whose preset or ease this build does not know is kept and skipped by every player (inert), like a dangling
// target, so a newer build's motion survives a rollback.

/** What a clip animates: a line (its balloon), an overlay layer (`ly_…`) or a panel (its frame). */
export type MotionTargetKind = 'line' | 'layer' | 'panel';
export const MOTION_TARGET_KINDS: readonly MotionTargetKind[] = ['line', 'layer', 'panel'];
export interface MotionTarget {
  k: MotionTargetKind;
  id: string;
}

/** When in the object's life the clip plays. */
export type MotionRole = 'enter' | 'emphasis' | 'exit' | 'loop';
export const MOTION_ROLES: readonly MotionRole[] = ['enter', 'emphasis', 'exit', 'loop'];

/** The reading beat a clip's time counts from: the line's reveal, a panel's shot, or the page's start. */
export type MotionAnchor = 'reveal' | 'panel' | 'page';
export const MOTION_ANCHORS: readonly MotionAnchor[] = ['reveal', 'panel', 'page'];

// ── Presets (§2.5: 10 entrances, 8 emphasis, 6 exits, 6 loops, 6 camera moves) ──────────────────────────────────

export const ENTER_PRESET_IDS = ['pop', 'bounce', 'slide', 'zoom-punch', 'fade', 'drop', 'spin-in', 'typewriter', 'word-cascade', 'ink-wipe'] as const;
export const EMPHASIS_PRESET_IDS = ['shake', 'pulse', 'jitter', 'squash-stretch', 'flicker', 'wiggle', 'glow', 'heartbeat'] as const;
/** The plan counts six exits without naming them: these mirror the entrances (lead to confirm). */
export const EXIT_PRESET_IDS = ['pop-out', 'fade-out', 'slide-out', 'zoom-out', 'drop-out', 'ink-wipe-out'] as const;
export const LOOP_PRESET_IDS = ['float', 'sway', 'blink', 'rain-fall', 'speed-line-scroll', 'sparkle-twinkle'] as const;
export const CAMERA_MOVE_IDS = ['still', 'push', 'pull', 'pan-left', 'pan-right', 'shake'] as const;

export type EnterPresetId = (typeof ENTER_PRESET_IDS)[number];
export type EmphasisPresetId = (typeof EMPHASIS_PRESET_IDS)[number];
export type ExitPresetId = (typeof EXIT_PRESET_IDS)[number];
export type LoopPresetId = (typeof LOOP_PRESET_IDS)[number];
export type MotionPresetId = EnterPresetId | EmphasisPresetId | ExitPresetId | LoopPresetId;
export type CameraMoveId = (typeof CAMERA_MOVE_IDS)[number];

/** Every clip preset, by role (the Easy Animate row offers six of the entrances and emphases). */
export const MOTION_PRESETS_BY_ROLE: Readonly<Record<MotionRole, readonly MotionPresetId[]>> = {
  enter: ENTER_PRESET_IDS,
  emphasis: EMPHASIS_PRESET_IDS,
  exit: EXIT_PRESET_IDS,
  loop: LOOP_PRESET_IDS
};
export const MOTION_PRESET_IDS: readonly MotionPresetId[] = [...ENTER_PRESET_IDS, ...EMPHASIS_PRESET_IDS, ...EXIT_PRESET_IDS, ...LOOP_PRESET_IDS];
/** The one-tap Easy Animate row (§2.2): Pop in, Fade in, Slide in, Shake, Pulse, Typewriter. */
export const EASY_ANIMATE_PRESETS: readonly MotionPresetId[] = ['pop', 'fade', 'slide', 'shake', 'pulse', 'typewriter'];
/** Presets Calm motion and reduced motion never play. §2.5 names shake, flicker and zoom-punch; 'jitter' (a shake) and
 *  'blink' (a flicker) are added by PE-0 on the same grounds: LEAD TO CONFIRM. */
export const CALM_EXCLUDED_PRESETS: readonly (MotionPresetId | CameraMoveId)[] = ['shake', 'jitter', 'flicker', 'zoom-punch', 'blink'];

// ── Easing (§2.5: the Atlas curves, linear, in and out, and a closed-form damped spring) ──────────────────────────

export const EASE_IDS = ['ease', 'enter', 'spring', 'linear', 'in', 'out', 'in-out', 'damped'] as const;
export type EaseId = (typeof EASE_IDS)[number];

// ── Stored shape ─────────────────────────────────────────────────────────────

/**
 * One keyframe: `t` is 0..1 of the clip's duration; every channel is optional and overrides the preset's. The channel
 * ranges are WRITE bounds (MOTION_LIMITS keyOffsetMax, keyScaleMax, keyRotateMax; LEAD TO CONFIRM): the sanitizer and the
 * players clamp to them, the load normalizer keeps any finite stored value (scale ≥ 0, opacity 0..1).
 */
export interface MotionKey {
  t: number;
  /** Offset, page fractions (written −1..1). */
  x?: number;
  y?: number;
  /** Scale (written 0..8). */
  s?: number;
  /** Rotation, degrees (written −720..720). */
  r?: number;
  /** Opacity 0..1. */
  o?: number;
}

export type MotionParamValue = number | string | boolean;

/** When a clip starts: its anchor plus `ms` (MOTION_LIMITS.atMsMin..atMsMax). `panelId` names the panel for 'panel'. */
export interface MotionAt {
  anchor: MotionAnchor;
  panelId?: string;
  ms: number;
}

/** One animation of one object (`id` 'mc_…', unique on its page). */
export interface MotionClip {
  id: string;
  target: MotionTarget;
  role: MotionRole;
  preset: MotionPresetId;
  at: MotionAt;
  /** Milliseconds, MOTION_LIMITS.durMin..durMax; absent = the preset's own. */
  dur?: number;
  ease?: EaseId;
  /** Preset parameters: numbers, booleans, short words (written ≤ MOTION_LIMITS.paramsPerClip, a write bound). */
  params?: Record<string, MotionParamValue>;
  /** Extra plays, 0..MOTION_LIMITS.repeatMax. */
  repeat?: number;
  /** Pro keyframes (≤ MOTION_LIMITS.keysPerClip), sorted by `t`. */
  keys?: MotionKey[];
}

/** The "With camera" move into one panel. */
export interface CameraMove {
  panelId: string;
  move: CameraMoveId;
}

/** A page's animation. A page with no clips, no camera and no hold has no `motion` at all. */
export interface PageMotion {
  clips: MotionClip[];
  camera?: CameraMove[];
  /** Milliseconds the page holds after its last beat (≥ 0; written ≤ MOTION_LIMITS.holdMaxMs, a write bound). */
  hold?: number;
}

/** `motion` op patch: null clears an optional key (id comes from the op). */
export type MotionClipPatch = { [K in Exclude<keyof MotionClip, 'id'>]?: MotionClip[K] | null };
/** `page_motion` op patch: `camera` replaces the list (null clears it); `hold` sets the hold (null clears it). */
export interface PageMotionPatch {
  camera?: CameraMove[] | null;
  hold?: number | null;
}

/** Clip ids: 'mc_…'. */
export const MOTION_CLIP_ID_RE = /^mc_[A-Za-z0-9_-]{1,61}$/;
/** Preset, ease and move ids as stored (lower-case words joined by '-'); the server checks them against the registry. */
export const MOTION_WORD_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** The key a target is addressed by in a pose map ("line:l1", "layer:ly_a", "panel:p2"). */
export const motionTargetKey = (t: MotionTarget): string => `${t.k}:${t.id}`;
