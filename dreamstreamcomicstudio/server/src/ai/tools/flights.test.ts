import { describe, it, expect, beforeEach } from 'vitest';
import { isoDurationToMinutes, toFlightOffer, googleFlightsUrl, flightSearchTool, amadeusEnabled } from './flights.js';

describe('isoDurationToMinutes', () => {
  it('parses ISO-8601 flight durations', () => {
    expect(isoDurationToMinutes('PT28H30M')).toBe(1710);
    expect(isoDurationToMinutes('PT2H')).toBe(120);
    expect(isoDurationToMinutes('PT45M')).toBe(45);
    expect(isoDurationToMinutes('garbage')).toBe(0);
  });
});

describe('toFlightOffer', () => {
  const offer = {
    price: { currency: 'USD', total: '488.00' },
    itineraries: [
      {
        duration: 'PT28H30M',
        segments: [
          { departure: { iataCode: 'IAD', at: '2026-07-07T22:55:00' }, arrival: { iataCode: 'LHR', at: '2026-07-08T10:00:00' }, carrierCode: 'VS' },
          { departure: { iataCode: 'LHR', at: '2026-07-08T21:05:00' }, arrival: { iataCode: 'BLR', at: '2026-07-09T12:55:00' }, carrierCode: 'VS' }
        ]
      }
    ],
    validatingAirlineCodes: ['VS']
  };

  it('maps an Amadeus offer into a flat FlightOffer with a computed layover', () => {
    const o = toFlightOffer(offer, { VS: 'VIRGIN ATLANTIC' });
    expect(o).not.toBeNull();
    expect(o).toMatchObject({
      airline: 'Virgin Atlantic', // title-cased from the dictionary
      airlineCode: 'VS',
      price: 488,
      currency: 'USD',
      durationMinutes: 1710,
      stops: 1,
      departCode: 'IAD',
      arriveCode: 'BLR'
    });
    expect(o?.layovers).toEqual(['11h 5m in LHR']); // 10:00 → 21:05
  });

  it('falls back to the carrier code when the dictionary lacks the name', () => {
    const o = toFlightOffer(offer, {});
    expect(o?.airline).toBe('VS');
  });

  it('returns null when there are no segments', () => {
    expect(toFlightOffer({ price: { currency: 'USD', total: '1' }, itineraries: [] }, {})).toBeNull();
  });
});

describe('googleFlightsUrl', () => {
  it('builds a deep-link mentioning origin, destination and date', () => {
    const url = googleFlightsUrl('IAD', 'BLR', '2026-07-07');
    expect(url).toContain('google.com/travel/flights');
    expect(decodeURIComponent(url)).toContain('IAD');
    expect(decodeURIComponent(url)).toContain('BLR');
    expect(decodeURIComponent(url)).toContain('2026-07-07');
  });
});

describe('search_flights tool (no keys / validation)', () => {
  beforeEach(() => {
    delete process.env.AMADEUS_API_KEY;
    delete process.env.AMADEUS_API_SECRET;
  });

  it('amadeusEnabled is false without keys', () => {
    expect(amadeusEnabled()).toBe(false);
  });

  it('rejects non-IATA codes before calling the API', async () => {
    const r = await flightSearchTool.execute({ origin: 'Washington', destination: 'Bengaluru', departureDate: '2026-07-07' });
    expect(r.content).toMatch(/IATA/i);
    expect(r.artifacts).toBeUndefined();
  });

  it('without keys, returns a clear notice and tells the model to fall back to web search', async () => {
    const r = await flightSearchTool.execute({ origin: 'IAD', destination: 'BLR', departureDate: '2026-07-07' });
    expect(r.content).toMatch(/web_search/);
    expect(r.notice?.message).toMatch(/Amadeus/i);
    expect(r.artifacts).toBeUndefined();
  });
});
