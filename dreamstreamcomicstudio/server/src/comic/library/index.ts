// Platform asset library HTTP surface (contract §12.8/§14.1, assets.md §8). Owned by P1-LIBRARY.
//
//   public  GET /                       (mounted at /api/comic/public/library, BEFORE /api/comic/public
//                                        so "library" is never parsed as a comic id) — the published
//                                        index; ETag; 5-minute single-flight cache; never fails the UI
//   admin   GET  /manifest              entries + stored state + active/last run + key/table status
//           POST /quote                 dry-run quote (no spend, no writes)
//           GET  /runs                  recent runs
//           POST /runs                  create a run (explicit admin click: {confirm: true}); no spend yet
//           GET  /runs/:id              run view
//           POST /runs/:id/step {n≤3}   advance ≤ n assets synchronously (client-driven; idempotent)
//           POST /runs/:id/cancel
//           POST /assets/:id/{publish,reject {note?, unpublish?},regenerate}
//           POST /assets/purge-candidates {dryRun?}
//
// The build is CLIENT-DRIVEN (decisions-final #4): no background job, so the container's
// 15-minute idle sleep can never kill it. The admin router sits behind requireAuth →
// adminRateLimit → requireAdmin (routes/comicMounts.ts).

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { LIBRARY_MANIFEST_VERSION, type LibraryBuildRequest, type LibraryIndex } from '../../../../shared/comic/library.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../observability/auditLog.js';
import { getSupabaseAdmin } from '../../services/supabase.js';
import { createSupabaseAssetStore } from '../assets.js';
import { createImageGenerator } from '../imageClient.js';
import { platformStudioKeys } from '../keys.js';
import { createLlmClient } from '../llm.js';
import { PUBLIC_BUCKET } from '../storagePaths.js';
import { StudioError } from '../types.js';
import { createSupabaseLibraryRepo } from './repo.js';
import {
  cancelRun,
  getRunView,
  manifestView,
  planQuote,
  publicIndex,
  publishAsset,
  purgeCandidates,
  regenerateAsset,
  rejectAsset,
  runSummary,
  startRun,
  stepRun,
  type LibraryDeps
} from './runner.js';

export * from './runner.js';
export { LIBRARY_MANIFEST, LIBRARY_CORE_COUNT, manifestEntry, promptHash, selectEntries, type LibraryManifestEntry } from './manifest.js';
export { createMemoryLibraryRepo, createSupabaseLibraryRepo, type LibraryRepo, type MemoryLibraryRepo } from './repo.js';

/** Public index cache lifetime (in-process; publish/reject invalidate it). */
export const LIBRARY_INDEX_TTL_MS = 5 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Default (production) dependencies, built lazily (no Supabase at import time) ─────────────

let indexCacheInvalidator: (() => void) | undefined;

export function createDefaultLibraryDeps(): LibraryDeps {
  const store = createSupabaseAssetStore();
  const bucket = PUBLIC_BUCKET;
  return {
    repo: createSupabaseLibraryRepo(),
    storage: {
      put: (path, buffer, contentType) => store.putObject(path, buffer, contentType, '31536000'),
      loadDataUrl: (path) => store.loadDataUrl(path),
      remove: (paths) => store.remove(paths),
      publicUrl: (path) => getSupabaseAdmin().storage.from(bucket).getPublicUrl(path).data.publicUrl
    },
    keys: () => platformStudioKeys(),
    images: (keys) => createImageGenerator(keys),
    llm: (keys) => createLlmClient(keys),
    now: () => Date.now(),
    bucket,
    audit: (input) => recordAudit(input),
    onPublishedChange: () => indexCacheInvalidator?.()
  };
}

/** Deps for a router: fixed, resolved per request (tests), or the lazily built production set. */
type DepsSource = LibraryDeps | (() => LibraryDeps);
const lazyDeps = (source?: DepsSource): (() => LibraryDeps) => {
  if (typeof source === 'function') return source;
  if (source) return () => source;
  let made: LibraryDeps | undefined;
  return () => (made ??= createDefaultLibraryDeps());
};

// ── Error shape (same as the studio routes) ──────────────────────────────────

const sendError = (res: Response, err: unknown, fallback: string) => {
  if (err instanceof StudioError) return res.status(err.status).json({ error: { code: err.code, message: err.userMessage } });
  if (/^MISSING_/.test(String((err as { publicCode?: unknown })?.publicCode || ''))) {
    return res.status(503).json({ error: { code: 'NOT_AVAILABLE', message: "Storage isn't configured on this server." } });
  }
  logger.error('comic_library_request_failed', { message: (err as Error)?.message });
  return res.status(500).json({ error: { code: 'INTERNAL', message: fallback } });
};

const handle =
  (fallback: string, fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res) => {
    fn(req, res).catch((err) => sendError(res, err, fallback));
  };

const bodyOf = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {});

/** Validate a build request body (types only; ids are checked against the manifest later). */
export function parseBuildRequest(body: Record<string, unknown>): LibraryBuildRequest {
  const out: LibraryBuildRequest = {};
  if (body.ids !== undefined) {
    if (!Array.isArray(body.ids) || body.ids.length > 200 || body.ids.some((x) => typeof x !== 'string' || x.length > 80)) {
      throw new StudioError('BAD_REQUEST', 'ids must be a list of library ids.', { status: 400 });
    }
    out.ids = body.ids as string[];
  }
  if (body.kinds !== undefined) {
    if (!Array.isArray(body.kinds) || body.kinds.length > 10 || body.kinds.some((x) => typeof x !== 'string')) {
      throw new StudioError('BAD_REQUEST', 'kinds must be a list of library kinds.', { status: 400 });
    }
    out.kinds = body.kinds as LibraryBuildRequest['kinds'];
  }
  for (const k of ['force', 'includeOptional'] as const) {
    if (body[k] !== undefined && typeof body[k] !== 'boolean') throw new StudioError('BAD_REQUEST', `${k} must be true or false.`, { status: 400 });
    if (body[k] === true) out[k] = true;
  }
  if (body.budgetUsd !== undefined) {
    if (typeof body.budgetUsd !== 'number' || !Number.isFinite(body.budgetUsd) || body.budgetUsd <= 0) {
      throw new StudioError('BAD_REQUEST', 'budgetUsd must be a positive number of dollars.', { status: 400 });
    }
    out.budgetUsd = body.budgetUsd;
  }
  if (body.maxRetries !== undefined) {
    if (body.maxRetries !== 0 && body.maxRetries !== 1 && body.maxRetries !== 2) throw new StudioError('BAD_REQUEST', 'maxRetries must be 0, 1 or 2.', { status: 400 });
    out.maxRetries = body.maxRetries;
  }
  return out;
}

const adminIdOf = (req: Request): string => {
  const id = (req as Request & { user?: { id?: string } }).user?.id;
  if (!id) throw new StudioError('FORBIDDEN', 'Admins only.', { status: 403 });
  return id;
};

const runIdOf = (req: Request): string => {
  const id = String(req.params.runId || '');
  if (!UUID_RE.test(id)) throw new StudioError('NOT_FOUND', 'That library build was not found.', { status: 404 });
  return id;
};

const requireConfirm = (body: Record<string, unknown>) => {
  // Generation only ever starts from an explicit admin click in the console, never implicitly.
  if (body.confirm !== true) throw new StudioError('BAD_REQUEST', 'Confirm the build (confirm: true) after reviewing the quote.', { status: 400 });
};

// ── Routers ──────────────────────────────────────────────────────────────────

/** GET / — the published library index (mounted at /api/comic/public/library; ETag, 5-minute cache). */
export function createLibraryPublicRouter(source?: DepsSource): Router {
  const router = Router();
  const deps = lazyDeps(source);
  let cached: { at: number; body: LibraryIndex; etag: string } | undefined;
  let inflight: Promise<{ body: LibraryIndex; etag: string }> | undefined;
  let generation = 0;
  const invalidate = () => {
    cached = undefined;
    generation += 1;
  };
  if (!source) indexCacheInvalidator = invalidate;

  const load = async (): Promise<{ body: LibraryIndex; etag: string; ok: boolean }> => {
    const now = Date.now();
    if (cached && now - cached.at < LIBRARY_INDEX_TTL_MS) return { ...cached, ok: true };
    if (!inflight) {
      const gen = generation;
      inflight = (async () => {
        try {
          const { index, etag } = await publicIndex(deps());
          if (gen === generation) cached = { at: Date.now(), body: index, etag };
          return { body: index, etag };
        } finally {
          inflight = undefined;
        }
      })();
    }
    try {
      return { ...(await inflight), ok: true };
    } catch (err) {
      logger.warn('comic_library_index_unavailable', { message: (err as Error)?.message });
      // Never fail the UI: an empty index makes every consumer use its procedural art.
      const body: LibraryIndex = { manifestVersion: LIBRARY_MANIFEST_VERSION, generatedAt: 0, assets: [] };
      return { body, etag: 'empty', ok: false };
    }
  };

  router.get('/', (req, res) => {
    load()
      .then(({ body, etag, ok }) => {
        res.set('Cache-Control', ok ? 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400' : 'public, max-age=60');
        res.set('ETag', `"${etag}"`);
        res.set('X-Content-Type-Options', 'nosniff');
        const inm = String(req.headers['if-none-match'] || '');
        if (inm && inm.split(',').map((s) => s.trim().replace(/^W\//, '')).includes(`"${etag}"`)) return res.status(304).end();
        return res.json(body);
      })
      .catch((err) => sendError(res, err, "The library couldn't be loaded."));
  });
  router.all('/', (_req, res) => res.status(405).json({ error: { code: 'BAD_REQUEST', message: 'Only GET is supported here.' } }));
  router.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }));
  return router;
}

/** Admin console: manifest, quote, runs, runs/:id/step {n ≤ 3}, cancel, assets/:id/{publish,reject,regenerate}, purge-candidates. */
export function createLibraryAdminRouter(source?: DepsSource): Router {
  const router = Router();
  const deps = lazyDeps(source);

  router.get('/manifest', handle("The library manifest couldn't be loaded.", async (_req, res) => res.json(await manifestView(deps()))));

  router.post(
    '/quote',
    handle("The quote couldn't be made.", async (req, res) => {
      const plan = await planQuote(deps(), parseBuildRequest(bodyOf(req)), { tolerateMissing: true });
      res.json({ quote: plan.quote, tableReady: plan.tableReady });
    })
  );

  router.get(
    '/runs',
    handle("The builds couldn't be listed.", async (req, res) => {
      const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
      const d = deps();
      const runs = await d.repo.listRuns(d.version ?? LIBRARY_MANIFEST_VERSION, limit);
      res.json({ runs: runs.map(runSummary) });
    })
  );

  router.post(
    '/runs',
    handle("The build couldn't be started.", async (req, res) => {
      const body = bodyOf(req);
      requireConfirm(body);
      const out = await startRun(deps(), parseBuildRequest(body), adminIdOf(req));
      res.status(out.run ? 201 : 200).json(out);
    })
  );

  router.get('/runs/:runId', handle("The build couldn't be loaded.", async (req, res) => res.json(await getRunView(deps(), runIdOf(req)))));

  router.post(
    '/runs/:runId/step',
    handle("The build step didn't finish. Step again to resume; nothing is drawn twice.", async (req, res) => {
      const n = bodyOf(req).n;
      if (n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 3)) {
        throw new StudioError('BAD_REQUEST', 'n must be 1, 2 or 3.', { status: 400 });
      }
      res.json(await stepRun(deps(), runIdOf(req), n, adminIdOf(req)));
    })
  );

  router.post('/runs/:runId/cancel', handle("The build couldn't be cancelled.", async (req, res) => res.json(await cancelRun(deps(), runIdOf(req), adminIdOf(req)))));

  router.post(
    '/assets/purge-candidates',
    handle("Candidates couldn't be purged.", async (req, res) => {
      const dryRun = bodyOf(req).dryRun !== false;
      res.json(await purgeCandidates(deps(), dryRun, adminIdOf(req)));
    })
  );

  router.post('/assets/:id/publish', handle("That asset couldn't be published.", async (req, res) => res.json(await publishAsset(deps(), String(req.params.id), bodyOf(req).rev, adminIdOf(req)))));

  router.post(
    '/assets/:id/reject',
    handle("That asset couldn't be rejected.", async (req, res) => {
      const body = bodyOf(req);
      // unpublish: true also takes down the live image (a takedown), not just the candidate in review.
      res.json(await rejectAsset(deps(), String(req.params.id), body.note, adminIdOf(req), { unpublish: body.unpublish === true }));
    })
  );

  router.post(
    '/assets/:id/regenerate',
    handle("The regenerate build couldn't be started.", async (req, res) => {
      const body = bodyOf(req);
      requireConfirm(body);
      const out = await regenerateAsset(deps(), String(req.params.id), body, adminIdOf(req));
      res.status(out.run ? 201 : 200).json(out);
    })
  );

  router.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }));
  return router;
}
