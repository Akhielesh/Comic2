// Translation quote API (contract §14.1; i18n.md). Wave-0 stub by P0-B; owned in wave 1 by
// P1-I18N, which replaces the route IN PLACE (keep the export names).
//
//   GET /api/comic/projects/:id/translation-quote?langs=
//       {perLanguage:[{lang, lines, free, upToDate, usd, seconds}], usd, byok}
//
// Mounted on /api/comic after requireAuth (routes/comicMounts.ts), behind the text limit and
// comicTranslateQuoteRateLimit (30/min). Quoting never spends. Stub behaviour: 501 NOT_AVAILABLE.

import { Router } from 'express';
import { notAvailableHandler } from '../comic/extensions.js';

export const I18N_PATHS = ['/projects/:id/translation-quote'];

export function createComicI18nRouter(): Router {
  const router = Router();
  router.all(I18N_PATHS, notAvailableHandler("Translation isn't available yet."));
  return router;
}

export const comicI18nRouter = createComicI18nRouter();
