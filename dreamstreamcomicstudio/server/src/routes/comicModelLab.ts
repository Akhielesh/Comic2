// Model Lab routes (wm-plan M1-MODEL-LAB; models.md §2.6): the admin-only, click-driven paid checks D1–D4. The logic
// lives in ../comic/models/lab.ts; this file is the HTTP surface. Mounted once in comicMounts.ts under /api/comic, with
// requireAdmin + the admin rate limit on the exact /api/comic/models/lab prefix (never the text limiter). This router
// re-checks sign-in and admin on its own paths too, so it stays admin-only even if it were mounted elsewhere.
// No timers: every paid call needs an explicit admin click carrying the quoted cost; hard cap $2 per UTC day.
//
//   GET  /api/comic/models/lab                        overview: every check with its quote, today's spend, results,
//                                                     blind pairs (names hidden until voted)
//   POST /api/comic/models/lab/runs                   { itemId, idempotencyKey, ack: true, quotedUsd } → one call
//   POST /api/comic/models/lab/runs/:id/watermark     { visible: true | false | null } (the owner's checkbox)
//   POST /api/comic/models/lab/blind/:pairId/vote     { pick: 'A' | 'B' | 'tie' } → the pair, revealed
//
// Every answer is `Cache-Control: private, no-store`. Errors: { error: { code, message, details? } } with the lab's
// own code (ACK_REQUIRED, LAB_CAP_REACHED, QUOTE_CHANGED, PROVIDER_DOWN, …) and honest copy.

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { logger } from '../lib/logger.js';
import { requireAdmin as requireAdminMiddleware } from '../middleware/requireAdmin.js';
import { createDefaultLabDeps, createModelLab, isLabError, type ModelLab } from '../comic/models/lab.js';
import { StudioError } from '../comic/types.js';

export const MODEL_LAB_BASE = '/models/lab';

export interface ComicModelLabRouterDeps {
  /** The lab (default: built lazily from the production deps on the first request). */
  lab?: ModelLab | (() => ModelLab);
  /** Admin guard override for tests (default: middleware/requireAdmin). */
  requireAdmin?: RequestHandler;
}

const PAIR_ID_RE = /^[a-z0-9-]{1,40}$/;
const RUN_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

function sendError(res: Response, err: unknown, next: NextFunction): void {
  if (res.headersSent) return next(err);
  res.set('Cache-Control', 'private, no-store');
  if (isLabError(err)) {
    res.status(err.status).json({ error: { code: err.labCode, message: err.userMessage, ...(err.details ? { details: err.details } : {}) } });
    return;
  }
  if (err instanceof StudioError) {
    res.status(err.status).json({ error: { code: err.code, message: err.userMessage } });
    return;
  }
  logger.error('comic_model_lab_failed', { message: String((err as Error)?.message || err).slice(0, 200) });
  res.status(500).json({ error: { code: 'INTERNAL', message: "The Model Lab couldn't finish that. If a check was running, its result shows after a refresh." } });
}

const signedIn: RequestHandler = (req, res, next) => {
  if (req.user?.id) return next();
  res.set('Cache-Control', 'private, no-store');
  res.status(401).json({ error: { message: 'Sign in to use the comic studio.', code: 'FORBIDDEN' } });
};

export function createComicModelLabRouter(deps: ComicModelLabRouterDeps = {}): Router {
  const router = Router();
  const requireAdmin = deps.requireAdmin || requireAdminMiddleware;
  let built: ModelLab | undefined;
  const lab = (): ModelLab => {
    if (typeof deps.lab === 'function') return deps.lab();
    if (deps.lab) return deps.lab;
    return (built ??= createModelLab(createDefaultLabDeps()));
  };
  const handle =
    (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
    (req, res, next) => {
      res.set('Cache-Control', 'private, no-store');
      res.vary('Authorization');
      fn(req, res).catch((err) => sendError(res, err, next));
    };

  // Guards first, on every lab path (and only on lab paths: everything else falls through untouched).
  router.use(MODEL_LAB_BASE, signedIn, requireAdmin);

  router.get(
    MODEL_LAB_BASE,
    handle(async (req, res) => {
      res.json(await lab().overview(req.user!.id));
    })
  );

  router.post(
    `${MODEL_LAB_BASE}/runs`,
    handle(async (req, res) => {
      res.json(await lab().run(req.user!.id, req.body));
    })
  );

  router.post(
    `${MODEL_LAB_BASE}/runs/:id/watermark`,
    handle(async (req, res) => {
      const id = String(req.params.id || '');
      if (!RUN_ID_RE.test(id)) throw new StudioError('NOT_FOUND', 'That lab result is gone.', { status: 404 });
      res.json(await lab().setWatermark(req.user!.id, id, req.body));
    })
  );

  router.post(
    `${MODEL_LAB_BASE}/blind/:pairId/vote`,
    handle(async (req, res) => {
      const pairId = String(req.params.pairId || '');
      if (!PAIR_ID_RE.test(pairId)) throw new StudioError('NOT_FOUND', 'There is no such blind pair.', { status: 404 });
      res.json(await lab().vote(req.user!.id, pairId, req.body));
    })
  );

  // Any other lab path or method: answered here, never by the studio router.
  router.all([MODEL_LAB_BASE, `${MODEL_LAB_BASE}/*`], (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such Model Lab action.' } });
  });

  return router;
}

export const comicModelLabRouter = createComicModelLabRouter();
