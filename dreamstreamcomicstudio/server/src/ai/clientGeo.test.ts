// @vitest-environment node
// Chat's approximate place is read from the X-DS-Geo header the API Worker writes from Cloudflare's own request data
// (api-proxy/src/geoHeader.ts). The backend never sends a member's IP to a geolocation service. Malformed input means
// "no location", never an error.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as clientGeo from './clientGeo.js';
import { EDGE_GEO_HEADER, clientIpFromReq, geoFromEdgeHeader } from './clientGeo.js';

const encode = (value: unknown) => encodeURIComponent(JSON.stringify(value));
const read = (value: unknown) => geoFromEdgeHeader({ [EDGE_GEO_HEADER]: value });

describe('geoFromEdgeHeader', () => {
  it('reads the place the API Worker attached', () => {
    expect(EDGE_GEO_HEADER).toBe('x-ds-geo');
    expect(read(encode({ city: 'Riverton', region: 'North Province', country: 'NZ', lat: -41.29, lng: 174.78 }))).toEqual({
      city: 'Riverton',
      region: 'North Province',
      country: 'NZ',
      lat: -41.29,
      lng: 174.78
    });
    expect(read(encode({ country: 'nz' }))).toEqual({ country: 'NZ' });
    expect(read(encode({ city: 'São Tomé' }))).toEqual({ city: 'São Tomé' });
  });

  it('no header, or a malformed one, means no location and never throws', () => {
    const bad: unknown[] = [
      undefined,
      '',
      '%',
      '%E0%A4%A',
      'not json',
      '{"city":"Riverton"',
      encode(null),
      encode([1, 2]),
      encode('Riverton'),
      encode(42),
      encode({}),
      encode({ city: 42, region: { x: 1 }, country: 'New Zealand', lat: 'north', lng: null }),
      encode({ lat: 12 }),
      encode({ city: '   ' }),
      `${encode({ city: 'Riverton' })}${'x'.repeat(4000)}`,
      ['a', 'b'],
      42
    ];
    for (const value of bad) {
      expect(() => read(value)).not.toThrow();
      expect(read(value), String(value).slice(0, 40)).toBeNull();
    }
    expect(geoFromEdgeHeader({})).toBeNull();
    expect(geoFromEdgeHeader(undefined)).toBeNull();
  });

  it('keeps the same caps as a browser location: 80-character text, two-letter country, coordinates rounded and in range', () => {
    expect(read(encode({ city: 'A'.repeat(300), region: 'B'.repeat(300) }))).toEqual({ city: 'A'.repeat(80), region: 'B'.repeat(80) });
    expect(read(encode({ city: 'New\u0000Port\n', country: 'NZL' }))).toEqual({ city: 'New Port' });
    expect(read(encode({ country: 'NZ', lat: 12.3456, lng: 45.6789 }))).toEqual({ country: 'NZ', lat: 12.35, lng: 45.68 });
    expect(read(encode({ country: 'NZ', lat: 91, lng: 0 }))).toEqual({ country: 'NZ' });
    expect(read(encode({ country: 'NZ', lat: 10, lng: 181 }))).toEqual({ country: 'NZ' });
    expect(read(encode({ country: 'NZ', lat: 10 }))).toEqual({ country: 'NZ' });
  });

  it('ignores every other field, so an IP or a postcode can never ride along', () => {
    expect(read(encode({ city: 'Riverton', ip: '203.0.113.9', postalCode: '6011', timezone: 'Pacific/Auckland' }))).toEqual({ city: 'Riverton' });
  });
});

describe('clientIpFromReq (the comic safety report route still uses it)', () => {
  it('prefers CF-Connecting-IP, then the first X-Forwarded-For hop, then req.ip', () => {
    expect(clientIpFromReq({ headers: { 'cf-connecting-ip': ' 203.0.113.9 ', 'x-forwarded-for': '198.51.100.1' }, ip: '10.0.0.1' })).toBe('203.0.113.9');
    expect(clientIpFromReq({ headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.2' }, ip: '10.0.0.1' })).toBe('198.51.100.1');
    expect(clientIpFromReq({ headers: {}, ip: '10.0.0.1' })).toBe('10.0.0.1');
  });
});

describe('Chat no longer sends IPs to a geolocation service', () => {
  it('the IP-geolocation lookup is gone from the module', () => {
    expect(Object.keys(clientGeo).sort()).toEqual(['EDGE_GEO_HEADER', 'clientIpFromReq', 'geoFromEdgeHeader']);
  });

  it('neither the chat routes nor this module reference ip-api.com', () => {
    for (const file of ['../routes/chat.ts', './clientGeo.ts']) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(source, file).not.toMatch(/ip-api/i);
      expect(source, file).not.toMatch(/resolveClientGeo/);
    }
  });
});
