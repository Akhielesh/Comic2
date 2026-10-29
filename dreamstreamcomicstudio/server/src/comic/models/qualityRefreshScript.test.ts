// @vitest-environment node
// scripts/models-quality-refresh.mjs (owner-run, models.md §4.5 S5/S6): no network at import, the server's
// merge rules, a dry run writes nothing, the benchmarks payload needs the platform key and is never merged.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as quality from './quality.js';
import type { LmarenaRow } from './quality.js';

const SCRIPT = '../../../../scripts/models-quality-refresh.mjs';

const lm = (model_name: string, rank: number, rating: number, category = 'overall', date = '2026-10-27'): LmarenaRow => ({
  model_name,
  rating,
  rating_lower: rating - 4,
  rating_upper: rating + 4,
  vote_count: 500,
  rank,
  category,
  leaderboard_publish_date: date
});

/** datasets-server stand-in with synthetic rows for every tracked model. */
const fakeDatasets = () => {
  const snap = quality.bundledQualitySnapshot;
  const ids = Object.keys(snap.boards.lmarena_edit!.entries);
  const byConfig: Record<string, LmarenaRow[]> = {
    text_to_image: ids.map((id, i) => lm(snap.aliases[id][0], i + 3, 1400 - i)),
    image_edit: [...ids.map((id, i) => lm(snap.aliases[id][0], i + 2, 1500 - i)), ...ids.map((id, i) => lm(snap.aliases[id][0], i + 1, 1480 - i, 'multi_image_edit', '2026-10-26'))]
  };
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    if (u.hostname !== 'datasets-server.huggingface.co') return new Response('{}', { status: 404 });
    if (u.pathname === '/splits') return Response.json({ splits: Object.keys(byConfig).map((config) => ({ config, split: 'latest' })) });
    const rows = byConfig[u.searchParams.get('config')!] ?? [];
    const offset = Number(u.searchParams.get('offset'));
    return Response.json({ rows: rows.slice(offset, offset + 100).map((row) => ({ row })), num_rows_total: rows.length });
  });
  return { fetch, calls };
};

afterEach(() => vi.unstubAllGlobals());

describe('models-quality-refresh.mjs', () => {
  it('importing it touches no network and runs nothing', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const mod = await import(SCRIPT);
    expect(typeof mod.main).toBe('function');
    expect(spy).not.toHaveBeenCalled();
  });

  it('refreshes with the server merge rules and describes the rank changes', async () => {
    const { refreshQualitySnapshot } = await import(SCRIPT);
    const ds = fakeDatasets();
    const snapshot = JSON.parse(JSON.stringify(quality.bundledQualitySnapshot));
    const r = await refreshQualitySnapshot({ snapshot, fetchImpl: ds.fetch, quality, now: () => Date.parse('2026-10-29T09:00:00Z') });
    expect(r.replaced.sort()).toEqual(['lmarena_edit', 'lmarena_multi_image', 'lmarena_t2i']);
    expect(r.snapshot.generatedAt).toBe('2026-10-29T09:00:00.000Z');
    expect(r.snapshot.boards.lmarena_edit.entries['google/gemini-nano-banana-2.1']).toMatchObject({ rank: 2 });
    expect(r.changes.join('\n')).toContain('~ google/gemini-nano-banana-2.1 #5 · 1426.2 → #2 · 1500');
    expect(r.snapshot.history['google/gemini-nano-banana-2.1'].lmarena_edit.map((p: { asOf: string }) => p.asOf)).toEqual(['2026-10-20', '2026-10-27']);
    // AA boards are untouched by the LMArena refresh.
    expect(r.snapshot.boards.aa_t2i).toEqual(quality.bundledQualitySnapshot.boards.aa_t2i);
  });

  it('a dry run fetches LMArena only and writes nothing', async () => {
    const { main, SNAPSHOT_PATH } = await import(SCRIPT);
    const before = readFileSync(SNAPSHOT_PATH, 'utf8');
    const ds = fakeDatasets();
    vi.stubGlobal('fetch', ds.fetch);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await main(['--dry-run'])).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(readFileSync(SNAPSHOT_PATH, 'utf8')).toBe(before);
    expect(ds.calls.length).toBeGreaterThan(0);
    expect(ds.calls.every((u) => u.startsWith('https://datasets-server.huggingface.co/'))).toBe(true);
  });

  it('the benchmarks payload needs the platform key, and unknown flags are refused', async () => {
    const { saveBenchmarks, parseArgs } = await import(SCRIPT);
    const f = vi.fn();
    await expect(saveBenchmarks({ fetchImpl: f, key: '', outPath: '/dev/null' })).rejects.toThrow('OPENROUTER_API_KEY');
    expect(f).not.toHaveBeenCalled();
    expect(() => parseArgs(['--write-everything'])).toThrow('Unknown argument');
    expect(parseArgs(['--dry-run', '--benchmarks-out', 'x.json'])).toEqual({ dryRun: true, benchmarksOut: 'x.json', help: false });
  });
});
