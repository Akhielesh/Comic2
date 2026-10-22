// Platform asset library seams (contract §12.8, assets.md). Wave-0 stub by P0-B; owned in
// wave 1 by P1-LIBRARY, which replaces both factories IN PLACE (same names, same signatures).
//
// The build is CLIENT-DRIVEN from the admin console (each `step` call advances ≤ 3 assets
// synchronously) so a sleeping container can never kill a long job (decisions-final #4).
// Stub behaviour: both routers answer 501 NOT_AVAILABLE for every path.

import { Router } from 'express';
import { notAvailableHandler } from '../extensions.js';

const LIBRARY_UNAVAILABLE = "The asset library isn't available yet.";

/** GET / — the published library index (mounted at /api/comic/public/library; ETag, 5-minute cache). */
export function createLibraryPublicRouter(): Router {
  const router = Router();
  router.use(notAvailableHandler(LIBRARY_UNAVAILABLE));
  return router;
}

/** Admin console: manifest, quote, runs, runs/:id/step {n ≤ 3}, cancel, assets/:id/{publish,reject,regenerate}, purge-candidates. */
export function createLibraryAdminRouter(): Router {
  const router = Router();
  router.use(notAvailableHandler(LIBRARY_UNAVAILABLE));
  return router;
}
