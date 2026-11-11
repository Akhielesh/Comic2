// Program 3 ST-A: the public library index is data, never trusted. sanitizeIndex rebuilds each asset from
// LibraryAssetPublic's own fields, so an unknown key (a run id, an admin id, a cost) never reaches a component or
// the session cache; the provenance goes through the shared allow-list (an exact prompt ≤ 6000 chars or none at
// all); the LQIP must be a small WebP data URL.
import { describe, expect, it } from 'vitest';
import { LIBRARY_PROMPT_MAX, sanitizeLibraryProvenance } from '../../../shared/comic/library';
import { sanitizeIndex } from './useComicLibrary';

const provenance = (over: Record<string, unknown> = {}) => ({
  model: 'nano-banana-2.1',
  modelLabel: 'Gemini Nano Banana 2.1',
  nickname: 'Nano Banana 2.1',
  factsAsOf: '2026-10-22',
  providerModel: 'google/gemini-nano-banana-2.1',
  route: 'openrouter',
  key: 'modeltest',
  prompt: 'A lighthouse keeper at dusk, ink and one colour.',
  promptHash: 'cf3cd1c1',
  seed: null,
  seedSupported: false,
  resolution: '1K',
  aspect: '4:5',
  score: 0.86,
  checkerModel: 'google/gemini-3.8-flash',
  attempts: 2,
  strategy: 'rerequest',
  generatedAt: 1_792_663_200_000,
  ...over
});

const asset = (over: Record<string, unknown> = {}) => ({
  id: 'style.noir-ink',
  kind: 'style_preview',
  presetId: 'noir-ink',
  theme: 'any',
  aspect: '4:5',
  w: 800,
  h: 1000,
  url: 'https://cdn.test/library/v1/style.noir-ink/1.webp',
  thumbs: { 320: 'https://cdn.test/library/v1/style.noir-ink/1@320.webp' },
  alt: 'Noir sample',
  tags: ['noir'],
  palette: ['#111111'],
  rev: 1,
  provenance: provenance(),
  lqip: 'data:image/webp;base64,UklGRjIAAABXRUJQVlA4ICYAAADwAgCdASoUABQAPu1ur1IppiQiqAgBMB2JaQAAPaaKAAD+zhQgAA==',
  ...over
});

describe('sanitizeIndex: an allow-list, field by field', () => {
  it('keeps a well-formed asset with its provenance and LQIP', () => {
    const out = sanitizeIndex({ manifestVersion: 1, generatedAt: 5, assets: [asset()] })!;
    expect(out.assets).toHaveLength(1);
    expect(out.assets[0].provenance).toEqual(provenance());
    expect(out.assets[0].lqip).toMatch(/^data:image\/webp;base64,/);
  });

  it('drops unknown keys at the asset and the provenance level (run id, admin id, cost, a key)', () => {
    const raw = asset({
      runId: '11111111-1111-4111-8111-111111111111',
      adminId: '00000000-0000-4000-8000-000000000001',
      costUsd: 0.0366,
      onclick: 'alert(1)',
      provenance: provenance({ runId: 'r', adminId: 'a', costUsd: 0.04, apiKey: 'sk-or-v1-leak', jobId: 'gen-1' })
    });
    const out = sanitizeIndex({ manifestVersion: 1, generatedAt: 0, assets: [raw] })!;
    const json = JSON.stringify(out);
    for (const banned of ['runId', 'adminId', 'costUsd', 'onclick', 'apiKey', 'jobId', 'sk-or-v1-leak', '11111111-1111']) expect(json).not.toContain(banned);
    expect(Object.keys(out.assets[0]).sort()).toEqual(['alt', 'aspect', 'h', 'id', 'kind', 'lqip', 'palette', 'presetId', 'provenance', 'rev', 'tags', 'theme', 'thumbs', 'url', 'w'].sort());
  });

  it('drops oversized or malformed fields: a prompt past 6000 chars drops the provenance; a bad LQIP is dropped', () => {
    const long = sanitizeIndex({ manifestVersion: 1, generatedAt: 0, assets: [asset({ provenance: provenance({ prompt: 'x'.repeat(LIBRARY_PROMPT_MAX + 1) }) })] })!;
    expect(long.assets[0].provenance).toBeUndefined();
    expect(long.assets).toHaveLength(1); // the image itself still shows
    const exact = sanitizeIndex({ manifestVersion: 1, generatedAt: 0, assets: [asset({ provenance: provenance({ prompt: 'y'.repeat(LIBRARY_PROMPT_MAX) }) })] })!;
    expect(exact.assets[0].provenance?.prompt).toHaveLength(LIBRARY_PROMPT_MAX);
    for (const lqip of ['data:image/svg+xml;base64,PHN2Zz4=', 'https://evil.test/x.webp', `data:image/webp;base64,${'A'.repeat(2000)}`, 'data:image/webp;base64,<script>']) {
      expect(sanitizeIndex({ manifestVersion: 1, generatedAt: 0, assets: [asset({ lqip })] })!.assets[0].lqip).toBeUndefined();
    }
    const badKind = sanitizeIndex({ manifestVersion: 1, generatedAt: 0, assets: [asset({ kind: 'admin_secret' }), asset({ id: 'style.retro-pop', theme: 'neon', aspect: 'wide', presetId: '../x' })] })!;
    expect(badKind.assets.map((a) => a.id)).toEqual(['style.retro-pop']);
    expect(badKind.assets[0]).toMatchObject({ theme: 'any', aspect: '1:1' });
    expect(badKind.assets[0].presetId).toBeUndefined();
  });

  it('the shared provenance allow-list rejects a record missing its required facts', () => {
    expect(sanitizeLibraryProvenance(provenance({ key: 'sk-or-v1-leak' }))).toBeUndefined();
    expect(sanitizeLibraryProvenance(provenance({ route: 'carrier-pigeon' }))).toBeUndefined();
    expect(sanitizeLibraryProvenance(provenance({ strategy: 'magic' }))).toBeUndefined();
    expect(sanitizeLibraryProvenance('nope')).toBeUndefined();
    expect(sanitizeLibraryProvenance(provenance({ seed: 42, seedSupported: 'yes' }))).toMatchObject({ seed: null, seedSupported: false });
  });
});
