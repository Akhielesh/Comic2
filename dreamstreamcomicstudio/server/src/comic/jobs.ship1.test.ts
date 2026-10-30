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
import { candidateLayouts, checkPagePlan } from '../../../shared/comic/pagePlanCheck.js';
import { applyOps, layoutFixOps, type DocOp } from '../../../shared/comic/ops.js';
import { costFormatterFor } from './costText.js';
import {
  JOB_TIMINGS,
  bindSpendAction,
  drawTargets,
  estimateSpendAction,
  gateMootedBy,
  heldBackLayoutFixOps,
  nextStepsFor,
  planGateApplies,
  planPagesQuoteText,
  planPagesUsd,
  runAction,
  startAction,
  suggestNextSteps
} from './jobs.js';
import { KEYS, newSession, plannedDoc, testContext } from './orchestrator.fakes.js';
import { LAYOUT_GUIDE_LABEL, effectiveLayout, harmonizePanelSizes, parseLayout } from './prompts.js';
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

// ── The held-back fixes do what they say ─────────────────────────────────────

const patchOps = (fix: NoticeFix | undefined): DocOp[] => (fix?.action as Extract<NoticeFix['action'], { type: 'patch' }>).ops;
const heldNotice = (doc: ComicDoc, n: number) => notices(doc).find((c) => new RegExp(`Page ${n} is held back`).test(c.text));

/** plannedDoc with page 1's last panel overfilled: its first panel is "wide", and the layout that fits puts panel 1
 *  in a shared row — a layout the prompt rejects unless the sizes change with it. */
const wideFirstDoc = (): ComicDoc => {
  const doc = plannedDoc();
  readySheets(doc);
  doc.planStatus = 'approved';
  doc.pages[0].panels[2].lines = [{ id: 'ln_long', kind: 'speech', speakerId: 'c_maya', text: LONG(70) }];
  return doc;
};

describe('"Use the layout that fits" puts the page on the layout it is drawn on', () => {
  it('fixture: the fitting blueprint shares panel 1\'s row, so the layout alone would be drawn as the old, overfull one', () => {
    const doc = wideFirstDoc();
    const check = checkPagePlan(doc, doc.pages[0]);
    expect(check.state).toBe('overfull');
    expect(doc.pages[0].panels.map((p) => p.size)).toEqual(['wide', 'medium', 'medium']);
    const layout = check.layoutFix!.layout;
    expect(layout).toBe('Row 1: two equal panels. Row 2: one large panel.');
    // A layout-only patch: the prompt rejects it (a wide panel in a shared row) and draws the old layout — and the
    // gate, which measures the layout as drawn (pageGeometry effectiveLayout), agrees that the page is still overfull.
    const layoutOnly = applyOps(doc, [{ op: 'page', id: 'pg_1', patch: { layout } }]);
    expect(checkPagePlan(layoutOnly, layoutOnly.pages[0]).state).toBe('overfull');
    expect(effectiveLayout(layoutOnly.pages[0], layoutOnly.format)).not.toBe(layout);
    const asDrawn = { ...layoutOnly.pages[0], layout: effectiveLayout(layoutOnly.pages[0], layoutOnly.format) };
    expect(checkPagePlan(layoutOnly, asDrawn).state).toBe('overfull');
  });

  it('the notice chip harmonizes the sizes: the prompt draws exactly that layout, and the page fits on it', async () => {
    const session = newSession(wideFirstDoc());
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    await ctx.settled();
    expect(session.doc.pages.map((p) => p.render.status)).toEqual(['none', 'ready', 'ready']);
    const fix = heldNotice(session.doc, 1)!.fixes!.find((f) => f.free)!;
    expect(fix.label).toBe('Use the layout that fits');
    const ops = patchOps(fix);
    expect(ops).toContainEqual({ op: 'panel', pageId: 'pg_1', id: 'pn_1_1', patch: { size: 'medium' } });
    const fixed = applyOps(session.doc, ops);
    const page = fixed.pages[0];
    expect(effectiveLayout(page, fixed.format)).toBe(page.layout);
    expect(page.layout).toBe('Row 1: two equal panels. Row 2: one large panel.');
    expect(checkPagePlan(fixed, page).state).not.toBe('overfull');
    // The chip is the same op set the shared helper gives the breakdown card (one implementation).
    expect(ops).toEqual(layoutFixOps(session.doc, session.doc.pages[0], page.layout!));
    // Applied through the real patch path, the next "Render all" draws page 1 on that layout.
    await runAction(ctx, fix.action, { confirmed: true });
    const calls = ctx.imagesFake.calls.length;
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    await ctx.settled();
    expect(session.doc.pages[0].render.status).toBe('ready');
    const drawn = ctx.imagesFake.calls.slice(calls).find((c) => /Action 1\.1/.test(c.prompt))!;
    expect(drawn.prompt).toContain('Row 1: two equal panels. Row 2: one large panel.');
  });

  it('no chip when the page would still be overfull on the layout it is drawn on', () => {
    const doc = wideFirstDoc();
    // A blueprint that parses but is not what fits (the page stays overfull on it): never offered as the free fix.
    expect(heldBackLayoutFixOps(doc, 'pg_1', 'Row 1: one wide panel. Row 2: two equal panels.')).toBeNull();
    // Another panel count, or a row grid on a webtoon: the blueprint cannot be drawn as given.
    expect(layoutFixOps(doc, doc.pages[0], 'Row 1: two equal panels.')).toEqual([]);
    expect(layoutFixOps({ format: { ...doc.format, kind: 'webtoon' } }, doc.pages[0], 'Row 1: two equal panels. Row 2: one large panel.')).toEqual([]);
    expect(heldBackLayoutFixOps(doc, 'pg_1', 'Row 1: two equal panels. Row 2: one large panel.')).not.toBeNull();
  });

  it("parity: layoutFixOps sizes every candidate blueprint as prompts.ts harmonizePanelSizes does, and the prompt keeps it", () => {
    const sizeSets: Page['panels'][number]['size'][][] = [['wide', 'medium', 'medium', 'small', 'tall', 'large'], ['medium', 'wide', 'small', 'large', 'medium', 'splash'], ['tall', 'small', 'wide', 'medium', 'wide', 'medium']];
    let checked = 0;
    for (const kind of ['comic', 'manga', 'storybook', 'webtoon'] as const) {
      for (const readingDirection of ['ltr', 'rtl'] as const) {
        const doc = plannedDoc();
        doc.format = { ...doc.format, kind, readingDirection };
        for (let n = 1; n <= 6; n += 1) {
          for (const layout of candidateLayouts(doc, n)) {
            for (const sizes of sizeSets) {
              const page: Page = { ...doc.pages[0], panels: Array.from({ length: n }, (_, i) => ({ ...doc.pages[0].panels[0], id: `pn_${i}`, n: i + 1, size: sizes[i] })) };
              const ops = layoutFixOps(doc, page, layout);
              const parsed = parseLayout(layout)!;
              const expected = harmonizePanelSizes(page.panels, parsed, readingDirection === 'rtl').map((p) => p.size);
              const d2 = { ...doc, pages: [page] };
              const fixed = applyOps(d2, ops).pages[0];
              if (kind === 'webtoon' && parsed.mode !== 'stack') {
                expect(ops).toEqual([]);
                continue;
              }
              expect(fixed.panels.map((p) => p.size)).toEqual(expected);
              expect(fixed.layout).toBe(layout);
              expect(effectiveLayout(fixed, doc.format)).toBe(layout);
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('"Draw anyway" beside an open "Render all" gate extends that gate; it never silently cancels it', () => {
  const gatedDoc = () => {
    const doc = overfullDoc(true);
    doc.settings = { ...doc.settings, confirm: 'always' };
    return doc;
  };

  it('the chip is the same Render all with the page added (drawOverfull), quoted as a whole; a tap draws pages 1, 2 and 3', async () => {
    const session = newSession(gatedDoc());
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_pages' }, { confirmed: false });
    const gate = session.doc.gate!;
    expect(gate.action).toEqual({ type: 'render_pages', pageIds: ['pg_1', 'pg_3'] });
    const chip = heldNotice(session.doc, 2)!.fixes!.find((f) => !f.free)!;
    expect(chip.label).toBe('Draw page 2 anyway (with the rest)');
    const all = { type: 'render_pages' as const, drawOverfull: ['pg_2'] };
    expect(chip.action).toEqual({ ...all, quotedUsd: estimateSpendAction(session.doc, all, false).usd });
    expect(estimateSpendAction(session.doc, all, false).imageCount).toBe(3);
    const out = await startAction(ctx, chip.action, { confirmed: true });
    expect(out.outcome.status).toBe('started');
    await out.done;
    await ctx.settled();
    expect(session.doc.pages.map((p) => p.render.status)).toEqual(['ready', 'ready', 'ready']);
    // The old gate is moot (its pages were drawn by this run), so it is retired, not left dangling.
    expect(session.doc.gate).toMatchObject({ id: gate.id, status: 'declined' });
  });

  it('the pending Render all carries its cover into the chip', async () => {
    const session = newSession(gatedDoc());
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_pages', includeCover: true }, { confirmed: false });
    const chip = heldNotice(session.doc, 2)!.fixes!.find((f) => !f.free)!;
    expect(chip.action).toMatchObject({ type: 'render_pages', drawOverfull: ['pg_2'], includeCover: true });
    expect((chip.action as { pageIds?: string[] }).pageIds).toBeUndefined();
  });

  it('backstop: a single-page draw beside the gate leaves the gate open; approving it later draws the other pages', async () => {
    const session = newSession(gatedDoc());
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_pages' }, { confirmed: false });
    const gate = session.doc.gate!;
    const quoted = estimateSpendAction(session.doc, { type: 'render_pages', pageIds: ['pg_2'] }, false).usd;
    const out = await startAction(ctx, { type: 'render_pages', pageIds: ['pg_2'], quotedUsd: quoted }, { confirmed: true });
    expect(out.outcome.status).toBe('started');
    await out.done;
    await ctx.settled();
    expect(session.doc.gate).toMatchObject({ id: gate.id, status: 'open' });
    expect(session.doc.pages.map((p) => p.render.status)).toEqual(['none', 'ready', 'none']);
    await runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: true });
    await ctx.settled();
    expect(session.doc.pages.map((p) => p.render.status)).toEqual(['ready', 'ready', 'ready']);
  });

  it('gateMootedBy: covered pages (and the cover) retire a gate; partial ones and other kinds do not', () => {
    const doc = overfullDoc(true);
    const gated = { type: 'render_pages' as const, pageIds: ['pg_1', 'pg_3'] };
    expect(gateMootedBy(doc, gated, { type: 'render_pages' })).toBe(true);
    expect(gateMootedBy(doc, gated, { type: 'render_pages', pageIds: ['pg_1', 'pg_3'] })).toBe(true);
    expect(gateMootedBy(doc, gated, { type: 'render_pages', pageIds: ['pg_2'] })).toBe(false);
    expect(gateMootedBy(doc, gated, { type: 'render_pages', pageIds: ['pg_1'] })).toBe(false);
    expect(gateMootedBy(doc, { ...gated, includeCover: true }, { type: 'render_pages' })).toBe(false);
    expect(gateMootedBy(doc, { ...gated, includeCover: true }, { type: 'render_pages', includeCover: true })).toBe(true);
    expect(gateMootedBy(doc, gated, { type: 'render_cover' })).toBe(false);
    expect(gateMootedBy(doc, { type: 'render_sheets' }, { type: 'render_sheets' })).toBe(true);
  });
});

describe('bindSpendAction never stores a raw drawOverfull', () => {
  it('explicit pageIds drop drawOverfull (it is meaningless there); a gate never saves it', async () => {
    const doc = overfullDoc(true);
    const junk = Array.from({ length: 500 }, (_, i) => `x${i}`);
    expect(bindSpendAction(doc, { type: 'render_pages', pageIds: ['pg_1'], drawOverfull: junk })).toEqual({ type: 'render_pages', pageIds: ['pg_1'] });
    expect(bindSpendAction(doc, { type: 'render_pages', drawOverfull: ['pg_2'] })).toEqual({ type: 'render_pages', pageIds: ['pg_1', 'pg_2', 'pg_3'] });
    doc.settings = { ...doc.settings, confirm: 'always' };
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], drawOverfull: junk }, { confirmed: false });
    expect(session.doc.gate?.action).toEqual({ type: 'render_pages', pageIds: ['pg_1'] });
  });
});

describe('next-step chips name what "Render all" really draws', () => {
  it('some pages held back: the chip says how many it draws and which page waits, at that price', () => {
    const doc = overfullDoc(true);
    const steps = nextStepsFor(doc);
    const draw = steps.find((s) => /^Draw /.test(s.label))!;
    expect(draw.label).toBe('Draw 2 pages (page 2 held back)');
    expect(draw.usd).toBe(estimateSpendAction(doc, { type: 'render_pages' }, false).usd);
    expect(suggestNextSteps(doc)).not.toContain('Draw all pages');
    // A draft plan says the same on its approve chip.
    doc.planStatus = 'draft';
    expect(suggestNextSteps(doc)).toContain('Approve & draw 2 pages (page 2 held back)');
  });

  it('every page left to draw held back: no draw chip, the free layout fix instead (the ops that make it fit)', () => {
    const doc = wideFirstDoc();
    doc.pages = [doc.pages[0]];
    doc.format.pageCount = 1;
    const steps = nextStepsFor(doc);
    expect(steps.some((s) => /^Draw /.test(s.label))).toBe(false);
    const fix = steps.find((s) => s.label === 'Use the layout that fits page 1')!;
    expect(fix).toMatchObject({ usd: 0, action: { type: 'patch' } });
    const fixed = applyOps(doc, (fix.action as Extract<NoticeFix['action'], { type: 'patch' }>).ops);
    expect(effectiveLayout(fixed.pages[0], fixed.format)).toBe(fixed.pages[0].layout);
    expect(checkPagePlan(fixed, fixed.pages[0]).state).not.toBe('overfull');
    expect(suggestNextSteps(fixed)).toContain('Draw all pages');
    // No layout fits: a said chip points the director at the free fixes (split, move a line, caption).
    const none = overfullDoc(false);
    none.pages = [none.pages[1]];
    none.pages[0].n = 1;
    none.format.pageCount = 1;
    expect(suggestNextSteps(none)).toContain("Make page 1's words fit its panels");
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

  it('the "Plan the pages" price is per page, and the words bound it honestly (the repair is a second pass, not included)', () => {
    const doc = plannedDoc();
    doc.format.pageCount = 6;
    expect(planPagesUsd(doc, true)).toBeCloseTo(0.072, 4);
    const session = newSession(doc);
    const ctx = testContext(session, { keys: KEYS });
    const cost = costFormatterFor(ctx);
    const usd = planPagesUsd(doc, false);
    expect(planPagesQuoteText(doc, cost, false)).toBe(`${cost.approx(usd)} for 6 pages (up to ${cost.approx(Math.round(2 * usd * 10000) / 10000)} if the plan needs its one writer repair)`);
    expect(planPagesQuoteText(doc, cost, false)).not.toMatch(/pages, up to one writer repair/);
  });

  it('a whole plan refused at the budget cap says what planning costs, with the repair bound', async () => {
    const doc = plannedDoc();
    doc.format.pageCount = 6;
    doc.settings = { ...doc.settings, budgetUsd: 1 };
    doc.spend = { ...doc.spend, totalUsd: 1 };
    const session = newSession(doc);
    const ctx = testContext(session, { keys: KEYS });
    const out = await startAction(ctx, { type: 'plan_pages', instructions: 'tighter' }, { confirmed: true });
    expect(out.outcome).toMatchObject({ status: 'blocked', code: 'BUDGET_EXCEEDED' });
    const price = planPagesQuoteText(doc, costFormatterFor(ctx), false);
    expect(out.outcome.message).toContain(`planning is ${price}`);
    expect(session.doc.conversation.at(-1)!.text).toContain(`(planning is ${price})`);
    expect(vi.mocked(writePagePlan)).not.toHaveBeenCalled();
  });
});
