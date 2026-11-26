// The side panel's "Your comics" list (SH-C1): every comic once, in the group that needs the person most (Needs you,
// In progress, Finished, Recent), with its stage and one status line. Pure: the panel calls it with the project list
// App already has and the small activity rows the list loads (services/comicWorkspaceActivity.ts), so nothing here
// loads a full comic, starts work or shows a price.
//
// "Finished" means freshly finished: a finished work with a real time (the legacy fallback records an older comic's
// page count with `at: 0`, which is a count, not a completion), from the last week, that this viewer has not cleared.

import type { Project } from '../../../types';
import type { ComicActivityRow } from '../../../services/comicWorkspaceActivity';
import type { FinishedWork, WorkAttention } from '../../../shared/comic/workspaceActivity';
import { STAGE_UNKNOWN, stageView, type StageFacts, type StageView } from '../../../shared/comic/stage';
import { isStudioV4Project } from '../../../services/studioDeepLink';
import { taskDestination, type TaskDestination } from '../home/workspaceTaskTarget';

export const PANEL_GROUPS = ['needs', 'working', 'finished', 'recent'] as const;
export type PanelGroup = (typeof PANEL_GROUPS)[number];

export const PANEL_GROUP_LABEL: Readonly<Record<PanelGroup, string>> = {
  needs: 'Needs you',
  working: 'In progress',
  finished: 'Finished',
  recent: 'Recent'
};

const DAY = 24 * 60 * 60 * 1000;
/** A finished work older than this is history, not news: the comic moves to Recent. */
export const FINISHED_FRESH_MS = 7 * DAY;
/** An "in progress" comic silent for this long reads "Check stalled progress". */
export const STALLED_MS = 15 * 60_000;
/** Recent comics shown (the open comic is always listed besides); "All comics" has the rest. */
export const RECENT_LIMIT = 5;
/** Finished comics shown before "Show all". */
export const FINISHED_SHOWN = 3;

export const ATTENTION_LABEL: Readonly<Record<WorkAttention, string>> = {
  approval: 'Review drawing estimate',
  question: 'Answer the Director',
  plan: 'Review page plan',
  style: 'Choose a look',
  interrupted: 'Resume interrupted draft',
  render_failed: 'Review drawing issue'
};

export function finishedLabel(work: FinishedWork): string {
  switch (work.kind) {
    case 'pages':
      return work.count === 1 ? '1 page drawn' : `${work.count ?? 0} pages drawn`;
    case 'plan':
      return 'Page plan ready';
    case 'cover':
      return 'Cover drawn';
    case 'sheets':
      return 'Reference art ready';
    case 'looks':
      return 'Style samples ready';
    case 'translation':
      return 'Translation updated';
    case 'published':
      return 'Comic published';
    case 'reply':
      return 'Director replied';
  }
}

/** Words for a comic in progress with no readable stage (saved before stages). */
export const IN_PROGRESS_UNKNOWN = 'Last reported in progress';
export const STALLED_LABEL = 'Check stalled progress';
/** A comic made in the classic editor has no stages. */
export const CLASSIC_LABEL = 'Classic editor';
const UNTITLED = 'Untitled comic';

export interface PanelComic {
  id: string;
  title: string;
  group: PanelGroup;
  /** The line under the title; null while the activity is still loading (never a guess). */
  status: string | null;
  /** Where the comic stands, when its saved (or, for the open comic, live) stage reads. */
  stage: StageView | null;
  /** Where opening it from this row goes (the old feed's task target); none for a plain Recent row. */
  task?: TaskDestination;
  /** A Comic Studio comic (opens in the studio); false for a classic comic. */
  studio: boolean;
  /** The fresh finished works this row stands for (Clear finished marks them seen). */
  fresh: FinishedWork[];
  /** The time the group orders by. */
  at: number;
}

export interface PanelComicsGroup {
  group: PanelGroup;
  label: string;
  comics: PanelComic[];
}

export interface PanelComicsInput {
  projects: readonly Project[];
  /** The loaded activity rows; null until the first page has loaded. */
  rows: readonly ComicActivityRow[] | null;
  now: number;
  /** True when this viewer cleared that finished work (or a later one of its kind). */
  isCleared?: (projectId: string, work: FinishedWork) => boolean;
  /** The comic open in the studio: always listed, with its live stage. */
  current?: { id: string; title: string; facts: StageFacts | null };
  recentLimit?: number;
}

export interface PanelComics {
  /** The non-empty groups, in PANEL_GROUPS order. */
  groups: PanelComicsGroup[];
  /** Comics left out of Recent (reachable from All comics). */
  hiddenRecent: number;
  /** No comic at all. */
  empty: boolean;
}

/** Fresh: a real finish time (never the fallback's 0), from the last FINISHED_FRESH_MS, not cleared. */
export const isFreshWork = (projectId: string, work: FinishedWork, now: number, isCleared?: PanelComicsInput['isCleared']): boolean =>
  Number.isFinite(work.at) && work.at > 0 && now - work.at <= FINISHED_FRESH_MS && !isCleared?.(projectId, work);

const titleOf = (row: ComicActivityRow | undefined, project: Project | undefined): string => {
  const fromRow = row?.title?.trim();
  if (fromRow && fromRow !== UNTITLED) return fromRow;
  return project?.name?.trim() || fromRow || UNTITLED;
};

const byAt = (a: PanelComic, b: PanelComic) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Every comic once, in the group that needs the person most, each group in its own order. */
export function panelComics({ projects, rows, now, isCleared, current, recentLimit = RECENT_LIMIT }: PanelComicsInput): PanelComics {
  const rowById = new Map<string, ComicActivityRow>();
  for (const row of rows ?? []) if (row?.id && !rowById.has(row.id)) rowById.set(row.id, row);
  const projectById = new Map<string, Project>();
  for (const project of projects) if (project?.id && !projectById.has(project.id)) projectById.set(project.id, project);

  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  if (current?.id) add(current.id);
  for (const id of rowById.keys()) add(id);
  for (const id of projectById.keys()) add(id);

  const loaded = rows !== null;
  const comics: PanelComic[] = ids.map((id): PanelComic => {
    const row = rowById.get(id);
    const project = projectById.get(id);
    const live = current?.id === id ? current : undefined;
    const studio = !!row || !!live || isStudioV4Project(project);
    const facts = live ? live.facts : row?.stage ?? null;
    const stage = facts ? stageView(facts) : null;
    const updatedAt = Math.max(row?.updatedAt ?? 0, project?.updatedAt ?? 0);
    const title = live?.title?.trim() || titleOf(row, project);
    const fresh = (row?.finished ?? []).filter((work) => isFreshWork(id, work, now, isCleared)).sort((a, b) => b.at - a.at);
    const base = { id, title, stage, studio, fresh };
    if (row?.attention) {
      return { ...base, group: 'needs', status: ATTENTION_LABEL[row.attention], task: taskDestination(row.attention), at: updatedAt };
    }
    if (row?.working) {
      const stalled = !!row.updatedAt && now - row.updatedAt > STALLED_MS;
      return { ...base, group: 'working', status: stalled ? STALLED_LABEL : stage?.summary ?? IN_PROGRESS_UNKNOWN, task: 'conversation', at: updatedAt };
    }
    if (fresh.length) {
      const latest = fresh[0];
      return { ...base, group: 'finished', status: finishedLabel(latest), task: taskDestination(latest.kind), at: latest.at };
    }
    const status = stage ? stage.summary : !studio ? CLASSIC_LABEL : loaded || live ? STAGE_UNKNOWN : null;
    return { ...base, group: 'recent', status, at: updatedAt };
  });

  const groups: PanelComicsGroup[] = [];
  let hiddenRecent = 0;
  for (const group of PANEL_GROUPS) {
    let list = comics.filter((c) => c.group === group).sort(byAt);
    if (group === 'recent' && list.length > recentLimit) {
      const shown = list.slice(0, recentLimit);
      const open = current?.id ? list.find((c) => c.id === current.id) : undefined;
      if (open && !shown.includes(open)) shown.push(open);
      hiddenRecent = list.length - shown.length;
      list = shown;
    }
    if (list.length) groups.push({ group, label: PANEL_GROUP_LABEL[group], comics: list });
  }
  return { groups, hiddenRecent, empty: comics.length === 0 };
}

/** A row's accessible name: the title, its status, and its stage when the status is not already the stage. */
export const comicRowName = (comic: Pick<PanelComic, 'title' | 'status' | 'stage'>): string =>
  [comic.title, comic.status, comic.stage && comic.status !== comic.stage.summary ? comic.stage.summary : null].filter(Boolean).join(' · ');
