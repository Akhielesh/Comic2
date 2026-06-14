import { describe, it, expect, vi, afterEach } from 'vitest';
import { GoogleMapsConnector } from './googleMaps.js';
import { ConnectorAuthError, ConnectorRateLimitError } from '../types.js';

const mockResponse = (body: any, init: { status?: number } = {}) => {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response;
};

const place = {
  place_id: 'p1',
  name: 'Test Cafe',
  formatted_address: '123 Main St',
  rating: 4.5,
  types: ['cafe'],
  geometry: { location: { lat: 1.23, lng: 4.56 } }
};

describe('GoogleMapsConnector (api_key model)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('normalizes Maps results into record items', () => {
    const items = new GoogleMapsConnector().normalize({ results: [place] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'record',
      externalId: 'p1',
      title: 'Test Cafe',
      snippet: '123 Main St'
    });
    expect(items[0].payload).toMatchObject({ placeId: 'p1', rating: 4.5, location: { lat: 1.23, lng: 4.56 } });
  });

  it('connects when the key validates (geocode returns OK)', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(mockResponse({ status: 'OK', results: [place] })) as any;
    const result = await new GoogleMapsConnector().initiate({ userId: 'u1', redirectUri: 'x', apiKey: 'good-key' });
    expect(result.mode).toBe('completed');
    expect(result.tokens?.accessToken).toBe('good-key');
  });

  it('rejects a denied key with a typed auth error', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 'REQUEST_DENIED', error_message: 'The provided API key is invalid.' })) as any;
    await expect(
      new GoogleMapsConnector().initiate({ userId: 'u1', redirectUri: 'x', apiKey: 'bad-key' })
    ).rejects.toBeInstanceOf(ConnectorAuthError);
  });

  it('fetch(geocode) returns normalized items', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(mockResponse({ status: 'OK', results: [place] })) as any;
    const out: any = await new GoogleMapsConnector().fetch({
      connection: { id: 'c', userId: 'u', connectorId: 'google_maps', accountIdentifier: 'google_maps', grantedScopes: [], metadata: {} },
      getAccessToken: async () => 'key',
      resource: 'geocode',
      params: { address: 'Googleplex' }
    });
    expect(out.items[0].externalId).toBe('p1');
  });

  it('is not syncable (query-on-demand)', () => {
    const c = new GoogleMapsConnector();
    expect(c.metadata.capabilities.syncable).toBe(false);
    expect(c.metadata.authType).toBe('api_key');
  });

  it('raises ConnectorRateLimitError when the quota is exhausted', async () => {
    global.fetch = vi.fn().mockResolvedValue(mockResponse({ status: 'OVER_QUERY_LIMIT' })) as any;
    await expect(
      new GoogleMapsConnector().fetch({
        connection: { id: 'c', userId: 'u', connectorId: 'google_maps', accountIdentifier: 'google_maps', grantedScopes: [], metadata: {} },
        getAccessToken: async () => 'key',
        resource: 'places',
        params: { query: 'coffee' }
      })
    ).rejects.toBeInstanceOf(ConnectorRateLimitError);
  }, 20_000);
});
