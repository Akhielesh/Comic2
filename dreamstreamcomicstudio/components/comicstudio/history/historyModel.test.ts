// The History view model (package H5): time words in the viewer's zone, money words, filters, the scrubber's spoken
// value, the scopes "Use then" sends, the whole-book restore preview (computed with the shared engine), the undo-AI
// preview, and the "Earlier (images only)" items of an older comic.

import { describe, expect, it } from 'vitest';
import { collectAssetPaths, normalizeDoc } from '../../../shared/comic/doc';
import { historyFixture, HISTORY_NOW, HISTORY_TZ } from './__scenes__/historyFixtures';
import {
  earlierImageGroups,
  filterRows,
  languageScope,
  lineScope,
  mergeLiveRow,
  nextDraftName,
  pageScope,
  panelScope,
  restorePreview,
  rowCostText,
  scrubValueText,
  undoAiPreview,
  whenText
} from './historyModel';

const governed = { governed: true, exact: () => '≈1% of your usage' };
const dollars = { governed: false, exact: (usd: number) => `$${usd.toFixed(2)}` };

describe('money words', () => {
  const row = (spend?: { usd: number; byok: boolean; estimated: boolean }) => ({ stats: { pages: 1, drawn: 1, lines: 1, langs: [], models: [], ...(spend ? { spend } : {}) } });
  it('nothing spent is Free; own key says "on your key" (dollars only for a dollar viewer); included usage in the viewer’s words', () => {
    expect(rowCostText(row(), governed)).toBe('Free');
    expect(rowCostText(row({ usd: 0, byok: false, estimated: false }), dollars)).toBe('Free');
    expect(rowCostText(row({ usd: 0.27, byok: true, estimated: false }), governed)).toBe('on your key');
    expect(rowCostText(row({ usd: 0.27, byok: true, estimated: false }), dollars)).toBe('$0.27 · on your key');
    expect(rowCostText(row({ usd: 0.07, byok: false, estimated: false }), governed)).toBe('≈1% of your usage');
    expect(rowCostText(row({ usd: 0.07, byok: false, estimated: true }), dollars)).toBe('about $0.07');
  });
});

describe('time and the scrubber', () => {
  it('weekday and clock within the week, the date beyond it; the spoken value reads ranges as words', () => {
    const f = historyFixture('v5');
    const ai = f.versions[1].row;
    expect(whenText(ai.contentAt, HISTORY_NOW, HISTORY_TZ)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d$/);
    expect(whenText(HISTORY_NOW - 30 * 86_400_000, HISTORY_NOW, HISTORY_TZ)).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d\d:\d\d$/);
    expect(scrubValueText(ai, HISTORY_NOW, HISTORY_TZ)).toMatch(/^[A-Z][a-z]+day \d\d:\d\d, AI revised pages 3 to 4$/);
  });
});

describe('filters and live rows', () => {
  it('Saved by you, AI changes and This page; a live row replaces its id or goes first', () => {
    const rows = historyFixture('v5').versions.map((v) => v.row);
    expect(filterRows(rows, 'saved').map((r) => r.id)).toEqual(['ver_draft2']);
    // "AI changes" includes the moment saved just before each AI run (the one worth going back to).
    expect(filterRows(rows, 'ai').map((r) => r.id)).toEqual(['ver_ai', 'ver_before', 'ver_draw']);
    expect(filterRows(rows, 'page', 'pg_2').map((r) => r.id)).toEqual(['ver_edit', 'ver_draw']);
    const live = { ...rows[0], id: 'ver_new', contentAt: rows[0].contentAt + 1 };
    expect(mergeLiveRow(rows, live)[0].id).toBe('ver_new');
    expect(mergeLiveRow(rows, { ...rows[1], label: 'x' })[1].label).toBe('x');
    expect(nextDraftName(rows)).toBe('Draft 3');
  });
});

describe('"Use then" scopes', () => {
  it('line, panel, page (replace when the page exists, insert when it is gone) and language', () => {
    const live = historyFixture('v5').live;
    expect(lineScope('pg_3', 'pg_3_l3')).toEqual({ kind: 'line', pageId: 'pg_3', lineId: 'pg_3_l3' });
    expect(panelScope('pg_3', 'pg_3_p3')).toEqual({ kind: 'panel', pageId: 'pg_3', panelId: 'pg_3_p3' });
    expect(pageScope('pg_3', 'text', live)).toEqual({ kind: 'page', pageId: 'pg_3', mode: 'replace', part: 'text' });
    expect(pageScope('pg_old', 'all', live)).toEqual({ kind: 'page', pageId: 'pg_old', mode: 'insert', part: 'all' });
    expect(languageScope('te')).toEqual({ kind: 'language', lang: 'te' });
  });
});

describe('the whole-book restore preview (the shared engine’s own restore)', () => {
  it('pages to Deleted, editions kept, the cover and the model', () => {
    const f = historyFixture('v5');
    const before = f.versions.find((v) => v.row.id === 'ver_before')!.doc;
    const p = restorePreview(f.live, before, 'ver_before', HISTORY_NOW);
    expect(p.pagesToDeleted).toBe(1);
    expect(p.editionsKept).toEqual(['hi', 'te']);
    expect(p.lines).toEqual(['3 pages change', '1 page added since goes to Deleted', 'Cover stays', 'Hindi kept', 'Telugu kept', 'Image model stays Nano Banana 2.1']);
    expect(p.modelNotice).toBeUndefined();
  });

  it('says when the restored art was drawn with another model than the lock', () => {
    const f = historyFixture('v5');
    const before = f.versions.find((v) => v.row.id === 'ver_before')!.doc;
    const other = JSON.parse(JSON.stringify(before));
    for (const pg of other.pages) pg.render.asset.model = 'nano-banana-pro';
    other.cover.render.asset.model = 'nano-banana-pro';
    const p = restorePreview(f.live, other, 'ver_before', HISTORY_NOW);
    expect(p.lines).toContain('Image model stays Nano Banana 2.1');
    expect(p.modelNotice).toBe('Pages 1–5 were drawn with Nano Banana Pro; this comic now draws with Nano Banana 2.1. New drawings use Nano Banana 2.1.');
  });
});

describe('the restore preview’s words (review round)', () => {
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  it('one page: "1 page changes" (the verb agrees)', () => {
    const f = historyFixture('v5');
    const now = clone(f.live);
    now.pages.find((p) => p.id === 'pg_5')!.panels[0].lines[0].text = 'Changed since then.';
    const p = restorePreview(normalizeDoc(now), f.live, 'ver_x', HISTORY_NOW);
    expect(p.lines[0]).toBe('1 page changes');
  });

  it('a page coming back is said once ("comes back"), never also counted as a change', () => {
    const f = historyFixture('v5');
    const now = clone(f.live);
    now.pages = now.pages.filter((p) => p.id !== 'pg_5');
    const p = restorePreview(normalizeDoc(now), f.live, 'ver_x', HISTORY_NOW);
    expect(p.lines).toContain('1 page comes back');
    expect(p.lines.filter((l) => /^\d+ pages? changes?$/.test(l) || l === 'No page changes')).toEqual([]);
  });

  it('the same model under its provider id is not "another model"', () => {
    const f = historyFixture('v5');
    const before = clone(f.versions.find((v) => v.row.id === 'ver_before')!.doc);
    for (const pg of before.pages) if (pg.render.asset) pg.render.asset.model = 'google/gemini-nano-banana-2.1';
    if (before.cover.render.asset) before.cover.render.asset.model = 'google/gemini-nano-banana-2.1';
    const p = restorePreview(f.live, before, 'ver_before', HISTORY_NOW);
    expect(p.modelNotice).toBeUndefined();
  });
});

describe('undo the last AI change (preview)', () => {
  it('reverts the AI’s untouched pieces and asks about a page you changed since', () => {
    const plain = historyFixture('v5');
    const P = plain.versions.find((v) => v.row.id === 'ver_before')!.doc;
    const R = plain.versions.find((v) => v.row.id === 'ver_ai')!.doc;
    const clean = undoAiPreview(P, R, plain.live);
    expect(clean.conflicts).toEqual([]);
    expect(clean.plan.revert).toEqual(expect.arrayContaining(['page:pg_3', 'page:pg_4', 'art:pg_3']));
    const conflict = historyFixture('v5-conflict');
    const asked = undoAiPreview(P, R, conflict.live);
    expect(asked.conflicts.map((c) => [c.pageId, c.title])).toEqual([['pg_3', "You've changed page 3 since."]]);
    // §6.4's question: only on the other pages (and the part of page 3 that goes back anyway), or on page 3 too?
    expect(asked.conflicts[0].question).toBe("You've changed page 3 since. Undo the AI’s change only on pages 1, 4 and 6 (and page 3’s drawing), or on page 3’s words too?");
    expect(asked.plan.revert).not.toContain('page:pg_3');
    const decided = undoAiPreview(P, R, conflict.live, { 'page:pg_3': 'earlier' });
    expect(decided.conflicts).toEqual([]);
    expect(decided.plan.revert).toContain('page:pg_3');
  });
});

describe('"Earlier (images only)"', () => {
  it('a v4 comic’s older drawings, newest first by day, only paths the comic holds, none of the current images', () => {
    const f = historyFixture('v4');
    const start = f.versions[0].row.contentAt;
    const groups = earlierImageGroups(f.live, start, HISTORY_NOW, HISTORY_TZ);
    const items = groups.flatMap((g) => g.items);
    expect(items).toHaveLength(5);
    const held = new Set(collectAssetPaths(f.live));
    for (const it of items) {
      expect(held.has(it.path)).toBe(true);
      expect(it.current).toBe(false);
    }
    for (let i = 1; i < items.length; i += 1) expect(items[i - 1].at).toBeGreaterThanOrEqual(items[i].at);
    expect(earlierImageGroups(historyFixture('empty').live, null, HISTORY_NOW, HISTORY_TZ)).toEqual([]);
  });
});
