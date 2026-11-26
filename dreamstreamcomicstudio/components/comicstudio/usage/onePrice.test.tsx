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
import { render } from '@testing-library/react';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { resolveImageJob } from '../../../shared/comic/models';
import { quoteRenderPages } from '../../../shared/comic/plan';
import { priceBookFromSources, priceSheetOf } from '../../../shared/comic/priceBook';
import { DOLLAR_CONTEXT } from '../../../services/costDisplay';
import { __resetPriceSheetForTests, __seedPriceSheetForTests } from '../../../services/priceSheet';
import { costFormat } from '../conversation/cost';
import { PagesTab } from '../board/PagesTab';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from '../board/__fixtures__/sampleDoc';

const OWNER = 'owner-one-price';
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner-one-price' } }) }));

const ROOT = resolve(__dirname, '../..');
/** Every surface that shows an image (or text-step) price, and the quote helpers it calls. */
const SURFACES: Record<string, string[]> = {
  'comicstudio/board/PagesTab.tsx': ['quoteRenderPages', 'estimateDraw', 'estimateOne', 'redrawPrice', 'planUsd'],
  'comicstudio/board/CastTab.tsx': ['estimateOne', 'estimateDraw'],
  'comicstudio/board/StyleTab.tsx': ['estimateOne'],
  'comicstudio/board/PageEditor.tsx': ['estimateOne', 'estimateDraw', 'recheckQuoteUsd'],
  'comicstudio/breakdown/BreakdownCard.tsx': ['quoteRenderPages', 'summarizeBook', 'unitPrice'],
  'comicstudio/conversation/cards/RendersCard.tsx': ['quoteRenderPages', 'estimateDocJobs', 'retryAllFailed'],
  'comicstudio/conversation/cards/StyleChoiceCard.tsx': ['quoteStyleOptions', 'retryAllFailed'],
  'comicstudio/conversation/cards/PlanCard.tsx': ['quoteRenderPages', 'estimatePlanRender'],
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

  it('governed: the same price as a share of the usage, and no dollar sign anywhere on the board', () => {
    __seedPriceSheetForTests(OWNER, sheet);
    const studio = makeStudio(doc, { caps: { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 70, exhausted: false, pctPerStandardPage: 1.5 } } });
    const { container } = render(<PagesTab studio={studio} doc={studio.doc!} />);
    expect(header().textContent).toMatch(/% of your usage/);
    expect(container.textContent).not.toContain('$');
  });
});
