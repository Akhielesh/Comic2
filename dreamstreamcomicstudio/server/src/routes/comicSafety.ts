// Safety HTTP surface (contract §14.1; safety.md). Wave-0 stub by P0-B; owned in wave 1 by
// P1-SAFETY, which replaces the routes IN PLACE (keep the export names). Three routers:
//
//   owner      POST /api/comic/projects/:id/safety-review      appeal (= safety_recheck); 5/day
//   report     POST /api/comic/public/s/:slug/report           optional auth + Turnstile; ALWAYS 202
//                                                              (even for an unknown slug); 5/h per IP or user
//   moderation GET /api/moderation/comic-cases, GET :id/asset, POST :id/resolve
//                                                              5-minute signed URLs; audited
//
// Mounts (routes/comicMounts.ts): owner on /api/comic after requireAuth; report on
// /api/comic/public/s BEFORE /api/comic/public; moderation on /api/moderation/comic-cases
// behind requireModerator. Stub behaviour: 501 NOT_AVAILABLE on these paths only.

import { Router } from 'express';
import { notAvailableHandler } from '../comic/extensions.js';

const SAFETY_UNAVAILABLE = "Safety reviews aren't available yet.";

export const SAFETY_OWNER_PATHS = ['/projects/:id/safety-review'];

/** Owner appeal route (mounted on /api/comic). */
export function createComicSafetyRouter(): Router {
  const router = Router();
  router.all(SAFETY_OWNER_PATHS, notAvailableHandler(SAFETY_UNAVAILABLE));
  return router;
}

/** Reader reports (mounted on /api/comic/public/s, before the public reader router). */
export function createComicReportRouter(): Router {
  const router = Router();
  router.all('/:slug/report', notAvailableHandler("Reporting isn't available yet."));
  return router;
}

/** Moderator case queue (mounted on /api/moderation/comic-cases behind requireModerator). */
export function createComicModerationRouter(): Router {
  const router = Router();
  router.use(notAvailableHandler(SAFETY_UNAVAILABLE));
  return router;
}

export const comicSafetyRouter = createComicSafetyRouter();
export const comicReportRouter = createComicReportRouter();
export const comicModerationRouter = createComicModerationRouter();
