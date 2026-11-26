// Where a comic stands (SH-A): one of five stages, how far along the stage is, and the one next step. Pure and
// server-safe, so the studio (from the full doc) and every list (from the small summary the server stores on save,
// workspaceActivity.ts) read the same words.
//
// The order follows the real flow, not the board's tabs: the Director's rule is "idea → style → plan_pages → pages"
// (server/src/comic/director.ts) and "Draft it for me" sets the look before it plans (directorDraft.ts), so a look
// comes before the plan. Each stage has its own done flag and the current stage is the first one not done, so a
// hands-on comic that planned first reads "Style" with Plan already ticked, and nothing ever claims a stage early.
//
// The next step only navigates (a board tab, the approval or the draft in the conversation, the composer, or the Share
// sheet). It never carries an action, so it can never start anything that spends.
//
// What waits on the person (attention.ts needsYouOf: an approval, a question from the Director, the page plan's OK, a
// look to pick) is the next step whatever the stage, so the strip, the stage map, My comics' card and the side panel's
// "Needs you" row all name the one step the Director is waiting on.

import { isPageStale, type ComicDoc, type Page, type RenderState } from './doc.js';
import { needsYouOf } from './attention.js';
import { progressState } from './renderOutcome.js';
import { canServeToOwner } from './safety.js';

export const COMIC_STAGES = ['story', 'style', 'plan', 'draw', 'publish'] as const;
export type ComicStage = (typeof COMIC_STAGES)[number];

/**
 * Where a step is worked: a board tab, the open approval or the Director's draft (both in the conversation), the
 * composer (the conversation, ready to type), or the Share sheet.
 */
export type StagePlace = 'story' | 'style' | 'pages' | 'read' | 'approval' | 'draft' | 'composer' | 'share';

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
  'answer_director',
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
  'see_paused',
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
  /** Pages with a picture the owner can be served (the Draw boundary). */
  drawn: number;
  /**
   * Drawn pages whose picture is ready and matches its script: the board's own count (the Pages badge and the reader's
   * "6 of 12 pages drawn", boardModel pageProgress), so every count on a screen agrees. A redraw in flight is not current.
   */
  current: number;
  /** Drawn pages whose picture no longer matches its script (the reader's "· 1 out of date"). */
  outOfDate: number;
  /** Pages queued or drawing without a picture yet. */
  drawing: number;
  /** Pages whose only picture is withheld by the content check. */
  withheld: number;
  /** Pages whose drawing failed and that have no picture. */
  failed: number;
  /**
   * Drawn pages being drawn again (queued or drawing over a picture the owner can be served): drawn, not current. Absent
   * in summaries written before it (read as 0).
   */
  redrawing?: number;
  /** Drawn pages whose redraw failed (the earlier picture still stands): drawn, not current. Absent before it (0). */
  redrawFailed?: number;
  /** Drawn looks waiting to be picked (the look is not set yet). */
  looks: number;
  /** The publication is paused by moderation: sharing is off until it is reviewed. */
  paused: boolean;
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
  /** "Drawing", "Ready to publish", "Publishing paused", "Published". */
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

/**
 * Where one picture stands, as the stage counts it: `current` is the board's "ready" (the "6" of "6 of 12 pages drawn");
 * `out_of_date`, `redrawing` (a redraw in flight) and `redraw_failed` keep an earlier picture the owner can be served, so
 * they count as drawn but not current; `drawing`, `withheld` and `failed` have no picture to show; `planned` and `empty`
 * were never drawn. The side panel's parts tree reads it per page, so its drawn pages are exactly the strip's count.
 */
export type PictureStanding = 'current' | 'out_of_date' | 'redrawing' | 'redraw_failed' | 'drawing' | 'withheld' | 'failed' | 'planned' | 'empty';

/** A picture's standing. `outOfDate`: its script changed since it was drawn (pages: isPageStale); `planned`: it has a plan. */
export const pictureStanding = (render: RenderState | undefined, outOfDate = false, planned = false): PictureStanding => {
  const picture = pagePicture(render);
  if (picture === 'drawn') {
    const status = render?.status;
    if (status === 'stale' || (status === 'ready' && outOfDate)) return 'out_of_date';
    if (status === 'ready') return 'current';
    return status === 'failed' ? 'redraw_failed' : 'redrawing';
  }
  if (picture !== 'none') return picture;
  return planned ? 'planned' : 'empty';
};

/** One page's standing (older pages without panels or a render read as far as their fields go). */
export const pageStanding = (doc: ComicDoc, page: Page): PictureStanding => {
  const ready = page?.render?.status === 'ready';
  return pictureStanding(page?.render, ready && isPageStale(doc, page), plannedPage(page));
};

/**
 * The live publication is behind the studio: a page or the cover was drawn after the last publish. One rule for the
 * strip's "Publish your changes" and the Director's "Update the published version" chip (server/src/comic/jobs.ts).
 */
export const publicationBehind = (doc: ComicDoc): boolean => {
  const pub = doc?.publication;
  if (!pub || pub.status !== 'live') return false;
  const at = pub.publishedAt || 0;
  const newer = (r: RenderState | undefined) => !!r && r.status === 'ready' && (r.updatedAt || 0) > at;
  return list(doc.pages).some((p) => newer(p?.render)) || newer(doc.cover?.render);
};

export interface StageOptions {
  /**
   * The server's own answer, when the studio has it (the owner's publication view compares lettering, text,
   * languages and rating too): true also asks to publish the changes. Lists have no such view and read the render rule.
   */
  behind?: boolean;
}

/** The stage facts of a doc. Never throws: an older or partial doc reads as far as its fields go. */
export function stageFacts(doc: ComicDoc, options: StageOptions = {}): StageFacts {
  const pages = list(doc?.pages);
  let planned = 0;
  let drawn = 0;
  let current = 0;
  let outOfDate = 0;
  let drawing = 0;
  let withheld = 0;
  let failed = 0;
  let redrawing = 0;
  let redrawFailed = 0;
  for (const page of pages) {
    if (plannedPage(page)) planned += 1;
    // The board's "ready" (boardModel pageVisualStatus) is current: ready and matching its script; stale is out of date.
    const standing = pageStanding(doc, page);
    if (standing === 'current' || standing === 'out_of_date' || standing === 'redrawing' || standing === 'redraw_failed') {
      drawn += 1;
      if (standing === 'current') current += 1;
      else if (standing === 'out_of_date') outOfDate += 1;
      else if (standing === 'redrawing') redrawing += 1;
      else redrawFailed += 1;
    } else if (standing === 'drawing') drawing += 1;
    else if (standing === 'withheld') withheld += 1;
    else if (standing === 'failed') failed += 1;
  }
  const looks = list(doc?.style?.options).filter((o) => progressState(o?.render) === 'drawn').length;
  const attempted = drawn + drawing + withheld + failed > 0;
  const planStatus = doc?.planStatus;
  const paused = doc?.publication?.status === 'suspended';
  const waiting = needsYouOf(doc)?.why ?? null;

  const isDone: Record<ComicStage, boolean> = {
    story: text(doc?.brief?.premise) || text(doc?.brief?.logline) || text(doc?.source?.script) || pages.length > 0,
    // Drawn looks waiting to be compared mean the look is being chosen again, even over a drafted spec (propose_styles
    // after set_style); once a page is drawn, the look it was drawn in stands.
    style: (text(doc?.style?.spec) && !(waiting === 'style' && looks > 0)) || drawn > 0,
    plan: pages.length > 0 && planned === pages.length && (planStatus === 'approved' || attempted),
    draw: pages.length > 0 && drawn === pages.length,
    publish: doc?.publication?.status === 'live'
  };
  const done = COMIC_STAGES.filter((s) => isDone[s]);
  const stage = COMIC_STAGES.find((s) => !isDone[s]) ?? 'publish';
  const complete = done.length === COMIC_STAGES.length;

  const next = ((): StageNextKey => {
    // Waits come first, whatever the stage: an open approval, and the Director planning a draft (picking a look or
    // editing the brief then would void the plan it is writing, directorDraft.ts assertPlanUnchanged).
    if (doc?.gate?.status === 'open') return 'review_estimate';
    if (doc?.directorDraft?.status === 'planning') return 'follow_planning';
    // An interrupted draft is resumed from its own control only while it has no pages yet; with pages the person
    // carries on from the plan, so the stage's own step leads.
    if (doc?.directorDraft?.status === 'interrupted' && !pages.length) return 'resume_draft';
    // The rest of what waits on the person, in needsYouOf's order (the approval is the gate above).
    if (waiting === 'question') return 'answer_director';
    if (waiting === 'plan') return 'review_plan';
    if (waiting === 'style') return looks > 0 ? 'pick_look' : 'choose_look';
    // A redraw running or failed over a drawn page leads in Draw and in Publish too: the book is not as drawn as it reads.
    if (stage === 'draw' || stage === 'publish') {
      if (drawing + redrawing > 0) return 'watch_drawing';
      if (withheld) return 'review_withheld';
      if (failed + redrawFailed > 0) return 'review_failed';
    }
    switch (stage) {
      case 'story':
        return 'tell_story';
      case 'style':
        return looks > 0 ? 'pick_look' : 'choose_look';
      case 'plan':
        if (!pages.length) return 'plan_pages';
        return planned < pages.length ? 'plan_rest' : 'review_plan';
      case 'draw':
        return drawn ? 'draw_rest' : 'draw_pages';
      default:
        // A paused publication cannot be shared again until it is reviewed: the step says why, it never offers to publish.
        if (!complete) return paused ? 'see_paused' : 'publish';
        return publicationBehind(doc) || options.behind === true ? 'update_published' : 'read';
    }
  })();
  return { v: 1, stage, done, pages: pages.length, planned, drawn, current, outOfDate, drawing, withheld, failed, redrawing, redrawFailed, looks, paused, next };
}

// ── From a stored summary ────────────────────────────────────────────────────

const STAGE_SET: ReadonlySet<string> = new Set(COMIC_STAGES);
const NEXT_SET: ReadonlySet<string> = new Set(STAGE_NEXT_KEYS);
/**
 * The stages each next step belongs to. What waits on the person (an approval, a question, the plan's OK, a look to pick,
 * the Director planning or its interrupted draft) belongs to any stage; a redraw running or failed leads in Publish too.
 */
const NEXT_STAGES: Readonly<Partial<Record<StageNextKey, readonly ComicStage[]>>> = {
  tell_story: ['story'],
  plan_pages: ['plan'],
  plan_rest: ['plan'],
  watch_drawing: ['draw', 'publish'],
  review_withheld: ['draw'],
  review_failed: ['draw', 'publish'],
  draw_pages: ['draw'],
  draw_rest: ['draw'],
  publish: ['publish'],
  update_published: ['publish'],
  see_paused: ['publish'],
  read: ['publish']
};
/** Far above any book (DOC_LIMITS.pages); a larger stored count is not ours. */
const COUNT_MAX = 10_000;
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= COUNT_MAX ? v : null);
/** A count added after the first summaries: absent reads 0, present must be a count. */
const laterCount = (v: unknown): number | null => (v === undefined ? 0 : count(v));

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
  const current = count(raw.current);
  const outOfDate = count(raw.outOfDate);
  const drawing = count(raw.drawing);
  const withheld = count(raw.withheld);
  const failed = count(raw.failed);
  const redrawing = laterCount(raw.redrawing);
  const redrawFailed = laterCount(raw.redrawFailed);
  const looks = count(raw.looks);
  if (pages === null || planned === null || drawn === null || current === null || outOfDate === null || drawing === null || withheld === null || failed === null || looks === null) return null;
  if (redrawing === null || redrawFailed === null) return null;
  if (typeof raw.paused !== 'boolean') return null;
  const paused = raw.paused;
  if (planned > pages || drawn + drawing + withheld + failed > pages || current + outOfDate + redrawing + redrawFailed > drawn) return null;
  // The done flags the counts decide.
  if (doneSet.has('draw') !== (pages > 0 && drawn === pages)) return null;
  if (doneSet.has('plan') && (pages === 0 || planned < pages)) return null;
  if (!doneSet.has('story') && pages > 0) return null;
  if (!doneSet.has('style') && drawn > 0) return null;
  if (paused && doneSet.has('publish')) return null; // a live publication is not paused
  const stage = raw.stage as ComicStage;
  const expected = COMIC_STAGES.find((s) => !doneSet.has(s)) ?? 'publish';
  if (stage !== expected) return null;
  const next = raw.next as StageNextKey;
  const nextStages = NEXT_STAGES[next];
  if (nextStages && !nextStages.includes(stage)) return null;
  // In Publish (every page drawn) only a redraw can be running or failed.
  if (stage === 'publish' && ((next === 'watch_drawing' && !redrawing) || (next === 'review_failed' && !redrawFailed))) return null;
  const complete = done.length === COMIC_STAGES.length;
  if (((next === 'publish' || next === 'see_paused') && complete) || ((next === 'read' || next === 'update_published') && !complete)) return null;
  if ((next === 'publish' && paused) || (next === 'see_paused' && !paused)) return null;
  if ((next === 'review_withheld' && !withheld) || (next === 'review_failed' && !failed && !redrawFailed) || (next === 'pick_look' && !looks)) return null;
  if (next === 'resume_draft' && pages > 0) return null;
  return { v: 1, stage, done, pages, planned, drawn, current, outOfDate, drawing, withheld, failed, redrawing, redrawFailed, looks, paused, next };
}

// ── Words ────────────────────────────────────────────────────────────────────

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

const NEXT_PLACE: Readonly<Record<StageNextKey, StagePlace>> = {
  review_estimate: 'approval',
  // The question is the newest message in the conversation, just above the message box.
  answer_director: 'composer',
  resume_draft: 'draft',
  tell_story: 'composer',
  choose_look: 'style',
  pick_look: 'style',
  follow_planning: 'draft',
  plan_pages: 'pages',
  plan_rest: 'pages',
  review_plan: 'pages',
  watch_drawing: 'pages',
  review_withheld: 'pages',
  review_failed: 'pages',
  draw_pages: 'pages',
  draw_rest: 'pages',
  publish: 'read',
  // The Director's "Update the published version" chip opens the Share sheet too (jobs.ts nextStepsFor).
  update_published: 'share',
  see_paused: 'share',
  read: 'read'
};

const nextLabel = (facts: StageFacts): string => {
  switch (facts.next) {
    case 'review_estimate':
      return 'Review the estimate';
    case 'answer_director':
      return 'Answer the Director';
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
      // A redraw that failed keeps its earlier picture: it is a failed redraw, not a failed page.
      return facts.failed ? `Review ${plural(facts.failed + (facts.redrawFailed ?? 0), 'failed page')}` : `Review ${plural(facts.redrawFailed ?? 0, 'failed redraw')}`;
    case 'draw_pages':
      return 'Draw the pages';
    case 'draw_rest':
      return 'Draw the rest';
    case 'publish':
      return 'Read and publish';
    case 'update_published':
      return 'Publish your changes';
    case 'see_paused':
      return 'See why it is paused';
    case 'read':
      return 'Read your comic';
  }
};

/**
 * "6 of 12 pages drawn", "All 12 pages drawn", "11 of 12 pages drawn · 1 out of date", "8 of 12 pages drawn · 3 redrawing
 * · 1 redraw failed": the board's count of current pages, then why a drawn page is not current (the reader's out-of-date
 * words, ComicReaderView drawnLabel), so the strip, the Board badge, the reader and the parts tree agree.
 */
const drawnWords = (facts: StageFacts): string => {
  const all = facts.current === facts.pages;
  const base = !all ? `${facts.current} of ${plural(facts.pages, 'page')} drawn` : facts.pages === 1 ? '1 page drawn' : `All ${facts.pages} pages drawn`;
  return [base, ...notCurrentWords(facts)].join(' · ');
};

/** Why drawn pages are not current: "1 out of date", "3 redrawing", "1 redraw failed" (none when every drawn page is). */
export const notCurrentWords = (facts: StageFacts): string[] =>
  [
    facts.outOfDate ? `${facts.outOfDate} out of date` : '',
    facts.redrawing ? `${facts.redrawing} redrawing` : '',
    facts.redrawFailed ? `${facts.redrawFailed} ${facts.redrawFailed === 1 ? 'redraw' : 'redraws'} failed` : ''
  ].filter(Boolean);

const progressWords = (facts: StageFacts): string => {
  if (facts.next === 'follow_planning') return 'The Director is planning';
  switch (facts.stage) {
    case 'story':
      // True whatever else is done (a look picked first, a cast): only the story is missing.
      return 'No story yet';
    case 'style':
      return facts.looks > 0 ? `${plural(facts.looks, 'look')} to compare` : 'Not chosen yet';
    case 'plan':
      if (!facts.pages) return 'No pages planned yet';
      return facts.planned < facts.pages ? `${facts.planned} of ${plural(facts.pages, 'page')} planned` : `${plural(facts.pages, 'page')} planned`;
    default:
      return drawnWords(facts);
  }
};

const WORD: Readonly<Record<ComicStage, string>> = { story: 'Story', style: 'Style', plan: 'Planning', draw: 'Drawing', publish: 'Ready to publish' };

const wordOf = (facts: StageFacts, complete: boolean): string => {
  if (complete) return 'Published';
  if (facts.stage === 'publish' && facts.paused) return 'Publishing paused';
  return WORD[facts.stage];
};

/** "Plan the pages" → "plan the pages", after "Next: " (the strip, the panel, My comics' cards). */
export const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** The words and places for a set of stage facts (from a doc or a stored summary: the same facts read the same). */
export function stageView(facts: StageFacts): StageView {
  const done = new Set(facts.done);
  const complete = COMIC_STAGES.every((s) => done.has(s));
  const steps = COMIC_STAGES.map((stage) => ({ stage, label: STAGE_LABEL[stage], done: done.has(stage), current: stage === facts.stage, place: STAGE_PLACE[stage] }));
  const word = wordOf(facts, complete);
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
export const comicStage = (doc: ComicDoc, options?: StageOptions): StageView => stageView(stageFacts(doc, options));

/** A list's one line for stored facts: "Drawing · 6 of 12 pages drawn", or STAGE_UNKNOWN when none are readable. */
export const stageSummaryOf = (stored: unknown): string => {
  const facts = readStageFacts(stored);
  return facts ? stageView(facts).summary : STAGE_UNKNOWN;
};
