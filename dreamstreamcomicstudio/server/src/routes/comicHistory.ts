// Comic History owner routes (versions plan §5, §12; package H0 STUB — H3 replaces the router in place, keeping
// every export name and signature).
//
//   GET  /projects/:id/history                 moments (rows + signed thumbs, cursor, filters)
//   GET  /projects/:id/history/compare?a=&b=   compare two moments / now / published / alt:<id>
//   GET  /projects/:id/history/:vid            one moment with "what changed"
//   GET  /projects/:id/history/:vid/book       the reassembled, normalized book + display URLs (read-only reader)
//   POST /projects/:id/history/:vid/urls       lazy signed URLs for that version's history/archive images
//   GET  /projects/:id/history/alternatives    "Versions you're trying" (H7)
//
// Owner-only by construction: mounted after requireAuth with the owner routers (comicMounts.ts), every query scoped
// by project AND user, and a foreign or missing id answers the same 404 (no oracle). Never public: nothing under
// publication/**, comics-edge/** or the public reader router imports history.
//
// H0: while COMIC_HISTORY is off (the default) these paths fall through untouched (nothing observable changes);
// with it on, every history path answers that same 404 with no detail until H3 lands.
//
// routes/comic.ts reaches the history seams through this module (the env flag, the request time zone), so the file
// that also holds the public reader router never imports comic/history directly.

import { Router, type RequestHandler } from 'express';
import { isHistoryEnabled, rememberTurnTimeZone } from '../comic/history/hooks.js';

/** Every path this router owns (exact; anything else falls through). */
export const HISTORY_PATHS = ['/projects/:id/history', '/projects/:id/history/*'];

/** The one 404 body of every history path: the same answer as a missing comic, nothing more. */
export const HISTORY_NOT_FOUND = { error: { message: "This comic doesn't exist or you don't have access to it.", code: 'NOT_FOUND' } } as const;

/** Comic History is on for this server (COMIC_HISTORY=1). */
export const historyRoutesEnabled = (): boolean => isHistoryEnabled();

/** `mw` only while Comic History is on; otherwise the request passes untouched (no double rate-limit counting). */
export const historyRouteGate =
  (mw: RequestHandler): RequestHandler =>
  (req, res, next) =>
    isHistoryEnabled() ? mw(req, res, next) : next();

/** Remember the stream request's time zone on its turn context (comic/history/hooks.ts). */
export { rememberTurnTimeZone };

export function createComicHistoryRouter(): Router {
  const router = Router();
  router.all(HISTORY_PATHS, (_req, res, next) => {
    if (!isHistoryEnabled()) return next();
    res.set('Cache-Control', 'private, no-store');
    res.status(404).json(HISTORY_NOT_FOUND);
  });
  return router;
}

export const comicHistoryRouter = createComicHistoryRouter();
