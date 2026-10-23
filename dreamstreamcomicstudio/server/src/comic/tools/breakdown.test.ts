// Director tool group "breakdown" (show_pages, quote) and the show_breakdown action.
// Free reads of the doc: no ops (except the message carrying a card), no spend, no model calls.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageSpecHash, type Card, type ComicDoc } from '../../../../shared/comic/doc.js';
import { formatUsd } from '../../../../shared/comic/models.js';
import { quoteRenderPages, unitPrice } from '../../../../shared/comic/plan.js';
import { estimateSpendAction } from '../jobs.js';
import { newSession, opsOf, plannedDoc, testContext } from '../orchestrator.fakes.js';
import { createDirectorTurn } from '../tools.js';
import { BREAKDOWN_ACTIONS, showBreakdownAction } from '../actions/breakdown.js';
import { ACTION_HANDLERS } from '../actions/index.js';
import { toolGroupById } from './index.js';
import { breakdownCardFor, breakdownToolGroup, pageRanges, resolvePageNumbers, sanitizeBreakdownPageIds } from './breakdown.js';
import { StudioError } from '../types.js';
import { estimateTranslation } from '../i18n/index.js';

// The translation estimate is REAL (P1-I18N); a test can make it fail to check the honest wording.
const i18nFailure = vi.hoisted(() => ({ next: null as Error | null }));
vi.mock('../i18n/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../i18n/index.js')>();
  return {
    ...actual,
    estimateTranslation: (...args: Parameters<typeof actual.estimateTranslation>) => {
      const err = i18nFailure.next;
      i18nFailure.next = null;
      return err ? Promise.reject(err) : actual.estimateTranslation(...args);
    }
  };
});
afterEach(() => {
  i18nFailure.next = null;
});

const setup = (doc: ComicDoc = plannedDoc()) => {
  const session = newSession(doc);
  const ctx = testContext(session);
  const turn = createDirectorTurn();
  const tools = Object.fromEntries(breakdownToolGroup.tools(ctx, turn).map((t) => [t.spec.function.name, t]));
  return { session, ctx, turn, tools };
};

/** Every page and sheet drawn and current. */
const drawnDoc = (): ComicDoc => {
  const doc = plannedDoc();
  doc.cast = doc.cast.map((c) => ({ ...c, sheet: { status: 'ready', history: [], asset: { path: `u/x/${c.id}.webp`, source: 'generated', at: 1 } } }));
  doc.pages = doc.pages.map((p) => ({
    ...p,
    render: { status: 'ready', history: [], asset: { path: `u/x/${p.id}.webp`, source: 'generated', at: 1, w: 800, h: 1200 }, specHash: pageSpecHash(doc, p), costUsd: 0.06 }
  }));
  return doc;
};

describe('registration', () => {
  it('is the registered breakdown group: always on, two FREE tools, prompt rules, activity labels', () => {
    expect(toolGroupById('breakdown')).toBe(breakdownToolGroup);
    const { ctx, turn, tools } = setup();
    expect(breakdownToolGroup.when?.(ctx, turn)).toBe(true);
    expect(Object.keys(tools)).toEqual(['show_pages', 'quote']);
    for (const t of Object.values(tools)) {
      expect(t.cost).toBe('free');
      expect(t.spec.function.description.startsWith('FREE — ')).toBe(true);
    }
    expect(breakdownToolGroup.promptRules?.(plannedDoc())).toMatch(/show_pages/);
    expect(breakdownToolGroup.activity).toMatchObject({ show_pages: expect.any(String), quote: expect.any(String) });
    expect(ACTION_HANDLERS.show_breakdown).toBe(showBreakdownAction);
    expect(BREAKDOWN_ACTIONS).toHaveLength(1);
  });

  it('summary line states what is left to draw with the real quote', () => {
    const doc = plannedDoc();
    const q = quoteRenderPages(doc, { byok: false, tier: doc.settings.quality });
    expect(breakdownToolGroup.summaryLines?.(doc, createDirectorTurn())).toEqual([
      `Breakdown: 3 pages, 0 drawn; to draw now: pages 1–3 ≈${formatUsd(q.usd)}; cover not drawn.`
    ]);
    expect(breakdownToolGroup.summaryLines?.(drawnDoc(), createDirectorTurn())[0]).toContain('nothing left to draw ($0)');
  });
});

describe('show_pages', () => {
  it('posts one live breakdown card and answers with the compact facts', async () => {
    const { ctx, turn, tools, session } = setup();
    const text = await tools.show_pages.execute({});
    expect(turn.cards).toHaveLength(1);
    const card = turn.cards[0] as Extract<Card, { type: 'breakdown' }>;
    expect(card).toMatchObject({ type: 'breakdown', view: 'plan', cover: true });
    expect(card.pageIds).toBeUndefined();
    const q = quoteRenderPages(session.doc, { byok: false, tier: session.doc.settings.quality });
    expect(text).toContain('3 pages · 9 panels');
    expect(text).toContain('cast: MAYA (no reference yet), ARJUN (no reference yet)');
    expect(text).toContain('cover not drawn');
    expect(text).toContain(`Not drawn: pages 1–3 (≈${formatUsd(q.usd)} incl. 2 character sheets`);
    // a second call re-scopes the same card instead of stacking another
    await tools.show_pages.execute({ pages: [2], view: 'cost' });
    expect(turn.cards).toHaveLength(1);
    expect(turn.cards[0]).toMatchObject({ id: card.id, pageIds: ['pg_2'], view: 'cost', cover: false });
    expect(opsOf(ctx.events)).toEqual([]); // nothing committed
  });

  it('says $0 for a fully drawn book and defaults to the art view', async () => {
    const { turn, tools } = setup(drawnDoc());
    const text = await tools.show_pages.execute({});
    expect(turn.cards[0]).toMatchObject({ view: 'status' });
    expect(text).toContain('pages 1–3 drawn ($0.18)');
    expect(text).toContain('Not drawn: nothing');
    expect(text).toContain('$0 to draw');
  });

  it('is honest about unknown pages and an empty book', async () => {
    const { turn, tools } = setup();
    expect(await tools.show_pages.execute({ pages: [7, 9] })).toBe('There are no pages 7, 9. This book has pages 1–3. Nothing was shown.');
    expect(await tools.show_pages.execute({ pages: [7] })).toBe('There is no page 7. This book has pages 1–3. Nothing was shown.');
    expect(turn.cards).toHaveLength(0);
    const partial = await tools.show_pages.execute({ pages: [1, 8] });
    expect(partial).toContain('There is no page 8');
    expect(turn.cards[0]).toMatchObject({ pageIds: ['pg_1'] });
    expect(await tools.show_pages.execute({ pages: ['x'] })).toMatch(/^Error: pages must be page numbers/);
    const empty = plannedDoc();
    empty.pages = [];
    const e = setup(empty);
    expect(await e.tools.show_pages.execute({})).toMatch(/no pages yet/);
    expect(e.turn.cards).toHaveLength(0);
  });
});

describe('cover honesty', () => {
  it('a cover drawn from an older title is "out of date", a failed one "failed" — never "not drawn"', async () => {
    const stale = drawnDoc();
    stale.cover = { ...stale.cover, render: { status: 'ready', history: [], asset: { path: 'u/x/cover.webp', source: 'generated', at: 1 }, specHash: 'an-older-title' } };
    const cover = estimateSpendAction(stale, { type: 'render_cover' }, false);
    const a = setup(stale);
    const text = await a.tools.show_pages.execute({});
    expect(text).toContain(`cover out of date — the title, style or cast changed since it was drawn (≈${formatUsd(cover.usd)} to redraw)`);
    expect(text).not.toContain('cover not drawn');
    expect(breakdownToolGroup.summaryLines?.(stale, createDirectorTurn())[0]).toContain('cover out of date.');

    const failed = drawnDoc();
    failed.cover = { ...failed.cover, render: { status: 'failed', history: [], error: 'boom' } };
    expect(await setup(failed).tools.show_pages.execute({})).toContain(`cover failed (≈${formatUsd(cover.usd)} to try again)`);
    expect(breakdownToolGroup.summaryLines?.(failed, createDirectorTurn())[0]).toContain('cover failed.');
  });
});

describe('quote', () => {
  it('render_pages equals the gate estimate and never counts drawn, current pages', async () => {
    const { tools, session } = setup();
    const gate = estimateSpendAction(session.doc, { type: 'render_pages' }, false);
    const text = await tools.quote.execute({ action: 'render_pages' });
    expect(text).toContain(`≈${formatUsd(gate.usd)} to draw 3 pages + 2 character sheets (pages 1–3)`);
    expect(text).toContain('Quote only — nothing was started.');

    const drawn = setup(drawnDoc());
    const zero = await drawn.tools.quote.execute({ action: 'render_pages', pages: [2] });
    const per = unitPrice(drawn.session.doc, 'page', { byok: false }).usd;
    expect(zero).toMatch(/^\$0 — nothing would be drawn\./);
    expect(zero).toContain('Already drawn and current (not counted): page 2.');
    expect(zero).toContain(`A new take is only for when the user asks for another version: ≈${formatUsd(per)} a page (1 page ≈${formatUsd(per)}).`);
  });

  it('a new take of a drawn page whose character has no sheet is priced with that sheet (the gate draws it too)', async () => {
    const doc = drawnDoc();
    doc.cast = doc.cast.map((c, i) => (i === 0 ? { ...c, sheet: { status: 'none', history: [] } } : c));
    const page = doc.pages.find((p) => p.panels.some((panel) => panel.castIds.includes(doc.cast[0].id)))!;
    page.render = { ...page.render, specHash: pageSpecHash(doc, page) }; // drawn and current with the sheet missing
    const gate = estimateSpendAction(doc, { type: 'render_pages', pageIds: [page.id], force: true }, false);
    const text = await setup(doc).tools.quote.execute({ action: 'render_pages', pages: [page.n] });
    expect(text).toMatch(/^\$0 — nothing would be drawn\./);
    expect(text).toContain(`(1 page ≈${formatUsd(gate.usd)} incl. 1 character sheet).`);
  });

  it('include_cover adds the cover; cover, sheets and edits use the gate estimate', async () => {
    const { tools, session } = setup();
    const doc = session.doc;
    expect(await tools.quote.execute({ action: 'render_pages', include_cover: true })).toContain('+ the cover');
    const cover = estimateSpendAction(doc, { type: 'render_cover' }, false);
    expect(await tools.quote.execute({ action: 'render_cover' })).toContain(`≈${formatUsd(cover.usd)} for the cover`);
    const sheets = estimateSpendAction(doc, { type: 'render_sheets' }, false);
    expect(await tools.quote.execute({ action: 'render_sheets' })).toContain(`≈${formatUsd(sheets.usd)} for 2 character sheets (MAYA, ARJUN)`);
    expect(await tools.quote.execute({ action: 'edit_page', pages: [1] })).toMatch(/Page 1 isn't drawn yet, so there is nothing to edit/);
    const drawn = setup(drawnDoc());
    const edit = estimateSpendAction(drawn.session.doc, { type: 'edit_page', pageId: 'pg_1', instruction: 'x' }, false);
    expect(await drawn.tools.quote.execute({ action: 'edit_page', pages: [1] })).toContain(`≈${formatUsd(edit.usd)} per image edit of page 1`);
    expect(await drawn.tools.quote.execute({ action: 'render_sheets' })).toMatch(/^\$0 — every lead and support character already has a sheet/);
  });

  it('translation: the real quote; honest when the estimate is unavailable; validates languages and actions', async () => {
    const { tools, ctx } = setup();
    // The real estimate: priced lines by the translator + the linguist review, quote only.
    const est = await estimateTranslation(ctx, { type: 'translate', languages: ['te', 'hi'] });
    const t = await tools.quote.execute({ action: 'translate', languages: ['Telugu', 'hi'] });
    expect(t.startsWith(est.usd > 0 ? `≈${formatUsd(est.usd)} to translate into Telugu, Hindi: ` : '$0 to translate into Telugu, Hindi: ')).toBe(true);
    expect(t).toMatch(/by the translator with a linguist review/);
    expect(ctx.session.doc.spend.entries).toHaveLength(0); // a quote never spends
    // Unavailable (e.g. no translator model): an honest sentence, never a made-up price.
    i18nFailure.next = new StudioError('NOT_AVAILABLE', 'Translation is unavailable right now.', { status: 503 });
    expect(await tools.quote.execute({ action: 'translate', languages: ['te'] })).toMatch(/^I can't price a translation right now: Translation is unavailable right now\./);
    expect(await tools.quote.execute({ action: 'translate', languages: ['Klingon'] })).toMatch(/I don't know Klingon as a language/);
    expect(await tools.quote.execute({ action: 'nope' })).toMatch(/^Error: action must be one of/);
    expect(await tools.quote.execute({ action: 'render_pages', pages: [12] })).toContain('There is no page 12. This book has pages 1–3.');
  });

  it('BYOK quotes say who pays', async () => {
    const session = newSession(plannedDoc());
    const ctx = testContext(session, { keys: { openrouter: { key: 'sk-or-mine', byok: true } } });
    const quote = breakdownToolGroup.tools(ctx, createDirectorTurn()).find((t) => t.spec.function.name === 'quote')!;
    const gate = estimateSpendAction(session.doc, { type: 'render_pages' }, true);
    const text = await quote.execute({ action: 'render_pages' });
    expect(text).toContain(`≈${formatUsd(gate.usd)}`);
    expect(text).toContain('Billed to the user’s own key.');
  });
});

describe('show_breakdown action', () => {
  it('posts an assistant message with the card (whole book) and never spends', async () => {
    const { ctx, session } = setup();
    const started = await showBreakdownAction.run(ctx, { type: 'show_breakdown' }, { confirmed: false });
    expect(started.outcome).toEqual({ status: 'done', message: 'Here’s the breakdown: 3 pages · 9 panels.' });
    const msg = session.doc.conversation[session.doc.conversation.length - 1];
    expect(msg).toMatchObject({ role: 'assistant', text: 'Here’s the breakdown: 3 pages · 9 panels.' });
    expect(msg.cards?.[0]).toMatchObject({ type: 'breakdown', cover: true, view: 'plan' });
    expect(session.doc.spend.totalUsd).toBe(0);
  });

  it('sanitizes client page ids and collects into a director message when asked', async () => {
    const { ctx, session } = setup();
    const collected: Card[] = [];
    const before = session.doc.conversation.length;
    const r = await showBreakdownAction.run(ctx, { type: 'show_breakdown', pageIds: ['pg_2', 'evil', 'pg_2', 7 as unknown as string] }, { confirmed: false, collectCard: (c) => collected.push(c) });
    expect(session.doc.conversation).toHaveLength(before);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ type: 'breakdown', pageIds: ['pg_2'], cover: false });
    expect(r.outcome.message).toBe('Here’s the breakdown: 1 page of 3 · 3 panels.');
    const gone = await showBreakdownAction.run(ctx, { type: 'show_breakdown', pageIds: ['pg_deleted'] }, { confirmed: false });
    expect(gone.outcome.message).toMatch(/^Those pages are no longer in the book/);
  });

  it('an empty book gets an honest message and no card', async () => {
    const doc = plannedDoc();
    doc.pages = [];
    const { ctx, session } = setup(doc);
    const r = await showBreakdownAction.run(ctx, { type: 'show_breakdown' }, { confirmed: false });
    expect(r.outcome.status).toBe('done');
    const msg = session.doc.conversation[session.doc.conversation.length - 1];
    expect(msg.text).toMatch(/no pages yet/);
    expect(msg.cards).toBeUndefined();
  });
});

describe('helpers', () => {
  it('pageRanges, resolvePageNumbers, sanitize, card defaults', () => {
    expect(pageRanges([5, 1, 2, 3, 7, 8, 2])).toBe('1–3, 5, 7–8');
    const doc = plannedDoc();
    expect(resolvePageNumbers(doc, undefined)).toEqual({ unknown: [] });
    expect(resolvePageNumbers(doc, ['2', 3, 9]).pages?.map((p) => p.id)).toEqual(['pg_2', 'pg_3']);
    expect(resolvePageNumbers(doc, 1).pages?.map((p) => p.id)).toEqual(['pg_1']);
    expect(() => resolvePageNumbers(doc, [1.5])).toThrow();
    expect(sanitizeBreakdownPageIds(doc, 'pg_1')).toBeUndefined();
    expect(sanitizeBreakdownPageIds(doc, Array.from({ length: 500 }, () => 'pg_1'))).toEqual(['pg_1']);
    // a "subset" that is the whole book is the whole book (cover shown)
    expect(breakdownCardFor(doc, { pageIds: doc.pages.map((p) => p.id) })).toMatchObject({ cover: true });
    expect(breakdownCardFor(doc, { pageIds: doc.pages.map((p) => p.id) }).pageIds).toBeUndefined();
    const single = plannedDoc();
    single.pages = single.pages.slice(0, 1);
    expect(breakdownCardFor(single).cover).toBe(false);
    expect(breakdownCardFor(single, { gateId: 'g1' }).gateId).toBe('g1');
  });
});
