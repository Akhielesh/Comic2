// Model catalog routes (models.md §4.3–§4.6 / §5.1 M1-CATALOG). Mounted once in comicMounts.ts under /api/comic,
// after the global requireAuth, with the text rate limit on these exact paths (modelRoutesTextLimit). The static
// GET /api/comic/models (routes/comic.ts) is untouched: this router never matches the bare /models path, and
// /models/status and /models/lab/* belong to their own routers.
//
//   GET /api/comic/models/catalog?projectId=   ModelCatalogRow[]; with a projectId the comic's owner also gets
//                                               `fit` (shared modelFit over that doc and their StudioCaps) and
//                                               `current` (the locked or migrated model)
//   GET /api/comic/models/trends?range=30d|90d  T2–T7 (models.md §4.4), only from data we hold
//   GET /api/comic/models/:id[?projectId=]      one model's detail (row + registry facts + history)
//
// Signed-in users only (401 otherwise). A projectId is loaded owner-scoped, so anyone else gets the same 404 as a
// missing comic. Answers are per user (their observed costs and reliability), so they are never cached publicly.
// Nothing here spends: the catalog reads OpenRouter's free public endpoints on demand and our own tables.
//
// Governed users (on the included usage: not an admin, not on their own key; server/src/comic/costText.ts) never
// see dollars: every answer carries `X-Cost-View: usage | dollars`, and for a usage view each free-text `note`
// loses the parts that name a dollar amount (the numbers stay; the UI words them with formatCostForUser).

import { Router, type NextFunction, type Request, type Response } from 'express';
import type { StudioCaps } from '../../../shared/comic/capabilities.js';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities.js';
import type { ComicDoc } from '../../../shared/comic/doc.js';
import { logger } from '../lib/logger.js';
import { studioCapsFor } from '../comic/access.js';
import { costViewFor, type CostView } from '../comic/costText.js';
import { spendIsByok } from '../comic/jobs.js';
import { studioKeysFromRequest } from '../comic/keys.js';
import { TREND_RANGES, modelCatalog, type ModelCatalog, type TrendRange } from '../comic/models/index.js';
import { getStudioSession } from '../comic/session.js';
import { createSupabaseDocStore } from '../comic/store.js';
import { StudioError, type DocStore, type StudioKeys } from '../comic/types.js';

/** Kept for the W-M stubs that still import it (comicModelStatus.ts until M1-RELIABILITY replaces it). */
export const NOT_BUILT = { error: 'not built yet' } as const;
/** Sub-paths of /models that other routers own (never treated as a model id). */
const RESERVED_MODEL_SEGMENTS: ReadonlySet<string> = new Set(['status', 'lab']);

export const MODELS_PATHS = ['/models/catalog', '/models/trends', '/models/:id'] as const;

const PROJECT_ID = /^[A-Za-z0-9-]{1,64}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const NOT_FOUND_COMIC = "This comic doesn't exist or you don't have access to it.";

export interface ComicModelsRouterDeps {
  /** Default: the process catalog (lazy). */
  catalog?: () => ModelCatalog;
  store?: DocStore;
  /** Overrides for tests (default: studioCapsFor with the request's keys). */
  capsFor?: (req: Request, opts: { byok: boolean }) => Promise<StudioCaps>;
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
  logger.error('comic_models_route_failed', { message: (err as Error)?.message });
  res.status(500).json({ error: { message: "Couldn't load model information right now — please try again.", code: 'INTERNAL' } });
}

const userOf = (req: Request): string => {
  const userId = req.user?.id;
  if (!userId) throw new StudioError('FORBIDDEN', 'Sign in to use the comic studio.', { status: 401 });
  return userId;
};

const queryString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * A copy of an answer without dollar text: every `note` string keeps only its " · "-separated parts that name no
 * dollar amount (and is dropped when nothing is left). Numbers are untouched.
 */
export const withoutDollarNotes = <T>(value: T): T => {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'note' && typeof x === 'string') {
        const kept = x
          .split(' · ')
          .filter((part) => !part.includes('$'))
          .join(' · ');
        if (kept) out[k] = kept;
        continue;
      }
      out[k] = walk(x);
    }
    return out;
  };
  return walk(value) as T;
};

export function createComicModelsRouter(deps: ComicModelsRouterDeps = {}): Router {
  const router = Router();
  const catalog = deps.catalog ?? modelCatalog;
  const store = lazy(() => deps.store || createSupabaseDocStore());

  /** The request's caps (plan, admin, own key): they decide `fit` and the cost view. A lookup failure is governed. */
  const capsOf = async (req: Request): Promise<StudioCaps> => {
    const keys = deps.keysFor ? deps.keysFor(req) : studioKeysFromRequest(req);
    try {
      return await (deps.capsFor ?? ((r, o) => studioCapsFor(r, o)))(req, { byok: spendIsByok(keys) });
    } catch {
      return { ...DEFAULT_CAPS };
    }
  };

  /** The owner's doc for `fit`, or nothing when no projectId was asked for. */
  const fitContext = async (req: Request, userId: string, caps: StudioCaps): Promise<{ doc?: ComicDoc; caps?: StudioCaps }> => {
    const raw = queryString(req.query.projectId);
    if (raw === undefined || raw === '') return {};
    if (!PROJECT_ID.test(raw)) throw new StudioError('NOT_FOUND', NOT_FOUND_COMIC, { status: 404 });
    const session = await getStudioSession(raw, userId, store());
    return { doc: session.doc, caps };
  };

  const handle =
    (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction): void => {
      res.vary('Authorization');
      fn(req, res, next).catch((err) => sendError(res, err, next));
    };

  const reply = (res: Response, body: unknown, view: CostView) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Cost-View', view.governed ? 'usage' : 'dollars');
    res.json(view.governed ? withoutDollarNotes(body) : body);
  };

  router.get(
    '/models/catalog',
    handle(async (req, res) => {
      const userId = userOf(req);
      const caps = await capsOf(req);
      const ctx = await fitContext(req, userId, caps);
      reply(res, await catalog().rows({ userId, ...ctx }), costViewFor(caps));
    })
  );

  router.get(
    '/models/trends',
    handle(async (req, res) => {
      const userId = userOf(req);
      const raw = queryString(req.query.range) ?? '30d';
      if (!(TREND_RANGES as readonly string[]).includes(raw)) throw new StudioError('BAD_REQUEST', 'Pick a range of 30d or 90d.', { status: 400 });
      const caps = await capsOf(req);
      reply(res, await catalog().trends(raw as TrendRange, { userId }), costViewFor(caps));
    })
  );

  router.get(
    '/models/:id',
    handle(async (req, res, next) => {
      const id = String(req.params.id ?? '');
      if (RESERVED_MODEL_SEGMENTS.has(id.toLowerCase())) return next();
      const userId = userOf(req);
      if (!MODEL_ID.test(id)) throw new StudioError('NOT_FOUND', "We don't know that model.", { status: 404 });
      const caps = await capsOf(req);
      const ctx = await fitContext(req, userId, caps);
      const detail = await catalog().model(id, { userId, ...ctx });
      if (!detail) throw new StudioError('NOT_FOUND', "We don't know that model.", { status: 404 });
      reply(res, detail, costViewFor(caps));
    })
  );

  return router;
}

export const comicModelsRouter = createComicModelsRouter();
