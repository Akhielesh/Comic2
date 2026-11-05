// Platform asset library HTTP surface (contract §14.1; assets.md). Owned by P1-LIBRARY. The
// router logic lives in ../comic/library/index.ts (createLibraryPublicRouter /
// createLibraryAdminRouter); this file is what routes/comicMounts.ts mounts:
//
//   public  GET /api/comic/public/library                       ETag; 5-minute cache; mounted BEFORE /api/comic/public
//   admin   /api/comic/admin/library/*                          requireAdmin; client-driven steps (n ≤ 3 per call)
//
// Both routers build their Supabase/storage/image dependencies lazily on the first request,
// so importing this module never needs Supabase env (tests, the public build).

import type { Router } from 'express';
import { createLibraryAdminRouter, createLibraryPublicRouter } from '../comic/library/index.js';

export function createComicLibraryPublicRouter(): Router {
  return createLibraryPublicRouter();
}

export function createComicLibraryAdminRouter(): Router {
  return createLibraryAdminRouter();
}

export const comicLibraryPublicRouter = createComicLibraryPublicRouter();
export const comicLibraryAdminRouter = createComicLibraryAdminRouter();
