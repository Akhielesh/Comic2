// Client-patch sanitizers "motion" (master plan §2.3 "Sanitizers", §2.5, §2.8 "Motion data", §2.9 "Flash ≤ 3 Hz";
// PE-SERVER). Owner: PE-SERVER.
//
//   motion       upsert (patch) or delete (null) one clip of a page's animation
//   page_motion  the page's camera moves and hold
//
// Both ops are FREE content edits (no spend, no render, no asset). They are client-patchable only once
// PRO_EDIT_OPS_PATCHABLE (shared/comic/ops.ts) is flipped: until then jobs.ts refuses them before any sanitizer runs,
// sanitize/index.ts does not register these, and each sanitizer refuses again on its own (defence in depth).
//
// A sanitizer rebuilds the op from known keys, or throws a StudioError that rejects the WHOLE batch:
//   - ids against PE-MOTION-ENGINE's registry (presets.ts motionPresetOf / cameraMoveOf, easing.ts isKnownEase), a
//     preset's role matching the clip's, its params against the preset's schema (presetParamIssues: unknown key, wrong
//     kind, out of range, an enum it does not list, more than MOTION_LIMITS.paramsPerClip);
//   - numbers clamped to MOTION_LIMITS (start −2000..10000 ms, duration 100..4000 ms, repeat 0..20, hold, keyframe
//     channels), whole milliseconds; a non-number or NaN is refused, never guessed;
//   - at most MOTION_LIMITS.keysPerClip keyframes; a clip that flashes more than MOTION_LIMITS.flashHzMax times a second
//     (WCAG 2.3.1; budget.ts clipFlashHz, the players' own count) is refused.
// A value the client re-sends exactly as stored (an undo, a newer build's preset after a rollback) is kept as it is:
// a client may re-assert what the doc holds, never add or change what this build cannot check.
//
// The whole batch is then checked as it will be stored (motionPatchScreen, after every per-op sanitizer; jobs.ts does
// not apply the motion ops to the batch's working doc): ≤ MOTION_LIMITS.clipsPerPage clips, ≤ pageBytes per page,
// ≤ docBytes for the document (trash included: budget.ts docMotionBytes), the page's flash check (pageFlashCheck: per
// drawn target and per panel area), and every clip the batch creates or re-aims names a line, panel or overlay that is
// on its page once the batch is applied (so "add a balloon, then animate it" in one batch works). The ops themselves
// never refuse a budget: applyMotion skips a 49th clip and normalizePageMotion drops clips from the END of a page past
// 16 KB, so the screen refuses any batch that would lose a clip it did not delete (an insert at the front or a grown
// early clip would otherwise push out a later, untouched one). A budget refuses only what the batch makes worse: a
// batch that only deletes is always accepted, even on a page already over (a newer build's flashes; a page_duplicate
// copy whose renamed ids pushed it past 16 KB, which the op trims from the end as the load would), and a value the
// batch did not add or change (a clip or camera move whose target is gone: inert) is never checked again.

import { LAYER_ID_RE, isOpaqueLayer, normalizeMotionClip, type ComicDoc, type Page } from '../../../../shared/comic/doc.js';
import { MOTION_LIMITS } from '../../../../shared/comic/limits.js';
import { PRO_EDIT_OPS_PATCHABLE, SAFE_ID_RE, applyOps, type DocOp } from '../../../../shared/comic/ops.js';
import { clipFlashHz, docMotionBytes, pageFlashCheck, pageMotionBytes } from '../../../../shared/comic/motion/budget.js';
import { isKnownEase } from '../../../../shared/comic/motion/easing.js';
import { cameraMoveOf, motionPresetOf, presetParamIssues, type PresetParamIssue } from '../../../../shared/comic/motion/presets.js';
import {
  MOTION_ANCHORS,
  MOTION_CLIP_ID_RE,
  MOTION_ROLES,
  MOTION_TARGET_KINDS,
  type CameraMove,
  type MotionClip,
  type MotionClipPatch,
  type MotionKey,
  type MotionRole,
  type PageMotionPatch
} from '../../../../shared/comic/motion/types.js';
import { motionPresetWord } from '../../../../shared/comic/motion/words.js';
import type { OpSanitizer, PatchScreen } from '../extensions.js';
import { StudioError } from '../types.js';
import { pageOf, safeIdOf } from './consistency.js';

type MotionOp = Extract<DocOp, { op: 'motion' }>;
type PageMotionOp = Extract<DocOp, { op: 'page_motion' }>;

const L = MOTION_LIMITS;
const bad = (message: string) => new StudioError('BAD_REQUEST', message, { status: 400 });
const limit = (message: string) => new StudioError('LIMIT', message, { status: 409 });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const jsonBytes = (v: unknown): number => {
  try {
    return JSON.stringify(v ?? null).length;
  } catch {
    return Infinity;
  }
};

/** A number for `what`, clamped to [lo, hi] (whole when `int`); a non-number or NaN is refused. */
const clampedNumber = (v: unknown, lo: number, hi: number, what: string, int = true): number => {
  if (!finite(v)) throw bad(`Invalid ${what}: it must be a number.`);
  const c = Math.min(hi, Math.max(lo, v));
  return int ? Math.round(c) : Math.round(c * 10000) / 10000;
};

/** The calm words for a refused preset parameter. */
const paramIssueMessage = (preset: string, issue: PresetParamIssue): string => {
  const name = motionPresetWord(preset);
  switch (issue.reason) {
    case 'count':
      return `${name} takes at most ${L.paramsPerClip} settings.`;
    case 'unknown':
      return `${name} has no setting called “${issue.key}”.`;
    case 'range':
      return `That ${name} setting (${issue.key}) is out of range.`;
    case 'value':
      return `That ${name} setting (${issue.key}) isn't one of its choices.`;
    default:
      return `That ${name} setting${issue.key ? ` (${issue.key})` : ''} has the wrong kind of value.`;
  }
};

const ROLE_WORD: Record<MotionRole, string> = { enter: 'an entrance', emphasis: 'an emphasis', exit: 'an exit', loop: 'a loop' };

// ── One clip ────────────────────────────────────────────────────────────────

const targetOf = (v: unknown): MotionClip['target'] => {
  if (!isObject(v)) throw bad('Invalid animation target.');
  const k = v.k;
  if (typeof k !== 'string' || !(MOTION_TARGET_KINDS as readonly string[]).includes(k)) throw bad('Invalid animation target.');
  const id = v.id;
  const ok = typeof id === 'string' && (k === 'layer' ? LAYER_ID_RE.test(id) : SAFE_ID_RE.test(id));
  if (!ok) throw bad('Invalid animation target.');
  return { k: k as MotionClip['target']['k'], id: id as string };
};

const atOf = (v: unknown): MotionClip['at'] => {
  if (!isObject(v)) throw bad('Invalid animation start.');
  const anchor = v.anchor;
  if (typeof anchor !== 'string' || !(MOTION_ANCHORS as readonly string[]).includes(anchor)) throw bad('Invalid animation start.');
  const at: MotionClip['at'] = { anchor: anchor as MotionClip['at']['anchor'], ms: clampedNumber(v.ms, L.atMsMin, L.atMsMax, 'animation start') };
  if (v.panelId !== undefined && v.panelId !== null) at.panelId = safeIdOf(v.panelId, 'panel');
  if (at.anchor === 'panel' && !at.panelId) throw bad('An animation that starts with a panel needs that panel.');
  return at;
};

const KEY_CHANNELS: readonly [keyof MotionKey, number, number][] = [
  ['x', -L.keyOffsetMax, L.keyOffsetMax],
  ['y', -L.keyOffsetMax, L.keyOffsetMax],
  ['s', 0, L.keyScaleMax],
  ['r', -L.keyRotateMax, L.keyRotateMax],
  ['o', 0, 1]
];

const keysOf = (v: unknown): MotionKey[] => {
  if (!Array.isArray(v)) throw bad('Invalid keyframes.');
  if (v.length > L.keysPerClip) throw bad(`An animation holds up to ${L.keysPerClip} keyframes.`);
  return v.map((raw) => {
    if (!isObject(raw)) throw bad('Invalid keyframe.');
    const key: MotionKey = { t: clampedNumber(raw.t, 0, 1, 'keyframe time', false) };
    for (const [name, lo, hi] of KEY_CHANNELS) {
      if (raw[name] === undefined || raw[name] === null) continue;
      key[name] = clampedNumber(raw[name], lo, hi, 'keyframe value', false);
    }
    return key;
  });
};

/** Parameter names as stored (doc.ts normalizeMotionClip keeps only these). */
const PARAM_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,23}$/;

/** Preset params as sent: an object of plain values under well-formed names, numbers to 4 places as the load keeps
 *  them (their schema is checked against the clip's preset in checkClip). */
const paramsShapeOf = (v: unknown): Record<string, number | string | boolean> => {
  if (!isObject(v)) throw bad('Invalid animation settings.');
  const out: Record<string, number | string | boolean> = {};
  for (const [key, value] of Object.entries(v)) {
    if (!PARAM_KEY_RE.test(key)) throw bad('Invalid animation settings.');
    if (finite(value)) out[key] = Math.round(value * 10000) / 10000;
    else if (typeof value === 'string' || typeof value === 'boolean') out[key] = value;
    else throw bad('Invalid animation settings.');
  }
  return out;
};

/** A `motion` patch from known keys only. `existing` is the stored clip (a value equal to it is a re-assert). */
const clipPatchOf = (raw: Record<string, unknown>, existing: MotionClip | undefined): MotionClipPatch => {
  const out: Record<string, unknown> = {};
  const same = (key: keyof MotionClip, v: unknown) => !!existing && sameJson(v, existing[key]);
  const set = (key: keyof MotionClip, fn: (v: unknown) => unknown, clearable: boolean) => {
    if (!hasOwn(raw, key) || raw[key] === undefined) return;
    if (raw[key] === null) {
      if (!clearable) throw bad(`Invalid animation: ${key} is needed.`);
      out[key] = null;
      return;
    }
    out[key] = fn(raw[key]);
  };
  set('target', targetOf, false);
  set('role', (v) => {
    if (typeof v !== 'string' || !(MOTION_ROLES as readonly string[]).includes(v)) throw bad('Invalid animation role.');
    return v;
  }, false);
  set('preset', (v) => {
    if (same('preset', v)) return v; // re-assert: a stored preset (a newer build's, after a rollback) is kept as it is
    if (!motionPresetOf(v)) throw bad("That animation isn't available in this version of the studio.");
    return v;
  }, false);
  set('at', atOf, false);
  set('dur', (v) => clampedNumber(v, L.durMin, L.durMax, 'animation length'), true);
  set('ease', (v) => {
    if (same('ease', v)) return v;
    if (!isKnownEase(v)) throw bad("That easing isn't available in this version of the studio.");
    return v;
  }, true);
  set('params', paramsShapeOf, true);
  set('repeat', (v) => clampedNumber(v, 0, L.repeatMax, 'repeat count'), true);
  set('keys', keysOf, true);
  return out as MotionClipPatch;
};

/** The clip as the op will store it (the applyMotion merge), or undefined when it is not a valid clip. */
const mergedClip = (existing: MotionClip | undefined, id: string, patch: MotionClipPatch): MotionClip | undefined => {
  const merged: Record<string, unknown> = { ...(existing || {}), id };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete merged[k];
    else merged[k] = v;
  }
  return normalizeMotionClip(merged);
};

/** The preset/role/params/flash rules on the clip the op will store. */
const checkClip = (clip: MotionClip, existing: MotionClip | undefined, patch: MotionClipPatch): void => {
  const def = motionPresetOf(clip.preset);
  const changed = (key: keyof MotionClip) => hasOwn(patch, key) && !(existing && sameJson(patch[key as keyof MotionClipPatch], existing[key]));
  if (def && (changed('role') || changed('preset')) && def.role !== clip.role) {
    throw bad(`${motionPresetWord(clip.preset)} is ${ROLE_WORD[def.role as MotionRole] ?? 'another kind of'} animation, so it can't play as ${ROLE_WORD[clip.role]}.`);
  }
  if (changed('params') || changed('preset')) {
    if (!def) {
      if (clip.params && Object.keys(clip.params).length) throw bad("That animation's settings can't be changed in this version of the studio.");
    } else {
      const issue = presetParamIssues(def.params, clip.params)[0];
      if (issue) throw bad(paramIssueMessage(clip.preset, issue));
    }
  }
  const hz = clipFlashHz(clip);
  if (hz > L.flashHzMax && (!existing || hz > clipFlashHz(existing))) {
    throw bad(`That animation would flash ${hz} times a second. Keep flashing to ${L.flashHzMax} times a second or less, so it stays safe to watch.`);
  }
};

const motionSanitizer: OpSanitizer<MotionOp> = {
  op: 'motion',
  sanitize(doc: ComicDoc, op: MotionOp): MotionOp {
    if (!PRO_EDIT_OPS_PATCHABLE) throw bad('“motion” can\'t be changed directly.');
    if (!isObject(op)) throw bad('Invalid animation change.');
    const page = pageOf(doc, op.pageId);
    if (typeof op.id !== 'string' || !MOTION_CLIP_ID_RE.test(op.id)) throw bad('Invalid animation id.');
    const clips = page.motion?.clips ?? [];
    const existing = clips.find((c) => c.id === op.id);
    if (op.patch === null || op.patch === undefined) return { op: 'motion', pageId: page.id, id: op.id, patch: null };
    if (!isObject(op.patch)) throw bad('Invalid animation change.');
    if (jsonBytes(op.patch) > L.pageBytes) throw bad('That animation is too large.');
    // The clip count (≤ MOTION_LIMITS.clipsPerPage) is the batch's, checked by motionPatchScreen: a batch may delete one
    // clip of a full page and add another.
    const patch = clipPatchOf(op.patch, existing);
    if (!Object.keys(patch).length) throw bad('Nothing to change in that animation.');
    const clip = mergedClip(existing, op.id, patch);
    if (!clip) throw bad(existing ? 'Invalid animation.' : 'A new animation needs a target, a role, a preset and a start.');
    checkClip(clip, existing, patch);
    const out: MotionOp = { op: 'motion', pageId: page.id, id: op.id, patch };
    if (!existing && op.index !== undefined && op.index !== null) {
      if (typeof op.index !== 'number' || !Number.isInteger(op.index) || op.index < 0 || op.index > clips.length) throw bad('Invalid animation position.');
      out.index = op.index;
    }
    return out;
  }
};

// ── The page's camera and hold ──────────────────────────────────────────────

const cameraOf = (v: unknown, stored: readonly CameraMove[]): CameraMove[] => {
  if (!Array.isArray(v)) throw bad('Invalid camera moves.');
  if (v.length > L.cameraMoves) throw bad(`A page takes at most one camera move per panel.`);
  const seen = new Set<string>();
  return v.map((raw) => {
    if (!isObject(raw)) throw bad('Invalid camera move.');
    const panelId = safeIdOf(raw.panelId, 'panel');
    if (seen.has(panelId)) throw bad('A panel takes one camera move.');
    seen.add(panelId);
    const reassert = stored.some((c) => c.panelId === panelId && c.move === raw.move);
    if (!reassert && !cameraMoveOf(raw.move)) throw bad("That camera move isn't available in this version of the studio.");
    return { panelId, move: raw.move as CameraMove['move'] };
  });
};

const pageMotionSanitizer: OpSanitizer<PageMotionOp> = {
  op: 'page_motion',
  sanitize(doc: ComicDoc, op: PageMotionOp): PageMotionOp {
    if (!PRO_EDIT_OPS_PATCHABLE) throw bad('“page_motion” can\'t be changed directly.');
    if (!isObject(op)) throw bad('Invalid page animation change.');
    const page = pageOf(doc, op.pageId);
    if (op.patch === null || op.patch === undefined) return { op: 'page_motion', pageId: page.id, patch: null };
    if (!isObject(op.patch)) throw bad('Invalid page animation change.');
    const raw = op.patch as Record<string, unknown>;
    const patch: PageMotionPatch = {};
    if (hasOwn(raw, 'camera') && raw.camera !== undefined) {
      if (raw.camera === null) patch.camera = null;
      else {
        const camera = cameraOf(raw.camera, page.motion?.camera ?? []);
        patch.camera = camera.length ? camera : null;
      }
    }
    if (hasOwn(raw, 'hold') && raw.hold !== undefined) patch.hold = raw.hold === null ? null : clampedNumber(raw.hold, 0, L.holdMaxMs, 'page hold');
    if (!Object.keys(patch).length) throw bad('Nothing to change in the page animation.');
    return { op: 'page_motion', pageId: page.id, patch };
  }
};

/** Registered by sanitize/index.ts only while PRO_EDIT_OPS_PATCHABLE is on (every registered op is patchable). */
export const MOTION_SANITIZERS: OpSanitizer[] = [motionSanitizer as OpSanitizer, pageMotionSanitizer as OpSanitizer];

// ── The whole batch, as it will be stored ───────────────────────────────────

const isMotionOp = (op: DocOp): op is MotionOp | PageMotionOp => op.op === 'motion' || op.op === 'page_motion';

/** Whether `page` (as the batch leaves it) has the target a clip names: a line, a panel, or an overlay this build draws. */
const hasTarget = (page: Page, target: MotionClip['target']): boolean => {
  if (target.k === 'panel') return page.panels.some((p) => p.id === target.id);
  if (target.k === 'line') return page.panels.some((p) => p.lines.some((l) => l.id === target.id));
  return (page.layers ?? []).some((l) => l.id === target.id && !isOpaqueLayer(l));
};

const SIZE_LIMIT_MESSAGE = "That page's animation is at its size limit — remove a clip or some keyframes first.";

/**
 * The page check: clips, bytes and flashes, refusing only what the batch made worse than it was. `meant` is every clip
 * the batch means the page to hold (what it held, less the batch's deletes, plus its upserts). The ops never refuse
 * loudly: applyMotion skips a clip past MOTION_LIMITS.clipsPerPage, and normalizePageMotion drops clips from the END
 * until the page fits MOTION_LIMITS.pageBytes, so an insert at the front or a grown early clip would silently push out
 * a later, untouched one. A meant clip missing after the batch is therefore refused here, whichever clip went. A batch
 * that only deletes or clears never loses a clip this way, except on a page already past the budget (page_duplicate
 * renames ids without trimming), which the load trims the same way; such a batch is accepted (a page can always shrink).
 */
const checkPage = (before: Page | undefined, after: Page, meant: ReadonlySet<string>, grows: boolean): void => {
  const kept = new Set((after.motion?.clips ?? []).map((c) => c.id));
  if (grows && [...meant].some((id) => !kept.has(id))) {
    if (meant.size > L.clipsPerPage) throw limit(`A page can hold up to ${L.clipsPerPage} animations — remove one first.`);
    throw limit(SIZE_LIMIT_MESSAGE);
  }
  // UTF-8 bytes (pageMotionBytes) can pass the budget where the load's JSON length does not (text in a newer build's
  // params): the same rule, read in bytes.
  const bytesNow = pageMotionBytes(after);
  if (bytesNow > L.pageBytes && bytesNow > (before ? pageMotionBytes(before) : 0)) throw limit(SIZE_LIMIT_MESSAGE);
  const flash = pageFlashCheck(after);
  if (!flash.ok && flash.hz > (before ? pageFlashCheck(before).hz : 0)) {
    throw bad(`Together, the animations on this page would flash ${flash.hz} times a second. Keep flashing to ${L.flashHzMax} times a second or less, so it stays safe to watch.`);
  }
};

/**
 * The batch-wide motion check (after the per-op sanitizers): the batch applied to the doc, then every page a motion op
 * touched against the page budgets and the flash rule, the targets of every clip the batch creates or re-aims, the
 * panels its new camera moves name, and the document's motion budget. Returns the ops unchanged.
 *
 * Only what the batch adds or changes must be on the page (master plan §2.3: a dangling target is inert, and ops never
 * prune): an edit of a clip whose balloon was deleted, or a camera list re-sent with the move of a removed panel, is
 * accepted; re-aiming a clip, a new start panel or a new camera move is checked. A NEW clip must name something on its
 * page once the batch is applied ("add a balloon, then animate it" in one batch works). The re-creation of a deleted
 * clip whose target is already gone (the undo of that delete) is a new clip to the server and is refused: the S2
 * integration's dangling-motion decision settles it (carry note 11; see motion.test.ts "dangling").
 */
export const motionPatchScreen: PatchScreen = (doc, ops) => {
  const motionOps = ops.filter(isMotionOp);
  if (!motionOps.length) return ops;
  const after = applyOps(doc, ops);
  const pageIds = new Set(motionOps.map((o) => o.pageId));
  for (const pageId of pageIds) {
    const before = doc.pages.find((p) => p.id === pageId);
    const now = after.pages.find((p) => p.id === pageId);
    if (!now) continue; // the batch deleted the page: its motion went with it
    const stored = new Map((before?.motion?.clips ?? []).map((c) => [c.id, c] as const));
    // Each clip as the batch leaves it: only its last op counts (an upsert then a delete leaves nothing to check).
    const meant = new Set(stored.keys());
    const last = new Map<string, MotionOp>();
    let grows = false;
    for (const op of motionOps) {
      if (op.pageId !== pageId) continue;
      if (op.op === 'page_motion') {
        if (op.patch) grows = true;
        continue;
      }
      if (op.patch) {
        meant.add(op.id);
        grows = true;
      } else meant.delete(op.id);
      last.set(op.id, op);
    }
    checkPage(before, now, meant, grows);
    for (const op of last.values()) {
      if (!op.patch) continue;
      const clip = now.motion!.clips.find((c) => c.id === op.id)!; // checkPage: every meant clip is on the page
      const was = stored.get(op.id);
      if ((!was || !sameJson(clip.target, was.target)) && !hasTarget(now, clip.target)) throw bad('That animation is aimed at something that is no longer on the page.');
      const atPanel = clip.at.panelId;
      if (atPanel && atPanel !== was?.at.panelId && !now.panels.some((p) => p.id === atPanel)) throw bad('That animation starts with a panel that is no longer on the page.');
    }
    const storedMoves = before?.motion?.camera ?? [];
    for (const move of now.motion?.camera ?? []) {
      if (storedMoves.some((m) => m.panelId === move.panelId && m.move === move.move)) continue; // as stored: inert if dangling
      if (!now.panels.some((p) => p.id === move.panelId)) throw bad('A camera move names a panel that is no longer on the page.');
    }
  }
  const docNow = docMotionBytes(after);
  if (docNow > L.docBytes && docNow > docMotionBytes(doc)) {
    throw limit(`This comic's animations are at their size limit (${Math.round(L.docBytes / 1024)} KB) — remove some first.`);
  }
  return ops;
};
