import type { FinishedKind, WorkAttention } from '../../../shared/comic/workspaceActivity';
import type { StudioTab } from '../../../shared/comic/doc';

/** Where a list sends a comic when it opens: a board tab, the conversation, or the Share sheet (My comics' next steps). */
export type TaskDestination = 'conversation' | 'share' | Extract<StudioTab, 'story' | 'pages' | 'cast' | 'style' | 'languages' | 'read'>;
export const TASK_TARGET_EVENT = 'dreamstream:comic-task-target';
export const WORK_CHANGED_EVENT = 'dreamstream:comic-work-changed';
/**
 * A list that reads the comics' news (the side panel's Your comics, My comics' cards) reads again when the tab comes back
 * into view or gets focus this long after its last read (work done on another device), never on a timer. One value, so
 * the grid and the panel beside it change together.
 */
export const WORK_FOCUS_REFRESH_MS = 30_000;
const destinations = new Set<TaskDestination>(['conversation', 'share', 'story', 'pages', 'cast', 'style', 'languages', 'read']);
let pending: { accountId: string; projectId: string; destination: TaskDestination } | undefined;

export function taskDestination(kind: FinishedKind | WorkAttention): TaskDestination {
  switch (kind) {
    case 'pages': case 'render_failed': return 'pages';
    case 'sheets': return 'cast';
    case 'looks': return 'style';
    case 'translation': return 'languages';
    case 'cover': case 'published': return 'read';
    default: return 'conversation';
  }
}

export function requestTaskTarget(accountId: string, projectId: string, destination: TaskDestination) {
  pending = { accountId, projectId, destination };
  window.dispatchEvent(new Event(TASK_TARGET_EVENT));
}

export function consumeTaskTarget(accountId: string | undefined, projectId: string): TaskDestination | undefined {
  if (!accountId) return;
  if (pending?.accountId === accountId && pending.projectId === projectId) {
    const { destination } = pending;
    pending = undefined;
    return destination;
  }
  const url = new URL(window.location.href);
  const destination = url.searchParams.get('task') as TaskDestination;
  if (url.searchParams.get('id') !== projectId || !destinations.has(destination)) return;
  url.searchParams.delete('task');
  window.history.replaceState(window.history.state, '', url);
  return destination;
}
