// @vitest-environment node
// get_flight_status: an API key never crosses the network over plain HTTP (a key that only works
// over HTTP counts as no key), and without live data the card carries the flight number only —
// never times, gates, terminals or delays the model remembers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetProviderUsage } from '../../lib/providerUsage.js';
import { flightStatusTool } from './travelWidgets.js';

const stubFetch = (route: (url: URL) => unknown): string[] => {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const raw = String(input);
      urls.push(raw);
      const body = route(new URL(raw));
      if (body instanceof Response) return body;
      if (body instanceof Error) throw body;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    })
  );
  return urls;
};

/** What the model might pass from memory: none of it may reach the card when there is no live data. */
const REMEMBERED = {
  flightNumber: 'ua 2402',
  airline: 'United',
  status: 'active',
  departure: { code: 'SFO', city: 'San Francisco', scheduled: '2026-11-19T09:15:00', terminal: 'I', gate: 'G92' },
  arrival: { code: 'HND', city: 'Tokyo', scheduled: '2026-11-20T13:05:00', terminal: '3' }
};

const TIME_FIELDS = /scheduled|estimated|actual|gate|terminal|delay|progress|departure|arrival|altitude|speed|asOf/i;

const LIVE_RECORD = {
  data: [
    {
      flight_status: 'active',
      airline: { name: 'United Airlines' },
      flight: { iata: 'UA2402' },
      departure: { iata: 'SFO', airport: 'San Francisco International', scheduled: '2026-11-19T09:15:00+00:00', actual: '2026-11-19T09:32:00+00:00', delay: 17, gate: 'G92' },
      arrival: { iata: 'HND', airport: 'Haneda', scheduled: '2026-11-20T13:05:00+00:00', estimated: '2026-11-20T13:18:00+00:00' },
      live: { altitude: 10600, speed_horizontal: 905 }
    }
  ]
};

beforeEach(() => __resetProviderUsage());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('get_flight_status without a live data source', () => {
  it('shows the flight number only: no times, gates, terminals or delays, and sends nothing', async () => {
    vi.stubEnv('AVIATIONSTACK_API_KEY', '');
    const urls = stubFetch(() => LIVE_RECORD);
    const out = await flightStatusTool.execute(REMEMBERED);
    expect(urls).toEqual([]);
    expect(out.artifacts).toEqual([
      { type: 'flight_status', data: { flightNumber: 'UA2402', airline: 'United', live: false, unavailable: true } }
    ]);
    expect(JSON.stringify(out.artifacts)).not.toMatch(TIME_FIELDS);
    expect(out.content).toContain('Live status needs a data source. Do not state times, gates or delays.');
    expect(out.content).not.toMatch(/SFO|HND|09:15|schedule/i);
  });

  it('tells the model so in its description, and no longer asks it for a remembered schedule', () => {
    expect(flightStatusTool.description).toMatch(/do not state times, gates or delays/i);
    expect(flightStatusTool.description).not.toMatch(/pass whatever schedule|schedule-only/i);
    const props = (flightStatusTool.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(['airline', 'flightNumber']);
  });
});

describe('get_flight_status with a key', () => {
  it('asks aviationstack over HTTPS and renders the live record', async () => {
    vi.stubEnv('AVIATIONSTACK_API_KEY', 'test-key');
    const urls = stubFetch(() => LIVE_RECORD);
    const out = await flightStatusTool.execute({ flightNumber: 'UA2402' });
    expect(urls).toHaveLength(1);
    expect(urls[0].startsWith('https://api.aviationstack.com/v1/flights?')).toBe(true);
    const data = out.artifacts?.[0]?.data as Record<string, unknown>;
    expect(data).toMatchObject({ flightNumber: 'UA2402', status: 'active', live: true, delayMin: 17 });
    expect(data.unavailable).toBeUndefined();
  });

  it('never retries over plain HTTP when HTTPS is refused: a key that works only over HTTP counts as no key', async () => {
    vi.stubEnv('AVIATIONSTACK_API_KEY', 'test-key');
    const urls = stubFetch((u) =>
      u.protocol === 'https:'
        ? new Response(JSON.stringify({ error: { code: 'https_access_restricted' } }), { status: 403 })
        : LIVE_RECORD
    );
    const out = await flightStatusTool.execute(REMEMBERED);
    expect(urls).toHaveLength(1);
    expect(urls.every((u) => u.startsWith('https://'))).toBe(true);
    for (const url of urls.filter((u) => u.startsWith('http://'))) expect(url).not.toMatch(/access_key=|token=/);
    expect(out.artifacts).toEqual([
      { type: 'flight_status', data: { flightNumber: 'UA2402', airline: 'United', live: false, unavailable: true } }
    ]);
    expect(out.content).toContain('Do not state times, gates or delays.');
    expect(out.notice?.level).toBe('warn');
    expect(out.notice?.message).toMatch(/HTTPS/);
  });

  it('a live source with no record today shows the flight number only, too', async () => {
    vi.stubEnv('AVIATIONSTACK_API_KEY', 'test-key');
    stubFetch(() => ({ data: [] }));
    const out = await flightStatusTool.execute(REMEMBERED);
    expect(JSON.stringify(out.artifacts)).not.toMatch(TIME_FIELDS);
    expect((out.artifacts?.[0]?.data as Record<string, unknown>).unavailable).toBe(true);
    expect(out.content).toContain('Do not state times, gates or delays.');
  });
});
