// The members' home in Comic Studio: which comic to offer as "Continue", the words under it, the help line under Start,
// and My comics' cards (stage, status, next step, order). Pure functions over the project list the page already has and
// the one stage read it makes (no request, no timer, no registry import).

import type { Project } from '../../../types';
import { formatStudioProgress, isStudioV4Project, studioPageProgress } from '../../../services/studioDeepLink';
import { COMIC_STAGES, STAGE_UNKNOWN, stageView, type ComicStage, type StageFacts, type StagePlace, type StageView } from '../../../shared/comic/stage';
import type { WorkAttention } from '../../../shared/comic/workspaceActivity';
import { taskDestination, type TaskDestination } from './workspaceTaskTarget';

/** Project names are capped server-side at 200 characters. */
export const PROJECT_NAME_MAX = 200;

/** A studio comic edited within this window is offered as Continue when nothing needs the member. */
export const CONTINUE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The help line under Start. The idea form (ComicCreationWorkspace) and Home's composer both read it from here, so a
 * change to what Start does is one edit.
 */
export const HOME_START_HELP = 'The Director uses your writing allowance to plan the story and choose a look. Approve one drawing estimate, then read your private comic.';

/** A comic's studio status as the organize data layer records it (only `phase` is read here). */
export type ContinuePhase = 'idle' | 'drawing' | 'waiting' | 'attention' | 'published';
export interface ContinueMetaRow {
  status?: { phase?: unknown } | null;
}
/** Status rows by project id, as a Map or a plain record. */
export type ContinueMeta = ReadonlyMap<string, ContinueMetaRow | undefined> | Readonly<Record<string, ContinueMetaRow | undefined>>;

/** What needs the member most: a waiting approval, then a problem, then a comic still drawing. */
const PHASE_RANK: Readonly<Record<string, number>> = { waiting: 3, attention: 2, drawing: 1 };

const rowOf = (meta: ContinueMeta, id: string): ContinueMetaRow | undefined =>
  meta instanceof Map ? meta.get(id) : (meta as Readonly<Record<string, ContinueMetaRow | undefined>>)[id];

const rankOf = (meta: ContinueMeta | undefined, id: string): number => {
  if (!meta) return 0;
  const phase = rowOf(meta, id)?.status?.phase;
  return typeof phase === 'string' ? PHASE_RANK[phase] ?? 0 : 0;
};

/**
 * The studio comic to continue, or null. Classic comics are never offered. With status rows (`meta`), a comic waiting
 * on the member beats one with a problem, which beats one still drawing, whenever it was last edited; otherwise (and
 * without meta) the most recently edited studio comic within 14 days.
 */
export function pickContinue<T extends Project>(projects: readonly T[], now: number, meta?: ContinueMeta): T | null {
  let best: T | null = null;
  let bestRank = -1;
  for (const project of projects) {
    if (!isStudioV4Project(project)) continue;
    const rank = rankOf(meta, project.id);
    if (rank === 0 && now - project.updatedAt > CONTINUE_WINDOW_MS) continue;
    if (rank > bestRank || (rank === bestRank && best && project.updatedAt > best.updatedAt)) {
      best = project;
      bestRank = rank;
    }
  }
  return best;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const relativeFormat = (locale: string | undefined): Intl.RelativeTimeFormat => {
  try {
    return new Intl.RelativeTimeFormat(locale || 'en', { numeric: 'auto' });
  } catch {
    // An unknown or malformed tag (RangeError): the page's own language.
    return new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  }
};

/** "edited 2 hours ago", "edited yesterday", "edited just now" (never a future time), in the given locale. */
export function editedAgo(updatedAt: number, now: number, locale?: string): string {
  const age = Math.max(0, now - updatedAt);
  if (age < MINUTE) return 'edited just now';
  const rtf = relativeFormat(locale);
  if (age < HOUR) return `edited ${rtf.format(-Math.floor(age / MINUTE), 'minute')}`;
  if (age < DAY) return `edited ${rtf.format(-Math.floor(age / HOUR), 'hour')}`;
  if (age < 7 * DAY) return `edited ${rtf.format(-Math.floor(age / DAY), 'day')}`;
  if (age < 30 * DAY) return `edited ${rtf.format(-Math.floor(age / (7 * DAY)), 'week')}`;
  if (age < 365 * DAY) return `edited ${rtf.format(-Math.floor(age / (30 * DAY)), 'month')}`;
  return `edited ${rtf.format(-Math.floor(age / (365 * DAY)), 'year')}`;
}

/**
 * Where a studio comic stands by its listing row alone (the server mirrors the page counts on every save): "3 of 10 pages
 * drawn", "All 4 pages drawn", "No pages planned yet", or "Published". Counts only, never a stage: a comic without a saved
 * stage reads STAGE_UNKNOWN for that.
 */
const rowWords = (project: Project): string | null => {
  if (project.isPublic) return 'Published';
  const progress = studioPageProgress(project);
  if (!progress) return null;
  if (progress.pages > 0 && progress.rendered >= progress.pages) {
    return progress.pages === 1 ? '1 page drawn' : `All ${progress.pages} pages drawn`;
  }
  return progress.pages > 0 ? `${formatStudioProgress(progress)} drawn` : formatStudioProgress(progress);
};

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A studio comic's one-line status: its stage's progress when the saved stage is known ("6 of 12 pages drawn · edited 2
 * hours ago", the strip's words), else the row's counts ("3 of 10 pages drawn · edited 2 hours ago").
 */
export function continueLine(project: Project, now: number, locale?: string, facts?: StageFacts | null): string {
  const progress = facts ? stageView(facts).progress : rowWords(project);
  const edited = editedAgo(project.updatedAt, now, locale);
  return progress ? `${progress} · ${edited}` : capitalise(edited);
}

/** True when at least one page is drawn, so the comic can be read: the saved stage when known, else the row's count. */
export const hasDrawnPage = (project: Project, facts?: StageFacts | null): boolean =>
  facts ? facts.drawn > 0 : (studioPageProgress(project)?.rendered ?? 0) > 0;

/** The pictures a comic card may show, in the grid's order: cover, first drawn panel, first Page Studio page, first style. */
export function coverCandidates(project: Project): string[] {
  const state = project.state;
  return [
    state.coverImageUrl,
    state.panels?.find((panel) => panel.imageUrl)?.imageUrl,
    state.pageStudio?.pages?.find((page) => page.imageUrl)?.imageUrl,
    state.styleVariants?.find((variant) => variant.imageUrl)?.imageUrl
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

// ── My comics cards ──────────────────────────────────────────────────────────
// One model per card, from the card row the list already has and the comic's row from the one stage read
// (services/comicWorkspaceActivity.ts loadComicStages): never a full doc, never a request of its own.

/** What the stage read says about one comic: its validated stage (absent before stages) and what waits on the person. */
export interface CardStageRow {
  stage?: StageFacts;
  attention: WorkAttention | null;
}

/** Where the stage read is: still loading (the row shows a placeholder), or settled (a missing row reads unknown). */
export type CardStageStatus = 'loading' | 'settled';

export type MyComicKind = 'studio' | 'classic' | 'pagestudio';

/** The next step: words, where it opens (null: the comic as it was left), and what it opens, for screen readers. */
export interface MyComicNext {
  label: string;
  destination: TaskDestination | null;
  hint: string;
}

export interface MyComicCardModel {
  kind: MyComicKind;
  title: string;
  /** The saved stage's words and marks; null when it is unknown, still loading, or the comic is classic. */
  stage: StageView | null;
  /** The stage read has not answered yet: the stage row is a placeholder of the same size. */
  pending: boolean;
  /** The stage row's word: "Drawing", "Published", "Open to see", "Classic editor", "Page Studio". */
  stageWord: string;
  /** One line: "6 of 12 pages drawn · edited 2 hours ago". */
  status: string;
  /** Something waits on the person (the activity summary's attention): ordered first, marked "Needs you". */
  needsYou: boolean;
  /** One tap away; null when reading is the next step (the Read button is it). Only ever navigates. */
  next: MyComicNext | null;
  canRead: boolean;
  /** A classic comic drawing now (its own progress and time left). */
  building: { progress: number; remaining: string } | null;
  featured: boolean;
}

/** Where each stage place opens from a list (StageStrip opens the same places inside the studio). */
export const STAGE_PLACE_DESTINATION: Readonly<Record<StagePlace, TaskDestination>> = {
  story: 'story',
  style: 'style',
  pages: 'pages',
  read: 'read',
  approval: 'conversation',
  draft: 'conversation',
  composer: 'conversation',
  share: 'share'
};

const DESTINATION_HINT: Readonly<Record<TaskDestination, string>> = {
  conversation: 'Opens the comic at the conversation',
  share: 'Opens the comic’s Share sheet',
  story: 'Opens the comic’s Story tab',
  style: 'Opens the comic’s Style tab',
  pages: 'Opens the comic’s Pages tab',
  cast: 'Opens the comic’s Cast tab',
  languages: 'Opens the comic’s Languages tab',
  read: 'Opens the comic’s Read tab'
};

/** What waits on the person, as a next step, when a comic has no saved stage (the AI activity feed's own reasons). */
const ATTENTION_NEXT: Readonly<Record<WorkAttention, string>> = {
  approval: 'Review the estimate',
  question: 'Answer the Director',
  plan: 'Review the plan',
  style: 'Choose a look',
  interrupted: 'Resume the draft',
  render_failed: 'Review the drawing problem'
};

/** The stage's own waits: a question never replaces them (they are what the conversation shows first). */
const WAIT_STEPS: ReadonlySet<string> = new Set(['review_estimate', 'follow_planning', 'resume_draft']);

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const nextTo = (label: string, destination: TaskDestination): MyComicNext => ({ label: `Next: ${lowerFirst(label)}`, destination, hint: DESTINATION_HINT[destination] });

/** The classic editor's steps, as the Step filter names them. */
const CLASSIC_STEP: readonly string[] = ['Script', 'Story plan', 'Style', 'World', 'Cover', 'Layout', 'Preview', 'Build', 'Done'];

const hasPicture = (item: { imageUrl?: string; imageId?: string } | undefined) => !!(item?.imageUrl || item?.imageId);

/** Which editor a comic lives in: the studio (v4), Page Studio, or the classic editor (every other or retired mode). */
export const kindOf = (project: Project): MyComicKind =>
  isStudioV4Project(project) ? 'studio' : project.state.pipelineMode === 'pagestudio' ? 'pagestudio' : 'classic';

/** A classic or Page Studio comic's status words (no stage: those editors have their own steps). */
const legacyWords = (project: Project, kind: Exclude<MyComicKind, 'studio'>): string | null => {
  const state = project.state;
  if (kind === 'pagestudio') {
    const pages = state.pageStudio?.pages ?? [];
    if (!pages.length) return 'No pages yet';
    const drawn = pages.filter(hasPicture).length;
    return drawn >= pages.length ? (pages.length === 1 ? '1 page drawn' : `All ${pages.length} pages drawn`) : `${drawn} of ${pages.length} pages drawn`;
  }
  const panels = state.panels ?? [];
  const drawn = panels.filter(hasPicture).length;
  if (drawn) return drawn >= panels.length ? `All ${panels.length} panels drawn` : `${drawn} of ${panels.length} panels drawn`;
  const step = typeof state.step === 'number' ? CLASSIC_STEP[state.step] : undefined;
  return step ? `Step: ${step}` : null;
};

/** The card for one comic. Pure: the same inputs give the same words. */
export function myComicCard(project: Project, row: CardStageRow | undefined, status: CardStageStatus, now: number, locale?: string): MyComicCardModel {
  const kind = kindOf(project);
  const title = project.name.trim() || 'Untitled comic';
  const featured = !!project.state.isFeatured;
  const edited = editedAgo(project.updatedAt, now, locale);
  if (kind !== 'studio') {
    const generation = project.state.generationStatus;
    const building = generation?.isActive
      ? { progress: Math.min(100, Math.max(0, Number(generation.progress) || 0)), remaining: typeof generation.estimatedTimeRemaining === 'string' ? generation.estimatedTimeRemaining.trim() : '' }
      : null;
    const words = building ? `Building · ${Math.round(building.progress)}%${building.remaining ? ` · about ${building.remaining} left` : ''}` : legacyWords(project, kind);
    const canRead = (project.state.panels ?? []).some(hasPicture) || (project.state.pageStudio?.pages ?? []).some(hasPicture);
    return {
      kind,
      title,
      stage: null,
      pending: false,
      stageWord: kind === 'pagestudio' ? 'Page Studio' : 'Classic editor',
      status: words ? `${words} · ${edited}` : capitalise(edited),
      needsYou: false,
      next: { label: 'Edit', destination: null, hint: kind === 'pagestudio' ? 'Opens Page Studio' : 'Opens the classic editor' },
      canRead,
      building,
      featured
    };
  }

  const pending = status === 'loading' && !row;
  const facts = row?.stage ?? null;
  const view = facts ? stageView(facts) : null;
  const attention = row?.attention ?? null;
  const canRead = hasDrawnPage(project, facts);
  let next: MyComicNext | null;
  if (view) {
    if (attention === 'question' && !WAIT_STEPS.has(view.next.key)) next = nextTo(ATTENTION_NEXT.question, 'conversation');
    else if (view.next.key === 'read' && canRead) next = null;
    else next = nextTo(view.next.label, STAGE_PLACE_DESTINATION[view.next.place]);
  } else if (attention) {
    next = nextTo(ATTENTION_NEXT[attention], taskDestination(attention));
  } else {
    next = { label: 'Open', destination: null, hint: 'Opens the comic in the studio' };
  }
  return {
    kind,
    title,
    stage: view,
    pending,
    stageWord: view ? view.word : pending ? '' : STAGE_UNKNOWN,
    status: continueLine(project, now, locale, facts),
    needsYou: !!attention,
    next,
    canRead,
    building: null,
    featured
  };
}

/** How the list is sorted (the Sort select). The default puts what waits on the person first. */
export type MyComicsSort = 'updated' | 'created' | 'az' | 'za';

/**
 * The list in order. "updated" (the default): comics that need the person first, then the most recently edited; the
 * explicit sorts (created, A–Z, Z–A) are exactly that. Stable: equal comics keep the list's own order.
 */
export function orderMyComics<T extends Project>(projects: readonly T[], sort: MyComicsSort, needsYou: (project: T) => boolean): T[] {
  const keyed = projects.map((project, index) => ({ project, index, first: sort === 'updated' && needsYou(project) ? 0 : 1 }));
  keyed.sort((a, b) => {
    if (a.first !== b.first) return a.first - b.first;
    let by = 0;
    if (sort === 'updated') by = b.project.updatedAt - a.project.updatedAt;
    else if (sort === 'created') by = b.project.createdAt - a.project.createdAt;
    else if (sort === 'az') by = a.project.name.localeCompare(b.project.name);
    else by = b.project.name.localeCompare(a.project.name);
    return by || a.index - b.index;
  });
  return keyed.map((k) => k.project);
}

/** The Step filter's studio choices: the five stages, and Published (every stage done). */
export type StageFilter = ComicStage | 'published';
export const STAGE_FILTERS: readonly StageFilter[] = [...COMIC_STAGES, 'published'];

/** Whether a comic's saved stage is the one asked for. A comic without a saved stage never matches (no guess). */
export function matchesStageFilter(facts: StageFacts | null | undefined, filter: StageFilter): boolean {
  if (!facts) return false;
  const complete = facts.done.length === COMIC_STAGES.length;
  if (filter === 'published') return complete;
  return !complete && facts.stage === filter;
}
