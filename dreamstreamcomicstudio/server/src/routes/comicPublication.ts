// Owner publication API (contract §14.1; sharing.md §4). Wave-0 stub by P0-B; owned in
// wave 1 by P1-PUBLISH, which replaces the routes IN PLACE (keep the export names).
//
//   GET|POST|PATCH|DELETE /api/comic/projects/:id/publication   PublishRequest / PublicationSettingsPatch
//   POST                  /api/comic/projects/:id/publication/regenerate
//
// Mounted on /api/comic after requireAuth (routes/comicMounts.ts), behind requireActiveUser()
// and comicPublishRateLimit (writes: 10/min, 60/day). Errors: 404 (not owner), 409 (busy),
// 422 NOT_READY / SAFETY_BLOCKED / LANG_INCOMPLETE. Re-publishing after an unpublish mints
// a NEW slug. Stub behaviour: 501 NOT_AVAILABLE on these paths only.

import { Router } from 'express';
import { notAvailableHandler } from '../comic/extensions.js';

export const PUBLICATION_PATHS = ['/projects/:id/publication', '/projects/:id/publication/*'];

export function createComicPublicationRouter(): Router {
  const router = Router();
  router.all(PUBLICATION_PATHS, notAvailableHandler("Publishing from the studio isn't available yet."));
  return router;
}

export const comicPublicationRouter = createComicPublicationRouter();
