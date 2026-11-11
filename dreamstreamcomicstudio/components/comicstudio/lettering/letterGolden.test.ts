// PE-LETTER regression lock: old balloons give BYTE-IDENTICAL plans, SVG markup and canvas draw calls.
//
// The golden (__fixtures__/letterGolden.json) was recorded on the engine before PE-LETTER (756b5a70): for every QA
// fixture (and its rtl edition), the sample doc, and every one of the 8 base looks on two fixtures, each page's
// planLettering output, letteringSvgMarkup and the canvas exporter's recorded draw calls, hashed. Nothing PE-LETTER
// adds (rotation, minimum height, gradient, strokes, glow, warp, Pro shapes, SFX effects, Pro looks, named styles,
// canvas defs / gradients / clip paths) may change a byte of any of them.
//
// Re-record (only on an intentional change of the old drawing): LETTER_GOLDEN_WRITE=1 npx vitest run <this file>.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashString } from '../../../shared/comic/hash';
import type { ComicDoc } from '../../../shared/comic/doc';
import { estimateMeasure, letteringAspect, planLettering } from '../../../shared/comic/lettering/layout';
import { LETTERING_PRESET_IDS } from '../../../shared/comic/lettering/style';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { drawLetterPlan } from '../export/canvasDraw';
import { fakeContext, fakeLayers, fakePath } from '../export/__fixtures__/fakeCanvas';
import { makeQaDoc, QA_FIXTURES } from '../testing/qaFixtures';
import { letteringSvgMarkup } from './svgMarkup';

const GOLDEN = join(__dirname, '__fixtures__', 'letterGolden.json');
const WRITE = process.env.LETTER_GOLDEN_WRITE === '1';

/** Every doc the golden covers, by a stable name. */
const goldenDocs = (): [string, ComicDoc][] => {
  const out: [string, ComicDoc][] = [];
  for (const name of QA_FIXTURES) {
    out.push([name, makeQaDoc(name)]);
    out.push([`${name}|rtl`, makeQaDoc(name, { rtl: true })]);
  }
  out.push(['sample', makeSampleDoc()]);
  for (const presetId of LETTERING_PRESET_IDS) {
    for (const name of ['heist-12p', 'lake-1p'] as const) {
      const doc = makeQaDoc(name);
      doc.letterStyle = { ...(doc.letterStyle ?? { presetId: 'classic' }), presetId };
      out.push([`${name}|preset:${presetId}`, doc]);
    }
  }
  return out;
};

/** plans, markup and canvas calls of one page, hashed. */
const pageHashes = (doc: ComicDoc, pageIndex: number): { plans: string; markup: string; canvas: string } => {
  const page = doc.pages[pageIndex];
  const aspect = letteringAspect(doc, page);
  const plans = planLettering(doc, page, aspect, estimateMeasure);
  const markup = letteringSvgMarkup(plans, { aspect, widthPx: 1000, idPrefix: 'gold' });
  const f = fakeContext(1000, Math.round(1000 / aspect));
  drawLetterPlan(f.ctx, plans, { aspect, widthPx: 1000, makePath: fakePath, createLayer: fakeLayers().createLayer });
  return { plans: hashString(JSON.stringify(plans)), markup: hashString(markup), canvas: hashString(JSON.stringify(f.calls)) };
};

const computeAll = (): Record<string, { plans: string; markup: string; canvas: string }> => {
  const out: Record<string, { plans: string; markup: string; canvas: string }> = {};
  for (const [name, doc] of goldenDocs()) {
    doc.pages.forEach((page, i) => {
      out[`${name}|${page.id}`] = pageHashes(doc, i);
    });
  }
  return out;
};

describe('old balloons draw byte-identically (PE-LETTER golden over every QA fixture)', () => {
  it('plans, SVG markup and canvas draw calls equal the engine before PE-LETTER, page by page', () => {
    const now = computeAll();
    if (WRITE || !existsSync(GOLDEN)) {
      writeFileSync(
        GOLDEN,
        `${JSON.stringify({ note: 'The lettering engine before PE-LETTER (756b5a70): hashString of JSON.stringify(planLettering(...)), letteringSvgMarkup(plans, {widthPx: 1000, idPrefix: "gold"}) and JSON.stringify of the canvas exporter\'s recorded calls (fakeCanvas), per page, estimateMeasure. Every QA fixture and its rtl edition, the sample doc, and the 8 base looks on heist-12p and lake-1p.', pages: now }, null, 1)}\n`
      );
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { pages: Record<string, { plans: string; markup: string; canvas: string }> };
    expect(Object.keys(now).sort()).toEqual(Object.keys(golden.pages).sort());
    const diff = Object.keys(now).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(golden.pages[k]));
    expect(diff).toEqual([]);
    // A golden that covers nothing proves nothing: every fixture has pages with lettering.
    expect(Object.keys(now).length).toBeGreaterThan(150);
  }, 120_000);
});
