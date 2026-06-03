import { describe, it, expect } from 'vitest';
import {
  canonicalModelKey,
  computeGroupDifferences,
  groupModelsBySource
} from './modelGrouping';
import type { CatalogModel } from './modelCatalog';

const model = (over: Partial<CatalogModel>): CatalogModel => ({
  id: 'x/y',
  name: 'Y',
  source: 'openrouter',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportedParameters: ['response_format'],
  pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 },
  isFree: true,
  costClass: 'free_verified',
  supportsImageOutput: false,
  supportsImageInput: false,
  supportsJsonOutput: true,
  roles: [],
  costBand: 'free',
  drawbacks: [],
  possibilities: [],
  ...over
});

describe('canonicalModelKey', () => {
  it('matches the same model across sources despite publisher-prefix differences', () => {
    const or = model({ id: 'meta-llama/llama-3.3-70b-instruct' });
    const nv = model({ id: 'meta/llama-3.3-70b-instruct', source: 'nvidia' });
    expect(canonicalModelKey(or)).toBe(canonicalModelKey(nv));
  });

  it('ignores a :free billing suffix', () => {
    expect(canonicalModelKey(model({ id: 'qwen/qwen-2.5-72b:free' }))).toBe(
      canonicalModelKey(model({ id: 'qwen/qwen-2.5-72b' }))
    );
  });

  it('never merges an image model with a text model of the same name', () => {
    const txt = model({ id: 'a/foo', supportsImageOutput: false });
    const img = model({ id: 'a/foo', supportsImageOutput: true });
    expect(canonicalModelKey(txt)).not.toBe(canonicalModelKey(img));
  });
});

describe('computeGroupDifferences', () => {
  it('returns empty for technically identical variants', () => {
    const a = model({ id: 'meta-llama/llama-3.3-70b', source: 'openrouter' });
    const b = model({ id: 'meta/llama-3.3-70b', source: 'nvidia' });
    expect(computeGroupDifferences([a, b])).toEqual([]);
  });

  it('flags the axes that actually differ', () => {
    const a = model({ id: 'meta/llama', contextLength: 128_000, supportsJsonOutput: true });
    const b = model({ id: 'meta/llama', source: 'nvidia', contextLength: 32_000, supportsJsonOutput: false });
    const diffs = computeGroupDifferences([a, b]);
    expect(diffs).toContain('context');
    expect(diffs).toContain('jsonOutput');
  });
});

describe('groupModelsBySource', () => {
  it('dedupes identical cross-source variants into one group, free-first', () => {
    const or = model({ id: 'meta-llama/llama-3.3-70b', source: 'openrouter', isFree: false, costClass: 'paid', costBand: 'low' });
    const nv = model({ id: 'meta/llama-3.3-70b', source: 'nvidia', isFree: true });
    const [group] = groupModelsBySource([or, nv]);
    expect(group.variants).toHaveLength(2);
    expect(group.multiSource).toBe(true);
    expect(group.variants[0].source).toBe('nvidia'); // free leads
  });

  it('keeps distinct models in separate groups', () => {
    const groups = groupModelsBySource([
      model({ id: 'meta/llama-3.3-70b' }),
      model({ id: 'deepseek/deepseek-r1' })
    ]);
    expect(groups).toHaveLength(2);
  });
});
