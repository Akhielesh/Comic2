// Director tool group "timeline" (timeline.md §3.3 / §7 tools): free page-structure edits, versions,
// book extras and the free shape fit. Every edit goes through the shared sanitizer.
import { describe, expect, it } from 'vitest';
import { applyOp } from '../../../../shared/comic/ops.js';
import { versionList as sharedVersionList } from '../../../../shared/comic/book.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../../shared/comic/capabilities.js';
import { emptyRender, isPageStale, pageSpecHash, trashOf, type AssetRef, type ComicDoc } from '../../../../shared/comic/doc.js';
import { newSession, opsOf, plannedDoc, testContext } from '../orchestrator.fakes.js';
import { createDirectorTurn } from '../tools.js';
import { toolGroupById } from './index.js';
import { describeVersion, modelName, newlyStalePages, offShape, resolveTarget, timelineToolGroup, versionList, versionedTargets } from './timeline.js';

const asset = (path: string, extra: Partial<AssetRef> = {}): AssetRef => ({ path, source: 'generated', at: 1, w: 800, h: 1000, ...extra });

/** 3 pages at 4:5; MAYA's sheet has two versions; page 1 drawn (3 versions, one archived); page 3 drawn square. */
const drawnDoc = (): ComicDoc => {
  const doc = plannedDoc();
  doc.format = { ...doc.format, pageAspect: '4:5' };
  doc.cast = doc.cast.map((c) =>
    c.id === 'c_maya'
      ? { ...c, sheet: { status: 'ready', asset: asset('u/x/maya-v2.webp', { at: 20 }), history: [asset('u/x/maya-v1.webp', { at: 10 })] } }
      : c
  );
  const [p1, p2, p3] = doc.pages;
  doc.pages = [
    {
      ...p1,
      render: {
        status: 'ready',
        asset: asset('u/x/p1-v3.webp', { at: 30, model: 'nano-banana-2.1' }),
        history: [asset('u/x/p1-v2.webp', { at: 20, w: 1024, h: 1024 })],
        specHash: pageSpecHash(doc, p1),
        costUsd: 0.06,
        origin: 'render',
        qc: { score: 0.82, issues: [], checkedAt: 1 }
      }
    },
    { ...p2, render: emptyRender() },
    { ...p3, render: { status: 'ready', asset: asset('u/x/p3.webp', { w: 1024, h: 1024 }), history: [], specHash: pageSpecHash(doc, p3) } }
  ];
  doc.pages[2].balloons = [{ lineId: 'ln_3_2', x: 0.5, y: 0.5, w: 0.3, tailX: 0.5, tailY: 0.9 }];
  doc.archive = [{ ...asset('u/x/p1-v1.webp', { at: 10 }), targetKey: 'page:pg_1', label: 'Page 1', archivedAt: 25 }];
  return doc;
};

const setup = (doc: ComicDoc = drawnDoc(), caps?: StudioCaps) => {
  const session = newSession(doc);
  const ctx = testContext(session, caps ? { caps } : {});
  const turn = createDirectorTurn();
  const tools = () => Object.fromEntries(timelineToolGroup.tools(ctx, turn).map((t) => [t.spec.function.name, t]));
  return { session, ctx, turn, tools };
};

describe('registration and phase gates', () => {
  it('is the registered timeline group; every tool is FREE', () => {
    expect(toolGroupById('timeline')).toBe(timelineToolGroup);
    const { ctx, turn, tools } = setup();
    expect(timelineToolGroup.when?.(ctx, turn)).toBe(true);
    const names = Object.keys(tools());
    expect(names).toEqual(['move_page', 'insert_page', 'duplicate_page', 'delete_page', 'list_versions', 'use_version', 'set_book', 'fit_render']);
    for (const t of Object.values(tools())) {
      expect(t.cost).toBe('free');
      expect(t.spec.function.description.startsWith('FREE — ')).toBe(true);
    }
    expect(timelineToolGroup.activity).toMatchObject({ move_page: expect.any(String), fit_render: expect.any(String) });
  });

  it('offers only what the doc can use (no versions, no shape problem, no trash → 5 tools)', () => {
    const { ctx, turn, tools } = setup(plannedDoc());
    expect(Object.keys(tools())).toEqual(['move_page', 'insert_page', 'duplicate_page', 'delete_page', 'set_book']);
    const empty = plannedDoc();
    empty.pages = [];
    const s = setup(empty);
    expect(timelineToolGroup.when?.(s.ctx, s.turn)).toBe(false);
    expect(ctx && turn).toBeTruthy();
  });

  it('prompt rules and summary lines carry real version / shape / book facts', () => {
    const doc = drawnDoc();
    expect(timelineToolGroup.promptRules?.(doc)).toMatch(/list_versions/);
    expect(timelineToolGroup.promptRules?.(doc)).toMatch(/fit_render/);
    const lines = timelineToolGroup.summaryLines?.(doc, createDirectorTurn()) ?? [];
    expect(lines.join('\n')).toMatch(/p1 3 versions \(v3 current, QC 0\.82\)/);
    expect(lines.join('\n')).toMatch(/Wrong shape for 4:5: p3 \(1:1\)/);
    expect(lines.join('\n')).toMatch(/Version archive: 1\/300/);
  });
});

describe('versions (v1 = oldest)', () => {
  it('numbers versions by creation time, stable across swaps', () => {
    const doc = drawnDoc();
    const list = versionList(doc, { kind: 'page', id: 'pg_1' });
    expect(list.map((e) => [e.n, e.path, e.current, e.archived])).toEqual([
      [1, 'u/x/p1-v1.webp', false, true],
      [2, 'u/x/p1-v2.webp', false, false],
      [3, 'u/x/p1-v3.webp', true, false]
    ]);
    const swapped = applyOp(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'u/x/p1-v2.webp', at: 99 });
    expect(versionList(swapped, { kind: 'page', id: 'pg_1' }).map((e) => [e.n, e.path, e.current])).toEqual([
      [1, 'u/x/p1-v1.webp', false],
      [2, 'u/x/p1-v2.webp', true],
      [3, 'u/x/p1-v3.webp', false]
    ]);
    expect(versionedTargets(doc).map((t) => t.count)).toEqual([3, 2]);
  });

  it('describes only recorded data (model nickname, shape, cost, QC)', () => {
    const doc = drawnDoc();
    const [v1, v2, v3] = versionList(doc, { kind: 'page', id: 'pg_1' });
    expect(describeVersion(doc, v3)).toBe('v3 current (4:5, Nano Banana 2.1, $0.06, render, QC 0.82)');
    expect(describeVersion(doc, v2)).toBe('v2 (1:1 ⚠ not 4:5)');
    expect(describeVersion(doc, v1)).toBe('v1 (4:5, archived)');
    expect(modelName('google/gemini-nano-banana-2.1')).toBe('Nano Banana 2.1');
    expect(modelName('mystery-model')).toBe('mystery-model');
  });

  it('list_versions posts one versions card and lists newest first', async () => {
    const { tools, turn } = setup();
    const text = await tools().list_versions.execute({ target: 'page 1' });
    expect(text).toMatch(/^Page 1 — 3 versions: v3 current .*; v2 .*; v1 /);
    expect(turn.cards).toEqual([{ type: 'versions', id: expect.any(String), target: { kind: 'page', id: 'pg_1' } }]);
    await tools().list_versions.execute({ target: 'page', page: 1 });
    expect(turn.cards).toHaveLength(1);
  });

  it('use_version "previous" swaps instantly and for free', async () => {
    const { tools, session, ctx } = setup();
    const text = await tools().use_version.execute({ target: 'page', page: 1, version: 'previous' });
    expect(text).toMatch(/Page 1 now uses v2 \(\$0/);
    expect(text).toMatch(/It's 1:1, not 4:5 — fit_render/);
    expect(session.doc.pages[0].render.asset?.path).toBe('u/x/p1-v2.webp');
    expect(session.doc.spend.totalUsd).toBe(0);
    const ops = opsOf(ctx.events);
    expect(ops.map((o) => o.op)).toEqual(['render_use']);
    expect(ctx.events.find((e) => e.type === 'ops')).toMatchObject({ origin: 'director' });
  });

  it('use_version from the archive ("original") and refusals', async () => {
    const { tools, session } = setup();
    expect(await tools().use_version.execute({ target: 'page 1', version: 'original' })).toMatch(/now uses v1/);
    expect(session.doc.archive).toEqual([]);
    expect(await tools().use_version.execute({ target: 'page 1', version: 1 })).toMatch(/already the current version/);
    expect(await tools().use_version.execute({ target: 'page 1', version: 9 })).toMatch(/^Error: There is no v9 — this image has v1–v3/);
    expect(await tools().use_version.execute({ target: 'page 3', version: 1 })).toMatch(/only one version — nothing to switch to\. A new take is ≈\$/);
  });

  it('a sheet version that would stale drawn pages needs confirm:true (and lists the pages)', async () => {
    const { tools, session } = setup();
    const first = await tools().use_version.execute({ target: 'sheet', name: 'Maya', version: 1 });
    expect(first).toMatch(/^Not switched yet: using v1 of MAYA sheet would mark page 1 out of date \(.*redrawing them later ≈\$/);
    expect(session.doc.cast[0].sheet.asset?.path).toBe('u/x/maya-v2.webp');
    const second = await tools().use_version.execute({ target: 'sheet MAYA', version: 1, confirm: true });
    expect(second).toMatch(/MAYA sheet now uses v1/);
    expect(second).toMatch(/Page 1 now shows as out of date/);
    expect(isPageStale(session.doc, session.doc.pages[0])).toBe(true);
  });

  it('resolveTarget explains what exists when nothing matches', () => {
    const doc = drawnDoc();
    expect(resolveTarget(doc, { target: 'cover' })).toEqual({ kind: 'cover' });
    expect(resolveTarget(doc, { target: 'Spice Market' })).toEqual({ kind: 'place', id: 'pl_market' });
    expect(() => resolveTarget(doc, { target: 'page 9' })).toThrow(/There is no page 9\. Images in this comic: cover; pages 1–3; sheets: MAYA, ARJUN/);
  });

  it('newlyStalePages compares before/after', () => {
    const doc = drawnDoc();
    const after = applyOp(doc, { op: 'render_use', target: { kind: 'sheet', id: 'c_maya' }, path: 'u/x/maya-v1.webp', at: 1 });
    expect(newlyStalePages(doc, after)).toEqual([1]);
  });
});

describe('page structure', () => {
  it('move_page reorders without redrawing anything', async () => {
    const { tools, session } = setup();
    const text = await tools().move_page.execute({ page: 3, to: 1 });
    expect(text).toMatch(/^Moved page 3 to 1 \(\$0\)\. Order now: 1 Page 3 beat, 2 Page 1 beat, 3 Page 2 beat\./);
    expect(session.doc.pages.map((p) => p.id)).toEqual(['pg_3', 'pg_1', 'pg_2']);
    expect(session.doc.pages.every((p) => !isPageStale(session.doc, p))).toBe(true);
    expect(await tools().move_page.execute({ page: 7, to: 1 })).toMatch(/^Error: There is no page 7/);
  });

  it('insert_page adds a blank page for free; write refuses past the per-turn writer limit', async () => {
    const { tools, session, turn } = setup();
    const text = await tools().insert_page.execute({ after: 1, summary: 'A storm rolls in.' });
    expect(text).toMatch(/^Added a blank page 2 after page 1 \(\$0\)/);
    expect(session.doc.pages.map((p) => p.n)).toEqual([1, 2, 3, 4]);
    expect(session.doc.pages[1]).toMatchObject({ summary: 'A storm rolls in.', panels: [] });
    expect(session.doc.format.pageCount).toBe(4);
    turn.paidText = 2;
    expect(await tools().insert_page.execute({ after: 0, write: true })).toMatch(/^Error: Already ran the writer twice/);
    expect(session.doc.pages).toHaveLength(4);
  });

  it('insert_page write:true whose writer fails still says the blank page was added (never a bare error)', async () => {
    const { tools, session, ctx, turn } = setup();
    ctx.llmFake.script.writer = [new Error('provider down'), new Error('provider down'), new Error('provider down')];
    const text = await tools().insert_page.execute({ after: 1, summary: 'A storm rolls in.', write: true });
    expect(text).toMatch(/^Added a blank page 2 \(\$0\)/);
    expect(text).not.toMatch(/^Error/);
    expect(session.doc.pages.map((p) => p.n)).toEqual([1, 2, 3, 4]);
    expect(turn.paidText).toBe(1);
  });

  it('duplicate_page copies the page right after itself with its current art', async () => {
    const { tools, session } = setup();
    const text = await tools().duplicate_page.execute({ page: 1 });
    expect(text).toMatch(/^Copied page 1 to page 2 \(\$0\) with its current art\./);
    expect(session.doc.pages[1].render.asset?.path).toBe('u/x/p1-v3.webp');
    expect(session.doc.pages[1].render.history).toEqual([]);
  });

  it('delete_page → Media → Deleted; restore_page brings it back at its old number', async () => {
    const { tools, session } = setup();
    expect(await tools().delete_page.execute({ page: 1 })).toMatch(/^Deleted page 1 \(\$0\)\. It's in Media → Deleted/);
    expect(trashOf(session.doc)[0]).toMatchObject({ fromN: 1, page: { id: 'pg_1' } });
    expect(Object.keys(tools())).toContain('restore_page');
    expect(await tools().restore_page.execute({ page: 5 })).toMatch(/^No deleted page was page 5\. Deleted: former page 1/);
    expect(await tools().restore_page.execute({})).toMatch(/^Restored the deleted page as page 1 \(\$0\)/);
    expect(session.doc.pages.map((p) => p.id)).toEqual(['pg_1', 'pg_2', 'pg_3']);
  });

  it('a drawing page cannot be deleted or duplicated (409 through the shared sanitizer)', async () => {
    const doc = drawnDoc();
    doc.pages[1].render = { status: 'rendering', history: [] };
    const { tools, session } = setup(doc);
    expect(await tools().delete_page.execute({ page: 2 })).toMatch(/^Error: Page 2 is still drawing/);
    expect(await tools().duplicate_page.execute({ page: 2 })).toMatch(/^Error: Page 2 is still drawing/);
    expect(session.doc.pages).toHaveLength(3);
  });

  it('set_book toggles the free software pages', async () => {
    const { tools, session } = setup();
    const text = await tools().set_book.execute({ titlePage: true, endPage: true, credits: ['Story: Maya'] });
    expect(text).toBe('Book extras: title page on, “The End” on, back cover off — all free, made by software.');
    expect(session.doc.book).toMatchObject({ titlePage: true, endPage: true, credits: ['Story: Maya'] });
    expect(await tools().set_book.execute({})).toMatch(/^Error: Pass at least one/);
  });
});

describe('fit_render tool', () => {
  it('fits a square page to 4:5 for free, keeps the original as a version, remaps balloons', async () => {
    const { tools, session, ctx, turn } = setup();
    expect(offShape(session.doc)).toEqual([{ target: { kind: 'page', id: 'pg_3' }, got: '1:1' }]);
    const text = await tools().fit_render.execute({ target: 'page', page: 3 });
    expect(text).toMatch(/^Fitted page 3 from 1:1 to 4:5 by padding the edges — free/);
    const r = session.doc.pages[2].render;
    expect(r.asset).toMatchObject({ source: 'derived', derivedFrom: 'u/x/p3.webp' });
    expect(r).toMatchObject({ origin: 'derived', parentPath: 'u/x/p3.webp', aspect: '4:5', costUsd: 0, specHash: pageSpecHash(drawnDoc(), drawnDoc().pages[2]) });
    expect(r.history[0].path).toBe('u/x/p3.webp');
    // Padding a 1:1 image to 4:5 adds top/bottom bars: x stays, y shrinks toward the centre.
    expect(session.doc.pages[2].balloons[0]).toMatchObject({ x: 0.5, y: 0.5, w: 0.3, tailY: 0.82 });
    expect(session.doc.spend.totalUsd).toBe(0);
    expect(session.doc.spend.entries[0]).toMatchObject({ usd: 0, target: 'page:pg_3', savedUsd: expect.any(Number) });
    expect(ctx.assetsFake.fits).toEqual([{ path: 'u/x/p3.webp', aspect: '4:5', mode: 'pad' }]);
    expect(turn.cards).toEqual([]); // the director speaks for itself on success
    expect(offShape(session.doc)).toEqual([]);
  });
});

describe('one version numbering (shared/comic/book.ts) and governed prices', () => {
  /** A user on the included usage: one Standard page is 5% of it. */
  const governed: StudioCaps = { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 80, exhausted: false, pctPerStandardPage: 5 } };

  it('versionList IS the shared implementation: same order, numbers and flags as the client timeline', () => {
    expect(versionList).toBe(sharedVersionList);
    const doc = drawnDoc();
    for (const target of [{ kind: 'page', id: 'pg_1' }, { kind: 'sheet', id: 'c_maya' }, { kind: 'page', id: 'pg_3' }, { kind: 'page', id: 'nope' }] as const) {
      expect(versionList(doc, target)).toEqual(sharedVersionList(doc, target));
    }
    expect(versionList(doc, { kind: 'sheet', id: 'c_maya' }).map((e) => [e.n, e.path, e.current])).toEqual([
      [1, 'u/x/maya-v1.webp', false],
      [2, 'u/x/maya-v2.webp', true]
    ]);
  });

  it('a governed user never reads dollars in version and redraw quotes; an admin still does', async () => {
    const g = setup(drawnDoc(), governed);
    const listed = await g.tools().list_versions.execute({ target: 'page 1' });
    const single = await g.tools().use_version.execute({ target: 'page 3', version: 1 });
    const sheet = await g.tools().use_version.execute({ target: 'sheet', name: 'Maya', version: 1 });
    for (const text of [listed, single, sheet]) {
      expect(text).not.toMatch(/\$/);
      expect(text).toMatch(/% of your usage/);
    }
    expect(sheet).toMatch(/^Not switched yet: .*redrawing them later ≈[\d.]+% of your usage\)/);
    const admin = setup(drawnDoc(), { ...governed, admin: true });
    expect(await admin.tools().use_version.execute({ target: 'page 3', version: 1 })).toMatch(/A new take is ≈\$\d/);
  });

  it('fit_render from the director passes caps: its refusal quotes the redraw in usage terms', async () => {
    const doc = drawnDoc();
    const { tools, turn } = setup(doc, governed);
    const out = await tools().fit_render.execute({ target: 'page', page: 3, mode: 'crop' });
    expect(out).toMatch(/would cut 20% of the art/);
    expect(out).toMatch(/redraw it at 4:5 \(≈[\d.]+% of your usage\)/);
    expect(out).not.toMatch(/\$/);
    expect(JSON.stringify(turn.cards)).not.toMatch(/\$/);
  });
});
