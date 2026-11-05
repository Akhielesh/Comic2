// Storage admin API (contract §14.1; buildplan P1-STORAGE). Owned by P1-STORAGE.
//
//   POST /api/comic/admin/storage/migrate-refs {dryRun?, projectId?, limit? ≤ 10, cursor?}
//        Moves LEGACY reference photos and chat attachments (stored before v5 in the public
//        `comic-assets` bucket under …/img/) into the private `comic-private` bucket under …/ref/,
//        rewrites the comic's paths with server ops through the live session, and only after
//        the doc is saved deletes the public copies.
//
// Safety properties:
//  - dry-run is the DEFAULT (dryRun must be explicitly false to change anything);
//  - client-driven batches: ≤ 10 objects per request, ≤ 5 comics loaded per request, so a
//    sleeping container (15-min idle) or a gateway timeout can never strand a long job;
//  - idempotent and resumable: destinations are deterministic (same object id), an existing
//    destination counts as copied, paths are rewritten only where they still point at the old
//    object, and an `image_assets` ledger row (source 'ref_migrated') lets a later run finish the
//    public-copy cleanup if an earlier one stopped between "saved" and "deleted";
//  - never destructive before the rewritten doc is persisted; never touches another user's
//    objects, generated art that is also a render, the platform library or publication copies;
//  - a comic with a render or director turn in flight is skipped ("busy") and retried later;
//  - one batch at a time per process (409 CONFLICT otherwise); every real run is audited.
//
// Mounted at /api/comic/admin/storage behind requireAuth + adminRateLimit + requireAdmin
// (routes/comicMounts.ts).

import { Router, type Request, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  collectAssetPaths,
  refInboxOf,
  type ComicDoc,
  type RefAsset,
  type RefOwner,
  type RenderState,
  type RenderTarget
} from '../../../shared/comic/doc.js';
import type { DocOp, RefPatch } from '../../../shared/comic/ops.js';
import { createSupabaseStorage, isOwnedAssetPath, isSafeStoragePath, variantPathFor, type StorageOps } from '../comic/assets.js';
import { buildRefPath, isLibraryPath, isPrivatePath, isPublicationPath, PRIVATE_BUCKET } from '../comic/storagePaths.js';
import { getStudioSession, peekStudioSession } from '../comic/session.js';
import { createSupabaseDocStore } from '../comic/store.js';
import { StudioError, type DocStore } from '../comic/types.js';
import { getSupabaseAdmin } from '../services/supabase.js';
import { recordAudit, type AuditInput } from '../observability/auditLog.js';
import { logger } from '../lib/logger.js';

/** Objects moved per request (client-driven batches). */
export const MIGRATE_MAX_LIMIT = 10;
/** Comics loaded per request while scanning. */
export const MIGRATE_SCAN_PAGE = 5;
/** image_assets.source of a migrated private copy (the cleanup ledger). */
export const MIGRATED_SOURCE = 'ref_migrated';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MigrateSkipReason = 'unsafe_path' | 'not_owner_path' | 'also_a_render' | 'missing_object';

/** Copy attempts per request, counting sources that turn out to be missing (bounded work per batch). */
const MIGRATE_MAX_ATTEMPTS = MIGRATE_MAX_LIMIT * 3;

export interface LegacyRefItem {
  /** Public path the doc points at today. */
  path: string;
  /** Deterministic private destination (…/ref/<same id>.webp). */
  dst: string;
  /** In this comic's own …/img/ lane: the public copy may be deleted once nothing references it. */
  ownLane: boolean;
  /** Where the doc uses it (counts per lane, for the report). */
  lanes: string[];
}

export interface RefMigrationPlan {
  items: LegacyRefItem[];
  skipped: { path: string; reason: MigrateSkipReason }[];
}

// ── Pure planning (exported for tests) ───────────────────────────────────────

type RefList = { owner: RefOwner; lane: string; refs: RefAsset[] };

const refLists = (doc: ComicDoc): RefList[] => [
  { owner: { kind: 'style' }, lane: 'style', refs: doc.style.refs || [] },
  ...doc.cast.map((c) => ({ owner: { kind: 'character', id: c.id } as RefOwner, lane: 'cast', refs: c.refs || [] })),
  ...doc.places.map((p) => ({ owner: { kind: 'place', id: p.id } as RefOwner, lane: 'places', refs: p.refs || [] })),
  { owner: { kind: 'inbox' }, lane: 'inbox', refs: refInboxOf(doc) }
];

/** Every path the doc uses OUTSIDE reference lanes (renders, sheets, options, board, archive, trash). */
const nonRefPaths = (doc: ComicDoc): Set<string> =>
  new Set(
    collectAssetPaths({
      ...doc,
      style: { ...doc.style, refs: [] },
      cast: doc.cast.map((c) => ({ ...c, refs: [] })),
      places: doc.places.map((p) => ({ ...p, refs: [] })),
      refInbox: [],
      conversation: doc.conversation.map((m) => ({ ...m, attachments: undefined }))
    })
  );

const objectId = (path: string): string =>
  (path.split('/').pop() || 'image').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'image';

/** The public counterpart of a migrated private copy (only for this comic's own …/img/ lane). */
export const publicCounterpart = (dst: string): string | null => {
  const m = /^(u\/[^/]+\/p\/[^/]+)\/ref\/([^/]+)$/.exec(dst);
  return m ? `${m[1]}/img/${m[2]}` : null;
};

/**
 * Which reference images of a comic still live in the public bucket. Only the doc owner's own
 * objects are candidates; anything also used as art (a page/cover/sheet render, a version, the
 * archive or trash) stays where it is.
 */
export function planRefMigration(doc: ComicDoc, ownerId: string, projectId: string): RefMigrationPlan {
  const renders = nonRefPaths(doc);
  const lanes = new Map<string, string[]>();
  const note = (path: string | undefined, lane: string) => {
    if (!path) return;
    lanes.set(path, [...(lanes.get(path) || []), lane]);
  };
  for (const list of refLists(doc)) {
    for (const ref of list.refs) {
      note(ref?.path, list.lane);
      note(ref?.original?.path, `${list.lane}.original`);
    }
  }
  for (const m of doc.conversation) for (const a of m.attachments || []) note(a?.path, 'attachments');

  const takenDst = new Set<string>([...lanes.keys()].filter((p) => isPrivatePath(p)));
  const items: LegacyRefItem[] = [];
  const skipped: RefMigrationPlan['skipped'] = [];
  for (const [path, where] of lanes) {
    if (isPrivatePath(path) || isLibraryPath(path) || isPublicationPath(path)) continue; // already private / not personal
    if (!isSafeStoragePath(path)) {
      skipped.push({ path: String(path).slice(0, 200), reason: 'unsafe_path' });
      continue;
    }
    if (!isOwnedAssetPath(path, ownerId)) {
      skipped.push({ path, reason: 'not_owner_path' });
      continue;
    }
    if (renders.has(path)) {
      skipped.push({ path, reason: 'also_a_render' });
      continue;
    }
    let dst = buildRefPath(ownerId, projectId, objectId(path));
    if (takenDst.has(dst)) dst = buildRefPath(ownerId, projectId, `${objectId(path)}-m${items.length + 1}`);
    takenDst.add(dst);
    // Deletable later only when it is this comic's own …/img/<id>.webp (its exact ledger counterpart).
    const ownLane = path.startsWith(`u/${ownerId}/p/${projectId}/img/`) && publicCounterpart(dst) === path;
    items.push({ path, dst, ownLane, lanes: where });
  }
  return { items, skipped };
}

const mapPaths = (paths: string[] | undefined, moved: Map<string, string>): string[] | undefined => {
  if (!paths?.length || !paths.some((p) => moved.has(p))) return undefined;
  return paths.map((p) => moved.get(p) || p);
};

/**
 * Ops that point the doc at the moved objects. Computed from the CURRENT doc right before the
 * commit (a path that changed meanwhile simply isn't patched). Variants of a moved ref are dropped
 * (they were public copies; the backfill remakes them privately).
 */
export function rewriteOpsFor(doc: ComicDoc, moved: Map<string, string>): DocOp[] {
  const ops: DocOp[] = [];
  if (!moved.size) return ops;
  for (const list of refLists(doc)) {
    for (const ref of list.refs) {
      const newPath = moved.get(ref.path);
      const newOriginal = ref.original?.path ? moved.get(ref.original.path) : undefined;
      if (!newPath && !newOriginal) continue;
      const patch: RefPatch = {};
      if (newPath) {
        patch.path = newPath;
        if (ref.variants?.length) (patch as Record<string, unknown>).variants = null;
      }
      if (newOriginal && ref.original) patch.original = { ...ref.original, path: newOriginal };
      ops.push({ op: 'ref_patch', owner: list.owner, path: ref.path, patch });
    }
  }
  for (const m of doc.conversation) {
    if (!m.attachments?.some((a) => moved.has(a.path))) continue;
    const attachments = m.attachments.map((a) => {
      const to = moved.get(a.path);
      if (!to) return a;
      const next: RefAsset = { ...a, path: to };
      delete next.variants;
      return next;
    });
    ops.push({ op: 'message_patch', id: m.id, patch: { attachments } });
  }
  // "Drawn from older photos" compares render refPaths with the current refs: keep them equal.
  const targets: { target: RenderTarget; render: RenderState }[] = [
    ...doc.pages.map((p) => ({ target: { kind: 'page', id: p.id } as RenderTarget, render: p.render })),
    { target: { kind: 'cover' }, render: doc.cover.render },
    ...doc.cast.map((c) => ({ target: { kind: 'sheet', id: c.id } as RenderTarget, render: c.sheet })),
    ...doc.places.map((p) => ({ target: { kind: 'place', id: p.id } as RenderTarget, render: p.sheet })),
    ...doc.style.options.map((o) => ({ target: { kind: 'style_option', id: o.id } as RenderTarget, render: o.render }))
  ];
  for (const { target, render } of targets) {
    if (!render) continue;
    const patch: Partial<RenderState> = {};
    const refPaths = mapPaths(render.refPaths, moved);
    if (refPaths) patch.refPaths = refPaths;
    if (render.history?.some((v) => v.refPaths?.some((p) => moved.has(p)))) {
      patch.history = render.history.map((v) => {
        const mapped = mapPaths(v.refPaths, moved);
        return mapped ? { ...v, refPaths: mapped } : v;
      });
    }
    if (Object.keys(patch).length) ops.push({ op: 'render', target, patch });
  }
  return ops;
}

// ── Router ───────────────────────────────────────────────────────────────────

export interface StorageAdminDeps {
  /** Service-role client: comic_docs listing and the image_assets ledger. */
  admin?: () => SupabaseClient;
  /** Low-level storage operations (copy / remove / register). */
  storage?: () => StorageOps;
  docStore?: () => DocStore;
  audit?: (input: AuditInput) => Promise<void>;
}

interface ProjectReport {
  projectId: string;
  status: 'ok' | 'busy' | 'error' | 'missing';
  /** Legacy objects found before this batch. */
  legacy: number;
  migrated: number;
  removedPublic: number;
  /** Moved, but the public copy stays (not in this comic's own lane, or still referenced). */
  keptPublic: number;
  remaining: number;
  /** Public copies of earlier moves still waiting to be deleted. */
  pendingCleanup: number;
  skipped: RefMigrationPlan['skipped'];
  error?: string;
}

let running = false;

/** Test hook. */
export const __resetStorageAdminForTests = (): void => {
  running = false;
};

const lazy = <T>(make: () => T): (() => T) => {
  let value: T | undefined;
  return () => (value ??= make());
};

export function createComicStorageAdminRouter(deps: StorageAdminDeps = {}): Router {
  const router = Router();
  const admin = deps.admin || getSupabaseAdmin;
  const defaultStorage = lazy(() => createSupabaseStorage({ admin }).ops);
  const defaultDocStore = lazy(() => createSupabaseDocStore());
  const storage = (): StorageOps => (deps.storage ? deps.storage() : defaultStorage());
  const docStore = (): DocStore => (deps.docStore ? deps.docStore() : defaultDocStore());
  const audit = deps.audit || recordAudit;

  /** comic_docs rows (project id order) from `cursor` inclusive. */
  const listDocs = async (cursor: string | undefined, limit: number): Promise<{ projectId: string; userId: string }[]> => {
    let q = admin().from('comic_docs').select('project_id, user_id');
    if (cursor) q = q.gte('project_id', cursor);
    const { data, error } = await q.order('project_id', { ascending: true }).limit(limit);
    if (error) throw new StudioError('INTERNAL', "Comics couldn't be listed right now.", { status: 503, retryable: true, cause: error });
    return (data || [])
      .map((r) => ({ projectId: String((r as { project_id?: unknown }).project_id || ''), userId: String((r as { user_id?: unknown }).user_id || '') }))
      .filter((r) => r.projectId && r.userId);
  };

  const ownerOf = async (projectId: string): Promise<string | null> => {
    const { data, error } = await admin().from('comic_docs').select('project_id, user_id').eq('project_id', projectId).maybeSingle();
    if (error) throw new StudioError('INTERNAL', "That comic couldn't be read right now.", { status: 503, retryable: true, cause: error });
    const userId = (data as { user_id?: unknown } | null)?.user_id;
    return userId ? String(userId) : null;
  };

  /** Earlier moves of this comic whose public copy may still exist: [publicPath]. */
  const ledgerCounterparts = async (projectId: string): Promise<string[]> => {
    try {
      const { data, error } = await admin()
        .from('image_assets')
        .select('path')
        .eq('project_id', projectId)
        .eq('bucket', PRIVATE_BUCKET)
        .eq('source', MIGRATED_SOURCE)
        .is('deleted_at', null);
      if (error) throw error;
      const counterparts = (data || []).map((r) => publicCounterpart(String((r as { path?: unknown }).path || ''))).filter((p): p is string => !!p);
      if (!counterparts.length) return [];
      // Only counterparts known to exist (a live image_assets row) are pending; rows that
      // removeObjects marked deleted are done, and a ledger id with no public original
      // (e.g. a tmp-lane source) has nothing to clean.
      const { data: rows, error: rowsError } = await admin().from('image_assets').select('path, deleted_at').in('path', counterparts);
      if (rowsError) throw rowsError;
      const alive = new Set(
        (rows || []).filter((r) => !(r as { deleted_at?: unknown }).deleted_at).map((r) => String((r as { path?: unknown }).path))
      );
      return counterparts.filter((p) => alive.has(p));
    } catch (err) {
      logger.warn('comic_migrate_ledger_failed', { projectId, message: (err as Error)?.message });
      return [];
    }
  };

  const loadDocForPlan = async (projectId: string, userId: string): Promise<ComicDoc | null> => {
    const live = peekStudioSession(projectId);
    if (live && live.userId === userId && !live.isGone) return live.doc;
    return docStore().load(projectId, userId);
  };

  const dryRunProject = async (projectId: string, userId: string): Promise<ProjectReport> => {
    const doc = await loadDocForPlan(projectId, userId);
    if (!doc) return { projectId, status: 'missing', legacy: 0, migrated: 0, removedPublic: 0, keptPublic: 0, remaining: 0, pendingCleanup: 0, skipped: [] };
    const plan = planRefMigration(doc, userId, projectId);
    const live = new Set(collectAssetPaths(doc));
    const pending = (await ledgerCounterparts(projectId)).filter((p) => !live.has(p));
    return {
      projectId,
      status: 'ok',
      legacy: plan.items.length,
      migrated: 0,
      removedPublic: 0,
      keptPublic: 0,
      remaining: plan.items.length,
      pendingCleanup: pending.length,
      skipped: plan.skipped
    };
  };

  const migrateProject = async (projectId: string, userId: string, budget: number): Promise<ProjectReport> => {
    const base: ProjectReport = { projectId, status: 'ok', legacy: 0, migrated: 0, removedPublic: 0, keptPublic: 0, remaining: 0, pendingCleanup: 0, skipped: [] };
    let session: Awaited<ReturnType<typeof getStudioSession>>;
    try {
      session = await getStudioSession(projectId, userId, docStore());
    } catch (err) {
      if (err instanceof StudioError && err.code === 'NOT_FOUND') return { ...base, status: 'missing' };
      throw err;
    }
    const plan = planRefMigration(session.doc, userId, projectId);
    base.legacy = plan.items.length;
    base.skipped = plan.skipped;
    if (session.busy || session.turnRunning) return { ...base, status: 'busy', remaining: plan.items.length };

    const ops = storage();
    const want = Math.max(0, budget);
    /** Items actually copied this batch (in plan order). */
    const batch: LegacyRefItem[] = [];
    /** Sources already gone from storage: nothing to move; reported, never retried in this batch. */
    const missing: string[] = [];
    // Copy + rewrite + save under the turn lock, so no director turn starts in between.
    const saved = await session.runExclusive(async () => {
      const moved = new Map<string, string>();
      let attempts = 0;
      for (const item of plan.items) {
        if (batch.length >= want || attempts >= MIGRATE_MAX_ATTEMPTS) break;
        attempts += 1;
        try {
          await ops.copy(item.path, item.dst);
        } catch (err) {
          // A legacy photo whose public object is already gone cannot be moved; without this one
          // dead path would fail the comic on every run and stall the whole migration on it.
          if (err instanceof StudioError && err.code === 'NOT_FOUND') {
            missing.push(item.path);
            continue;
          }
          throw err;
        }
        batch.push(item);
        moved.set(item.path, item.dst);
        await ops.register({ userId, projectId, path: item.dst, bytes: 0, source: MIGRATED_SOURCE });
      }
      if (moved.size) {
        const rewrite = rewriteOpsFor(session.doc, moved);
        if (rewrite.length) session.commit(rewrite, { origin: 'job', label: 'Moved your reference photos to private storage' });
        await session.flush();
      }
      return { moved, ok: !moved.size || (session.persisted && !session.isGone) };
    });
    const migrated = saved.moved.size;
    const remaining = Math.max(0, plan.items.length - migrated - missing.length);
    if (missing.length) base.skipped = [...base.skipped, ...missing.map((path) => ({ path, reason: 'missing_object' as const }))];
    if (!saved.ok) {
      // The old paths are still what the database holds: deleting now would break the comic.
      return { ...base, status: 'error', migrated, remaining, error: "The comic couldn't be saved, so the public copies were kept. Run the batch again." };
    }
    // Cleanup (outside the lock, so `busy` means someone else): public copies in this comic's own
    // lane that nothing references any more — this batch's and any an earlier run left behind.
    const candidates = new Set<string>(await ledgerCounterparts(projectId));
    for (const item of batch) if (item.ownLane) candidates.add(item.path);
    // Read what the doc references right before deciding (after the await above), so a change
    // that landed meanwhile is never deleted from under it.
    const live = new Set(collectAssetPaths(session.doc));
    const doomed = [...candidates].filter((p) => p.startsWith(`u/${userId}/p/${projectId}/img/`) && !live.has(p));
    let removedPublic = 0;
    let pendingCleanup = 0;
    if (doomed.length) {
      if (session.busy) {
        pendingCleanup = doomed.length; // a render or turn started meanwhile: finish on the next run
      } else {
        const siblings = doomed.flatMap((p) => [variantPathFor(p, 480), variantPathFor(p, 1080)]).filter((p) => !live.has(p));
        await ops.removeObjects([...doomed, ...siblings]);
        removedPublic = doomed.length;
      }
    }
    return { ...base, migrated, removedPublic, keptPublic: batch.filter((i) => !i.ownLane).length, remaining, pendingCleanup };
  };

  router.post('/migrate-refs', async (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'dryRun must be true or false.' } });
    }
    const dryRun = body.dryRun !== false; // dry run unless explicitly turned off
    const projectId = body.projectId === undefined ? undefined : String(body.projectId);
    const cursor = body.cursor === undefined || body.cursor === null ? undefined : String(body.cursor);
    if ((projectId !== undefined && !UUID_RE.test(projectId)) || (cursor !== undefined && !UUID_RE.test(cursor))) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'projectId and cursor must be comic ids.' } });
    }
    const rawLimit = body.limit === undefined ? MIGRATE_MAX_LIMIT : Number(body.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MIGRATE_MAX_LIMIT) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: `limit must be a whole number from 1 to ${MIGRATE_MAX_LIMIT}.` } });
    }
    if (running) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'A migration batch is already running. Try again in a moment.' } });
    }
    running = true;
    try {
      let rows: { projectId: string; userId: string }[];
      let nextCursor: string | null = null;
      if (projectId) {
        const userId = await ownerOf(projectId);
        if (!userId) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No Comic Studio comic with that id.' } });
        rows = [{ projectId, userId }];
      } else {
        const page = await listDocs(cursor, MIGRATE_SCAN_PAGE + 1);
        rows = page.slice(0, MIGRATE_SCAN_PAGE);
        nextCursor = page[MIGRATE_SCAN_PAGE]?.projectId ?? null;
      }

      const projects: ProjectReport[] = [];
      let budget = rawLimit;
      for (const row of rows) {
        if (dryRun) {
          projects.push(await dryRunProject(row.projectId, row.userId));
          continue;
        }
        if (budget <= 0) {
          nextCursor = row.projectId; // resume here next time
          break;
        }
        let report: ProjectReport;
        try {
          report = await migrateProject(row.projectId, row.userId, budget);
        } catch (err) {
          logger.error('comic_migrate_refs_failed', { projectId: row.projectId, message: (err as Error)?.message });
          report = {
            projectId: row.projectId,
            status: 'error',
            legacy: 0,
            migrated: 0,
            removedPublic: 0,
            keptPublic: 0,
            remaining: 0,
            pendingCleanup: 0,
            skipped: [],
            error: err instanceof StudioError ? err.userMessage : 'Storage failed for this comic. Run the batch again.'
          };
        }
        projects.push(report);
        budget -= report.migrated;
        // Unfinished comic (budget ran out, busy, or failed): the next batch resumes on it.
        if (report.status === 'error' || report.status === 'busy' || report.remaining > 0 || report.pendingCleanup > 0) {
          nextCursor = row.projectId;
          break;
        }
      }
      if (projectId) {
        // One named comic: "next" means "run this comic again" (only meaningful for real runs).
        const p = projects[0];
        nextCursor = !dryRun && p && (p.remaining > 0 || p.pendingCleanup > 0 || p.status === 'busy' || p.status === 'error') ? projectId : null;
      }

      const sum = (k: 'legacy' | 'migrated' | 'removedPublic' | 'keptPublic' | 'remaining' | 'pendingCleanup') => projects.reduce((n, p) => n + p[k], 0);
      const totals = {
        legacy: sum('legacy'),
        migrated: sum('migrated'),
        removedPublic: sum('removedPublic'),
        keptPublic: sum('keptPublic'),
        remaining: sum('remaining'),
        pendingCleanup: sum('pendingCleanup'),
        skipped: projects.reduce((n, p) => n + p.skipped.length, 0),
        busy: projects.filter((p) => p.status === 'busy').length,
        failed: projects.filter((p) => p.status === 'error').length
      };
      const done = nextCursor === null && totals.failed === 0 && totals.busy === 0 && (dryRun || (totals.remaining === 0 && totals.pendingCleanup === 0));
      // "copy" → "copies"; everything else takes an "s".
      const plural = (n: number, word: string) => `${n} ${n === 1 ? word : word.endsWith('copy') ? `${word.slice(0, -1)}ies` : `${word}s`}`;
      const missingObjects = projects.reduce((n, p) => n + p.skipped.filter((x) => x.reason === 'missing_object').length, 0);
      const message = dryRun
        ? `Dry run: ${plural(totals.legacy, 'legacy photo')} in ${plural(projects.length, 'comic')} would move to private storage` +
          `${totals.pendingCleanup ? `, and ${plural(totals.pendingCleanup, 'earlier public copy')} would be deleted` : ''}` +
          `${totals.skipped ? ` (${totals.skipped} left as they are)` : ''}.` +
          (nextCursor ? ' More comics remain — continue with the returned cursor.' : ' Run with dryRun:false to migrate in batches of up to 10.')
        : `Moved ${plural(totals.migrated, 'photo')} to private storage and deleted ${plural(totals.removedPublic, 'public copy')}` +
          `${totals.keptPublic ? ` (${totals.keptPublic} public ${totals.keptPublic === 1 ? 'copy' : 'copies'} kept: shared or outside this comic's folder)` : ''}.` +
          `${totals.busy ? ` ${plural(totals.busy, 'comic')} busy rendering — run again shortly.` : ''}` +
          `${totals.failed ? ` ${plural(totals.failed, 'comic')} failed — run again.` : ''}` +
          `${missingObjects ? ` ${plural(missingObjects, 'photo')} already missing from storage, left as ${missingObjects === 1 ? 'it is' : 'they are'}.` : ''}` +
          (done ? ' Everything is migrated.' : nextCursor ? ' Run the next batch with the returned cursor.' : '');

      if (!dryRun) {
        await audit({
          actorId: req.user?.id ?? null,
          action: 'comic.storage.migrate_refs',
          targetType: 'comic_docs',
          targetId: projectId,
          detail: { migrated: totals.migrated, removedPublic: totals.removedPublic, projects: projects.map((p) => p.projectId), failed: totals.failed }
        });
      }
      return res.json({ dryRun, done, nextCursor, totals, projects, message });
    } catch (err) {
      logger.error('comic_migrate_refs_request_failed', { message: (err as Error)?.message });
      if (/^MISSING_/.test(String((err as { publicCode?: unknown })?.publicCode || ''))) {
        return res.status(503).json({ error: { code: 'NOT_AVAILABLE', message: "Storage isn't configured on this server." } });
      }
      const status = err instanceof StudioError ? err.status : 500;
      const message = err instanceof StudioError ? err.userMessage : 'Storage maintenance failed. Please try again.';
      return res.status(status).json({ error: { code: err instanceof StudioError ? err.code : 'INTERNAL', message } });
    } finally {
      running = false;
    }
  });

  return router;
}

export const comicStorageAdminRouter = createComicStorageAdminRouter();
