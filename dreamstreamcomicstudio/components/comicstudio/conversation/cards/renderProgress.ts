// Where one run of images stands, read from the stored doc (quick2 Q-PROG). The renders card shows a run of several
// pages as ONE compact progress card ("Drawing pages · 3 of 8 · page 4 · 12s", a thin bar, one strip of thumbnails),
// a failure as one quiet line ("Page 5 didn't draw · rate limited"), and a finished run as one line ("8 pages drawn").
// Every word comes from here, pure, so the card, its tests and a remount (the studio reloading the doc) agree.
//
// "Drawn" means this run drew a picture the owner can see. A take the content check blocked is stored as ready, but
// it reads "withheld"; a ready target whose picture predates the run (the card's `since`: a stopped redraw put the
// earlier one back, an earlier take was reused, a failed redraw kept the old one) reads "earlier picture".

import { findPage, getRender, renderTargetKey, type ComicDoc, type RenderState, type RenderTarget } from '../../../../shared/comic/doc';
import { progressState, type ProgressState } from '../../../../shared/comic/renderOutcome';
import { listWords } from '../../../../shared/comic/settle';
import { failureFacts, failureKind, failureReason } from './failure';
import { describeTarget, tileProgress, type TargetMeta } from './renderTile';

export { listWords };

export { progressState, type ProgressState };

export interface ProgressItem {
  key: string;
  target: RenderTarget;
  render?: RenderState;
  meta: TargetMeta;
  state: ProgressState;
  /** The page number (pages only). */
  n?: number;
}

/** What the run draws, as the card names it. */
export type RunKind = 'pages' | 'pagesCover' | 'sheets' | 'places' | 'cast' | 'styles' | 'cover' | 'mixed';

export interface RunProgress {
  /** Targets still in the comic, in the run's order. */
  items: ProgressItem[];
  total: number;
  drawn: number;
  /** Ready, but the content check blocked the picture. */
  withheld: number;
  /** Ready with a picture from before the run. */
  kept: number;
  /** Drawing right now, in the run's order. */
  drawing: ProgressItem[];
  queued: number;
  failed: ProgressItem[];
  /** Never started or stopped. */
  idle: number;
  /** Something is still queued or drawing. */
  busy: boolean;
  kind: RunKind;
}

const isTarget = (t: unknown): t is RenderTarget => !!t && typeof t === 'object' && typeof (t as { kind?: unknown }).kind === 'string';

const kindOf = (items: ProgressItem[]): RunKind => {
  const kinds = new Set(items.map((i) => i.target.kind));
  const only = (...ks: RenderTarget['kind'][]) => [...kinds].every((k) => ks.includes(k));
  if (only('page')) return 'pages';
  if (only('page', 'cover')) return kinds.has('page') ? 'pagesCover' : 'cover';
  if (only('sheet')) return 'sheets';
  if (only('place')) return 'places';
  if (only('sheet', 'place')) return 'cast';
  if (only('style_option')) return 'styles';
  return 'mixed';
};

/** The run's state over the current doc (targets gone from the comic are left out). */
export const runProgress = (doc: ComicDoc, targets: unknown, since?: number): RunProgress => {
  const items: ProgressItem[] = [];
  for (const target of Array.isArray(targets) ? targets : []) {
    if (!isTarget(target)) continue;
    const meta = describeTarget(doc, target);
    if (!meta) continue;
    const render = getRender(doc, target);
    const n = target.kind === 'page' ? findPage(doc, target.id)?.n : undefined;
    items.push({ key: renderTargetKey(target), target, render, meta, state: progressState(render, since), ...(typeof n === 'number' ? { n } : {}) });
  }
  const count = (s: ProgressState) => items.filter((i) => i.state === s).length;
  const drawing = items.filter((i) => i.state === 'drawing');
  const queued = count('queued');
  return {
    items,
    total: items.length,
    drawn: count('drawn'),
    withheld: count('withheld'),
    kept: count('kept'),
    drawing,
    queued,
    failed: items.filter((i) => i.state === 'failed'),
    idle: count('idle'),
    busy: drawing.length + queued > 0,
    kind: kindOf(items)
  };
};

// ── Words ─────────────────────────────────────────────────────────────────────

export const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Page numbers as a reader says them: "4", "4 and 5", "4–6", "2, 4–6 and 9"; past four groups, null (say a count). */
export const pageNumbers = (ns: number[]): string | null => {
  const sorted = [...new Set(ns)].sort((a, b) => a - b);
  const groups: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    // Two in a row read better as "4 and 5" than "4–5".
    if (j - i >= 2) groups.push(`${sorted[i]}–${sorted[j]}`);
    else for (let k = i; k <= j; k += 1) groups.push(String(sorted[k]));
    i = j + 1;
  }
  return groups.length <= 4 ? listWords(groups) : null;
};

/** Short names for the "now" part of the headline: "page 4", "pages 4 and 5", "the cover", "Maya". */
const shortNames = (items: ProgressItem[]): string => {
  const pages = items.filter((i) => i.target.kind === 'page' && typeof i.n === 'number').map((i) => i.n as number);
  const parts: string[] = [];
  if (pages.length) {
    const ns = pageNumbers(pages);
    parts.push(ns ? `${pages.length === 1 ? 'page' : 'pages'} ${ns}` : `${pages.length} pages`);
  }
  for (const i of items) {
    if (i.target.kind === 'page') continue;
    parts.push(i.target.kind === 'cover' ? 'the cover' : i.meta.label);
  }
  return parts.length > 3 ? `${items.length} images` : listWords(parts);
};

/** One target in a sentence: "page 4", "the cover", "Maya’s sheet", "the harbour", "“Retro”". */
export const itemName = (item: ProgressItem): string => {
  switch (item.target.kind) {
    case 'page':
      return typeof item.n === 'number' ? `page ${item.n}` : item.meta.label.toLowerCase();
    case 'cover':
      return 'the cover';
    case 'sheet':
      return `${item.meta.label}’s sheet`;
    case 'style_option':
      return `“${item.meta.label}”`;
    default:
      return item.meta.label;
  }
};

/** What the run draws, in its headline: "pages", "the pages and cover", "character sheets", … */
export const runNoun = (kind: RunKind): string => {
  switch (kind) {
    case 'pages':
      return 'pages';
    case 'pagesCover':
      return 'the pages and cover';
    case 'sheets':
      return 'character sheets';
    case 'places':
      return 'places';
    case 'cast':
      return 'sheets';
    case 'styles':
      return 'style options';
    case 'cover':
      return 'the cover';
    default:
      return 'images';
  }
};

/** A count of the run's kind: "8 pages", "3 style options", "9 images". */
const countOf = (n: number, kind: RunKind): string => {
  const word: Record<RunKind, [string, string]> = {
    pages: ['page', 'pages'],
    pagesCover: ['image', 'images'],
    sheets: ['character sheet', 'character sheets'],
    places: ['place', 'places'],
    cast: ['sheet', 'sheets'],
    styles: ['style option', 'style options'],
    cover: ['image', 'images'],
    mixed: ['image', 'images']
  };
  const [one, many] = word[kind];
  return `${n} ${n === 1 ? one : many}`;
};

export interface Headline {
  /** "Drawing pages" / "Drawing page 2". */
  what: string;
  /** "3 of 8" (several targets only). */
  count?: string;
  /** "pages 4 and 5" / "waiting to start". */
  now?: string;
  /** "12s" / "taking longer than usual". */
  time?: string;
  /** The lead drawing target is far past its usual time (the card offers "Check again"). */
  stuck?: ProgressItem;
}

/** The in-flight headline at `now` (ms): what, how far, what is drawing now and for how long. */
export const runHeadline = (p: RunProgress, now: number): Headline => {
  const lead = p.drawing[0];
  const t = lead ? tileProgress('rendering', lead.render?.updatedAt, now, lead.meta.typicalSec) : null;
  const time = t?.stuck ? undefined : t?.hint === 'taking longer than usual' ? t.hint : t?.elapsed;
  const stuck = t?.stuck ? lead : undefined;
  if (p.total === 1) {
    const only = p.items[0];
    return { what: `Drawing ${itemName(only)}`, ...(only.state === 'queued' ? { now: 'waiting to start' } : {}), ...(time ? { time } : {}), ...(stuck ? { stuck } : {}) };
  }
  return {
    what: `Drawing ${runNoun(p.kind)}`,
    count: `${p.drawn} of ${p.total}`,
    now: p.drawing.length ? shortNames(p.drawing) : p.queued ? 'waiting to start' : undefined,
    ...(time ? { time } : {}),
    ...(stuck ? { stuck } : {})
  };
};

/** The headline as one string (the card's text and its tests read the same words). */
export const headlineText = (h: Headline): string => [h.what, h.count, h.now, h.time].filter(Boolean).join(' · ');

/** The finished run: the line (ink) and what else happened (muted). */
export interface DoneLine {
  /** "8 pages drawn", "6 of 8 pages drawn", "Page 2 drawn", "3 pages not drawn", "Nothing drawn". */
  line: string;
  /** "1 withheld · 2 not drawn". */
  rest?: string;
}

const WITHHELD_WHY = 'didn’t pass the content check';
const earlier = (n: number) => `${n} ${n === 1 ? 'shows an earlier picture' : 'show earlier pictures'}`;

/**
 * The finished run in one line: "8 pages drawn", "7 of 8 pages drawn · 1 withheld", "5 of 8 pages drawn · 3 show
 * earlier pictures", "6 of 8 pages drawn · 2 not drawn", "3 pages not drawn". null when every target failed (the
 * failure line says it all). Failures are never counted here: the failure line names them.
 */
export const doneLine = (p: RunProgress): DoneLine | null => {
  if (!p.total) return null;
  if (p.failed.length === p.total) return null;
  if (p.total === 1) {
    const only = p.items[0];
    const name = capitalize(itemName(only));
    switch (only.state) {
      case 'drawn':
        return { line: `${name} drawn` };
      case 'withheld':
        return { line: `${name} was withheld`, rest: WITHHELD_WHY };
      case 'kept':
        return { line: `${name} shows an earlier picture` };
      default:
        return { line: `${name} wasn’t drawn` };
    }
  }
  if (p.drawn === p.total) {
    if (p.kind === 'pagesCover') return { line: `${countOf(p.total - 1, 'pages')} and the cover drawn` };
    return { line: `${countOf(p.total, p.kind)} drawn` };
  }
  const shown = [p.withheld ? `${p.withheld} withheld` : '', p.kept ? earlier(p.kept) : ''].filter(Boolean);
  if (p.drawn === 0) {
    // Stopped before anything landed: say it once ("3 pages not drawn"), never "0 of 3 drawn · 3 not drawn".
    if (p.idle === p.total) return { line: `${countOf(p.total, p.kind)} not drawn` };
    return { line: 'Nothing drawn', ...(shown.length ? { rest: shown.join(' · ') } : {}) };
  }
  const noun = countOf(p.total, p.kind).replace(/^\d+ /, '');
  const rest = [...shown, p.idle ? `${p.idle} not drawn` : ''].filter(Boolean);
  return { line: `${p.drawn} of ${p.total} ${noun} drawn`, ...(rest.length ? { rest: rest.join(' · ') } : {}) };
};

/** "Page 5", "Pages 5 and 7", "The cover", "“Retro”", "3 images": who didn't draw. */
export const failedNames = (failed: ProgressItem[]): string => {
  if (failed.length === 1) return capitalize(itemName(failed[0]));
  if (failed.every((f) => f.target.kind === 'page' && typeof f.n === 'number')) {
    const ns = pageNumbers(failed.map((f) => f.n as number));
    return ns ? `Pages ${ns}` : `${failed.length} pages`;
  }
  return `${failed.length} images`;
};

/** The main reason, when there is a known one: "rate limited", "timed out", … */
export const failedReason = (failed: ProgressItem[]): string | undefined => {
  const counts = new Map<string, number>();
  for (const f of failed) {
    const error = failureFacts(f.render).error;
    if (failureKind(error) === 'unknown') continue;
    const r = failureReason(error);
    counts.set(r, (counts.get(r) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/** What the Details row says about one target. */
export const stateWord = (state: ProgressState): string =>
  ({
    drawn: 'Drawn',
    withheld: `Withheld (${WITHHELD_WHY})`,
    kept: 'Earlier picture',
    drawing: 'Drawing',
    queued: 'Waiting',
    failed: 'Didn’t draw',
    idle: 'Not drawn'
  })[state];
