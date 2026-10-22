// Reference-photo upload API (contract §14.1; refs.md §4). Wave-0 stub by P0-B; owned in
// wave 1 by P1-REFS, which replaces the routes IN PLACE (keep the export names).
//
//   POST   /api/comic/projects/:id/refs?to=&label=&name=&hash=&index=   raw image body ≤ 10 MB
//          order: magic-byte check → screen → store PRIVATE → ref_add
//          201 {ref, rev, ops, urls, notice?} · 200 {duplicateOf} · 409 LIMIT · 415 · 422 CONTENT_POLICY
//   DELETE /api/comic/projects/:id/refs?owner=inbox&path=               commits ref_remove
//
// Mounted on /api/comic after requireAuth (routes/comicMounts.ts), behind requireActiveUser()
// and comicUploadRateLimit (30/min, 300/h). The raw body parser (express.raw) belongs here,
// on this route only. Stub behaviour: 501 NOT_AVAILABLE on these paths only.

import { Router } from 'express';
import { notAvailableHandler } from '../comic/extensions.js';

export const REFS_PATHS = ['/projects/:id/refs'];

export function createComicRefsRouter(): Router {
  const router = Router();
  router.all(REFS_PATHS, notAvailableHandler("Uploading reference photos isn't available yet."));
  return router;
}

export const comicRefsRouter = createComicRefsRouter();
