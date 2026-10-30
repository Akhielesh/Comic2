// Safety HTTP surface (contract §14.1; safety.md §5.3). Owner: P1-SAFETY. Three routers:
//
//   owner      POST /api/comic/projects/:id/safety-review   {target, note?} — appeal (= safety_recheck);
//                                                           5/day (inside the safety module)
//   report     POST /api/comic/public/s/:slug/report        optional auth + Turnstile; ALWAYS 202 (even
//                                                           for an unknown slug — the work runs after the
//                                                           answer, so timing says nothing); 5/h per IP or user
//   moderation GET  /api/moderation/comic-cases             ?status=open|resolved&kind=report|appeal|auto
//              GET  /api/moderation/comic-cases/:id/asset   5-minute signed URL (quarantine first), audited
//              POST /api/moderation/comic-cases/:id/resolve {action, assessed?, reason}, audited
//
// Mounts (routes/comicMounts.ts): owner on /api/comic after requireAuth; report on
// /api/comic/public/s BEFORE /api/comic/public; moderation on /api/moderation/comic-cases
// behind requireModerator. Errors use the studio shape {error: {message, code}}.

import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { RenderTarget } from '../../../shared/comic/doc.js';
import { effectiveRating, isContentRating, type AssessedRating } from '../../../shared/comic/safety.js';
import { clientIpFromReq } from '../ai/clientGeo.js';
import { studioCapsFor } from '../comic/access.js';
import { createStudioContext } from '../comic/context.js';
import { spendIsByok } from '../comic/jobs.js';
import { studioKeysFromRequest } from '../comic/keys.js';
import { appealAndTell, recordReport, requireActiveUser } from '../comic/safety/index.js';
import { RESOLVE_ACTIONS, caseAssetUrl, caseView, normalizeReportReason, resolveCase, type ResolveAction } from '../comic/safety/cases.js';
import { errorFacts, safetyDeps } from '../comic/safety/deps.js';
import { getStudioSession } from '../comic/session.js';
import { createSupabaseDocStore } from '../comic/store.js';
import { StudioError, type StudioContext } from '../comic/types.js';
import { logger } from '../lib/logger.js';
import { verifyTurnstile } from '../services/turnstile.js';

export const SAFETY_OWNER_PATHS = ['/projects/:id/safety-review'];

const PROJECT_ID = /^[A-Za-z0-9-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const httpError = (res: Response, err: unknown, next: NextFunction) => {
  if (err instanceof StudioError) {
    res.status(err.status || 500).json({ error: { message: err.userMessage, code: err.code } });
    return;
  }
  next(err);
};
const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((err) => httpError(res, err, next));
  };
const userOf = (req: Request): string => {
  const id = (req as { user?: { id?: string } }).user?.id;
  if (!id) throw new StudioError('FORBIDDEN', 'Sign in first.', { status: 401 });
  return id;
};

/** A RenderTarget from a request body (strict shape; ids are bounded). */
export const parseTarget = (raw: unknown): RenderTarget | null => {
  if (!isObject(raw)) return null;
  if (raw.kind === 'cover') return { kind: 'cover' };
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  if (raw.kind === 'page' || raw.kind === 'sheet' || raw.kind === 'place' || raw.kind === 'style_option') return { kind: raw.kind, id };
  return null;
};

// ── Owner: appeals ───────────────────────────────────────────────────────────

export interface ComicSafetyRouterDeps {
  /** Owner-scoped context for a project (throws NOT_FOUND for anyone else). */
  contextFor?(req: Request, projectId: string): Promise<StudioContext>;
  /** Moderation-status gate (suspended accounts get 403); defaults to requireActiveUser(). */
  requireActive?: (req: Request, res: Response, next: NextFunction) => void;
}

const defaultContextFor = async (req: Request, projectId: string): Promise<StudioContext> => {
  const userId = userOf(req);
  const session = await getStudioSession(projectId, userId, createSupabaseDocStore());
  const keys = studioKeysFromRequest(req);
  const caps = await studioCapsFor(req, { byok: spendIsByok(keys) });
  const rating = effectiveRating(session.doc, caps.ratingCeiling).rating;
  return createStudioContext({ req, session, caps, rating });
};

/** Owner appeal route (mounted on /api/comic). */
export function createComicSafetyRouter(deps: ComicSafetyRouterDeps = {}): Router {
  const router = Router();
  // A suspended account cannot spend platform checks (the mount adds no requireActive here).
  router.post(SAFETY_OWNER_PATHS, deps.requireActive ?? requireActiveUser());
  router.post(
    SAFETY_OWNER_PATHS,
    handle(async (req, res) => {
      userOf(req);
      const projectId = String(req.params.id || '');
      if (!PROJECT_ID.test(projectId)) throw new StudioError('NOT_FOUND', "This comic doesn't exist or you don't have access to it.", { status: 404 });
      const body = isObject(req.body) ? req.body : {};
      const target = parseTarget(body.target);
      if (!target) throw new StudioError('BAD_REQUEST', 'Pick the page, cover or sheet to check again.', { status: 400 });
      const note = typeof body.note === 'string' ? body.note.slice(0, 300) : undefined;
      const ctx = await (deps.contextFor || defaultContextFor)(req, projectId);
      const result = await appealAndTell(ctx, target, note);
      res.json({ status: result.status, message: result.message, ...(result.rating ? { rating: result.rating } : {}), rev: ctx.session.doc.rev });
    })
  );
  return router;
}

// ── Public: reader reports ───────────────────────────────────────────────────

export interface ComicReportRouterDeps {
  verifyTurnstile?(token: string | undefined, ip?: string): Promise<boolean>;
  recordReport?: typeof recordReport;
  /** Salt for the anonymous reporter fingerprint (rotated daily by mixing in the date). */
  salt?: string;
}

const processSalt = crypto.randomBytes(16).toString('hex');
const reportSalt = (): string => (process.env.COMIC_REPORT_SALT || process.env.SHARE_VIEW_SALT || '').trim() || processSalt;

/** Salted, daily-rotating hash of the reporter's IP (dedupe only; never the IP). */
export const reporterFingerprint = (ip: string | undefined, salt: string, now = Date.now()): string =>
  crypto.createHash('sha256').update(`${salt}|${new Date(now).toISOString().slice(0, 10)}|${ip || 'unknown'}`).digest('hex').slice(0, 32);

/** Reader reports (mounted on /api/comic/public/s, before the public reader router). */
export function createComicReportRouter(deps: ComicReportRouterDeps = {}): Router {
  const router = Router();
  router.post('/:slug/report', (req: Request, res: Response) => {
    void (async () => {
      const body = isObject(req.body) ? req.body : {};
      const reason = normalizeReportReason(body.reason);
      if (!reason) {
        res.status(400).json({ error: { message: 'Pick a reason for the report.', code: 'BAD_REQUEST' } });
        return;
      }
      const ip = clientIpFromReq(req as unknown as { headers: Record<string, unknown>; ip?: string });
      const token = typeof body.turnstileToken === 'string' ? body.turnstileToken.slice(0, 4096) : undefined;
      const human = await (deps.verifyTurnstile || verifyTurnstile)(token, ip).catch(() => false);
      if (!human) {
        res.status(400).json({ error: { message: 'Please complete the quick check and send the report again.', code: 'CAPTCHA' } });
        return;
      }
      const rawPage = body.pageN ?? body.page;
      const page = typeof rawPage === 'number' && Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 500 ? rawPage : undefined;
      const note = typeof body.note === 'string' ? body.note.slice(0, 300) : undefined;
      const reporterUserId = (req as { user?: { id?: string } }).user?.id;
      const slug = String(req.params.slug || '').slice(0, 64);
      // Answer first: the same 202 for every slug, before any lookup runs.
      res.status(202).json({ ok: true });
      const record = deps.recordReport || recordReport;
      setImmediate(() => {
        record({ slug, reason, ...(note ? { note } : {}), ...(page ? { page } : {}), ...(reporterUserId ? { reporterUserId } : {}), ipHash: reporterFingerprint(ip, deps.salt || reportSalt()) }).catch((err) =>
          logger.warn('comic_report_record_failed', { ...errorFacts(err) })
        );
      });
    })().catch((err) => {
      logger.warn('comic_report_route_failed', { ...errorFacts(err) });
      if (!res.headersSent) res.status(202).json({ ok: true });
    });
  });
  return router;
}

// ── Moderators: cases ────────────────────────────────────────────────────────

/** Moderator case queue (mounted on /api/moderation/comic-cases behind requireModerator). */
export function createComicModerationRouter(): Router {
  const router = Router();

  router.get(
    '/',
    handle(async (req, res) => {
      userOf(req);
      const status = req.query.status === 'resolved' ? 'resolved' : req.query.status === 'all' ? undefined : 'open';
      const kind = req.query.kind === 'report' || req.query.kind === 'appeal' || req.query.kind === 'auto' ? req.query.kind : undefined;
      const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
      const offset = Math.max(0, Math.floor(Number(req.query.cursor) || 0));
      const store = safetyDeps().store;
      const cases = await store.listCases({ ...(status ? { status } : {}), ...(kind ? { kind } : {}), limit, offset });
      const names: Record<string, string> = {};
      await Promise.all(
        [...new Set(cases.map((c) => c.projectId))].slice(0, 100).map(async (id) => {
          const info = await store.projectInfo(id).catch(() => null);
          if (info?.name) names[id] = info.name;
        })
      );
      res.set('Cache-Control', 'private, no-store');
      res.json({ cases: cases.map((c) => caseView(c, names)), ...(cases.length === limit ? { nextCursor: String(offset + limit) } : {}) });
    })
  );

  router.get(
    '/:id/asset',
    handle(async (req, res) => {
      const actorId = userOf(req);
      const id = String(req.params.id || '');
      if (!UUID.test(id)) throw new StudioError('NOT_FOUND', 'That case no longer exists.', { status: 404 });
      const out = await caseAssetUrl(actorId, id);
      if (!out) throw new StudioError('NOT_FOUND', 'There is no image for this case (it may have been removed).', { status: 404 });
      res.set('Cache-Control', 'private, no-store');
      res.set('Referrer-Policy', 'no-referrer');
      res.json(out);
    })
  );

  router.post(
    '/:id/resolve',
    handle(async (req, res) => {
      const actorId = userOf(req);
      const id = String(req.params.id || '');
      if (!UUID.test(id)) throw new StudioError('NOT_FOUND', 'That case no longer exists.', { status: 404 });
      const body = isObject(req.body) ? req.body : {};
      const action = body.action as ResolveAction;
      if (!RESOLVE_ACTIONS.includes(action)) throw new StudioError('BAD_REQUEST', 'action must be dismiss, withhold, restore or force_private.', { status: 400 });
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : '';
      if (action !== 'dismiss' && !reason.trim()) throw new StudioError('BAD_REQUEST', 'Add a short reason (the owner sees a neutral summary).', { status: 400 });
      const assessed = body.assessed === 'X' || isContentRating(body.assessed) ? (body.assessed as AssessedRating) : undefined;
      const out = await resolveCase(actorId, id, { action, reason, ...(assessed ? { assessed } : {}) });
      res.json(out);
    })
  );

  return router;
}

export const comicSafetyRouter = createComicSafetyRouter();
export const comicReportRouter = createComicReportRouter();
export const comicModerationRouter = createComicModerationRouter();
