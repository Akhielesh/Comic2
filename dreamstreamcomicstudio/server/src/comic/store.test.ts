// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createEmptyDoc, type ComicDoc, type Page } from '../../../shared/comic/doc.js';
import { buildLegacyProjectState, createMemoryDocStore, createSupabaseDocStore, jsonbSafe, jsonbSafeText, sanitizePublicDoc } from './store.js';
import { StudioError } from './types.js';

const USER = 'user-a';
const OTHER = 'user-b';
const PID = '33333333-3333-4333-8333-333333333333';

type Row = Record<string, any>;
type PgErr = { code: string; message: string };

/**
 * What Postgres says about a written row (P2-GATE L5): jsonb (and text) reject `\u0000` — 22P05
 * "unsupported Unicode escape sequence" — and jsonb rejects an unpaired surrogate — 22P02. Checked on
 * the JSON the client would send, in every string and every object key.
 */
const pgRejects = (payload: unknown): PgErr | null => {
  let found: PgErr | null = null;
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const check = (s: string) => {
    if (found) return;
    if (s.includes('\u0000')) found = { code: '22P05', message: 'unsupported Unicode escape sequence' };
    else if (lone.test(s)) found = { code: '22P02', message: 'invalid input syntax for type json' };
  };
  const walk = (v: unknown) => {
    if (typeof v === 'string') return check(v);
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (check(k), walk(x));
  };
  walk(JSON.parse(JSON.stringify(payload ?? null)));
  return found;
};

/** A tiny PostgREST look-alike: enough of the builder API for store.ts. */
const makeDb = () => {
  const tables: Record<string, Row[]> = { projects: [], comic_docs: [], comic_publications: [] };
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
    not(col: string, op: string, value: unknown) {
      if (op !== 'is') throw new Error(`unsupported not.${op}`);
      this.filters.push((r) => (r[col] ?? null) !== value);
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
      if (this.op === 'insert' || this.op === 'update') {
        const rejected = pgRejects(this.payload);
        if (rejected) return { data: null, error: rejected };
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
    expect(clean.style.board).toBeUndefined();
    expect(clean.cast[0].refs).toEqual([]);
    expect(clean.places[0].refs).toEqual([]);
    expect(doc.conversation).toHaveLength(1); // input untouched
  });

  it('drops discarded render drafts, QC/model metadata and unchosen style tests from the public payload', () => {
    const draft = { path: 'u/a/discarded.webp', source: 'generated' as const, at: 1 };
    const current = { path: 'u/a/current.webp', source: 'generated' as const, at: 2 };
    const leaky = {
      status: 'ready' as const,
      asset: current,
      history: [draft],
      model: 'secret-image-model',
      costUsd: 0.42,
      error: 'last attempt failed with a private hint',
      qc: { score: 0.4, issues: ['private qc note'], checkedAt: 1 },
      specHash: 'abc'
    };
    const doc = docWith({
      style: {
        status: 'locked',
        refs: [],
        board: { path: 'u/a/board.webp', source: 'generated', at: 1 },
        options: [{ id: 'o1', name: 'Test look', spec: 'test', render: { status: 'ready', history: [draft], asset: draft } }]
      },
      cast: [{ id: 'c1', name: 'Maya', tier: 'lead', look: { summary: 's' }, refs: [], sheet: { ...leaky } }],
      places: [{ id: 'pl1', name: 'Market', look: 'busy', refs: [], sheet: { ...leaky } }],
      pages: [{ id: 'pg_1', n: 1, summary: 'Page 1', layout: 'one panel', panels: [], render: { ...leaky }, balloons: [] }],
      cover: { render: { ...leaky } }
    });
    const clean = sanitizePublicDoc(doc);

    // Unchosen style tests and the style board are gone.
    expect(clean.style.options).toEqual([]);
    expect(clean.style.board).toBeUndefined();

    // Model sheets never reach the public payload.
    for (const sheet of [clean.cast[0].sheet, clean.places[0].sheet]) {
      expect(sheet).toEqual({ status: 'none', history: [] });
    }

    // Every served render keeps only status + current asset — no history/qc/error/model.
    for (const render of [clean.pages[0].render, clean.cover.render]) {
      expect(render.history).toEqual([]);
      expect(render.asset?.path).toBe('u/a/current.webp');
      expect(render.qc).toBeUndefined();
      expect(render.error).toBeUndefined();
      expect(render.model).toBeUndefined();
      expect(render.costUsd).toBeUndefined();
      expect(render.specHash).toBeUndefined();
    }

    // Input is untouched.
    expect(doc.pages[0].render.history).toEqual([draft]);
    expect(doc.style.options).toHaveLength(1);
  });
  it('strips the version archive, trash, ref inbox and blanks private planning text (P0-SEC)', () => {
    const draft = { path: 'u/a/p/x/img/discarded.webp', source: 'generated' as const, at: 1 };
    const current = { path: 'u/a/p/x/img/current.webp', source: 'generated' as const, at: 2 };
    const doc = {
      ...docWith({
        brief: { title: 'Spice Market', logline: 'Two rivals, one recipe.', premise: 'secret premise', notes: ['private note'] },
        style: { status: 'locked', spec: 'SECRET STYLE SPEC', refs: [], options: [], board: { path: 'u/a/p/x/img/board.webp', source: 'generated', at: 1 } },
        cast: [
          {
            id: 'c1',
            name: 'Maya',
            tier: 'lead',
            look: { summary: 'SECRET LOOK', hair: 'red' },
            personality: 'SECRET PERSONALITY',
            voice: 'SECRET VOICE',
            refs: [],
            sheet: { status: 'ready', history: [draft], asset: { path: 'u/a/p/x/img/sheet.webp', source: 'generated', at: 1 } }
          }
        ],
        places: [{ id: 'pl1', name: 'Market', look: 'SECRET PLACE LOOK', refs: [], sheet: { status: 'ready', history: [], asset: { path: 'u/a/p/x/img/place.webp', source: 'generated', at: 1 } } }],
        pages: [
          {
            id: 'pg_1',
            n: 1,
            summary: 'SECRET SUMMARY',
            layout: 'one panel',
            panels: [{ id: 'pn1', n: 1, size: 'large', shot: 'wide', action: 'SECRET ACTION', castIds: ['c1'], lines: [{ id: 'l1', kind: 'speech', speakerId: 'c1', text: 'Hello!' }] }],
            render: { status: 'ready', asset: current, history: [draft] },
            balloons: []
          }
        ]
      }),
      archive: [{ id: 'v1', asset: draft }],
      trash: [{ page: { id: 'pg_old' } }],
      refInbox: [{ path: 'u/a/p/x/ref/photo.webp' }]
    } as unknown as ComicDoc;

    const clean = sanitizePublicDoc(doc);
    const json = JSON.stringify(clean);
    for (const secret of ['SECRET', 'discarded.webp', 'board.webp', 'sheet.webp', 'place.webp', '/ref/', 'private note', 'secret premise']) {
      expect(json).not.toContain(secret);
    }
    const loose = clean as unknown as Record<string, unknown>;
    expect(loose.archive).toBeUndefined();
    expect(loose.trash).toBeUndefined();
    expect(loose.refInbox).toBeUndefined();
    expect(clean.style.spec).toBe('');
    expect(clean.cast[0].look).toEqual({ summary: '' });
    expect(clean.pages[0].summary).toBe('');
    expect(clean.pages[0].panels[0].action).toBe('');
    // What the reader needs survives: title, logline, the current page asset and the dialogue.
    expect(clean.brief.title).toBe('Spice Market');
    expect(clean.brief.logline).toBe('Two rivals, one recipe.');
    expect(clean.pages[0].render.asset?.path).toBe('u/a/p/x/img/current.webp');
    expect(clean.pages[0].panels[0].lines[0].text).toBe('Hello!');
    expect(clean.cast[0].name).toBe('Maya');
    // Idempotent and non-mutating.
    expect(sanitizePublicDoc(clean)).toEqual(clean);
    expect(doc.style.spec).toBe('SECRET STYLE SPEC');
  });

  it('tolerates docs that predate optional fields', () => {
    const doc = docWith();
    delete (doc as Partial<ComicDoc>).places;
    delete (doc.cover as Partial<ComicDoc['cover']>).render;
    const clean = sanitizePublicDoc(doc);
    expect(clean.places).toEqual([]);
    expect(clean.cover.render).toEqual({ status: 'none', history: [] });
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
    // create() itself re-asserts is_public=false once (P0-SEC); count mirror writes after it.
    const afterCreate = db.calls.filter((c) => c.table === 'projects' && c.op === 'update').length;
    const projectUpdates = () => db.calls.filter((c) => c.table === 'projects' && c.op === 'update').length - afterCreate;
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

  // P2-GATE L5 (HIGH reliability): a str()-sanitized field can still carry \u0000 or half an emoji (a pasted
  // PDF script, a clipped brief). Postgres jsonb rejects both, and the bad character stays in the live doc —
  // so before this fix EVERY later save of the project failed and edits were lost on eviction.
  it('a NUL or a lone surrogate in a brief field never breaks this save or any later one', async () => {
    const { db, store } = setup({ mirrorIntervalMs: 0 });
    await store.create({ projectId: PID, userId: USER, doc: docWith() });
    const brief = { title: 'Moon\u0000 Fox \uD83E\uDD8A', logline: 'A fox\u0000 chases the moon \uD83C', premise: '\uDF19 night', notes: ['keep\u0000 it calm'] };
    const dirty = docWith({ rev: 1, brief });
    await expect(store.save({ projectId: PID, userId: USER, doc: dirty, summary: { title: brief.title, logline: brief.logline } })).resolves.toBeUndefined();
    const stored = db.tables.comic_docs[0];
    expect(stored.rev).toBe(1);
    expect(stored.doc.brief).toMatchObject({ title: 'Moon Fox \uD83E\uDD8A', logline: 'A fox chases the moon \uFFFD', premise: '\uFFFD night', notes: ['keep it calm'] });
    // The listing mirror (text name + jsonb state) is written too, cleaned the same way.
    expect(db.tables.projects[0].name).toBe('Moon Fox \uD83E\uDD8A');
    expect(db.tables.projects[0].state.overview).toBe('A fox chases the moon \uFFFD');
    // The live doc is not rewritten under the session (the caller's object is untouched)…
    expect(dirty.brief.logline).toBe('A fox\u0000 chases the moon \uD83C');
    // …and the NEXT save — the bad characters still in the live doc, plus a real edit — lands as well.
    const next = docWith({ rev: 2, brief: { ...brief, genre: 'fable' }, pages: [page(1, 'ready', 'u/a/p1\u0000.webp')] });
    await expect(store.save({ projectId: PID, userId: USER, doc: next, summary: { title: brief.title } })).resolves.toBeUndefined();
    expect(db.tables.comic_docs[0]).toMatchObject({ rev: 2, doc: { brief: { genre: 'fable' } } });
    expect(db.tables.comic_docs[0].doc.pages[0].render.asset.path).toBe('u/a/p1.webp');
  });

  it('a new comic whose title carries a NUL is created (both rows), not refused', async () => {
    const { db, store } = setup();
    await expect(store.create({ projectId: PID, userId: USER, doc: docWith({ brief: { title: 'Spice\u0000 Run \uD83C', notes: [] } }) })).resolves.toBeUndefined();
    expect(db.tables.projects[0].name).toBe('Spice Run \uFFFD');
    expect(db.tables.comic_docs[0].doc.brief.title).toBe('Spice Run \uFFFD');
  });

  it('a bad character another flow left in projects.state never fails the mirror', async () => {
    const { db, store } = setup({ mirrorIntervalMs: 0 });
    await store.create({ projectId: PID, userId: USER, doc: docWith() });
    db.tables.projects[0].state.legacyNote = 'old\u0000 note';
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 1, brief: { title: 'Renamed', notes: [] } }), summary: { title: 'Renamed' } });
    expect(db.tables.projects[0]).toMatchObject({ name: 'Renamed', state: { legacyNote: 'old note' } });
  });

  it('treats a failed mirror as non-fatal', async () => {
    const { db, store } = setup();
    await store.create({ projectId: PID, userId: USER, doc: docWith() });
    db.failNext('projects', 'update', { code: '57014', message: 'statement timeout' });
    await expect(store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 1, brief: { title: 'Z', notes: [] } }), summary: { title: 'Z' } })).resolves.toBeUndefined();
    expect(db.tables.comic_docs[0].rev).toBe(1);
  });

  it('never mirrors a live draft path into coverImageId while the row is public (P0-SEC)', async () => {
    const { db, store } = setup({ mirrorIntervalMs: 0 });
    await store.create({ projectId: PID, userId: USER, doc: docWith() });
    // Private: the live cover path mirrors for the owner's dashboard.
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 1, pages: [page(1, 'ready', 'u/a/p/x/img/p1.webp')] }), summary: { title: 'Spice Market' } });
    expect(db.tables.projects[0].state.coverImageId).toBe('u/a/p/x/img/p1.webp');

    // Public: the live path is removed (and the style spec blanked), never re-added.
    db.tables.projects[0].is_public = true;
    const styled = { status: 'locked' as const, spec: 'SECRET SPEC', refs: [], options: [] };
    await store.save({
      projectId: PID,
      userId: USER,
      doc: docWith({ rev: 2, style: styled, pages: [page(1, 'ready', 'u/a/p/x/img/p2.webp')] }),
      summary: { title: 'Spice Market', coverPath: 'u/a/p/x/img/cover.webp' }
    });
    const publicState = db.tables.projects[0].state;
    expect('coverImageId' in publicState).toBe(false);
    expect(publicState.stylePrompt).toBe('');
    expect(JSON.stringify(publicState)).not.toContain('u/a/p/x/img/');
    expect(publicState.studioVersion).toBe(4);

    // An opaque published cover written by the publish flow is kept.
    db.tables.projects[0].state.coverImageId = 'pub/abc/cover.webp';
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 3, pages: [page(1, 'ready', 'u/a/p/x/img/p3.webp')] }), summary: { title: 'Spice Market' } });
    expect(db.tables.projects[0].state.coverImageId).toBe('pub/abc/cover.webp');

    // Back to private: the live cover mirrors again.
    db.tables.projects[0].is_public = false;
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 4, pages: [page(1, 'ready', 'u/a/p/x/img/p4.webp')] }), summary: { title: 'Spice Market' } });
    expect(db.tables.projects[0].state.coverImageId).toBe('u/a/p/x/img/p4.webp');
  });

  it('a PUBLIC row keeps the published title and blurb; live edits stay private until republish (P1-PUBLISH)', async () => {
    const { db, store } = setup({ mirrorIntervalMs: 0 });
    await store.create({ projectId: PID, userId: USER, doc: docWith() });
    db.tables.projects[0].is_public = true;
    db.tables.projects[0].name = 'Published Title';
    db.tables.projects[0].state = { ...db.tables.projects[0].state, overview: 'Published blurb.' };
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 1 }), summary: { title: 'UNREVIEWED live rename', logline: 'UNREVIEWED live blurb' } });
    expect(db.tables.projects[0].name).toBe('Published Title');
    expect(db.tables.projects[0].state.overview).toBe('Published blurb.');
    expect(db.tables.projects[0].state.studioVersion).toBe(4);
    expect(JSON.stringify(db.tables.projects[0])).not.toContain('UNREVIEWED');
    // Private again (unpublished / unlisted): the owner's live text mirrors as before.
    db.tables.projects[0].is_public = false;
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 2 }), summary: { title: 'Live Title', logline: 'Live blurb' } });
    expect(db.tables.projects[0].name).toBe('Live Title');
    expect(db.tables.projects[0].state.overview).toBe('Live blurb');
  });

  it('writes the public-safe state when the row turns public between the read and the write', async () => {
    const { db, store } = setup({ mirrorIntervalMs: 0 });
    await store.create({ projectId: PID, userId: USER, doc: docWith() });
    // Flip the row public after the mirror's read, as its guarded (`is_public` not true) update is built.
    const realFrom = db.client.from.bind(db.client);
    let flips = 0;
    (db.client as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      const q = realFrom(table) as unknown as { not: (...a: unknown[]) => unknown };
      const originalNot = q.not.bind(q);
      q.not = (...args: unknown[]) => {
        if (table === 'projects' && args[0] === 'is_public') {
          flips += 1;
          db.tables.projects[0].is_public = true;
        }
        return originalNot(...args);
      };
      return q;
    };
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 1, pages: [page(1, 'ready', 'u/a/p/x/img/p1.webp')] }), summary: { title: 'Spice Market' } });
    expect(flips).toBe(1);
    expect(db.tables.projects[0].is_public).toBe(true);
    expect('coverImageId' in db.tables.projects[0].state).toBe(false);
    expect(db.tables.projects[0].state.studioVersion).toBe(4);
  });

  it('treats a NULL is_public as private for the mirror', async () => {
    const { db, store } = setup({ mirrorIntervalMs: 0 });
    db.tables.projects.push({ id: PID, user_id: USER, name: 'x', state: {}, is_public: null });
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 1, pages: [page(1, 'ready', 'u/a/p/x/img/p1.webp')] }), summary: { title: 'x' } });
    expect(db.tables.projects[0].state.coverImageId).toBe('u/a/p/x/img/p1.webp');
  });

  it('serves ONLY the frozen snapshot of a live, public, non-force-private publication (P1-PUBLISH)', async () => {
    const { db, store } = setup();
    await store.create({ projectId: PID, userId: USER, doc: docWith({ conversation: [{ id: 'm', role: 'user', text: 'hi', at: 1 }] }) });
    // A public listing row alone (no publication) never exposes the live doc.
    db.tables.projects[0].is_public = true;
    expect(await store.loadPublic(PID)).toBeNull();
    const snapshot = { ...createEmptyDoc('pub-1', 'Spice Market', 5), conversation: [] };
    db.tables.comic_publications.push({ project_id: PID, user_id: USER, status: 'live', visibility: 'unlisted', snapshot });
    // Unlisted is reachable by slug only, never by project id.
    expect(await store.loadPublic(PID)).toBeNull();
    db.tables.comic_publications[0].visibility = 'public';
    const doc = await store.loadPublic(PID);
    expect(doc?.id).toBe('pub-1');
    expect(doc?.id).not.toBe(PID);
    expect(doc?.conversation).toEqual([]);
    db.tables.projects[0].is_forced_private = true;
    expect(await store.loadPublic(PID)).toBeNull();
    db.tables.projects[0].is_forced_private = false;
    db.tables.comic_publications[0].status = 'suspended';
    expect(await store.loadPublic(PID)).toBeNull();
    db.tables.comic_publications[0].status = 'live';
    // Databases without the moderation columns fall back to the publication alone.
    db.failNext('projects', 'select', { code: '42703', message: 'column projects.is_forced_private does not exist' });
    expect((await store.loadPublic(PID))?.id).toBe('pub-1');
    // Any other moderation lookup error fails closed.
    db.failNext('projects', 'select', { code: 'XX000', message: 'boom' });
    expect(await store.loadPublic(PID)).toBeNull();
    // An unmigrated database (no publications table) and bad ids serve nothing.
    db.failNext('comic_publications', 'select', { code: '42P01', message: 'relation does not exist' });
    expect(await store.loadPublic(PID)).toBeNull();
    db.failNext('comic_publications', 'select', { code: '22P02', message: 'invalid uuid' });
    expect(await store.loadPublic('bad')).toBeNull();
  });

  it('re-asserts the live share slug in the listing mirror (P1-PUBLISH)', () => {
    const live = docWith({ publication: { visibility: 'unlisted', status: 'live', slug: 'Ab3dEf6hIj9kLm2nP', publishedRev: 3, publishedAt: 9, languages: ['en'] } });
    expect(buildLegacyProjectState(live).shareSlug).toBe('Ab3dEf6hIj9kLm2nP');
    expect(buildLegacyProjectState(docWith()).shareSlug).toBeUndefined();
    const suspended = docWith({ publication: { visibility: 'public', status: 'suspended', slug: 'Ab3dEf6hIj9kLm2nP', publishedRev: 3, publishedAt: 9, languages: ['en'] } });
    expect(buildLegacyProjectState(suspended).shareSlug).toBeUndefined();
  });

  it('loads the legacy state for its owner only', async () => {
    const { db, store } = setup();
    db.tables.projects.push({ id: PID, user_id: USER, name: 'Classic', state: { script: 'INT. MARKET' } });
    expect(await store.loadLegacyState(PID, USER)).toEqual({ name: 'Classic', state: { script: 'INT. MARKET' } });
    expect(await store.loadLegacyState(PID, OTHER)).toBeNull();
  });
});

describe('jsonbSafe (P2-GATE L5)', () => {
  it('removes NULs and turns lone surrogates into U+FFFD, keeping every valid pair', () => {
    expect(jsonbSafeText('a\u0000b')).toBe('ab');
    expect(jsonbSafeText('x \uD83D')).toBe('x \uFFFD'); // a high surrogate cut off at the end
    expect(jsonbSafeText('\uDE00 y')).toBe('\uFFFD y'); // a low surrogate with no high one
    expect(jsonbSafeText('\uDE00\uD83D')).toBe('\uFFFD\uFFFD'); // reversed pair = two lone halves
    expect(jsonbSafeText('fox \uD83E\uDD8A తెలుగు नमस्ते')).toBe('fox \uD83E\uDD8A తెలుగు नमस्ते');
    expect(jsonbSafeText('\u0000')).toBe('');
  });

  it('cleans every string and object key, deep; a clean value comes back as the same reference', () => {
    const clean = { a: ['x', { b: 'y' }], n: 1, t: true, z: null };
    expect(jsonbSafe(clean)).toBe(clean);
    const dirty = { ok: 'fine', 'k\u0000ey': 'v', list: ['p', 'q\u0000', { deep: ['\uD800'] }], same: { s: 't' }, n: 2 };
    const out = jsonbSafe(dirty);
    expect(out).toEqual({ ok: 'fine', key: 'v', list: ['p', 'q', { deep: ['\uFFFD'] }], same: { s: 't' }, n: 2 });
    expect(Object.keys(out)).toEqual(['ok', 'key', 'list', 'same', 'n']); // order kept
    expect(out.same).toBe(dirty.same); // untouched branches are shared, not copied
    expect(dirty.list[1]).toBe('q\u0000'); // the input is never mutated
    expect(pgRejects(out)).toBeNull();
    expect(pgRejects(dirty)).toMatchObject({ code: '22P05' });
  });

  it('a whole comic doc with bad characters in many places passes the database check', () => {
    const doc = docWith({
      brief: { title: 'T\u0000', logline: 'L \uD83C', notes: ['n\u0000'] },
      pages: [{ ...page(1, 'ready', 'u/a/p1.webp'), summary: 'S\uDC00', panels: [{ id: 'pn', n: 1, size: 'wide', shot: 'medium', action: 'A\u0000', castIds: [], lines: [{ id: 'l1', kind: 'speech', text: 'Hi\u0000 \uD83D' }] }] }]
    });
    expect(pgRejects(doc)).not.toBeNull();
    expect(pgRejects(jsonbSafe(doc))).toBeNull();
    expect(jsonbSafe(doc).pages[0].panels[0].lines[0].text).toBe('Hi \uFFFD');
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

describe('createMemoryDocStore mirror (P0-SEC)', () => {
  it('never exposes a live cover path in the listing state while public', async () => {
    const store = createMemoryDocStore();
    await store.create({ projectId: PID, userId: USER, doc: docWith() });
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 1, pages: [page(1, 'ready', 'u/a/p/x/img/p1.webp')] }), summary: { title: 'x' } });
    expect(store.rows.get(PID)?.state.coverImageId).toBe('u/a/p/x/img/p1.webp');
    store.setVisibility(PID, { isPublic: true });
    await store.save({ projectId: PID, userId: USER, doc: docWith({ rev: 2, pages: [page(1, 'ready', 'u/a/p/x/img/p2.webp')] }), summary: { title: 'x', coverPath: 'u/a/p/x/img/c.webp' } });
    expect('coverImageId' in (store.rows.get(PID)?.state || {})).toBe(false);
  });
});

describe('buildLegacyProjectState for a public row', () => {
  it('omits the live cover path and the style spec', () => {
    const doc = docWith({
      style: { status: 'locked', spec: 'SECRET', refs: [], options: [] },
      pages: [page(1, 'ready', 'u/a/p/x/img/p1.webp')]
    });
    const state = buildLegacyProjectState(doc, { isPublic: true });
    expect('coverImageId' in state).toBe(false);
    expect(state.stylePrompt).toBe('');
    expect(buildLegacyProjectState(doc).coverImageId).toBe('u/a/p/x/img/p1.webp');
  });
});

describe('sanitizePublicDoc: key-path allow-list (P0-SEC verification)', () => {
  /** A doc with every private field populated, including the newer contract fields. */
  const fullDoc = (): ComicDoc => {
    const asset = (path: string) => ({
      path,
      w: 1024,
      h: 1536,
      source: 'generated' as const,
      at: 1,
      model: 'secret-model',
      variants: [{ path: `${path}.480.webp`, w: 480, h: 720 }],
      safety: { status: 'flag', categories: ['violence'] },
      libraryId: 'lib.secret',
      derivedFrom: 'u/x/p/y/img/DRAFT-SOURCE.webp'
    }) as any;
    const render = (path: string) => ({
      status: 'ready' as const,
      asset: asset(path),
      history: [{ ...asset(`${path}.old`), note: 'SECRET-NOTE' }],
      model: 'secret-model',
      qc: { ok: false, issues: ['SECRET-QC'] },
      note: 'SECRET-NOTE',
      parentPath: 'u/x/p/y/img/PARENT.webp',
      refPaths: ['u/x/p/y/ref/PHOTO.webp']
    }) as any;
    const doc = createEmptyDoc(PID, 'Title');
    return {
      ...doc,
      brief: { title: 'Title', logline: 'Logline', premise: 'SECRET-PREMISE', notes: ['SECRET-NOTE'] },
      source: { script: 'SECRET-SCRIPT' },
      style: { status: 'locked', name: 'Ink', spec: 'SECRET-SPEC', refs: [{ id: 'r', path: 'u/x/p/y/ref/STYLE.webp' }] as any, board: asset('u/x/p/y/img/BOARD.webp'), options: [{ id: 'o', name: 'n', spec: 'SECRET-SPEC', render: render('u/x/p/y/img/OPTION.webp') }] as any },
      cast: [{ id: 'c', name: 'Maya', tier: 'lead', look: { summary: 'SECRET-LOOK', face: 'SECRET-LOOK' }, personality: 'SECRET-PERSONALITY', voice: 'SECRET-VOICE', refs: [{ id: 'r', path: 'u/x/p/y/ref/FACE.webp' }], sheet: render('u/x/p/y/img/SHEET.webp') }] as any,
      places: [{ id: 'pl', name: 'Town', look: 'SECRET-LOOK', refs: [], sheet: render('u/x/p/y/img/PLACE.webp') }] as any,
      pages: [{ id: 'pg', n: 1, summary: 'SECRET-SUMMARY', layout: 'Row 1', turnHook: 'SECRET-HOOK', panels: [{ id: 'pn', n: 1, size: 'wide', shot: 'wide', action: 'SECRET-ACTION', castIds: [], lines: [{ id: 'l', kind: 'speech', text: 'Hi' }] }], render: render('u/x/p/y/img/PAGE.webp'), balloons: [] }] as any,
      cover: { title: 'Title', direction: 'SECRET-DIRECTION', render: render('u/x/p/y/img/COVER.webp') },
      conversation: [{ id: 'm', role: 'user', text: 'SECRET-CHAT' }] as any,
      memory: 'SECRET-MEMORY',
      archive: [{ ...asset('u/x/p/y/img/ARCHIVED.webp'), targetKey: 'page:pg', label: 'Page 1', archivedAt: 1 }] as any,
      trash: [{ page: { id: 'gone', summary: 'SECRET-SUMMARY' }, fromN: 2, deletedAt: 1 }] as any,
      refInbox: [{ id: 'ri', path: 'u/x/p/y/ref/INBOX.webp' }] as any,
      safety: { publish: { ok: false, rating: 'pg13', rev: 1, at: 1, blockers: [{ status: 'block', categories: ['x'], note: 'SECRET-SAFETY' }] } } as any,
      publication: { visibility: 'unlisted', status: 'live', slug: 'SECRETSLUG0000000000', publishedRev: 1, publishedAt: 1, languages: [] } as any,
      planInputHash: 'SECRET-HASH',
      i18n: {
        editions: { es: { lang: 'es', lines: { l: { text: 'Hola', status: 'machine', sourceHash: 'h', gloss: 'SECRET-GLOSS', issue: { severity: 'major', note: 'SECRET-ISSUE' }, model: 'secret-model', at: 1 } }, balloons: {}, register: 'neutral' } },
        glossary: [{ id: 'g', term: 'Maya', kind: 'character', policy: 'keep', forms: {}, note: 'SECRET-GLOSSARY' }]
      } as any,
      settings: { ...doc.settings, budgetUsd: 99, imageModelOverride: 'secret-model' },
      spend: { totalUsd: 3, byKind: {}, entries: [{ id: 's', at: 1, kind: 'page', label: 'SECRET-SPEND', usd: 1, byok: false, estimated: false }] } as any,
      gate: { id: 'g', kind: 'spend', title: 'SECRET-GATE' } as any
    };
  };

  it('leaves no private text, model, safety verdict or non-published path anywhere', () => {
    const json = JSON.stringify(sanitizePublicDoc(fullDoc()));
    expect(json).not.toMatch(/SECRET|secret-model|DRAFT-SOURCE|PARENT|PHOTO|STYLE\.webp|FACE|BOARD|OPTION|SHEET|PLACE\.webp|ARCHIVED|INBOX|\.old|lib\.secret|"safety"|"publication"|planInputHash|"glossary":\[\{/);
  });

  it('every image path left is a current page/cover image or its downscale', () => {
    const paths: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (typeof x === 'string' && (k === 'path' || x.startsWith('u/'))) paths.push(x);
          walk(x);
        }
      }
    };
    walk(sanitizePublicDoc(fullDoc()));
    expect(paths.sort()).toEqual([
      'u/x/p/y/img/COVER.webp',
      'u/x/p/y/img/COVER.webp.480.webp',
      'u/x/p/y/img/PAGE.webp',
      'u/x/p/y/img/PAGE.webp.480.webp'
    ]);
  });

  it('keeps reader content (title, logline, dialogue, translations) and is idempotent', () => {
    const once = sanitizePublicDoc(fullDoc());
    expect(once.brief.title).toBe('Title');
    expect(once.brief.logline).toBe('Logline');
    expect(once.pages[0].panels[0].lines[0].text).toBe('Hi');
    expect((once.i18n as any).editions.es.lines.l.text).toBe('Hola');
    expect(sanitizePublicDoc(once)).toEqual(once);
  });
});

describe('create re-asserts private once the comic is v4 (P0-SEC verification)', () => {
  it('a listing row flipped public between the two inserts ends up private', async () => {
    const db = makeDb();
    const store = createSupabaseDocStore({ admin: () => db.client, now: () => 10_000 });
    const realFrom = (db.client as any).from.bind(db.client);
    // Simulate the owner's PostgREST update landing right after the projects insert.
    (db.client as any).from = (table: string) => {
      if (table === 'comic_docs' && db.tables.projects[0]) db.tables.projects[0].is_public = true;
      return realFrom(table);
    };
    await store.create({ projectId: PID, userId: USER, doc: createEmptyDoc(PID, 'Race') });
    expect(db.tables.projects[0].is_public).toBe(false);
  });
});
