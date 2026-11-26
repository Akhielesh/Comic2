// @vitest-environment node
// Planning, style directions, the page re-check and translation are quoted from what they really cost
// (docs/features/pricing.md § Text rates): the request's PriceBook carries the observed rates, every quote of those
// steps reads them, never under the constants; and the calls of one planning pass carry one tag into the ledger.
// Synthetic docs and rates only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLAN_USD_PER_PAGE, PLATFORM_MARKUP, QC_USD_PER_PAGE, STYLE_DIRECTIONS_USD } from '../../../shared/comic/models.js';
import { priceBookFromSources, sanitizeTextRates } from '../../../shared/comic/priceBook.js';
import { estimateSpendAction, nextStepsFor, planPages, planPagesUsd, startAction, textRatesWithin } from './jobs.js';
import { estimateTranslation, quoteTranslation, resetTranslationCalibration } from './i18n/index.js';
import { TEXT_RATES_WAIT_MS } from './models/index.js';
import { setTextRateSource } from './models/textRates.js';
import { KEYS, fakeBilling, newSession, plannedDoc, scriptedLlm, testContext } from './orchestrator.fakes.js';
import { writePagePlan } from './writer.js';

vi.mock('./writer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./writer.js')>();
  return { ...actual, writePagePlan: vi.fn(actual.writePagePlan) };
});

afterEach(() => {
  vi.mocked(writePagePlan).mockReset();
  resetTranslationCalibration();
});

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const observed = sanitizeTextRates({ planPerPageUsd: PLAN_USD_PER_PAGE * 1.5, styleDirectionsUsd: STYLE_DIRECTIONS_USD * 2, translateFactor: 1.4 });
const book = priceBookFromSources({ rows: [], qc: { medianUsd: 0.0045, n: 9 }, text: observed });

describe('text steps quoted at their observed rates', () => {
  it('planning: the chip, the planning quote and the constant without a book', () => {
    const doc = plannedDoc();
    doc.planStatus = 'none';
    doc.format.pageCount = 6;
    expect(planPagesUsd(doc, false, book)).toBe(r4(6 * PLAN_USD_PER_PAGE * 1.5 * PLATFORM_MARKUP));
    expect(planPagesUsd(doc, false)).toBe(r4(6 * PLAN_USD_PER_PAGE * PLATFORM_MARKUP));
    const chip = nextStepsFor(doc, { byok: false, prices: book }).find((s) => s.label === 'Plan the pages');
    expect(chip?.usd).toBe(planPagesUsd(doc, false, book));
  });

  it('the page re-check at the book’s QC figure, style directions at their observed rate', () => {
    const doc = plannedDoc();
    const recheck = estimateSpendAction(doc, { type: 'recheck_page', pageId: doc.pages[0].id } as never, true, book);
    expect(recheck.usd).toBe(0.0045);
    expect(estimateSpendAction(doc, { type: 'recheck_page', pageId: doc.pages[0].id } as never, true).usd).toBe(QC_USD_PER_PAGE);
    const style = estimateSpendAction(doc, { type: 'render_style_options' }, true, book);
    expect(style.lines.find((l) => l.label === 'style directions')?.usd).toBe(r4(STYLE_DIRECTIONS_USD * 2));
  });

  it('a book with cheaper observations still quotes the constants', () => {
    const doc = plannedDoc();
    doc.format.pageCount = 6;
    const cheap = priceBookFromSources({ rows: [], qc: { medianUsd: 0.001, n: 9 }, text: { planPerPageUsd: 0.001, styleDirectionsUsd: 0.001, translateFactor: 0.5 } });
    expect(planPagesUsd(doc, true, cheap)).toBe(r4(6 * PLAN_USD_PER_PAGE));
    expect(cheap.qcUsd).toBe(QC_USD_PER_PAGE);
    expect(estimateSpendAction(doc, { type: 'recheck_page', pageId: doc.pages[0].id } as never, true, cheap).usd).toBe(QC_USD_PER_PAGE);
  });

  it('translation: the token estimate × the observed factor, never below the estimate', () => {
    const doc = plannedDoc();
    const base = quoteTranslation(doc, KEYS, { languages: ['te'] }).estimate.usd;
    expect(base).toBeGreaterThan(0);
    expect(quoteTranslation(doc, KEYS, { languages: ['te'] }, observed).estimate.usd).toBeCloseTo(base * 1.4, 3);
    expect(quoteTranslation(doc, KEYS, { languages: ['te'] }, { translateFactor: 0.4 }).estimate.usd).toBe(base);
  });
});

describe('the ledger tag', () => {
  it('every writer call of one planning pass carries the same tag, priced at the constant per page', async () => {
    const doc = plannedDoc();
    const pages = doc.pages;
    doc.pages = [];
    doc.planStatus = 'none';
    doc.format.pageCount = pages.length;
    vi.mocked(writePagePlan).mockImplementation(async (args) => {
      await args.llm.complete({ role: 'writer', messages: [{ role: 'user', content: 'outline' }] });
      await args.llm.complete({ role: 'writer', messages: [{ role: 'user', content: 'pages' }] });
      return { pages, newCast: [], model: 'w' };
    });
    const billing = fakeBilling();
    const ctx = testContext(newSession(doc), { billing, llm: scriptedLlm(), keys: KEYS });
    const out = await startAction(ctx, { type: 'plan_pages' }, { confirmed: true });
    expect(out.outcome.status).toBe('done');
    const writer = billing.reserves.filter((r) => r.stage === 'plan');
    expect(writer).toHaveLength(2);
    expect(writer[0].textOp).toMatchObject({ kind: 'plan', units: pages.length, baseUsd: r4(PLAN_USD_PER_PAGE * pages.length) });
    expect(writer[1].textOp?.id).toBe(writer[0].textOp?.id);
  });

  it('a repair round rides the same operation, marked, so the observed rate is one pass', async () => {
    const doc = plannedDoc();
    const pages = doc.pages;
    doc.pages = [];
    doc.planStatus = 'none';
    doc.format.pageCount = pages.length;
    vi.mocked(writePagePlan).mockImplementation(async (args) => {
      await args.llm.complete({ role: 'writer', messages: [{ role: 'user', content: 'pages' }] });
      await args.llm.complete({ role: 'writer', messages: [{ role: 'user', content: 'pages' }], repair: true });
      return { pages, newCast: [], model: 'w' };
    });
    const billing = fakeBilling();
    const ctx = testContext(newSession(doc), { billing, llm: scriptedLlm(), keys: KEYS });
    await startAction(ctx, { type: 'plan_pages' }, { confirmed: true });
    const [pass, repair] = billing.reserves.filter((r) => r.stage === 'plan');
    expect(pass.textOp?.repair).toBeUndefined();
    expect(repair.textOp).toMatchObject({ id: pass.textOp?.id, repair: true });
  });

  it('a rewrite of one page is not a whole plan: it carries no tag and never moves the planning rate', async () => {
    const doc = plannedDoc();
    doc.planStatus = 'approved';
    const page = doc.pages[1];
    vi.mocked(writePagePlan).mockImplementation(async (args) => {
      await args.llm.complete({ role: 'writer', messages: [{ role: 'user', content: 'one page' }] });
      return { pages: [{ ...page, summary: 'A sharper beat' }], newCast: [], model: 'w' };
    });
    const billing = fakeBilling();
    const ctx = testContext(newSession(doc), { billing, llm: scriptedLlm(), keys: KEYS });
    const out = await planPages(ctx, { pageIds: [page.id] });
    expect(out.status).toBe('done');
    const writer = billing.reserves.filter((r) => r.stage === 'plan');
    expect(writer).toHaveLength(1);
    expect(writer[0].textOp).toBeUndefined();
  });
});

describe('text rates are read from their own source', () => {
  afterEach(() => setTextRateSource(null));

  it('the translation gate and the planning checks never fall to the floor behind a cold image catalog', async () => {
    const source = { forUser: vi.fn(async () => observed) };
    setTextRateSource(source);
    const doc = plannedDoc();
    // No book handed to the request: its full book would wait on the image catalog; the text rates do not.
    const ctx = { ...testContext(newSession(doc), { keys: KEYS }), prices: undefined };
    expect(await textRatesWithin(ctx)).toEqual(observed);
    expect(source.forUser).toHaveBeenCalledWith(ctx.userId, { maxWaitMs: TEXT_RATES_WAIT_MS });
    const gate = await estimateTranslation(ctx, { type: 'translate', languages: ['te'] });
    expect(gate.usd).toBe(quoteTranslation(doc, KEYS, { languages: ['te'] }, observed).estimate.usd);
    expect(gate.usd).toBeGreaterThan(quoteTranslation(doc, KEYS, { languages: ['te'] }).estimate.usd);
  });

  it('a failing source is the constants, never an error', async () => {
    setTextRateSource({ forUser: async () => Promise.reject(new Error('down')) });
    const ctx = { ...testContext(newSession(plannedDoc()), { keys: KEYS }), prices: undefined };
    expect((await textRatesWithin(ctx)).planPerPageUsd).toBe(PLAN_USD_PER_PAGE);
  });

  it('a request handed its own book reads that book\'s rates', async () => {
    const ctx = testContext(newSession(plannedDoc()), { keys: KEYS, prices: book });
    expect((await textRatesWithin(ctx)).translateFactor).toBeCloseTo(1.4, 6);
  });
});
