// Storage admin API (contract §14.1; assets.md). Wave-0 stub by P0-B; owned in wave 1 by
// P1-STORAGE, which replaces the routes IN PLACE (keep the export names).
//
//   POST /api/comic/admin/storage/migrate-refs {dryRun, projectId?, limit ≤ 10}
//        copies legacy refs/attachments from /img/ (public) to /ref/ (private), rewrites doc
//        paths via server ops, then deletes the public copies. Client-driven batches.
//
// Mounted at /api/comic/admin/storage behind adminRateLimit + requireAdmin (routes/comicMounts.ts).
// Stub behaviour: 501 NOT_AVAILABLE.

import { Router } from 'express';
import { notAvailableHandler } from '../comic/extensions.js';

export function createComicStorageAdminRouter(): Router {
  const router = Router();
  router.use(notAvailableHandler("Storage maintenance isn't available yet."));
  return router;
}

export const comicStorageAdminRouter = createComicStorageAdminRouter();
