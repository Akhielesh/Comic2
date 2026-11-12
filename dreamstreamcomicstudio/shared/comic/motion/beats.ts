// Pro Edit motion: reading beats (master plan §2.5 "Time anchored to reading beats", graft 9; PE-MOTION-ENGINE).
//
// The beat math of the motion-comic export (components/comicstudio/export/motionComic.ts buildMotionTimeline), lifted
// into shared so the editor preview, the MP4 and the server time a page the same way:
//   - a 1300 ms page overview;
//   - panels in the page's VISUAL reading order (shared/comic/readingOrder.ts panelReadingOrder: rows from the top,
//     right to left for an RTL book), never the written order;
//   - reveals start 450 ms into a panel shot, one line after another at 210 words a minute, never under 650 ms;
//   - a panel lasts 450 ms + its reading + 500 ms, at least its shot type's hold (AV-0: an establishing shot 3.5 s, a
//     splash or large panel +1 s) and the 1800 ms floor, at most 7500 ms.
// pageBeats equals buildMotionTimeline's shots for every page (beats.test.ts, the golden); the hold constants mirror
// motionComic.ts's exports exactly (a parity test pins them) until PE-MOTION-EXPORT / AV-1 import them from here.
//
// A clip's time is its anchor (a line's reveal, a panel's shot, the page's start) plus its offset, so when dialogue grows
// the reveal moves and the clip moves with it. Pure: no DOM, no clock.

import type { Box, ComicDoc, Page, Panel, PanelSize, ShotType } from '../doc.js';
import { MOTION_LIMITS } from '../limits.js';
import { panelBoxesFor } from '../pageGeometry.js';
import { panelReadingOrder } from '../readingOrder.js';

/** The whole page on screen before the first panel. */
export const PAGE_OVERVIEW_MS = 1300;
/** A panel's reveals start this far into its shot (the camera settles first). */
export const REVEAL_LEAD_MS = 450;
/** A panel stays this long after its last line has been read. */
export const PANEL_TAIL_MS = 500;
/** Every panel lasts at least this long, at most PANEL_MAX_MS. */
export const PANEL_MIN_MS = 1800;
export const PANEL_MAX_MS = 7500;
/** Reading speed, and the least time any line is given. */
export const READ_WPM = 210;
export const READ_MIN_MS = 650;

const FULL: Box = { x: 0, y: 0, w: 1, h: 1 };
const words = (text: string) => (text.match(/\S+/g) || []).length;
const textOf = (line: { text?: unknown }): string => (typeof line.text === 'string' ? line.text : '');

/** How long a reader needs for a line (ms), never under a beat (motionComic.ts readMs, same numbers). */
export const readMs = (text: string, wpm = READ_WPM): number => Math.max(READ_MIN_MS, Math.round((words(text) * 60_000) / wpm));

/**
 * The least time a panel stays on screen, by its planned shot (av.md §5.3). Mirrors motionComic.ts SHOT_MIN_HOLD_MS
 * (frozen in S2b; PE-MOTION-EXPORT / AV-1 import it from here): a parity test deep-equals the two.
 */
export const SHOT_MIN_HOLD_MS: Readonly<Record<ShotType, number>> = {
  establishing: 3500,
  wide: 3000,
  full: 2600,
  medium: 2200,
  close_up: 2200,
  extreme_close_up: 1800,
  over_shoulder: 2200,
  insert: 1800,
  pov: 2200
};

/** Extra hold for the big panels a page is built around (av.md §5.3 "splash and large add 1 s"). */
export const SIZE_HOLD_BONUS_MS: Readonly<Partial<Record<PanelSize, number>>> = { splash: 1000, large: 1000 };

/** True only for a table's OWN key: an inherited name ('constructor', 'toString') must not read as a shot or size. */
const ownKey = (table: object, key: unknown): boolean => typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);

/**
 * A panel's minimum hold (ms) from its shot and size. An unknown shot gets the medium hold and an unknown size no
 * bonus, so a duration is never NaN (motionComic.ts panelHoldMs, same rule).
 */
export const panelHoldMs = (panel: Pick<Panel, 'shot' | 'size'>): number =>
  (ownKey(SHOT_MIN_HOLD_MS, panel.shot) ? SHOT_MIN_HOLD_MS[panel.shot] : SHOT_MIN_HOLD_MS.medium) +
  (ownKey(SIZE_HOLD_BONUS_MS, panel.size) ? (SIZE_HOLD_BONUS_MS[panel.size] ?? 0) : 0);

/** The export's timeline options a page's beats depend on (same names and defaults as motionComic.ts TimelineOptions). */
export interface BeatOptions {
  minPanelMs?: number;
  maxPanelMs?: number;
  wordsPerMinute?: number;
  pageOverviewMs?: number;
  /** Hold each panel at least its shot type's minimum (default true, as the export). */
  shotHolds?: boolean;
}

/** One line's reveal on its page. */
export interface LineBeat {
  lineId: string;
  panelId: string;
  /** Milliseconds from the page's start. */
  atMs: number;
}

/** One panel's shot on its page (the export's MotionShot of kind 'panel', timed from the page's start). */
export interface PanelBeat {
  panelId: string;
  /** Index in page.panels (the written order). */
  index: number;
  panelN: number;
  /** Page-normalized region the camera frames (the whole page when the panel has no usable box). */
  box: Box;
  /** Milliseconds from the page's start. */
  startMs: number;
  durationMs: number;
  /** Lines revealed in this shot, in reveal order, with their offset into the shot (MotionShot.reveals). */
  reveals: { lineId: string; atMs: number }[];
  /** Lines revealed by earlier shots on the page (MotionShot.carried). */
  carried: string[];
}

/** A page's reading beats: the overview, then each panel in reading order. Milliseconds from the page's start. */
export interface PageBeats {
  pageId: string;
  overviewMs: number;
  /** Reading order. */
  panels: PanelBeat[];
  /** Every revealed line (overlay lettering only), in reveal order. */
  lines: LineBeat[];
  /** When the last panel ends (the export's page length). */
  beatsMs: number;
  /** The page's own hold after its last beat (Page.motion.hold, clamped to MOTION_LIMITS.holdMaxMs). */
  holdMs: number;
  /** beatsMs + holdMs. */
  totalMs: number;
}

/** A finite number in lo..hi, or `fallback`. */
const inRange = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/**
 * A page's reading beats, exactly as the motion-comic export times it (buildMotionTimeline's page and panel shots, from
 * the page's start). Every page gets beats, drawn or not (the export only plays drawn pages). Overlay lettering reveals
 * its lines; in-art lettering only holds each panel long enough to read.
 */
export function pageBeats(doc: Pick<ComicDoc, 'format'>, page: Page, opts: BeatOptions = {}): PageBeats {
  const minPanel = opts.minPanelMs ?? PANEL_MIN_MS;
  const maxPanel = opts.maxPanelMs ?? PANEL_MAX_MS;
  const wpm = opts.wordsPerMinute ?? READ_WPM;
  const overview = opts.pageOverviewMs ?? PAGE_OVERVIEW_MS;
  const shotHolds = opts.shotHolds !== false;
  const rtl = doc.format.readingDirection === 'rtl';
  const overlay = doc.format.lettering === 'overlay';
  const boxes = panelBoxesFor(doc, page);
  const panels: PanelBeat[] = [];
  const lines: LineBeat[] = [];
  const carried: string[] = [];
  let t = overview;
  for (const i of panelReadingOrder(boxes, page.panels.length, rtl)) {
    const panel = page.panels[i];
    const b = boxes[i];
    const box = b && b.w > 0 && b.h > 0 ? b : FULL;
    const spoken = (panel.lines || []).filter((l) => textOf(l).trim());
    let at = REVEAL_LEAD_MS;
    const reveals = overlay
      ? spoken.map((l) => {
          const reveal = { lineId: l.id, atMs: at };
          at += readMs(textOf(l), wpm);
          return reveal;
        })
      : [];
    const reading = spoken.reduce((ms, l) => ms + readMs(textOf(l), wpm), 0);
    const floor = shotHolds ? Math.max(minPanel, panelHoldMs(panel)) : minPanel;
    const durationMs = Math.min(maxPanel, Math.max(floor, REVEAL_LEAD_MS + reading + PANEL_TAIL_MS));
    panels.push({ panelId: panel.id, index: i, panelN: panel.n, box, startMs: t, durationMs, reveals, carried: [...carried] });
    for (const r of reveals) lines.push({ lineId: r.lineId, panelId: panel.id, atMs: t + r.atMs });
    carried.push(...reveals.map((r) => r.lineId));
    t += durationMs;
  }
  const holdMs = Math.round(inRange(page.motion?.hold, 0, MOTION_LIMITS.holdMaxMs, 0));
  return { pageId: page.id, overviewMs: overview, panels, lines, beatsMs: t, holdMs, totalMs: t + holdMs };
}

/** The panel shot of `panelId` (undefined when the page has no such panel). */
export const panelBeatOf = (beats: PageBeats, panelId: string): PanelBeat | undefined => beats.panels.find((p) => p.panelId === panelId);

/** When `lineId` is revealed, ms from the page's start (undefined for a line with no reveal: empty, or in-art lettering). */
export const lineRevealMs = (beats: PageBeats, lineId: string): number | undefined => beats.lines.find((l) => l.lineId === lineId)?.atMs;

/** The panel shot on screen at `ms` (undefined during the overview and after the last panel). */
export const panelBeatAt = (beats: PageBeats, ms: number): PanelBeat | undefined =>
  beats.panels.find((p) => ms >= p.startMs && ms < p.startMs + p.durationMs);

/**
 * Linked balloons (speech chains; Balloon.linkTo points to the PREVIOUS line, so l1 ← l2 ← l3) by their head, the line
 * the chain starts from. The lettering draws a chain as ONE group (svgMarkup `data-link-group`), so motion keys and
 * moves a chain by its head. Groups are joined the way the lettering joins them (svgMarkup groupsOf: every link
 * between two lines on the page joins their groups). The head is the member that links to no one, the first in the
 * page's balloon order; a malformed cycle (every member links on) falls back to its first member, so the answer is the
 * same on every run. Only lines in a chain of two or more appear; a link to a line that is not on the page is ignored.
 */
export const lineChainHeads = (page: Pick<Page, 'panels' | 'balloons'>): Map<string, string> => {
  const lineIds = new Set<string>();
  for (const panel of page.panels || []) for (const l of panel.lines || []) lineIds.add(l.id);
  const linkOf = new Map<string, string | undefined>();
  for (const b of page.balloons || []) {
    if (!b || !lineIds.has(b.lineId) || linkOf.has(b.lineId)) continue;
    linkOf.set(b.lineId, typeof b.linkTo === 'string' ? b.linkTo : undefined);
  }
  const order = [...linkOf.keys()];
  const parent = new Map(order.map((id) => [id, id]));
  const find = (id: string): string => {
    let cur = id;
    while (parent.get(cur) !== cur) cur = parent.get(cur)!;
    let walk = id;
    while (parent.get(walk) !== cur) {
      const next = parent.get(walk)!;
      parent.set(walk, cur);
      walk = next;
    }
    return cur;
  };
  const links = (id: string): boolean => {
    const to = linkOf.get(id);
    return !!to && to !== id && linkOf.has(to);
  };
  for (const id of order) if (links(id)) parent.set(find(id), find(linkOf.get(id)!));
  const groups = new Map<string, string[]>();
  for (const id of order) groups.set(find(id), [...(groups.get(find(id)) || []), id]);
  const out = new Map<string, string>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const head = members.find((id) => !links(id)) ?? members[0];
    for (const id of members) out.set(id, head);
  }
  return out;
};
