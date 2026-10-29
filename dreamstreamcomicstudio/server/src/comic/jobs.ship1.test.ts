// K1 wiring tests (plan §10 K1): back-compat F1 on a real render run (no false "Out of date" after a jsonb reload),
// the plan-fit render gate (held-back pages leave the run AND its quote), the honest page-check notice
// (letterPage → qcNoticeFor), the layout guide behind COMIC_LAYOUT_GUIDE, and the plan-fit notes. Fakes only:
// no paid call, no network, synthetic docs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptyRender,
  isPageStale,
  isTargetStale,
  normalizeDoc,
  planInputHashOf,
  type Card,
  type ComicDoc,
  type NoticeFix,
  type Page
} from '../../../shared/comic/doc.js';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities.js';
import { resolveImageJob } from '../../../shared/comic/models.js';
import { deriveLock } from '../../../shared/comic/modelLock.js';
import { checkPagePlan } from '../../../shared/comic/pagePlanCheck.js';
import { applyOps } from '../../../shared/comic/ops.js';
import { costFormatterFor } from './costText.js';
import {
  JOB_TIMINGS,
  drawTargets,
  estimateSpendAction,
  planGateApplies,
  planPagesQuoteText,
  planPagesUsd,
  runAction,
  startAction,
  suggestNextSteps
} from './jobs.js';
import { KEYS, newSession, plannedDoc, testContext } from './orchestrator.fakes.js';
import { LAYOUT_GUIDE_LABEL } from './prompts.js';
import { tryRenderPageLayoutGuide } from './panelize/wireframe.js';
import { checkRenderSafety, onRenderVerdict } from './safety/index.js';
import { StudioError } from './types.js';
import { analyzePageRender } from './vision.js';
import { writePagePlan } from './writer.js';

vi.mock('./vision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vision.js')>();
  return { ...actual, analyzePageRender: vi.fn(actual.analyzePageRender) };
});
vi.mock('./writer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./writer.js')>();
  return { ...actual, writePagePlan: vi.fn(actual.writePagePlan) };
});
vi.mock('./safety/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./safety/index.js')>();
  return { ...actual, onRenderVerdict: vi.fn(actual.onRenderVerdict), checkRenderSafety: vi.fn(actual.checkRenderSafety) };
});
vi.mock('./panelize/wireframe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./panelize/wireframe.js')>();
  return { ...actual, tryRenderPageLayoutGuide: vi.fn(actual.tryRenderPageLayoutGuide) };
});

const TIMINGS = { ...JOB_TIMINGS };
const GUIDE_ENV = process.env.COMIC_LAYOUT_GUIDE;
beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.saveRetryMs = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(analyzePageRender).mockRejectedValue(new StudioError('RATE_LIMIT', 'The page checker is busy.', { retryable: true }));
  vi.mocked(onRenderVerdict).mockResolvedValue(undefined);
  vi.mocked(checkRenderSafety).mockResolvedValue(undefined);
  delete process.env.COMIC_LAYOUT_GUIDE;
});
afterEach(() => {
  Object.assign(JOB_TIMINGS, TIMINGS);
  vi.mocked(analyzePageRender).mockReset();
  vi.mocked(writePagePlan).mockReset();
  vi.mocked(onRenderVerdict).mockReset();
  vi.mocked(checkRenderSafety).mockReset();
  vi.mocked(tryRenderPageLayoutGuide).mockClear();
  vi.restoreAllMocks();
  if (GUIDE_ENV === undefined) delete process.env.COMIC_LAYOUT_GUIDE;
  else process.env.COMIC_LAYOUT_GUIDE = GUIDE_ENV;
});

const cardsOf = (doc: ComicDoc): Card[] => doc.conversation.flatMap((m) => m.cards || []);
const notices = (doc: ComicDoc) => cardsOf(doc).filter((c): c is Extract<Card, { type: 'notice' }> => c.type === 'notice');
const readySheets = (doc: ComicDoc) =>
  doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1, w: 1536, h: 1024 } }));
const onePage = (doc: ComicDoc) => {
  doc.pages = doc.pages.slice(0, 1);
  doc.format.pageCount = 1;
  return doc;
};

/** What Postgres jsonb does to object key order on save: shorter keys first, then bytewise. */
const jsonbOrder = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(jsonbOrder)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
            .map((k) => [k, jsonbOrder((v as Record<string, unknown>)[k])])
        )
      : v;

// ── Back-compat F1 on a real run (the investigation's jsonbstale probe, kept as a regression test) ──

describe('jsonbstale: a comic drawn in one session is still current after a jsonb save/reload', () => {
  for (const lettering of ['overlay', 'in_art'] as const) {
    it(`${lettering}: 0 stale pages, Render all quotes 0 images, no "Redraw the out-of-date pages" chip, stable plan hash`, async () => {
      const doc = plannedDoc();
      doc.format.lettering = lettering;
      // A writer-shaped look (LOOK_KEYS insertion order, as tools.ts / writer.ts build it): jsonb reorders it.
      doc.cast.forEach((c) => {
        c.look = { summary: c.look.summary || 'x', age: '30s', build: 'lean', hair: 'black bob', outfit: 'red coat', palette: 'red, black', marks: 'scar' };
      });
      const session = newSession(doc);
      const ctx = testContext(session);
      await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
      await ctx.settled();
      const live = session.doc;
      expect(live.pages.filter((p) => p.render.status === 'ready')).toHaveLength(3);
      expect(live.pages.filter((p) => isPageStale(live, p))).toEqual([]);
      const reloaded = normalizeDoc(jsonbOrder(JSON.parse(JSON.stringify(live))) as ComicDoc);
      expect(reloaded.pages.filter((p) => isPageStale(reloaded, p))).toEqual([]);
      expect(reloaded.cast.filter((c) => isTargetStale(reloaded, { kind: 'sheet', id: c.id }))).toEqual([]);
      expect(estimateSpendAction(reloaded, { type: 'render_pages' }, false).imageCount).toBe(0);
      expect(suggestNextSteps(reloaded)).not.toContain('Redraw the out-of-date pages');
      expect(planInputHashOf(reloaded)).toBe(planInputHashOf(live));
    });
  }
});

// ── The plan-fit gate (plan §4.1, decision PD-1) ─────────────────────────────

const LONG = (words: number) => Array.from({ length: words }, (_, i) => ['Listen', 'carefully', 'because', 'the', 'spice', 'map', 'leads', 'past', 'the', 'old', 'gate'][i % 11]).join(' ') + '.';

/** plannedDoc with page 2's last panel overfilled: `fixable` = a same-count layout fits it; else nothing fits. */
const overfullDoc = (fixable: boolean): ComicDoc => {
  const doc = plannedDoc();
  readySheets(doc);
  doc.settings = { ...doc.settings, confirm: 'never' };
  doc.planStatus = 'approved';
  const p2 = doc.pages[1];
  p2.panels[2].lines = fixable
    ? [{ id: 'ln_long', kind: 'speech', speakerId: 'c_maya', text: LONG(52) }]
    : [
        { id: 'ln_long1', kind: 'speech', speakerId: 'c_maya', text: LONG(60) },
        { id: 'ln_long2', kind: 'speech', speakerId: 'c_arjun', text: LONG(60) },
        { id: 'ln_long3', kind: 'speech', speakerId: 'c_maya', text: LONG(60) }
      ];
  return doc;
};

describe('render_pages → planCheckGate: held-back pages leave the run and its quote', () => {
  it('fixtures: page 2 is overfull (with and without a layout that fits); pages 1 and 3 fit', () => {
    const fix = overfullDoc(true);
    expect(checkPagePlan(fix, fix.pages[1]).state).toBe('overfull');
    expect(checkPagePlan(fix, fix.pages[1]).layoutFix).toBeTruthy();
    const none = overfullDoc(false);
    expect(checkPagePlan(none, none.pages[1]).state).toBe('overfull');
    expect(checkPagePlan(none, none.pages[1]).layoutFix).toBeFalsy();
    for (const d of [fix, none]) for (const i of [0, 2]) expect(checkPagePlan(d, d.pages[i]).state).not.toBe('overfull');
  });

  it('the quote and the run drop the overfull page; a notice says why with free fixes first, then "Draw page 2 anyway"', async () => {
    const doc = overfullDoc(true);
    expect(planGateApplies({})).toBe(true);
    expect(estimateSpendAction(doc, { type: 'render_pages' }, false).imageCount).toBe(2);
    expect(drawTargets(doc, { type: 'render_pages' }).map((p) => p.id)).toEqual(['pg_1', 'pg_3']);
    const session = newSession(doc);
    const ctx = testContext(session);
    const started = await startAction(ctx, { type: 'render_pages' }, { confirmed: true });
    expect(started.outcome.status).toBe('started');
    if (started.outcome.status === 'started') expect(started.outcome.estimate.imageCount).toBe(2);
    expect(started.outcome.message).toMatch(/Held back \(not drawn, not in this price\): page 2/);
    await started.done;
    await ctx.settled();
    expect(ctx.imagesFake.calls).toHaveLength(2);
    expect(session.doc.pages.map((p) => p.render.status)).toEqual(['ready', 'none', 'ready']);
    const held = notices(session.doc).find((n) => /Page 2 is held back/.test(n.text))!;
    expect(held).toBeTruthy();
    expect(held.fixes?.map((f) => [f.label, f.free])).toEqual([
      ['Use the layout that fits', true],
      ['Draw page 2 anyway', false]
    ]);
    // The paid chip carries its own quote (a tap is the confirmation; a stale quote re-gates).
    const anyway = held.fixes![1].action as Extract<NoticeFix['action'], { type: 'render_pages' }>;
    expect(anyway).toMatchObject({ type: 'render_pages', pageIds: ['pg_2'] });
    expect(anyway.quotedUsd).toBe(estimateSpendAction(session.doc, { type: 'render_pages', pageIds: ['pg_2'] }, false).usd);
    // The free fix makes the page fit: the next "Render all" draws it.
    const fixed = applyOps(session.doc, (held.fixes![0].action as Extract<NoticeFix['action'], { type: 'patch' }>).ops);
    expect(checkPagePlan(fixed, fixed.pages[1]).state).not.toBe('overfull');
    expect(estimateSpendAction(fixed, { type: 'render_pages' }, false).imageCount).toBe(1);
  });

  it('drawOverfull draws it anyway (quote included); explicit page ids and forced takes skip the gate', async () => {
    const doc = overfullDoc(false);
    expect(estimateSpendAction(doc, { type: 'render_pages', drawOverfull: ['pg_2'] }, false).imageCount).toBe(3);
    // Unknown ids are ignored (sanitized to this doc's pages).
    expect(estimateSpendAction(doc, { type: 'render_pages', drawOverfull: ['pg_nope', 'x'.repeat(500)] }, false).imageCount).toBe(2);
    expect(estimateSpendAction(doc, { type: 'render_pages', pageIds: ['pg_2'] }, false).imageCount).toBe(1);
    expect(planGateApplies({ pageIds: ['pg_2'] })).toBe(false);
    expect(planGateApplies({ force: true })).toBe(false);
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_pages', drawOverfull: ['pg_2'] }, { confirmed: true });
    await ctx.settled();
    expect(session.doc.pages.map((p) => p.render.status)).toEqual(['ready', 'ready', 'ready']);
    // No layout fits: no layout chip, only "Draw anyway" (never refused outright).
    const held = overfullDoc(false);
    const s2 = newSession(held);
    const c2 = testContext(s2);
    await runAction(c2, { type: 'render_pages' }, { confirmed: true });
    await c2.settled();
    expect(notices(s2.doc).find((n) => /Page 2 is held back/.test(n.text))?.fixes?.map((f) => f.label)).toEqual(['Draw page 2 anyway']);
  });

  it('a gated "Render all" is bound to the pages it draws; the held-back notice sits beside the gate', async () => {
    const doc = overfullDoc(true);
    doc.settings = { ...doc.settings, confirm: 'always' };
    const session = newSession(doc);
    const ctx = testContext(session);
    const gated = await startAction(ctx, { type: 'render_pages' }, { confirmed: false });
    expect(gated.outcome.status).toBe('gated');
    expect(gated.outcome.message).toMatch(/Held back/);
    const gate = session.doc.gate!;
    expect(gate.action).toEqual({ type: 'render_pages', pageIds: ['pg_1', 'pg_3'] });
    expect(gate.imageCount).toBe(2);
    const msg = session.doc.conversation.at(-1)!;
    expect(msg.cards?.map((c) => c.type)).toEqual(['breakdown', 'notice', 'gate']);
    expect(msg.text).toMatch(/Page 2 isn't drawn yet/);
    await runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: true });
    await ctx.settled();
    expect(session.doc.pages.map((p) => p.render.status)).toEqual(['ready', 'none', 'ready']);
  });

  it('everything held back: $0, nothing drawn, the notice offers the fixes', async () => {
    const doc = overfullDoc(true);
    doc.pages = [doc.pages[1]];
    doc.pages[0].n = 1;
    doc.format.pageCount = 1;
    const session = newSession(doc);
    const ctx = testContext(session);
    const out = await startAction(ctx, { type: 'render_pages' }, { confirmed: true });
    expect(out.outcome.status).toBe('nothing');
    expect(out.outcome.message).toMatch(/Page 1 is held back: panel 3 has/);
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(notices(session.doc).find((n) => /held back/.test(n.text))?.fixes?.map((f) => f.free)).toEqual([true, false]);
  });
});

// ── letterPage → qcNoticeFor (plan §3 C14) ───────────────────────────────────

describe('the page-check notice path calls qcNoticeFor', () => {
  const checked = (score: number, extra: Record<string, unknown> = {}) => ({
    qc: {
      score,
      issues: ['MAYA may be missing from panel 2.'],
      checkedAt: 2,
      panelBoxes: [{ x: 0, y: 0, w: 1, h: 0.4 }, { x: 0, y: 0.4, w: 0.5, h: 0.6 }, { x: 0.5, y: 0.4, w: 0.5, h: 0.6 }],
      drawnBoxes: [{ x: 0, y: 0, w: 1, h: 0.4 }, { x: 0, y: 0.4, w: 0.5, h: 0.6 }, { x: 0.5, y: 0.4, w: 0.5, h: 0.6 }],
      boxesFrom: 'vision',
      missingSpeakers: [{ panel: 2, castId: 'c_maya' }]
    },
    balloons: [],
    model: 'v',
    ...extra
  });

  it('a missing speaker at 0.75 raises "Check panels" with a free caption fix first and a quoted panel redraw', async () => {
    const doc = onePage(plannedDoc());
    readySheets(doc);
    vi.mocked(analyzePageRender).mockResolvedValue(checked(0.75) as never);
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    await ctx.settled();
    const n = notices(session.doc).find((c) => /Check panels on page 1/.test(c.text));
    expect(n).toBeTruthy();
    expect(n!.text).toMatch(/MAYA has 1 line in panel 2 but may not be drawn/);
    expect(n!.fixes?.[0]).toMatchObject({ free: true, action: { type: 'patch' } });
    const paid = n!.fixes!.filter((f) => !f.free);
    expect(paid.length).toBeGreaterThan(0);
    for (const f of paid) expect(typeof (f.action as { quotedUsd?: number }).quotedUsd).toBe('number');
    // The QC fields land on the render (typed in doc.ts now).
    expect(session.doc.pages[0].render.qc?.missingSpeakers).toEqual([{ panel: 2, castId: 'c_maya' }]);
  });

  it('a withheld page gets no notice: blocked by the check itself, or by the safety check that runs after it', async () => {
    const doc = onePage(plannedDoc());
    readySheets(doc);
    vi.mocked(analyzePageRender).mockResolvedValue(checked(0.3, { safety: { assessed: 'X', categories: ['gore'], at: 2, by: 'qc' } }) as never);
    const s1 = newSession(doc);
    const c1 = testContext(s1);
    await runAction(c1, { type: 'render_pages' }, { confirmed: true });
    await c1.settled();
    expect(notices(s1.doc).filter((c) => /Check panels|may need another pass/.test(c.text))).toEqual([]);
    // No safety block in the vision reply; checkRenderSafety finds it afterwards: the buffered notice is dropped.
    vi.mocked(analyzePageRender).mockResolvedValue(checked(0.3) as never);
    vi.mocked(checkRenderSafety).mockResolvedValue({ assessed: 'X', categories: ['gore'], at: 3, by: 'image' } as never);
    const s2 = newSession(onePage(plannedDoc()));
    readySheets(s2.doc);
    const c2 = testContext(s2);
    await runAction(c2, { type: 'render_pages' }, { confirmed: true });
    await c2.settled();
    expect(notices(s2.doc).filter((c) => /Check panels|may need another pass/.test(c.text))).toEqual([]);
  });

  it('a clean check (0.98, nothing structured) is quiet', async () => {
    const doc = onePage(plannedDoc());
    readySheets(doc);
    vi.mocked(analyzePageRender).mockResolvedValue({ qc: { score: 0.98, issues: [], checkedAt: 2 }, balloons: [], model: 'v' } as never);
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    await ctx.settled();
    expect(notices(session.doc).filter((c) => /Check panels|may need another pass/.test(c.text))).toEqual([]);
  });
});

// ── The layout guide (plan §4.2; COMIC_LAYOUT_GUIDE, off by default — PD-8) ──

describe('prepare() attaches the PAGE LAYOUT GUIDE only while COMIC_LAYOUT_GUIDE=1', () => {
  const drawOne = async (doc: ComicDoc, caps = DEFAULT_CAPS) => {
    const session = newSession(doc);
    const ctx = testContext(session, { caps });
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], force: true }, { confirmed: true });
    await ctx.settled();
    return { session, ctx, call: ctx.imagesFake.calls.find((c) => /Action 1\.1/.test(c.prompt))! };
  };
  const guideDoc = () => {
    const doc = onePage(plannedDoc());
    readySheets(doc);
    return doc;
  };

  it('off (the default): no guide, references exactly as before', async () => {
    const { call } = await drawOne(guideDoc());
    expect(call.prompt).not.toContain(LAYOUT_GUIDE_LABEL);
    expect(call.references.some((r) => r.label.includes(LAYOUT_GUIDE_LABEL))).toBe(false);
    expect(vi.mocked(tryRenderPageLayoutGuide)).not.toHaveBeenCalled();
  });

  it('on: Image 1 is the PAGE LAYOUT GUIDE (a PNG), the other references follow unchanged, all within the slots', async () => {
    const off = await drawOne(guideDoc());
    process.env.COMIC_LAYOUT_GUIDE = '1';
    const on = await drawOne(guideDoc());
    const [first, ...rest] = on.call.references;
    expect(first.label).toContain(LAYOUT_GUIDE_LABEL);
    expect(first.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(on.call.prompt).toContain(LAYOUT_GUIDE_LABEL);
    expect(rest.map((r) => r.dataUrl)).toEqual(off.call.references.map((r) => r.dataUrl));
    const spec = resolveImageJob('page', on.session.doc.settings.quality, on.session.doc.settings.imageModelOverride, deriveLock(on.session.doc)).spec;
    expect(on.call.references.length).toBeLessThanOrEqual(spec.refs.total);
    // The quote does not change (references are not priced in Ship 1).
    expect(estimateSpendAction(guideDoc(), { type: 'render_pages', pageIds: ['pg_1'] }, false).usd).toBe(estimateSpendAction(guideDoc(), { type: 'render_pages', pageIds: ['pg_1'] }, false).usd);
    // The version records the guide by its geometry, never a path (nothing is stored).
    expect(on.session.doc.pages[0].render.jobHash).not.toBe(off.session.doc.pages[0].render.jobHash);
  });

  it("on, legacy-locked comic (one object slot): the guide never takes the model's only object slot", async () => {
    process.env.COMIC_LAYOUT_GUIDE = '1';
    const doc = guideDoc();
    doc.imageModel = { modelId: 'nano-banana-legacy', lockedAt: 1, origin: 'migrated' };
    const { call } = await drawOne(doc, { ...DEFAULT_CAPS, modelOverride: true });
    expect(call.spec.id).toBe('nano-banana-legacy');
    expect(call.references.some((r) => r.label.includes(LAYOUT_GUIDE_LABEL))).toBe(false);
    expect(call.references.length).toBeLessThanOrEqual(call.spec.refs.total);
  });

  it('on, but the guide cannot be drawn: the page is drawn without it (no guide lines, same quote)', async () => {
    process.env.COMIC_LAYOUT_GUIDE = '1';
    vi.mocked(tryRenderPageLayoutGuide).mockResolvedValueOnce(null);
    const doc = guideDoc();
    const quote = estimateSpendAction(doc, { type: 'render_pages', pageIds: ['pg_1'], force: true }, false).usd;
    const { session, call } = await drawOne(doc);
    expect(vi.mocked(tryRenderPageLayoutGuide)).toHaveBeenCalledTimes(1);
    expect(session.doc.pages[0].render.status).toBe('ready');
    expect(call.prompt).not.toContain(LAYOUT_GUIDE_LABEL);
    expect(call.references.some((r) => r.label.includes(LAYOUT_GUIDE_LABEL))).toBe(false);
    expect(session.doc.spend.entries.find((e) => e.kind === 'page')).toBeTruthy();
    expect(estimateSpendAction(guideDoc(), { type: 'render_pages', pageIds: ['pg_1'], force: true }, false).usd).toBe(quote);
  });
});

// ── The plan flow: plan-fit notes and the "up to one repair" estimate ─────────

describe('plan_pages surfaces the plan-fit notes; the estimate says "up to one writer repair"', () => {
  it("writePagePlan's notes reach the chat and the director's tool result", async () => {
    const doc = plannedDoc();
    const pages: Page[] = doc.pages;
    doc.pages = [];
    doc.planStatus = 'none';
    const note = "Page 2's layout changed so the conversation fits: panel 3 now has a full-width row.";
    vi.mocked(writePagePlan).mockResolvedValue({ pages, newCast: [], model: 'w', notes: [note] });
    const session = newSession(doc);
    const ctx = testContext(session);
    const out = await startAction(ctx, { type: 'plan_pages' }, { confirmed: false });
    expect(out.outcome.status).toBe('done');
    expect(out.outcome.message).toContain(note);
    expect(session.doc.conversation.at(-1)!.text).toContain(note);
  });

  it('the "Plan the pages" price is per page and the words say up to one writer repair', () => {
    const doc = plannedDoc();
    doc.format.pageCount = 6;
    expect(planPagesUsd(doc, true)).toBeCloseTo(0.072, 4);
    const session = newSession(doc);
    const ctx = testContext(session, { keys: KEYS });
    expect(planPagesQuoteText(doc, costFormatterFor(ctx), false)).toMatch(/6 pages, up to one writer repair/);
  });
});
