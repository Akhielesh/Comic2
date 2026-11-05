// fit_render (contract §12.2 "Aspect"): a FREE software fix for a wrong-shape page or cover.
// Never a redraw, never automatic; honest outcomes when software can't do it.
import { describe, expect, it } from 'vitest';
import { emptyRender, pageSpecHash, type AssetRef, type ComicDoc } from '../../../../shared/comic/doc.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../../shared/comic/capabilities.js';
import { newSession, plannedDoc, testContext } from '../orchestrator.fakes.js';
import { startAction } from '../jobs.js';
import { ACTION_HANDLERS } from './index.js';
import { StudioError } from '../types.js';
import { TIMELINE_ACTIONS, cropNeeded, fitFrame, mapBox, remapBalloons, remapQc, resolveFitMode } from './timeline.js';

const asset = (path: string, w: number, h: number): AssetRef => ({ path, source: 'generated', at: 1, w, h });

const squarePageDoc = (w = 1024, h = 1024): ComicDoc => {
  const doc = plannedDoc();
  doc.format = { ...doc.format, pageAspect: '4:5' };
  doc.pages[0] = {
    ...doc.pages[0],
    render: {
      status: 'ready',
      asset: asset('u/user-1/p/proj-1/img/p1.webp', w, h),
      history: [],
      specHash: pageSpecHash(doc, doc.pages[0]),
      qc: { score: 0.8, issues: [], checkedAt: 1, panelBoxes: [{ x: 0, y: 0, w: 1, h: 0.5 }], heads: [{ panel: 1, head: { x: 0.5, y: 0.25 } }] }
    },
    balloons: [{ lineId: 'ln_1_2', x: 0.1, y: 0.1, w: 0.3 }]
  };
  return doc;
};

const ui = (doc: ComicDoc, caps?: StudioCaps) => {
  const session = newSession(doc);
  const ctx = testContext(session, caps ? { caps } : {});
  return { session, ctx, fit: (action: Record<string, unknown>) => startAction(ctx, { type: 'fit_render', ...action } as never, { confirmed: true }) };
};

describe('registration', () => {
  it('fit_render is a registered, non-spend feature action (no stub)', () => {
    expect(TIMELINE_ACTIONS.map((h) => h.type)).toEqual(['fit_render']);
    expect(ACTION_HANDLERS.fit_render).toBe(TIMELINE_ACTIONS[0]);
    expect(ACTION_HANDLERS.fit_render.spend).toBe(false);
  });
});

describe('geometry', () => {
  it('auto crops only when ≤ 8% of the art would go, else pads', () => {
    expect(cropNeeded(1024, 1024, '4:5')).toBeCloseTo(0.2);
    expect(resolveFitMode(1024, 1024, '4:5', 'auto')).toBe('pad');
    expect(cropNeeded(820, 1000, '4:5')).toBeCloseTo(0.0244, 3);
    expect(resolveFitMode(820, 1000, '4:5', undefined)).toBe('crop');
    expect(resolveFitMode(820, 1000, '4:5', 'pad')).toBe('pad');
  });

  it('pad keeps every box inside the frame; crop clips what falls outside', () => {
    const pad = fitFrame(1000, 1000, '4:5', 'pad');
    expect(pad).toMatchObject({ W: 1000, H: 1250, ox: 0, oy: 125 });
    expect(mapBox(pad, { x: 0, y: 0, w: 1, h: 1 })).toEqual({ x: 0, y: 0.1, w: 1, h: 0.8 });
    const crop = fitFrame(1000, 1000, '4:5', 'crop');
    expect(crop).toMatchObject({ W: 800, H: 1000, ox: -100, oy: 0 });
    expect(mapBox(crop, { x: 0, y: 0, w: 0.05, h: 1 })).toBeUndefined();
    expect(mapBox(crop, { x: 0, y: 0, w: 0.5, h: 1 })).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
  });

  it('QC boxes, speaker marks and balloons follow the art', () => {
    const f = fitFrame(1000, 1000, '4:5', 'pad');
    const qc = remapQc({ score: 0.9, issues: ['x'], checkedAt: 1, panelBoxes: [{ x: 0, y: 0.5, w: 1, h: 0.5 }], keepOut: [{ panel: 1, box: { x: 0, y: 0, w: 0.2, h: 0.2 }, kind: 'face' }], heads: [{ panel: 1, head: { x: 0.5, y: 0 }, mouth: { x: 0.5, y: 1 } }] }, f)!;
    expect(qc.panelBoxes).toEqual([{ x: 0, y: 0.5, w: 1, h: 0.4 }]);
    expect(qc.keepOut?.[0].box).toEqual({ x: 0, y: 0.1, w: 0.2, h: 0.16 });
    expect(qc.heads?.[0]).toMatchObject({ head: { x: 0.5, y: 0.1 }, mouth: { x: 0.5, y: 0.9 } });
    expect(qc).toMatchObject({ score: 0.9, issues: ['x'] });
    const wide = fitFrame(1000, 1000, '4:5', 'crop');
    expect(remapBalloons([{ lineId: 'l', x: 0.5, y: 0.2, w: 0.4, tailX: 0 }], wide)[0]).toEqual({ lineId: 'l', x: 0.5, y: 0.2, w: 0.5, tailX: 0 });
  });
});

describe('fit_render action (UI tap)', () => {
  it('pads a square page to 4:5: new derived version, original kept, QC + balloons remapped, $0 with savedUsd', async () => {
    const { session, ctx, fit } = ui(squarePageDoc());
    const started = await fit({ target: { kind: 'page', id: 'pg_1' } });
    expect(started.outcome).toMatchObject({ status: 'done', message: expect.stringMatching(/^Fitted page 1 from 1:1 to 4:5 by padding the edges — free/) });
    const page = session.doc.pages[0];
    expect(page.render.asset).toMatchObject({ source: 'derived', derivedFrom: 'u/user-1/p/proj-1/img/p1.webp', w: 1024, h: 1280 });
    expect(page.render).toMatchObject({ status: 'ready', origin: 'derived', costUsd: 0, aspect: '4:5', specHash: squarePageDoc().pages[0].render.specHash });
    expect(page.render.qc?.panelBoxes).toEqual([{ x: 0, y: 0.1, w: 1, h: 0.4 }]);
    expect(page.render.history[0]).toMatchObject({ path: 'u/user-1/p/proj-1/img/p1.webp', balloons: [{ lineId: 'ln_1_2', x: 0.1, y: 0.1, w: 0.3 }] });
    expect(page.balloons[0]).toMatchObject({ x: 0.1, y: 0.18, w: 0.3 });
    expect(session.doc.spend.totalUsd).toBe(0);
    expect(session.doc.spend.savedUsd).toBeGreaterThan(0);
    // A UI tap gets a short assistant confirmation, and the new image's URL is pushed.
    const last = session.doc.conversation.at(-1)!;
    expect(last.cards?.[0]).toMatchObject({ type: 'notice', tone: 'success' });
    expect(ctx.events.some((e) => e.type === 'urls' && Object.keys(e.urls).some((p) => p.includes('/fit-')))).toBe(true);
  });

  it('"saved by software" counts once per original: flipping back and fitting again saves nothing new', async () => {
    const { session, fit } = ui(squarePageDoc());
    await fit({ target: { kind: 'page', id: 'pg_1' } });
    const savedOnce = session.doc.spend.savedUsd ?? 0;
    expect(savedOnce).toBeGreaterThan(0);
    // The user picks the square original again (free version swap), then fits it a second time.
    session.commit([{ op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'u/user-1/p/proj-1/img/p1.webp', at: 2 }]);
    expect(session.doc.pages[0].render.asset?.path).toBe('u/user-1/p/proj-1/img/p1.webp');
    const again = await fit({ target: { kind: 'page', id: 'pg_1' } });
    expect(again.outcome).toMatchObject({ status: 'done' });
    expect(session.doc.pages[0].render.origin).toBe('derived');
    expect(session.doc.spend.savedUsd).toBe(savedOnce);
    expect(session.doc.spend.totalUsd).toBe(0);
  });

  it('a page that already fits is a $0 no-op', async () => {
    const { session, fit } = ui(squarePageDoc(1024, 1280));
    const started = await fit({ target: { kind: 'page', id: 'pg_1' } });
    expect(started.outcome).toMatchObject({ status: 'done', message: 'Page 1 already fits 4:5 — nothing to change ($0).' });
    expect(session.doc.pages[0].render.history).toEqual([]);
  });

  it('busy → 409; undrawn → NOT_READY; a sheet target is refused', async () => {
    const busy = squarePageDoc();
    busy.pages[0].render = { ...busy.pages[0].render, status: 'rendering' };
    await expect(ui(busy).fit({ target: { kind: 'page', id: 'pg_1' } })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    const undrawn = squarePageDoc();
    undrawn.pages[0].render = emptyRender();
    expect((await ui(undrawn).fit({ target: { kind: 'page', id: 'pg_1' } })).outcome).toMatchObject({ status: 'blocked', code: 'NOT_READY' });
    expect((await ui(squarePageDoc()).fit({ target: { kind: 'sheet', id: 'c_maya' } })).outcome).toMatchObject({ status: 'blocked' });
    await expect(ui(squarePageDoc()).fit({ target: { kind: 'page', id: '../x' } })).rejects.toBeInstanceOf(StudioError);
  });

  it('refuses a crop that would cut more than 8% and offers padding (free) or a quoted redraw', async () => {
    const { session, fit } = ui(squarePageDoc());
    const started = await fit({ target: { kind: 'page', id: 'pg_1' }, mode: 'crop' });
    expect(started.outcome).toMatchObject({ status: 'blocked', message: expect.stringMatching(/would cut 20% of the art/) });
    const steps = session.doc.conversation.at(-1)!.nextSteps!;
    expect(steps[0]).toMatchObject({ usd: 0, action: { type: 'fit_render', mode: 'pad' } });
    expect(steps[1]).toMatchObject({ label: 'Redraw at 4:5', action: { type: 'render_pages', pageIds: ['pg_1'], force: true } });
    expect(steps[1].usd).toBeGreaterThan(0);
    expect(session.doc.pages[0].render.history).toEqual([]);
  });

  it('storage unavailable → honest blocked outcome, nothing changed', async () => {
    const { session, ctx, fit } = ui(squarePageDoc());
    ctx.assetsFake.fitToAspect = async () => {
      throw new StudioError('NOT_AVAILABLE', "Fitting an image to its page shape isn't available yet.", { status: 501 });
    };
    const started = await fit({ target: { kind: 'page', id: 'pg_1' } });
    expect(started.outcome).toMatchObject({ status: 'blocked', code: 'NOT_AVAILABLE', message: expect.stringMatching(/^I couldn't fit page 1 to 4:5: Fitting an image to its page shape isn't available yet\. Nothing was changed/) });
    expect(session.doc.pages[0].render.asset?.path).toBe('u/user-1/p/proj-1/img/p1.webp');
  });

  it('the page changed while storage worked → nothing replaced', async () => {
    const { session, ctx, fit } = ui(squarePageDoc());
    const real = ctx.assetsFake.fitToAspect.bind(ctx.assetsFake);
    ctx.assetsFake.fitToAspect = async (args) => {
      const out = await real(args);
      session.commit([{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { status: 'ready', asset: asset('u/user-1/p/proj-1/img/p1-redraw.webp', 1024, 1280) } }]);
      return out;
    };
    const started = await fit({ target: { kind: 'page', id: 'pg_1' } });
    expect(started.outcome).toMatchObject({ status: 'blocked', code: 'CONFLICT' });
    expect(session.doc.pages[0].render.asset?.path).toBe('u/user-1/p/proj-1/img/p1-redraw.webp');
  });
});

describe('fit_render prices are worded for the user', () => {
  /** On the included usage: one Standard page is 5% of it. */
  const governed: StudioCaps = { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 80, exhausted: false, pctPerStandardPage: 5 } };
  const usage = /(?:≈[\d.]+|<0\.1)% of your usage/;

  it('a governed user reads the redraw quote as a share of the usage — message, card and outcome; never dollars', async () => {
    const { session, fit } = ui(squarePageDoc(), governed);
    const started = await fit({ target: { kind: 'page', id: 'pg_1' }, mode: 'crop' });
    expect(started.outcome.message).toMatch(usage);
    expect(started.outcome.message).not.toMatch(/\$/);
    const msg = session.doc.conversation.at(-1)!;
    expect(msg.text).toMatch(new RegExp(`redraw it at 4:5 \\(${usage.source}\\)`));
    expect(JSON.stringify(msg.cards)).not.toMatch(/\$/);
    // The chip keeps its machine price (the client words it); the action is unchanged.
    expect(msg.nextSteps?.[1]).toMatchObject({ label: 'Redraw at 4:5', action: { type: 'render_pages', force: true } });
  });

  it('a page that already fits is "free" for a governed user; storage failures quote the redraw in usage terms', async () => {
    const fits = ui(squarePageDoc(800, 1000), governed);
    expect((await fits.fit({ target: { kind: 'page', id: 'pg_1' } })).outcome.message).toBe('Page 1 already fits 4:5 — nothing to change (free).');
    const down = ui(squarePageDoc(), governed);
    down.ctx.assetsFake.fitToAspect = async () => {
      throw new StudioError('NOT_AVAILABLE', 'Storage is down.', { status: 503 });
    };
    const out = await down.fit({ target: { kind: 'page', id: 'pg_1' } });
    expect(out.outcome.message).toMatch(new RegExp(`a redraw at 4:5 is ${usage.source}\\.$`));
    expect(down.session.doc.conversation.at(-1)!.text).not.toMatch(/\$/);
  });

  it('admins and own keys still read dollars', async () => {
    const { fit } = ui(squarePageDoc(), { ...governed, admin: true });
    const started = await fit({ target: { kind: 'page', id: 'pg_1' }, mode: 'crop' });
    expect(started.outcome.message).toMatch(/redraw it at 4:5 \(≈\$\d/);
    const byok = ui(squarePageDoc(), { ...governed, byok: true });
    expect((await byok.fit({ target: { kind: 'page', id: 'pg_1' }, mode: 'crop' })).outcome.message).toMatch(/≈\$\d/);
  });
});
