// @vitest-environment node
// Public leaderboard quality (models.md §1.2, §4.3 quality[], §4.4 T4, §4.5 S5 24 h TTL, §4.6 "Not ranked").
import { describe, expect, it } from 'vitest';
import type { CatalogFetch } from './catalog.js';
import {
  HF_DATASETS_SERVER,
  NOT_RANKED_COPY,
  bundledQualitySnapshot,
  createQualitySource,
  fetchLmarenaBoards,
  lmarenaRowsToBoard,
  mergeLmarenaBoards,
  nameKeys,
  qualityEntriesFor,
  rankMovesFor,
  type LmarenaRow,
  type QualitySnapshot
} from './quality.js';

// Rows shaped like the public lmarena-ai/leaderboard-dataset image configs (columns model_name, rating,
// rating_lower, rating_upper, vote_count, rank, category, leaderboard_publish_date). Values are synthetic.
const lm = (model_name: string, rank: number, rating: number, category = 'overall', date = '2026-10-27'): LmarenaRow => ({
  model_name,
  rating,
  rating_lower: rating - 5,
  rating_upper: rating + 5,
  vote_count: 1000,
  rank,
  category,
  leaderboard_publish_date: date
});

describe('the bundled snapshot (2026-10-22 research pull, models.md §1.2)', () => {
  it('holds the dated, sourced numbers from the spec tables', () => {
    const nb = qualityEntriesFor('google/gemini-nano-banana-2.1');
    expect(nb.find((q) => q.board === 'aa_t2i')).toMatchObject({ rank: 4, score: 1176, ci: [1164, 1188], of: 105 });
    expect(nb.find((q) => q.board === 'aa_edit')).toMatchObject({ rank: 4, score: 1152 });
    expect(nb.find((q) => q.board === 'lmarena_edit')).toMatchObject({ rank: 5, score: 1426.2, asOf: '2026-10-20', of: 60 });
    expect(nb.find((q) => q.board === 'lmarena_multi_image')).toMatchObject({ rank: 5, score: 1431.7 });
    expect(qualityEntriesFor('google/gemini-3-pro-image').find((q) => q.board === 'lmarena_t2i')).toMatchObject({ rank: 16, score: 1247.9 });
    for (const e of nb) {
      expect(e.source.length).toBeGreaterThan(10);
      expect(e.asOf).toMatch(/^2026-10-/);
    }
  });

  it('a model on no board has no entries (the UI shows the §4.6 copy)', () => {
    expect(qualityEntriesFor('krea/k3-edit')).toEqual([]);
    expect(qualityEntriesFor(undefined)).toEqual([]);
    expect(NOT_RANKED_COPY).toBe('Not ranked on public leaderboards yet');
  });

  it('every tracked registry id has aliases', () => {
    expect(Object.keys(bundledQualitySnapshot.aliases)).toContain('google/gemini-nano-banana-2.1');
  });
});

describe('LMArena rows → a board keyed by OpenRouter id', () => {
  it('matches leaderboard spellings, including a parenthetical alias, and keeps the best rank', () => {
    expect(nameKeys('Gemini 3.1 Flash-Lite Image (nano-banana-2-lite)')).toEqual(expect.arrayContaining(['gemini31flashliteimage', 'nanobanana2lite']));
    const rows = [
      lm('GPT-Image-2.5 Sunburst', 1, 1516.8),
      lm('Gemini Nano Banana 2.1', 7, 1427.0),
      lm('Gemini 3 Pro Image (2K)', 14, 1390.0),
      lm('Gemini 3 Pro Image', 20, 1350.0),
      lm('Gemini 3.1 Flash-Lite Image (nano-banana-2-lite)', 25, 1300.0),
      lm('Gemini Nano Banana 2.1', 3, 1450.0, 'overall', '2026-10-20') // an older publish date is ignored
    ];
    const board = lmarenaRowsToBoard(rows, { category: 'overall', aliases: bundledQualitySnapshot.aliases, configLabel: 'image_edit' })!;
    expect(board.asOf).toBe('2026-10-27');
    expect(board.entries['google/gemini-nano-banana-2.1']).toMatchObject({ rank: 7, score: 1427, ci: [1422, 1432], name: 'Gemini Nano Banana 2.1' });
    expect(board.entries['google/gemini-3-pro-image']).toMatchObject({ rank: 14, name: 'Gemini 3 Pro Image (2K)' });
    expect(board.entries['google/gemini-3.1-flash-lite-image']).toMatchObject({ rank: 25 });
    expect(board.entries['openai/gpt-image-2.5-sunburst']).toMatchObject({ rank: 1 });
    expect(board.source).toContain('CC BY 4.0');
    expect(lmarenaRowsToBoard(rows, { category: 'multi_image_edit', aliases: {}, configLabel: 'image_edit' })).toBeNull();
  });
});

const smallSnap = (): QualitySnapshot => JSON.parse(JSON.stringify(bundledQualitySnapshot)) as QualitySnapshot;

describe('merging a refresh', () => {
  it('replaces a board that matched enough tracked models and appends dated history points; T4 then has a real move', () => {
    const snap = smallSnap();
    const rows = Object.keys(snap.boards.lmarena_edit!.entries).map((id, i) => lm(snap.aliases[id][0], i === 0 ? 7 : 20 + i, 1400 - i));
    const fresh = lmarenaRowsToBoard(rows, { category: 'overall', aliases: snap.aliases, configLabel: 'image_edit' });
    const { snapshot, replaced, kept } = mergeLmarenaBoards(snap, { lmarena_edit: fresh, lmarena_t2i: null }, '2026-10-28T00:00:00Z');
    expect(replaced).toEqual(['lmarena_edit']);
    expect(kept).toContain('lmarena_t2i');
    expect(snapshot.boards.lmarena_t2i).toEqual(snap.boards.lmarena_t2i);
    const nbHist = snapshot.history['google/gemini-nano-banana-2.1'].lmarena_edit!;
    expect(nbHist.map((p) => p.asOf)).toEqual(['2026-10-20', '2026-10-27']);
    const { moves } = rankMovesFor('google/gemini-nano-banana-2.1', '2026-09-28', snapshot);
    expect(moves).toEqual([{ board: 'lmarena_edit', from: { asOf: '2026-10-20', rank: 5, score: 1426.2 }, to: expect.objectContaining({ asOf: '2026-10-27', rank: 7 }), delta: -2 }]);
  });

  it('keeps the dated snapshot when a pull matches too few tracked models (an upstream rename never wipes the ranks)', () => {
    const snap = smallSnap();
    const fresh = lmarenaRowsToBoard([lm('Gemini Nano Banana 2.1', 7, 1427)], { category: 'overall', aliases: snap.aliases, configLabel: 'image_edit' });
    const { snapshot, replaced } = mergeLmarenaBoards(snap, { lmarena_edit: fresh }, '2026-10-28T00:00:00Z');
    expect(replaced).toEqual([]);
    expect(snapshot.boards.lmarena_edit).toEqual(snap.boards.lmarena_edit);
  });
});

/** A datasets-server stand-in: /splits and paged /rows for text_to_image and image_edit. */
const datasetsServer = (byConfig: Record<string, LmarenaRow[]>, opts: { fail?: boolean } = {}) => {
  const calls: string[] = [];
  const fetch: CatalogFetch = async (url) => {
    calls.push(url);
    if (opts.fail) return { ok: false, status: 503, json: async () => ({}) };
    const u = new URL(url);
    if (u.pathname === '/splits') return { ok: true, status: 200, json: async () => ({ splits: Object.keys(byConfig).flatMap((config) => [{ config, split: 'full' }, { config, split: 'latest' }]) }) };
    if (u.pathname === '/rows') {
      const rows = byConfig[u.searchParams.get('config')!] ?? [];
      const offset = Number(u.searchParams.get('offset'));
      const length = Number(u.searchParams.get('length'));
      return { ok: true, status: 200, json: async () => ({ rows: rows.slice(offset, offset + length).map((row) => ({ row })), num_rows_total: rows.length }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetch, calls };
};

const tracked = () => {
  const snap = smallSnap();
  const ids = Object.keys(snap.boards.lmarena_edit!.entries);
  const edit = [
    ...ids.map((id, i) => lm(snap.aliases[id][0], i + 1, 1500 - i)),
    ...ids.map((id, i) => lm(snap.aliases[id][0], i + 1, 1490 - i, 'multi_image_edit', '2026-10-26')),
    // Filler beyond one page of 100 rows, so paging is exercised.
    ...Array.from({ length: 120 }, (_, i) => lm(`Filler ${i}`, 100 + i, 1000, 'overall'))
  ];
  const t2i = ids.map((id, i) => lm(snap.aliases[id][0], i + 2, 1400 - i, 'overall', '2026-10-25'));
  return { text_to_image: t2i, image_edit: edit, video_edit: [lm('Some video model', 1, 1300)] };
};

describe('the LMArena pull (documented datasets-server endpoints)', () => {
  it('reads the latest split of text_to_image and image_edit, pages through rows, and builds three boards', async () => {
    const ds = datasetsServer(tracked());
    const boards = await fetchLmarenaBoards(ds.fetch, bundledQualitySnapshot.aliases, HF_DATASETS_SERVER);
    expect(boards.lmarena_t2i!.asOf).toBe('2026-10-25');
    expect(boards.lmarena_edit!.entries['google/gemini-nano-banana-2.1']).toMatchObject({ rank: 1 });
    expect(boards.lmarena_multi_image!.category).toBe('multi_image_edit');
    expect(ds.calls.some((u) => u.includes('config=video_edit'))).toBe(false);
    expect(ds.calls.filter((u) => u.includes('config=image_edit')).length).toBeGreaterThanOrEqual(2); // paged
    expect(ds.calls.every((u) => u.includes('split=latest') || u.includes('/splits'))).toBe(true);
  });

  it('on demand with a 24 h TTL: never blocks a reader, single-flight, and stale (snapshot kept) when the pull fails', async () => {
    let t = Date.parse('2026-10-29T10:00:00Z');
    const ds = datasetsServer(tracked());
    const q = createQualitySource({ fetch: ds.fetch, now: () => t, snapshot: smallSnap() });
    const first = await q.get(); // answers with the dated snapshot at once; the pull runs behind it
    expect(first.fetchedAt).toBeUndefined();
    expect(first.snapshot.boards.lmarena_edit!.asOf).toBe('2026-10-20');
    const refreshed = await q.get({ wait: true }); // joins the same pull
    expect(refreshed.fetchedAt).toBe('2026-10-29T10:00:00.000Z');
    expect(refreshed.snapshot.boards.lmarena_edit!.asOf).toBe('2026-10-27');
    const splitCalls = ds.calls.filter((u) => u.includes('/splits')).length;
    expect(splitCalls).toBe(1);
    t += 3_600_000;
    await q.get();
    expect(ds.calls.filter((u) => u.includes('/splits')).length).toBe(1); // within the TTL
    expect(q.current().stale).toBe(false);

    const down = datasetsServer({}, { fail: true });
    const q2 = createQualitySource({ fetch: down.fetch, now: () => t, snapshot: smallSnap() });
    const failed = await q2.get({ wait: true });
    expect(failed.stale).toBe(true);
    expect(failed.snapshot.boards.lmarena_edit!.asOf).toBe('2026-10-20');
  });

  it('fetch: null never fetches (the bundled snapshot only)', async () => {
    const q = createQualitySource({ fetch: null });
    expect((await q.get({ wait: true })).snapshot).toBe(bundledQualitySnapshot);
  });
});
