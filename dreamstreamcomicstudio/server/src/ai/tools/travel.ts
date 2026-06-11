// Travel planner tool. The model composes the itinerary (days + stops); this tool
// coerces it into an ItineraryArtifact and enriches it with LIVE data:
//  - geocodes stops that came without coordinates (Nominatim) so the map renders,
//  - attaches a live weather snapshot for the destination (Open-Meteo).
// Both enrichments are best-effort — a network failure never sinks the plan.

import type { ChatTool } from './types.js';
import type { ItineraryArtifact, ItineraryDay, ItineraryStop, ItineraryStopKind, ItineraryTransport } from '../../../../apiTypes.js';
import { geocodePlaces } from './maps.js';
import { getWeather } from './weather.js';

const STOP_KINDS: ItineraryStopKind[] = ['flight', 'transit', 'train', 'bus', 'car', 'ferry', 'walk', 'hotel', 'food', 'sight', 'activity', 'shopping', 'other'];
const TRANSPORT_MODES: NonNullable<ItineraryTransport['mode']>[] = ['flight', 'train', 'bus', 'car', 'ferry', 'walk', 'transit'];

const coerceTransport = (raw: unknown): ItineraryTransport | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const t: ItineraryTransport = {
    mode: TRANSPORT_MODES.includes(r.mode as ItineraryTransport['mode']) ? (r.mode as ItineraryTransport['mode']) : undefined,
    from: str(r.from, 80),
    to: str(r.to, 80),
    carrier: str(r.carrier, 80),
    code: str(r.code, 40),
    depart: str(r.depart, 20),
    arrive: str(r.arrive, 20)
  };
  // Only keep it if at least one meaningful field is present.
  return Object.values(t).some((v) => v !== undefined) ? t : undefined;
};

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const coerceStop = (raw: unknown): ItineraryStop | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name, 160);
  if (!name) return null;
  return {
    name,
    kind: STOP_KINDS.includes(r.kind as ItineraryStopKind) ? (r.kind as ItineraryStopKind) : undefined,
    time: str(r.time, 40),
    durationMin: num(r.durationMin),
    lat: num(r.lat),
    lng: num(r.lng),
    address: str(r.address, 240),
    notes: str(r.notes, 600),
    cost: num(r.cost),
    url: typeof r.url === 'string' && /^https:\/\//.test(r.url) ? r.url.slice(0, 500) : undefined,
    transport: coerceTransport(r.transport)
  };
};

const coerceDay = (raw: unknown, idx: number): ItineraryDay | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const stops = (Array.isArray(r.stops) ? r.stops : [])
    .slice(0, 16)
    .map(coerceStop)
    .filter((s): s is ItineraryStop => !!s);
  if (stops.length === 0) return null;
  return {
    label: str(r.label, 80) ?? `Day ${idx + 1}`,
    date: str(r.date, 20),
    summary: str(r.summary, 300),
    stops
  };
};

export const coerceItinerary = (args: Record<string, unknown>): ItineraryArtifact | null => {
  const title = str(args.title, 200) ?? (str(args.destination, 120) ? `Trip to ${str(args.destination, 120)}` : undefined);
  const days = (Array.isArray(args.days) ? args.days : [])
    .slice(0, 21)
    .map((d, i) => coerceDay(d, i))
    .filter((d): d is ItineraryDay => !!d);
  if (!title || days.length === 0) return null;
  const budgetRaw = args.budget && typeof args.budget === 'object' ? (args.budget as Record<string, unknown>) : undefined;
  return {
    title,
    destination: str(args.destination, 120),
    startDate: str(args.startDate, 20),
    endDate: str(args.endDate, 20),
    travelers: num(args.travelers),
    currency: str(args.currency, 8),
    budget: budgetRaw
      ? {
          total: num(budgetRaw.total),
          lines: Array.isArray(budgetRaw.lines)
            ? budgetRaw.lines
                .map((l) => {
                  const lr = l && typeof l === 'object' ? (l as Record<string, unknown>) : {};
                  const label = str(lr.label, 80);
                  const amount = num(lr.amount);
                  return label && amount !== undefined ? { label, amount } : null;
                })
                .filter((l): l is { label: string; amount: number } => !!l)
                .slice(0, 12)
            : undefined
        }
      : undefined,
    days,
    tips: Array.isArray(args.tips) ? args.tips.map((t) => str(t, 240)).filter((t): t is string => !!t).slice(0, 10) : undefined,
    packing: Array.isArray(args.packing) ? args.packing.map((t) => str(t, 120)).filter((t): t is string => !!t).slice(0, 20) : undefined
  };
};

/** Geocode up to `limit` stops that came without coordinates (best-effort). */
const enrichCoords = async (plan: ItineraryArtifact, signal?: AbortSignal): Promise<void> => {
  const missing = plan.days.flatMap((d) => d.stops).filter((s) => s.lat === undefined || s.lng === undefined);
  if (missing.length === 0) return;
  const suffix = plan.destination ? `, ${plan.destination}` : '';
  const batch = missing.slice(0, 8); // geocodePlaces caps at 8 sequential lookups
  const names = batch.map((s) => `${s.name}${suffix}`);
  try {
    const markers = await geocodePlaces(names, signal);
    // geocodePlaces drops failed lookups, so align results by their query label.
    const byLabel = new Map(markers.map((m) => [m.label, m]));
    batch.forEach((stop, i) => {
      const m = byLabel.get(names[i]);
      if (m) {
        stop.lat = m.lat;
        stop.lng = m.lng;
      }
    });
  } catch {
    /* map simply renders fewer pins */
  }
};

/** Attach a live destination weather snapshot (best-effort). */
const enrichWeather = async (plan: ItineraryArtifact, signal?: AbortSignal): Promise<void> => {
  if (!plan.destination) return;
  try {
    const wx = await getWeather(plan.destination, signal);
    if (!wx) return;
    plan.weather = {
      description: wx.current?.description,
      tempC: wx.current?.tempC,
      tempF: wx.current?.tempF,
      daily: (wx.daily ?? []).slice(0, 7).map((d) => ({
        date: d.date,
        minC: d.minC,
        maxC: d.maxC,
        description: d.description,
        precipProb: d.precipProb
      }))
    };
  } catch {
    /* plan ships without the weather strip */
  }
};

export const planTripTool: ChatTool = {
  name: 'plan_trip',
  description:
    'Create an interactive travel itinerary widget: day-by-day timeline with stops (flights, hotels, food, sights), ' +
    'a map of every stop, budget lines, packing list and live destination weather. Use for ANY trip planning request — ' +
    '"plan 3 days in Tokyo", "weekend in Rome with kids", "road trip SF→LA". Compose realistic days (3–6 stops each, ' +
    'logical geography and timing); include known lat/lng when you are confident, otherwise omit them — stops are ' +
    'geocoded automatically. ALWAYS include the inter-city/arrival TRANSPORT legs (flight, train, ferry, car, bus): ' +
    'set the stop kind to the transport mode AND fill the `transport` object (from, to, carrier, code, depart, arrive) ' +
    'so the leg renders with route + times. Use find_places/get_weather first if you need ground truth.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      destination: { type: 'string', description: 'Primary destination, e.g. "Tokyo, Japan".' },
      startDate: { type: 'string', description: 'YYYY-MM-DD' },
      endDate: { type: 'string', description: 'YYYY-MM-DD' },
      travelers: { type: 'number' },
      currency: { type: 'string', description: 'ISO code for budget amounts, e.g. USD.' },
      budget: {
        type: 'object',
        properties: {
          total: { type: 'number' },
          lines: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, amount: { type: 'number' } }, required: ['label', 'amount'] } }
        }
      },
      days: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            date: { type: 'string' },
            summary: { type: 'string' },
            stops: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  kind: { type: 'string', enum: STOP_KINDS },
                  time: { type: 'string', description: 'e.g. "09:30"' },
                  durationMin: { type: 'number' },
                  lat: { type: 'number' },
                  lng: { type: 'number' },
                  address: { type: 'string' },
                  notes: { type: 'string' },
                  cost: { type: 'number' },
                  url: { type: 'string' },
                  transport: {
                    type: 'object',
                    description: 'For transport legs only (kind flight/train/bus/car/ferry/walk): the route + times.',
                    properties: {
                      mode: { type: 'string', enum: TRANSPORT_MODES },
                      from: { type: 'string', description: 'Origin (city / station / airport code).' },
                      to: { type: 'string', description: 'Destination.' },
                      carrier: { type: 'string', description: 'Airline / rail operator / ferry line.' },
                      code: { type: 'string', description: 'Flight number / train number / route code.' },
                      depart: { type: 'string', description: 'Departure time, e.g. "08:15".' },
                      arrive: { type: 'string', description: 'Arrival time, e.g. "11:40".' }
                    }
                  }
                },
                required: ['name']
              }
            }
          },
          required: ['stops']
        }
      },
      tips: { type: 'array', items: { type: 'string' } },
      packing: { type: 'array', items: { type: 'string' } }
    },
    required: ['days']
  },
  execute: async (args, signal) => {
    const plan = coerceItinerary(args);
    if (!plan) {
      return { content: 'Could not build the itinerary: provide at least one day with stops.' };
    }
    await Promise.all([enrichCoords(plan, signal), enrichWeather(plan, signal)]);
    const stops = plan.days.reduce((n, d) => n + d.stops.length, 0);
    const located = plan.days.flatMap((d) => d.stops).filter((s) => s.lat !== undefined).length;
    return {
      content:
        `Created itinerary "${plan.title}": ${plan.days.length} days, ${stops} stops (${located} mapped)` +
        `${plan.weather?.tempC !== undefined ? `; live weather at destination: ${plan.weather.description ?? ''} ${plan.weather.tempC}°C` : ''}. ` +
        'It renders as an interactive trip widget with map, timeline and budget.',
      artifacts: [{ type: 'itinerary', data: plan }]
    };
  }
};
