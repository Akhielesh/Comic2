// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ownerShowcaseCandidates, readOwnerModelExamples, type OwnerShowcaseDocRow } from './modelShowcaseOwner.js';

const OWNER = '10000000-0000-4000-8000-000000000001';
const PROJECT = '20000000-0000-4000-8000-000000000002';
const MODEL = 'nano-banana-2.1';
const path = `u/${OWNER}/p/${PROJECT}/img/example.webp`;
const render = (overrides: Record<string, unknown> = {}) => ({
  status: 'ready', model: 'nano-banana-pro', resolution: '1K',
  asset: { source: 'generated', model: MODEL, path, at: 12345, w: 1024, h: 1024 }, ...overrides
});
const row = (overrides: Partial<OwnerShowcaseDocRow> = {}): OwnerShowcaseDocRow => ({
  user_id: OWNER, project_id: PROJECT, title: 'My comic', cover: { render: render() }, ...overrides
});

describe('owner Models examples', () => {
  it('uses exact asset attribution and rejects a different owner before returning candidates', () => {
    const result = ownerShowcaseCandidates([row(), row({ user_id: 'someone-else' })], OWNER);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ modelId: MODEL, providerModelId: null, source: 'your_comic', projectId: PROJECT });
    expect(result[0].readingLink).toBe(`/?view=read&id=${PROJECT}`);
  });

  it('never guesses model from the render or lock, uses uploads, signs another owner or serves quarantined art', () => {
    const asset = render().asset;
    const bad = [
      { ...asset, model: undefined }, { ...asset, source: 'upload' }, { ...asset, source: 'derived' },
      { ...asset, path: 'u/victim/p/project/img/image.webp' },
      { ...asset, path: `u/${OWNER}/p/${PROJECT}/ref/photo.webp` },
      { ...asset, path: `u/${OWNER}/%2e%2e/victim/image.webp` },
      { ...asset, safety: { quarantined: true } }, { ...asset, safety: { assessed: 'X' } }
    ];
    for (const candidate of bad) {
      expect(ownerShowcaseCandidates([row({ cover: { render: render({ asset: candidate }) } })], OWNER)).toEqual([]);
    }
  });

  it('bounds examples per model and signs only owned display paths; drops unsigned images', async () => {
    const pages = Array.from({ length: 8 }, (_, i) => ({ render: render({ asset: { ...render().asset, path: path.replace('example', `page${i}`), at: 100 + i } }) }));
    const docsForUser = vi.fn(async () => [row({ cover: undefined, pages })]);
    const signUrls = vi.fn(async (paths: string[]) => ({ [paths[0]]: 'https://storage.example/signed-first' }));
    const result = await readOwnerModelExamples(OWNER, { docsForUser, signUrls });
    expect(docsForUser).toHaveBeenCalledWith(OWNER);
    expect(signUrls.mock.calls[0][0]).toHaveLength(3);
    expect(result).toHaveLength(1);
    expect(result![0].generatedAt).toBe(107);
    expect(result![0]).not.toHaveProperty('path');
  });

  it('reports an unavailable source when existing artwork could not be signed', async () => {
    expect(await readOwnerModelExamples(OWNER, { docsForUser: async () => [row()], signUrls: async () => ({}) })).toBeNull();
  });
});
