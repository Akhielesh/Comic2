// The History view model (package H5): time words in the viewer's zone, money words, filters, the scrubber's spoken
// value, the scopes "Use then" sends, the whole-book restore preview (computed with the shared engine), the undo-AI
// preview, and what "Use this version" opens from an "Earlier (images only)" moment.

import { describe, expect, it } from 'vitest';
import { collectAssetPaths, normalizeDoc } from '../../../shared/comic/doc';
import { historyFixture, HISTORY_NOW, HISTORY_TZ } from './__scenes__/historyFixtures';
import { earlierHistory, earlierMoments, type EarlierMoment } from '../../../shared/comic/history/index';
import { collectMedia } from '../timeline/bookModel';
import {
  earlierUseOf,
  filterRows,
  hereRowId,
  HISTORY_COPY,
  isRemovedLineRow,
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

describe('"Earlier (images only)": what "Use this version" opens (H6a FIX note 1)', () => {
  const v4 = () => historyFixture('v4').live;
  const before = () => historyFixture('v4').versions[0].row.createdAt;
  const momentsOf = (doc = v4()) => earlierHistory(doc, { now: HISTORY_NOW, tz: HISTORY_TZ, before: before() }).moments;
  const find = (ms: EarlierMoment[], pred: (m: EarlierMoment) => boolean) => {
    const m = ms.find(pred);
    expect(m, 'the fixture has such a moment').toBeTruthy();
    return m!;
  };

  it('an older drawing of a live page opens that page’s own MediaPreview item (matched on path and owner)', () => {
    const doc = v4();
    const older = find(momentsOf(doc), (m) => m.kind === 'drawing' && !m.current && m.owner.key === 'page:pg_3');
    const use = earlierUseOf(doc, older)!;
    expect(use.items).toEqual(collectMedia(doc));
    expect(use.items[use.index].path).toBe(older.path);
    expect(use.items[use.index].owner.key).toBe('page:pg_3');
    // Every path offered is one the comic holds (the item list is the timeline's own).
    const held = new Set(collectAssetPaths(doc));
    for (const it of use.items) expect(held.has(it.path)).toBe(true);
  });

  it('is not offered for a drawing already in the book, one held back, one with no live target, or a non-drawing', () => {
    const doc = v4();
    const ms = momentsOf(doc);
    expect(earlierUseOf(doc, find(ms, (m) => m.current && m.owner.key === 'page:pg_1'))).toBeNull();
    expect(earlierUseOf(doc, find(ms, (m) => m.owner.kind === 'style_board'))).toBeNull(); // no target
    const older = find(ms, (m) => !m.current && m.owner.key === 'page:pg_2');
    expect(earlierUseOf(doc, { ...older, blocked: true })).toBeNull();
    expect(earlierUseOf(doc, { ...older, kind: 'deleted' })).toBeNull();
    expect(earlierUseOf(doc, { ...older, owner: { ...older.owner, target: undefined } })).toBeNull();
    // Exactly the five older page drawings of the v4 fixture can be used.
    expect(ms.filter((m) => earlierUseOf(doc, m)).map((m) => m.owner.key).sort()).toEqual(['page:pg_1', 'page:pg_2', 'page:pg_3', 'page:pg_4', 'page:pg_5']);
  });

  it('a path page 5 shares with page 4 opens a one-item list in page 5’s context, never page 4’s item', () => {
    const live = v4();
    const p4Older = live.pages[3].render.history[0];
    // Page 5 reuses page 4's older drawing in its own versions (collectMedia keeps the first owner: page 4).
    const doc = normalizeDoc({ ...live, pages: live.pages.map((p) => (p.id === 'pg_5' ? { ...p, render: { ...p.render, history: [p4Older, ...p.render.history] } } : p)) });
    const shared = earlierMoments(doc, { before: before() }).filter((m) => m.path === p4Older.path);
    expect(shared.map((m) => m.owner.key).sort()).toEqual(['page:pg_4', 'page:pg_5']);
    expect(collectMedia(doc).filter((i) => i.path === p4Older.path).map((i) => i.owner.key)).toEqual(['page:pg_4']);

    const forPage4 = earlierUseOf(doc, shared.find((m) => m.owner.key === 'page:pg_4')!)!;
    expect(forPage4.items[forPage4.index].owner.key).toBe('page:pg_4');

    const m5 = shared.find((m) => m.owner.key === 'page:pg_5')!;
    const forPage5 = earlierUseOf(doc, m5)!;
    expect(forPage5.index).toBe(0);
    expect(forPage5.items).toHaveLength(1);
    expect(forPage5.items[0]).toMatchObject({
      path: p4Older.path,
      owner: { key: 'page:pg_5', label: 'Page 5', order: m5.owner.order, target: { kind: 'page', id: 'pg_5' } },
      current: false,
      versionN: m5.versionN,
      versionLabel: `v${m5.versionN}`
    });
  });
});

describe('rows of a version you removed (H1 FIX note 4): never "you\'re here", never the top of Original', () => {
  const rows = () => {
    const f = historyFixture('v5');
    const own = f.versions.map((v) => v.row);
    const gone = { ...own[0], id: 'ver_gone', alternativeId: 'alt_gone', contentAt: HISTORY_NOW - 60_000, createdAt: HISTORY_NOW - 60_000 };
    return [gone, ...own];
  };

  it('in Original\'s list a row with a non-null alternativeId came from a removed version; in a line\'s own list it did not', () => {
    expect(isRemovedLineRow({ alternativeId: 'alt_gone' })).toBe(true);
    expect(isRemovedLineRow({ alternativeId: 'alt_gone' }, null)).toBe(true);
    expect(isRemovedLineRow({ alternativeId: null })).toBe(false);
    expect(isRemovedLineRow({})).toBe(false);
    expect(isRemovedLineRow({ alternativeId: 'alt_live' }, 'alt_live')).toBe(false);
    expect(HISTORY_COPY.removedLine).toBe('From a version you removed');
  });

  it('"you\'re here" is the head the server read; without it, the line\'s newest own row — never rows[0] when that was removed', () => {
    const list = rows();
    expect(list[0].id).toBe('ver_gone');
    expect(hereRowId(list, 'ver_draw')).toBe('ver_draw'); // head() wins, whatever the list order
    expect(hereRowId(list, null)).toBeNull();
    expect(hereRowId(list, undefined)).toBe(list[1].id); // Original's own newest row
    expect(hereRowId(list, undefined, null, true)).toBeNull(); // a filtered list alone can't tell
    expect(hereRowId(list.map((r) => ({ ...r, alternativeId: 'alt_live' })), undefined, 'alt_live')).toBe('ver_gone');
  });
});
