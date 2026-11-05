// Reference-photo upload API (contract §14.1; refs.md §3–§4). Owner: P1-REFS.
//
//   POST   /api/comic/projects/:id/refs?to=&label=&name=&hash=&index=   raw image body ≤ 10 MB
//          order: owner + capacity → exact dedupe → magic bytes / encode → content screen →
//                 near-dup → store PRIVATE (u/<user>/p/<project>/ref/…) → commit ref_add
//          201 {ref, rev, ops, urls, notice?} · 200 {duplicateOf} · 409 LIMIT · 413 · 415 · 422 CONTENT_POLICY
//   DELETE /api/comic/projects/:id/refs?owner=inbox&path=               commits ref_remove (idempotent)
//
// Mounted on /api/comic after requireAuth (routes/comicMounts.ts), behind requireActiveUser() and
// comicUploadRateLimit (30/min, 300/h). The raw body parser lives here, on this route only.
//
// Security: the owner is the verified JWT user (req.user.id), never a parameter; the session is
// loaded owner-scoped, so anyone else gets 404. Bodies are sniffed by magic bytes (SVG/HTML/HEIC never
// pass, whatever the Content-Type says). A blocked image is NEVER stored — the screen runs on the
// in-memory buffer before saveRef. Photos land in the private bucket and are signed for 5 minutes;
// the image proxy serves /ref/ paths to their owner only. Errors are honest sentences; nothing about
// storage, keys or other users leaks. Uploads never redraw anything: a ready sheet is not marked stale
// (the client shows the "new photos since this sheet" hint itself).

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { RefAsset, RefLabel, RefOwner } from '../../../shared/comic/doc.js';
import type { DocOp } from '../../../shared/comic/ops.js';
import { dhashDistance } from '../../../shared/comic/refRanking.js';
import { REF_LABELS_FOR, REF_LIMITS, isRefLabel, parseRefOwnerKey, refOwnerKey, refsOf } from '../../../shared/comic/refs.js';
import { SAFE_ID_RE } from '../../../shared/comic/ops.js';
import { logger } from '../lib/logger.js';
import { createStudioContext, signAssetPaths, type StudioContextDeps } from '../comic/context.js';
import { cleanFileName, inboxRemoveOp, limitMessage, ownerName, pruneInboxOps, roomFor } from '../comic/refs/index.js';
import { screenUploadPreview } from '../comic/safety/index.js';
import { getStudioSession } from '../comic/session.js';
import { createSupabaseDocStore } from '../comic/store.js';
import { StudioError, type DocStore, type StudioContext } from '../comic/types.js';

export const REFS_PATHS = ['/projects/:id/refs'];

const PROJECT_ID = /^[A-Za-z0-9-]{1,64}$/;
const HASH_RE = /^[0-9a-f]{16}$/;
/** dHash bits within which a new photo "looks the same as" one already on the owner. */
export const NEAR_DUP_BITS = 4;
/** What the vision piggyback may say a photo shows (anything else is dropped). */
const REF_SUBJECTS = new Set<string>(['person', 'animal', 'creature', 'robot', 'toy', 'vehicle', 'object', 'place', 'artwork', 'other']);
/** The content screen may not hold an upload longer than this (then the photo is stored unchecked). */
export const SCREEN_TIMEOUT_MS = 15_000;

const NOT_FOUND = "This comic doesn't exist or you don't have access to it.";
const BLOCKED = "This image doesn't fit DreamStream's content rules, so it wasn't added.";
const RESTRICTED = 'Your account is limited right now, so adding photos is paused. You can still read and edit your comic.';
const TOO_BIG = 'That image is larger than 10 MB even after shrinking. Please choose a smaller photo.';

type ScreenFn = typeof screenUploadPreview;

export interface ComicRefsRouterDeps {
  store?: DocStore;
  contextDeps?: (req: Request) => StudioContextDeps;
  /** The upload content screen (tests inject a fake). */
  screen?: ScreenFn;
  now?: () => number;
}

const lazy = <T>(make: () => T) => {
  let v: T | undefined;
  return () => (v ??= make());
};

// ── Reservations: parallel uploads (the client sends 3 at a time) can't squeeze past a cap ──

const pending = new Map<string, { count: number; storing: Set<string> }>();
const reserveKey = (projectId: string, owner: RefOwner) => `${projectId}\u0000${refOwnerKey(owner)}`;
const pendingFor = (projectId: string, owner: RefOwner) => pending.get(reserveKey(projectId, owner));
const pendingProject = (projectId: string): number => {
  let n = 0;
  for (const [key, v] of pending) if (key.startsWith(`${projectId}\u0000`)) n += v.count;
  return n;
};
/** Hold one slot on `owner` until the returned release() runs (idempotent). */
const reserve = (projectId: string, owner: RefOwner) => {
  const key = reserveKey(projectId, owner);
  const entry = pending.get(key) || { count: 0, storing: new Set<string>() };
  entry.count += 1;
  pending.set(key, entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.count -= 1;
    if (entry.count <= 0 && !entry.storing.size) pending.delete(key);
  };
};

/** Test hook. */
export const __resetRefUploadsForTests = () => pending.clear();

// ── Helpers ──────────────────────────────────────────────────────────────────

const first = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined);

const ownerFromQuery = (raw: unknown): RefOwner => {
  const owner = parseRefOwnerKey(first(raw) || '');
  if (!owner || ((owner.kind === 'character' || owner.kind === 'place') && !SAFE_ID_RE.test(owner.id))) {
    throw new StudioError('BAD_REQUEST', 'Choose where the photo goes (a character, a place, the style or the composer).', { status: 400 });
  }
  return owner;
};

const missingOwner = (owner: RefOwner) =>
  new StudioError(
    'BAD_REQUEST',
    owner.kind === 'character' ? 'That character is no longer in the cast.' : owner.kind === 'place' ? 'That place is no longer in the story.' : 'Invalid photo owner.',
    { status: 400 }
  );

/** 409 LIMIT when the owner or the comic is full, counting other in-flight uploads (`self` = slots this request holds). */
const capacityError = (doc: Parameters<typeof limitMessage>[0], owner: RefOwner, projectId: string, self = 0) => {
  const reserved = Math.max(0, (pendingFor(projectId, owner)?.count || 0) - self);
  const room = roomFor(doc, owner, { owner: reserved, project: Math.max(0, pendingProject(projectId) - self) });
  if (room.owner <= 0) return new StudioError('LIMIT', limitMessage(doc, owner), { status: 409 });
  if (room.project <= 0) return new StudioError('LIMIT', limitMessage(doc, owner, 'project'), { status: 409 });
  return null;
};

/** A label the owner can carry (the vision "view" is only a suggestion and must fit the owner). */
const labelFits = (owner: RefOwner, label: unknown): label is RefLabel =>
  isRefLabel(label) && (owner.kind === 'inbox' || REF_LABELS_FOR[owner.kind].includes(label));

const withTimeout = <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });

const dataUrlBytes = (dataUrl: string): Buffer | null => {
  const m = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(dataUrl || '');
  return m ? Buffer.from(m[1], 'base64') : null;
};

function sendError(res: Response, err: unknown, next: NextFunction): void {
  if (res.headersSent) return next(err);
  res.set('Cache-Control', 'no-store');
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: { message: TOO_BIG, code: 'BAD_REQUEST' } });
    return;
  }
  if (e?.type === 'request.aborted' || e?.type === 'request.size.invalid' || e?.type === 'stream.encoding.set') {
    res.status(400).json({ error: { message: 'The upload was interrupted — please try again.', code: 'BAD_REQUEST' } });
    return;
  }
  if (err instanceof StudioError) {
    if (err.status >= 500) logger.warn('comic_refs_route_error', { code: err.code, status: err.status });
    res.status(err.status).json({ error: { message: err.userMessage, code: err.code } });
    return;
  }
  logger.error('comic_refs_route_failed', { message: (err as Error)?.message });
  res.status(500).json({ error: { message: "Couldn't add that photo — nothing was changed. Please try again.", code: 'INTERNAL' } });
}

// ── Router ───────────────────────────────────────────────────────────────────

export function createComicRefsRouter(deps: ComicRefsRouterDeps = {}): Router {
  const router = Router();
  const store = lazy(() => deps.store || createSupabaseDocStore());
  const screen: ScreenFn = deps.screen || screenUploadPreview;
  const now = deps.now || (() => Date.now());

  const sessionFor = async (req: Request) => {
    const userId = req.user?.id;
    if (!userId) throw new StudioError('FORBIDDEN', 'Sign in to add photos.', { status: 401 });
    const projectId = String(req.params.id || '');
    if (!PROJECT_ID.test(projectId)) throw new StudioError('NOT_FOUND', NOT_FOUND, { status: 404 });
    return getStudioSession(projectId, userId, store());
  };

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction): void => {
      res.vary('Authorization');
      fn(req, res).catch((err) => sendError(res, err, next));
    };

  // Any Content-Type is read as bytes: the magic-byte sniff (not the header) decides what it is,
  // so a mislabelled SVG/HTML/HEIC gets an honest 415 instead of an empty body.
  const rawBody = express.raw({ type: () => true, limit: REF_LIMITS.maxUploadBytes });

  router.post(
    REFS_PATHS[0],
    (req, res, next) => rawBody(req, res, (err?: unknown) => (err ? sendError(res, err, next) : next())),
    handle(async (req, res) => {
      if ((res.locals as Record<string, unknown>)?.moderationStatus === 'restricted') {
        throw new StudioError('FORBIDDEN', RESTRICTED, { status: 403 });
      }
      const session = await sessionFor(req);
      const owner = ownerFromQuery(req.query.to);
      const labelArg = first(req.query.label);
      if (labelArg && !labelFits(owner, labelArg)) throw new StudioError('BAD_REQUEST', 'Unknown photo label.', { status: 400 });
      const name = cleanFileName(first(req.query.name));
      const hashArg = first(req.query.hash);
      const hash = hashArg && HASH_RE.test(hashArg) ? hashArg : undefined;
      const indexArg = first(req.query.index);
      const index = indexArg !== undefined && /^\d{1,3}$/.test(indexArg) ? Number(indexArg) : undefined;

      // Expired composer drafts never count against the inbox.
      if (owner.kind === 'inbox') {
        const pruned = pruneInboxOps(session.doc, now());
        if (pruned.length) session.commit(pruned, { origin: 'job', label: 'Clear old uploads' });
      }
      const list = refsOf(session.doc, owner);
      if (!list) throw missingOwner(owner);

      // 1. Exact duplicate of a photo already on this owner (same original file): nothing stored.
      if (hash) {
        const dup = list.find((r) => r.hash === hash);
        if (dup) {
          res.set('Cache-Control', 'private, no-store');
          res.status(200).json({ duplicateOf: dup.path, rev: session.doc.rev, ops: [], urls: {} });
          return;
        }
      }
      // 2. Capacity (never silent): checked before any work, and again before the commit.
      const full = capacityError(session.doc, owner, session.projectId);
      if (full) throw full;
      const body = req.body;
      if (!Buffer.isBuffer(body) || !body.byteLength) {
        throw new StudioError('BAD_REQUEST', "That file isn't a readable image.", { status: 400 });
      }

      const release = reserve(session.projectId, owner);
      const abort = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) abort.abort();
      };
      res.on('close', onClose);
      try {
        const contextDeps = deps.contextDeps?.(req) || {};
        const ctx: StudioContext = createStudioContext({ req, session, signalFrom: abort.signal, deps: contextDeps });
        const contentType = String(req.headers['content-type'] || '');

        // 3. Magic bytes, pixel limits, min edge, EXIF-upright WebP ≤ 2048 (415 / 413 / 422 / 400).
        const encoded = await ctx.assets.encodeUploadBuffer(body, contentType);

        // 4. Content screen on the in-memory preview, BEFORE anything is stored.
        let preview: Buffer = encoded.buffer;
        try {
          const url = await ctx.assets.previewDataUrl(encoded.buffer, 768);
          preview = dataUrlBytes(url) || encoded.buffer;
        } catch {
          preview = encoded.buffer;
        }
        const screened = await withTimeout(
          screen(ctx, preview, 'upload').catch(() => ({ decision: 'unavailable' as const })),
          SCREEN_TIMEOUT_MS,
          { decision: 'unavailable' as const }
        );
        if (screened.decision === 'block') {
          logger.info('comic_ref_upload_blocked', { projectId: session.projectId, owner: owner.kind });
          throw new StudioError('CONTENT_POLICY', BLOCKED, { status: 422 });
        }
        if (abort.signal.aborted) return;

        // 5. Free measurements: dHash (near-duplicates) and quality flags (blurry / dark / low-res).
        let measured: { dhash?: string; quality?: RefAsset['quality'] } = {};
        try {
          measured = await ctx.assets.measureRef(encoded.buffer);
        } catch (err) {
          logger.warn('comic_ref_measure_failed', { projectId: session.projectId, message: (err as Error)?.message });
        }

        // The doc may have moved on while we worked: the owner must still exist and have room.
        const current = refsOf(session.doc, owner);
        if (!current) throw missingOwner(owner);
        const fullNow = capacityError(session.doc, owner, session.projectId, 1);
        if (fullNow) throw fullNow;
        if (hash && current.some((r) => r.hash === hash)) {
          const dup = current.find((r) => r.hash === hash)!;
          res.set('Cache-Control', 'private, no-store');
          res.status(200).json({ duplicateOf: dup.path, rev: session.doc.rev, ops: [], urls: {} });
          return;
        }
        const slot = pendingFor(session.projectId, owner);
        if (hash && slot?.storing.has(hash)) {
          // The same file is being stored by a parallel request (a retry): ask the client to try again.
          throw new StudioError('CONFLICT', 'That photo is already being added — one moment.', { status: 409, retryable: true });
        }
        const nearOf = measured.dhash ? current.find((r) => r.dhash && dhashDistance(measured.dhash, r.dhash) <= NEAR_DUP_BITS) : undefined;
        if (hash) slot?.storing.add(hash);
        let ref: RefAsset;
        let op: DocOp;
        let savedPath: string | undefined;
        try {
          // 6. Store in the PRIVATE bucket.
          const saved = await ctx.assets.saveRef({ userId: session.userId, projectId: session.projectId, encoded });
          savedPath = saved.path;
          const describe = 'describe' in screened ? screened.describe : undefined;
          const quality = { ...(measured.quality || {}), ...(describe?.multipleSubjects ? { multiSubject: true as const } : {}) };
          ref = {
            ...saved,
            source: 'upload',
            at: saved.at || now(),
            ...(labelArg && labelFits(owner, labelArg) ? { label: labelArg } : describe?.view && labelFits(owner, describe.view) ? { label: describe.view } : {}),
            ...(name ? { name } : {}),
            ...(hash ? { hash } : {}),
            ...(measured.dhash ? { dhash: measured.dhash } : {}),
            ...(Object.keys(quality).length ? { quality } : {}),
            ...(describe?.caption ? { caption: String(describe.caption).replace(/\s+/g, ' ').trim().slice(0, 160) } : {}),
            ...(describe?.subject && REF_SUBJECTS.has(describe.subject) ? { subject: describe.subject } : {}),
            ...('verdict' in screened && screened.verdict ? { safety: screened.verdict } : {}),
            addedBy: 'user'
          };
          op = { op: 'ref_add', owner, ref, ...(index !== undefined ? { index } : {}) };
          // 7. Commit. Never a stale op on the sheet: a redraw is offered, never forced.
          session.commit([op], { origin: 'user', label: owner.kind === 'inbox' ? 'Attach photo' : 'Add photo' });
        } catch (err) {
          // Stored but never committed (e.g. the doc-size guard refused it): nothing points at the file.
          if (savedPath) void ctx.assets.remove([savedPath]).catch(() => undefined);
          throw err;
        } finally {
          if (hash) slot?.storing.delete(hash);
        }
        const landed = refsOf(session.doc, owner)?.some((r) => r.path === ref.path);
        if (!landed) {
          // Lost a race (owner removed / filled meanwhile): nothing points at the file; drop it.
          void ctx.assets.remove([ref.path]).catch(() => undefined);
          const after = refsOf(session.doc, owner);
          throw after ? new StudioError('LIMIT', limitMessage(session.doc, owner), { status: 409 }) : missingOwner(owner);
        }
        await session.flush();
        const urls = await signAssetPaths(ctx.assets, [ref.path, ...(ref.variants || []).map((v) => v.path)], { projectId: session.projectId, via: 'refs' });
        res.set('Cache-Control', 'private, no-store');
        res.status(201).json({
          ref,
          rev: session.doc.rev,
          ops: [op],
          urls,
          ...(nearOf ? { notice: { kind: 'near_duplicate', of: nearOf.path } } : {})
        });
        logger.info('comic_ref_uploaded', {
          projectId: session.projectId,
          owner: owner.kind,
          bytes: encoded.bytes,
          screened: screened.decision,
          near: !!nearOf
        });
      } finally {
        release();
        res.off('close', onClose);
      }
    })
  );

  router.delete(
    REFS_PATHS[0],
    handle(async (req, res) => {
      const session = await sessionFor(req);
      const ownerKey = first(req.query.owner) || 'inbox';
      if (ownerKey !== 'inbox') {
        throw new StudioError('BAD_REQUEST', 'Only photos waiting in the composer can be removed here — use the photo menu for the rest.', { status: 400 });
      }
      const path = first(req.query.path);
      if (!path || path.length > 512) throw new StudioError('BAD_REQUEST', 'Which photo?', { status: 400 });
      const op = inboxRemoveOp(session.doc, path);
      if (op) {
        session.commit([op], { origin: 'user', label: 'Remove photo' });
        await session.flush();
      }
      res.set('Cache-Control', 'private, no-store');
      res.status(200).json({ rev: session.doc.rev, ops: op ? [op] : [] });
    })
  );

  return router;
}

export const comicRefsRouter = createComicRefsRouter();

/** For log lines / tests: the owner's display name. */
export const refsOwnerName = ownerName;
