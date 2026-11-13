// Gate outcome stamps (PROGRAM3 SETTLE-SRV; settle.md §5.6, V.7; bug B3). Every gate write goes through commitGate,
// which stamps `closed` on the gate's card in the same commit, so a settled card says what happened after doc.gate
// moved on, and a close the studio made never reads as the creator's "Not now". The :1337 reopen clears it again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, type Card, type ComicDoc, type Page } from '../../../shared/comic/doc.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities.js';
import { cardSettle, gateClosedOf, planCountsOf, summaryOf, type GateClosed } from '../../../shared/comic/settle.js';
import { costFormatter, costViewFor } from './costText.js';
import { sixPageDrawnDoc } from './golden/fixtures.js';
import { JOB_TIMINGS, estimateSpendAction, planInputHashOf, runAction, startAction } from './jobs.js';
import { newSession, plannedDoc, testContext } from './orchestrator.fakes.js';
import { recoveryOps, GATE_EXPIRY_MS } from './session.js';
import { analyzePageRender } from './vision.js';
import { writePagePlan } from './writer.js';

vi.mock('./writer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./writer.js')>();
  return { ...actual, writePagePlan: vi.fn(actual.writePagePlan) };
});
vi.mock('./vision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vision.js')>();
  return { ...actual, analyzePageRender: vi.fn(actual.analyzePageRender) };
});

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
  vi.mocked(writePagePlan).mockReset();
  vi.mocked(analyzePageRender).mockReset();
  vi.restoreAllMocks();
});

/** The gate card for `gateId` and its message index. */
const gateCard = (doc: ComicDoc, gateId: string): { i: number; card: Card } => {
  for (const [i, m] of doc.conversation.entries()) {
    const card = (m.cards || []).find((c) => c.type === 'gate' && c.gateId === gateId);
    if (card) return { i, card };
  }
  throw new Error(`no card for ${gateId}`);
};
const stampOf = (doc: ComicDoc, gateId: string): GateClosed | undefined => gateClosedOf(gateCard(doc, gateId).card);
const lineOf = (doc: ComicDoc, gateId: string, cost = costFormatter()): string | undefined => {
  const { i, card } = gateCard(doc, gateId);
  return summaryOf(card, doc, cardSettle(doc, i, card), cost)?.text;
};
const readyPage = (page: Page, path: string): Page => ({ ...page, render: { ...emptyRender(), status: 'ready', asset: { path, source: 'generated', at: 1, w: 1024, h: 1536 } } });
const governedCaps: StudioCaps = { ...DEFAULT_CAPS, usage: { governed: true, pctPerStandardPage: 2 } as StudioCaps['usage'] };

describe('commitGate stamps the gate card', () => {
  it('approve stamps approved with the quote it was approved at; the settled line reads it, and a governed line has no $', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_cover' }, { confirmed: false });
    const gate = session.doc.gate!;
    expect(stampOf(session.doc, gate.id)).toBeUndefined();
    await runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: false, origin: 'user' });
    expect(session.doc.gate?.status).toBe('approved');
    expect(stampOf(session.doc, gate.id)).toEqual({
      status: 'approved', by: 'user', usd: gate.estimateUsd, imageCount: gate.imageCount, model: gate.model, at: expect.any(Number)
    });
    expect(lineOf(session.doc, gate.id)).toBe(`Approved · ≈ $${gate.estimateUsd.toFixed(2)} · 1 image`);
    const governed = lineOf(session.doc, gate.id, costFormatter(costViewFor(governedCaps)))!;
    expect(governed).toMatch(/^Approved · .*of your usage · 1 image$/);
    expect(governed).not.toMatch(/[$¢]/);
  });

  it('a new gate stamps the open gate it replaces; the old card says so, never "Not now"', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_cover' }, { confirmed: false });
    const first = session.doc.gate!;
    await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, { confirmed: false });
    const second = session.doc.gate!;
    expect(second.id).not.toBe(first.id);
    expect(stampOf(session.doc, first.id)).toEqual({ status: 'replaced', by: 'system', at: expect.any(Number) });
    expect(lineOf(session.doc, first.id)).toBe('Closed — a newer approval replaced it');
    // The new gate is the open one.
    const { i, card } = gateCard(session.doc, second.id);
    expect(cardSettle(session.doc, i, card)).toEqual({ state: 'open' });
    expect(stampOf(session.doc, second.id)).toBeUndefined();
  });

  it('a stale approval re-quotes: the old card is stamped replaced by the studio, not declined by the user', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, { confirmed: false });
    const first = session.doc.gate!;
    session.commit([{ op: 'settings', patch: { quality: 'pro' } }]);
    await runAction(ctx, { type: 'approve_gate', gateId: first.id }, { confirmed: false, origin: 'user' });
    expect(session.doc.gate?.id).not.toBe(first.id);
    expect(stampOf(session.doc, first.id)).toMatchObject({ status: 'replaced', by: 'system' });
  });

  it('nothing_to_draw is stamped by the system ("Nothing left to draw")', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    for (const c of doc.cast) c.sheet = { ...c.sheet, status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } };
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_pages', pageIds: ['pg_3'] }, { confirmed: false });
    const gate = session.doc.gate!;
    session.commit([{ op: 'page_delete', id: 'pg_3', deletedAt: Date.now() }], { origin: 'user' });
    await runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: true, origin: 'user' });
    expect(session.doc.gate).toMatchObject({ id: gate.id, status: 'declined', closedReason: 'nothing_to_draw' });
    expect(stampOf(session.doc, gate.id)).toEqual({ status: 'nothing_to_draw', by: 'system', at: expect.any(Number) });
    expect(lineOf(session.doc, gate.id)).toBe('Nothing left to draw — nothing spent');
  });

  it('the :1337 reopen clears the stamp: an approval that never ran is open again and never reads "Approved"', async () => {
    const doc = plannedDoc();
    doc.pages[0] = readyPage(doc.pages[0], 'page1.webp');
    doc.settings.confirm = 'always';
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'edit_page', pageId: 'pg_1', instruction: 'make it night' }, { confirmed: false });
    const gate = session.doc.gate!;
    // The page starts drawing before the tap, so the approved edit cannot start.
    session.commit([{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { status: 'rendering' } }]);
    const stamps: (GateClosed | undefined)[] = [];
    const off = session.subscribe((e) => {
      if (e.type === 'ops' && e.ops.some((op) => op.op === 'gate')) stamps.push(stampOf(session.doc, gate.id));
    });
    await expect(runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: false, origin: 'user' })).rejects.toMatchObject({ status: 409 });
    off();
    // Stamped 'approved' with the approval, then cleared with the reopen.
    expect(stamps.map((s) => s?.status)).toEqual(['approved', undefined]);
    expect(session.doc.gate?.status).toBe('open');
    expect(stampOf(session.doc, gate.id)).toBeUndefined();
    const { i, card } = gateCard(session.doc, gate.id);
    expect(cardSettle(session.doc, i, card)).toEqual({ state: 'open' });
  });

  it('"Not now" is the creator’s own decline: stamped by the user', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_cover' }, { confirmed: false });
    const gate = session.doc.gate!;
    await runAction(ctx, { type: 'decline_gate', gateId: gate.id }, { confirmed: false, origin: 'user' });
    expect(stampOf(session.doc, gate.id)).toEqual({ status: 'declined', by: 'user', at: expect.any(Number) });
    expect(lineOf(session.doc, gate.id)).toBe('Not now — nothing spent');
  });

  it('a newer spend that makes the gate moot stamps it superseded by the system (:1948)', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, confirm: 'big', bigSpendUsd: 5 };
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_cover' }, { confirmed: false, forceGate: 'no_intent' });
    const gate = session.doc.gate!;
    expect(gate.status).toBe('open');
    const started = await startAction(ctx, { type: 'render_cover' }, { confirmed: true, origin: 'user' });
    await started.done;
    await ctx.settled();
    expect(session.doc.gate).toMatchObject({ id: gate.id, status: 'declined' });
    expect(stampOf(session.doc, gate.id)).toEqual({ status: 'superseded', by: 'system', at: expect.any(Number) });
    expect(lineOf(session.doc, gate.id)).toBe('Closed — a newer request covered it');
    expect(lineOf(session.doc, gate.id)).not.toMatch(/Not now/);
  });

  it('a confirmed re-check makes the open re-check gate moot: stamped superseded by the system (:2022)', async () => {
    const doc = plannedDoc();
    doc.pages[0] = readyPage(doc.pages[0], 'u/user-1/p/proj-1/img/p1.webp');
    const session = newSession(doc);
    const ctx = testContext(session);
    vi.mocked(analyzePageRender).mockImplementation(async ({ page }) => ({
      qc: { score: 0.9, issues: [], checkedAt: 2 },
      balloons: page.panels.flatMap((p) => p.lines.map((l) => ({ lineId: l.id, x: 0.1, y: 0.1, w: 0.3 }))),
      model: 'v'
    }));
    await startAction(ctx, { type: 'recheck_page', pageId: 'pg_1' }, { confirmed: false, origin: 'user', forceGate: 'policy' });
    const gate = session.doc.gate!;
    expect(gate).toMatchObject({ status: 'open', action: { type: 'recheck_page', pageId: 'pg_1' } });
    const quotedUsd = estimateSpendAction(session.doc, { type: 'recheck_page', pageId: 'pg_1' }, false).usd;
    const ran = await startAction(ctx, { type: 'recheck_page', pageId: 'pg_1', quotedUsd }, { confirmed: true, origin: 'user' });
    await ran.done;
    expect(session.doc.gate).toMatchObject({ id: gate.id, status: 'declined' });
    expect(stampOf(session.doc, gate.id)).toEqual({ status: 'superseded', by: 'system', at: expect.any(Number) });
    expect(lineOf(session.doc, gate.id)).toBe('Closed — a newer request covered it');
  });
});

describe('expiry (session.ts recoveryOps)', () => {
  it('an open gate older than a day is declined and its card stamped expired, in the same ops', () => {
    const now = 100 * GATE_EXPIRY_MS;
    const doc = plannedDoc();
    const gate = { id: 'g1', action: { type: 'render_cover' as const }, title: 't', summary: 's', estimateUsd: 0.1, imageCount: 1, model: 'Model A', createdAt: now - GATE_EXPIRY_MS - 1, status: 'open' as const, reason: 'policy' as const };
    doc.gate = gate;
    doc.conversation = [{ id: 'm1', role: 'assistant', text: 'Approve?', at: 1, cards: [{ type: 'gate', id: 'cg', gateId: 'g1' }] }];
    const ops = recoveryOps(doc, { now, allInFlight: true });
    expect(ops[0]).toEqual({ op: 'gate', gate: { ...gate, status: 'declined' } });
    expect(ops[1]).toEqual({ op: 'message_patch', id: 'm1', patch: { cards: [{ type: 'gate', id: 'cg', gateId: 'g1', closed: { status: 'expired', by: 'system', at: now } }] } });
    const session = newSession(doc);
    session.commit(ops, { origin: 'job' });
    expect(lineOf(session.doc, 'g1')).toBe('Closed after a day — nothing spent');
    // A fresh gate is left alone.
    expect(recoveryOps({ ...doc, gate: { ...gate, createdAt: now - 1 } }, { now, allInFlight: true }).some((op) => op.op === 'message_patch')).toBe(false);
  });
});

describe('book cards get their counts where jobs.ts posts them', () => {
  it('plan_pages posts its breakdown with { pages, panels } stamped', async () => {
    const doc = plannedDoc();
    doc.pages = [];
    doc.planStatus = 'none';
    const session = newSession(doc);
    const ctx = testContext(session);
    vi.mocked(writePagePlan).mockImplementation(async () => ({ pages: plannedDoc().pages, newCast: [], model: 'fake-writer' }));
    await runAction(ctx, { type: 'plan_pages' }, { confirmed: true });
    const book = session.doc.conversation.flatMap((m) => m.cards || []).find((c) => c.type === 'breakdown');
    expect(book).toBeTruthy();
    expect(planCountsOf(book)).toEqual({ pages: session.doc.pages.length, panels: session.doc.pages.reduce((n, p) => n + p.panels.length, 0) });
  });
  it('the unchanged-inputs plan reply carries counts too (no writer call)', async () => {
    const doc = plannedDoc();
    doc.planInputHash = planInputHashOf(doc);
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'plan_pages' }, { confirmed: true });
    expect(vi.mocked(writePagePlan)).not.toHaveBeenCalled();
    const last = session.doc.conversation.at(-1)!;
    expect(last.text).toMatch(/^Nothing changed since the plan was written/);
    const book = (last.cards || []).find((c) => c.type === 'breakdown');
    expect(planCountsOf(book)).toEqual({ pages: doc.pages.length, panels: doc.pages.reduce((n, p) => n + p.panels.length, 0) });
  });

  it('render_pages with nothing to draw posts its status breakdown with counts', async () => {
    const doc = sixPageDrawnDoc();
    const session = newSession(doc);
    const ctx = testContext(session);
    const out = await startAction(ctx, { type: 'render_pages', pageIds: ['pg_six_1'] }, { confirmed: true, origin: 'user' });
    expect(out.outcome.status).toBe('nothing');
    const book = (session.doc.conversation.at(-1)!.cards || []).find((c) => c.type === 'breakdown');
    expect(book).toMatchObject({ view: 'status', pageIds: ['pg_six_1'] });
    expect(planCountsOf(book)).toEqual({ pages: 1, panels: doc.pages[0].panels.length });
  });
});
