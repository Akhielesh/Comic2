// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { LibraryAssetPublic, LibraryIndex } from '../../../shared/comic/library.js';
import type { PlatformStatRow } from '../comic/models/observed.js';
import { getModelShowcase, type ModelShowcaseDeps } from './modelShowcase.js';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const MODEL = 'nano-banana-2.1';
const asset = (id = 'style.noir', patch: Partial<LibraryAssetPublic> = {}): LibraryAssetPublic => ({
  id, kind: 'style_preview', theme: 'light', aspect: '1:1', w: 1024, h: 1024,
  url: `https://example.supabase.co/storage/v1/object/public/comic-assets/library/v1/${id}/1.webp`,
  thumbs: {}, alt: 'Original platform style illustration', tags: [], palette: [], rev: 1,
  provenance: {
    model: MODEL, providerModel: 'google/gemini-nano-banana-2.1', route: 'openrouter', key: 'modeltest',
    prompt: 'Platform-authored prompt', promptHash: 'hash', seed: null, seedSupported: false,
    resolution: '1K', aspect: '1:1', score: 0.9, attempts: 1, strategy: 'first', generatedAt: NOW - 1000
  }, ...patch
});
const stat = (patch: Partial<PlatformStatRow> = {}): PlatformStatRow => ({
  modelId: MODEL, kind: 'page', res: '1K', calls: 12, ok: 10, failed: 2, rateLimited: 1,
  distinctUsers: 6, pricedCalls: 9, costN: 7, medianCostUsd: 0.041, minCostUsd: 0.03, maxCostUsd: 0.06,
  costFrom: '2026-11-02T00:00:00Z', costTo: '2026-11-12T00:00:00Z',
  firstAt: '2026-11-01T00:00:00Z', lastAt: '2026-11-12T00:00:00Z', ...patch
});
const deps = (assets: LibraryAssetPublic[] = [], stats: PlatformStatRow[] = []): ModelShowcaseDeps => ({
  now: () => NOW,
  publishedLibrary: async (): Promise<LibraryIndex> => ({ manifestVersion: 1, generatedAt: NOW, assets }),
  platformStats: async () => stats
});

describe('Models showcase evidence', () => {
  it('returns five honest comparison rows, with catalog-only entries gated and dated list prices separate', async () => {
    const out = await getModelShowcase(undefined, deps());
    expect(out.rows).toHaveLength(5);
    expect(out.rows.filter((row) => row.studioSupported)).toHaveLength(4);
    expect(out.rows.find((row) => row.modelId === 'flux-3')).toMatchObject({ studioSupported: false, catalogOnly: true });
    expect(out.rows[0]).toMatchObject({ factsAsOf: '2026-10-22', examples: [], metrics: [], sampleState: 'not_recorded', metricState: 'insufficient_data' });
    expect(out.rows[0].listPrices).toContainEqual({ resolution: '1K', usd: 0.0336, basis: 'per_token_table' });
    expect(out.windowStart).toBe('2026-10-14T12:00:00.000Z');
  });

  it('keeps sourced, dated benchmark performance separate and never substitutes another model version', async () => {
    const out = await getModelShowcase(undefined, deps());
    expect(out.rows[0].quality?.[0]).toMatchObject({ board: 'lmarena_t2i', rank: 6, score: 1327.8, asOf: '2026-10-07' });
    expect(out.rows[0].quality?.[0].source).toContain('LMArena leaderboard-dataset');
    expect(out.rows.find((row) => row.modelId === 'flux-3')?.quality?.[0]).toMatchObject({ board: 'aa_t2i', rank: 19, score: 1115, asOf: '2026-11-13T22:41:51Z' });
    const sunburst = out.rows.find((row) => row.modelId === 'gpt-image-2.6-sunburst')?.quality;
    const flare = out.rows.find((row) => row.modelId === 'gpt-image-2.6-flare')?.quality;
    expect(sunburst).toHaveLength(1);
    expect(sunburst?.[0]).toMatchObject({ board: 'aa_t2i', rank: 1, score: 1261, name: 'GPT Image 2.6 Sunburst (max)', samples: 5282 });
    expect(flare).toHaveLength(1);
    expect(flare?.[0]).toMatchObject({ board: 'aa_t2i', rank: 3, score: 1226, name: 'GPT Image 2.6 Flare (max)', samples: 7169 });
    // Neither row borrows the dated 2.5 LMArena result or its evaluated variant.
    expect(JSON.stringify([sunburst, flare])).not.toContain('2.5');
  });

  it('requires recorded attribution, excludes conflicting models and user-lane images, and never copies prompt/key metadata', async () => {
    const good = asset();
    const out = await getModelShowcase(undefined, deps([
      good,
      asset('unattributed', { provenance: undefined }),
      asset('mismatch', { provenance: { ...good.provenance!, providerModel: 'openai/some-other-model' } }),
      asset('private', { url: 'https://example.supabase.co/storage/v1/object/public/comic-assets/u/someone/img/1.webp' }),
      asset('data', { url: 'data:image/png;base64,AA==' }),
      asset('duplicate', { url: good.url })
    ]));
    expect(out.rows[0].examples).toHaveLength(1);
    expect(out.rows[0].examples[0]).toMatchObject({ id: good.id, modelId: MODEL, source: 'platform_library', width: 1024 });
    expect(JSON.stringify(out)).not.toContain('Platform-authored prompt');
    expect(JSON.stringify(out)).not.toContain('modeltest');
    expect(out.rows[0].publishedExampleCount).toBe(1);
  });

  it('counts published examples while bounding the newest displayed examples, and refuses private thumbnails', async () => {
    const assets = Array.from({ length: 5 }, (_, i) => asset(`style.${i}`, {
      provenance: { ...asset().provenance!, generatedAt: NOW - i * 1000 },
      thumbs: { 640: 'https://example.supabase.co/storage/v1/object/sign/comic-private/u/owner/secret.png?token=x' }
    }));
    const out = await getModelShowcase(undefined, deps(assets));
    expect(out.rows[0].examples.map((example) => example.id)).toEqual(['style.0', 'style.1', 'style.2']);
    expect(out.rows[0].publishedExampleCount).toBe(5);
    expect(out.rows[0].examples.every((example) => example.thumbnailUrl === example.url)).toBe(true);
  });

  it('retains privacy-approved observed costs and counts only, with no fabricated latency', async () => {
    const out = await getModelShowcase(undefined, deps([], [stat(), stat({ kind: 'cover', distinctUsers: 4 }), stat({ kind: 'library' }), stat({ kind: 'lab_page' }), stat({ kind: 'qc' })]));
    expect(out.rows[0].metrics).toEqual([{
      kind: 'page', resolution: '1K', calls: 12, successfulCalls: 10, failedCalls: 2,
      medianCostUsd: 0.041, costSamples: 7, costFrom: '2026-11-02T00:00:00.000Z', costTo: '2026-11-12T00:00:00.000Z',
      medianLatencyMs: null, latencySamples: 0
    }]);
  });

  it('suppresses insufficient/nonfinite cost samples independently of counts', async () => {
    const out = await getModelShowcase(undefined, deps([], [stat({ costN: 3 }), stat({ kind: 'cover', medianCostUsd: NaN }), stat({ kind: 'edit', calls: -2 })]));
    expect(out.rows[0].metrics).toHaveLength(2);
    expect(out.rows[0].metrics.every((m) => m.medianCostUsd === null && m.costSamples === 0)).toBe(true);
  });

  it('distinguishes source failure from a successful empty read and never requests owner data for guests', async () => {
    const ownExamples = vi.fn(async () => []);
    const out = await getModelShowcase(undefined, { ...deps(), publishedLibrary: async () => { throw new Error('private storage detail'); }, ownExamples });
    expect(out.sourceStatus).toEqual({ samples: 'unavailable', metrics: 'ready', ownSamples: 'not_requested' });
    expect(out.rows[0].sampleState).toBe('source_unavailable');
    expect(out.rows[0].metricState).toBe('insufficient_data');
    expect(ownExamples).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain('private storage detail');
  });

  it('keeps personal examples scoped to the requested owner and separate from published counts', async () => {
    const ownExamples = vi.fn(async (userId: string) => [{
      id: `own-${userId}`, url: 'https://storage.example/own', thumbnailUrl: 'https://storage.example/own',
      alt: 'Your cover', width: 1024, height: 1024, generatedAt: NOW, resolution: '1K',
      source: 'your_comic' as const, modelId: MODEL, providerModelId: null
    }]);
    const source = { ...deps(), ownExamples };
    const first = await getModelShowcase('owner-a', source);
    const second = await getModelShowcase('owner-b', source);
    const guest = await getModelShowcase(undefined, source);
    expect(first.rows[0]).toMatchObject({ ownExampleCount: 1, publishedExampleCount: 0, sampleState: 'available' });
    expect(first.rows[0].examples[0].id).toBe('own-owner-a');
    expect(second.rows[0].examples[0].id).toBe('own-owner-b');
    expect(guest.rows[0].examples).toEqual([]);
    expect(first.scope).toBe('platform_and_yours');
    expect(first.sourceStatus.ownSamples).toBe('ready');
    expect(ownExamples).toHaveBeenCalledTimes(2);
  });
});
