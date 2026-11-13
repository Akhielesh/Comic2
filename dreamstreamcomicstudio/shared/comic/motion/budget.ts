// Pro Edit motion: budgets (master plan §2.8 "Motion data", §2.9 "Flash ≤ 3 Hz in the presets and in the sanitizer";
// PE-MOTION-ENGINE). The PE-SERVER sanitizer (server/src/comic/sanitize/motion.ts) imports these, so the write rule and
// the players agree by construction:
//   - bytes: a page's motion against MOTION_LIMITS.pageBytes (16 KB) and the document's against docBytes (256 KB);
//   - flashes: clipFlashHz (the most flashes in any one second of the clip's run, WCAG 2.3.1 "Three Flashes") and a page
//     check against MOTION_LIMITS.flashHzMax (3), per drawn target and per panel area (pageFlashCheck, flashVerdict).
// The players use the same verdict at draw time: sample.ts holds the visibility of whatever would flash more often
// than flashHzMax, so a stored clip from anywhere never flashes past the limit. Pure (the flash counts are cached by
// value: the same clip always gives the same count), no DOM.

import type { ComicDoc, Page } from '../doc.js';
import { MOTION_LIMITS } from '../limits.js';
import { lineChainHeads } from './beats.js';
import { clipCurveAt, FLASH_OPACITY_DELTA, playableClip, visibilityOf, type PlayableClip } from './presets.js';
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
//
// What flashes is what the reader sees go and come back: visibilityOf (presets.ts) reads opacity, the reveal and a
// collapsed scale, so a balloon that blinks out by fading, by un-revealing or by shrinking to nothing counts the same.
// A swing is one change of visibility of at least FLASH_OPACITY_DELTA against the last turn; a flash is a pair of
// opposing swings (WCAG 2.3.1). The rule is read off the curve the players draw (preset, ease and keys, clamped), and
// what it reads is the same for every seed (presets.test.ts), so the sanitizer's seed-0 count bounds every player.
//
// Three readings, all "as if they played at once" (the safe reading: the server has no clock):
//   - one clip: the most flashes in any one-second window of its run (clipFlashHz);
//   - one drawn target (a balloon chain by its head): its clips' swings added up, then paired, so an entrance and an
//     exit on a flickering balloon count their changes too;
//   - one panel's area (LEAD TO CONFIRM; the whole page is the stricter reading): the flashes of every clip drawn in
//     it added up: the panel's own, its lines', the overlays clipped to it, and every unclipped overlay (it floats over
//     the whole page). A balloon appearing while another one goes is not a flash of either, so a clip with only one
//     change adds nothing here.
// The players hold the visibility of a target or a panel past MOTION_LIMITS.flashHzMax (sample.ts), and PE-SERVER
// refuses the page (pageFlashCheck): the two read the same entries through flashVerdict.

/** Visibility samples per play (fine enough for the narrowest flicker dip at the shortest duration). */
const SAMPLES_PER_PLAY = 480;
/** WCAG 2.3.1 counts flashes in any one-second period. */
export const FLASH_WINDOW_MS = 1000;
const LTR = { dir: 'ltr' as const };

/** A swing detector over a run of visibility values: true when the value has turned by at least `delta` since the
 *  last extreme (the first turn counts too: it leaves the starting value). */
const swingDetector = (delta: number) => {
  let started = false;
  let dir = 0;
  let hi = 0;
  let lo = 0;
  let extreme = 0;
  return (v: number): boolean => {
    if (!started) {
      started = true;
      hi = lo = extreme = v;
      return false;
    }
    if (dir === 0) {
      hi = Math.max(hi, v);
      lo = Math.min(lo, v);
      if (hi - v >= delta) [dir, extreme] = [-1, v];
      else if (v - lo >= delta) [dir, extreme] = [1, v];
      else return false;
      return true;
    }
    if (dir > 0) {
      if (v > extreme) extreme = v;
      else if (extreme - v >= delta) {
        [dir, extreme] = [-1, v];
        return true;
      }
      return false;
    }
    if (v < extreme) extreme = v;
    else if (v - extreme >= delta) {
      [dir, extreme] = [1, v];
      return true;
    }
    return false;
  };
};

/** The most entries of sorted `times` inside any half-open window of `span` ms (a microsecond of slack, so exactly
 *  periodic swings are not counted twice at the window's edge by float rounding). */
const mostInWindow = (times: readonly number[], span: number): number => {
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < times.length; hi += 1) {
    while (times[hi] - times[lo] >= span - 1e-3) lo += 1;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
};

/** The phases one play is read at: an even grid plus every key's own time (a keyed step is never missed). */
const phasesOf = (pc: PlayableClip): number[] => {
  const grid = Array.from({ length: SAMPLES_PER_PLAY + 1 }, (_, i) => i / SAMPLES_PER_PLAY);
  return pc.keys.length ? [...grid, ...pc.keys.map((k) => k.t)].sort((a, b) => a - b) : grid;
};

/** The swings in the busiest one-second window of one playable clip's run (see clipFlashSwings). */
const swingsOfPlayable = (pc: PlayableClip): number => {
  const role = pc.def.role;
  const once = role === 'enter' || role === 'exit';
  // Every play draws the same curve, and a one-second window spans at most ceil(1000 / dur) + 1 of them, so reading more
  // plays than that adds no new window: the count is exact, and a long run costs no more than a short one.
  const span = Math.ceil(FLASH_WINDOW_MS / pc.durMs) + 2;
  const plays = once ? 1 : role === 'loop' ? span : Math.min(1 + pc.repeat, span);
  const phases = phasesOf(pc);
  const curve = phases.map((p) => visibilityOf(clipCurveAt(pc, p, LTR)));
  const turned = swingDetector(FLASH_OPACITY_DELTA);
  const times: number[] = [];
  const feed = (t: number, v: number) => {
    if (turned(v)) times.push(t);
  };
  // An entrance holds its first frame before it starts and an exit its last after it ends, so its one play is its
  // whole run; an emphasis and a loop rest as drawn before they start (and an emphasis after it ends).
  if (!once) feed(0, 1);
  for (let play = 0; play < plays; play += 1) for (let i = 0; i < phases.length; i += 1) feed((play + phases[i]) * pc.durMs, curve[i]);
  if (role === 'emphasis') feed(plays * pc.durMs, 1);
  return mostInWindow(times, FLASH_WINDOW_MS);
};

// planMotion runs on every edit and drag tick, so each clip's count is read once: the key is the clip as played (its
// canonical, clamped form, so equal clips share an entry) and the cache is cleared when it grows past its bound.
const SWING_CACHE = new Map<string, number>();
const SWING_CACHE_MAX = 4096;
const cacheKeyOf = (pc: PlayableClip): string | undefined => {
  try {
    return JSON.stringify([pc.def.id, pc.durMs, pc.repeat, pc.params, pc.keys, pc.clip.ease ?? pc.def.ease, pc.seed]);
  } catch {
    return undefined;
  }
};

/**
 * Visibility swings of one stored clip: the most changes of at least FLASH_OPACITY_DELTA (each against the last turn)
 * in any one-second period of its run, read off the curve the players draw (preset, ease and keys, clamped to the
 * write bounds). An entrance or exit plays once; an emphasis plays 1 + repeat times from rest back to rest; a loop
 * cycles for as long as it shows. 0 for a clip this build cannot play (inert). `seed` is the player's
 * (SampleOptions.seed); the answer is the same for every seed.
 */
export const clipFlashSwings = (clip: MotionClip, seed = 0): number => {
  const pc = playableClip(clip, seed);
  if (!pc) return 0;
  const key = cacheKeyOf(pc);
  const known = key === undefined ? undefined : SWING_CACHE.get(key);
  if (known !== undefined) return known;
  const swings = swingsOfPlayable(pc);
  if (key !== undefined) {
    if (SWING_CACHE.size >= SWING_CACHE_MAX) SWING_CACHE.clear();
    SWING_CACHE.set(key, swings);
  }
  return swings;
};

/**
 * Flashes per second of one stored clip: the most flashes (pairs of opposing visibility swings) in any one-second
 * period of its run (clipFlashSwings / 2, rounded down). 0 for a clip this build cannot play (inert).
 */
export const clipFlashHz = (clip: MotionClip, seed = 0): number => Math.floor(clipFlashSwings(clip, seed) / 2);

/** One clip as the flash rule judges it on its page. */
export interface FlashEntry {
  clip: MotionClip;
  /** motionTargetKey of the drawn target (a balloon chain by its head). */
  key: string;
  /** The panels whose area it is drawn in (every panel for an overlay that floats over the page; 'page' without any). */
  regions: readonly string[];
  /** clipFlashSwings. */
  swings: number;
}

/** One drawn target's flashes: its clips' swings added up and paired (as if they all played at once). */
export interface FlashTarget {
  /** motionTargetKey of the drawn target (a balloon chain by its head). */
  key: string;
  hz: number;
  clipIds: string[];
}
/** One panel's area: the flashes of every clip drawn in it, added up (LEAD TO CONFIRM). */
export interface FlashRegion {
  /** The panel id ('page' on a page without panels). */
  region: string;
  hz: number;
  clipIds: string[];
}
export interface PageFlashCheck {
  ok: boolean;
  /** The worst rate: a target's or a panel area's. */
  hz: number;
  /** Every target with a flash, worst first. */
  targets: FlashTarget[];
  /** Every panel area with a flash, worst first. */
  regions: FlashRegion[];
}
export interface FlashVerdict extends PageFlashCheck {
  /** The entries (by index) a player draws with their visibility held: every clip on a target past the limit, and
   *  every flashing clip in a panel area past it. Empty when ok. */
  held: Set<number>;
}

const worstFirst = <T extends { hz: number }>(list: T[], name: (t: T) => string): T[] =>
  list.sort((a, b) => b.hz - a.hz || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));

/** The flash rule over a page's entries: the target and panel-area rates, and what a player must hold. */
export const flashVerdict = (entries: readonly FlashEntry[]): FlashVerdict => {
  const byKey = new Map<string, { swings: number; clipIds: string[]; at: number[] }>();
  const byRegion = new Map<string, { hz: number; clipIds: string[]; at: number[] }>();
  entries.forEach((e, i) => {
    if (!(e.swings > 0)) return;
    const t = byKey.get(e.key) ?? { swings: 0, clipIds: [], at: [] };
    t.swings += e.swings;
    t.clipIds.push(e.clip.id);
    t.at.push(i);
    byKey.set(e.key, t);
    const flashes = Math.floor(e.swings / 2);
    if (flashes <= 0) return;
    for (const region of new Set(e.regions)) {
      const r = byRegion.get(region) ?? { hz: 0, clipIds: [], at: [] };
      r.hz += flashes;
      r.clipIds.push(e.clip.id);
      r.at.push(i);
      byRegion.set(region, r);
    }
  });
  const held = new Set<number>();
  const max = MOTION_LIMITS.flashHzMax;
  const targets: FlashTarget[] = [];
  for (const [key, t] of byKey) {
    const hz = Math.floor(t.swings / 2);
    if (hz > max) for (const i of entries.keys()) if (entries[i].key === key) held.add(i);
    if (hz > 0) targets.push({ key, hz, clipIds: t.clipIds });
  }
  const regions: FlashRegion[] = [];
  for (const [region, r] of byRegion) {
    if (r.hz > max) for (const i of r.at) held.add(i);
    regions.push({ region, hz: r.hz, clipIds: r.clipIds });
  }
  worstFirst(targets, (t) => t.key);
  worstFirst(regions, (r) => r.region);
  const hz = Math.max(targets[0]?.hz ?? 0, regions[0]?.hz ?? 0);
  return { ok: hz <= max, hz, targets, regions, held };
};

/** The key a clip's target is drawn under on its page: a line in a linked chain is drawn (and so flashes) with its head. */
const drawnKeyOf = (clip: MotionClip, heads: Map<string, string>): string =>
  clip.target?.k === 'line' ? motionTargetKey({ k: 'line', id: heads.get(clip.target.id) ?? clip.target.id }) : motionTargetKey(clip.target);

/**
 * The panels a target is drawn in: a line's (its chain head's) panel, a panel itself, an overlay's clip panel. An
 * unclipped overlay, or a target this page cannot place (dangling: it may come back), counts in every panel.
 */
export const flashRegionsOf = (
  page: Pick<Page, 'panels'> & Partial<Pick<Page, 'layers'>>,
  heads: Map<string, string> = new Map()
): ((target: MotionClip['target']) => string[]) => {
  const panelIds = (page.panels || []).map((p) => p.id);
  const all = panelIds.length ? panelIds : ['page'];
  const panelOfLine = new Map<string, string>();
  for (const panel of page.panels || []) for (const l of panel.lines || []) if (!panelOfLine.has(l.id)) panelOfLine.set(l.id, panel.id);
  const clipOf = new Map<string, string | undefined>();
  for (const layer of page.layers || []) if (layer && !clipOf.has(layer.id)) clipOf.set(layer.id, layer.clip);
  const known = new Set(panelIds);
  return (target) => {
    if (!target || typeof target.id !== 'string') return all;
    if (target.k === 'panel') return [target.id];
    if (target.k === 'line') {
      const panel = panelOfLine.get(heads.get(target.id) ?? target.id);
      return panel ? [panel] : all;
    }
    const clip = clipOf.get(target.id);
    return clip && known.has(clip) ? [clip] : all;
  };
};

/**
 * The page check against MOTION_LIMITS.flashHzMax (PE-SERVER refuses a page that fails it): every drawn target, and
 * every panel's area, at or under the limit (flashVerdict). Only the first MOTION_LIMITS.clipsPerPage clips count
 * (players read no more). Clips on a target this page does not have still count (undo can bring it back).
 */
export const pageFlashCheck = (page: Pick<Page, 'motion' | 'panels' | 'balloons'> & Partial<Pick<Page, 'layers'>>): PageFlashCheck => {
  const clips = (page.motion?.clips || []).slice(0, MOTION_LIMITS.clipsPerPage);
  const heads = lineChainHeads(page);
  const regionsOf = flashRegionsOf(page, heads);
  const entries: FlashEntry[] = [];
  for (const clip of clips) {
    if (!clip?.target) continue;
    entries.push({ clip, key: drawnKeyOf(clip, heads), regions: regionsOf(clip.target), swings: clipFlashSwings(clip) });
  }
  const { ok, hz, targets, regions } = flashVerdict(entries);
  return { ok, hz, targets, regions };
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
