// One true price (docs/features/pricing.md): every image surface prices with the ONE quote path — the shared helpers
// (shared/comic/plan.ts, models.ts estimateJobs, priceBook.ts) fed the person's PriceBook from their price sheet — and
// prints it with the ONE formatter (conversation/cost.ts). Two checks:
//   1. a source guard: in every surface that quotes, each quote helper call is handed the book (or is marked as
//      reading targets only), and nothing prices from the registry list or the constants directly;
//   2. the screen: with observed prices well above the registry, the Pages tab's Render all names the book's figure
//      (the one the server's gate names: server/src/comic/onePrice.parity.test.ts), never the registry one, and a
//      governed person reads it as a share of their usage.
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_CAPS, resolveStudioCaps } from '../../../shared/comic/capabilities';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { HealthState, ModelHealth } from '../../../shared/comic/modelHealth';
import { redrawQuote, redrawResolution } from '../../../shared/comic/modelLock';
import { PLATFORM_MARKUP, formatUsd, getImageModel, resolveImageJob } from '../../../shared/comic/models';
import { estimateDocJobs, quoteRenderPages } from '../../../shared/comic/plan';
import { priceBookFromSources, priceSheetOf } from '../../../shared/comic/priceBook';
import { DOLLAR_CONTEXT } from '../../../services/costDisplay';
import { __resetPriceSheetForTests, __seedPriceSheetForTests } from '../../../services/priceSheet';
import { costFormat } from '../conversation/cost';
import { PagesTab } from '../board/PagesTab';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from '../board/__fixtures__/sampleDoc';
import { CastCard } from '../conversation/cards/CastCard';
import { estimatePlanRender } from '../conversation/cards/PlanCard';
import { makeFakeStudio, makeSampleDoc as makeConversationDoc, resetUsageStatus, showDollarPrices } from '../conversation/testing/fixtures';
import { ModelStatusBanner } from '../reliability/ModelStatusBanner';
import { registryPriceBook } from '../reliability/options';
import { __resetStatusStore, __setStatusFetcherForTests } from '../reliability/statusStore';

const OWNER = 'owner-one-price';
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner-one-price' } }) }));

const ROOT = resolve(__dirname, '../..');
/** Every surface that shows an image (or text-step) price, and the quote helpers it calls. */
const SURFACES: Record<string, string[]> = {
  'comicstudio/board/PagesTab.tsx': ['quoteRenderPages', 'estimateDraw', 'estimateOne', 'redrawPrice', 'planUsd'],
  'comicstudio/board/CastTab.tsx': ['estimateOne', 'estimateDraw', 'sheetHint'],
  'comicstudio/board/StyleTab.tsx': ['estimateOne'],
  'comicstudio/board/PageEditor.tsx': ['estimateOne', 'estimateDraw', 'recheckQuoteUsd'],
  'comicstudio/breakdown/BreakdownCard.tsx': ['quoteRenderPages', 'summarizeBook', 'unitPrice'],
  'comicstudio/conversation/cards/RendersCard.tsx': ['quoteRenderPages', 'estimateDocJobs', 'retryAllFailed'],
  'comicstudio/conversation/cards/StyleChoiceCard.tsx': ['quoteStyleOptions', 'retryAllFailed'],
  'comicstudio/conversation/cards/PlanCard.tsx': ['quoteRenderPages', 'estimatePlanRender'],
  'comicstudio/conversation/cards/CastCard.tsx': ['estimateDocJobs'],
  'comicstudio/conversation/panels/FormatPanel.tsx': ['redrawQuoteUsd', 'unitPrice', 'estimateDocJobs'],
  'comicstudio/i18n/LanguagesTab.tsx': ['priceOf', 'estimateDocJobs'],
  'comicstudio/refs/refsModel.ts': ['unitPrice'],
  'comicstudio/refs/RefsDrawer.tsx': ['sheetHint'],
  'comicstudio/refs/RefStrip.tsx': ['sheetHint'],
  'comicstudio/refs/RefsCard.tsx': ['sheetHint'],
  'comicstudio/conversation/cards/NoticeCard.tsx': ['quoteRenderPages', 'liveNoticeChip', 'liveRenderQuote'],
  'comicstudio/conversation/panels/StylePanel.tsx': ['estimateDocJobs', 'quoteStyleOptions', 'styleDirectionsQuoteUsd'],
  'comicstudio/conversation/panels/QualityPanel.tsx': ['jobUnitUsd', 'jobQcUsd'],
  'comicstudio/timeline/BookTimeline.tsx': ['redrawPrice', 'planUsd'],
  'comicstudio/timeline/VersionStack.tsx': ['redrawPrice'],
  'comicstudio/history/HistoryPanel.tsx': ['redrawPrice'],
  'images/ImagePrice.tsx': ['standaloneQuoteUsd']
};
/** Pricing straight from the registry list or the constants, which the book replaces on every surface. */
const REGISTRY_ONLY = /\bimagePriceUsd\(|\bPLAN_USD_PER_PAGE\b|\bRELAYOUT_VISION_USD\b|\bQC_USD_PER_PAGE\b|\bstyleDirectionsUsd\(|\btierPagePrice\(/;

/** Each call `name(…)` in the source with its argument text (balanced parentheses) and the line before it. */
const callsOf = (src: string, name: string): { args: string; before: string }[] => {
  const out: { args: string; before: string }[] = [];
  const re = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    const lineStart = src.lastIndexOf('\n', m.index);
    const prevStart = src.lastIndexOf('\n', lineStart - 1);
    out.push({ args: src.slice(m.index + m[0].length, i - 1), before: src.slice(prevStart + 1, lineStart) });
  }
  return out;
};

describe('every surface uses the same quote path', () => {
  for (const [file, helpers] of Object.entries(SURFACES)) {
    it(file, () => {
      const src = readFileSync(resolve(ROOT, file), 'utf8');
      let seen = 0;
      for (const name of helpers) {
        for (const call of callsOf(src, name)) {
          seen++;
          if (/Targets only/.test(call.before)) continue;
          expect(call.args, `${file}: ${name}(${call.args.slice(0, 80)}…) must be handed the PriceBook`).toMatch(/\bprice[sd]\b|\bprices(?:Ref\.current)?\b/);
        }
      }
      expect(seen, `${file} quotes through the shared helpers`).toBeGreaterThan(0);
      expect(src, `${file} must not price from the registry or the constants directly`).not.toMatch(REGISTRY_ONLY);
    });
  }

  it('the model picker and the model-change redraw take their figures from the shared book', () => {
    expect(readFileSync(resolve(ROOT, 'comicstudio/models/priceBook.ts'), 'utf8')).toMatch(/\bshared\.quote\(/);
  });

  it('the standalone image is the book\'s own job quote', () => {
    expect(readFileSync(resolve(ROOT, 'images/ImagePrice.tsx'), 'utf8')).toMatch(/\bbook\.jobQuote\(/);
  });
});

describe('the screen names the book’s price', () => {
  const doc = makeSampleDoc();
  const job = resolveImageJob('page', doc.settings.quality, doc.settings.imageModelOverride);
  const sheet = priceSheetOf(
    { rows: [], observed: [{ modelId: job.spec.id, kind: 'page', res: job.resolution, n: 8, medianUsd: 0.4, minUsd: 0.38, maxUsd: 0.45, scope: 'you' }], qc: { medianUsd: 0.008, n: 9 } },
    SAMPLE_NOW
  );
  const book = priceBookFromSources(sheet.sources);
  const header = () => document.querySelector('#pages-draw-all-price') as HTMLElement;

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    __resetPriceSheetForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    __resetPriceSheetForTests();
  });

  it('own key: Render all is the book’s figure, printed by the one formatter — not the registry list', () => {
    __seedPriceSheetForTests(OWNER, sheet);
    const studio = makeStudio(doc, { caps: { ...DEFAULT_CAPS, byok: true } });
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    const opts = { byok: true, tier: doc.settings.quality, modelOverride: doc.settings.imageModelOverride };
    const real = quoteRenderPages(doc, { ...opts, prices: book }).usd;
    const registry = quoteRenderPages(doc, opts).usd;
    const fmt = costFormat(DOLLAR_CONTEXT);
    expect(fmt.approx(real)).not.toBe(fmt.approx(registry));
    expect(header().textContent).toContain(fmt.approx(real));
    expect(header().textContent).not.toContain(fmt.approx(registry));
  });

  it('before the sheet arrives the board quotes the registry list (and then the book, once it is read)', () => {
    const studio = makeStudio(doc, { caps: { ...DEFAULT_CAPS, byok: true } });
    const { rerender } = render(<PagesTab studio={studio} doc={studio.doc!} />);
    const opts = { byok: true, tier: doc.settings.quality, modelOverride: doc.settings.imageModelOverride };
    const fmt = costFormat(DOLLAR_CONTEXT);
    expect(header().textContent).toContain(fmt.approx(quoteRenderPages(doc, opts).usd));
    __seedPriceSheetForTests(OWNER, sheet);
    rerender(<PagesTab studio={studio} doc={studio.doc!} />);
    expect(header().textContent).toContain(fmt.approx(quoteRenderPages(doc, { ...opts, prices: book }).usd));
  });

  /** Page 2's words do not fit its panels: Render all holds it back (the server's plan check, PD-1). */
  const withOverfull = (): ComicDoc =>
    makeSampleDoc((d) => {
      const said = Array.from({ length: 60 }, (_, i) => ['listen', 'the', 'carrier', 'behind', 'those', 'stalls'][i % 6]).join(' ');
      const p = d.pages.find((x) => x.id === 'pg_2')!;
      p.layout = 'Row 1: three small panels.';
      p.panels = p.panels.map((pn, i) => ({ ...pn, size: 'small', lines: [{ id: `ln_over_${i}`, kind: 'speech', speakerId: 'ch_maya', text: said }] }));
    });

  it('Render all with a page held back: the board and the plan card name the server gate\'s figure (the page left out)', () => {
    __seedPriceSheetForTests(OWNER, sheet);
    const held = withOverfull();
    const studio = makeStudio(held, { caps: { ...DEFAULT_CAPS, byok: true } });
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    const opts = { byok: true, tier: held.settings.quality, modelOverride: held.settings.imageModelOverride };
    // The server's render_pages quote for a Render all (server/src/comic/onePrice.parity.test.ts checks it is this).
    const gate = quoteRenderPages(held, { ...opts, holdBack: {}, prices: book });
    expect(gate.heldBackIds).toEqual(['pg_2']);
    const everything = quoteRenderPages(held, { ...opts, prices: book }).usd;
    const fmt = costFormat(DOLLAR_CONTEXT);
    expect(fmt.approx(gate.usd)).not.toBe(fmt.approx(everything));
    expect(header().textContent).toContain(fmt.approx(gate.usd));
    expect(header().textContent).not.toContain(fmt.approx(everything));
    expect(estimatePlanRender(held, true, book).estimate.usd).toBe(gate.usd);
  });

  it('governed: the same price as a share of the usage, and no dollar sign anywhere on the board', () => {
    __seedPriceSheetForTests(OWNER, sheet);
    const studio = makeStudio(doc, { caps: { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 70, exhausted: false, pctPerStandardPage: 1.5 } } });
    const { container } = render(<PagesTab studio={studio} doc={studio.doc!} />);
    expect(header().textContent).toMatch(/% of your usage/);
    expect(container.textContent).not.toContain('$');
  });
});

describe('the chat\'s Cast card names the book\'s price and sends it as the quote', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    __resetPriceSheetForTests();
    showDollarPrices();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    __resetPriceSheetForTests();
    resetUsageStatus();
  });

  it('Draw 1 sheet: the label and quotedUsd are the book\'s figure, not the registry list', async () => {
    const doc = makeConversationDoc();
    const job = resolveImageJob('sheet', doc.settings.quality, doc.settings.imageModelOverride);
    const sheet = priceSheetOf({ rows: [], observed: [{ modelId: job.spec.id, kind: 'sheet', res: job.resolution, n: 8, medianUsd: 0.35, minUsd: 0.3, maxUsd: 0.4, scope: 'you' }], qc: null }, SAMPLE_NOW);
    __seedPriceSheetForTests(OWNER, sheet);
    const book = priceBookFromSources(sheet.sources);
    const real = estimateDocJobs(doc, [{ kind: 'sheet', count: 1, label: 'character sheets' }], { byok: false, prices: book }).usd;
    const registry = estimateDocJobs(doc, [{ kind: 'sheet', count: 1, label: 'character sheets' }], { byok: false }).usd;
    expect(real).toBeGreaterThan(registry);
    const studio = makeFakeStudio({ doc });
    render(<CastCard card={{ type: 'cast', id: 'card_c', characterIds: ['c_maya', 'c_arjun'] }} studio={studio} />);
    const button = screen.getByRole('button', { name: /Draw 1 sheet/ });
    expect(button.textContent).toContain(costFormat(DOLLAR_CONTEXT).approx(real));
    fireEvent.click(button);
    await waitFor(() => expect(studio.act).toHaveBeenCalledWith(expect.objectContaining({ type: 'render_sheets', characterIds: ['c_arjun'], quotedUsd: real })));
  });
});

describe('the model-status banner names the book\'s price for "Try X instead"', () => {
  const NB21 = 'nano-banana-2.1';
  const PRO = 'nano-banana-pro';
  const healthOf = (modelId: string, state: HealthState): ModelHealth => ({
    modelId,
    state,
    checkedAt: Date.now(),
    routes: [
      {
        route: 'openrouter',
        model: getImageModel(modelId)?.routes.openrouter || modelId,
        state,
        providers: [{ name: 'Google AI Studio', status: state === 'down' ? -1 : 0, uptime30m: state === 'down' ? 41 : 99, uptime1d: 95 }],
        ...(state === 'down' ? { reason: 'Every provider reports a problem' } : {}),
        checkedAt: Date.now(),
        source: 'openrouter'
      }
    ]
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    __resetPriceSheetForTests();
    __resetStatusStore();
    __setStatusFetcherForTests(async (ids) => ids.map((id) => healthOf(id, id === NB21 ? 'down' : 'ok')));
    sessionStorage.clear();
    showDollarPrices();
  });
  afterEach(() => {
    __setStatusFetcherForTests(null);
    __resetStatusStore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    __resetPriceSheetForTests();
    resetUsageStatus();
  });

  it('before any outage card: the per-image figure and the redraw are the book\'s, as the picker and the approval quote them', async () => {
    const doc = makeConversationDoc();
    const res = redrawResolution(doc, PRO, 'page');
    const sheet = priceSheetOf({ rows: [], observed: [{ modelId: PRO, kind: 'page', res, n: 8, medianUsd: 0.6, minUsd: 0.55, maxUsd: 0.7, scope: 'you' }], qc: null }, SAMPLE_NOW);
    __seedPriceSheetForTests(OWNER, sheet);
    const book = priceBookFromSources(sheet.sources);
    const caps = resolveStudioCaps({ planId: 'pro', byok: false, isAdmin: false });
    render(<ModelStatusBanner studio={makeFakeStudio({ doc, caps })} compact={false} />);
    const group = await screen.findByRole('group', { name: /Ways to continue without Nano Banana 2\.1/ });
    const button = within(group).getByRole('button', { name: /Try Nano Banana Pro instead/ });
    const fmt = costFormat(DOLLAR_CONTEXT);
    const round4 = (n: number) => Math.round(n * 10000) / 10000;
    const real = round4(book.unit(PRO, res, 'page').usd! * PLATFORM_MARKUP);
    const registry = round4(registryPriceBook().unit(PRO, res, 'page').usd! * PLATFORM_MARKUP);
    expect(fmt.approx(real)).not.toBe(fmt.approx(registry));
    expect(button).toHaveTextContent(`${fmt.approx(real)} per image`);
    expect(button).not.toHaveTextContent(fmt.approx(registry));
    // The redraw it names is the quote the change_image_model approval recomputes with the same book.
    const redraw = redrawQuote(doc, PRO, 'pages_cover', book, false).usd!;
    expect(button.getAttribute('title')).toContain(`≈ ${formatUsd(redraw)}`);
  });
});
