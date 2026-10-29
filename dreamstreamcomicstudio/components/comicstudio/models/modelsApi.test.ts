// modelsApi (M1-CATALOG's routes as the picker reads them): rows are validated field by field — malformed rows and
// fields are dropped, prices keep null (never 0) and their §4.6 note, uptimes outside 0–100 become unknown — and
// the requests go to the documented paths with the comic's id. The registry fallback labels every price with its date.

import { afterEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../services/apiClient', async (importOriginal) => ({ ...(await importOriginal<object>()), get: client.get }));

import { asCatalogDetail, asCatalogRow, fetchModelCatalog, fetchModelDetail, registryCatalogRows } from './modelsApi';
import { catalogRows } from './testing/fixtures';

afterEach(() => client.get.mockReset());

const PROJECT = '8f312c86-0b1e-4c5a-9d7e-2a4f6b8c0d1e';

describe('asCatalogRow', () => {
  it('keeps a well-formed row as is', () => {
    const row = catalogRows()[0];
    expect(asCatalogRow(JSON.parse(JSON.stringify(row)))).toEqual(row);
  });

  it('drops malformed rows and fields; null prices stay null with their copy', () => {
    expect(asCatalogRow({ id: 'x', nickname: 'X' })).toBeUndefined();
    expect(asCatalogRow({ ...catalogRows()[0], id: '<script>' })).toBeUndefined();
    const row = asCatalogRow({
      ...catalogRows()[3],
      price: { '1K': { usd: -1, basis: 'openrouter_endpoint' }, '2K': { usd: null, basis: 'openrouter_endpoint', note: 'OpenRouter publishes no price' }, '8K': { usd: 1, basis: 'registry' } },
      endpoints: [{ provider: 'A', uptime1d: 140, uptime30m: 'x' }, { nope: true }],
      quality: [{ board: 'made_up', score: 1, asOf: 'x', source: 'y' }],
      fit: [{ code: 'aspect', severity: 'block', text: "Can't draw 4:5 pages" }, { code: 'hack', severity: 'block', text: 'x' }],
      extra: 'dropped'
    })!;
    expect(row.price).toEqual({ '2K': { usd: null, basis: 'openrouter_endpoint', note: 'OpenRouter publishes no price' } });
    expect(row.endpoints).toEqual([{ provider: 'A', uptime1d: null, uptime30m: null }]);
    expect(row.quality).toEqual([]);
    expect(row.fit).toEqual([{ code: 'aspect', severity: 'block', text: "Can't draw 4:5 pages" }]);
    expect(row).not.toHaveProperty('extra');
  });

  it('a detail keeps its facts and history', () => {
    const d = asCatalogDetail({
      ...catalogRows()[1],
      facts: { factsAsOf: '2026-10-22', priceBasis: 'per_token_table', refs: { total: 14, characters: 5, objects: 6, style: 3 }, aspects: ['2:3'], resolutions: ['1K', '9K'] },
      priceHistory: [{ res: '2K', usd: 0.1344, basis: 'vendor_table', at: '2026-10-23T00:00:00Z' }, { res: '2K', usd: 'x', basis: 'vendor_table', at: 'y' }],
      qualityHistory: [],
      qualityNote: 'Not ranked on public leaderboards yet'
    })!;
    expect(d.facts.resolutions).toEqual(['1K']);
    expect(d.priceHistory).toHaveLength(1);
    expect(d.qualityNote).toBe('Not ranked on public leaderboards yet');
  });
});

describe('requests', () => {
  it('GET /api/comic/models/catalog?projectId= (bad rows skipped)', async () => {
    client.get.mockResolvedValue([catalogRows()[0], { broken: true }]);
    const rows = await fetchModelCatalog(PROJECT);
    expect(client.get).toHaveBeenCalledWith(`/api/comic/models/catalog?projectId=${PROJECT}`, { signal: undefined });
    expect(rows.map((r) => r.id)).toEqual(['nano-banana-2.1']);
  });

  it('GET /api/comic/models/:id?projectId=; an unreadable answer is a calm error', async () => {
    client.get.mockResolvedValue({ nope: 1 });
    await expect(fetchModelDetail('nano-banana-pro', PROJECT)).rejects.toThrow("Couldn't read this model's details right now.");
    expect(client.get).toHaveBeenCalledWith(`/api/comic/models/nano-banana-pro?projectId=${PROJECT}`, { signal: undefined });
  });

  it('an id the server would refuse is never put in the query (the client judges fit itself)', async () => {
    client.get.mockResolvedValue([]);
    await fetchModelCatalog('../../etc?x=1');
    expect(client.get).toHaveBeenCalledWith('/api/comic/models/catalog', { signal: undefined });
  });
});

describe('registryCatalogRows', () => {
  it('every registry price carries its date; an unverified one is null with the §4.6 copy', () => {
    const nb = registryCatalogRows().find((r) => r.id === 'nano-banana-2.1')!;
    expect(nb.price['1K']).toEqual({ usd: 0.0336, basis: 'registry', note: 'from our price list, 2026-10-22' });
    expect(nb.endpoints).toEqual([]);
  });
});
