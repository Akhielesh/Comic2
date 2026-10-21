import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, pageSpecHash, type Card, type ComicDoc, type Page } from '../../../shared/comic/doc.js';
import type { SpendAction } from '../../../shared/comic/ops.js';
import { PLATFORM_MARKUP, QC_USD_PER_PAGE, estimateJobs, imagePriceUsd, resolveImageJob, type SpendEstimate } from '../../../shared/comic/models.js';
import {
  JOB_TIMINGS,
  estimateSpendAction,
  gateDecision,
  pickDefaultPreset,
  runAction,
  sanitizePatchOps,
  startAction,
  suggestNextSteps
} from './jobs.js';
import { KEYS, fakeBilling, fakeImages, newSession, opsOf, plannedDoc, scriptedLlm, testContext, TINY_PNG } from './orchestrator.fakes.js';
import { StudioError } from './types.js';
import { analyzePageRender } from './vision.js';
import { proposeStyleDirections, writePagePlan } from './writer.js';

vi.mock('./vision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vision.js')>();
  return { ...actual, analyzePageRender: vi.fn(actual.analyzePageRender) };
});
vi.mock('./writer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./writer.js')>();
  return { ...actual, writePagePlan: vi.fn(actual.writePagePlan), proposeStyleDirections: vi.fn(actual.proposeStyleDirections) };
});

const quiet = () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
};

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.saveRetryMs = 0;
  quiet();
  vi.mocked(analyzePageRender).mockRejectedValue(new StudioError('RATE_LIMIT', 'The page checker is busy.', { retryable: true }));
});
afterEach(() => {
  vi.mocked(analyzePageRender).mockReset();
  vi.mocked(writePagePlan).mockReset();
  vi.mocked(proposeStyleDirections).mockReset();
  vi.restoreAllMocks();
});

const estimate = (usd: number): SpendEstimate => ({ usd, imageCount: 1, model: 'Nano Banana 2.1', lines: [] });
const cardsOf = (doc: ComicDoc): Card[] => doc.conversation.flatMap((m) => m.cards || []);
const readyPage = (page: Page, path: string): Page => ({
  ...page,
  render: { ...emptyRender(), status: 'ready', asset: { path, source: 'generated', at: 1, w: 1024, h: 1536 } }
});

// ── Gate decision ────────────────────────────────────────────────────────────

describe('gateDecision', () => {
  const withSettings = (patch: Partial<ComicDoc['settings']>, spent = 0): ComicDoc => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, ...patch };
    doc.spend = { ...doc.spend, totalUsd: spent };
    return doc;
  };

  it.each([
    ['always', 0.01, false, 'policy'],
    ['always', 0.01, true, null],
    ['big', 0.49, false, null],
    ['big', 0.51, false, 'policy'],
    ['big', 5, true, null],
    ['never', 50, false, null]
  ] as const)('confirm=%s usd=%s confirmed=%s → %s', (confirm, usd, confirmed, want) => {
    expect(gateDecision(withSettings({ confirm, bigSpendUsd: 0.5 }), estimate(usd), confirmed)).toBe(want);
  });

  it('stops at the budget cap even when confirmed, unless a budget gate was approved', () => {
    const doc = withSettings({ confirm: 'never', budgetUsd: 1 }, 0.8);
    expect(gateDecision(doc, estimate(0.3), true)).toBe('budget');
    expect(gateDecision(doc, estimate(0.3), false)).toBe('budget');
    expect(gateDecision(doc, estimate(0.2), true)).toBeNull();
    expect(gateDecision(doc, estimate(0.3), true, { budgetApproved: true })).toBeNull();
  });

  it('treats a zero/absent budget as no cap', () => {
    expect(gateDecision(withSettings({ confirm: 'never', budgetUsd: 0 }, 99), estimate(10), true)).toBeNull();
  });
});

// ── Estimates ────────────────────────────────────────────────────────────────

describe('estimateSpendAction', () => {
  const price = (kind: 'page' | 'sheet' | 'style_option' | 'cover' | 'edit', byok = false) => {
    const { spec, resolution } = resolveImageJob(kind, 'standard');
    return (imagePriceUsd(spec, resolution) + (kind === 'page' || kind === 'edit' ? QC_USD_PER_PAGE : 0)) * (byok ? 1 : PLATFORM_MARKUP);
  };

  it('style options: 3 by default, else the number of directions', () => {
    const doc = plannedDoc();
    expect(estimateSpendAction(doc, { type: 'render_style_options' }, false).imageCount).toBe(3);
    expect(estimateSpendAction(doc, { type: 'render_style_options', directions: [{ name: 'a', spec: 'b' }, { name: 'c', spec: 'd' }] }, false).imageCount).toBe(2);
  });

  it('sheets: lead/support without a ready sheet, or the forced ids', () => {
    const doc = plannedDoc();
    doc.cast.push({ id: 'c_extra', name: 'Crowd', tier: 'extra', look: { summary: 'people' }, refs: [], sheet: emptyRender() });
    expect(estimateSpendAction(doc, { type: 'render_sheets' }, false).imageCount).toBe(2);
    doc.cast[0].sheet = { ...emptyRender(), status: 'ready', asset: { path: 's.webp', source: 'generated', at: 1 } };
    expect(estimateSpendAction(doc, { type: 'render_sheets' }, false).imageCount).toBe(1);
    expect(estimateSpendAction(doc, { type: 'render_sheets', characterIds: ['c_maya'] }, false).imageCount).toBe(0);
    expect(estimateSpendAction(doc, { type: 'render_sheets', characterIds: ['c_maya'], force: true }, false).imageCount).toBe(1);
    expect(estimateSpendAction(doc, { type: 'render_sheets', characterIds: ['pl_market'] }, false).lines).toEqual([
      { label: 'location sheets', count: 1, usd: expect.any(Number) }
    ]);
  });

  it('pages: undrawn + stale pages, plus missing sheets for their lead/support cast', () => {
    const doc = plannedDoc();
    const est = estimateSpendAction(doc, { type: 'render_pages' }, false);
    expect(est.imageCount).toBe(5);
    expect(est.usd).toBeCloseTo(3 * price('page') + 2 * price('sheet'), 3);
    expect(est.model).toBe('Nano Banana 2.1');

    // Page 1 drawn and current; page 3 drawn but stale; sheets ready for Maya.
    doc.cast[0].sheet = { ...emptyRender(), status: 'ready', asset: { path: 's.webp', source: 'generated', at: 1 } };
    doc.pages[0] = readyPage(doc.pages[0], 'p1.webp');
    doc.pages[0].render.specHash = pageSpecHash(doc, doc.pages[0]);
    doc.pages[2] = readyPage(doc.pages[2], 'p3.webp');
    doc.pages[2].render.specHash = 'outdated';
    const next = estimateSpendAction(doc, { type: 'render_pages' }, false);
    expect(next.lines).toEqual([
      { label: 'pages', count: 2, usd: expect.any(Number) },
      { label: 'character sheets', count: 1, usd: expect.any(Number) }
    ]);
    // Explicit pages + force redraws a current page.
    expect(estimateSpendAction(doc, { type: 'render_pages', pageIds: ['pg_1'], force: true }, false).imageCount).toBe(1);
    expect(estimateSpendAction(doc, { type: 'render_pages', pageIds: ['pg_1'] }, false).imageCount).toBe(0);
  });

  it('edit and cover are one image each; BYOK drops the platform markup', () => {
    const doc = plannedDoc();
    expect(estimateSpendAction(doc, { type: 'edit_page', pageId: 'pg_1', instruction: 'x' }, false).usd).toBeCloseTo(price('edit'), 4);
    expect(estimateSpendAction(doc, { type: 'render_cover' }, true).usd).toBeCloseTo(price('cover', true), 4);
    expect(estimateSpendAction(doc, { type: 'render_cover' }, false).usd).toBeCloseTo(
      estimateJobs([{ kind: 'cover', count: 1 }], 'standard', { byok: false }).usd,
      4
    );
  });
});

// ── render_pages ─────────────────────────────────────────────────────────────

describe('runAction render_pages', () => {
  it('draws sheets first, page 1 alone, then the rest; records spend, QC fallback balloons and urls', async () => {
    const session = newSession(plannedDoc());
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });

    const calls = ctx.imagesFake.calls;
    expect(calls).toHaveLength(5);
    expect(calls.slice(0, 2).every((c) => c.prompt.includes('Character model sheet'))).toBe(true);
    expect(calls[2].prompt).toContain('Action 1.1');
    expect(calls.slice(3).map((c) => (c.prompt.includes('Action 2.1') ? 2 : 3)).sort()).toEqual([2, 3]);
    // Page 1 uses the freshly drawn sheet; later pages get page 1 as continuity.
    expect(calls[2].references.map((r) => r.label)).toContain('CHARACTER SHEET: MAYA');
    expect(calls[3].references.map((r) => r.label)).toContain('PREVIOUS PAGE');

    const doc = session.doc;
    expect(doc.cast.every((c) => c.sheet.status === 'ready' && c.sheet.asset)).toBe(true);
    for (const page of doc.pages) {
      expect(page.render.status).toBe('ready');
      expect(page.render.asset?.path).toMatch(/gen-/);
      expect(page.render.model).toBe('nano-banana-2.1');
      expect(page.render.attempts).toBe(1);
      expect(page.render.specHash).toBe(pageSpecHash(doc, page));
      // QC failed → layout-based balloons for every line, no QC report claimed.
      expect(page.render.qc).toBeUndefined();
      expect(page.balloons.map((b) => b.lineId)).toEqual(page.panels.flatMap((p) => p.lines.map((l) => l.id)));
    }
    expect(doc.planStatus).toBe('approved');

    const entries = doc.spend.entries;
    expect(entries.filter((e) => e.kind === 'sheet')).toHaveLength(2);
    expect(entries.filter((e) => e.kind === 'page').map((e) => e.label).sort()).toEqual(['Page 1', 'Page 2', 'Page 3']);
    for (const e of entries.filter((x) => x.kind === 'page')) {
      expect(e).toMatchObject({ usd: Math.round(0.05 * PLATFORM_MARKUP * 10000) / 10000, byok: false, estimated: false, model: 'nano-banana-2.1' });
    }
    expect(doc.spend.totalUsd).toBeCloseTo(5 * 0.05 * PLATFORM_MARKUP, 4);
    expect(ctx.billingFake.reserves.filter((r) => r.operation === 'comic.image.page')).toHaveLength(3);
    expect(ctx.billingFake.settled.filter((s) => s.imageUnits === 1)).toHaveLength(5);

    const urlEvents = ctx.events.filter((e) => e.type === 'urls');
    expect(urlEvents).toHaveLength(5);
    // Progress message: one assistant message with a renders card, summarized at the end.
    const progress = doc.conversation.find((m) => m.cards?.some((c) => c.type === 'renders'));
    expect(progress?.text).toMatch(/^Done — 3 pages, 2 sheets/);
    // Activity start/end pairs for every image.
    const starts = ctx.events.filter((e) => e.type === 'activity' && e.phase === 'start' && e.label.startsWith('Drawing page'));
    expect(starts.map((e) => (e as { label: string }).label)).toEqual(expect.arrayContaining(['Drawing page 1', 'Drawing page 2', 'Drawing page 3']));
    // Nothing is left queued, ever.
    expect(opsOf(ctx.events).some((op) => op.op === 'render' && op.patch.status === 'queued')).toBe(true);
  });

  it('commits QC + balloons from vision, keeps pinned balloons, and warns on a low score', async () => {
    const doc = plannedDoc();
    doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } }));
    doc.pages[1].balloons = [{ lineId: 'ln_2_2', x: 0.5, y: 0.5, w: 0.2, pinned: true }];
    const session = newSession(doc);
    const ctx = testContext(session);
    vi.mocked(analyzePageRender).mockImplementation(async ({ page, llm }) => ({
      ...(await llm.complete({ role: 'vision', messages: [{ role: 'user', content: 'check' }] }).then(() => ({}))),
      qc: { score: page.n === 2 ? 0.3 : 0.9, issues: page.n === 2 ? ['ARJUN is missing from panel 2.'] : [], checkedAt: 1 },
      balloons: page.panels.flatMap((p) => p.lines.map((l) => ({ lineId: l.id, x: 0.1, y: 0.1, w: 0.3 }))),
      costUsd: 0.002,
      model: 'vision-x'
    }));
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const after = session.doc;
    expect(after.pages[0].render.qc?.score).toBe(0.9);
    expect(after.pages[1].balloons).toEqual([{ lineId: 'ln_2_2', x: 0.5, y: 0.5, w: 0.2, pinned: true }]);
    expect(after.pages[0].balloons).toEqual([{ lineId: 'ln_1_2', x: 0.1, y: 0.1, w: 0.3 }]);
    const warn = cardsOf(after).find((c) => c.type === 'notice' && c.tone === 'warn');
    expect(warn && 'text' in warn ? warn.text : '').toContain('Page 2 may need another pass');
    expect(after.spend.entries.filter((e) => e.kind === 'qc')).toHaveLength(3);
    expect(ctx.imagesFake.calls).toHaveLength(3);
  });

  it('billing denial fails that image, stops the rest (restored, never queued) and posts an error notice', async () => {
    const doc = plannedDoc();
    doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } }));
    const session = newSession(doc);
    const ctx = testContext(session, { billing: fakeBilling(1) });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const after = session.doc;
    expect(after.pages[0].render.status).toBe('ready');
    const others = after.pages.slice(1).map((p) => p.render);
    expect(others.filter((r) => r.status === 'failed')).toHaveLength(1);
    expect(others.filter((r) => r.status === 'none')).toHaveLength(1);
    expect(others.find((r) => r.status === 'failed')?.error).toContain('allowance');
    expect(after.pages.some((p) => p.render.status === 'queued' || p.render.status === 'rendering')).toBe(false);
    expect(ctx.imagesFake.calls).toHaveLength(1);
    const errorCard = cardsOf(after).find((c) => c.type === 'notice' && c.tone === 'error');
    expect(errorCard && 'text' in errorCard ? errorCard.text : '').toContain('allowance');
  });

  it('retries a retryable image error once, and marks a hard error failed with its message', async () => {
    const doc = plannedDoc();
    doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } }));
    const session = newSession(doc);
    const images = fakeImages((req, i) => {
      if (req.prompt.includes('Action 1.1') && i === 0) return new StudioError('TIMEOUT', 'The image provider timed out.', { retryable: true });
      if (req.prompt.includes('Action 2.1')) return new StudioError('SAFETY_BLOCKED', 'The safety filter blocked this page.', { retryable: false });
      return undefined;
    });
    const ctx = testContext(session, { images });
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    const [p1, p2, p3] = session.doc.pages;
    expect(p1.render).toMatchObject({ status: 'ready', attempts: 2 });
    expect(p2.render).toMatchObject({ status: 'failed', error: 'The safety filter blocked this page.', attempts: 1 });
    expect(p3.render.status).toBe('ready');
    expect(ctx.billingFake.released).toHaveLength(1);
    const progress = session.doc.conversation.find((m) => m.cards?.some((c) => c.type === 'renders'));
    expect(progress?.text).toContain('Page 2: The safety filter blocked this page.');
  });

  it('records money spent on a failed attempt as an estimated spend line', async () => {
    const doc = plannedDoc();
    doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } }));
    const session = newSession(doc);
    const images = fakeImages(() => Object.assign(new StudioError('NO_IMAGE', 'No image came back.', { retryable: false }), { spentUsd: 0.01 }));
    const ctx = testContext(session, { images });
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], force: true }, { confirmed: true });
    expect(session.doc.spend.entries.map((e) => e.label)).toEqual(['Page 1 (failed attempt)']);
    expect(ctx.billingFake.settled).toEqual([{ costUsd: 0.01, imageUnits: 0 }]);
  });

  it('cancel stops unstarted work and restores previous statuses; in-flight images are kept', async () => {
    const doc = plannedDoc();
    doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } }));
    doc.pages[2] = readyPage(doc.pages[2], 'old-p3.webp');
    const session = newSession(doc);
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => (markStarted = resolve));
    const images = fakeImages(async (_req, i) => {
      if (i === 0) {
        markStarted();
        await new Promise<void>((r) => (releaseFirst = r));
      }
      return undefined;
    });
    const ctx = testContext(session, { images });
    const run = runAction(ctx, { type: 'render_pages', force: true }, { confirmed: true });
    await firstStarted;
    expect(session.doc.pages[1].render.status).toBe('queued');
    session.abort.abort();
    releaseFirst();
    await run;
    const [p1, p2, p3] = session.doc.pages;
    expect(p1.render.status).toBe('ready');
    expect(p2.render.status).toBe('none');
    expect(p3.render).toMatchObject({ status: 'ready', asset: { path: 'old-p3.webp' } });
    expect(ctx.imagesFake.calls).toHaveLength(1);
    const progress = session.doc.conversation.find((m) => m.cards?.some((c) => c.type === 'renders'));
    expect(progress?.text).toContain('Stopped before');
  });

  it('drops a reference that cannot be loaded and recompiles so labels stay aligned', async () => {
    const doc = plannedDoc();
    doc.cast[0].sheet = { ...emptyRender(), status: 'ready', asset: { path: 'gone.webp', source: 'generated', at: 1 } };
    doc.cast[1].sheet = { ...emptyRender(), status: 'ready', asset: { path: 'arjun.webp', source: 'generated', at: 1 } };
    const session = newSession(doc);
    const ctx = testContext(session);
    ctx.assetsFake.missing.add('gone.webp');
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_2'], force: true }, { confirmed: true });
    const call = ctx.imagesFake.calls[0];
    expect(call.references.map((r) => r.label)).not.toContain('CHARACTER SHEET: MAYA');
    expect(call.references[0].label).toBe('CHARACTER SHEET: ARJUN');
    expect(call.prompt).toContain('Image 1 — CHARACTER SHEET: ARJUN');
    expect(call.prompt).not.toContain('CHARACTER SHEET: MAYA');
    expect(session.doc.pages[1].render.status).toBe('ready');
  });

  it('sets a default style from the best-fitting preset when none was chosen', async () => {
    const doc = plannedDoc();
    doc.style = { status: 'empty', refs: [], options: [] };
    doc.brief.genre = 'crime mystery';
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_sheets' }, { confirmed: true });
    expect(session.doc.style).toMatchObject({ status: 'drafted', presetId: pickDefaultPreset(doc).id });
    expect(cardsOf(session.doc).some((c) => c.type === 'notice' && c.text.includes('No style was chosen'))).toBe(true);
  });
});

// ── Gating ───────────────────────────────────────────────────────────────────

describe('spend gating', () => {
  it('policy gate: no spend, a gate card; approving runs it', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    const session = newSession(doc);
    const ctx = testContext(session);
    const started = await startAction(ctx, { type: 'render_cover' }, { confirmed: false });
    expect(started.outcome.status).toBe('gated');
    expect(started.outcome.message).toMatch(/^Waiting for the user to approve ~\$0\.\d\d \(the cover on Nano Banana 2\.1\)\.$/);
    expect(ctx.imagesFake.calls).toHaveLength(0);
    const gate = session.doc.gate!;
    expect(gate).toMatchObject({ status: 'open', reason: 'policy', imageCount: 1, model: 'Nano Banana 2.1', action: { type: 'render_cover' } });
    expect(cardsOf(session.doc)).toContainEqual(expect.objectContaining({ type: 'gate', gateId: gate.id }));

    await runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: false });
    expect(session.doc.gate?.status).toBe('approved');
    expect(session.doc.cover.render.status).toBe('ready');
    expect(ctx.imagesFake.calls).toHaveLength(1);
  });

  it('collects the gate card for a director turn instead of posting a message', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    const session = newSession(doc);
    const ctx = testContext(session);
    const collected: Card[] = [];
    await startAction(ctx, { type: 'render_pages' }, { confirmed: false, collectCard: (c) => collected.push(c) });
    expect(collected).toEqual([expect.objectContaining({ type: 'gate' })]);
    expect(session.doc.conversation).toHaveLength(0);
  });

  it('budget gate applies to confirmed clicks; approving it allows going over once', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, confirm: 'never', budgetUsd: 0.05 };
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_cover' }, { confirmed: true });
    const gate = session.doc.gate!;
    expect(gate.reason).toBe('budget');
    expect(gate.summary).toContain('over your $0.05 budget');
    expect(ctx.imagesFake.calls).toHaveLength(0);
    await runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: true });
    expect(ctx.imagesFake.calls).toHaveLength(1);
  });

  it('approving a gate runs exactly what was quoted; a grown plan or new model re-quotes', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, { confirmed: false });
    const first = session.doc.gate!;
    expect(first.action).toMatchObject({ type: 'render_pages', pageIds: ['pg_1'] });
    // The quality jumps to Pro after the card was shown: approving must not run the pricier spend.
    session.commit([{ op: 'settings', patch: { quality: 'pro' } }]);
    await runAction(ctx, { type: 'approve_gate', gateId: first.id }, { confirmed: false });
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(session.doc.gate?.id).not.toBe(first.id);
    expect(session.doc.gate).toMatchObject({ status: 'open', model: 'Nano Banana Pro' });
  });

  it('an open-ended render gate is pinned to the pages it quoted', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_pages' }, { confirmed: false });
    expect(session.doc.gate?.action).toMatchObject({ type: 'render_pages', pageIds: ['pg_1', 'pg_2', 'pg_3'] });
  });

  it('advanced model overrides are paid-plan only on the platform key', async () => {
    const doc = plannedDoc();
    doc.settings.imageModelOverride = 'flux-3';
    const session = newSession(doc);
    const ctx = testContext(session);
    (ctx as { qualityDenied?: string }).qualityDenied = 'Needs a paid plan.';
    const blocked = await startAction(ctx, { type: 'render_cover' }, { confirmed: true });
    expect(blocked.outcome.status).toBe('blocked');
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('decline closes the gate; a stale gate id is rejected', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_cover' }, { confirmed: false });
    const gate = session.doc.gate!;
    await runAction(ctx, { type: 'decline_gate', gateId: gate.id }, { confirmed: false });
    expect(session.doc.gate?.status).toBe('declined');
    await expect(runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: false })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('blocks without keys and for Pro without access — with a notice, no spend', async () => {
    const session = newSession(plannedDoc());
    const noKeys = testContext(session, { keys: {} });
    const blocked = await startAction(noKeys, { type: 'render_cover' }, { confirmed: true });
    expect(blocked.outcome).toMatchObject({ status: 'blocked', message: expect.stringContaining('Connect a Gemini or OpenRouter key') });

    const pro = newSession({ ...plannedDoc('p2'), settings: { ...plannedDoc().settings, quality: 'pro' } });
    const ctx = testContext(pro);
    const denied = await startAction(ctx, { type: 'render_pages' }, { confirmed: true, qualityDenied: 'Pro quality needs a paid plan.' });
    expect(denied.outcome.status).toBe('blocked');
    expect(ctx.imagesFake.calls).toHaveLength(0);
    // Style options never run on Pro, so they are allowed.
    vi.mocked(proposeStyleDirections).mockResolvedValue({ options: [{ name: 'A', spec: 'spec a' }], model: 'w' });
    const allowed = await startAction(ctx, { type: 'render_style_options' }, { confirmed: true, qualityDenied: 'Pro quality needs a paid plan.' });
    expect(allowed.outcome.status).toBe('started');
    await allowed.done;
  });

  it('nothing to draw → an info notice, no gate', async () => {
    const doc = plannedDoc();
    doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } }));
    const session = newSession(doc);
    const started = await startAction(testContext(session), { type: 'render_sheets' }, { confirmed: false });
    expect(started.outcome).toMatchObject({ status: 'blocked', message: 'All character sheets are already drawn.' });
    expect(session.doc.gate).toBeNull();
  });
});

// ── Edits ────────────────────────────────────────────────────────────────────

describe('edit_page', () => {
  it('outlines the region on the current page, substitutes it as Image 2, and versions the result', async () => {
    const doc = plannedDoc();
    doc.pages[0] = readyPage(doc.pages[0], 'u/user-1/p/proj-1/img/page1.webp');
    const session = newSession(doc);
    const ctx = testContext(session);
    ctx.assetsFake.files.set('u/user-1/p/proj-1/img/page1.webp', 'data:image/png;base64,Q1VSUkVOVA==');
    const action: SpendAction = { type: 'edit_page', pageId: 'pg_1', instruction: 'Make it night', region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, panelN: 2 };
    await runAction(ctx, action, { confirmed: true });

    expect(ctx.assetsFake.outlines).toEqual([{ dataUrl: 'data:image/png;base64,Q1VSUkVOVA==', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }]);
    const call = ctx.imagesFake.calls[0];
    expect(call.references[0]).toEqual({ label: 'CURRENT PAGE', dataUrl: 'data:image/png;base64,Q1VSUkVOVA==' });
    expect(call.references[1]).toEqual({ label: 'SAME PAGE — AREA TO CHANGE OUTLINED IN RED', dataUrl: 'data:image/png;base64,T1VUTElORUQ=' });
    expect(call.prompt).toContain('Make it night');
    const page = session.doc.pages[0];
    expect(page.render.status).toBe('ready');
    expect(page.render.asset?.path).toMatch(/gen-/);
    expect(page.render.history[0].path).toBe('u/user-1/p/proj-1/img/page1.webp');
    expect(session.doc.spend.entries[0]).toMatchObject({ kind: 'edit', label: 'Edit page 1' });
  });

  it('a failed edit keeps the page as it was and explains', async () => {
    const doc = plannedDoc();
    doc.pages[0] = readyPage(doc.pages[0], 'page1.webp');
    const session = newSession(doc);
    const ctx = testContext(session, { images: fakeImages(() => new StudioError('SAFETY_BLOCKED', 'Blocked by the safety filter.')) });
    await runAction(ctx, { type: 'edit_page', pageId: 'pg_1', instruction: 'Add a dragon' }, { confirmed: true });
    expect(session.doc.pages[0].render).toMatchObject({ status: 'ready', asset: { path: 'page1.webp' }, error: 'Blocked by the safety filter.' });
    expect(cardsOf(session.doc).some((c) => c.type === 'notice' && c.text.includes("Edit page 1 didn't work"))).toBe(true);
  });

  it('rejects an edit of an undrawn page', async () => {
    const ctx = testContext(newSession(plannedDoc()));
    await expect(runAction(ctx, { type: 'edit_page', pageId: 'pg_1', instruction: 'x' }, { confirmed: true })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

// ── Style options & doc-only actions ─────────────────────────────────────────

describe('style options and doc actions', () => {
  it('renders given directions, then replaces the progress card with a style_choice card; pick_style locks it', async () => {
    const doc = plannedDoc();
    doc.style.options = [{ id: 'old', name: 'Old', spec: 'old', render: emptyRender() }];
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_style_options', directions: [{ name: 'Ink Noir', spec: 'Heavy blacks' }, { name: 'Pastel', spec: 'Soft' }] }, { confirmed: true });
    const options = session.doc.style.options;
    expect(options.map((o) => o.name)).toEqual(['Ink Noir', 'Pastel']);
    expect(options.every((o) => o.render.status === 'ready')).toBe(true);
    expect(ctx.imagesFake.calls.every((c) => c.aspect === '4:5')).toBe(true);
    const msg = session.doc.conversation.find((m) => m.cards?.some((c) => c.type === 'style_choice'));
    expect(msg?.cards?.some((c) => c.type === 'renders')).toBe(false);
    expect(session.doc.spend.entries.filter((e) => e.kind === 'style')).toHaveLength(2);

    await runAction(ctx, { type: 'pick_style', optionId: options[0].id }, { confirmed: false });
    expect(session.doc.style).toMatchObject({ status: 'locked', name: 'Ink Noir', spec: 'Heavy blacks', board: options[0].render.asset });
  });

  it('proposes directions with the writer when none are given (billed as style spend)', async () => {
    const session = newSession(plannedDoc());
    const ctx = testContext(session);
    vi.mocked(proposeStyleDirections).mockImplementation(async ({ llm }) => {
      await llm.complete({ role: 'writer', messages: [{ role: 'user', content: 'go' }] });
      return { options: [{ name: 'A', spec: 'a' }, { name: 'B', spec: 'b' }, { name: 'C', spec: 'c' }], model: 'w' };
    });
    await runAction(ctx, { type: 'render_style_options' }, { confirmed: true });
    expect(session.doc.style.options).toHaveLength(3);
    expect(session.doc.spend.entries.map((e) => e.label)).toContain('Style directions');
    expect(ctx.billingFake.reserves[0]).toMatchObject({ operation: 'comic.text.writer', stage: 'style' });
  });

  it('plan_pages commits pages + new cast, a plan card, and plan spend; a re-plan keeps drawn pages as out of date', async () => {
    const doc = plannedDoc();
    doc.pages[0] = readyPage(doc.pages[0], 'p1.webp');
    const session = newSession(doc);
    const ctx = testContext(session);
    const fresh = plannedDoc().pages.map((p) => ({ ...p, id: `new_${p.n}`, summary: `New ${p.n}` }));
    vi.mocked(writePagePlan).mockImplementation(async ({ llm }) => {
      await llm.complete({ role: 'writer', messages: [{ role: 'user', content: 'plan' }] });
      return {
        pages: fresh,
        newCast: [{ id: 'c_new', name: 'Nani', tier: 'support', look: { summary: 'grandmother' }, refs: [], sheet: emptyRender() }],
        model: 'writer-x'
      };
    });
    await runAction(ctx, { type: 'plan_pages', instructions: 'faster' }, { confirmed: false });
    const after = session.doc;
    expect(after.pages.map((p) => p.id)).toEqual(['pg_1', 'pg_2', 'pg_3']);
    expect(after.pages[0].summary).toBe('New 1');
    expect(after.pages[0].render.asset?.path).toBe('p1.webp');
    expect(after.planStatus).toBe('draft');
    expect(after.cast.map((c) => c.name)).toContain('Nani');
    expect(cardsOf(after).some((c) => c.type === 'plan')).toBe(true);
    expect(after.spend.entries[0]).toMatchObject({ kind: 'plan', label: 'Page plan' });
    expect(vi.mocked(writePagePlan).mock.calls[0][0].instructions).toBe('faster');
  });

  it('approve_plan, restore_render and relayout_balloons', async () => {
    const doc = plannedDoc();
    doc.pages[0] = {
      ...doc.pages[0],
      render: { ...emptyRender(), status: 'ready', asset: { path: 'v2.webp', source: 'generated', at: 2 }, history: [{ path: 'v1.webp', source: 'generated', at: 1 }], specHash: 'h', qc: { score: 0.9, issues: [], checkedAt: 1 } }
    };
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'approve_plan' }, { confirmed: false });
    expect(session.doc.planStatus).toBe('approved');

    await expect(runAction(ctx, { type: 'restore_render', target: { kind: 'page', id: 'pg_1' }, path: 'nope.webp' }, { confirmed: false })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await runAction(ctx, { type: 'restore_render', target: { kind: 'page', id: 'pg_1' }, path: 'v1.webp' }, { confirmed: false });
    const r = session.doc.pages[0].render;
    expect(r.asset?.path).toBe('v1.webp');
    expect(r.history[0].path).toBe('v2.webp');
    expect(r.qc).toBeUndefined();

    await runAction(ctx, { type: 'relayout_balloons', pageId: 'pg_1' }, { confirmed: false });
    expect(session.doc.pages[0].balloons.map((b) => b.lineId)).toEqual(['ln_1_2']);
  });

  it('cancel aborts the session controller', async () => {
    const session = newSession(plannedDoc());
    await runAction(testContext(session), { type: 'cancel' }, { confirmed: false });
    expect(session.abort.signal.aborted).toBe(true);
  });
});

// ── Patch validation ─────────────────────────────────────────────────────────

describe('sanitizePatchOps', () => {
  const doc = plannedDoc();

  it('accepts client-patchable content edits, bounded and stripped of unknown keys', () => {
    const ops = sanitizePatchOps(doc, [
      { op: 'brief', patch: { title: 'New', evil: 1 } },
      { op: 'format', patch: { pageCount: 99, pageAspect: '3:4' } },
      { op: 'settings', patch: { budgetUsd: null, confirm: 'always' } },
      { op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: { text: 'Hi!' } },
      { op: 'balloon', pageId: 'pg_1', lineId: 'ln_1_2', patch: { x: 2, pinned: true } },
      { op: 'character', id: 'c_new', patch: { name: 'Nani', tier: 'extra', look: { summary: 'old', bogus: 'x' } } },
      { op: 'panel', pageId: 'pg_1', id: 'pn_1_1', patch: { castIds: ['c_new'], placeId: null } }
    ]);
    expect(ops[0]).toEqual({ op: 'brief', patch: { title: 'New' } });
    expect(ops[1]).toEqual({ op: 'format', patch: { pageCount: 40, pageAspect: '3:4' } });
    expect(ops[2]).toEqual({ op: 'settings', patch: { budgetUsd: undefined, confirm: 'always' } });
    expect(ops[4]).toEqual({ op: 'balloon', pageId: 'pg_1', lineId: 'ln_1_2', patch: { x: 1, pinned: true } });
    expect(ops[5]).toEqual({ op: 'character', id: 'c_new', patch: { name: 'Nani', tier: 'extra', look: { summary: 'old' } } });
    expect(ops[6]).toEqual({ op: 'panel', pageId: 'pg_1', id: 'pn_1_1', patch: { castIds: ['c_new'], placeId: undefined } });
  });

  it.each([
    [{ op: 'render', target: { kind: 'cover' }, patch: { status: 'ready' } }, "can't be changed directly"],
    [{ op: 'spend', entry: {} }, "can't be changed directly"],
    [{ op: 'gate', gate: null }, "can't be changed directly"],
    [{ op: 'format', patch: { kind: 'novel' } }, 'Invalid format: kind'],
    [{ op: 'style', patch: { board: { path: 'u/other-user/p/x/img/secret.webp' } } }, 'Invalid style: board'],
    [{ op: 'character', id: 'c_maya', patch: { refs: [{ path: 'u/other/secret.webp' }] } }, 'Invalid character: refs'],
    [{ op: 'line', pageId: 'pg_9', panelId: 'x', id: 'y', patch: { text: 'a' } }, 'no longer in the plan'],
    [{ op: 'character', id: 'bad id!', patch: { name: 'x' } }, 'Invalid character id'],
    [{ op: 'character', id: 'c_brand_new', patch: { tier: 'lead' } }, 'needs a name']
  ])('rejects %j', (op, message) => {
    expect(() => sanitizePatchOps(doc, [op])).toThrow(message);
  });

  it('patch action applies valid ops atomically', async () => {
    const session = newSession(plannedDoc());
    const ctx = testContext(session);
    await expect(runAction(ctx, { type: 'patch', ops: [{ op: 'note_add', text: 'ok' }, { op: 'spend', entry: {} } as never] }, { confirmed: false })).rejects.toBeInstanceOf(StudioError);
    expect(session.doc.brief.notes).toEqual([]);
    await runAction(ctx, { type: 'patch', ops: [{ op: 'note_add', text: 'ok' }] }, { confirmed: false });
    expect(session.doc.brief.notes).toEqual(['ok']);
  });
});

describe('suggestNextSteps', () => {
  it('follows the forward motion', () => {
    const empty = plannedDoc();
    empty.brief = { title: 'x', notes: [] };
    empty.cast = [];
    empty.pages = [];
    empty.planStatus = 'none';
    expect(suggestNextSteps(empty)).toContain('Paste a script');
    const draft = plannedDoc();
    expect(suggestNextSteps(draft)).toContain('Render all pages');
    const noStyle = { ...draft, style: { status: 'empty' as const, refs: [], options: [] } };
    expect(suggestNextSteps(noStyle)[0]).toBe('Show me 3 styles');
    const done = plannedDoc();
    done.planStatus = 'approved';
    done.pages = done.pages.map((p, i) => readyPage(p, `p${i}.webp`));
    expect(suggestNextSteps(done)).toEqual(expect.arrayContaining(['Make the cover', 'Read it']));
    for (const d of [empty, draft, noStyle, done]) {
      const s = suggestNextSteps(d);
      expect(s.length).toBeGreaterThanOrEqual(2);
      expect(s.length).toBeLessThanOrEqual(4);
    }
  });
});

it('fakes stay honest: TINY_PNG is a valid data URL and KEYS route via OpenRouter', () => {
  expect(TINY_PNG.startsWith('data:image/png;base64,')).toBe(true);
  expect(KEYS.openrouter?.byok).toBe(false);
  expect(scriptedLlm).toBeTypeOf('function');
});
