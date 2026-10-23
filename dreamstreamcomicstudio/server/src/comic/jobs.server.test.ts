// @vitest-environment node
// P2-SERVER job-runner integration details (wave-2 queue): sanitizer restore paths (contract §5.4),
// chapter titles, balloon z/lock/link, the errorDetail patch, refPaths and continuity, the lazy
// reference check and render-verdict follow-ups (real safety module, fake platform classifier),
// activity cost badges. Fakes only at the network edge; $0.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, type ComicDoc } from '../../../shared/comic/doc.js';
import { applyOps, type DocOp } from '../../../shared/comic/ops.js';
import { canServeToOwner } from '../../../shared/comic/safety.js';
import { JOB_TIMINGS, estimateSpendAction, isOwnProjectAssetPath, mergeBalloons, sanitizePatchOps, sanitizeCtxFor, startAction } from './jobs.js';
import { fakeImages, newSession, plannedDoc, testContext, TINY_PNG } from './orchestrator.fakes.js';
import { installSafetyFakes, resetSafety } from './safety/testkit.js';
import { StudioError } from './types.js';

const TIMINGS = { ...JOB_TIMINGS };
beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.saveRetryMs = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  Object.assign(JOB_TIMINGS, TIMINGS);
  resetSafety();
  vi.restoreAllMocks();
});

const ctxFor = (doc: ComicDoc = plannedDoc()) => {
  const session = newSession(doc);
  const ctx = testContext(session);
  return { session, ctx, sctx: sanitizeCtxFor(ctx) };
};

describe('patch sanitizer (P2-SERVER)', () => {
  it('Undo of character_remove re-creates the character with its photos from THIS project only (rebuilt, unchecked)', () => {
    const doc = plannedDoc();
    const own = 'u/user-1/p/proj-1/ref/face-1.webp';
    doc.cast[0] = { ...doc.cast[0], refs: [{ path: own, source: 'upload', at: 1, safety: { assessed: 'G', at: 1 } }] };
    const removed = applyOps(doc, [{ op: 'character_remove', id: 'c_maya' }]);
    const { sctx } = ctxFor(removed);
    const inverse = {
      op: 'character',
      id: 'c_maya',
      patch: { ...doc.cast[0], refs: [{ ...doc.cast[0].refs[0], safety: { assessed: 'G', at: 1 }, hash: 'forged' }], sheet: { status: 'ready', history: [], asset: { path: 'u/user-1/p/proj-1/img/sheet-1.webp', source: 'generated', at: 1 } } }
    };
    const [op] = sanitizePatchOps(removed, [inverse], sctx) as Extract<DocOp, { op: 'character' }>[];
    expect(op.patch.name).toBe('Maya');
    // The photo comes back WITHOUT the client's verdict or hash: the job runner checks it before its first use.
    expect(op.patch.refs).toEqual([{ path: own, source: 'upload', at: expect.any(Number) }]);
    expect(op.patch.sheet).toMatchObject({ status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/sheet-1.webp' } });
    // Another user's, another project's, a size variant and a quarantine path are refused.
    for (const path of ['u/someone/p/proj-1/ref/x.webp', 'u/user-1/p/other/ref/x.webp', 'u/user-1/p/proj-1/img/gen-1_w480.webp', 'q/user-1/proj-1/q-1.webp', 'pub/AAAAAAAAAAAAAAAAAAAAAA/p1.webp']) {
      expect(() => sanitizePatchOps(removed, [{ op: 'character', id: 'c_new', patch: { name: 'X', refs: [{ path }] } }], sctx)).toThrow(/Invalid character: refs/);
      expect(isOwnProjectAssetPath(path, 'user-1', 'proj-1')).toBe(false);
    }
  });

  it('a path the doc still knows as blocked never comes back as an unchecked photo', () => {
    const doc = plannedDoc();
    const bad = 'u/user-1/p/proj-1/img/bad-take.webp';
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/ok.webp', source: 'generated', at: 1 }, history: [{ path: bad, source: 'generated', at: 1, safety: { assessed: 'X', at: 1 } }] };
    const { sctx } = ctxFor(doc);
    expect(() => sanitizePatchOps(doc, [{ op: 'character', id: 'c_new', patch: { name: 'X', refs: [{ path: bad }] } }], sctx)).toThrow(/Invalid character: refs/);
    // The same shape with a clean own-project path is accepted (rebuilt, unchecked).
    const [op] = sanitizePatchOps(doc, [{ op: 'character', id: 'c_new', patch: { name: 'X', refs: [{ path: 'u/user-1/p/proj-1/ref/fresh.webp' }] } }], sctx) as Extract<DocOp, { op: 'character' }>[];
    expect(op.patch.refs).toEqual([{ path: 'u/user-1/p/proj-1/ref/fresh.webp', source: 'upload', at: expect.any(Number) }]);
  });

  it('a live character never gets its sheet rewritten by a patch; kind and count are accepted', () => {
    const { session, sctx } = ctxFor();
    const [op] = sanitizePatchOps(session.doc, [{ op: 'character', id: 'c_maya', patch: { kind: 'animal', count: 3, sheet: { status: 'ready', history: [] } } }], sctx) as Extract<DocOp, { op: 'character' }>[];
    expect(op.patch).toEqual({ kind: 'animal', count: 3 });
  });

  it('chapter titles set and clear; balloons keep z / lock / link (no self-link, no cycle)', () => {
    const doc = plannedDoc();
    doc.pages[1].panels[2].lines = [{ id: 'ln_2_3', kind: 'speech', speakerId: 'c_arjun', text: 'Second' }];
    doc.pages[1].balloons = [{ lineId: 'ln_2_2', x: 0.1, y: 0.1, w: 0.3, linkTo: 'ln_2_3' }];
    const { sctx } = ctxFor(doc);
    expect(sanitizePatchOps(doc, [{ op: 'page', id: 'pg_1', patch: { chapterTitle: '  Chapter One  ' } }], sctx)).toEqual([{ op: 'page', id: 'pg_1', patch: { chapterTitle: 'Chapter One' } }]);
    expect(sanitizePatchOps(doc, [{ op: 'page', id: 'pg_1', patch: { chapterTitle: '' } }], sctx)).toEqual([{ op: 'page', id: 'pg_1', patch: { chapterTitle: null } }]);
    const [b] = sanitizePatchOps(doc, [{ op: 'balloon', pageId: 'pg_2', lineId: 'ln_2_3', patch: { z: 250, locked: true } }], sctx) as Extract<DocOp, { op: 'balloon' }>[];
    expect(b.patch).toEqual({ z: 100, locked: true });
    expect(() => sanitizePatchOps(doc, [{ op: 'balloon', pageId: 'pg_2', lineId: 'ln_2_3', patch: { linkTo: 'ln_2_3' } }], sctx)).toThrow(/linkTo/);
    // ln_2_2 → ln_2_3 exists, so ln_2_3 → ln_2_2 would close a cycle.
    expect(() => sanitizePatchOps(doc, [{ op: 'balloon', pageId: 'pg_2', lineId: 'ln_2_3', patch: { linkTo: 'ln_2_2' } }], sctx)).toThrow(/linkTo/);
    const [full] = sanitizePatchOps(doc, [{ op: 'balloons', pageId: 'pg_2', balloons: [{ lineId: 'ln_2_3', x: 0.5, y: 0.5, w: 0.2, z: 3, locked: true, linkTo: 'nope' }] }], sctx) as Extract<DocOp, { op: 'balloons' }>[];
    expect(full.balloons[0]).toEqual({ lineId: 'ln_2_3', x: 0.5, y: 0.5, w: 0.2, pinned: true, z: 3, locked: true });
  });

  it('an all-translation batch (Undo of a removed edition) may exceed 200 ops; anything else may not', () => {
    const { session, sctx } = ctxFor();
    const tooMany = Array.from({ length: 201 }, (): unknown => ({ op: 'note_add', text: 'x' }));
    expect(() => sanitizePatchOps(session.doc, tooMany, sctx)).toThrow(/Too many changes/);
    const translations = Array.from({ length: 2001 }, (): unknown => ({ op: 'translation', lang: 'hi', lineId: 'ln_1_2', patch: { text: 'x' } }));
    expect(() => sanitizePatchOps(session.doc, translations, sctx)).toThrow(/Too many changes/);
  });
});

describe('mergeBalloons (lettering.md §9)', () => {
  it('pinned and locked stay put; a re-laid balloon keeps its z and its link to a line still on the page', () => {
    const page = plannedDoc().pages[1];
    page.panels[2].lines = [{ id: 'ln_2_3', kind: 'speech', speakerId: 'c_arjun', text: 'Second' }];
    page.balloons = [
      { lineId: 'ln_2_2', x: 0.1, y: 0.1, w: 0.3, z: 5, linkTo: 'ln_2_3' },
      { lineId: 'ln_2_3', x: 0.6, y: 0.6, w: 0.2, locked: true, pinned: true }
    ];
    const out = mergeBalloons(page, [
      { lineId: 'ln_2_2', x: 0.2, y: 0.2, w: 0.25 },
      { lineId: 'ln_2_3', x: 0.0, y: 0.0, w: 0.2 }
    ], true);
    expect(out).toEqual([
      { lineId: 'ln_2_3', x: 0.6, y: 0.6, w: 0.2, locked: true, pinned: true },
      { lineId: 'ln_2_2', x: 0.2, y: 0.2, w: 0.25, z: 5, linkTo: 'ln_2_3' }
    ]);
    expect(mergeBalloons(page, [], false)).toEqual([]);
  });
});

describe('render runs (P2-SERVER)', () => {
  it('a failed draw sends status, error and the sanitized errorDetail in ONE patch', async () => {
    const doc = plannedDoc();
    doc.cast = doc.cast.map((c) => ({ ...c, sheet: { status: 'ready', history: [], asset: { path: `u/user-1/p/proj-1/img/${c.id}.webp`, source: 'generated', at: 1 } } }));
    doc.planStatus = 'approved';
    const session = newSession(doc);
    const images = fakeImages(() =>
      Object.assign(new StudioError('PROVIDER_ERROR', 'The image service had a problem.', { status: 502 }), { imageFailure: { route: 'openrouter', status: 500, providerName: 'Google' } })
    );
    const ctx = testContext(session, { images });
    const started = await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], quotedUsd: estimateSpendAction(doc, { type: 'render_pages', pageIds: ['pg_1'] }, false).usd }, { confirmed: true, origin: 'user' });
    await started.done;
    const failedPatch = ctx.events
      .flatMap((e) => (e.type === 'ops' ? e.ops : []))
      .find((op) => op.op === 'render' && op.patch.status === 'failed') as Extract<DocOp, { op: 'render' }>;
    expect(failedPatch.patch).toMatchObject({ status: 'failed', error: 'The image service had a problem.', errorDetail: { code: '500', provider: 'OpenRouter' } });
    expect(failedPatch.patch.errorDetail!.text).toMatch(/^OpenRouter · 500 · upstream Google · \d\d:\d\d UTC$/);
    expect(session.doc.pages[0].render.errorDetail).toMatchObject({ code: '500' });
    // The live status line carries the Image badge.
    expect(ctx.events.some((e) => e.type === 'activity' && e.cost === 'image' && e.phase === 'start')).toBe(true);
  });

  it('a sheet drawn without photos records refPaths: [] ; page 2 records page 1 as its continuity (by path)', async () => {
    const doc = plannedDoc();
    doc.planStatus = 'approved';
    const session = newSession(doc);
    const ctx = testContext(session);
    const sheet = await startAction(ctx, { type: 'render_sheets', characterIds: ['c_maya'], quotedUsd: estimateSpendAction(doc, { type: 'render_sheets', characterIds: ['c_maya'] }, false).usd }, { confirmed: true, origin: 'user' });
    await sheet.done;
    expect(session.doc.cast[0].sheet.refPaths).toEqual([]);
    const pages = await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1', 'pg_2'], quotedUsd: 99 }, { confirmed: true, origin: 'user' });
    await pages.done;
    await ctx.settled();
    const [p1, p2] = session.doc.pages;
    expect(p1.render.status).toBe('ready');
    expect(p2.render.continuityPath).toBe(p1.render.asset!.path);
    expect(p1.render.continuityPath).toBeUndefined();
  });
});

describe('the real safety module in a render run (fake platform classifier)', () => {
  it('an unchecked uploaded photo is checked before its first use; a blocked one is left out, said honestly', async () => {
    const safety = installSafetyFakes();
    const blockedX = { rating: 'X', categories: ['nudity'], notes: [], photo: true, minorLikely: false, subject: 'person', view: 'none', caption: '', multipleSubjects: false };
    safety.llm.script.vision = [blockedX];
    const doc = plannedDoc();
    const refPath = 'u/user-1/p/proj-1/ref/unchecked.webp';
    doc.cast[0] = { ...doc.cast[0], refs: [{ path: refPath, source: 'upload', at: 1 }] };
    const session = newSession(doc);
    const ctx = testContext(session);
    ctx.assetsFake.files.set(refPath, TINY_PNG);
    const run = await startAction(ctx, { type: 'render_sheets', characterIds: ['c_maya'], quotedUsd: 1 }, { confirmed: true, origin: 'user' });
    await run.done;
    await ctx.settled();
    // Checked once, verdict stored on the ref (blocked → never attached).
    expect(session.doc.cast[0].refs[0].safety?.assessed).toBe('X');
    expect(ctx.imagesFake.calls[0].references.some((r) => r.label.includes('AUTHOR REFERENCE'))).toBe(false);
    expect(session.doc.cast[0].sheet.refPaths).toEqual([]);
    const done = [...session.doc.conversation].reverse().find((m) => m.role === 'assistant')!;
    expect(done.cards?.some((c) => c.type === 'notice' && /reference photos? didn't pass the content check/.test(c.text))).toBe(true);
  });

  it('a blocked render: the verdict follow-ups ("redraw safer") ride the run summary, the image is never published', async () => {
    const safety = installSafetyFakes();
    safety.llm.script.vision = [{ rating: 'X', categories: ['graphic_gore'], notes: ['too much'], photo: false, minorLikely: false, subject: 'other', view: 'none', caption: '', multipleSubjects: false }];
    const doc = plannedDoc();
    const session = newSession(doc);
    const ctx = testContext(session);
    const run = await startAction(ctx, { type: 'render_sheets', characterIds: ['c_arjun'], quotedUsd: 1 }, { confirmed: true, origin: 'user' });
    await run.done;
    await ctx.settled();
    const sheet = session.doc.cast[1].sheet;
    expect(ctx.assetsFake.quarantined.length).toBe(1);
    const summary = [...session.doc.conversation].reverse().find((m) => m.role === 'assistant')!;
    expect(summary.text).toMatch(/didn't fit the content rules/);
    expect(summary.cards?.some((c) => c.type === 'notice' && /didn't fit the content rules/.test(c.text))).toBe(true);
    // The verdict's chips, priced: a redraw (with its quote) and a free second look.
    const redraw = (summary.nextSteps || []).find((s) => s.label === 'Redraw the sheet');
    expect(redraw).toMatchObject({ action: { type: 'render_sheets', characterIds: ['c_arjun'], force: true, quotedUsd: expect.any(Number) } });
    expect(redraw!.usd).toBeGreaterThan(0);
    expect((summary.nextSteps || []).some((s) => s.action?.type === 'safety_recheck')).toBe(true);
    const signed = ctx.assetsFake.signed.flat();
    expect(signed).not.toContain(ctx.assetsFake.quarantined[0].path);
    // A first take has no earlier version to fall back to: it stays, withheld (never served to anyone).
    expect(canServeToOwner(sheet.asset)).toBe(false);
    expect(sheet.asset?.safety).toMatchObject({ assessed: 'X', quarantined: true });
  });
});

describe('relayout is free (activity badge)', () => {
  it('relayout_balloons says Free on the status line and makes no AI call', async () => {
    const doc = plannedDoc();
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/p1.webp', source: 'generated', at: 1 } };
    const { session, ctx } = ctxFor(doc);
    const out = await startAction(ctx, { type: 'relayout_balloons', pageId: 'pg_1' }, { confirmed: false, origin: 'user' });
    expect(out.outcome.message).toMatch(/free — no AI call/);
    expect(ctx.events.some((e) => e.type === 'activity' && e.cost === 'free')).toBe(true);
    expect(ctx.llmFake.calls).toHaveLength(0);
    expect(session.doc.pages[0].balloons.map((b) => b.lineId)).toEqual(['ln_1_2']);
  });
});
