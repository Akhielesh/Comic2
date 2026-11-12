// Pro Edit motion: budgets (master plan §2.8 "Motion data", §2.9 "Flash ≤ 3 Hz in the presets and in the sanitizer";
// PE-MOTION-ENGINE). The PE-SERVER sanitizer (server/src/comic/sanitize/motion.ts) imports these, so the write rule and
// the players agree by construction:
//   - bytes: a page's motion against MOTION_LIMITS.pageBytes (16 KB) and the document's against docBytes (256 KB);
//   - flashes: clipFlashHz (the most flashes in any one second of the clip's run, WCAG 2.3.1 "Three Flashes") and a page
//     check against MOTION_LIMITS.flashHzMax (3).
// The players use the same numbers at draw time: sample.ts holds a target's opacity as drawn when its clips would
// flash more often than flashHzMax, so a stored clip from anywhere never flashes past the limit. Pure, no DOM.

import type { ComicDoc, Page } from '../doc.js';
import { MOTION_LIMITS } from '../limits.js';
import { lineChainHeads } from './beats.js';
import { clipCurveAt, FLASH_OPACITY_DELTA, keysSetOpacity, playableClip, type PlayableClip } from './presets.js';
import { motionTargetKey, type MotionClip, type PageMotion } from './types.js';

// ── Bytes ───────────────────────────────────────────────────────────────────

/** UTF-8 length of a string (no TextEncoder needed). */
export const utf8Bytes = (text: string): number => {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i += 1;
      } else n += 3;
    } else n += 3;
  }
  return n;
};

/** UTF-8 bytes of a page's stored motion as JSON (0 without motion). Never less than the load rule's JSON length, so a
 *  page within budget here is never trimmed on load. */
export const motionBytes = (motion: PageMotion | undefined | null): number => (motion ? utf8Bytes(JSON.stringify(motion)) : 0);

/** A page's motion bytes. */
export const pageMotionBytes = (page: Pick<Page, 'motion'>): number => motionBytes(page.motion);

/** Every page's motion bytes together, the trash's pages included (what the document stores). */
export const docMotionBytes = (doc: Pick<ComicDoc, 'pages'> & Partial<Pick<ComicDoc, 'trash'>>): number =>
  (doc.pages || []).reduce((n, p) => n + pageMotionBytes(p), 0) + (doc.trash || []).reduce((n, t) => n + pageMotionBytes(t.page), 0);

export const pageMotionFits = (page: Pick<Page, 'motion'>): boolean => pageMotionBytes(page) <= MOTION_LIMITS.pageBytes;
export const docMotionFits = (doc: Pick<ComicDoc, 'pages'> & Partial<Pick<ComicDoc, 'trash'>>): boolean => docMotionBytes(doc) <= MOTION_LIMITS.docBytes;

// ── Flashes ─────────────────────────────────────────────────────────────────

/** Opacity samples per play (fine enough for the narrowest flicker dip at the shortest duration). */
const SAMPLES_PER_PLAY = 480;
const SECOND = 1000;

/** Times (ms from the run's start) at which a flash completes in a run of (time, opacity) samples. */
const flashTimes = (samples: readonly { t: number; o: number }[], delta = FLASH_OPACITY_DELTA): number[] => {
  const out: number[] = [];
  if (samples.length < 2) return out;
  let dir = 0;
  let swings = 0;
  let hi = samples[0].o;
  let lo = samples[0].o;
  let extreme = samples[0].o;
  for (const { t, o } of samples) {
    let turned = false;
    if (dir === 0) {
      hi = Math.max(hi, o);
      lo = Math.min(lo, o);
      if (hi - o >= delta) [dir, extreme, turned] = [-1, o, true];
      else if (o - lo >= delta) [dir, extreme, turned] = [1, o, true];
    } else if (dir > 0) {
      if (o > extreme) extreme = o;
      else if (extreme - o >= delta) [dir, extreme, turned] = [-1, o, true];
    } else if (o < extreme) extreme = o;
    else if (o - extreme >= delta) [dir, extreme, turned] = [1, o, true];
    if (turned) {
      swings += 1;
      if (swings % 2 === 0) out.push(t);
    }
  }
  return out;
};

/** The most entries of sorted `times` inside any half-open window of `span` ms (a microsecond of slack, so exactly
 *  periodic flashes are not counted twice at the window's edge by float rounding). */
const mostInWindow = (times: readonly number[], span: number): number => {
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < times.length; hi += 1) {
    while (times[hi] - times[lo] >= span - 1e-3) lo += 1;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
};

/** Could this clip's opacity change at all by a flash's worth? (A preset that declares no flashes and no keyed opacity
 *  never flashes: presets.test.ts holds every declaration against the drawn curve.) */
const mayFlash = (pc: PlayableClip): boolean => keysSetOpacity(pc) || pc.def.flashes(pc.params) > 0;

/**
 * Flashes per second of one stored clip: the most flashes (pairs of opposing opacity changes of at least
 * FLASH_OPACITY_DELTA) in any one-second period of its run, read off the curve the players draw (preset, ease and keys,
 * clamped to the write bounds). An emphasis plays 1 + repeat times from rest back to rest; a loop cycles for as long as
 * it shows; an entrance or exit holds its first and last frames. 0 for a clip this build cannot play (inert).
 */
export const clipFlashHz = (clip: MotionClip): number => {
  const pc = playableClip(clip);
  if (!pc || !mayFlash(pc)) return 0;
  const role = pc.def.role;
  // Every play draws the same curve, and a one-second window spans at most ceil(1000 / dur) + 1 of them, so reading more
  // plays than that adds no new window: the count is exact, and a long clip costs no more than a short one.
  const span = Math.ceil(SECOND / pc.durMs) + 2;
  const plays = role === 'loop' ? span : Math.min(1 + pc.repeat, span);
  const ctx = { dir: 'ltr' as const };
  const phases = [...Array.from({ length: SAMPLES_PER_PLAY + 1 }, (_, i) => i / SAMPLES_PER_PLAY), ...pc.keys.map((k) => k.t)].sort((a, b) => a - b);
  const curve = phases.map((p) => clipCurveAt(pc, p, ctx).o);
  const samples: { t: number; o: number }[] = [];
  if (role === 'emphasis') samples.push({ t: 0, o: 1 });
  for (let play = 0; play < plays; play += 1) phases.forEach((p, i) => samples.push({ t: (play + p) * pc.durMs, o: curve[i] }));
  if (role === 'emphasis') samples.push({ t: plays * pc.durMs, o: 1 });
  return mostInWindow(flashTimes(samples), SECOND);
};

/** One drawn target's flashes: its clips' rates added up (as if they all played at once, the safe reading). */
export interface FlashTarget {
  /** motionTargetKey of the drawn target (a balloon chain by its head). */
  key: string;
  hz: number;
  clipIds: string[];
}
export interface PageFlashCheck {
  ok: boolean;
  /** The worst target's rate. */
  hz: number;
  /** Every target with a flashing clip, worst first. */
  targets: FlashTarget[];
}

/** The key a clip's target is drawn under on its page: a line in a linked chain is drawn (and so flashes) with its head. */
const drawnKeyOf = (clip: MotionClip, heads: Map<string, string>): string =>
  clip.target?.k === 'line' ? motionTargetKey({ k: 'line', id: heads.get(clip.target.id) ?? clip.target.id }) : motionTargetKey(clip.target);

/**
 * The page check against MOTION_LIMITS.flashHzMax: per drawn target, the flash rates of its clips added up. ok when no
 * target goes past the limit. Only the first MOTION_LIMITS.clipsPerPage clips count (players read no more).
 */
export const pageFlashCheck = (page: Pick<Page, 'motion' | 'panels' | 'balloons'>): PageFlashCheck => {
  const clips = (page.motion?.clips || []).slice(0, MOTION_LIMITS.clipsPerPage);
  const heads = lineChainHeads(page);
  const byKey = new Map<string, FlashTarget>();
  for (const clip of clips) {
    if (!clip?.target) continue;
    const hz = clipFlashHz(clip);
    if (hz <= 0) continue;
    const key = drawnKeyOf(clip, heads);
    const t = byKey.get(key) ?? { key, hz: 0, clipIds: [] };
    t.hz += hz;
    t.clipIds.push(clip.id);
    byKey.set(key, t);
  }
  const targets = [...byKey.values()].sort((a, b) => b.hz - a.hz || (a.key < b.key ? -1 : 1));
  const hz = targets[0]?.hz ?? 0;
  return { ok: hz <= MOTION_LIMITS.flashHzMax, hz, targets };
};

// ── One report ──────────────────────────────────────────────────────────────

export interface PageMotionBudget {
  pageId: string;
  bytes: number;
  overBytes: boolean;
  clips: number;
  overClips: boolean;
  flashHz: number;
  overFlash: boolean;
}
export interface MotionBudgetReport {
  docBytes: number;
  overDoc: boolean;
  /** Pages with motion (live pages, then the trash's). */
  pages: PageMotionBudget[];
  /** True when nothing is over any budget. */
  ok: boolean;
}

/** Every motion budget of a document at once (PE-SERVER's write check, the editor's "too much motion" note). */
export const motionBudgetReport = (doc: Pick<ComicDoc, 'pages'> & Partial<Pick<ComicDoc, 'trash'>>): MotionBudgetReport => {
  const all = [...(doc.pages || []), ...(doc.trash || []).map((t) => t.page)].filter((p) => p?.motion);
  const pages = all.map((p): PageMotionBudget => {
    const bytes = pageMotionBytes(p);
    const clips = p.motion?.clips?.length ?? 0;
    const flash = pageFlashCheck(p);
    return {
      pageId: p.id,
      bytes,
      overBytes: bytes > MOTION_LIMITS.pageBytes,
      clips,
      overClips: clips > MOTION_LIMITS.clipsPerPage,
      flashHz: flash.hz,
      overFlash: !flash.ok
    };
  });
  const docBytes = docMotionBytes(doc);
  const overDoc = docBytes > MOTION_LIMITS.docBytes;
  return { docBytes, overDoc, pages, ok: !overDoc && pages.every((p) => !p.overBytes && !p.overClips && !p.overFlash) };
};
