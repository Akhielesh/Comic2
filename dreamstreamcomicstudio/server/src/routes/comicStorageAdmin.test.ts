// @vitest-environment node
// POST /api/comic/admin/storage/migrate-refs (P1-STORAGE): legacy refs and attachments move from
// the public bucket (…/img/) to the private one (…/ref/). Dry run first, batches ≤ 10,
// idempotent, never destructive before the rewritten doc is saved.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { SupabaseClient } from '@supabase/supabase-js';
import { emptyRender, type ComicDoc, type RefAsset } from '../../../shared/comic/doc.js';
import { plannedDoc } from '../comic/orchestrator.fakes.js';
import { createMemoryDocStore, type MemoryDocStore } from '../comic/store.js';
import { __resetSessionsForTests, getStudioSession } from '../comic/session.js';
import { __resetAssetCachesForTests, createSupabaseStorage } from '../comic/assets.js';
import { __resetStorageAdminForTests, createComicStorageAdminRouter, planRefMigration, rewriteOpsFor } from './comicStorageAdmin.js';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PID = '11111111-1111-4111-8111-111111111111';
const PID2 = '22222222-2222-4222-8222-222222222222';
const ADMIN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const img = (name: string, pid = PID, owner = OWNER) => `u/${owner}/p/${pid}/img/${name}.webp`;
const refp = (name: string, pid = PID, owner = OWNER) => `u/${owner}/p/${pid}/ref/${name}.webp`;
const r = (path: string, extra: Partial<RefAsset> = {}): RefAsset => ({ path, source: 'upload', at: 1, w: 800, h: 600, ...extra });

/** A comic with every kind of reference the migration must handle. */
const legacyDoc = (pid = PID): ComicDoc => {
  const doc = plannedDoc(pid);
  doc.cast[0].refs = [r(img('r1', pid), { variants: [{ path: img('r1_w480', pid), w: 480, h: 360 }] }), r(refp('already', pid))];
  doc.cast[0].sheet = { ...emptyRender(), status: 'ready', asset: { path: img('sheet', pid), source: 'generated', at: 2 }, refPaths: [img('r1', pid)] };
  doc.cast[1].refs = [r(img('r3', pid))];
  doc.places[0].refs = [r(img('foreign', pid, OTHER)), r('library/v1/style.noir/1.webp', { source: 'library' })];
  // Generated art the user also pinned as a style ref: it is a render, so it stays public.
  doc.style.refs = [r(img('art', pid), { source: 'generated' })];
  doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: img('art', pid), source: 'generated', at: 3 } };
  doc.refInbox = [r(`u/${OWNER}/tmp/t1.webp`, { at: Date.now() })]; // fresh: the 24 h inbox prune keeps it
  doc.conversation = [{ id: 'm1', role: 'user', text: 'here are photos', at: 4, attachments: [r(img('a1', pid))] }];
  return doc;
};

// ── Supabase fake: two buckets + comic_docs / image_assets / audit tables ──

type Row = Record<string, unknown>;
const db = {
  buckets: new Map<string, Map<string, Buffer>>(),
  tables: {} as Record<string, Row[]>,
  removed: [] as { bucket: string; paths: string[] }[],
  copies: 0
};
const bucket = (name: string) => {
  if (!db.buckets.has(name)) db.buckets.set(name, new Map());
  return db.buckets.get(name)!;
};
const fail = (message: string, statusCode: string) => ({ data: null, error: Object.assign(new Error(message), { statusCode }) });

class Query implements PromiseLike<{ data: unknown; error: null }> {
  private filters: ((row: Row) => boolean)[] = [];
  private single = false;
  private max = Infinity;
  private sortBy?: string;
  private patch?: Row;
  constructor(private table: string) {}
  select() {
    return this;
  }
  update(patch: Row) {
    this.patch = patch;
    return this;
  }
  eq(col: string, v: unknown) {
    this.filters.push((row) => row[col] === v);
    return this;
  }
  is(col: string, v: unknown) {
    this.filters.push((row) => (row[col] ?? null) === v);
    return this;
  }
  in(col: string, vs: unknown[]) {
    this.filters.push((row) => vs.includes(row[col]));
    return this;
  }
  gte(col: string, v: string) {
    this.filters.push((row) => String(row[col]) >= v);
    return this;
  }
  order(col: string) {
    this.sortBy = col;
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  then<A, B>(onOk?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null, onErr?: ((e: unknown) => B | PromiseLike<B>) | null) {
    let rows = (db.tables[this.table] ||= []).filter((row) => this.filters.every((f) => f(row)));
    if (this.patch) {
      rows.forEach((row) => Object.assign(row, this.patch));
      return Promise.resolve({ data: null, error: null as null }).then(onOk, onErr);
    }
    if (this.sortBy) rows = [...rows].sort((a, b) => String(a[this.sortBy!]).localeCompare(String(b[this.sortBy!])));
    rows = rows.slice(0, this.max);
    return Promise.resolve({ data: this.single ? rows[0] ?? null : rows, error: null as null }).then(onOk, onErr);
  }
}

const client = {
  from: (table: string) => ({
    select: () => new Query(table),
    update: (patch: Row) => new Query(table).update(patch),
    insert: async (row: Row) => {
      const rows = (db.tables[table] ||= []);
      if (rows.some((x) => x.path === row.path)) return { error: { code: '23505' } };
      rows.push({ ...row });
      return { error: null };
    }
  }),
  storage: {
    from: (name: string) => ({
      copy: async (from: string, to: string, opts?: { destinationBucket?: string }) => {
        const dst = opts?.destinationBucket || name;
        if (!bucket(name).has(from)) return fail('Object not found', '404');
        if (bucket(dst).has(to)) return fail('The resource already exists', '409');
        bucket(dst).set(to, bucket(name).get(from)!);
        db.copies += 1;
        return { data: { path: to }, error: null };
      },
      remove: async (paths: string[]) => {
        db.removed.push({ bucket: name, paths });
        paths.forEach((p) => bucket(name).delete(p));
        return { data: [], error: null };
      },
      download: async (path: string) =>
        bucket(name).has(path) ? { data: new Blob([new Uint8Array(bucket(name).get(path)!)]), error: null } : fail('Object not found', '404'),
      upload: async (path: string, data: Buffer) => {
        bucket(name).set(path, Buffer.from(data));
        return { data: { path }, error: null };
      }
    })
  }
} as unknown as SupabaseClient;

let docs: MemoryDocStore;
const audit = vi.fn(async () => undefined);
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { user: { id: string } }).user = { id: ADMIN };
  next();
});
app.use(
  '/api/comic/admin/storage',
  createComicStorageAdminRouter({
    admin: () => client,
    storage: () => createSupabaseStorage({ admin: () => client }).ops,
    docStore: () => docs,
    audit
  })
);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const seedComic = async (pid: string, doc = legacyDoc(pid)) => {
  await docs.create({ projectId: pid, userId: OWNER, doc });
  db.tables.comic_docs.push({ project_id: pid, user_id: OWNER });
  for (const path of [img('r1', pid), img('r1_w480', pid), img('r3', pid), img('art', pid), img('a1', pid), img('foreign', pid, OTHER), `u/${OWNER}/tmp/t1.webp`]) {
    bucket('comic-assets').set(path, Buffer.from(`bytes:${path}`));
    db.tables.image_assets.push({ path, bucket: 'comic-assets', deleted_at: null });
  }
  bucket('comic-private').set(refp('already', pid), Buffer.from('private'));
};

beforeEach(async () => {
  __resetSessionsForTests();
  __resetAssetCachesForTests();
  __resetStorageAdminForTests();
  audit.mockClear();
  db.buckets = new Map();
  db.tables = { comic_docs: [], image_assets: [] };
  db.removed = [];
  db.copies = 0;
  docs = createMemoryDocStore();
  await seedComic(PID);
});

const migrate = async (body: Record<string, unknown>) => {
  const res = await fetch(`${base}/api/comic/admin/storage/migrate-refs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

const storedDoc = (pid = PID) => docs.rows.get(pid)!.doc!;

describe('planRefMigration (pure)', () => {
  it('finds the owner’s public refs and attachments, skipping renders, foreign and private paths', () => {
    const plan = planRefMigration(legacyDoc(), OWNER, PID);
    expect(plan.items.map((i) => [i.path, i.dst, i.ownLane])).toEqual([
      [img('r1'), refp('r1'), true],
      [img('r3'), refp('r3'), true],
      [`u/${OWNER}/tmp/t1.webp`, refp('t1'), false],
      [img('a1'), refp('a1'), true]
    ]);
    expect(plan.skipped).toEqual([
      { path: img('art'), reason: 'also_a_render' },
      { path: img('foreign', PID, OTHER), reason: 'not_owner_path' }
    ]);
  });

  it('rewrite ops repoint refs, attachments and sheet refPaths, dropping public variants', () => {
    const doc = legacyDoc();
    const ops = rewriteOpsFor(doc, new Map([[img('r1'), refp('r1')], [img('a1'), refp('a1')]]));
    expect(ops).toContainEqual({ op: 'ref_patch', owner: { kind: 'character', id: 'c_maya' }, path: img('r1'), patch: { path: refp('r1'), variants: null } });
    expect(ops).toContainEqual({ op: 'message_patch', id: 'm1', patch: { attachments: [{ path: refp('a1'), source: 'upload', at: 1, w: 800, h: 600 }] } });
    expect(ops).toContainEqual({ op: 'render', target: { kind: 'sheet', id: 'c_maya' }, patch: { refPaths: [refp('r1')] } });
  });
});

describe('POST /migrate-refs', () => {
  it('is a dry run by default: counts only, nothing copied, deleted or saved', async () => {
    const before = JSON.stringify(storedDoc());
    const { status, body } = await migrate({});
    expect(status).toBe(200);
    expect(body).toMatchObject({ dryRun: true, done: true, nextCursor: null, totals: { legacy: 4, migrated: 0, removedPublic: 0, skipped: 2 } });
    expect(body.projects[0]).toMatchObject({ projectId: PID, status: 'ok', legacy: 4, remaining: 4 });
    expect(body.message).toMatch(/Dry run: 4 legacy photos in 1 comic would move/);
    expect(db.copies).toBe(0);
    expect(db.removed).toEqual([]);
    expect(JSON.stringify(storedDoc())).toBe(before);
    expect(audit).not.toHaveBeenCalled();
  });

  it('migrates in client-driven batches, saves before deleting, and is idempotent', async () => {
    const first = await migrate({ dryRun: false, projectId: PID, limit: 2 });
    expect(first.status).toBe(200);
    expect(first.body.projects[0]).toMatchObject({ migrated: 2, remaining: 2, removedPublic: 2 });
    expect(first.body).toMatchObject({ done: false, nextCursor: PID });
    // The saved doc points at the private copies; the public ones are gone (with their variants).
    const saved = storedDoc();
    expect(saved.cast[0].refs.map((x) => x.path)).toEqual([refp('r1'), refp('already')]);
    expect(saved.cast[0].refs[0].variants).toBeUndefined();
    expect(saved.cast[0].sheet.refPaths).toEqual([refp('r1')]);
    expect(saved.cast[1].refs[0].path).toBe(refp('r3'));
    expect(bucket('comic-private').get(refp('r1'))?.toString()).toBe(`bytes:${img('r1')}`);
    expect(bucket('comic-assets').has(img('r1'))).toBe(false);
    expect(bucket('comic-assets').has(img('r1_w480'))).toBe(false);
    expect(db.tables.image_assets.find((x) => x.path === img('r1'))?.deleted_at).toBeTruthy();
    expect(db.tables.image_assets.find((x) => x.path === refp('r1'))).toMatchObject({ bucket: 'comic-private', source: 'ref_migrated', user_id: OWNER });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actorId: ADMIN, action: 'comic.storage.migrate_refs' }));

    const second = await migrate({ dryRun: false, projectId: PID });
    expect(second.body.projects[0]).toMatchObject({ migrated: 2, remaining: 0, keptPublic: 1, removedPublic: 1 });
    expect(second.body).toMatchObject({ done: true, nextCursor: null });
    const done = storedDoc();
    expect(done.refInbox?.[0].path).toBe(refp('t1'));
    expect(done.conversation[0].attachments?.[0].path).toBe(refp('a1'));
    // The generated art stays where it is; the tmp-lane original is kept (outside this comic's folder).
    expect(done.style.refs[0].path).toBe(img('art'));
    expect(bucket('comic-assets').has(img('art'))).toBe(true);
    expect(bucket('comic-assets').has(`u/${OWNER}/tmp/t1.webp`)).toBe(true);
    expect(bucket('comic-assets').has(img('foreign', PID, OTHER))).toBe(true);

    // Idempotent: a third run finds nothing to do and changes nothing.
    const copies = db.copies;
    const rev = storedDoc().rev;
    const third = await migrate({ dryRun: false, projectId: PID });
    expect(third.body.totals).toMatchObject({ legacy: 0, migrated: 0, removedPublic: 0 });
    expect(third.body.done).toBe(true);
    expect(db.copies).toBe(copies);
    expect(storedDoc().rev).toBe(rev);
  });

  it('resumes safely after a crash between copy and save (existing copy counts, cleanup finishes later)', async () => {
    // A previous run copied r1 privately and wrote its ledger row, then died before the doc changed.
    bucket('comic-private').set(refp('r1'), Buffer.from(`bytes:${img('r1')}`));
    db.tables.image_assets.push({ path: refp('r1'), bucket: 'comic-private', source: 'ref_migrated', project_id: PID, deleted_at: null });
    const dry = await migrate({ projectId: PID });
    // The public copy is still referenced by the stored doc, so nothing is "pending" yet.
    expect(dry.body.projects[0]).toMatchObject({ legacy: 4, pendingCleanup: 0 });
    const run = await migrate({ dryRun: false, projectId: PID, limit: 10 });
    expect(run.body.projects[0]).toMatchObject({ migrated: 4, remaining: 0 });
    expect(storedDoc().cast[0].refs[0].path).toBe(refp('r1'));
    expect(bucket('comic-assets').has(img('r1'))).toBe(false);
  });

  it('a legacy photo already missing from storage is reported, never stalls the migration, and its path is left alone', async () => {
    bucket('comic-assets').delete(img('r3'));
    const run = await migrate({ dryRun: false, projectId: PID, limit: 10 });
    expect(run.status).toBe(200);
    expect(run.body.projects[0]).toMatchObject({ status: 'ok', migrated: 3, remaining: 0, removedPublic: 2, keptPublic: 1 });
    expect(run.body.projects[0].skipped).toContainEqual({ path: img('r3'), reason: 'missing_object' });
    expect(run.body).toMatchObject({ done: true, nextCursor: null });
    expect(run.body.message).toMatch(/deleted 2 public copies/);
    expect(run.body.message).toMatch(/1 photo already missing from storage/);
    const saved = storedDoc();
    expect(saved.cast[0].refs[0].path).toBe(refp('r1'));
    expect(saved.cast[1].refs[0].path).toBe(img('r3')); // nothing to point at: unchanged
    expect(bucket('comic-private').has(refp('r3'))).toBe(false);
    // A cursor scan does not get stuck on it either.
    await seedComic(PID2);
    const scan = await migrate({ dryRun: false, limit: 10 });
    expect(scan.body.projects.map((p: { projectId: string }) => p.projectId)).toContain(PID2);
  });

  it('skips a comic that is rendering and tells the admin to retry', async () => {
    const session = await getStudioSession(PID, OWNER, docs);
    let release!: () => void;
    const busy = session.runExclusive(() => new Promise<void>((resolve) => (release = resolve)));
    const { body } = await migrate({ dryRun: false, projectId: PID });
    expect(body.projects[0]).toMatchObject({ status: 'busy', migrated: 0 });
    expect(body).toMatchObject({ done: false, nextCursor: PID });
    expect(body.message).toMatch(/busy/);
    expect(db.copies).toBe(0);
    release();
    await busy;
  });

  it('scans comics in pages with a cursor and a per-request object budget', async () => {
    await seedComic(PID2);
    const first = await migrate({ dryRun: false, limit: 3 });
    expect(first.body.totals.migrated).toBe(3);
    expect(first.body.nextCursor).toBe(PID);
    let cursor = first.body.nextCursor;
    let rounds = 0;
    while (cursor && rounds < 10) {
      const next = await migrate({ dryRun: false, limit: 10, cursor });
      cursor = next.body.nextCursor;
      rounds += 1;
    }
    expect(cursor).toBeNull();
    for (const pid of [PID, PID2]) {
      const plan = planRefMigration(storedDoc(pid), OWNER, pid);
      expect(plan.items).toEqual([]);
    }
    const dry = await migrate({});
    expect(dry.body).toMatchObject({ done: true, totals: { legacy: 0, pendingCleanup: 0 } });
  });

  it('validates input and refuses overlapping batches', async () => {
    expect((await migrate({ limit: 11 })).status).toBe(400);
    expect((await migrate({ limit: 0 })).status).toBe(400);
    expect((await migrate({ dryRun: 'no' })).status).toBe(400);
    expect((await migrate({ projectId: '../etc' })).status).toBe(400);
    expect((await migrate({ projectId: '' })).status).toBe(400);
    expect((await migrate({ cursor: 'u/x' })).status).toBe(400);
    expect((await migrate({ projectId: '99999999-9999-4999-8999-999999999999' })).status).toBe(404);
    // Hold the first batch inside the doc load, then try a second one.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const load = docs.load.bind(docs);
    docs.load = async (projectId, userId) => {
      await gate;
      return load(projectId, userId);
    };
    const first = migrate({ dryRun: false, projectId: PID });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await migrate({ dryRun: false, projectId: PID });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
    open();
    expect((await first).status).toBe(200);
  });
});
