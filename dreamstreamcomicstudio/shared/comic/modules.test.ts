// Wave-0 shared modules with working implementations (pageGeometry is real; plan/book/textLayout/refRanking minimal).
import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import * as board from '../../components/comicstudio/board/pageLayout';
import { balloonWidthForText, estimateBalloonHeight, hashSeed as boardHashSeed } from '../../components/comicstudio/board/balloonGeometry';
import { normalizeDoc, type Character } from './doc';
import { applyOps } from './ops';
import * as geo from './pageGeometry';
import { coverNeedsDraw, missingSheetsFor, pageTargets, quoteRenderPages, sheetTargets, summarizeBook } from './plan';
import { bookSequence, bookSpreads, clipStatus, continuityHint, reorderIds } from './book';
import { estimateTextHeight, estimateWidthForText, graphemes, wrapLines } from './textLayout';
import { dhashDistance, isPhotoLikeness, pickRefs, sheetRefs, sheetRefsChanged } from './refRanking';
import { hashSeed } from './lettering/shapes';
import { fontString, fontsForDoc, resolveLetteringFont, FONT_REGISTRY } from './lettering/fonts';
import { planLettering } from './lettering/layout';
import { fitBalloonOnPage, placeBalloons } from './lettering/place';
import { LIBRARY_ID_RE, clampLibraryBudget, libraryStatusForScore, stylePreviewId } from './library';
import { planTranslation } from './translationPlan';

describe('pageGeometry is byte-identical to the board copy', () => {
  it('same boxes, parses and synthesized layouts for every sample page and direction', () => {
    const doc = makeSampleDoc();
    for (const page of doc.pages) {
      for (const readingDirection of ['ltr', 'rtl'] as const) {
        for (const kind of ['comic', 'webtoon', 'strip'] as const) {
          expect(geo.estimatePanelBoxes(page, { readingDirection, kind })).toEqual(board.estimatePanelBoxes(page, { readingDirection, kind }));
          expect(geo.synthesizeLayout(page.panels, { kind, readingDirection })).toBe(board.synthesizeLayout(page.panels, { kind, readingDirection }));
        }
      }
      expect(geo.parseLayout(page.layout)).toEqual(board.parseLayout(page.layout));
      expect(geo.panelBoxesFor(doc, page)).toEqual(board.panelBoxesFor(doc, page));
    }
    expect(geo.regionFromPoints({ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.6 })).toEqual(board.regionFromPoints({ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.6 }));
    expect(geo.MIN_REGION).toBe(board.MIN_REGION);
  });
});

describe('plan', () => {
  it('never re-draws a ready, non-stale page unless forced (the owner\'s $0.06 bug)', () => {
    const doc = normalizeDoc(makeSampleDoc());
    // pg_1 ready+fresh, pg_2 planned, pg_3 queued, pg_4 rendering, pg_5 stale, pg_6 failed
    expect(pageTargets(doc).map((p) => p.id)).toEqual(['pg_2', 'pg_5', 'pg_6']);
    expect(pageTargets(doc, { pageIds: ['pg_1'] })).toEqual([]);
    expect(pageTargets(doc, { pageIds: ['pg_1'], force: true }).map((p) => p.id)).toEqual(['pg_1']);
    expect(pageTargets(doc, { force: true }).map((p) => p.id)).toEqual(['pg_1', 'pg_2', 'pg_5', 'pg_6']); // never busy
    const q = quoteRenderPages(doc, { pageIds: ['pg_1'], byok: true, tier: 'standard' });
    expect(q).toMatchObject({ nothing: true, usd: 0, pageIds: [] });
    expect(quoteRenderPages(doc, { byok: true, tier: 'standard' }).usd).toBeGreaterThan(0);
  });

  it('sheets: never extras; companions count', () => {
    const doc = applyOps(normalizeDoc(makeSampleDoc()), [{ op: 'character', id: 'duck', patch: { name: 'Ducklings', kind: 'animal', count: 3, tier: 'support' } }]);
    expect(sheetTargets(doc).map((c) => c.id)).toEqual(['ch_arjun', 'duck']);
    expect(sheetTargets(doc, { characterIds: ['ch_maya'], force: true }).map((c) => c.id)).toEqual(['ch_maya']);
    expect(missingSheetsFor(doc, doc.pages.slice(0, 1)).map((c: Character) => c.id)).toEqual(['ch_arjun']);
    expect(coverNeedsDraw(doc)).toBe(true);
  });

  it('summarizeBook', () => {
    const doc = normalizeDoc(makeSampleDoc());
    const s = summarizeBook(doc, { byok: true, rating: 'PG-13' });
    expect(s.pages.map((p) => p.status)).toEqual(['ready', 'planned', 'queued', 'rendering', 'stale', 'failed']);
    expect(s.pages[0].panels).toHaveLength(3);
    expect(s.pages[0].panels[2]).toMatchObject({ speech: 2, captions: 0, sfx: 1 });
    expect(s.pages[0].quoteUsd).toBeUndefined();
    expect(s.pages[1].quoteUsd).toBeGreaterThan(0);
    expect(s.pages[0].safety).toBe('unchecked');
    expect(s.totals).toMatchObject({ pages: 6, drawn: 2, stale: 1, spentUsd: 0.42, savedUsd: 0 });
    expect(s.cover).toMatchObject({ status: 'planned', title: 'The Saffron Thief', lettering: 'in_art' });
  });
});

describe('book', () => {
  it('sequences, spreads and statuses', () => {
    let doc = normalizeDoc(makeSampleDoc());
    expect(bookSequence(doc).map((s) => s.key)).toEqual(['cover', 'pg_1', 'pg_2', 'pg_3', 'pg_4', 'pg_5', 'pg_6']);
    expect(bookSequence(doc, { audience: 'public' }).map((s) => s.key)).toEqual(['pg_1', 'pg_5']);
    doc = applyOps(doc, [{ op: 'book', patch: { titlePage: true, endPage: true, backCover: 'auto' } }]);
    const slots = bookSequence(doc);
    expect(slots.map((s) => s.kind)).toEqual(['cover', 'title', 'page', 'page', 'page', 'page', 'page', 'page', 'end', 'back_cover']);
    expect(bookSpreads(slots, true)).toEqual([[0], [1], [2, 3], [4, 5], [6, 7], [8], [9]]);
    expect(bookSpreads(slots, false)).toEqual([[0], [1, 2], [3, 4], [5, 6], [7, 8], [9]]);
    expect(clipStatus(doc, doc.pages[4])).toBe('stale');
    expect(reorderIds(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    const withContinuity = applyOps(doc, [{ op: 'render', target: { kind: 'page', id: 'pg_5' }, patch: { continuityPath: 'old.png' } }]);
    expect(continuityHint(withContinuity, withContinuity.pages[4])).toBe(true);
  });
});

describe('textLayout stub keeps today\'s Latin numbers', () => {
  it('estimates equal balloonGeometry', () => {
    for (const text of ['Hi', 'You owe me an explanation, Maya.', 'x'.repeat(140), 'A very long sentence that wraps across several lines in a balloon for sure.']) {
      expect(estimateWidthForText(text, 'en')).toBe(balloonWidthForText(text));
      for (const w of [0.16, 0.25, 0.34]) expect(estimateTextHeight(text, w, 2 / 3, 'en')).toBe(estimateBalloonHeight(text, w, 2 / 3));
    }
    expect(wrapLines('one two three', 'en', 7, (s) => s.length)).toEqual(['one two', 'three']);
    expect(graphemes('నమస్తే').length).toBeLessThan('నమస్తే'.length);
  });
});

describe('refRanking stub', () => {
  it('dhash distance, pick order, sheet refs and likeness', () => {
    expect(dhashDistance('0000000000000000', '000000000000000f')).toBe(4);
    expect(dhashDistance(undefined, 'ffffffffffffffff')).toBe(64);
    const refs = [
      { path: 'a', source: 'upload' as const, at: 1, safety: { assessed: 'X' as const, at: 1 } },
      { path: 'b', source: 'upload' as const, at: 1 },
      { path: 'c', source: 'upload' as const, at: 1 },
      { path: 'd', source: 'upload' as const, at: 1 },
      { path: 'e', source: 'upload' as const, at: 1 },
      { path: 'f', source: 'upload' as const, at: 1 }
    ];
    expect(pickRefs(refs, 2, 'page').map((r) => r.path)).toEqual(['b', 'c']);
    const doc = normalizeDoc(makeSampleDoc());
    const maya = { ...doc.cast[0], refs };
    expect(sheetRefs(maya, 5).map((r) => r.path)).toEqual(['b', 'c', 'd', 'e']);
    expect(sheetRefsChanged({ ...maya, sheet: { ...maya.sheet, refPaths: ['b', 'c', 'd', 'e'] } }, 5)).toBe(false);
    expect(sheetRefsChanged({ ...maya, sheet: { ...maya.sheet, refPaths: ['b'] } }, 5)).toBe(true);
    expect(isPhotoLikeness(doc.cast[0])).toBe(true);
  });
});

describe('lettering engine stubs + library constants', () => {
  it('shapes/fonts/layout/place have working inert implementations', () => {
    expect(hashSeed('pg_1_l5')).toBe(boardHashSeed('pg_1_l5'));
    expect(resolveLetteringFont('comic-neue', 'speech', 'te')).toMatchObject({ fontId: 'noto-sans-telugu', family: 'Noto Sans Telugu', weight: 700 });
    expect(resolveLetteringFont('bangers', 'sfx', 'en').fontId).toBe('bangers');
    expect(fontString('comic-neue', 17, 650, false)).toMatch(/^700 17px "DSL Comic Neue"/);
    for (const meta of Object.values(FONT_REGISTRY)) expect(['OFL-1.1', 'Apache-2.0']).toContain(meta.license);
    const doc = normalizeDoc(makeSampleDoc());
    expect(fontsForDoc(doc)).toEqual(['comic-neue', 'bangers']);
    expect(fontsForDoc(doc, ['hi'])).toEqual(['comic-neue', 'bangers', 'noto-sans-devanagari']);
    expect(planLettering(doc, doc.pages[0], 2 / 3, () => 0)).toEqual([]);
    expect(placeBalloons({ page: doc.pages[0], boxes: [], aspect: 2 / 3, rtl: false, plansFor: () => ({ h: 0, bounds: { x: 0, y: 0, w: 0, h: 0 } }), safeMargin: 0.03, existing: doc.pages[0].balloons })).toEqual(doc.pages[0].balloons);
    expect(fitBalloonOnPage({ x: 0.1, y: 0.1, w: 0.2 }, 'speech', 0.1, 2 / 3)).toEqual({ x: 0.1, y: 0.1, w: 0.2, crowded: false });
    expect(planTranslation(doc, 'hi')).toMatchObject({ lang: 'hi', calls: 0, toTranslate: [] });
    expect(LIBRARY_ID_RE.test(stylePreviewId('noir-ink'))).toBe(true);
    expect(libraryStatusForScore(0.8)).toBe('published');
    expect(libraryStatusForScore(0.5)).toBe('needs_review');
    expect(clampLibraryBudget(100)).toBe(25);
    expect(clampLibraryBudget(undefined)).toBe(5);
  });
});
