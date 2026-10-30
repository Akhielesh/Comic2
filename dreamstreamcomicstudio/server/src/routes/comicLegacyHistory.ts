// Classic comics' history on the server (versions plan §11; package H0 STUB — H6 replaces the router in place,
// keeping every export name and signature).
//
//   GET /projects/:id/history/legacy                 classic snapshots kept safely on the server (beyond the old 20)
//   GET /projects/:id/history/legacy/:snapshotId     one snapshot (state for "Open in the new studio")
//
// Mounted BEFORE comicHistoryRouter, so "legacy" is never read as a version id. Owner-only (after requireAuth); a
// foreign or missing id answers the same 404. H0: off (COMIC_HISTORY unset) → falls through untouched; on → 404.
//
// Also the create-time seams routes/comic.ts uses for POST /projects {importFromProjectId, fromVersionId}: the
// snapshot loader (comic/history/legacyImport.ts) and the one onImported call — reached through this module so the
// file holding the public reader router never imports comic/history directly.

import { Router } from 'express';
import type { ComicDoc } from '../../../shared/comic/doc.js';
import { logger } from '../lib/logger.js';
import { createHistoryHooks, isHistoryEnabled, type HistoryHooks } from '../comic/history/hooks.js';
import { loadLegacyVersionState, type LegacySnapshotState } from '../comic/history/legacyImport.js';
import { HISTORY_NOT_FOUND } from './comicHistory.js';

export const LEGACY_HISTORY_PATHS = ['/projects/:id/history/legacy', '/projects/:id/history/legacy/*'];

export function createComicLegacyHistoryRouter(): Router {
  const router = Router();
  router.all(LEGACY_HISTORY_PATHS, (_req, res, next) => {
    if (!isHistoryEnabled()) return next();
    res.set('Cache-Control', 'private, no-store');
    res.status(404).json(HISTORY_NOT_FOUND);
  });
  return router;
}

export const comicLegacyHistoryRouter = createComicLegacyHistoryRouter();

/** A `fromVersionId` POST /projects may carry (snapshot ids are short opaque ids). */
const VERSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const parseFromVersionId = (raw: unknown): string | undefined => (typeof raw === 'string' && VERSION_ID.test(raw.trim()) ? raw.trim() : undefined);

/**
 * The classic snapshot to import instead of the live classic state, or null (missing, foreign — or, in H0, not on the
 * server yet). Only consulted while Comic History is on.
 */
export const legacyVersionImport = (userId: string, fromProjectId: string, fromVersionId: string): Promise<LegacySnapshotState | null> =>
  loadLegacyVersionState({ projectId: fromProjectId, userId }, fromProjectId, fromVersionId);

/** One onImported call after a classic import created a comic (H6 records the classic project on its import row). */
export const notifyImported = (
  info: { projectId: string; userId: string; doc: ComicDoc; fromProjectId: string; fromVersionId?: string },
  hooks?: Pick<HistoryHooks, 'onImported'>
): void => {
  try {
    const out = (hooks ?? createHistoryHooks({ projectId: info.projectId, userId: info.userId })).onImported?.(info);
    if (out && typeof (out as Promise<void>).then === 'function') {
      (out as Promise<void>).catch((err) => logger.warn('comic_history_capture_failed', { projectId: info.projectId, hook: 'onImported', message: (err as Error)?.message }));
    }
  } catch (err) {
    logger.warn('comic_history_capture_failed', { projectId: info.projectId, hook: 'onImported', message: (err as Error)?.message });
  }
};
