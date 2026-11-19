// The members' home in Comic Studio: which comic to offer as "Continue", the words under it, and the help line under
// Start. Pure functions over the project list the page already has (no request, no timer, no registry import).

import type { Project } from '../../../types';
import { formatStudioProgress, isStudioV4Project, studioPageProgress } from '../../../services/studioDeepLink';

/** A studio comic edited within this window is offered as Continue when nothing needs the member. */
export const CONTINUE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The help line under Start (Home's composer reads it from here, so a change to what Start does is one edit). It says
 * the same as the idea form's line today.
 */
export const HOME_START_HELP = 'Start prepares the conversation. Send submits your idea.';

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

/** Where the comic stands: "3 of 10 pages", "No pages planned yet", "All 4 pages drawn" or "Published". */
const progressWords = (project: Project): string | null => {
  if (project.isPublic) return 'Published';
  const progress = studioPageProgress(project);
  if (!progress) return null;
  if (progress.pages > 0 && progress.rendered >= progress.pages) {
    return progress.pages === 1 ? '1 page drawn' : `All ${progress.pages} pages drawn`;
  }
  return formatStudioProgress(progress);
};

/** The line under the Continue card's title: "3 of 10 pages · edited 2 hours ago". */
export function continueLine(project: Project, now: number, locale?: string): string {
  const progress = progressWords(project);
  const edited = editedAgo(project.updatedAt, now, locale);
  return progress ? `${progress} · ${edited}` : edited.charAt(0).toUpperCase() + edited.slice(1);
}

/** True when at least one page is drawn, so the comic can be read. */
export const hasDrawnPage = (project: Project): boolean => (studioPageProgress(project)?.rendered ?? 0) > 0;

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
