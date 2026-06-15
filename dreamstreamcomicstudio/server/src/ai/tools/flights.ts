// Real flight-fare search via Amadeus Self-Service (Flight Offers Search v2).
//
// Closes the gap the user hit: a "best flight deals IAD→BLR" query had NO structured
// flight source, so the agent fell back to web-search snippets and returned the wrong
// dates. Amadeus returns real airline fares from the global GDS. Free self-service tier:
// the user creates an account and sets AMADEUS_API_KEY / AMADEUS_API_SECRET. Without keys
// the tool degrades honestly (tells the model to use web_search) rather than guessing.
//
// Defaults to the TEST host (works with free self-service keys out of the box); set
// AMADEUS_PRODUCTION=true to use the production host once production access is granted.

import type { FlightResultsArtifact, FlightOffer } from '../../../../apiTypes.js';
import { assertProviderBudget, noteProviderCall } from '../../lib/providerUsage.js';
import type { ChatTool } from './registry.js';

export const amadeusEnabled = (): boolean =>
  Boolean(process.env.AMADEUS_API_KEY && process.env.AMADEUS_API_SECRET);

const host = (): string =>
  process.env.AMADEUS_PRODUCTION === 'true' ? 'https://api.amadeus.com' : 'https://test.api.amadeus.com';

const TIMEOUT_MS = 12_000;

// --- OAuth2 client-credentials token, cached until shortly before it expires. ---
let cachedToken: { token: string; expiresAt: number } | null = null;

const getToken = async (signal?: AbortSignal): Promise<string> => {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.token;
  const url = `${host()}/v1/security/oauth2/token`;
  assertProviderBudget(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.AMADEUS_API_KEY || '',
        client_secret: process.env.AMADEUS_API_SECRET || ''
      }),
      signal: controller.signal
    });
    noteProviderCall(url, res.ok);
    if (!res.ok) throw new Error(`Amadeus auth ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cachedToken = { token: json.access_token, expiresAt: Date.now() + (json.expires_in || 1799) * 1000 };
    return cachedToken.token;
  } finally {
    clearTimeout(timer);
  }
};

/** Parse an ISO-8601 duration (e.g. "PT28H30M") into total minutes. */
export const isoDurationToMinutes = (iso: string): number => {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso || '');
  if (!m) return 0;
  return (Number(m[1] || 0) * 60) + Number(m[2] || 0);
};

interface AmadeusSegment {
  departure: { iataCode: string; at: string };
  arrival: { iataCode: string; at: string };
  carrierCode: string;
  duration?: string;
}
interface AmadeusOffer {
  price: { currency: string; total: string };
  itineraries: { duration: string; segments: AmadeusSegment[] }[];
  validatingAirlineCodes?: string[];
}

/** Map one Amadeus offer's OUTBOUND itinerary into our flat FlightOffer. */
export const toFlightOffer = (offer: AmadeusOffer, carriers: Record<string, string>): FlightOffer | null => {
  const itin = offer.itineraries?.[0];
  const segs = itin?.segments;
  if (!segs || !segs.length) return null;
  const first = segs[0];
  const last = segs[segs.length - 1];
  const code = offer.validatingAirlineCodes?.[0] || first.carrierCode;
  const titleCase = (s: string) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  const airline = carriers[code] ? titleCase(carriers[code]) : code;
  // Layover = the gap between an arrival and the next departure, labelled by airport.
  const layovers: string[] = [];
  for (let i = 0; i < segs.length - 1; i += 1) {
    const at = segs[i].arrival.iataCode;
    const gapMs = new Date(segs[i + 1].departure.at).getTime() - new Date(segs[i].arrival.at).getTime();
    const mins = Math.max(0, Math.round(gapMs / 60000));
    layovers.push(`${fmtDuration(mins)} in ${at}`);
  }
  return {
    airline,
    airlineCode: code,
    price: Math.round(Number(offer.price.total)),
    currency: offer.price.currency || 'USD',
    durationMinutes: isoDurationToMinutes(itin.duration),
    stops: Math.max(0, segs.length - 1),
    layovers: layovers.length ? layovers : undefined,
    departTime: first.departure.at,
    arriveTime: last.arrival.at,
    departCode: first.departure.iataCode,
    arriveCode: last.arrival.iataCode
  };
};

const fmtDuration = (mins: number): string => `${Math.floor(mins / 60)}h ${mins % 60}m`;

/** A Google Flights deep-link so the user can open the full live results (like Gemini's card). */
export const googleFlightsUrl = (origin: string, dest: string, date: string, returnDate?: string): string => {
  const trip = returnDate ? `${date} returning ${returnDate}` : `${date} one way`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights from ${origin} to ${dest} on ${trip}`)}`;
};

const IATA = /^[A-Za-z]{3}$/;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export const flightSearchTool: ChatTool = {
  name: 'search_flights',
  description:
    'Search REAL airline fares for a route and date (one-way or round-trip) and show a flight-deals card: airline, price, total duration, stops and layovers, sorted cheapest first. Use whenever the user wants flight prices/deals/options between two places. Pass 3-letter IATA airport codes (resolve city names yourself, e.g. Washington Dulles → IAD, Bengaluru → BLR) and the date as YYYY-MM-DD. Needs Amadeus API keys configured; if unavailable it will say so and you should fall back to web_search.',
  parameters: {
    type: 'object',
    properties: {
      origin: { type: 'string', description: '3-letter IATA origin airport code, e.g. "IAD".' },
      destination: { type: 'string', description: '3-letter IATA destination airport code, e.g. "BLR".' },
      departureDate: { type: 'string', description: 'Departure date, YYYY-MM-DD.' },
      returnDate: { type: 'string', description: 'Optional return date, YYYY-MM-DD (omit for one-way).' },
      adults: { type: 'number', description: 'Passengers (default 1).' },
      nonStop: { type: 'boolean', description: 'Only non-stop flights.' },
      travelClass: { type: 'string', enum: ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'] }
    },
    required: ['origin', 'destination', 'departureDate']
  },
  execute: async (args, signal) => {
    const origin = str(args?.origin).toUpperCase();
    const destination = str(args?.destination).toUpperCase();
    const departureDate = str(args?.departureDate);
    const returnDate = str(args?.returnDate) || undefined;
    if (!IATA.test(origin) || !IATA.test(destination)) {
      return { content: 'Flight search needs 3-letter IATA airport codes for both origin and destination (e.g. IAD, BLR). Resolve the city names to codes and retry.' };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(departureDate)) {
      return { content: 'Flight search needs a departure date as YYYY-MM-DD.' };
    }
    if (!amadeusEnabled()) {
      // No live-fare provider configured — but DON'T fall back to web search for fares:
      // aggregator snippets are not date-accurate (they show "from $X" teasers and other
      // dates) and the model ends up quoting wrong, generic numbers. Instead return an
      // instant card with a Google Flights deep-link to the EXACT route + date, so the
      // user gets real, current fares in one tap and we never fabricate a price.
      const artifact: FlightResultsArtifact = {
        origin,
        destination,
        departureDate,
        returnDate,
        adults: Math.max(1, Math.min(9, Number(args?.adults) || 1)),
        offers: [],
        searchUrl: googleFlightsUrl(origin, destination, departureDate, returnDate),
        live: false,
        asOf: new Date().toISOString()
      };
      return {
        content: `I can't quote exact ${origin}→${destination} fares for ${departureDate} (no live flight provider configured). A card with a direct Google Flights link for that exact route and date is shown — that's the accurate, current source. Do NOT quote specific prices or airlines from web_search for this; aggregator snippets aren't date-specific and would mislead. Briefly tell the user to tap the card for live ${departureDate} fares.`,
        artifacts: [{ type: 'flight_results', data: artifact }],
        notice: { level: 'info', message: 'Showing a live Google Flights link — add AMADEUS_API_KEY/SECRET to show fares inline.', fix: 'Create a free app at developers.amadeus.com and set AMADEUS_API_KEY + AMADEUS_API_SECRET.' }
      };
    }
    try {
      const token = await getToken(signal);
      const q = new URLSearchParams({
        originLocationCode: origin,
        destinationLocationCode: destination,
        departureDate,
        adults: String(Math.max(1, Math.min(9, Number(args?.adults) || 1))),
        currencyCode: 'USD',
        max: '8'
      });
      if (returnDate) q.set('returnDate', returnDate);
      if (args?.nonStop === true) q.set('nonStop', 'true');
      if (typeof args?.travelClass === 'string') q.set('travelClass', String(args.travelClass));
      const url = `${host()}/v2/shopping/flight-offers?${q.toString()}`;
      assertProviderBudget(url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      signal?.addEventListener('abort', () => controller.abort(), { once: true });
      let body: { data?: AmadeusOffer[]; dictionaries?: { carriers?: Record<string, string> }; errors?: { detail?: string }[] };
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: controller.signal });
        noteProviderCall(url, res.ok);
        body = await res.json();
        if (!res.ok) {
          const detail = body?.errors?.[0]?.detail || `Amadeus ${res.status}`;
          return { content: `Couldn't fetch live flights (${detail}). Fall back to web_search for ${origin}→${destination}.`, notice: { level: 'warn', message: `Flight search failed: ${detail}` } };
        }
      } finally {
        clearTimeout(timer);
      }
      const carriers = body.dictionaries?.carriers || {};
      const offers = (body.data || [])
        .map((o) => toFlightOffer(o, carriers))
        .filter((o): o is FlightOffer => o !== null)
        .sort((a, b) => a.price - b.price)
        .slice(0, 6);
      if (!offers.length) {
        return { content: `No flights found for ${origin}→${destination} on ${departureDate}. Suggest nearby dates or a web_search.`, notice: { level: 'info', message: 'No flights found for those dates' } };
      }
      const artifact: FlightResultsArtifact = {
        origin,
        destination,
        departureDate,
        returnDate,
        adults: Math.max(1, Math.min(9, Number(args?.adults) || 1)),
        offers,
        searchUrl: googleFlightsUrl(origin, destination, departureDate, returnDate),
        live: true,
        asOf: new Date().toISOString()
      };
      // Compact text the model reads — the card shows the full table, so keep this tight.
      const lines = offers.map((o) => `${o.airline}: $${o.price} ${o.currency}, ${fmtDuration(o.durationMinutes)}, ${o.stops === 0 ? 'non-stop' : `${o.stops} stop${o.stops > 1 ? 's' : ''}`}${o.layovers ? ` (${o.layovers.join(', ')})` : ''}`);
      return {
        content: `Live ${returnDate ? 'round-trip' : 'one-way'} fares ${origin}→${destination} on ${departureDate} (cheapest first):\n${lines.join('\n')}\n\nA flight-deals card is shown to the user. Add a short read of the trade-offs (cheapest vs fastest); don't restate every row.`,
        artifacts: [{ type: 'flight_results', data: artifact }]
      };
    } catch (err) {
      const message = (err as Error)?.message || 'flight search failed';
      return { content: `Couldn't fetch live flights (${message}). Fall back to web_search for ${origin}→${destination}.`, notice: { level: 'warn', message: `Flight search failed: ${message}` } };
    }
  }
};

export const FLIGHT_TOOLS: ChatTool[] = [flightSearchTool];
