// Where a comic stands (SH-A): one of five stages, how far along the stage is, and the one next step. Pure and
// server-safe, so the studio (from the full doc) and every list (from the small summary the server stores on save,
// workspaceActivity.ts) read the same words.
//
// The order follows the real flow, not the board's tabs: the Director's rule is "idea → style → plan_pages → pages"
// (server/src/comic/director.ts) and "Draft it for me" sets the look before it plans (directorDraft.ts), so a look
// comes before the plan. Each stage has its own done flag and the current stage is the first one not done, so a
// hands-on comic that planned first reads "Style" with Plan already ticked, and nothing ever claims a stage early.
//
// The next step only navigates (a board tab, the conversation or the composer). It never carries an action, so it
// can never start anything that spends.

import type { ComicDoc, Page, RenderState } from './doc.js';
import { progressState } from './renderOutcome.js';
import { canServeToOwner } from './safety.js';

export const COMIC_STAGES = ['story', 'style', 'plan', 'draw', 'publish'] as const;
export type ComicStage = (typeof COMIC_STAGES)[number];

/** Where a step is worked: a board tab, the conversation, or the composer (the conversation, ready to type). */
export type StagePlace = 'story' | 'style' | 'pages' | 'read' | 'conversation' | 'composer';

export const STAGE_LABEL: Readonly<Record<ComicStage, string>> = { story: 'Story', style: 'Style', plan: 'Plan', draw: 'Draw', publish: 'Publish' };

/** The board tab each stage is worked in (boardNavigation.tsx BOARD_TABS). */
export const STAGE_PLACE: Readonly<Record<ComicStage, Extract<StagePlace, 'story' | 'style' | 'pages' | 'read'>>> = {
  story: 'story',
  style: 'style',
  plan: 'pages',
  draw: 'pages',
  publish: 'read'
};

export const STAGE_NEXT_KEYS = [
  'review_estimate',
  'resume_draft',
  'tell_story',
  'choose_look',
  'pick_look',
  'follow_planning',
  'plan_pages',
  'plan_rest',
  'review_plan',
  'watch_drawing',
  'review_withheld',
  'review_failed',
  'draw_pages',
  'draw_rest',
  'publish',
  'update_published',
  'read'
] as const;
export type StageNextKey = (typeof STAGE_NEXT_KEYS)[number];

/**
 * The facts a stage is read from: counts and keys only (no text, prices, prompts or paths), small enough for the
 * private listing summary. `done` lists the finished stages in stage order.
 */
export interface StageFacts {
  v: 1;
  stage: ComicStage;
  done: ComicStage[];
  /** Pages in the book. */
  pages: number;
  /** Pages with a plan (panels) or a picture. */
  planned: number;
  /** Pages with a picture the owner can be served. */
  drawn: number;
  /** Pages queued or drawing without a picture yet. */
  drawing: number;
  /** Pages whose only picture is withheld by the content check. */
  withheld: number;
  /** Pages whose drawing failed and that have no picture. */
  failed: number;
  /** Drawn looks waiting to be picked (the look is not set yet). */
  looks: number;
  next: StageNextKey;
}

export interface StageStep {
  stage: ComicStage;
  label: string;
  done: boolean;
  current: boolean;
  /** Where the stage is worked. */
  place: StagePlace;
}

export interface StageView {
  stage: ComicStage;
  /** Every stage is done: the comic is drawn and published. */
  complete: boolean;
  steps: StageStep[];
  /** "Drawing", "Ready to publish", "Published". */
  word: string;
  /** "6 of 12 pages drawn". */
  progress: string;
  next: { key: StageNextKey; label: string; place: StagePlace };
  /** "Drawing · 6 of 12 pages drawn" (lists). */
  summary: string;
  /** "Drawing · 6 of 12 pages drawn · Next: draw the rest" (the studio's status line). */
  line: string;
}

/** What a list shows for a comic whose stored summary predates stages (or is unreadable). Never a guessed stage. */
export const STAGE_UNKNOWN = 'Open to see';

// ── From the doc ─────────────────────────────────────────────────────────────

const text = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
const list = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);

type PagePicture = 'drawn' | 'drawing' | 'withheld' | 'failed' | 'none';

/** Where one page stands. A redraw in flight, or one that failed, still has the earlier picture on the page. */
const pagePicture = (render: RenderState | undefined): PagePicture => {
  const state = progressState(render);
  if (state === 'drawn') return 'drawn';
  if (state === 'withheld') return 'withheld';
  const servable = !!render?.asset && canServeToOwner(render.asset);
  if (state === 'drawing' || state === 'queued') return servable ? 'drawn' : 'drawing';
  if (state === 'failed') return servable ? 'drawn' : render?.asset ? 'withheld' : 'failed';
  return 'none';
};

const plannedPage = (page: Page | undefined): boolean => list(page?.panels).length > 0 || !!page?.render?.asset;

/** A published comic with a page or the cover drawn after it was published (the server's chip rule, jobs.ts). */
const publicationBehind = (doc: ComicDoc): boolean => {
  const at = doc.publication?.publishedAt || 0;
  const newer = (r: RenderState | undefined) => !!r && r.status === 'ready' && (r.updatedAt || 0) > at;
  return list(doc.pages).some((p) => newer(p?.render)) || newer(doc.cover?.render);
};

/** The stage facts of a doc. Never throws: an older or partial doc reads as far as its fields go. */
export function stageFacts(doc: ComicDoc): StageFacts {
  const pages = list(doc?.pages);
  let planned = 0;
  let drawn = 0;
  let drawing = 0;
  let withheld = 0;
  let failed = 0;
  for (const page of pages) {
    if (plannedPage(page)) planned += 1;
    const picture = pagePicture(page?.render);
    if (picture === 'drawn') drawn += 1;
    else if (picture === 'drawing') drawing += 1;
    else if (picture === 'withheld') withheld += 1;
    else if (picture === 'failed') failed += 1;
  }
  const looks = list(doc?.style?.options).filter((o) => progressState(o?.render) === 'drawn').length;
  const attempted = drawn + drawing + withheld + failed > 0;
  const planStatus = doc?.planStatus;

  const isDone: Record<ComicStage, boolean> = {
    story: text(doc?.brief?.premise) || text(doc?.brief?.logline) || text(doc?.source?.script) || pages.length > 0,
    style: text(doc?.style?.spec) || drawn > 0,
    plan: pages.length > 0 && planned === pages.length && (planStatus === 'approved' || attempted),
    draw: pages.length > 0 && drawn === pages.length,
    publish: doc?.publication?.status === 'live'
  };
  const done = COMIC_STAGES.filter((s) => isDone[s]);
  const stage = COMIC_STAGES.find((s) => !isDone[s]) ?? 'publish';
  const complete = done.length === COMIC_STAGES.length;

  const next = ((): StageNextKey => {
    if (doc?.gate?.status === 'open') return 'review_estimate';
    if (doc?.directorDraft?.status === 'interrupted') return 'resume_draft';
    switch (stage) {
      case 'story':
        return 'tell_story';
      case 'style':
        return looks > 0 ? 'pick_look' : 'choose_look';
      case 'plan':
        if (doc?.directorDraft?.status === 'planning') return 'follow_planning';
        if (!pages.length) return 'plan_pages';
        return planned < pages.length ? 'plan_rest' : 'review_plan';
      case 'draw':
        if (drawing) return 'watch_drawing';
        if (withheld) return 'review_withheld';
        if (failed) return 'review_failed';
        return drawn ? 'draw_rest' : 'draw_pages';
      default:
        if (!complete) return 'publish';
        return publicationBehind(doc) ? 'update_published' : 'read';
    }
  })();
  return { v: 1, stage, done, pages: pages.length, planned, drawn, drawing, withheld, failed, looks, next };
}

// ── From a stored summary ────────────────────────────────────────────────────

const STAGE_SET: ReadonlySet<string> = new Set(COMIC_STAGES);
const NEXT_SET: ReadonlySet<string> = new Set(STAGE_NEXT_KEYS);
/** The stage each next step belongs to (the two waiting steps belong to any stage). */
const NEXT_STAGE: Readonly<Partial<Record<StageNextKey, ComicStage>>> = {
  tell_story: 'story',
  choose_look: 'style',
  pick_look: 'style',
  follow_planning: 'plan',
  plan_pages: 'plan',
  plan_rest: 'plan',
  review_plan: 'plan',
  watch_drawing: 'draw',
  review_withheld: 'draw',
  review_failed: 'draw',
  draw_pages: 'draw',
  draw_rest: 'draw',
  publish: 'publish',
  update_published: 'publish',
  read: 'publish'
};
/** Far above any book (DOC_LIMITS.pages); a larger stored count is not ours. */
const COUNT_MAX = 10_000;
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= COUNT_MAX ? v : null);

/**
 * Stored stage facts, validated, or null. Anything unexpected reads as null, so a list shows STAGE_UNKNOWN rather than a
 * wrong stage: an unknown stage or step, a count out of range, a current stage that is not the first one not done, a done
 * flag the counts contradict (Draw done with a page undrawn), or a next step from another stage.
 */
export function readStageFacts(value: unknown): StageFacts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1 || typeof raw.stage !== 'string' || !STAGE_SET.has(raw.stage)) return null;
  if (typeof raw.next !== 'string' || !NEXT_SET.has(raw.next)) return null;
  if (!Array.isArray(raw.done) || !raw.done.every((s) => typeof s === 'string' && STAGE_SET.has(s))) return null;
  const doneSet = new Set(raw.done as string[]);
  const done = COMIC_STAGES.filter((s) => doneSet.has(s));
  if (done.length !== raw.done.length) return null; // a repeated stage
  const pages = count(raw.pages);
  const planned = count(raw.planned);
  const drawn = count(raw.drawn);
  const drawing = count(raw.drawing);
  const withheld = count(raw.withheld);
  const failed = count(raw.failed);
  const looks = count(raw.looks);
  if (pages === null || planned === null || drawn === null || drawing === null || withheld === null || failed === null || looks === null) return null;
  if (planned > pages || drawn + drawing + withheld + failed > pages) return null;
  // The done flags the counts decide.
  if (doneSet.has('draw') !== (pages > 0 && drawn === pages)) return null;
  if (doneSet.has('plan') && (pages === 0 || planned < pages)) return null;
  if (!doneSet.has('story') && pages > 0) return null;
  if (!doneSet.has('style') && drawn > 0) return null;
  const stage = raw.stage as ComicStage;
  const expected = COMIC_STAGES.find((s) => !doneSet.has(s)) ?? 'publish';
  if (stage !== expected) return null;
  const next = raw.next as StageNextKey;
  const nextStage = NEXT_STAGE[next];
  if (nextStage && nextStage !== stage) return null;
  const complete = done.length === COMIC_STAGES.length;
  if ((next === 'publish' && complete) || ((next === 'read' || next === 'update_published') && !complete)) return null;
  if ((next === 'review_withheld' && !withheld) || (next === 'review_failed' && !failed) || (next === 'pick_look' && !looks)) return null;
  return { v: 1, stage, done, pages, planned, drawn, drawing, withheld, failed, looks, next };
}

// ── Words ────────────────────────────────────────────────────────────────────

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

const NEXT_PLACE: Readonly<Record<StageNextKey, StagePlace>> = {
  review_estimate: 'conversation',
  resume_draft: 'conversation',
  tell_story: 'composer',
  choose_look: 'style',
  pick_look: 'style',
  follow_planning: 'conversation',
  plan_pages: 'pages',
  plan_rest: 'pages',
  review_plan: 'pages',
  watch_drawing: 'pages',
  review_withheld: 'pages',
  review_failed: 'pages',
  draw_pages: 'pages',
  draw_rest: 'pages',
  publish: 'read',
  update_published: 'read',
  read: 'read'
};

const nextLabel = (facts: StageFacts): string => {
  switch (facts.next) {
    case 'review_estimate':
      return 'Review the estimate';
    case 'resume_draft':
      return 'Resume the draft';
    case 'tell_story':
      return 'Tell the Director your idea';
    case 'choose_look':
      return 'Choose a look';
    case 'pick_look':
      return 'Pick a look';
    case 'follow_planning':
      return 'Follow the Director';
    case 'plan_pages':
      return 'Plan the pages';
    case 'plan_rest':
      return 'Plan the rest';
    case 'review_plan':
      return 'Review the plan';
    case 'watch_drawing':
      return 'Watch the pages draw';
    case 'review_withheld':
      return `Review ${plural(facts.withheld, 'withheld page')}`;
    case 'review_failed':
      return facts.failed === 1 ? 'Review the page that didn’t draw' : `Review ${facts.failed} pages that didn’t draw`;
    case 'draw_pages':
      return 'Draw the pages';
    case 'draw_rest':
      return 'Draw the rest';
    case 'publish':
      return 'Read and publish';
    case 'update_published':
      return 'Update the published comic';
    case 'read':
      return 'Read your comic';
  }
};

const progressWords = (facts: StageFacts): string => {
  switch (facts.stage) {
    case 'story':
      return 'Not started';
    case 'style':
      return facts.looks > 0 ? `${plural(facts.looks, 'look')} to compare` : 'Not chosen yet';
    case 'plan':
      if (facts.next === 'follow_planning') return 'The Director is planning';
      if (!facts.pages) return 'No pages planned yet';
      return facts.planned < facts.pages ? `${facts.planned} of ${plural(facts.pages, 'page')} planned` : `${plural(facts.pages, 'page')} planned`;
    case 'draw':
      return `${facts.drawn} of ${plural(facts.pages, 'page')} drawn`;
    default:
      // Publish is current only once Draw is done, so every page is drawn here.
      return facts.pages === 1 ? '1 page drawn' : `All ${facts.pages} pages drawn`;
  }
};

const WORD: Readonly<Record<ComicStage, string>> = { story: 'Story', style: 'Style', plan: 'Planning', draw: 'Drawing', publish: 'Ready to publish' };

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The words and places for a set of stage facts (from a doc or a stored summary: the same facts read the same). */
export function stageView(facts: StageFacts): StageView {
  const done = new Set(facts.done);
  const complete = COMIC_STAGES.every((s) => done.has(s));
  const steps = COMIC_STAGES.map((stage) => ({ stage, label: STAGE_LABEL[stage], done: done.has(stage), current: stage === facts.stage, place: STAGE_PLACE[stage] }));
  const word = complete ? 'Published' : WORD[facts.stage];
  const progress = progressWords(facts);
  const label = nextLabel(facts);
  const summary = `${word} · ${progress}`;
  return {
    stage: facts.stage,
    complete,
    steps,
    word,
    progress,
    next: { key: facts.next, label, place: NEXT_PLACE[facts.next] },
    summary,
    line: `${summary} · Next: ${lowerFirst(label)}`
  };
}

/** The doc's stage, in words. */
export const comicStage = (doc: ComicDoc): StageView => stageView(stageFacts(doc));

/** A list's one line for stored facts: "Drawing · 6 of 12 pages drawn", or STAGE_UNKNOWN when none are readable. */
export const stageSummaryOf = (stored: unknown): string => {
  const facts = readStageFacts(stored);
  return facts ? stageView(facts).summary : STAGE_UNKNOWN;
};
