// Translation quote API (contract §14.1; i18n.md §8.4). Owner: P1-I18N.
//
//   GET /api/comic/projects/:id/translation-quote?langs=te,hi
//       200 {perLanguage:[{lang, lines, free, upToDate, usd, seconds}], usd, byok, unknown?}
//
// Mounted on /api/comic after requireAuth (routes/comicMounts.ts), behind the text limit and
// comicTranslateQuoteRateLimit (30/min). OWNER ONLY: the session is loaded owner-scoped from the
// verified JWT user, so anyone else gets the same 404 as a missing project. Quoting never spends,
// never commits and never calls a model — the client never duplicates the price tables.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { DOC_LIMITS } from '../../../shared/comic/limits.js';
import { logger } from '../lib/logger.js';
import { quoteTranslation, resolveLanguages } from '../comic/i18n/index.js';
import { studioKeysFromRequest } from '../comic/keys.js';
import { getStudioSession } from '../comic/session.js';
import { createSupabaseDocStore } from '../comic/store.js';
import { StudioError, type DocStore, type StudioKeys } from '../comic/types.js';

export const I18N_PATHS = ['/projects/:id/translation-quote'];

const PROJECT_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_LANGS_PARAM = 400;

export interface ComicI18nRouterDeps {
  store?: DocStore;
  /** Keys override for tests (default: the request's resolved account keys). */
  keysFor?: (req: Request) => StudioKeys;
}

const lazy = <T>(make: () => T) => {
  let v: T | undefined;
  return () => (v ??= make());
};

function sendError(res: Response, err: unknown, next: NextFunction): void {
  if (res.headersSent) return next(err);
  res.set('Cache-Control', 'private, no-store');
  if (err instanceof StudioError) {
    res.status(err.status).json({ error: { message: err.userMessage, code: err.code } });
    return;
  }
  logger.error('comic_translation_quote_failed', { message: (err as Error)?.message });
  res.status(500).json({ error: { message: "Couldn't price the translation right now — please try again.", code: 'INTERNAL' } });
}

export function createComicI18nRouter(deps: ComicI18nRouterDeps = {}): Router {
  const router = Router();
  const store = lazy(() => deps.store || createSupabaseDocStore());

  router.get(I18N_PATHS[0], (req: Request, res: Response, next: NextFunction) => {
    res.vary('Authorization');
    (async () => {
      const userId = req.user?.id;
      if (!userId) throw new StudioError('FORBIDDEN', 'Sign in to use the comic studio.', { status: 401 });
      const projectId = String(req.params.id || '');
      if (!PROJECT_ID.test(projectId)) throw new StudioError('NOT_FOUND', "This comic doesn't exist or you don't have access to it.", { status: 404 });
      const session = await getStudioSession(projectId, userId, store());
      const raw = typeof req.query.langs === 'string' ? req.query.langs.slice(0, MAX_LANGS_PARAM) : '';
      const { codes, unknown } = resolveLanguages(session.doc, raw.split(',').slice(0, DOC_LIMITS.editions + 4));
      if (!codes.length) throw new StudioError('BAD_REQUEST', 'Pick at least one language to translate into.', { status: 400 });
      const keys = deps.keysFor ? deps.keysFor(req) : studioKeysFromRequest(req);
      const q = quoteTranslation(session.doc, keys, { languages: codes });
      res.set('Cache-Control', 'private, no-store');
      res.json({
        perLanguage: q.perLanguage,
        usd: q.estimate.usd,
        byok: q.byok,
        ...(unknown.length ? { unknown: unknown.map((u) => u.slice(0, 20)).slice(0, 10) } : {})
      });
    })().catch((err) => sendError(res, err, next));
  });

  return router;
}

export const comicI18nRouter = createComicI18nRouter();
