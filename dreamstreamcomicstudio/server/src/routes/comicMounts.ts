// Comic Studio route mounting, in contract §14.1 order (P0-B; called exactly twice from
// server/src/index.ts). Kept in one place so the ORDER is testable (comicMounts.test.ts):
//
//   before requireAuth (public)
//     /api/comic/public/library   library index           — before /api/comic/public, so "library" is never an :id
//     /api/comic/public/s         reader reports          — before /api/comic/public, so "s" is never an :id
//     /api/comic/public           the reader (existing)
//   after requireAuth (owner/admin)
//     /api/comic/admin/library    admin library console   — before /api/comic
//     /api/comic/admin/storage    storage maintenance     — before /api/comic
//     /api/moderation/comic-cases moderator queue         — before /api/moderation
//     /api/comic                  feature owner routers (publication, refs, i18n, safety appeal)
//     /api/comic                  the studio (existing, text rate limit)
//
// Feature routers answer ONLY their own paths, so everything else falls through to the
// studio router untouched. Per-route limits (contract §14.3) are mounted on the exact
// paths, never on the whole /api/comic prefix, so no request is counted twice.

import type { Express, RequestHandler, Router } from 'express';
import { requireActiveUser } from '../comic/safety/index.js';
import { comicI18nRouter } from './comicI18n.js';
import { comicLibraryAdminRouter, comicLibraryPublicRouter } from './comicLibrary.js';
import { comicPublicationRouter } from './comicPublication.js';
import { comicRefsRouter } from './comicRefs.js';
import { comicModerationRouter, comicReportRouter, comicSafetyRouter } from './comicSafety.js';
import { comicStorageAdminRouter } from './comicStorageAdmin.js';

/** The §14.3 limiters (each may be several windows, e.g. 30/min AND 300/h). */
export interface ComicRateLimits {
  upload: RequestHandler[];
  publish: RequestHandler[];
  report: RequestHandler[];
  translateQuote: RequestHandler[];
}

export interface ComicPublicMountDeps {
  systemRateLimit: RequestHandler;
  optionalAuth: RequestHandler;
  limits: Pick<ComicRateLimits, 'report'>;
  /** The existing public reader router (routes/comic.ts). */
  comicPublicRouter: Router | RequestHandler;
  /** Overrides for tests. */
  libraryPublicRouter?: Router | RequestHandler;
  reportRouter?: Router | RequestHandler;
}

export interface ComicOwnerMountDeps {
  textRateLimit: RequestHandler;
  adminRateLimit: RequestHandler;
  moderationRateLimit: RequestHandler;
  requireAdmin: RequestHandler;
  requireModerator: RequestHandler;
  limits: Omit<ComicRateLimits, 'report'>;
  /** The existing studio router (routes/comic.ts). */
  comicRouter: Router | RequestHandler;
  /** Overrides for tests. */
  requireActive?: RequestHandler;
  libraryAdminRouter?: Router | RequestHandler;
  storageAdminRouter?: Router | RequestHandler;
  moderationRouter?: Router | RequestHandler;
  featureRouters?: (Router | RequestHandler)[];
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Apply limiters to writes only (reading the publication view never counts as a publish). */
export const onlyWrites =
  (limiters: RequestHandler[]): RequestHandler =>
  (req, res, next) => {
    if (READ_METHODS.has(req.method)) return next();
    let i = 0;
    const step = (err?: unknown) => {
      if (err) return next(err);
      const limiter = limiters[i++];
      if (!limiter) return next();
      try {
        const out = limiter(req, res, step) as unknown;
        if (out && typeof (out as Promise<unknown>).catch === 'function') (out as Promise<unknown>).catch(step);
      } catch (e) {
        step(e);
      }
    };
    step();
  };

/** Mount the public comic routes. Call BEFORE the global requireAuth. */
export function mountComicPublicRoutes(app: Express, deps: ComicPublicMountDeps): void {
  app.use('/api/comic/public/library', deps.systemRateLimit, deps.libraryPublicRouter ?? comicLibraryPublicRouter);
  app.use('/api/comic/public/s', deps.optionalAuth, ...deps.limits.report, deps.reportRouter ?? comicReportRouter);
  // Comic Studio v4 reader for published comics (no session needed; optionalAuth lets an
  // owner preview their own unpublished comic).
  app.use('/api/comic/public', deps.systemRateLimit, deps.optionalAuth, deps.comicPublicRouter);
}

/** Mount the authenticated comic routes. Call AFTER requireAuth / account context / account keys. */
export function mountComicOwnerRoutes(app: Express, deps: ComicOwnerMountDeps): void {
  const requireActive = deps.requireActive ?? requireActiveUser();
  // Admin + moderation consoles (before /api/comic and /api/moderation).
  app.use('/api/comic/admin/library', deps.adminRateLimit, deps.requireAdmin, deps.libraryAdminRouter ?? comicLibraryAdminRouter);
  app.use('/api/comic/admin/storage', deps.adminRateLimit, deps.requireAdmin, deps.storageAdminRouter ?? comicStorageAdminRouter);
  app.use('/api/moderation/comic-cases', deps.moderationRateLimit, deps.requireModerator, deps.moderationRouter ?? comicModerationRouter);

  // Per-route limits for the feature owner routes (exact paths only).
  app.use('/api/comic/projects/:id/refs', requireActive, ...deps.limits.upload);
  app.use('/api/comic/projects/:id/publication', requireActive, deps.textRateLimit, onlyWrites(deps.limits.publish));
  app.use('/api/comic/projects/:id/translation-quote', deps.textRateLimit, ...deps.limits.translateQuote);
  app.use('/api/comic/projects/:id/safety-review', deps.textRateLimit);
  app.use('/api/comic', ...(deps.featureRouters ?? [comicPublicationRouter, comicRefsRouter, comicI18nRouter, comicSafetyRouter]));

  // Comic Studio (conversational studio) — auth'd, text-tier rate limited; renders are
  // billed per image inside the job runner.
  app.use('/api/comic', deps.textRateLimit, deps.comicRouter);
}
