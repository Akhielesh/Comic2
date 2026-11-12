// What the app does when a comic is opened from the library (EGRESS-DB E1 follow-up).
//
// The library lists cards: a subset of each comic's state. Opening a comic first loads its full state
// (hooks/useProjectManager.ts hydrateProjectAssets -> ensureProjectState), then signs its images. Two
// different things can go wrong, and they must not be treated alike:
//
//   - The full state could not be loaded (ProjectStateLoadError). The library still holds only the card, and
//     a workspace or reader opened on a card shows a comic with pieces missing and refuses every change. So
//     the app STAYS where it is (the library); the hook has already said "Couldn't load this comic. Try
//     again." and the next open retries.
//   - The state loaded but signing its images failed. The comic is whole; it opens best-effort, as it always
//     has (images that could not be signed show their placeholders).
//
// resolveProjectOpen never rejects, so a caller cannot forget the failure branch.

import type { Project } from '../types';

/** A comic's full state could not be loaded for an open: the library still holds its card. */
export class ProjectStateLoadError extends Error {
  readonly projectId: string;
  readonly cause: unknown;

  constructor(projectId: string, cause: unknown, message = 'The comic’s full state could not be loaded') {
    super(message);
    this.name = 'ProjectStateLoadError';
    this.projectId = projectId;
    this.cause = cause;
  }
}

export const isProjectStateLoadError = (error: unknown): error is ProjectStateLoadError => error instanceof ProjectStateLoadError;

export type ProjectOpen =
  /** The comic is whole and its images are signed: open it. */
  | { outcome: 'opened'; project: Project | undefined }
  /** The comic is whole but its images could not be signed: open the copy in memory. */
  | { outcome: 'opened-best-effort'; project: Project | undefined }
  /** The full state did not load: stay on the library (the hook has shown the error). */
  | { outcome: 'stayed' };

/**
 * Runs an open and says what to do next. `hydrate` is the hook's hydrateProjectAssets for the comic; `current`
 * reads the copy in memory (used only for the best-effort open).
 */
export const resolveProjectOpen = async (
  hydrate: () => Promise<Project | undefined>,
  current: () => Project | undefined
): Promise<ProjectOpen> => {
  try {
    return { outcome: 'opened', project: await hydrate() };
  } catch (error) {
    if (isProjectStateLoadError(error)) return { outcome: 'stayed' };
    return { outcome: 'opened-best-effort', project: current() };
  }
};
