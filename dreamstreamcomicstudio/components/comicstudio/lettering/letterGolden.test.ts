// PE-LETTER regression lock: old balloons give BYTE-IDENTICAL plans, SVG markup and canvas draw calls.
//
// The golden (__fixtures__/letterGolden.json) was recorded on the engine before PE-LETTER (756b5a70): for every QA
// fixture (and its rtl edition), the sample doc, and every one of the 8 base looks on two fixtures, each page's
// planLettering output, letteringSvgMarkup and the canvas exporter's recorded draw calls, hashed. Nothing PE-LETTER
// adds (rotation, minimum height, gradient, strokes, glow, warp, Pro shapes, SFX effects, Pro looks, named styles,
// canvas defs / gradients / clip paths) may change a byte of any of them.
//
// Re-record (only on an intentional change of the old drawing): LETTER_GOLDEN_WRITE=1 npx vitest run <this file>.
// Nothing else ever writes the fixture: a missing or renamed golden FAILS (it is never re-recorded from the engine under
// test, which would lock in whatever that engine draws).

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const GOLDEN_MISSING = 'golden missing: re-record on the pre-change engine with LETTER_GOLDEN_WRITE=1';
type PageHashes = Record<string, { plans: string; markup: string; canvas: string }>;

/**
 * The recorded golden at `path`. Only an explicit `write` (LETTER_GOLDEN_WRITE=1) records `now` first; a missing file
 * otherwise fails, so a deleted or renamed golden can never be re-recorded from the engine under test.
 */
const loadGolden = (path: string, now: () => PageHashes, write: boolean): PageHashes => {
  if (write) {
    writeFileSync(
      path,
      `${JSON.stringify({ note: 'The lettering engine before PE-LETTER (756b5a70): hashString of JSON.stringify(planLettering(...)), letteringSvgMarkup(plans, {widthPx: 1000, idPrefix: "gold"}) and JSON.stringify of the canvas exporter\'s recorded calls (fakeCanvas), per page, estimateMeasure. Every QA fixture and its rtl edition, the sample doc, and the 8 base looks on heist-12p and lake-1p.', pages: now() }, null, 1)}\n`
    );
  } else if (!existsSync(path)) throw new Error(GOLDEN_MISSING);
  return (JSON.parse(readFileSync(path, 'utf8')) as { pages: PageHashes }).pages;
};

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
    const golden = { pages: loadGolden(GOLDEN, () => now, WRITE) };
    expect(Object.keys(now).sort()).toEqual(Object.keys(golden.pages).sort());
    const diff = Object.keys(now).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(golden.pages[k]));
    expect(diff).toEqual([]);
    // A golden that covers nothing proves nothing: every fixture has pages with lettering.
    expect(Object.keys(now).length).toBeGreaterThan(150);
  }, 120_000);

  it('a missing golden fails and is never re-recorded from the engine under test (only LETTER_GOLDEN_WRITE=1 writes)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'letter-golden-'));
    try {
      const path = join(dir, 'letterGolden.json');
      let computed = 0;
      const now = () => {
        computed += 1;
        return { p: { plans: 'a', markup: 'b', canvas: 'c' } };
      };
      expect(() => loadGolden(path, now, false)).toThrow(GOLDEN_MISSING);
      expect(existsSync(path)).toBe(false);
      expect(computed).toBe(0);
      // The explicit re-record writes, and reads back what it wrote.
      expect(loadGolden(path, now, true)).toEqual({ p: { plans: 'a', markup: 'b', canvas: 'c' } });
      expect(loadGolden(path, () => ({}), false)).toEqual({ p: { plans: 'a', markup: 'b', canvas: 'c' } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
