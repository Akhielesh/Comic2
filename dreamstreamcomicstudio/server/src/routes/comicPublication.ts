// Owner publication API (contract §14.1; sharing.md §4.1). Owner: P1-PUBLISH.
//
//   GET    /api/comic/projects/:id/publication              → PublicationOwnerView
//   POST   /api/comic/projects/:id/publication              PublishRequest → view (201 first publish, 200 update)
//   PATCH  /api/comic/projects/:id/publication              PublicationSettingsPatch → view
//   DELETE /api/comic/projects/:id/publication              → view (status unpublished; idempotent)
//   POST   /api/comic/projects/:id/publication/regenerate   → view (new slug; the old link 404s)
//
// Mounted on /api/comic AFTER the global requireAuth (routes/comicMounts.ts), behind
// requireActiveUser() and comicPublishRateLimit on writes (10/min, 60/day). The owner is the
// verified JWT user (req.user.id) — never a body field — and the session is loaded owner-scoped,
// so anyone else (or a share-link holder, who has no JWT) gets 401/404. A restricted account
// can read its publication but not publish. Errors carry `{ error: { message, code, details? } }`
// with code NOT_READY / SAFETY_BLOCKED / LANG_INCOMPLETE / CONFLICT / NOT_FOUND / BAD_REQUEST.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { effectiveRating } from '../../../shared/comic/safety.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities.js';
import { logger } from '../lib/logger.js';
import { studioCapsFor, type StudioCapsDeps } from '../comic/access.js';
import { createSupabaseAssetStore } from '../comic/assets.js';
import { createStudioContext, type StudioContextDeps } from '../comic/context.js';
import { spendIsByok } from '../comic/jobs.js';
import { studioKeysFromRequest } from '../comic/keys.js';
import {
  getPublicationView,
  publishWithOutcome,
  PublishError,
  regenerateLink,
  unpublish,
  updatePublication
} from '../comic/publication/index.js';
import { getStudioSession } from '../comic/session.js';
import { createSupabaseDocStore } from '../comic/store.js';
import { StudioError, type AssetStore, type DocStore, type StudioContext } from '../comic/types.js';

export const PUBLICATION_PATHS = ['/projects/:id/publication', '/projects/:id/publication/*'];

const PROJECT_ID = /^[A-Za-z0-9-]{1,64}$/;
const RESTRICTED_PUBLISH_MESSAGE = 'Your account is limited right now, so publishing is paused. You can still read and edit your comic.';

export interface ComicPublicationRouterDeps {
  store?: DocStore;
  assets?: AssetStore;
  contextDeps?: (req: Request) => StudioContextDeps;
  capsDeps?: StudioCapsDeps;
}

const lazy = <T>(make: () => T) => {
  let v: T | undefined;
  return () => (v ??= make());
};

function sendError(res: Response, err: unknown, next: NextFunction): void {
  if (res.headersSent) return next(err);
  res.set('Cache-Control', 'no-store');
  if (err instanceof PublishError) {
    res.status(err.status).json({ error: { message: err.userMessage, code: err.reason, ...(err.details ? { details: err.details } : {}) } });
    return;
  }
  if (err instanceof StudioError) {
    if (err.status >= 500) logger.warn('comic_publication_route_error', { code: err.code, status: err.status });
    res.status(err.status).json({ error: { message: err.userMessage, code: err.code } });
    return;
  }
  logger.error('comic_publication_route_failed', { message: (err as Error)?.message });
  res.status(500).json({ error: { message: 'Something went wrong. Your comic is unchanged — please try again.', code: 'INTERNAL' } });
}

export function createComicPublicationRouter(deps: ComicPublicationRouterDeps = {}): Router {
  const router = Router();
  const store = lazy(() => deps.store || createSupabaseDocStore());
  const assets = lazy(() => deps.assets || createSupabaseAssetStore());

  const contextFor = async (req: Request, res: Response): Promise<StudioContext> => {
    const userId = req.user?.id;
    if (!userId) throw new StudioError('FORBIDDEN', 'Sign in to publish your comic.', { status: 401 });
    const projectId = String(req.params.id || '');
    if (!PROJECT_ID.test(projectId)) throw new StudioError('NOT_FOUND', "This comic doesn't exist or you don't have access to it.", { status: 404 });
    const session = await getStudioSession(projectId, userId, store());
    const contextDeps = deps.contextDeps?.(req) || {};
    const keys = contextDeps.keys || studioKeysFromRequest(req);
    let caps: StudioCaps;
    try {
      caps = await studioCapsFor(req, { byok: spendIsByok(keys) }, deps.capsDeps);
    } catch {
      caps = { ...DEFAULT_CAPS };
    }
    const rating = effectiveRating(session.doc, caps.ratingCeiling).rating;
    return createStudioContext({ req, session, deps: { ...contextDeps, keys, assets: contextDeps.assets || assets() }, caps, rating });
  };

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction): void => {
      res.vary('Authorization');
      fn(req, res).catch((err) => sendError(res, err, next));
    };

  const refuseRestricted = (res: Response) => {
    if ((res.locals as Record<string, unknown>)?.moderationStatus === 'restricted') {
      throw new StudioError('FORBIDDEN', RESTRICTED_PUBLISH_MESSAGE, { status: 403 });
    }
  };

  const reply = (res: Response, status: number, body: unknown) => {
    res.set('Cache-Control', 'private, no-store');
    res.status(status).json(body);
  };

  router.get(
    '/projects/:id/publication',
    handle(async (req, res) => {
      const ctx = await contextFor(req, res);
      reply(res, 200, await getPublicationView(ctx));
    })
  );

  router.post(
    '/projects/:id/publication',
    handle(async (req, res) => {
      refuseRestricted(res);
      const ctx = await contextFor(req, res);
      const { view, firstTime } = await publishWithOutcome(ctx, req.body);
      reply(res, firstTime ? 201 : 200, view);
    })
  );

  router.patch(
    '/projects/:id/publication',
    handle(async (req, res) => {
      refuseRestricted(res);
      const ctx = await contextFor(req, res);
      reply(res, 200, await updatePublication(ctx, req.body));
    })
  );

  router.delete(
    '/projects/:id/publication',
    handle(async (req, res) => {
      // Unpublishing is always allowed (even for a restricted account): it only takes content down.
      const ctx = await contextFor(req, res);
      reply(res, 200, await unpublish(ctx));
    })
  );

  router.post(
    '/projects/:id/publication/regenerate',
    handle(async (req, res) => {
      refuseRestricted(res);
      const ctx = await contextFor(req, res);
      reply(res, 200, await regenerateLink(ctx));
    })
  );

  // Anything else on these paths: a clean 404 in the studio's error shape (never falls through).
  router.all(PUBLICATION_PATHS, (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store').status(404).json({ error: { message: 'Not found.', code: 'NOT_FOUND' } });
  });

  return router;
}

export const comicPublicationRouter = createComicPublicationRouter();
