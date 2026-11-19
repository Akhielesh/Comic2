// @vitest-environment node
// Chat's approximate place comes from Cloudflare's own request data (request.cf), which the API Worker writes into
// one header for the backend. The backend never looks an IP up anywhere. These tests pin who gets the header (main
// host, Chat routes and the recipe run only), that a header sent by anyone else never survives the Worker, the caps
// on what it holds, and that the backend reads exactly what the Worker writes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type BackendNamespace } from './proxy';
import { GEO_HEADER, GEO_HEADER_MAX_BYTES, geoHeaderFor } from './geoHeader';
import { geoFromEdgeHeader } from '../../server/src/ai/clientGeo';

const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
// Invented request data in Cloudflare's shape (coordinates arrive as strings).
const CF = { city: 'Riverton', region: 'North Province', country: 'NZ', latitude: '-41.28664', longitude: '174.77557', postalCode: '6011', timezone: 'Pacific/Auckland', colo: 'AKL', asn: 64500 };
const PLACE = { city: 'Riverton', region: 'North Province', country: 'NZ', lat: -41.29, lng: 174.78 };

const withCf = (url: string, cf?: unknown, init: RequestInit = {}): Request => {
  const req = new Request(url, { ...init, headers: { 'user-agent': HUMAN, ...(init.headers as Record<string, string> | undefined) } });
  return cf === undefined ? req : Object.assign(req, { cf });
};
const headerFor = (url: string, cf?: unknown) => geoHeaderFor(withCf(url, cf), new URL(url));
const decoded = (value: string | null) => (value === null ? null : JSON.parse(decodeURIComponent(value)));
const placeFor = (cf: unknown, url = 'https://dreamstreamstudio.ai/api/chat') => decoded(headerFor(url, cf));

afterEach(() => vi.unstubAllGlobals());

describe('geoHeaderFor: who gets an approximate place', () => {
  it('main-host Chat routes and the recipe run get the place from request.cf, coordinates rounded to 2 decimals', () => {
    // A recipe run from Chat (the Live Monitor's weather, a recipe asking for places near me) needs the place as much
    // as a chat turn: both go through prepareChat.
    for (const path of ['/api/chat', '/api/chat/stream', '/api/chat/swarm', '/api/chat/tool-refresh', '/api/recipes/run']) {
      expect(placeFor(CF, `https://dreamstreamstudio.ai${path}`)).toEqual(PLACE);
    }
  });

  it('no other path and no other host ever gets it', () => {
    const never = [
      'https://dreamstreamstudio.ai/api/projects',
      'https://dreamstreamstudio.ai/api/chats',
      'https://dreamstreamstudio.ai/api/chatter',
      'https://dreamstreamstudio.ai/api/comic/projects/p1/research',
      'https://dreamstreamstudio.ai/api/recipes',
      'https://dreamstreamstudio.ai/api/recipes/distill',
      'https://dreamstreamstudio.ai/api/recipes/validate',
      'https://dreamstreamstudio.ai/api/recipes/run/extra',
      'https://dreamstreamstudio.ai/api/recipes/runs',
      'https://comics.dreamstreamstudio.ai/api/recipes/run',
      'https://dreamstreamstudio.ai/api',
      'https://dreamstreamstudio.ai/chat',
      'https://comics.dreamstreamstudio.ai/api/chat',
      'https://comics.dreamstreamstudio.ai/api/chat/stream',
      'https://stream.dreamstreamstudio.ai/api/chat',
      'https://www.dreamstreamstudio.ai/api/chat',
      'https://dreamstream-api.example.workers.dev/api/chat',
      'https://dreamstreamstudio.ai.evil.example/api/chat',
      'https://dreamstreamstudio.ai:8443/api/chat'
    ];
    for (const url of never) expect(headerFor(url, CF), url).toBeNull();
  });

  it('no request.cf, or nothing usable in it, means no header', () => {
    for (const cf of [undefined, null, 'Riverton', 42, [], {}, { colo: 'AKL', asn: 64500 }, { country: 'XX' }, { country: 'T1' }, { latitude: 'north', longitude: '1' }, { city: '   ' }]) {
      expect(placeFor(cf), JSON.stringify(cf)).toBeNull();
    }
  });
});

describe('geoHeaderFor: what the place may hold', () => {
  it('only city, region, country and coordinates: never the postcode, time zone, network or an IP', () => {
    const place = placeFor({ ...CF, clientIp: '203.0.113.9', ip: '203.0.113.9' });
    expect(Object.keys(place).sort()).toEqual(['city', 'country', 'lat', 'lng', 'region']);
    expect(decodeURIComponent(headerFor('https://dreamstreamstudio.ai/api/chat', { ...CF, ip: '203.0.113.9' })!)).not.toMatch(/203\.0\.113|6011|AKL|64500|Pacific/);
  });

  it('city and region at most 80 characters, control characters removed', () => {
    expect(placeFor({ city: 'A'.repeat(200), region: 'B'.repeat(200), country: 'NZ' })).toEqual({ city: 'A'.repeat(80), region: 'B'.repeat(80), country: 'NZ' });
    expect(placeFor({ city: 'New\u0000 \nPort\u007f', country: 'NZ' })).toEqual({ city: 'New Port', country: 'NZ' });
  });

  it('a character is never cut in half at the 80-character limit, and broken text never throws', () => {
    // 80 UTF-16 units, the chat route's own cap, so that cap never has to cut what the Worker kept.
    expect(placeFor({ city: `${'a'.repeat(78)}😀z`, country: 'NZ' }).city).toBe(`${'a'.repeat(78)}😀`);
    expect(placeFor({ city: `${'a'.repeat(79)}😀z`, country: 'NZ' }).city).toBe('a'.repeat(79));
    for (const city of [`${'a'.repeat(70)}${'😀'.repeat(6)}`, `${'a'.repeat(77)}😀😀`, `a${'𝔸'.repeat(20)}${'b'.repeat(60)}`]) {
      const place = placeFor({ city, country: 'NZ' });
      expect(place.city, city).toBeTruthy();
      expect(place.city.length).toBeLessThanOrEqual(80);
      expect(place.city.length).toBeGreaterThanOrEqual(79);
      expect(place.city).toBe(place.city.slice(0, 80));
      expect(place.city).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
    expect(() => headerFor('https://dreamstreamstudio.ai/api/chat', { city: 'Port\ud800 Town', country: 'NZ' })).not.toThrow();
    expect(placeFor({ city: 'Port\ud800 Town', country: 'NZ' })).toEqual({ city: 'Port Town', country: 'NZ' });
  });

  it('country is exactly two letters (upper-cased); anything else is dropped', () => {
    expect(placeFor({ city: 'Riverton', country: 'nz' })).toEqual({ city: 'Riverton', country: 'NZ' });
    for (const country of ['NZL', 'N', 'N1', 'XX', 'T1', 7]) expect(placeFor({ city: 'Riverton', country })).toEqual({ city: 'Riverton' });
  });

  it('coordinates: both or neither, in range, rounded to 2 decimals', () => {
    expect(placeFor({ latitude: 12.3456, longitude: '-0.004' })).toEqual({ lat: 12.35, lng: 0 });
    expect(placeFor({ country: 'NZ', latitude: '91', longitude: '10' })).toEqual({ country: 'NZ' });
    expect(placeFor({ country: 'NZ', latitude: '10', longitude: '-180.5' })).toEqual({ country: 'NZ' });
    expect(placeFor({ country: 'NZ', latitude: '10' })).toEqual({ country: 'NZ' });
    expect(placeFor({ country: 'NZ', latitude: '', longitude: '' })).toEqual({ country: 'NZ' });
  });

  it(`the whole value stays within ${GEO_HEADER_MAX_BYTES} bytes of plain ASCII: the region goes first, then the city`, () => {
    const regionTooLong = placeFor({ ...CF, city: 'é'.repeat(30), region: 'é'.repeat(80) });
    expect(regionTooLong).toEqual({ city: 'é'.repeat(30), country: 'NZ', lat: -41.29, lng: 174.78 });
    const bothTooLong = placeFor({ ...CF, city: '東'.repeat(80), region: '京'.repeat(80) });
    expect(bothTooLong).toEqual({ country: 'NZ', lat: -41.29, lng: 174.78 });
    for (const cf of [CF, { ...CF, city: '東'.repeat(80), region: '京'.repeat(80) }, { ...CF, city: 'é'.repeat(30), region: 'é'.repeat(80) }]) {
      const value = headerFor('https://dreamstreamstudio.ai/api/chat', cf)!;
      expect(value.length).toBeLessThanOrEqual(GEO_HEADER_MAX_BYTES);
      expect(value).toMatch(/^[\x21-\x7e]+$/);
    }
  });
});

function fakeContainer() {
  const seen: Request[] = [];
  const ns: BackendNamespace = {
    idFromName: (name) => ({ name }),
    get: () => ({
      fetch: async (req) => {
        seen.push(req);
        return new Response('ok');
      }
    })
  };
  return { ns, seen };
}

const forward = async (req: Request, env: Record<string, unknown>) => {
  const res = await worker.fetch(req, env as never, { waitUntil: () => undefined });
  expect(res.status).toBe(200);
};

describe('the API Worker', () => {
  it('removes an incoming X-DS-Geo on every path and host before forwarding', async () => {
    const { ns, seen } = fakeContainer();
    const spoofed = { headers: { 'X-DS-Geo': encodeURIComponent(JSON.stringify({ city: 'Elsewhere', country: 'AQ' })) } };
    for (const url of [
      'https://dreamstreamstudio.ai/api/projects',
      'https://dreamstreamstudio.ai/api/chat',
      'https://dreamstreamstudio.ai/api/chat/stream',
      'https://comics.dreamstreamstudio.ai/api/chat',
      'https://stream.dreamstreamstudio.ai/api/chat',
      'https://dreamstream-api.example.workers.dev/api/chat'
    ]) {
      await forward(withCf(url, undefined, spoofed), { BACKEND: ns });
    }
    // The comics host and the others carry Cloudflare data too, and still get nothing.
    await forward(withCf('https://comics.dreamstreamstudio.ai/api/chat', CF, spoofed), { BACKEND: ns });
    await forward(withCf('https://dreamstreamstudio.ai/api/projects', CF, spoofed), { BACKEND: ns });
    expect(seen).toHaveLength(8);
    for (const req of seen) expect(req.headers.get(GEO_HEADER), req.url).toBeNull();
  });

  it('main-host Chat gets the Worker’s own value, never the one the request brought', async () => {
    const { ns, seen } = fakeContainer();
    const spoofed = { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-ds-geo': encodeURIComponent(JSON.stringify({ city: 'Elsewhere' })) } };
    await forward(withCf('https://dreamstreamstudio.ai/api/chat/stream', CF, spoofed), { BACKEND: ns });
    await forward(withCf('https://dreamstreamstudio.ai/api/recipes/run', CF, spoofed), { BACKEND: ns });
    await forward(withCf('https://dreamstreamstudio.ai/api/recipes/distill', CF, spoofed), { BACKEND: ns });
    expect(decoded(seen[0].headers.get(GEO_HEADER))).toEqual(PLACE);
    expect(await seen[0].text()).toBe('{}');
    expect(decoded(seen[1].headers.get(GEO_HEADER))).toEqual(PLACE);
    expect(seen[2].headers.get(GEO_HEADER)).toBeNull();
  });

  it('the external origin path (BACKEND_TARGET=origin) strips and sets it the same way', async () => {
    const origin = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', origin);
    const spoofed = { headers: { 'x-ds-geo': 'spoofed' } };
    const env = { BACKEND_TARGET: 'origin', BACKEND_ORIGIN: 'https://backend.example' };
    await forward(withCf('https://dreamstreamstudio.ai/api/chat', CF, spoofed), env);
    await forward(withCf('https://dreamstreamstudio.ai/api/projects', CF, spoofed), env);
    const sent = origin.mock.calls.map((call) => new Headers((call as unknown as [string, RequestInit])[1].headers));
    expect(decoded(sent[0].get(GEO_HEADER))).toEqual(PLACE);
    expect(sent[1].get(GEO_HEADER)).toBeNull();
  });
});

describe('the backend reads exactly what the Worker writes', () => {
  it('round trip', () => {
    for (const cf of [
      CF,
      { ...CF, city: 'São Tomé', region: 'Água Grande', country: 'ST' },
      { country: 'NZ' },
      { latitude: '1.234', longitude: '5.678' },
      { ...CF, city: `${'a'.repeat(79)}😀z`, region: '😀'.repeat(60) },
      { city: 'Port\ud800 Town', country: 'XX' }
    ]) {
      const value = headerFor('https://dreamstreamstudio.ai/api/chat', cf);
      expect(geoFromEdgeHeader({ [GEO_HEADER]: value ?? undefined })).toEqual(decoded(value));
    }
  });
});
