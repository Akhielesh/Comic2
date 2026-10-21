// Comic Studio (v4) API — the conversational studio.
//
// Mounted at /api/comic (after requireAuth/attachAccountKeys) and /api/comic/public
// (before requireAuth, optionalAuth). Every :id route is owner-scoped through the doc
// store. One POST /projects/:id/stream request carries a user message (→ Comic Director
// turn) or a direct action (→ job runner) and streams StudioEvents as SSE until the turn
// and every render it started have settled. See docs/features/comic-studio-v4.md §4.

import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  collectAssetPaths,
  createEmptyDoc,
  newId,
  type AssetRef,
  type CastTier,
  type ComicDoc,
  type Msg
} from '../../../shared/comic/doc.js';
import { applyOps, isSpendAction, SPEND_ACTION_TYPES, type DocOp, type StudioAction } from '../../../shared/comic/ops.js';
import { encodeStudioEvent, type StreamRequest, type StudioEvent } from '../../../shared/comic/events.js';
import { IMAGE_MODELS, TIER_PRESETS, resolveImageJob } from '../../../shared/comic/models.js';
import { STYLE_PRESETS } from '../../../shared/comic/stylePresets.js';
import { logger } from '../lib/logger.js';
import { consumeAllowanceNotices } from '../services/usageEnforcer.js';
import { checkQualityAccess } from '../comic/access.js';
import { createSupabaseAssetStore, isOwnedAssetPath } from '../comic/assets.js';
import { createStudioContext, type StudioContextDeps } from '../comic/context.js';
import { runDirectorTurn } from '../comic/director.js';
import { ASPECT_RATIOS, noticeCard, runAction, spendIsByok, suggestNextSteps } from '../comic/jobs.js';
import { studioKeysFromRequest } from '../comic/keys.js';
import { getStudioSession, peekStudioSession, type StudioSession } from '../comic/session.js';
import { createSupabaseDocStore } from '../comic/store.js';
import { ANALYZE_SOURCE_MIN_CHARS } from '../comic/tools.js';
import { StudioError, type AssetStore, type DocStore } from '../comic/types.js';

// ── Limits ───────────────────────────────────────────────────────────────────

export const MAX_MESSAGE_CHARS = 60_000;
export const MAX_ATTACHMENTS = 6;
/** A 10 MB file is ~13.4M base64 characters plus its data: header. */
export const MAX_ATTACHMENT_DATA_URL_CHARS = Math.ceil((10 * 1024 * 1024 * 4) / 3) + 256;
const MAX_TEXT_FILE_CHARS = 200_000;
const MAX_URL_PATHS = 500;
const HEARTBEAT_MS = 15_000;
const PROJECT_ID = /^[A-Za-z0-9-]{1,64}$/;
const NON_SPEND_ACTIONS = new Set(['approve_gate', 'decline_gate', 'pick_style', 'plan_pages', 'approve_plan', 'patch', 'restore_render', 'relayout_balloons', 'cancel']);
const TEXT_MIME = /^(text\/|application\/(json|x-fountain|rtf))/i;
const TEXT_EXT = /\.(txt|md|markdown|fountain|fdx|json|csv|rtf)$/i;

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface ComicRouterDeps {
  store?: DocStore;
  assets?: AssetStore;
  /** Per-request overrides for the context (keys, llm, images, billing). */
  contextDeps?: (req: Request) => StudioContextDeps;
  qualityAccess?: typeof checkQualityAccess;
  heartbeatMs?: number;
}

const lazy = <T>(make: () => T) => {
  let value: T | undefined;
  return () => (value ??= make());
};

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

const requireUser = (req: Request): string => {
  const id = req.user?.id;
  if (!id) throw new StudioError('FORBIDDEN', 'Sign in to use the comic studio.', { status: 401 });
  return id;
};

const projectIdParam = (req: Request): string => {
  const id = String(req.params.id || '');
  if (!PROJECT_ID.test(id)) throw new StudioError('NOT_FOUND', "This comic doesn't exist or you don't have access to it.", { status: 404 });
  return id;
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const round4 = (n: number) => Math.round(n * 10000) / 10000;

// ── Stream request validation ────────────────────────────────────────────────

interface InboundAttachment {
  name: string;
  mimeType: string;
  dataUrl: string;
}

/** Validate the body of POST /stream. Throws BAD_REQUEST with a user-safe message. */
export function parseStreamRequest(body: unknown): StreamRequest {
  const bad = (message: string) => new StudioError('BAD_REQUEST', message, { status: 400 });
  if (!isObject(body)) throw bad('Send a message or an action.');
  if (body.kind === 'message') {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length > MAX_MESSAGE_CHARS) throw bad(`That message is too long (max ${MAX_MESSAGE_CHARS.toLocaleString('en-US')} characters). Attach long scripts as a .txt file.`);
    const raw = body.attachments === undefined ? [] : body.attachments;
    if (!Array.isArray(raw)) throw bad('Attachments must be a list.');
    if (raw.length > MAX_ATTACHMENTS) throw bad(`Attach at most ${MAX_ATTACHMENTS} files per message.`);
    const attachments: InboundAttachment[] = raw.map((a) => {
      if (!isObject(a) || typeof a.dataUrl !== 'string' || !a.dataUrl.startsWith('data:')) throw bad('An attachment could not be read.');
      if (a.dataUrl.length > MAX_ATTACHMENT_DATA_URL_CHARS) throw bad('Each attachment must be 10 MB or smaller.');
      return {
        name: (typeof a.name === 'string' ? a.name : 'attachment').slice(0, 200),
        mimeType: (typeof a.mimeType === 'string' ? a.mimeType : '').slice(0, 120).toLowerCase(),
        dataUrl: a.dataUrl
      };
    });
    if (!text && !attachments.length) throw bad('Type a message or attach something.');
    return { kind: 'message', text, ...(attachments.length ? { attachments } : {}) };
  }
  if (body.kind === 'action') {
    const action = body.action;
    if (!isObject(action) || typeof action.type !== 'string') throw bad('Unknown action.');
    if (!SPEND_ACTION_TYPES.has(action.type) && !NON_SPEND_ACTIONS.has(action.type)) throw bad(`Unknown action "${action.type.slice(0, 40)}".`);
    return { kind: 'action', action: action as unknown as StudioAction };
  }
  throw bad('Send a message or an action.');
}

const mimeOfDataUrl = (dataUrl: string) => (/^data:([^;,]+)/i.exec(dataUrl)?.[1] || '').toLowerCase();

const decodeTextDataUrl = (dataUrl: string): string => {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new StudioError('BAD_REQUEST', 'A text attachment could not be read.', { status: 400 });
  const header = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  const text = /;base64$/i.test(header) ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload);
  return text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').slice(0, MAX_TEXT_FILE_CHARS);
};

interface PreparedMessage {
  text: string;
  attachments: AssetRef[];
  /** Ops to commit before the turn (a long text file becomes the source script). */
  ops: DocOp[];
}

/**
 * Images are stored as uploads; plain-text files are inlined into the message when short
 * or saved as the source script when long (the director then reads it with save_source).
 */
async function prepareMessage(
  req: Extract<StreamRequest, { kind: 'message' }>,
  ctx: { userId: string; projectId: string; assets: AssetStore }
): Promise<PreparedMessage> {
  let text = req.text;
  const attachments: AssetRef[] = [];
  const ops: DocOp[] = [];
  const notes: string[] = [];
  for (const a of req.attachments || []) {
    const mime = a.mimeType || mimeOfDataUrl(a.dataUrl);
    if (mime.startsWith('image/')) {
      attachments.push(await ctx.assets.saveUpload({ userId: ctx.userId, projectId: ctx.projectId, dataUrl: a.dataUrl }));
      continue;
    }
    if (TEXT_MIME.test(mime) || TEXT_EXT.test(a.name)) {
      const content = decodeTextDataUrl(a.dataUrl).trim();
      if (!content) continue;
      if (content.length >= ANALYZE_SOURCE_MIN_CHARS) {
        const words = (content.match(/\S+/g) || []).length;
        ops.push({ op: 'source', patch: { script: content, updatedAt: Date.now() } });
        notes.push(`[Attached “${a.name}” — ${words.toLocaleString('en-US')} words, saved as the source script. Call save_source (no text) to read it.]`);
      } else {
        notes.push(`[Attached “${a.name}”]\n${content}`);
      }
      continue;
    }
    throw new StudioError('BAD_REQUEST', `“${a.name}” isn't supported — attach images or plain-text files (.txt, .md).`, { status: 400 });
  }
  if (notes.length) text = [text, ...notes].filter(Boolean).join('\n\n');
  return { text, attachments, ops };
}

// ── Legacy import ────────────────────────────────────────────────────────────

const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Owned storage paths from a legacy entity (its main image + references). */
const legacyRefs = (entity: Record<string, unknown>, userId: string, max = 3): AssetRef[] => {
  const paths = [entity.imageId, ...(Array.isArray(entity.referenceImageIds) ? entity.referenceImageIds : [])]
    .filter((p): p is string => typeof p === 'string' && !!p && isOwnedAssetPath(p, userId));
  return [...new Set(paths)].slice(0, max).map((path) => ({ path, source: 'upload' as const, at: Date.now() }));
};

/**
 * Map a classic (pre-v4) project's state onto doc ops: script, title, characters (look
 * from the structured details), locations, style prompt and aspect. Pure.
 */
export function legacyImportOps(
  legacy: { name: string; state: Record<string, unknown> },
  userId: string
): { ops: DocOp[]; summary: { title: string; words: number; cast: string[]; places: number; style: boolean } } {
  const state = legacy.state || {};
  const ops: DocOp[] = [];
  const title = str(legacy.name, 200) || str(state.title, 200) || 'Untitled comic';
  const brief: Record<string, unknown> = { title };
  const overview = str(state.overview, 4000);
  if (overview) brief[overview.length <= 300 ? 'logline' : 'premise'] = overview;
  ops.push({ op: 'brief', patch: brief });

  const script = typeof state.script === 'string' ? state.script.trim().slice(0, 200_000) : '';
  if (script) ops.push({ op: 'source', patch: { script, updatedAt: Date.now() } });

  const cast: string[] = [];
  const characters = Array.isArray(state.characters) ? state.characters.filter(isObject) : [];
  characters.slice(0, 24).forEach((c, i) => {
    const name = str(c.name, 80);
    if (!name) return;
    const s = isObject(c.structured) ? c.structured : {};
    const description = str(c.description, 600);
    const traits = str(s.physicalTraits, 400);
    const summary = [description, traits && !description.toLowerCase().includes(traits.toLowerCase()) ? traits : ''].filter(Boolean).join('. ').slice(0, 600);
    const marks = [str(s.distinguishingFeatures, 300), str(s.mustKeep, 200)].filter(Boolean).join('; ');
    const tier: CastTier = c.castTier === 'lead' || c.castTier === 'support' || c.castTier === 'extra' ? c.castTier : i === 0 ? 'lead' : 'support';
    const look = {
      summary,
      ...(str(s.ageBand, 80) ? { age: str(s.ageBand, 80) } : {}),
      ...(str(s.genderPresentation, 80) ? { gender: str(s.genderPresentation, 80) } : {}),
      ...(str(s.outfit, 300) ? { outfit: str(s.outfit, 300) } : {}),
      ...(str(s.colorPalette, 200) ? { palette: str(s.colorPalette, 200) } : {}),
      ...(marks ? { marks } : {})
    };
    const personality = str(s.personality, 1000) || str(c.bio, 1000);
    ops.push({
      op: 'character',
      id: newId('c'),
      patch: {
        name,
        tier,
        look,
        refs: legacyRefs(c, userId),
        ...(str(s.role, 200) ? { role: str(s.role, 200) } : {}),
        ...(personality ? { personality } : {})
      }
    });
    cast.push(name.toUpperCase());
  });

  const locations = Array.isArray(state.locations) ? state.locations.filter(isObject) : [];
  let places = 0;
  for (const l of locations.slice(0, 16)) {
    const name = str(l.name, 80);
    if (!name) continue;
    const s = isObject(l.structured) ? l.structured : {};
    const look = [str(l.description, 800), str(s.landmarks, 200), str(s.lighting, 160), str(s.eraMood, 160), str(s.palette, 160)].filter(Boolean).join('. ').slice(0, 1500);
    ops.push({ op: 'place', id: newId('pl'), patch: { name, look, refs: legacyRefs(l, userId, 2) } });
    places += 1;
  }

  const stylePrompt = str(state.stylePrompt, 2000);
  const styleRefs = typeof state.styleImageId === 'string' && isOwnedAssetPath(state.styleImageId, userId)
    ? [{ path: state.styleImageId, source: 'upload' as const, at: Date.now() }]
    : [];
  if (stylePrompt || styleRefs.length) {
    ops.push({
      op: 'style',
      patch: {
        status: stylePrompt ? 'drafted' : 'empty',
        ...(stylePrompt ? { spec: stylePrompt, name: str(state.styleCategory, 80) || 'Imported style' } : {}),
        refs: styleRefs
      }
    });
  }
  const aspect = typeof state.styleAspectRatio === 'string' ? state.styleAspectRatio : '';
  const pageModel = resolveImageJob('page', 'standard').spec;
  if ((ASPECT_RATIOS as string[]).includes(aspect) && pageModel.aspects.includes(aspect as never)) {
    ops.push({ op: 'format', patch: { pageAspect: aspect as never } });
  }
  return { ops, summary: { title, words: (script.match(/\S+/g) || []).length, cast, places, style: !!stylePrompt } };
}

const importWelcome = (summary: ReturnType<typeof legacyImportOps>['summary'], doc: ComicDoc): Msg => {
  const parts: string[] = [];
  if (summary.words) parts.push(`the script (${summary.words.toLocaleString('en-US')} words)`);
  if (summary.cast.length) {
    const names = summary.cast.slice(0, 4).join(', ') + (summary.cast.length > 4 ? ` +${summary.cast.length - 4}` : '');
    parts.push(`${summary.cast.length} character${summary.cast.length === 1 ? '' : 's'} (${names})`);
  }
  if (summary.places) parts.push(`${summary.places} location${summary.places === 1 ? '' : 's'}`);
  if (summary.style) parts.push('your style');
  const what = parts.length ? parts.join(', ').replace(/, ([^,]*)$/, ' and $1') : 'the title';
  return {
    id: newId('msg'),
    role: 'assistant',
    text:
      `I brought “${summary.title}” into the new studio: ${what}. The new studio draws each page as one image with your characters on model. ` +
      (summary.words ? 'Want me to read the script and plan the pages, or change anything first?' : 'Tell me what the comic is about and I’ll plan it with you.'),
    at: Date.now(),
    suggestions: summary.words ? ['Read the script and plan the pages', ...suggestNextSteps(doc).slice(0, 2)] : suggestNextSteps(doc)
  };
};

// ── Public sanitization ──────────────────────────────────────────────────────

/** Strip everything private from a published doc (idempotent). */
export function publicComicDoc(doc: ComicDoc): ComicDoc {
  const settings = { ...doc.settings };
  delete settings.budgetUsd;
  delete settings.imageModelOverride;
  const out: ComicDoc = {
    ...doc,
    conversation: [],
    spend: { totalUsd: 0, byKind: {}, entries: [] },
    gate: null,
    source: {},
    settings,
    style: { ...doc.style, refs: [] },
    cast: doc.cast.map((c) => ({ ...c, refs: [] })),
    places: doc.places.map((p) => ({ ...p, refs: [] }))
  };
  delete out.memory;
  return out;
}

const publicAssetPaths = (doc: ComicDoc): string[] =>
  [...doc.pages.map((p) => p.render.asset?.path), doc.cover.render.asset?.path].filter((p): p is string => !!p);

// ── Routers ──────────────────────────────────────────────────────────────────

export function createComicRouter(deps: ComicRouterDeps = {}): Router {
  const router = Router();
  const store = lazy(() => deps.store || createSupabaseDocStore());
  const assets = lazy(() => deps.assets || createSupabaseAssetStore());
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;

  const sessionFor = async (req: Request): Promise<StudioSession> => getStudioSession(projectIdParam(req), requireUser(req), store());

  const signAll = async (paths: string[]): Promise<Record<string, string>> => {
    if (!paths.length) return {};
    try {
      return await assets().signUrls(paths);
    } catch (err) {
      logger.warn('comic_sign_urls_failed', { count: paths.length, message: (err as Error)?.message });
      return {};
    }
  };

  router.get('/models', (_req, res) => {
    res.json({ models: IMAGE_MODELS, tiers: TIER_PRESETS, presets: STYLE_PRESETS });
  });

  router.post(
    '/projects',
    handle(async (req, res) => {
      const userId = requireUser(req);
      const body = isObject(req.body) ? req.body : {};
      const projectId = randomUUID();
      let doc = createEmptyDoc(projectId, str(body.title, 200) || 'Untitled comic');
      const importFrom = typeof body.importFromProjectId === 'string' ? body.importFromProjectId.trim() : '';
      if (importFrom) {
        if (!PROJECT_ID.test(importFrom)) throw new StudioError('NOT_FOUND', "That project doesn't exist or you don't have access to it.", { status: 404 });
        const legacy = await store().loadLegacyState(importFrom, userId);
        if (!legacy) throw new StudioError('NOT_FOUND', "That project doesn't exist or you don't have access to it.", { status: 404 });
        if (legacy.state?.studioVersion === 4) throw new StudioError('BAD_REQUEST', 'That comic is already in the new studio.', { status: 400 });
        const { ops, summary } = legacyImportOps(legacy, userId);
        if (str(body.title, 200)) ops.push({ op: 'brief', patch: { title: str(body.title, 200) } });
        doc = applyOps(doc, ops);
        doc = applyOps(doc, [{ op: 'message', msg: importWelcome({ ...summary, title: doc.brief.title }, doc) }]);
      }
      await store().create({ projectId, userId, doc });
      logger.info('comic_project_created', { projectId, imported: !!importFrom });
      res.status(201).json({ projectId, doc, urls: await signAll(collectAssetPaths(doc)) });
    })
  );

  router.get(
    '/projects/:id',
    handle(async (req, res) => {
      const session = await sessionFor(req);
      res.json({ doc: session.doc, urls: await signAll(collectAssetPaths(session.doc)) });
    })
  );

  router.post(
    '/projects/:id/cancel',
    handle(async (req, res) => {
      const session = await sessionFor(req);
      session.abort.abort();
      res.json({ ok: true });
    })
  );

  router.post(
    '/projects/:id/urls',
    handle(async (req, res) => {
      const session = await sessionFor(req);
      const raw = isObject(req.body) && Array.isArray(req.body.paths) ? req.body.paths : null;
      if (!raw) throw new StudioError('BAD_REQUEST', 'Send the paths to sign.', { status: 400 });
      const allowed = new Set(collectAssetPaths(session.doc));
      const paths = [...new Set(raw.filter((p): p is string => typeof p === 'string' && allowed.has(p)))].slice(0, MAX_URL_PATHS);
      res.json({ urls: await signAll(paths) });
    })
  );

  router.post('/projects/:id/stream', (req, res, next) => {
    void stream(req, res).catch((err) => {
      if (res.headersSent) {
        logger.error('comic_stream_unhandled', { message: (err as Error)?.message });
        if (!res.writableEnded) res.end();
        return;
      }
      httpError(res, err, next);
    });
  });

  async function stream(req: Request, res: Response) {
    const userId = requireUser(req);
    const request = parseStreamRequest(req.body);
    const session = await sessionFor(req);
    const busy = request.kind === 'message' && session.turnRunning;

    // Uploads are stored before the stream opens so a bad file is a plain 400.
    const prepared =
      request.kind === 'message' && !busy
        ? await prepareMessage(request, { userId, projectId: session.projectId, assets: assets() })
        : null;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const send = (event: StudioEvent) => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(`event: ${event.type}\ndata: ${encodeStudioEvent(event)}\n\n`);
      } catch {
        /* socket already closed */
      }
    };
    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(': keep-alive\n\n');
      } catch {
        /* socket already closed */
      }
    }, heartbeatMs);
    heartbeat.unref?.();

    send({ type: 'hello', rev: session.doc.rev, turnId: newId('turn') });
    const unsubscribe = session.subscribe(send);

    if (session.abort.signal.aborted) session.resetAbort();
    // The director loop stops when the user cancels OR closes the tab; renders only on cancel.
    const turnAbort = new AbortController();
    const sessionSignal = session.abort.signal;
    const onSessionAbort = () => turnAbort.abort();
    sessionSignal.addEventListener('abort', onSessionAbort, { once: true });
    res.on('close', () => {
      if (!res.writableEnded) turnAbort.abort();
    });

    const startSpend = session.doc.spend.totalUsd;
    try {
      if (busy) {
        send({ type: 'error', message: "I'm still working on your last message — wait for it to finish, or press stop.", code: 'BUSY' });
        return;
      }
      const contextDeps = deps.contextDeps?.(req) || {};
      const keys = contextDeps.keys || studioKeysFromRequest(req);
      const access = await (deps.qualityAccess || checkQualityAccess)(req, 'pro', spendIsByok(keys)).catch(() => ({ ok: true as const }));
      const ctx = createStudioContext({
        req,
        session,
        signalFrom: turnAbort.signal,
        deps: { ...contextDeps, keys, assets: contextDeps.assets || assets() },
        ...(access.ok === false ? { qualityDenied: access.message } : {})
      });

      try {
        if (request.kind === 'message') {
          await session.runExclusive(async () => {
            if (prepared!.ops.length) session.commit(prepared!.ops);
            await runDirectorTurn(ctx, { text: prepared!.text, attachments: prepared!.attachments });
          });
        } else {
          const action = request.action;
          // A click on a spend button IS the confirmation; the budget cap still applies.
          const run = () => runAction(ctx, action, { confirmed: isSpendAction(action) || action.type === 'approve_gate' });
          if (action.type === 'plan_pages') await session.runExclusive(run);
          else await run();
        }
      } catch (err) {
        const error = err instanceof StudioError ? err : null;
        if (!error) logger.error('comic_stream_failed', { projectId: session.projectId, message: (err as Error)?.message });
        if (error?.code !== 'CANCELLED') {
          send({ type: 'error', message: error?.userMessage || 'Something went wrong. Please try again.', ...(error ? { code: error.code } : {}) });
        }
      }
      // Keep the stream open until every render this request started has settled.
      await ctx.settled();
      const notices = consumeAllowanceNotices(req);
      if (notices.length) {
        session.commit([
          {
            op: 'message',
            msg: { id: newId('msg'), role: 'assistant', text: '', at: Date.now(), cards: notices.map((n) => noticeCard(n.level === 'error' ? 'error' : n.level === 'warn' ? 'warn' : 'info', n.message)) }
          }
        ]);
      }
    } finally {
      sessionSignal.removeEventListener('abort', onSessionAbort);
      await session.flush();
      send({ type: 'done', rev: session.doc.rev, spentUsd: round4(Math.max(0, session.doc.spend.totalUsd - startSpend)) });
      unsubscribe();
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }

  return router;
}

export function createComicPublicRouter(deps: Pick<ComicRouterDeps, 'store' | 'assets'> = {}): Router {
  const router = Router();
  const store = lazy(() => deps.store || createSupabaseDocStore());
  const assets = lazy(() => deps.assets || createSupabaseAssetStore());

  router.get(
    '/:id',
    handle(async (req, res) => {
      const id = projectIdParam(req);
      let doc = await store().loadPublic(id);
      // Owners can preview their own comic in the reader before publishing (live doc when open).
      if (!doc && req.user?.id) {
        const live = peekStudioSession(id);
        doc = live && live.userId === req.user.id ? live.doc : await store().load(id, req.user.id);
      }
      if (!doc) throw new StudioError('NOT_FOUND', "This comic isn't published.", { status: 404 });
      const clean = publicComicDoc(doc);
      let urls: Record<string, string> = {};
      const paths = publicAssetPaths(clean);
      if (paths.length) {
        try {
          urls = await assets().signUrls(paths);
        } catch (err) {
          logger.warn('comic_public_sign_failed', { projectId: id, message: (err as Error)?.message });
        }
      }
      res.set('Cache-Control', 'private, max-age=60');
      res.json({ doc: clean, urls });
    })
  );

  return router;
}

/** Authenticated studio API (mount at /api/comic after requireAuth). */
export const comicRouter = createComicRouter();
/** Public reader API (mount at /api/comic/public before requireAuth, with optionalAuth). */
export const comicPublicRouter = createComicPublicRouter();
