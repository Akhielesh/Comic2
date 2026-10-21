// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createEmptyDoc, type ComicDoc, type Page } from '../../../shared/comic/doc.js';
import { buildLegacyProjectState, createMemoryDocStore, createSupabaseDocStore, sanitizePublicDoc } from './store.js';
import { StudioError } from './types.js';

const USER = 'user-a';
const OTHER = 'user-b';
const PID = '33333333-3333-4333-8333-333333333333';

type Row = Record<string, any>;
type PgErr = { code: string; message: string };

/** A tiny PostgREST look-alike: enough of the builder API for store.ts. */
const makeDb = () => {
  const tables: Record<string, Row[]> = { projects: [], comic_docs: [] };
  const failures: { table: string; op: string; error: PgErr }[] = [];
  const calls: { table: string; op: string; payload?: unknown }[] = [];

  class Query {
    private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    private payload: Row | undefined;
    private filters: ((r: Row) => boolean)[] = [];
    private single = false;
    private returning = false;
    constructor(private table: string) {}
    select() {
      if (this.op !== 'select') this.returning = true;
      return this;
    }
    insert(row: Row) {
      this.op = 'insert';
      this.payload = row;
      return this;
    }
    update(payload: Row) {
      this.op = 'update';
      this.payload = payload;
      return this;
    }
    delete() {
      this.op = 'delete';
      return this;
    }
    eq(col: string, value: unknown) {
      this.filters.push((r) => r[col] === value);
      return this;
    }
    lte(col: string, value: number) {
      this.filters.push((r) => r[col] <= value);
      return this;
    }
    maybeSingle() {
      this.single = true;
      return this;
    }
    then<T>(resolve: (v: { data: unknown; error: PgErr | null }) => T, reject?: (e: unknown) => T) {
      return Promise.resolve()
        .then(() => this.exec())
        .then(resolve, reject);
    }
    private exec(): { data: unknown; error: PgErr | null } {
      calls.push({ table: this.table, op: this.op, payload: this.payload });
      const failure = failures.findIndex((f) => f.table === this.table && f.op === this.op);
      if (failure >= 0) {
        const [f] = failures.splice(failure, 1);
        return { data: null, error: f.error };
      }
      const rows = tables[this.table];
      const match = (r: Row) => this.filters.every((f) => f(r));
      switch (this.op) {
        case 'insert': {
          const row = JSON.parse(JSON.stringify(this.payload)) as Row;
          const pk = this.table === 'projects' ? 'id' : 'project_id';
          if (rows.some((r) => r[pk] === row[pk])) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          if (this.table === 'comic_docs' && !tables.projects.some((p) => p.id === row.project_id)) {
            return { data: null, error: { code: '23503', message: 'fk violation' } };
          }
          rows.push(row);
          return { data: null, error: null };
        }
        case 'update': {
          const hits = rows.filter(match);
          hits.forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(this.payload))));
          return { data: this.returning ? hits.map((r) => ({ ...r })) : null, error: null };
        }
        case 'delete': {
          tables[this.table] = rows.filter((r) => !match(r));
          return { data: null, error: null };
        }
        default: {
          const hits = rows.filter(match).map((r) => JSON.parse(JSON.stringify(r)));
          return { data: this.single ? hits[0] ?? null : hits, error: null };
        }
      }
    }
  }

  const client = { from: (table: string) => new Query(table) } as unknown as SupabaseClient;
  return {
    client,
    tables,
    calls,
    failNext: (table: string, op: string, error: PgErr) => failures.push({ table, op, error })
  };
};

const page = (n: number, status: Page['render']['status'], path?: string): Page => ({
  id: `pg_${n}`,
  n,
  summary: `Page ${n}`,
  layout: 'Row 1: one wide panel.',
  panels: [],
  render: { status, history: [], ...(path ? { asset: { path, source: 'generated', at: 1 } } : {}) },
  balloons: []
});

const docWith = (patch: Partial<ComicDoc> = {}): ComicDoc => ({ ...createEmptyDoc(PID, 'Spice Market', 1000), ...patch });

describe('buildLegacyProjectState', () => {
  it('produces the minimal legacy-compatible state', () => {
    const doc = docWith({
      brief: { title: 'Spice Market', logline: 'Two rivals, one recipe.', notes: [] },
      style: { status: 'locked', name: 'Ligne claire', spec: 'Clean lines.', refs: [], options: [] },
      pages: [page(2, 'ready', 'u/a/p2.webp'), page(1, 'ready', 'u/a/p1.webp'), page(3, 'failed')]
    });
    expect(buildLegacyProjectState(doc)).toEqual({
      studioVersion: 4,
      pipelineMode: 'classic',
      step: 0,
      maxStepReached: 0,
      script: '',
      scenes: [],
      panels: [],
      characters: [],
      items: [],
      locations: [],
      styleVariants: [],
      stylePrompt: 'Clean lines.',
      styleCategory: 'Ligne claire',
      styleAspectRatio: '2:3',
      imageResolution: '2K',
      layoutType: 'classic',
      overview: 'Two rivals, one recipe.',
      coverImageId: 'u/a/p1.webp',
      studioPages: 3,
      studioRendered: 2
    });
  });

  it('prefers the cover and omits coverImageId when nothing is rendered', () => {
    const withCover = docWith({ cover: { render: { status: 'ready', history: [], asset: { path: 'u/a/cover.webp', source: 'generated', at: 1 } } } });
    expect(buildLegacyProjectState(withCover).coverImageId).toBe('u/a/cover.webp');
    const empty = buildLegacyProjectState(docWith());
    expect('coverImageId' in empty).toBe(false);
    expect(empty).toMatchObject({ stylePrompt: '', styleCategory: '', overview: '', studioPages: 0, studioRendered: 0 });
  });
});

describe('sanitizePublicDoc', () => {
  it('strips conversation, spend, gate, memory, source, budget and personal reference uploads', () => {
    const ref = { path: 'u/a/photo.webp', source: 'upload' as const, at: 1 };
    const doc = docWith({
      conversation: [{ id: 'm1', role: 'user', text: 'my secret', at: 1 }],
      memory: 'older context',
      source: { script: 'private script' },
      spend: { totalUsd: 1.2, byKind: { page: 1.2 }, entries: [] },
      settings: { quality: 'pro', confirm: 'big', bigSpendUsd: 1, budgetUsd: 20, imageModelOverride: 'x' },
      style: { status: 'locked', refs: [ref], options: [], board: { path: 'u/a/board.webp', source: 'generated', at: 1 } },
      cast: [{ id: 'c1', name: 'Maya', tier: 'lead', look: { summary: 's' }, refs: [ref], sheet: { status: 'ready', history: [] } }],
      places: [{ id: 'pl1', name: 'Market', look: 'busy', refs: [ref], sheet: { status: 'none', history: [] } }]
    });
    const clean = sanitizePublicDoc(doc);
    expect(clean.conversation).toEqual([]);
    expect(clean.memory).toBeUndefined();
    expect(clean.source).toEqual({});
    expect(clean.spend.totalUsd).toBe(0);
    expect(clean.gate).toBeNull();
    expect(clean.settings).toEqual({ quality: 'pro', confirm: 'big', bigSpendUsd: 1 });
    expect(clean.style.refs).toEqual([]);
    expect(clean.style.board?.path).toBe('u/a/board.webp');
    expect(clean.cast[0].refs).toEqual([]);
    expect(clean.places[0].refs).toEqual([]);
    expect(doc.conversation).toHaveLength(1); // input untouched
  });
});

describe('createSupabaseDocStore', () => {
  const setup = (opts: { mirrorIntervalMs?: number } = {}) => {
    const db = makeDb();
    let clock = 10_000;
    const store = createSupabaseDocStore({ admin: () => db.client, now: () => clock, ...opts });
    return { db, store, tick: (ms: number) => (clock += ms) };
  };

  it('creates the projects row and the comic_docs row', async () => {
    const { db, store } = setup();
    await store.create({ projectId: PID, userId: USER, doc: docWith() });
    expect(db.tables.projects[0]).toMatchObject({ id: PID, user_id: USER, name: 'Spice Market', is_public: false });
    expect(db.tables.projects[0].state.studioVersion).toBe(4);
    expect(db.tables.comic_docs[0]).toMatchObject({ project_id: PID, user_id: USER, rev: 0 });
    expect(db.tables.comic_docs[0].doc.id).toBe(PID);
  });

  it('refuses duplicates and rolls back the listing row when the doc insert fails', async () => {
    const { db, store } = setup();
    await store.create({ projectId: PID, userId: USER, doc: docWith() });
    await expect(store.create({ projectId: PID, userId: USER, doc: docWith() })).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 409 });

    const other = '44444444-4444-4444-8444-444444444444';
    db.failNext('comic_docs', 'insert', { code: '42P01', message: 'relation "comic_docs" does not exist' });
    const err = await store.create({ projectId: other, userId: USER, doc: docWith() }).catch((e) => e);
    expect(err).toBeInstanceOf(StudioError);
    expect(err.userMessage).toBe("Comic Studio storage isn't available right now.");
    expect(db.tables.projects.some((p) => p.id === other)).toBe(false);
  });

  it('loads owner-scoped, normalized docs and treats bad ids as not found', async () => {
    const { db, store } = setup();
    await store.create({ projectId: PID, userId: USER, doc: docWith({ rev: 3 }) });
    db.tables.comic_docs[0].rev = 5;
    delete db.tables.comic_docs[0].doc.spend;
    const doc = await store.load(PID, USER);
    expect(doc?.id).toBe(PID);
    expect(doc?.rev).toBe(5);
    expect(doc?.spend).toEqual({ totalUsd: 0, byKind: {}, entries: [] });
    expect(await store.load(PID, OTHER)).toBeNull();
    db.failNext('comic_docs', 'select', { code: '22P02', message: 'invalid input syntax for type uuid' });
    expect(await store.load('nope', USER)).toBeNull();
    db.failNext('comic_docs', 'select', { code: '08006', message: 'connection failure' });
    await expect(store.load(PID, USER)).rejects.toMatchObject({ code: 'INTERNAL', retryable: true });
  });

  it('saves the doc and mirrors name/state onto projects, preserving keys other flows wrote', async () => {
    const { db, store } = setup();
    await store.create({ projectId: PID, userId: USER, doc: docWith() });
    db.tables.projects[0].state.publishedAt = 1234;
    const next = docWith({ rev: 4, brief: { title: 'The Spice Market', logline: 'Rivals cook.', notes: [] }, pages: [page(1, 'ready', 'u/a/p1.webp')] });
    await store.save({ projectId: PID, userId: USER, doc: next, summary: { title: 'The Spice Market', logline: 'Rivals cook.' } });
    expect(db.tables.comic_docs[0]).toMatchObject({ rev: 4 });
    expect(db.tables.comic_docs[0].doc.brief.title).toBe('The Spice Market');
    const project = db.tables.projects[0];
    expect(project.name).toBe('The Spice Market');
    expect(project.state).toMatchObject({ studioVersion: 4, publishedAt: 1234, overview: 'Rivals cook.', coverImageId: 'u/a/p1.webp', studioRendered: 1 });
  });

  it('throttles unchanged mirrors but always writes the doc', async () => {
    const { db, store, tick } = setup({ mirrorIntervalMs: 60_000 });
    await store.create({ projectId: PID, userId: USER, doc: docWith() });
    const projectUpdates = () => db.calls.filter((c) => c.table === 'projects' && c.op === 'update').length;
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 1 }), summary: { title: 'Spice Market' } });
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 2 }), summary: { title: 'Spice Market' } });
    expect(projectUpdates()).toBe(0);
    expect(db.tables.comic_docs[0].rev).toBe(2);
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 3, brief: { title: 'Renamed', notes: [] } }), summary: { title: 'Renamed' } });
    expect(projectUpdates()).toBe(1);
    tick(61_000);
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 4, brief: { title: 'Renamed', notes: [] } }), summary: { title: 'Renamed' } });
    expect(projectUpdates()).toBe(2);
  });

  it('never lets a stale writer clobber a newer doc, and never re-homes another user’s row', async () => {
    const { db, store } = setup();
    await store.create({ projectId: PID, userId: USER, doc: docWith() });
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 9, brief: { title: 'New', notes: [] } }), summary: { title: 'New' } });
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 7, brief: { title: 'Old', notes: [] } }), summary: { title: 'Old' } });
    expect(db.tables.comic_docs[0].doc.brief.title).toBe('New');
    expect(db.tables.comic_docs[0].rev).toBe(9);
    await expect(store.save({ projectId: PID, userId: OTHER, doc: docWith({ rev: 99 }), summary: { title: 'x' } })).rejects.toMatchObject({
      code: 'FORBIDDEN'
    });
    expect(db.tables.comic_docs[0].user_id).toBe(USER);
  });

  it('inserts a missing doc row for an existing project, and 404s when the project is gone', async () => {
    const { db, store } = setup();
    db.tables.projects.push({ id: PID, user_id: USER, name: 'x', state: {} });
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 1 }), summary: { title: 'x' } });
    expect(db.tables.comic_docs).toHaveLength(1);
    const gone = '55555555-5555-4555-8555-555555555555';
    await expect(store.save({ projectId: gone, userId: USER, doc: docWith({ rev: 1 }), summary: { title: 'x' } })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    });
  });

  it('treats a failed mirror as non-fatal', async () => {
    const { db, store } = setup();
    await store.create({ projectId: PID, userId: USER, doc: docWith() });
    db.failNext('projects', 'update', { code: '57014', message: 'statement timeout' });
    await expect(store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 1, brief: { title: 'Z', notes: [] } }), summary: { title: 'Z' } })).resolves.toBeUndefined();
    expect(db.tables.comic_docs[0].rev).toBe(1);
  });

  it('serves public docs only when published and not force-private, sanitized', async () => {
    const { db, store } = setup();
    await store.create({ projectId: PID, userId: USER, doc: docWith({ conversation: [{ id: 'm', role: 'user', text: 'hi', at: 1 }] }) });
    expect(await store.loadPublic(PID)).toBeNull();
    db.tables.projects[0].is_public = true;
    db.tables.projects[0].is_forced_private = true;
    expect(await store.loadPublic(PID)).toBeNull();
    db.tables.projects[0].is_forced_private = false;
    const doc = await store.loadPublic(PID);
    expect(doc?.id).toBe(PID);
    expect(doc?.conversation).toEqual([]);
    // Databases without the moderation columns fall back to is_public alone.
    db.failNext('projects', 'select', { code: '42703', message: 'column projects.is_forced_private does not exist' });
    expect((await store.loadPublic(PID))?.id).toBe(PID);
    db.failNext('projects', 'select', { code: '22P02', message: 'invalid uuid' });
    expect(await store.loadPublic('bad')).toBeNull();
  });

  it('loads the legacy state for its owner only', async () => {
    const { db, store } = setup();
    db.tables.projects.push({ id: PID, user_id: USER, name: 'Classic', state: { script: 'INT. MARKET' } });
    expect(await store.loadLegacyState(PID, USER)).toEqual({ name: 'Classic', state: { script: 'INT. MARKET' } });
    expect(await store.loadLegacyState(PID, OTHER)).toBeNull();
  });
});

describe('createMemoryDocStore', () => {
  it('round-trips, guards ownership and staleness, and models visibility', async () => {
    const store = createMemoryDocStore();
    await store.create({ projectId: PID, userId: USER, doc: docWith() });
    await expect(store.create({ projectId: PID, userId: USER, doc: docWith() })).rejects.toMatchObject({ status: 409 });
    const loaded = await store.load(PID, USER);
    expect(loaded?.brief.title).toBe('Spice Market');
    loaded!.brief.title = 'mutated';
    expect((await store.load(PID, USER))?.brief.title).toBe('Spice Market'); // copies, not references
    expect(await store.load(PID, OTHER)).toBeNull();

    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 5, brief: { title: 'Five', notes: [] } }), summary: { title: 'Five' } });
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 4 }), summary: { title: 'Four' } });
    expect((await store.load(PID, USER))?.brief.title).toBe('Five');
    expect(store.saveCount).toBe(1);
    expect(store.rows.get(PID)?.name).toBe('Five');
    await expect(store.save({ projectId: PID, userId: OTHER, doc: docWith({ rev: 9 }), summary: { title: 'x' } })).rejects.toMatchObject({
      code: 'FORBIDDEN'
    });
    await expect(store.save({ projectId: 'missing', userId: USER, doc: docWith(), summary: { title: 'x' } })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    });

    expect(await store.loadPublic(PID)).toBeNull();
    store.setVisibility(PID, { isPublic: true });
    expect((await store.loadPublic(PID))?.conversation).toEqual([]);
    store.setVisibility(PID, { forcedPrivate: true });
    expect(await store.loadPublic(PID)).toBeNull();

    store.seedLegacyProject({ projectId: 'legacy-1', userId: USER, name: 'Old comic', state: { script: 'x' } });
    expect(await store.loadLegacyState('legacy-1', USER)).toEqual({ name: 'Old comic', state: { script: 'x' } });
    expect(await store.loadLegacyState('legacy-1', OTHER)).toBeNull();
    expect(await store.load('legacy-1', USER)).toBeNull();
  });
});
