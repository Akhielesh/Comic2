// Comic History H2 — the recorder (versions plan §4.1–§4.4, §14 H2) on H1's in-memory store (store.fake.ts).
//
// Every test drives the recorder exactly as StudioSession does (onLoad after hydrate, onCommit with before/next/ops/
// origin per commit, awaited onFlush), with docs built by the real applyOps and an injected clock: no Date.now in the
// rules, no timers anywhere.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeDoc, type ComicDoc, type SpendEntry } from '../../../../shared/comic/doc.js';
import type { OpsOrigin } from '../../../../shared/comic/events.js';
import { applyOps, type DocOp } from '../../../../shared/comic/ops.js';
import { historyV4Doc } from '../../../../shared/comic/history/__fixtures__/books.js';
import { plannedDoc } from '../orchestrator.fakes.js';
import { StudioError } from '../types.js';
import { chunkBook } from './hash.js';
import { historyStoreError } from './store.js';
import { HISTORY_PENDING_MAX, HISTORY_POLICY, classifyBatch, spendOf } from './policy.js';
import { createHistoryRecorder, withHistoryAction, type HistoryEvent, type HistoryRecorder } from './recorder.js';
import { createFakeHistoryStore, type FakeHistoryStore } from './store.fake.js';
import type { HistoryStore } from './storeTypes.js';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const scope = { projectId: 'proj-1', userId: 'user-1' };
const IMG = 'u/user-1/p/proj-1/img';

const spend = (id: string, usd: number, extra: Partial<SpendEntry> = {}): SpendEntry => ({ id, at: T0, kind: 'page', label: id, usd, byok: false, estimated: false, ...extra });
const drawn = (pageId: string, file: string, origin: 'render' | 'edit' | 'derived' = 'render', model = 'nano-banana-2.1'): DocOp => ({
  op: 'render',
  target: { kind: 'page', id: pageId },
  patch: { status: 'ready', asset: { path: `${IMG}/${file}`, source: origin === 'derived' ? 'derived' : 'generated', model, at: T0 }, origin }
});
const queued = (pageId: string): DocOp => ({ op: 'render', target: { kind: 'page', id: pageId }, patch: { status: 'queued' } });
const say = (pageId: string, text: string, n = Number(pageId.slice(3))): DocOp => ({ op: 'line', pageId, panelId: `pn_${n}_2`, id: `ln_${n}_2`, patch: { text } });

interface Rig {
  store: FakeHistoryStore;
  rec: HistoryRecorder;
  events: HistoryEvent[];
  notices: string[];
  clock: { t: number };
  doc(): ComicDoc;
  /** One StudioSession.commit: applyOps, rev + 1, updatedAt = now, then onCommit (inside the action, when one; with
   *  the commit's undo label, when one). */
  commit(ops: DocOp[], origin?: OpsOrigin, action?: Record<string, unknown>, label?: string): ComicDoc;
  flush(final?: boolean): Promise<void>;
  /** Rows oldest first. */
  rows(): ReturnType<FakeHistoryStore['rows']>;
  puts(): number;
}

const rig = (start: ComicDoc = plannedDoc(), opts: { store?: (fake: FakeHistoryStore) => HistoryStore; startAt?: number } = {}): Rig => {
  const clock = { t: opts.startAt ?? T0 };
  const now = () => clock.t;
  const store = createFakeHistoryStore({ now });
  const events: HistoryEvent[] = [];
  const notices: string[] = [];
  const rec = createHistoryRecorder(scope, {
    store: opts.store ? opts.store(store) : store,
    now,
    sink: { emit: (e) => void events.push(e), notice: (t) => void notices.push(t) }
  });
  let doc: ComicDoc = { ...start, updatedAt: clock.t };
  return {
    store,
    rec,
    events,
    notices,
    clock,
    doc: () => doc,
    commit(ops, origin, action, label) {
      const before = doc;
      const at = clock.t;
      const next = { ...applyOps(before, ops, at), rev: before.rev + 1, updatedAt: at };
      doc = next;
      const call = () => rec.onCommit(before, next, ops, origin, label);
      if (action) withHistoryAction(action, call);
      else call();
      return next;
    },
    async flush(final = false) {
      await rec.onFlush(doc, { final });
    },
    rows: () => store.rows(scope).reverse(),
    puts: () => store.calls.filter((c) => c.method === 'put').length
  };
};

/** A rig whose comic already has its start row (the usual case after deploy). */
const loaded = async (start?: ComicDoc, opts?: Parameters<typeof rig>[1]): Promise<Rig> => {
  const r = rig(start, opts);
  await r.rec.onLoad(r.doc());
  return r;
};

/** What H3 writes around a restore, straight to the store: the awaited before_restore row, then its restore row. */
const putRow = async (r: Rig, kind: 'before_restore' | 'restore', doc: ComicDoc) => {
  const book = chunkBook(doc);
  const label = kind === 'restore' ? 'Restored an earlier version' : 'Before restoring';
  return r.store.put(scope, { kind, actor: 'you', label, rev: doc.rev, contentAt: r.clock.t, manifest: book.manifest, rootHash: book.rootHash, chunks: book.hashes }, book.chunks);
};
/** A whole-book history_restore op back to `doc`'s pages (what H3 commits). */
const restoreTo = (doc: ComicDoc, at: number): DocOp => ({ op: 'history_restore', set: { pages: doc.pages }, mode: 'merge', versionId: 'v', at }) as DocOp;
const published = (rev: number, at: number) => ({ visibility: 'unlisted' as const, status: 'live' as const, publishedRev: rev, publishedAt: at, languages: ['en'] });

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('classification (§4.2)', () => {
  const doc = plannedDoc();
  const actorsOf = (ops: DocOp[], origin?: OpsOrigin, action?: string, label?: string) =>
    classifyBatch(ops, origin, doc, { ...applyOps(doc, ops, T0), updatedAt: T0 }, action, label);

  it('you, the AI, the editor; forward-only records are nobody', () => {
    expect(actorsOf([say('pg_1', 'Hi')], 'user').actor).toBe('you');
    expect(actorsOf([say('pg_1', 'Hi')], 'director').actor).toBe('ai');
    expect(actorsOf([drawn('pg_1', 'a.webp')], 'job')).toMatchObject({ actor: 'ai', ai: true, pageIds: ['pg_1'] });
    expect(actorsOf([{ op: 'translations', lang: 'te', lines: {} }], 'job').actor).toBe(null); // touches no section without an edition
    expect(actorsOf([{ op: 'image_model', lock: { modelId: 'm', lockedAt: 1, origin: 'user_change' } }], 'user')).toMatchObject({ actor: 'ai', model: true });
    expect(actorsOf([{ op: 'balloons', pageId: 'pg_1', balloons: [] }], 'job').actor).toBe('editor');
    for (const op of [
      { op: 'message', msg: { id: 'm', role: 'assistant', text: 'hi', at: 1 } },
      { op: 'spend', entry: spend('s', 1) },
      { op: 'gate', gate: null },
      { op: 'memory', text: 'likes teal' },
      { op: 'asset_meta', path: `${IMG}/a.webp`, patch: { variants: null } },
      { op: 'safety', patch: {} },
      { op: 'settings', patch: { quality: 'standard' } }
    ] as DocOp[]) {
      expect(actorsOf([op], 'user').actor, op.op).toBe(null);
    }
  });

  it('fit_render (a fitted image) and relayout_balloons are the editor’s whoever asked; K2a actions reach opActor', () => {
    const fit = [drawn('pg_1', 'fit.webp', 'derived'), { op: 'balloons', pageId: 'pg_1', balloons: [] } as DocOp, { op: 'spend', entry: spend('fit', 0, { savedUsd: 0.05 }) } as DocOp];
    expect(actorsOf(fit, 'user')).toMatchObject({ actor: 'editor', ai: false, you: false });
    expect(actorsOf(fit, 'director')).toMatchObject({ actor: 'editor', ai: false });
    expect(actorsOf([{ op: 'balloons', pageId: 'pg_1', balloons: [] }], 'user', 'relayout_balloons').actor).toBe('editor');
    expect(actorsOf([{ op: 'panels_order', pageId: 'pg_2', order: ['pn_2_2', 'pn_2_1', 'pn_2_3'] }], 'user', 'rebind_panels').actor).toBe('editor');
    expect(actorsOf([drawn('pg_1', 'fix.webp', 'edit')], 'user', 'fix_panel').actor).toBe('ai');
  });

  it('"Plan the pages" is the AI’s whoever clicked it: by its action, or by the writer’s commit label until jobs.ts names it', () => {
    const pages = doc.pages.map((p) => ({ ...p, summary: 'Rewritten' }));
    const cast: DocOp = { op: 'character', id: 'c_arjun', patch: { name: 'Arjun the vendor' } } as DocOp;
    // Pages you edit yourself (no paid action, no writer label) stay yours.
    expect(actorsOf([{ op: 'pages', pages }], 'user').actor).toBe('you');
    expect(actorsOf([{ op: 'pages', pages }, { op: 'plan_status', status: 'draft' }], 'user', 'plan_pages')).toMatchObject({ actor: 'ai', ai: true, you: false, edit: false });
    for (const label of ['Plan pages', 'Revise pages']) {
      expect(actorsOf([{ op: 'pages', pages }, { op: 'plan_status', status: 'draft' }], 'user', undefined, label), label).toMatchObject({ actor: 'ai', ai: true, you: false });
    }
    expect(actorsOf([cast], 'user', undefined, 'Add cast')).toMatchObject({ actor: 'ai', ai: true });
    // A writer label on a batch without the writer's pages or cast names nothing.
    expect(actorsOf([say('pg_1', 'mine')], 'user', undefined, 'Plan pages').actor).toBe('you');
    expect(actorsOf([cast], 'user', undefined, 'Rename').actor).toBe('you');
  });
});

describe('AI runs (§4.3 #1–2)', () => {
  it('three render commits in one run give exactly one before_ai + ai pair, with the parent, the words and the spend', async () => {
    const r = await loaded();
    r.clock.t += MIN;
    r.commit([say('pg_2', 'Hold the tin!')], 'user');
    r.clock.t += MIN;
    r.commit([queued('pg_1'), queued('pg_2'), queued('pg_3')], 'job');
    for (const n of [1, 2, 3]) {
      r.clock.t += 2 * MIN;
      r.commit([drawn(`pg_${n}`, `p${n}.webp`), { op: 'spend', entry: spend(`sp_${n}`, 0.0575) }], 'job');
    }
    await r.flush();
    const rows = r.rows();
    expect(rows.map((x) => x.kind)).toEqual(['start', 'before_ai', 'ai']);
    const [, before, ai] = rows;
    expect(before).toMatchObject({ label: 'Before the AI drew pages 1–3', actor: 'system', pinned: false });
    // The before_ai row holds your edit (made before the run) and is dated when it was made: the queued statuses
    // after it are the system's (a render's status is no change to the book).
    expect(before.changes).toEqual([expect.objectContaining({ what: 'dialogue', by: 'you', pageIds: ['pg_2'] })]);
    expect(before.contentAt).toBe(T0 + MIN);
    expect(ai).toMatchObject({ kind: 'ai', actor: 'ai', label: 'AI drew pages 1–3', parentId: before.id });
    expect(ai.stats.spend).toEqual({ usd: 0.1725, byok: false, estimated: false });
    expect(ai.stats).toMatchObject({ pages: 3, drawn: 3, models: ['nano-banana-2.1'] });
    expect(ai.thumbs.map((t) => t.key)).toEqual(['page:pg_1', 'page:pg_2', 'page:pg_3']);
    // The live event carried each new row, "Original" as null.
    expect(r.events.map((e) => [e.version.kind, e.version.alternativeId])).toEqual([['start', null], ['before_ai', null], ['ai', null]]);
    expect(r.events[2].version).toMatchObject({ id: ai.id, parentId: before.id, label: 'AI drew pages 1–3' });
  });

  it('a commit of yours closes the run; the next AI commit starts a new run with its own before_ai', async () => {
    const r = await loaded();
    r.clock.t += MIN;
    r.commit([say('pg_3', 'Mine first')], 'user');
    r.clock.t += MIN;
    r.commit([drawn('pg_1', 'p1.webp')], 'job');
    r.clock.t += MIN;
    r.commit([say('pg_2', 'Now me')], 'user'); // closes run 1
    r.clock.t += MIN;
    r.commit([drawn('pg_2', 'p2.webp')], 'job');
    await r.flush();
    const rows = r.rows();
    expect(rows.map((x) => x.kind)).toEqual(['start', 'before_ai', 'ai', 'before_ai', 'ai']);
    expect(rows[2]).toMatchObject({ label: 'AI drew page 1', parentId: rows[1].id });
    expect(rows[3].changes).toEqual([expect.objectContaining({ what: 'dialogue', by: 'you', pageIds: ['pg_2'] })]);
    expect(rows[3].label).toBe('Before the AI drew page 2');
    expect(rows[4]).toMatchObject({ label: 'AI drew page 2', parentId: rows[3].id });
  });

  it('AI commits more than aiRunGapMinutes apart are two runs; the second run’s parent is the first run’s ai row', async () => {
    const r = await loaded();
    r.clock.t += MIN;
    r.commit([say('pg_1', 'x')], 'user');
    r.clock.t += MIN;
    r.commit([drawn('pg_1', 'p1.webp')], 'job');
    r.clock.t += HISTORY_POLICY.aiRunGapMs + MIN;
    r.commit([drawn('pg_2', 'p2.webp')], 'job');
    await r.flush();
    const rows = r.rows();
    expect(rows.map((x) => x.kind)).toEqual(['start', 'before_ai', 'ai', 'ai']);
    expect(rows[3].parentId).toBe(rows[2].id); // the book before run 2 IS run 1's result: no duplicate row
  });

  it('a translation run and an image-model switch each get a before_ai', async () => {
    const doc = plannedDoc();
    doc.i18n = { editions: { te: { lang: 'te', lines: {}, balloons: {}, register: 'everyday' } }, glossary: [] } as never;
    const r = await loaded(normalizeDoc(doc));
    r.clock.t += MIN;
    r.commit([say('pg_1', 'Run!')], 'user');
    r.clock.t += MIN;
    const tr = (id: string, text: string) => ({ text, status: 'machine' as const, sourceHash: 'h', at: r.clock.t });
    r.commit([{ op: 'translations', lang: 'te', lines: { ln_1_2: tr('ln_1_2', 'పరుగు!'), ln_2_2: tr('ln_2_2', 'రెండు') } }], 'job');
    r.clock.t += MIN;
    r.commit([{ op: 'translations', lang: 'te', lines: { ln_3_2: tr('ln_3_2', 'మూడు') } }, { op: 'spend', entry: spend('tr', 0.01, { kind: 'translate' }) }], 'job');
    await r.flush();
    let rows = r.rows();
    expect(rows.map((x) => x.kind)).toEqual(['start', 'before_ai', 'ai']);
    expect(rows[1].label).toBe('Before the AI updated the Telugu edition'); // the run's size is not known yet
    expect(rows[2]).toMatchObject({ label: 'AI translated 3 lines to Telugu', parentId: rows[1].id, stats: { langs: ['te'], spend: { usd: 0.01 } } });

    // The model switch (the lock is not a section, yet it is an AI change), then the redraw it was for.
    r.clock.t += MIN;
    r.commit([say('pg_2', 'Edit before the switch')], 'user');
    r.clock.t += MIN;
    r.commit([{ op: 'image_model', lock: { modelId: 'nano-banana-pro', lockedAt: r.clock.t, origin: 'user_change' } }, { op: 'message', msg: { id: 'm2', role: 'assistant', text: 'Switched.', at: r.clock.t } }], 'user');
    r.clock.t += MIN;
    r.commit([queued('pg_1')], 'job');
    r.clock.t += MIN;
    r.commit([drawn('pg_1', 'p1-pro.webp', 'render', 'nano-banana-pro')], 'job');
    await r.flush();
    rows = r.rows();
    expect(rows.map((x) => x.kind)).toEqual(['start', 'before_ai', 'ai', 'before_ai', 'ai']);
    expect(rows[3].label).toBe('Before switching the image model');
    expect(rows[4]).toMatchObject({ label: 'Switched the image model and redrew page 1', parentId: rows[3].id, modelId: 'nano-banana-pro' });
  });

  it('fit_render and relayout_balloons are the editor’s and never start an AI run', async () => {
    const start = plannedDoc();
    const r = await loaded(normalizeDoc({ ...start, pages: start.pages.map((p) => ({ ...p, render: { ...p.render, status: 'ready', asset: { path: `${IMG}/${p.id}.webp`, source: 'generated', at: 1 } } })) }));
    const fit = (origin: OpsOrigin) =>
      r.commit([drawn('pg_1', `fit-${origin}.webp`, 'derived'), { op: 'balloons', pageId: 'pg_1', balloons: [{ lineId: 'ln_1_2', x: 0.2, y: 0.2, w: 0.3 }] }, { op: 'spend', entry: spend(`fit-${origin}`, 0) }], origin);
    r.clock.t += MIN;
    fit('user');
    r.clock.t += MIN;
    fit('director');
    r.clock.t += MIN;
    // relayout_balloons letters the page from a job; as a UI click the action names it too.
    r.commit([{ op: 'balloons', pageId: 'pg_2', balloons: [{ lineId: 'ln_2_2', x: 0.6, y: 0.1, w: 0.3 }] }], 'job');
    r.commit([{ op: 'balloons', pageId: 'pg_3', balloons: [{ lineId: 'ln_3_2', x: 0.6, y: 0.1, w: 0.3 }] }], 'user', { type: 'relayout_balloons', pageId: 'pg_3' });
    await r.flush(); // three pages touched: quiet editing is due
    const rows = r.rows();
    expect(rows.map((x) => x.kind)).toEqual(['start', 'edits']);
    expect(rows[1]).toMatchObject({ actor: 'editor', label: 'The editor changed the art on pages 1–3, no AI cost' });
    expect(rows[1].changes.every((c) => c.by === 'editor')).toBe(true);
  });

  it('"Plan the pages" clicked in the UI writes before_ai + ai with the writer’s spend (by its action, or its label)', async () => {
    for (const how of ['action', 'label'] as const) {
      const r = await loaded();
      r.clock.t += MIN;
      r.commit([say('pg_1', 'my own words')], 'user');
      r.clock.t += MIN;
      // planPages records the writer's spend first, then commits its pages with the click's origin ('user').
      r.commit([{ op: 'spend', entry: spend('writer', 0.01, { kind: 'plan' }) }], 'job');
      const pages = r.doc().pages.map((p) => ({ ...p, summary: `Rewritten by the writer ${p.n}` }));
      const ops: DocOp[] = [{ op: 'pages', pages }, { op: 'plan_status', status: 'draft' }];
      if (how === 'action') r.commit(ops, 'user', { type: 'plan_pages' });
      else r.commit(ops, 'user', undefined, 'Plan pages');
      await r.flush();
      const rows = r.rows();
      expect(rows.map((x) => x.kind), how).toEqual(['start', 'before_ai', 'ai']);
      const [, before, ai] = rows;
      // Your words written before the click are kept apart from the AI's rewrite.
      expect(before.changes).toEqual([expect.objectContaining({ what: 'dialogue', by: 'you', pageIds: ['pg_1'] })]);
      expect(ai.label.startsWith('AI '), ai.label).toBe(true);
      expect(ai).toMatchObject({ actor: 'ai', parentId: before.id, stats: { spend: { usd: 0.01, byok: false, estimated: false } } });
      expect(ai.changes.length).toBeGreaterThan(0);
      expect(ai.changes.every((c) => c.by === 'ai')).toBe(true);
    }
  });

  it('a paid run never waits for its before_ai write: onCommit returns at once while the put is still pending', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const r = await loaded(undefined, {
      store: (fake) => ({
        ...fake,
        async put(s, v, c, p) {
          order.push(`put:${v.kind}`);
          if (v.kind === 'before_ai') await gate;
          return fake.put(s, v, c, p);
        }
      })
    });
    r.clock.t += MIN;
    r.commit([say('pg_1', 'x')], 'user');
    r.clock.t += MIN;
    const before = r.doc();
    const ops = [drawn('pg_1', 'p1.webp')];
    const next = { ...applyOps(before, ops, r.clock.t), rev: before.rev + 1, updatedAt: r.clock.t };
    const out: unknown = r.rec.onCommit(before, next, ops, 'job', undefined);
    expect(out).toBeUndefined(); // synchronous: nothing for the run to await
    order.push('run:continues');
    for (let i = 0; i < 50 && !order.includes('put:before_ai'); i += 1) await Promise.resolve();
    order.push('run:next-image');
    // The write started right away (not awaited by the run) and is still pending while the run goes on.
    expect(order).toEqual(['put:start', 'run:continues', 'put:before_ai', 'run:next-image']);
    expect(r.rows().map((x) => x.kind)).toEqual(['start']); // still waiting
    release();
    await r.rec.settled();
    expect(r.rows().map((x) => x.kind)).toEqual(['start', 'before_ai']);
  });
});

describe('edits (§4.3 #3–5)', () => {
  it('a commit 31 minutes after the last change writes `edits` of the book before it, dated before.updatedAt', async () => {
    const r = await loaded();
    r.clock.t += MIN;
    const afterFirst = r.commit([say('pg_1', 'Morning words')], 'user');
    r.clock.t += 29 * MIN;
    r.commit([say('pg_2', 'Still here')], 'user'); // 29 minutes: no gap
    await r.rec.settled();
    expect(r.rows().map((x) => x.kind)).toEqual(['start']);
    r.clock.t += 31 * MIN;
    const before = r.doc();
    r.commit([say('pg_3', 'Back after lunch')], 'user');
    await r.rec.settled();
    const rows = r.rows();
    expect(rows.map((x) => x.kind)).toEqual(['start', 'edits']);
    expect(rows[1]).toMatchObject({ contentAt: before.updatedAt, rev: before.rev, actor: 'you', label: 'You edited dialogue on pages 1–2' });
    expect(before.updatedAt).toBe(afterFirst.updatedAt + 29 * MIN);
    expect(rows[1].contentAt).not.toBe(r.clock.t);
  });

  it('content_at is when the book last changed, even when a chat message or a spend moved updatedAt since', async () => {
    const r = await loaded();
    r.clock.t += MIN;
    const edited = r.commit([say('pg_1', 'Morning words')], 'user').updatedAt;
    r.clock.t += 40 * MIN;
    r.commit([{ op: 'message', msg: { id: 'm1', role: 'user', text: 'I am back', at: r.clock.t } }], 'user');
    r.commit([{ op: 'spend', entry: spend('chat', 0.002, { kind: 'chat' }) }], 'job');
    r.clock.t += 1000;
    const before = r.doc();
    const back = r.commit([say('pg_2', 'Back again')], 'user').updatedAt;
    await r.rec.settled();
    let rows = r.rows();
    expect(rows.map((x) => x.kind)).toEqual(['start', 'edits']);
    expect(before.updatedAt).toBe(edited + 40 * MIN); // the chat message's time…
    expect(rows[1].contentAt).toBe(edited); // …is not when the book changed
    // The same for a run's before_ai: your chat message just before the director's first AI commit.
    r.clock.t += MIN;
    r.commit([{ op: 'message', msg: { id: 'm2', role: 'user', text: 'Draw page 1', at: r.clock.t } }], 'user');
    r.clock.t += MIN;
    r.commit([drawn('pg_1', 'p1.webp')], 'job');
    await r.flush();
    rows = r.rows();
    expect(rows.map((x) => x.kind)).toEqual(['start', 'edits', 'before_ai', 'ai']);
    expect(rows[2].contentAt).toBe(back);
    expect(rows[3].contentAt).toBe(r.clock.t);
  });

  it('a QC report or a render status is no change: it neither restarts the gap clock nor dates the next row', async () => {
    const start = plannedDoc();
    start.pages[0].render = { status: 'ready', asset: { path: `${IMG}/p1.webp`, source: 'generated', at: 1 }, history: [] };
    const r = await loaded(normalizeDoc(start));
    r.clock.t += MIN;
    const first = r.commit([say('pg_1', 'First words')], 'user').updatedAt;
    r.clock.t += 20 * MIN;
    r.commit([{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { qc: { score: 0.9, issues: [], checkedAt: r.clock.t } } }], 'job');
    r.commit([{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { status: 'ready', updatedAt: r.clock.t } }], 'job');
    await r.rec.settled();
    expect(r.rows().map((x) => x.kind)).toEqual(['start']);
    r.clock.t += 11 * MIN; // 31 minutes after your first edit, 11 after the QC report
    r.commit([say('pg_2', 'After lunch')], 'user');
    await r.rec.settled();
    const rows = r.rows();
    expect(rows.map((x) => x.kind)).toEqual(['start', 'edits']);
    expect(rows[1]).toMatchObject({ contentAt: first, label: 'You edited dialogue on page 1' });
    // A late QC report is not "the first commit after a gap": your unrecorded edit waits for your own next commit.
    const g = await loaded(normalizeDoc(start));
    g.clock.t += MIN;
    const mine = g.commit([say('pg_2', 'Before the break')], 'user').updatedAt;
    g.clock.t += HISTORY_POLICY.gapMs + MIN;
    g.commit([{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { qc: { score: 0.7, issues: [], checkedAt: g.clock.t } } }], 'job');
    await g.rec.settled();
    expect(g.rows().map((x) => x.kind)).toEqual(['start']);
    g.clock.t += MIN;
    g.commit([say('pg_3', 'Back')], 'user');
    await g.rec.settled();
    expect(g.rows().map((x) => [x.kind, x.contentAt])).toEqual([['start', T0], ['edits', mine]]);
    // A QC report alone, long after the last change, captures nothing and leaves nothing to say at the end.
    const q = await loaded(normalizeDoc(start));
    q.clock.t += 2 * HISTORY_POLICY.gapMs;
    q.commit([{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { qc: { score: 0.5, issues: [], checkedAt: q.clock.t } } }], 'job');
    await q.flush(true);
    expect(q.rows().map((x) => x.kind)).toEqual(['start']);
    expect(q.puts()).toBe(1);
  });

  it('quiet editing: an edits row at a flush after 25 commits, or 3 pages, or 10 minutes — never before', async () => {
    // 24 commits on one page, 9 minutes: nothing yet; the 25th commit makes it due.
    const a = await loaded();
    for (let i = 0; i < HISTORY_POLICY.quietEditCommits - 1; i += 1) {
      a.clock.t += 10_000;
      a.commit([say('pg_1', `draft ${i}`)], 'user');
    }
    await a.flush();
    expect(a.rows().map((x) => x.kind)).toEqual(['start']);
    a.commit([say('pg_1', 'draft final')], 'user');
    await a.flush();
    expect(a.rows().map((x) => [x.kind, x.label])).toEqual([['start', 'History starts here'], ['edits', 'You edited dialogue on page 1']]);

    // Two pages: nothing; a third page: due.
    const b = await loaded();
    b.commit([say('pg_1', 'one')], 'user');
    b.commit([say('pg_2', 'two')], 'user');
    await b.flush();
    expect(b.rows()).toHaveLength(1);
    b.commit([say('pg_3', 'three')], 'user');
    await b.flush();
    expect(b.rows().map((x) => [x.kind, x.label])).toEqual([['start', 'History starts here'], ['edits', 'You edited dialogue on pages 1–3']]);

    // One edit: 9 minutes later nothing, 10 minutes later due.
    const c = await loaded();
    c.clock.t += MIN;
    c.commit([say('pg_2', 'slow')], 'user');
    c.clock.t += HISTORY_POLICY.quietEditMs - MIN;
    await c.flush();
    expect(c.rows()).toHaveLength(1);
    c.clock.t += MIN;
    await c.flush();
    expect(c.rows().map((x) => x.kind)).toEqual(['start', 'edits']);
  });

  it('the final flush writes "Where you left off"; with nothing changed it writes nothing', async () => {
    const r = await loaded();
    r.clock.t += MIN;
    r.commit([say('pg_2', 'Last words')], 'user');
    await r.flush();
    expect(r.rows()).toHaveLength(1);
    await r.flush(true);
    expect(r.rows().map((x) => [x.kind, x.label, x.contentAt])).toEqual([
      ['start', 'History starts here', T0],
      ['edits', 'Where you left off', T0 + MIN]
    ]);
    await r.flush(true);
    expect(r.rows()).toHaveLength(2);
  });

  it('an unchanged state writes nothing: no rows and no put for an edit undone, QC, variants or a render status', async () => {
    const start = plannedDoc();
    start.pages[0].render = { status: 'ready', asset: { path: `${IMG}/p1.webp`, source: 'generated', at: 1 }, history: [] };
    const r = await loaded(normalizeDoc(start));
    const original = r.doc().pages[1].panels[1].lines[0].text;
    r.clock.t += MIN;
    r.commit([say('pg_2', 'oops')], 'user');
    r.commit([say('pg_2', original)], 'user');
    r.commit([{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { qc: { score: 0.9, issues: [], checkedAt: 1 } } }], 'job');
    r.commit([{ op: 'asset_meta', path: `${IMG}/p1.webp`, patch: { variants: [{ path: `${IMG}/p1_w480.webp`, w: 480, h: 720 }] } }], 'job');
    r.commit([queued('pg_2')], 'job');
    await r.flush();
    await r.flush(true);
    expect(r.rows().map((x) => x.kind)).toEqual(['start']);
    expect(r.puts()).toBe(1);
    expect(r.events).toHaveLength(1);
  });

  it('message, spend, gate, memory, QC/asset_meta and safety commits write nothing, even after a gap', async () => {
    const start = plannedDoc();
    start.pages[0].render = { status: 'ready', asset: { path: `${IMG}/p1.webp`, source: 'generated', at: 1 }, history: [] };
    const r = await loaded(normalizeDoc(start));
    r.commit([say('pg_2', 'not recorded yet')], 'user'); // a real change waits for its moment...
    const calls = r.store.calls.length;
    r.clock.t += 2 * HISTORY_POLICY.gapMs; // ...and none of these commits counts as the first commit after a gap
    r.commit([{ op: 'message', msg: { id: 'm1', role: 'user', text: 'hello', at: r.clock.t } }], 'user');
    r.commit([{ op: 'spend', entry: spend('chat', 0.002, { kind: 'chat' }) }], 'job');
    r.commit([{ op: 'gate', gate: null }], 'job');
    r.commit([{ op: 'memory', text: 'likes teal' }], 'director');
    r.commit([{ op: 'asset_meta', path: `${IMG}/p1.webp`, patch: { safety: { assessed: 'G', at: 1 } } }], 'job');
    r.commit([{ op: 'safety', patch: {} }], 'job');
    await r.rec.settled();
    expect(r.store.calls.length).toBe(calls);
    expect(r.rows().map((x) => x.kind)).toEqual(['start']);
    expect(r.rec.pending).toBe(0);
    // The edit itself is still recorded at the end of the session.
    await r.flush(true);
    expect(r.rows().map((x) => [x.kind, x.label])).toEqual([['start', 'History starts here'], ['edits', 'Where you left off']]);
  });
});

describe('start, publish, import (§4.3 #6–7, §11)', () => {
  it('a v4-shaped load writes exactly one pinned start row; the next load reads the head and writes nothing', async () => {
    const v4 = normalizeDoc(historyV4Doc());
    const r = rig(v4);
    await r.rec.onLoad(v4);
    const rows = r.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'start', actor: 'system', pinned: true, label: 'History starts here', contentAt: v4.updatedAt, rev: 41, changes: [] });
    expect(rows[0].stats).toMatchObject({ pages: 5, drawn: 5, lines: 10, models: ['nano-banana-2.1'] });
    expect(rows[0].thumbs[0]).toEqual({ key: 'cover', path: 'u/user-a/p/proj-v4/img/cover.webp' });
    expect(rows[0].thumbs).toHaveLength(6);
    expect(r.rec.recording).toBe(true);
    // Every chunk landed: the row can be opened.
    expect(await r.store.get(scope, rows[0].id)).not.toBeNull();
    // A later session on the same comic: head() and nothing else.
    const again = createHistoryRecorder(scope, { store: r.store, now: () => r.clock.t });
    expect(again.recording).toBe(false);
    await again.onLoad(v4);
    expect(r.rows()).toHaveLength(1);
    expect(again.recording).toBe(true);
  });

  it('a publication op writes a pinned publish row with published_rev; an unchanged head is pinned and marked instead', async () => {
    const r = await loaded();
    r.clock.t += MIN;
    r.commit([say('pg_1', 'Ready to share')], 'user');
    const mirror = (rev: number) => ({ visibility: 'unlisted' as const, status: 'live' as const, publishedRev: rev, publishedAt: r.clock.t, languages: ['en'] });
    r.clock.t += MIN;
    r.commit([{ op: 'publication', value: mirror(r.doc().rev) }], 'user');
    await r.rec.settled();
    let rows = r.rows();
    expect(rows.map((x) => x.kind)).toEqual(['start', 'publish']);
    expect(rows[1]).toMatchObject({ pinned: true, label: 'Published', publishedRev: r.doc().rev - 1, actor: 'you' });
    // Settings only (same publishedRev): nothing.
    r.commit([{ op: 'publication', value: { ...mirror(rows[1].publishedRev!), visibility: 'public' } }], 'user');
    await r.rec.settled();
    expect(r.rows()).toHaveLength(2);
    // Publish again with nothing changed: the head itself is pinned and marked.
    const fresh = await loaded();
    fresh.commit([{ op: 'publication', value: mirror(7) }], 'user');
    await fresh.rec.settled();
    rows = fresh.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'start', pinned: true, publishedRev: 7 });
    expect(fresh.events.at(-1)?.version).toMatchObject({ id: rows[0].id, publishedRev: 7 });
  });

  it('a classic import writes a pinned import row (the classic project and snapshot); its first load adds no start row', async () => {
    const r = rig();
    await r.rec.onImported!({ ...scope, doc: r.doc(), fromProjectId: 'old-9', fromVersionId: 'snap_2' });
    const session = createHistoryRecorder(scope, { store: r.store, now: () => r.clock.t });
    await session.onLoad(r.doc());
    const rows = r.rows();
    expect(rows.map((x) => [x.kind, x.pinned, x.label])).toEqual([['import', true, 'Brought into the new studio']]);
    expect(rows[0].legacy).toEqual({ projectId: 'old-9', snapshotId: 'snap_2' });
  });
});

describe('words for Ship 2 moments (wave notes: the action reaches opActor and panelMomentsOfOps)', () => {
  it('a rebind is the editor’s free work; fix_panel names its panel; a panel reorder of yours is worded', async () => {
    const start = plannedDoc();
    start.pages = start.pages.map((p) => ({ ...p, render: { status: 'ready', asset: { path: `${IMG}/${p.id}.webp`, source: 'generated', at: 1 }, history: [] } }));
    const r = await loaded(normalizeDoc(start));
    r.clock.t += MIN;
    r.commit([{ op: 'panels_order', pageId: 'pg_2', order: ['pn_2_2', 'pn_2_1', 'pn_2_3'] }], 'user', { type: 'rebind_panels', pageId: 'pg_2' });
    r.clock.t += HISTORY_POLICY.quietEditMs;
    await r.flush();
    expect(r.rows().at(-1)).toMatchObject({ kind: 'edits', actor: 'editor', label: "Matched page 2's script to its art (free)" });

    r.clock.t += MIN;
    r.commit([say('pg_3', 'tweak')], 'user');
    r.commit([drawn('pg_1', 'fixed.webp', 'edit')], 'job', { type: 'fix_panel', pageId: 'pg_1', panelId: 'pn_1_3', mode: 'fix' });
    await r.flush();
    const [, , before, ai] = r.rows();
    expect(before).toMatchObject({ kind: 'before_ai', label: 'Before the AI redrew panel 3 on page 1' });
    expect(ai).toMatchObject({ kind: 'ai', label: 'AI redrew panel 3 on page 1', parentId: before.id });

    r.clock.t += MIN;
    r.commit([{ op: 'panels_order', pageId: 'pg_3', order: ['pn_3_3', 'pn_3_2', 'pn_3_1'] }], 'user');
    r.clock.t += HISTORY_POLICY.quietEditMs;
    await r.flush();
    expect(r.rows().at(-1)).toMatchObject({ kind: 'edits', actor: 'you', label: 'You rearranged the panels on page 3' });
  });
});

describe('spend (stats.spend)', () => {
  it('a BYOK run is recorded with byok:true; a mixed run keeps only what counted toward usage', async () => {
    expect(spendOf([spend('a', 0.05, { byok: true }), spend('b', 0.02, { byok: true, estimated: true })])).toEqual({ usd: 0.07, byok: true, estimated: true });
    expect(spendOf([spend('a', 0.05, { byok: true }), spend('b', 0.02)])).toEqual({ usd: 0.02, byok: false, estimated: false });
    expect(spendOf([spend('free', 0, { savedUsd: 0.05 })])).toBeUndefined();

    const r = await loaded();
    r.clock.t += MIN;
    r.commit([say('pg_1', 'x')], 'user');
    // The writer is paid before its plan lands (planPages records its spend first): the run adopts it.
    r.clock.t += MIN;
    r.commit([{ op: 'spend', entry: spend('plan', 0.003, { kind: 'plan', byok: true }) }], 'job');
    r.commit([drawn('pg_1', 'p1.webp'), { op: 'spend', entry: spend('p1', 0.05, { byok: true }) }], 'job');
    await r.flush();
    expect(r.rows().at(-1)).toMatchObject({ kind: 'ai', stats: { spend: { usd: 0.053, byok: true, estimated: false } } });
    expect(r.events.at(-1)?.version.stats.spend).toEqual({ usd: 0.053, byok: true, estimated: false });
  });

  it('spend of a request that changed nothing by AI is not carried into a later run', async () => {
    const r = await loaded();
    r.commit([{ op: 'spend', entry: spend('chat', 0.004, { kind: 'chat' }) }], 'job');
    await r.flush();
    r.clock.t += MIN;
    r.commit([say('pg_1', 'x')], 'user');
    r.commit([drawn('pg_1', 'p1.webp'), { op: 'spend', entry: spend('p1', 0.05) }], 'job');
    await r.flush();
    expect(r.rows().at(-1)?.stats.spend).toEqual({ usd: 0.05, byok: false, estimated: false });
  });
});

describe('failures never reach a save, a turn or a render (§4.1)', () => {
  it('a rejected put is logged, kept, and retried at the next commit; nothing throws', async () => {
    const warn = vi.spyOn(console, 'warn');
    const r = await loaded();
    r.store.failNext('put');
    r.clock.t += MIN;
    r.commit([say('pg_1', 'x')], 'user');
    expect(() => r.commit([drawn('pg_1', 'p1.webp')], 'job')).not.toThrow();
    await r.rec.settled();
    expect(r.rec.pending).toBe(1);
    expect(r.rows().map((x) => x.kind)).toEqual(['start']);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('comic_history_capture_failed');
    // The next commit (any commit) retries it — no timer.
    r.commit([{ op: 'message', msg: { id: 'm', role: 'assistant', text: 'Drawing…', at: r.clock.t } }], 'job');
    await r.rec.settled();
    expect(r.rec.pending).toBe(0);
    expect(r.rows().map((x) => x.kind)).toEqual(['start', 'before_ai']);
    await r.flush();
    expect(r.rows().map((x) => x.kind)).toEqual(['start', 'before_ai', 'ai']);
    expect(r.rows()[2].parentId).toBe(r.rows()[1].id);
  });

  it('a store that throws, rejects or hangs on head/missing never throws into onCommit, onFlush or onLoad', async () => {
    const broken: HistoryStore = new Proxy({} as HistoryStore, {
      get: () => () => {
        throw new Error('store exploded synchronously');
      }
    });
    const rec = createHistoryRecorder(scope, { store: broken, now: () => T0 });
    const doc = plannedDoc();
    await expect(rec.onLoad(doc)).resolves.toBeUndefined();
    const next = { ...applyOps(doc, [drawn('pg_1', 'p1.webp')], T0), rev: doc.rev + 1, updatedAt: T0 };
    expect(() => rec.onCommit(doc, next, [drawn('pg_1', 'p1.webp')], 'job', undefined)).not.toThrow();
    await expect(rec.onFlush(next, { final: true })).resolves.toBeUndefined();
    expect(rec.recording).toBe(false);
    // A sink that throws is the same: the row is still written.
    const fake = createFakeHistoryStore({ now: () => T0 });
    const loud = createHistoryRecorder(scope, { store: fake, now: () => T0, sink: { emit: () => { throw new Error('listener gone'); } } });
    await loud.onLoad(doc);
    expect(fake.rows(scope)).toHaveLength(1);
  });

  it('the pending queue keeps at most HISTORY_PENDING_MAX captures and never drops a pinned one', async () => {
    let down = true;
    const r = rig(plannedDoc(), {
      store: (fake) => ({
        ...fake,
        async put(...args) {
          if (down) throw new StudioError('INTERNAL', 'down', { status: 503, retryable: true });
          return fake.put(...args);
        }
      })
    });
    await r.rec.onLoad(r.doc()); // the pinned start fails and waits
    for (let i = 1; i <= 8; i += 1) {
      r.clock.t += MIN;
      r.commit([say(`pg_${(i % 3) + 1}`, `edit ${i}`)], 'user');
      r.commit([drawn(`pg_${(i % 3) + 1}`, `p${i}.webp`)], 'job');
      await r.rec.settled();
    }
    expect(r.rec.pending).toBe(HISTORY_PENDING_MAX);
    down = false;
    await r.flush();
    const kinds = r.rows().map((x) => x.kind);
    expect(kinds[0]).toBe('start');
    expect(r.rec.pending).toBe(0);
  });

  it('a refusal that can never succeed (not retryable) is dropped after one try; a network error is retried', async () => {
    for (const refusal of [historyStoreError('HASH'), historyStoreError('REFUSED:newest'), new StudioError('INTERNAL', 'bad digest', { status: 500 })]) {
      let puts = 0;
      const r = await loaded(undefined, {
        store: (fake) => ({
          ...fake,
          async put(...args) {
            puts += 1;
            if (puts > 1) throw refusal;
            return fake.put(...args);
          }
        })
      });
      r.clock.t += MIN;
      r.commit([say('pg_1', 'x')], 'user');
      r.commit([drawn('pg_1', 'p1.webp')], 'job'); // before_ai: refused
      await r.rec.settled();
      expect(r.rec.pending, refusal.message).toBe(0);
      for (let i = 0; i < 10; i += 1) {
        r.commit([{ op: 'message', msg: { id: `m${i}`, role: 'assistant', text: 'Drawing…', at: r.clock.t } }], 'job');
        await r.rec.settled();
      }
      expect(puts, refusal.message).toBe(2); // the start row, then one try
    }
    // A plain error (the network, a socket) is not a refusal: it waits and is retried at the next commit.
    let fails = 1;
    const r = await loaded(undefined, {
      store: (fake) => ({
        ...fake,
        async put(...args) {
          if (args[1].kind === 'before_ai' && fails-- > 0) throw new Error('socket hang up');
          return fake.put(...args);
        }
      })
    });
    r.clock.t += MIN;
    r.commit([say('pg_1', 'x')], 'user');
    r.commit([drawn('pg_1', 'p1.webp')], 'job');
    await r.rec.settled();
    expect(r.rec.pending).toBe(1);
    r.commit([{ op: 'message', msg: { id: 'm', role: 'assistant', text: 'Drawing…', at: r.clock.t } }], 'job');
    await r.rec.settled();
    expect(r.rec.pending).toBe(0);
    expect(r.rows().map((x) => x.kind)).toEqual(['start', 'before_ai']);
  });

  it('a flush waits for what was queued since the last flush, never again for an older write an earlier flush waits for', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const r = await loaded(undefined, {
      store: (fake) => ({
        ...fake,
        async put(s, v, c, p) {
          if (v.kind === 'before_ai') await held; // a store that hangs on this write
          return fake.put(s, v, c, p);
        }
      })
    });
    r.clock.t += MIN;
    r.commit([say('pg_1', 'x')], 'user');
    r.commit([queued('pg_2')], 'job');
    r.commit([drawn('pg_1', 'p1.webp')], 'job'); // the run's before_ai write starts and hangs; page 2 still drawing
    const done: string[] = [];
    const first = r.flush().then(() => done.push('first'));
    const tick = async () => {
      for (let i = 0; i < 50; i += 1) await Promise.resolve();
    };
    await tick();
    expect(done).toEqual([]); // this request's own moment is still being written
    // A later request with nothing new (a chat reply) is not held by that write.
    const second = r.flush().then(() => done.push('second'));
    await tick();
    expect(done).toEqual(['second']);
    // The final flush (eviction, shutdown) waits for everything.
    const last = r.flush(true).then(() => done.push('final'));
    await tick();
    expect(done).toEqual(['second']);
    release();
    await Promise.all([first, second, last]);
    expect(done.slice(1).sort()).toEqual(['final', 'first']);
    expect(r.rows().map((x) => x.kind)).toEqual(['start', 'before_ai', 'ai']);
  });

  it('a put refused for missing chunks (another write’s GC) is retried once with every chunk', async () => {
    const sizes: number[] = [];
    let conflicts = 1;
    const r = await loaded(undefined, {
      store: (fake) => ({
        ...fake,
        async put(s, v, chunks, p) {
          sizes.push(chunks.length);
          if (v.kind === 'edits' && conflicts-- > 0) throw new StudioError('CONFLICT', 'gone', { status: 409, retryable: true });
          return fake.put(s, v, chunks, p);
        }
      })
    });
    r.clock.t += MIN;
    r.commit([say('pg_1', 'x')], 'user');
    await r.flush(true);
    const all = chunkBook(r.doc()).chunks.length;
    expect(sizes.slice(1)).toEqual([1, all]); // only the changed page text, then every chunk
    expect(r.rows().map((x) => x.kind)).toEqual(['start', 'edits']);
  });

  it('a budget-thinned put posts a notice once (never silent, never repeated), in the History panel\'s own words', async () => {
    const r = await loaded(undefined, {
      store: (fake) => ({ ...fake, put: async (...args) => ({ ...(await fake.put(...args)), budgetThinned: 3 }) })
    });
    expect(r.notices).toEqual(['History made room for new moments: it let 3 older automatic moments go to stay within this comic\'s space. Named versions are kept forever.']);
    expect(r.notices[0]).not.toMatch(/\$|commit|branch|merge|diff|pinned/i);
    // Past its budget every new row thins an older one: the second and third thinned writes post nothing more.
    r.clock.t += MIN;
    r.commit([say('pg_1', 'one more')], 'user');
    r.clock.t += MIN;
    r.commit([drawn('pg_1', 'p1.webp')], 'job');
    await r.flush();
    expect(r.rows().map((x) => x.kind)).toEqual(['start', 'before_ai', 'ai']);
    expect(r.notices).toHaveLength(1);
  });

  it('tables not applied (NOT_AVAILABLE): the session stops recording after one try', async () => {
    const r = rig(plannedDoc(), {
      store: (fake) => ({ ...fake, head: async () => Promise.reject(new StudioError('NOT_AVAILABLE', 'apply the sql', { status: 503 })) })
    });
    await r.rec.onLoad(r.doc());
    const calls = r.store.calls.length;
    r.commit([drawn('pg_1', 'p1.webp')], 'job');
    await r.flush(true);
    expect(r.store.calls.length).toBe(calls);
    expect(r.rec.pending).toBe(0);
  });
});

describe('lines and restores', () => {
  it('rows go to the line you are on (the event carries its alternativeId)', async () => {
    const first = await loaded();
    const [start] = first.rows();
    const alt = await first.store.createAlternative(scope, { name: 'Darker ending', headVersionId: start.id });
    // H7's switch: the new line's own first row, then it becomes the line you're on.
    const book = chunkBook(first.doc());
    await first.store.put(scope, { kind: 'switch', actor: 'you', label: 'Switched', rev: 1, contentAt: T0, manifest: book.manifest, rootHash: book.rootHash, chunks: book.hashes, alternativeId: alt.id }, book.chunks);
    await first.store.updateAlternative(scope, alt.id, { active: true });
    const r = rig(plannedDoc(), { store: () => first.store });
    await r.rec.onLoad(r.doc());
    r.clock.t += MIN;
    r.commit([say('pg_3', 'A darker line')], 'user');
    await r.flush(true);
    const row = first.store.rows(scope)[0];
    expect(row).toMatchObject({ kind: 'edits', alternativeId: alt.id });
    expect(r.events.at(-1)?.version.alternativeId).toBe(alt.id);
  });

  it('a history restore commit writes nothing itself (H3 writes its rows) and the head is read again', async () => {
    const r = await loaded();
    const heads = () => r.store.calls.filter((c) => c.method === 'head').length;
    const before = heads();
    r.clock.t += MIN;
    r.commit([{ op: 'history_restore', set: {}, mode: 'merge', versionId: 'v', at: r.clock.t } as DocOp], 'user');
    await r.rec.settled();
    expect(r.rec.pending).toBe(0);
    r.commit([say('pg_1', 'after restore')], 'user');
    await r.flush(true);
    expect(heads()).toBe(before + 1);
    expect(r.rows().map((x) => x.kind)).toEqual(['start', 'edits']);
  });
});

describe('a restore (H3) never lets an older capture become the line’s head', () => {
  it('a capture still waiting at a restore is dropped: the restore row stays the newest and the head holds the live book', async () => {
    const warn = vi.spyOn(console, 'warn');
    const r = await loaded();
    const original = r.doc();
    r.clock.t += MIN;
    r.commit([say('pg_1', 'a')], 'user');
    r.commit([say('pg_2', 'b')], 'user');
    r.commit([say('pg_3', 'c')], 'user');
    r.store.failNext('put');
    await r.flush(); // quiet editing is due (3 pages): its write fails and waits for a retry
    expect(r.rec.pending).toBe(1);
    // H3: the awaited before_restore row of the live book, the history_restore commit, then its restore row.
    await putRow(r, 'before_restore', r.doc());
    r.clock.t += 1000;
    r.commit([restoreTo(original, r.clock.t)], 'user');
    expect(r.rec.pending).toBe(0);
    await putRow(r, 'restore', r.doc());
    await r.flush();
    await r.rec.settled();
    expect(r.store.rows(scope).map((x) => x.kind)).toEqual(['restore', 'before_restore', 'start']); // newest first
    const head = await r.store.head(scope);
    expect(head?.kind).toBe('restore');
    expect(head?.rootHash).toBe(chunkBook(r.doc()).rootHash);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('comic_history_capture_dropped');
    // Your next edit is worded against the restored book.
    r.clock.t += MIN;
    r.commit([say('pg_3', 'after the restore')], 'user');
    await r.flush(true);
    const newest = r.store.rows(scope)[0];
    expect(newest).toMatchObject({ kind: 'edits', label: 'Where you left off' });
    expect(newest.changes).toEqual([expect.objectContaining({ what: 'dialogue', by: 'you', pageIds: ['pg_3'] })]);
  });

  it('a pinned moment waiting at a restore is still written (before H3’s restore row) but never taken as the head', async () => {
    const r = await loaded();
    const original = r.doc();
    r.clock.t += MIN;
    r.commit([say('pg_1', 'Ready to share')], 'user');
    r.clock.t += MIN;
    r.store.failNext('put');
    r.commit([{ op: 'publication', value: published(r.doc().rev, r.clock.t) }], 'user');
    await r.rec.settled();
    r.clock.t += MIN;
    r.commit([say('pg_2', 'An edit after publishing')], 'user'); // so the book H3 saves differs from the published one
    r.store.failNext('put');
    await r.flush(); // H3's first flush: the publish row fails again
    expect(r.rec.pending).toBe(1);
    await putRow(r, 'before_restore', r.doc());
    r.clock.t += 1000;
    r.commit([restoreTo(original, r.clock.t)], 'user');
    expect(r.rec.pending).toBe(1); // pinned: never dropped
    await r.flush(); // H3 flushes, then writes its restore row
    await putRow(r, 'restore', r.doc());
    expect(r.store.rows(scope).map((x) => [x.kind, x.pinned])).toEqual([
      ['restore', false],
      ['publish', true],
      ['before_restore', false],
      ['start', true]
    ]);
    // The recorder's head is the restored book, not the published one: your next edit is worded against it.
    r.clock.t += MIN;
    r.commit([say('pg_3', 'after the restore')], 'user');
    await r.flush(true);
    const newest = r.store.rows(scope)[0];
    expect(newest.kind).toBe('edits');
    expect(newest.changes).toEqual([expect.objectContaining({ what: 'dialogue', by: 'you', pageIds: ['pg_3'] })]);
  });
});

describe('no timers (the backend stays sleepable)', () => {
  it('a whole session of captures, failures and retries creates zero setTimeout / setInterval', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const r = await loaded();
    r.clock.t += MIN;
    r.commit([say('pg_1', 'a')], 'user');
    r.store.failNext('put');
    r.commit([queued('pg_1'), queued('pg_2')], 'job');
    r.commit([drawn('pg_1', 'p1.webp'), { op: 'spend', entry: spend('p1', 0.05) }], 'job');
    await r.rec.settled();
    r.commit([drawn('pg_2', 'p2.webp')], 'job');
    await r.flush();
    r.clock.t += HISTORY_POLICY.gapMs;
    r.commit([say('pg_2', 'b')], 'user');
    r.commit([{ op: 'publication', value: { visibility: 'unlisted', status: 'live', publishedRev: 9, publishedAt: 1, languages: ['en'] } }], 'user');
    await r.flush(true);
    await r.rec.onImported!({ ...scope, doc: r.doc(), fromProjectId: 'old' });
    expect(r.rows().map((x) => x.kind)).toEqual(['start', 'before_ai', 'ai', 'publish']);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
