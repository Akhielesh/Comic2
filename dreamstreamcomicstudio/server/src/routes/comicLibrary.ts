// Platform asset library HTTP surface (contract §14.1; assets.md). Wave-0 stub by P0-B;
// owned in wave 1 by P1-LIBRARY, which replaces it IN PLACE (keep the export names). The
// router logic lives in ../comic/library/index.ts (createLibraryPublicRouter /
// createLibraryAdminRouter); this file is what routes/comicMounts.ts mounts:
//
//   public  GET /api/comic/public/library                       ETag; 5-minute cache; mounted BEFORE /api/comic/public
//   admin   /api/comic/admin/library/*                          requireAdmin; client-driven steps (n ≤ 3 per call)
//
// Stub behaviour: 501 NOT_AVAILABLE.

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
