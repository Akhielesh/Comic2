// models.md §4.2: the pure per-comic insights over `doc` (Overview · Pages · Models), on the f8312c86-shaped fixture.
// Every number traces to doc.spend or the drawn assets; missing data is labelled, never guessed.

import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type SpendEntry } from './doc';
import { applyOp } from './ops';
import { MAX_SPEND_ENTRIES } from './limits';
import { byModel, byTarget, entriesForTarget, failedOf, observedVsList, overviewOf, savedOf } from './modelInsights';
import type { PriceBook } from './modelLock';
import { LAKE_MODEL, makeLakeComic } from './__fixtures__/lakeComic';

describe('overviewOf', () => {
  it('exact byKind rows (zero kinds hidden, Translate included when present), BYOK split, failed and saved', () => {
    const o = overviewOf(makeLakeComic());
    expect(o.totalUsd).toBeCloseTo(0.7513 + 0.0343 + 0.0062, 4);
    expect(o.byKind.map((r) => r.kind)).toEqual(['page', 'cover', 'sheet', 'qc', 'chat']);
    expect(o.byKind.find((r) => r.kind === 'page')!.usd).toBeCloseTo(0.5482, 4);
    expect(o.byok).toEqual({ usd: 0.7856, images: 15 });
    expect(o.platform).toEqual({ usd: 0.0062, images: 0 });
    expect(o.failed).toEqual({ count: 0, usd: 0 });
    expect(o.savedUsd).toBe(0);
    expect(o.estimated).toBe(0);
    expect(o.exact).toBe(true);
    const withTranslate = makeLakeComic((d) => { d.spend.byKind.translate = 0.02; d.spend.byKind.edit = 0; });
    expect(overviewOf(withTranslate).byKind.map((r) => r.kind)).toEqual(['page', 'cover', 'sheet', 'qc', 'chat', 'translate']);
  });

  it('failed and saved come from the running totals when present, else from the entries', () => {
    const doc = makeLakeComic((d) => {
      d.spend.entries.unshift({ id: 'f1', at: 9e12, kind: 'page', label: 'Page 2', usd: 0, model: LAKE_MODEL, byok: true, estimated: false, target: 'page:pg_2', outcome: 'failed' });
      d.spend.entries.unshift({ id: 's1', at: 9e12 + 1, kind: 'page', label: 'Reused', usd: 0, byok: true, estimated: false, savedUsd: 0.0428 });
      d.spend.savedUsd = 0.0428;
    });
    expect(failedOf(doc)).toEqual({ count: 1, usd: 0 });
    expect(savedOf(doc)).toEqual({ usd: 0.0428, count: 1 });
    expect(failedOf(makeLakeComic((d) => { d.spend.failed = { count: 3, usd: 0.01 }; }))).toEqual({ count: 3, usd: 0.01 });
  });
});

describe('byTarget (the Pages tab)', () => {
  it('one row per drawn target in book order: spent, versions, model and size — page 1 at 2K, pages 2–5 at 1K', () => {
    const rows = byTarget(makeLakeComic());
    expect(rows.map((r) => r.label)).toEqual(['Cover', 'Page 1', 'Page 2', 'Page 3', 'Page 4', 'Page 5', 'THE BABY sheet', 'DUCKLINGS sheet', 'FROG sheet', 'BUNNY sheet']);
    const p1 = rows.find((r) => r.key === 'page:pg_1')!;
    expect(p1).toMatchObject({ res: '2K', w: 1856, h: 2304, aspect: '4:5', model: LAKE_MODEL, nickname: 'Nano Banana 2.1', versions: 2 });
    expect(p1.spentUsd).toBeCloseTo(0.0579 + 0.06 + 0.0049 * 2, 4); // two renders + two QC passes, summed from entries
    for (const n of [2, 3, 4, 5]) expect(rows.find((r) => r.key === `page:pg_${n}`)!.res).toBe('1K');
    expect(rows.find((r) => r.key === 'cover')!).toMatchObject({ spentUsd: 0.0533, versions: 1, res: '1K' });
    // Mixed sizes → each row carries its size badge; nothing drawn on another model → no "older model".
    expect(p1.badges).toEqual(['2K']);
    expect(rows.find((r) => r.key === 'page:pg_2')!.badges).toEqual(['1K']);
  });

  it('prefers the exact byTarget totals, flags older models, and quotes a redraw on the locked model when prices are given', () => {
    const prices: PriceBook = { unit: (_m, res) => ({ usd: res === '2K' ? 0.0504 : 0.0336, basis: 'list' }), qcUsd: 0.003 };
    const doc = makeLakeComic((d) => {
      d.spend.byTarget = { 'page:pg_1': 0.2, cover: 0.1 };
      d.pages[1].render.asset!.model = 'nano-banana-pro';
    });
    const rows = byTarget(doc, prices);
    expect(rows.find((r) => r.key === 'page:pg_1')).toMatchObject({ spentUsd: 0.2, redrawUsd: 0.0534 });
    expect(rows.find((r) => r.key === 'page:pg_2')).toMatchObject({ spentUsd: 0, badges: ['1K', 'older model'], nickname: 'Nano Banana Pro' });
    expect(rows.find((r) => r.key === 'cover')).toMatchObject({ spentUsd: 0.1, redrawUsd: 0.0336 });
    const unpriced = byTarget(doc, { unit: () => ({ usd: null, basis: 'none' }), qcUsd: 0.003 });
    expect(unpriced[0].redrawUsd).toBeNull();
  });

  it('targets with no image and no spend are left out; entriesForTarget lists a target’s entries', () => {
    const rows = byTarget(createEmptyDoc('d', 'D', 1));
    expect(rows).toEqual([]);
    expect(entriesForTarget(makeLakeComic(), { kind: 'page', id: 'pg_3' }).map((e) => e.label)).toEqual(['QC page 3', 'Page 3 (v1)', 'Page 3']);
  });
});

describe('byModel (the Models tab)', () => {
  it('nano-banana-2.1: 15 images and $0.7513, exact, with per-size real averages', () => {
    const m = byModel(makeLakeComic());
    expect(m.exact).toBe(true);
    expect(m.recentN).toBeUndefined();
    expect(m.rows).toHaveLength(1);
    const row = m.rows[0];
    expect(row).toMatchObject({ modelId: LAKE_MODEL, nickname: 'Nano Banana 2.1', images: 15, failed: 0 });
    expect(row.usd).toBeCloseTo(0.7513, 4);
    expect(row.sizes.map((s) => s.res).sort()).toEqual(['1K', '2K']);
    expect(row.sizes.find((s) => s.res === '2K')).toEqual({ res: '2K', n: 6, avgUsd: 0.0596 }); // page 1 + five v1 pages
    expect(row.sizes.find((s) => s.res === '1K')!.n).toBe(9); // pages 2–5, 4 sheets, cover
  });

  it('prefers the running totals; a capped legacy doc is labelled "(recent n)" instead of exact', () => {
    const totals = makeLakeComic((d) => { d.spend.byModel = { [LAKE_MODEL]: { usd: 9.99, images: 99, failed: 2 } }; });
    expect(byModel(totals).rows[0]).toMatchObject({ usd: 9.99, images: 99, failed: 2 });
    let doc = createEmptyDoc('d', 'D', 1);
    const e = (i: number): SpendEntry => ({ id: `e${i}`, at: i, kind: 'page', label: `Page ${i}`, usd: 0.04, model: LAKE_MODEL, byok: true, estimated: false, res: '1K', listUsd: 0.0336 });
    doc = { ...doc, spend: { ...doc.spend, entries: Array.from({ length: MAX_SPEND_ENTRIES }, (_, i) => e(i)) } };
    const capped = byModel(doc);
    expect(capped.exact).toBe(false);
    expect(capped.recentN).toBe(MAX_SPEND_ENTRIES);
    expect(capped.rows[0]).toMatchObject({ images: MAX_SPEND_ENTRIES, usd: 8 });
    expect(capped.rows[0].sizes[0]).toEqual({ res: '1K', n: MAX_SPEND_ENTRIES, avgUsd: 0.04, avgListUsd: 0.0336 });
  });

  it('observedVsList uses only real (non-estimated, non-failed) entries that recorded a list price', () => {
    const doc = makeLakeComic((d) => {
      d.spend.entries = d.spend.entries.map((x) => (x.kind === 'page' && x.res === '1K' && !x.label.includes('v1') ? { ...x, listUsd: 0.0336 } : x));
      d.spend.entries.unshift({ id: 'est', at: 9e12, kind: 'page', label: 'Est', usd: 0.5, model: LAKE_MODEL, byok: true, estimated: true, res: '1K', listUsd: 0.0336 });
    });
    expect(observedVsList(doc)).toEqual([{ modelId: LAKE_MODEL, res: '1K', n: 4, avgUsd: 0.0476, minUsd: 0.0428, maxUsd: 0.0538, avgListUsd: 0.0336 }]);
    expect(observedVsList(makeLakeComic())).toEqual([]); // the base fixture recorded no list prices → no "real cost" row
  });

  it('a failed attempt counts in failed, not in images (through the spend op)', () => {
    const doc = applyOp(makeLakeComic(), { op: 'spend', entry: { id: 'f', at: 9e12, kind: 'page', label: 'Page 1', usd: 0, model: LAKE_MODEL, byok: true, estimated: false, target: 'page:pg_1', outcome: 'failed', res: '1K' } });
    expect(byModel(doc).rows[0]).toMatchObject({ images: 15, failed: 1 });
    expect(overviewOf(doc).failed).toEqual({ count: 1, usd: 0 });
  });
});
