import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./apiClient', () => ({ get: vi.fn() }));
import { get } from './apiClient';
import { costLabel, fetchModelCatalog, loadCachedCatalog, type CatalogModel, type CatalogResponse } from './modelCatalog';

const model = (extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id: 'test/model', name: 'Test', source: 'openrouter', inputModalities: ['text'], outputModalities: ['text'],
  supportedParameters: [], pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 },
  isFree: false, costClass: 'paid', supportsImageOutput: false, supportsImageInput: false, supportsJsonOutput: false,
  roles: [], costBand: 'low', drawbacks: [], possibilities: [], ...extra
});
const response = (id: string): CatalogResponse => ({ models: [model({ id })], count: 1, total: 1, fetchedAt: Date.now(), degraded: false });
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

describe('catalog cache scope and freshness', () => {
  it('does not replace the full catalog with a filtered studio response', async () => {
    vi.mocked(get).mockResolvedValueOnce(response('full')).mockResolvedValueOnce(response('subset'));
    await fetchModelCatalog();
    await fetchModelCatalog({ product: 'comic_studio' });
    expect(loadCachedCatalog()?.models.map((m) => m.id)).toEqual(['full']);
    expect(loadCachedCatalog()?.stale).toBe(true);
  });
  it('sends a forced refresh through to the server', async () => {
    vi.mocked(get).mockResolvedValue(response('new'));
    await fetchModelCatalog({ refresh: true });
    expect(get).toHaveBeenCalledWith('/api/models/catalog?refresh=true', expect.anything());
  });
});

describe('honest price labels', () => {
  it('does not turn unknown prices into a zero-dollar quote', () => {
    expect(costLabel(model({ pricingKnown: false }))).toBe('Pricing unavailable');
    expect(costLabel(model({ pricingKnown: false, isFree: true, costBand: 'free' }))).toBe('Pricing unavailable');
    expect(costLabel(model())).toBe('Pricing unavailable');
  });
  it('distinguishes token-billed images from per-image pricing and verified free models', () => {
    expect(costLabel(model({ supportsImageOutput: true, pricing: { promptPerToken: 0, completionPerToken: 0.00001, imagePerImage: 0, requestFlat: 0 } }))).toBe('Token-billed image');
    expect(costLabel(model({ supportsImageOutput: true, pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0.03, requestFlat: 0 } }))).toBe('$0.030/img');
    expect(costLabel(model({ isFree: true, costClass: 'free_verified' }))).toBe('Free');
  });
});
