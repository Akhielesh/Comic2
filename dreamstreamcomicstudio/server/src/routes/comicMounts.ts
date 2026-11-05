// Comic Studio route mounting, in contract §14.1 order (P0-B; called exactly twice from
// server/src/index.ts). Kept in one place so the ORDER is testable (comicMounts.test.ts):
//
//   before requireAuth (public)
//     /api/comic/public/library   library index           — before /api/comic/public, so "library" is never an :id
//     /api/comic/public/s         reader reports          — before /api/comic/public, so "s" is never an :id
//     /api/comic/public           the reader (existing)
//   after requireAuth (owner/admin)
//     /api/comic/admin/library    admin library console   — before /api/comic
//     /api/comic/admin/storage    storage maintenance     — before /api/comic
//     /api/moderation/comic-cases moderator queue         — before /api/moderation
//     /api/comic/models/lab       Model Lab (W-M)         — requireAdmin + admin rate limit, before the owner model routes
//     /api/comic/models/*         model status + catalog  — W-M routers, text rate limit on their exact paths only
//     /api/comic                  feature owner routers (publication, refs, i18n, safety appeal, models, model status, lab,
//                                 classic history before history — so "legacy" is never a version id)
//     /api/comic                  the studio (existing, text rate limit; also serves the static GET /models)
//
// Feature routers answer ONLY their own paths, so everything else falls through to the
// studio router untouched. Per-route limits (contract §14.3) are mounted on the exact
// paths, never on the whole /api/comic prefix, so no request is counted twice.
//
// Refusals decided BEFORE the studio router — the global requireAuth 401 and the rate-limit 429s —
// never reach comic_stream_refused / comic_request_refused, so mountComicPublicRoutes (which runs
// before requireAuth) also installs a passive observer: one structured `comic_edge_refused` line per
// 401/429 on a comic path (route PATTERN, status, userId or a daily-salted ip hash; never the raw
// URL, query, body or IP). It only listens for 'finish' and never changes a response.

import crypto from 'node:crypto';
import type { Express, Request, RequestHandler, Response, Router } from 'express';
import { logger } from '../lib/logger.js';
import { requireActiveUser } from '../comic/safety/index.js';
import { comicI18nRouter } from './comicI18n.js';
import { comicLibraryAdminRouter, comicLibraryPublicRouter } from './comicLibrary.js';
import { comicModelLabRouter } from './comicModelLab.js';
import { comicModelStatusRouter } from './comicModelStatus.js';
import { comicModelsRouter } from './comicModels.js';
import { comicPublicationRouter } from './comicPublication.js';
import { comicRefsRouter } from './comicRefs.js';
import { comicModerationRouter, comicReportRouter, comicSafetyRouter } from './comicSafety.js';
import { comicStorageAdminRouter } from './comicStorageAdmin.js';
// --- history (versions plan §12; H0 stubs, H3/H6 replace them) ---
import { comicHistoryRouter, historyRouteGate } from './comicHistory.js';
import { comicLegacyHistoryRouter } from './comicLegacyHistory.js';

/** The §14.3 limiters (each may be several windows, e.g. 30/min AND 300/h). */
export interface ComicRateLimits {
  upload: RequestHandler[];
  publish: RequestHandler[];
  report: RequestHandler[];
  translateQuote: RequestHandler[];
}

export interface ComicPublicMountDeps {
  systemRateLimit: RequestHandler;
  optionalAuth: RequestHandler;
  limits: Pick<ComicRateLimits, 'report'>;
  /** The existing public reader router (routes/comic.ts). */
  comicPublicRouter: Router | RequestHandler;
  /** Overrides for tests. */
  libraryPublicRouter?: Router | RequestHandler;
  reportRouter?: Router | RequestHandler;
}

export interface ComicOwnerMountDeps {
  textRateLimit: RequestHandler;
  adminRateLimit: RequestHandler;
  moderationRateLimit: RequestHandler;
  requireAdmin: RequestHandler;
  requireModerator: RequestHandler;
  limits: Omit<ComicRateLimits, 'report'>;
  /** The existing studio router (routes/comic.ts). */
  comicRouter: Router | RequestHandler;
  /** Overrides for tests. */
  requireActive?: RequestHandler;
  libraryAdminRouter?: Router | RequestHandler;
  storageAdminRouter?: Router | RequestHandler;
  moderationRouter?: Router | RequestHandler;
  featureRouters?: (Router | RequestHandler)[];
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// ── Early-refusal observer ───────────────────────────────────────────────────

/** Statuses decided before the studio router (auth, rate limits). */
const EARLY_REFUSALS: ReadonlySet<number> = new Set([401, 429]);
/** Path segments that are routes, never ids (kept verbatim in the logged pattern). */
const STATIC_SEGMENTS: ReadonlySet<string> = new Set([
  'api', 'comic', 'moderation', 'comic-cases', 'public', 'library', 's', 'report', 'admin', 'storage', 'migrate-refs', 'projects',
  'stream', 'publication', 'regenerate', 'refs', 'inbox', 'crop', 'translation-quote', 'safety-review', 'urls', 'cancel', 'runs',
  'step', 'quote', 'assets', 'reject', 'publish', 'manifest', 'appeal', 'og', 'embed', 'tail',
  'models', 'catalog', 'trends', 'status', 'lab',
  // --- history ---
  'history', 'compare', 'book', 'legacy', 'alternatives', 'forget'
]);
const MAX_PATTERN_SEGMENTS = 8;

/** The route PATTERN of a comic URL: query dropped, every non-route segment (ids, slugs, paths) → ':id'. */
export const comicRoutePattern = (url: string): string => {
  const path = String(url || '').split('?')[0].split('#')[0];
  const segments = path.split('/').filter(Boolean).slice(0, MAX_PATTERN_SEGMENTS);
  return `/${segments.map((seg) => (STATIC_SEGMENTS.has(seg.toLowerCase()) ? seg.toLowerCase() : ':id')).join('/')}`;
};

const OBSERVER_SALT = crypto.randomBytes(16).toString('hex'); // per process: correlates a day's lines, never reversible
/** Daily-salted, truncated client fingerprint (the raw IP is never logged). */
export const refusalIpHash = (ip: string | undefined, now = Date.now(), salt = OBSERVER_SALT): string =>
  crypto.createHash('sha256').update(`${salt}|${new Date(now).toISOString().slice(0, 10)}|${ip || 'unknown'}`).digest('hex').slice(0, 16);

/** Log-flood guard: at most this many refusal lines per minute per process; the rest are counted and summarized. */
export const REFUSAL_LOG_PER_MINUTE = 120;

/**
 * Passive: logs one `comic_edge_refused` line when a comic request ends in 401/429 (unless a router already
 * logged it and set res.locals.comicRefusalLogged). Mounted before requireAuth so it sees those refusals too.
 * A flood (≥ REFUSAL_LOG_PER_MINUTE in a minute) is summarized as one `comic_edge_refused_suppressed` line
 * when the next minute's first refusal arrives — no timers.
 */
export const comicRefusalObserver = (now: () => number = Date.now): RequestHandler => {
  let windowStart = 0;
  let logged = 0;
  let suppressed = 0;
  const onRefusal = (req: Request, res: Response) => {
    if (!EARLY_REFUSALS.has(res.statusCode) || res.locals?.comicRefusalLogged) return;
    const t = now();
    if (t - windowStart >= 60_000) {
      if (suppressed) logger.info('comic_edge_refused_suppressed', { count: suppressed, windowStart });
      windowStart = t;
      logged = 0;
      suppressed = 0;
    }
    if (logged >= REFUSAL_LOG_PER_MINUTE) {
      suppressed += 1;
      return;
    }
    logged += 1;
    const userId = (req as Request & { user?: { id?: string } }).user?.id || null;
    logger.info('comic_edge_refused', {
      requestId: (req as Request & { requestId?: string }).requestId,
      method: req.method,
      route: comicRoutePattern(req.originalUrl || req.url),
      status: res.statusCode,
      userId,
      ...(userId ? {} : { ipHash: refusalIpHash(req.ip) })
    });
  };
  return (req: Request, res: Response, next) => {
    res.once('finish', () => onRefusal(req, res));
    next();
  };
};

/** Apply limiters to writes only (reading the publication view never counts as a publish). */
export const onlyWrites =
  (limiters: RequestHandler[]): RequestHandler =>
  (req, res, next) => {
    if (READ_METHODS.has(req.method)) return next();
    let i = 0;
    const step = (err?: unknown) => {
      if (err) return next(err);
      const limiter = limiters[i++];
      if (!limiter) return next();
      try {
        const out = limiter(req, res, step) as unknown;
        if (out && typeof (out as Promise<unknown>).catch === 'function') (out as Promise<unknown>).catch(step);
      } catch (e) {
        step(e);
      }
    };
    step();
  };

/** The text limiter for /api/comic/models/*, skipping the bare list (the studio limits it) and the admin-limited lab. */
export const modelRoutesTextLimit =
  (textRateLimit: RequestHandler): RequestHandler =>
  (req, res, next) => {
    const path = req.path.split('?')[0];
    if (path === '/' || path === '' || path === '/lab' || path.startsWith('/lab/')) return next();
    return textRateLimit(req, res, next);
  };

/** Mount the public comic routes. Call BEFORE the global requireAuth. */
export function mountComicPublicRoutes(app: Express, deps: ComicPublicMountDeps): void {
  // Observe every comic request (public and owner) from here on, so the global requireAuth 401 and the
  // rate-limit 429s leave a structured line too. Never answers, never blocks.
  const observe = comicRefusalObserver();
  app.use('/api/comic', observe);
  app.use('/api/moderation/comic-cases', observe);
  app.use('/api/comic/public/library', deps.systemRateLimit, deps.libraryPublicRouter ?? comicLibraryPublicRouter);
  app.use('/api/comic/public/s', deps.optionalAuth, ...deps.limits.report, deps.reportRouter ?? comicReportRouter);
  // Comic Studio v4 reader for published comics (no session needed; optionalAuth lets an
  // owner preview their own unpublished comic).
  app.use('/api/comic/public', deps.systemRateLimit, deps.optionalAuth, deps.comicPublicRouter);
}

/** Mount the authenticated comic routes. Call AFTER requireAuth / account context / account keys. */
export function mountComicOwnerRoutes(app: Express, deps: ComicOwnerMountDeps): void {
  const requireActive = deps.requireActive ?? requireActiveUser();
  // Admin + moderation consoles (before /api/comic and /api/moderation).
  app.use('/api/comic/admin/library', deps.adminRateLimit, deps.requireAdmin, deps.libraryAdminRouter ?? comicLibraryAdminRouter);
  app.use('/api/comic/admin/storage', deps.adminRateLimit, deps.requireAdmin, deps.storageAdminRouter ?? comicStorageAdminRouter);
  app.use('/api/moderation/comic-cases', deps.moderationRateLimit, deps.requireModerator, deps.moderationRouter ?? comicModerationRouter);

  // Per-route limits for the feature owner routes (exact paths only).
  app.use('/api/comic/projects/:id/refs', requireActive, ...deps.limits.upload);
  app.use('/api/comic/projects/:id/publication', requireActive, deps.textRateLimit, onlyWrites(deps.limits.publish));
  app.use('/api/comic/projects/:id/translation-quote', deps.textRateLimit, ...deps.limits.translateQuote);
  app.use('/api/comic/projects/:id/safety-review', deps.textRateLimit);
  // W-M model routes. The Model Lab is admin-only (its guards sit on the exact prefix, before anything else can
  // answer); status, catalog, trends and :id take the text limiter on their exact paths. The bare /models path is
  // the studio router's static list and keeps the studio's own limiter, so no request is ever counted twice.
  app.use('/api/comic/models/lab', deps.adminRateLimit, deps.requireAdmin);
  app.use('/api/comic/models', modelRoutesTextLimit(deps.textRateLimit));
  // Comic History (owner-only): text-limited on its exact paths while COMIC_HISTORY is on; off, the paths reach the
  // studio exactly as before (never counted twice).
  app.use('/api/comic/projects/:id/history', historyRouteGate(deps.textRateLimit));
  app.use(
    '/api/comic',
    ...(deps.featureRouters ?? [
      comicPublicationRouter,
      comicRefsRouter,
      comicI18nRouter,
      comicSafetyRouter,
      comicModelLabRouter,
      comicModelStatusRouter,
      comicModelsRouter,
      comicLegacyHistoryRouter,
      comicHistoryRouter
    ])
  );

  // Comic Studio (conversational studio) — auth'd, text-tier rate limited; renders are
  // billed per image inside the job runner.
  app.use('/api/comic', deps.textRateLimit, deps.comicRouter);
}
