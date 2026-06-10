// Travel widget tools — wallet-style cards the model composes for trips: boarding
// pass, world clocks, packing list, trip countdown. These are model-authored (the
// model supplies the facts), but trip_countdown is enriched server-side with LIVE
// destination weather (Open-Meteo, keyless) the same way plan_trip is.

import type { ChatTool } from './types.js';
import type {
  BoardingPassArtifact,
  BoardingPassEndpoint,
  BoardingPassStatus,
  WorldClocksArtifact,
  WorldClockZone,
  PackingListArtifact,
  PackingGroup,
  TripCountdownArtifact,
  FlightStatusArtifact,
  FlightEndpointStatus,
  FlightPhase,
  TripBudgetArtifact,
  BudgetCategory,
  LocalCheatsheetArtifact,
  CheatsheetPhrase,
  LoyaltyWalletArtifact,
  LoyaltyCard
} from '../../../../apiTypes.js';
import { getWeather } from './weather.js';
import { fetchJson, envKey } from './http.js';

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const strList = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, maxLen)).filter((x): x is string => !!x).slice(0, maxItems) : [];

/** Stable-enough id for locally-persisted widget state when the model omits one. */
const slugId = (seed: string): string =>
  `${seed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item'}-${Date.now().toString(36)}`;

// ---------------------------------------------------------------- boarding pass ---

const PASS_STATUSES: BoardingPassStatus[] = ['on-time', 'delayed', 'boarding', 'departed', 'cancelled'];

const coerceEndpoint = (v: unknown): BoardingPassEndpoint | null => {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const code = str(r.code, 5)?.toUpperCase();
  if (!code) return null;
  return {
    code,
    city: str(r.city, 80),
    time: str(r.time, 20),
    date: str(r.date, 24),
    terminal: str(r.terminal, 20)
  };
};

export const boardingPassTool: ChatTool = {
  name: 'render_boarding_pass',
  description:
    'Render a wallet-style BOARDING PASS card for a flight — route (IATA codes), times, gate/seat/boarding group, passenger, status (with a status glow), a QR of the confirmation code, and a flip side with fare class, baggage and your tips. Use when the user shares flight details, asks you to track/summarize a flight, or a trip plan includes a booked flight. Fill ONLY fields you actually know — omit the rest; never invent gates or seats.',
  parameters: {
    type: 'object',
    properties: {
      airline: { type: 'string', description: 'Airline name, e.g. "United".' },
      flightNumber: { type: 'string', description: 'e.g. "UA 82".' },
      from: {
        type: 'object',
        properties: { code: { type: 'string', description: 'IATA, e.g. "IAD".' }, city: { type: 'string' }, time: { type: 'string', description: 'Local, e.g. "10:45".' }, date: { type: 'string' }, terminal: { type: 'string' } },
        required: ['code']
      },
      to: {
        type: 'object',
        properties: { code: { type: 'string' }, city: { type: 'string' }, time: { type: 'string' }, date: { type: 'string' } },
        required: ['code']
      },
      gate: { type: 'string' },
      seat: { type: 'string' },
      boardingGroup: { type: 'string' },
      boardingTime: { type: 'string' },
      passenger: { type: 'string' },
      status: { type: 'string', enum: PASS_STATUSES },
      statusNote: { type: 'string', description: 'e.g. "Delayed 40 min — inbound aircraft".' },
      confirmation: { type: 'string', description: 'Record locator (encoded into the QR).' },
      fareClass: { type: 'string' },
      baggage: { type: 'string', description: 'e.g. "1 checked + carry-on".' },
      durationMin: { type: 'number' },
      aircraft: { type: 'string' },
      notes: { type: 'array', items: { type: 'string' }, description: 'Your helpful tips ("Gate B32 is a 12-min walk").' },
      accent: { type: 'string', description: 'Airline brand color hex, e.g. "#1414D2".' }
    },
    required: ['airline', 'flightNumber', 'from', 'to']
  },
  execute: async (args) => {
    const from = coerceEndpoint(args?.from);
    const to = coerceEndpoint(args?.to);
    const airline = str(args?.airline, 60);
    const flightNumber = str(args?.flightNumber, 16);
    if (!from || !to || !airline || !flightNumber) {
      return { content: 'A boarding pass needs airline, flightNumber and from/to airport codes.' };
    }
    const accent = typeof args?.accent === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(args.accent) ? args.accent : undefined;
    const data: BoardingPassArtifact = {
      airline,
      flightNumber,
      from,
      to,
      gate: str(args?.gate, 12),
      seat: str(args?.seat, 8),
      boardingGroup: str(args?.boardingGroup, 12),
      boardingTime: str(args?.boardingTime, 20),
      passenger: str(args?.passenger, 80),
      status: PASS_STATUSES.includes(args?.status as BoardingPassStatus) ? (args?.status as BoardingPassStatus) : undefined,
      statusNote: str(args?.statusNote, 140),
      confirmation: str(args?.confirmation, 20),
      fareClass: str(args?.fareClass, 40),
      baggage: str(args?.baggage, 80),
      durationMin: num(args?.durationMin),
      aircraft: str(args?.aircraft, 60),
      notes: strList(args?.notes, 6, 160),
      accent
    };
    return {
      content: `Rendered the boarding pass for ${airline} ${flightNumber}, ${from.code} → ${to.code}${data.status ? ` (${data.status})` : ''}. The wallet-style card is shown to the user — keep prose to one line.`,
      artifacts: [{ type: 'boarding_pass', data }]
    };
  }
};

// ----------------------------------------------------------------- world clocks ---

const validTz = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const worldClocksTool: ChatTool = {
  name: 'render_world_clocks',
  description:
    'Render LIVE ticking world clocks for 2–6 places — analog + digital time per zone, day/night and sleep-hours shading, and (with exactly two zones) a "good time to call home?" indicator. Use for time-zone questions between places, coordinating calls across zones, or as a travel companion card (home vs destination). Pass IANA zone ids (e.g. "Asia/Kolkata"); the clocks tick in real time client-side.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      zones: {
        type: 'array',
        description: '2–6 zones. label = friendly place name; tz = IANA zone id.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'e.g. "Home — Washington DC".' },
            tz: { type: 'string', description: 'IANA zone, e.g. "America/New_York".' },
            wakeStart: { type: 'number', description: 'Waking hours start (default 8).' },
            wakeEnd: { type: 'number', description: 'Waking hours end (default 22).' }
          },
          required: ['label', 'tz']
        }
      }
    },
    required: ['zones']
  },
  execute: async (args) => {
    const zones: WorldClockZone[] = (Array.isArray(args?.zones) ? args.zones : [])
      .flatMap((z): WorldClockZone[] => {
        if (!z || typeof z !== 'object') return [];
        const r = z as Record<string, unknown>;
        const label = str(r.label, 60);
        const tz = str(r.tz, 60);
        if (!label || !tz || !validTz(tz)) return [];
        const hour = (v: unknown) => {
          const n = num(v);
          return n !== undefined && n >= 0 && n <= 24 ? Math.round(n) : undefined;
        };
        return [{ label, tz, wakeStart: hour(r.wakeStart), wakeEnd: hour(r.wakeEnd) }];
      })
      .slice(0, 6);
    if (!zones.length) return { content: 'No usable time zones were provided (each needs a label and a valid IANA tz).' };
    const data: WorldClocksArtifact = { title: str(args?.title, 80), zones };
    return {
      content: `Rendered live world clocks for ${zones.map((z) => z.label).join(', ')}. The clocks tick in real time on the card — keep prose to one line.`,
      artifacts: [{ type: 'world_clocks', data }]
    };
  }
};

// ----------------------------------------------------------------- packing list ---

export const packingListTool: ChatTool = {
  name: 'render_packing_list',
  description:
    "Render an interactive PACKING LIST the user can check off (progress persists on their device). Generate the items yourself from the trip's destination weather, length and activities — group them (Clothing / Documents / Tech / Toiletries / Extras) and keep items short. Use after planning a trip, when the user asks what to pack, or alongside a forecast. Include a context line summarizing what informed the list.",
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Stable id for saved progress; omit to auto-generate.' },
      title: { type: 'string', description: 'e.g. "Packing — 5 days in Tokyo".' },
      destination: { type: 'string' },
      context: { type: 'string', description: 'What informed the list, e.g. "5 days · highs 31°C · rain likely".' },
      groups: {
        type: 'array',
        description: 'Grouped items (2–6 groups, short item names).',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'e.g. "Clothing".' },
            items: { type: 'array', items: { type: 'string' } }
          },
          required: ['items']
        }
      },
      tips: { type: 'array', items: { type: 'string' } }
    },
    required: ['title', 'groups']
  },
  execute: async (args) => {
    const title = str(args?.title, 120);
    const groups: PackingGroup[] = (Array.isArray(args?.groups) ? args.groups : [])
      .flatMap((g): PackingGroup[] => {
        if (!g || typeof g !== 'object') return [];
        const r = g as Record<string, unknown>;
        const items = strList(r.items, 24, 80);
        return items.length ? [{ name: str(r.name, 40), items }] : [];
      })
      .slice(0, 8);
    if (!title || !groups.length) return { content: 'A packing list needs a title and at least one group with items.' };
    const data: PackingListArtifact = {
      id: str(args?.id, 60) ?? slugId(title),
      title,
      destination: str(args?.destination, 80),
      context: str(args?.context, 160),
      groups,
      tips: strList(args?.tips, 6, 160)
    };
    const total = groups.reduce((s, g) => s + g.items.length, 0);
    return {
      content: `Rendered the packing list "${title}" (${total} items in ${groups.length} groups). It is interactive — check-offs persist on the user's device. Keep prose to one line.`,
      artifacts: [{ type: 'packing_list', data }]
    };
  }
};

// --------------------------------------------------------------- trip countdown ---

export const tripCountdownTool: ChatTool = {
  name: 'render_trip_countdown',
  description:
    'Render a TRIP COUNTDOWN hero — a live ticking countdown to departure with the destination, a LIVE destination weather strip (attached automatically server-side) and an optional prep checklist. Use when a user has an upcoming trip with a known start date ("Bali on July 3rd"), after building an itinerary, or when they ask "how long until my trip".',
  parameters: {
    type: 'object',
    properties: {
      destination: { type: 'string', description: 'e.g. "Bali, Indonesia".' },
      startDate: { type: 'string', description: 'ISO date or datetime the trip starts, e.g. "2026-07-03" or "2026-07-03T10:45".' },
      endDate: { type: 'string', description: 'ISO date the trip ends.' },
      title: { type: 'string', description: 'Optional, e.g. "Honeymoon".' },
      checklist: {
        type: 'array',
        description: 'Prep items with done flags (visa, bookings, packing).',
        items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text'] }
      },
      accent: { type: 'string', description: 'Accent color hex.' }
    },
    required: ['destination', 'startDate']
  },
  execute: async (args, signal) => {
    const destination = str(args?.destination, 100);
    const startDate = str(args?.startDate, 32);
    if (!destination || !startDate || Number.isNaN(new Date(startDate).getTime())) {
      return { content: 'A trip countdown needs a destination and a valid ISO startDate.' };
    }
    const checklist = (Array.isArray(args?.checklist) ? args.checklist : [])
      .flatMap((c) => {
        if (!c || typeof c !== 'object') return [];
        const r = c as Record<string, unknown>;
        const text = str(r.text, 120);
        return text ? [{ text, done: r.done === true }] : [];
      })
      .slice(0, 10);
    const data: TripCountdownArtifact = {
      destination,
      startDate,
      endDate: str(args?.endDate, 32),
      title: str(args?.title, 80),
      checklist: checklist.length ? checklist : undefined,
      accent: typeof args?.accent === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(args.accent) ? args.accent : undefined
    };
    // Live destination weather, best-effort — the countdown ships without it on failure.
    try {
      const wx = await getWeather(destination, signal);
      data.weather = {
        description: wx.current?.description,
        tempC: wx.current?.tempC,
        daily: (wx.daily ?? []).slice(0, 5).map((d) => ({ date: d.date, minC: d.minC, maxC: d.maxC, description: d.description, precipProb: d.precipProb }))
      };
    } catch {
      /* no weather strip */
    }
    const days = Math.max(0, Math.ceil((new Date(startDate).getTime() - Date.now()) / 86_400_000));
    return {
      content: `Rendered the countdown to ${destination} (${days} day${days === 1 ? '' : 's'} to go${data.weather?.tempC !== undefined ? `; live weather there: ${data.weather.description ?? ''} ${data.weather.tempC}°C` : ''}). The card ticks live — keep prose to one line.`,
      artifacts: [{ type: 'trip_countdown', data }]
    };
  }
};

// ---------------------------------------------------------------- flight status ---
// Live via aviationstack when AVIATIONSTACK_API_KEY is configured (free tier:
// 100 req/month, HTTP-only); otherwise renders the model-supplied schedule with
// live:false and a notice naming the key. See docs/features/data-connectors.md §4-H.

const FLIGHT_PHASES: FlightPhase[] = ['scheduled', 'active', 'landed', 'cancelled', 'diverted', 'unknown'];

const coerceFlightEndpoint = (v: unknown): FlightEndpointStatus | null => {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const code = str(r.code, 5)?.toUpperCase();
  if (!code) return null;
  return {
    code,
    city: str(r.city, 80),
    scheduled: str(r.scheduled, 32),
    estimated: str(r.estimated, 32),
    actual: str(r.actual, 32),
    terminal: str(r.terminal, 12),
    gate: str(r.gate, 12)
  };
};

/** 0–100 along the route from departure/arrival times (best-effort). */
const progressFromTimes = (dep?: FlightEndpointStatus, arr?: FlightEndpointStatus): number | undefined => {
  const start = new Date(dep?.actual ?? dep?.estimated ?? dep?.scheduled ?? '').getTime();
  const end = new Date(arr?.estimated ?? arr?.scheduled ?? '').getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  return Math.round(Math.max(0, Math.min(1, (Date.now() - start) / (end - start))) * 100);
};

interface AvsFlight {
  flight_status?: string;
  airline?: { name?: string };
  flight?: { iata?: string };
  departure?: Record<string, unknown>;
  arrival?: Record<string, unknown>;
  live?: { altitude?: number; speed_horizontal?: number; is_ground?: boolean };
}

const avsEndpoint = (raw?: Record<string, unknown>): FlightEndpointStatus | null => {
  if (!raw) return null;
  const code = str(raw.iata, 5)?.toUpperCase();
  if (!code) return null;
  return {
    code,
    city: str(raw.airport, 80),
    scheduled: str(raw.scheduled, 40),
    estimated: str(raw.estimated, 40),
    actual: str(raw.actual, 40),
    terminal: str(raw.terminal, 12),
    gate: str(raw.gate, 12)
  };
};

const fetchAviationstack = async (flightIata: string, key: string, signal?: AbortSignal): Promise<AvsFlight | null> => {
  const query = `access_key=${encodeURIComponent(key)}&flight_iata=${encodeURIComponent(flightIata)}`;
  // The free tier is HTTP-only; try HTTPS first for keyed/paid accounts.
  for (const proto of ['https', 'http'] as const) {
    try {
      const data = await fetchJson<{ data?: AvsFlight[] }>(`${proto}://api.aviationstack.com/v1/flights?${query}`, { signal });
      const flight = data.data?.[0];
      if (flight) return flight;
    } catch {
      /* try the next protocol */
    }
  }
  return null;
};

export const flightStatusTool: ChatTool = {
  name: 'get_flight_status',
  description:
    'Track a FLIGHT — status (scheduled/active/landed/cancelled), departure/arrival times with delays, terminal/gate, and a route-progress arc. Use when the user asks "where is flight X", "is UA 2402 on time", or wants to track an upcoming flight. Pass the IATA flight number (e.g. "UA2402"); with a configured aviationstack key the data is live. WITHOUT the key, also pass whatever schedule you know (departure/arrival codes and times) so the card renders schedule-only — never invent gates or delays.',
  parameters: {
    type: 'object',
    properties: {
      flightNumber: { type: 'string', description: 'IATA flight number, e.g. "UA2402".' },
      airline: { type: 'string' },
      status: { type: 'string', enum: FLIGHT_PHASES, description: 'Your best known status (fallback mode only).' },
      departure: {
        type: 'object',
        properties: { code: { type: 'string' }, city: { type: 'string' }, scheduled: { type: 'string', description: 'ISO datetime.' }, terminal: { type: 'string' }, gate: { type: 'string' } },
        required: ['code']
      },
      arrival: {
        type: 'object',
        properties: { code: { type: 'string' }, city: { type: 'string' }, scheduled: { type: 'string' }, terminal: { type: 'string' } },
        required: ['code']
      }
    },
    required: ['flightNumber']
  },
  execute: async (args, signal) => {
    const flightNumber = str(args?.flightNumber, 10)?.toUpperCase().replace(/\s+/g, '');
    if (!flightNumber) return { content: 'A flight number is required, e.g. "UA2402".' };
    const key = envKey('AVIATIONSTACK_API_KEY');
    if (key) {
      const flight = await fetchAviationstack(flightNumber, key, signal);
      const dep = avsEndpoint(flight?.departure);
      const arr = avsEndpoint(flight?.arrival);
      if (flight && dep && arr) {
        const status = FLIGHT_PHASES.includes(flight.flight_status as FlightPhase) ? (flight.flight_status as FlightPhase) : 'unknown';
        const delayMin = num(flight.departure?.delay);
        const data: FlightStatusArtifact = {
          airline: str(flight.airline?.name, 60) ?? str(args?.airline, 60),
          flightNumber,
          status,
          departure: dep,
          arrival: arr,
          progressPct: status === 'landed' ? 100 : status === 'active' ? progressFromTimes(dep, arr) : status === 'scheduled' ? 0 : undefined,
          altitudeM: num(flight.live?.altitude),
          speedKmh: num(flight.live?.speed_horizontal),
          delayMin,
          live: true,
          asOf: new Date().toISOString()
        };
        return {
          content: `Live flight status for ${flightNumber}: ${status}${delayMin ? `, departure delayed ${delayMin} min` : ''}, ${dep.code} → ${arr.code}. The tracker card carries the detail — one short line is enough.`,
          artifacts: [{ type: 'flight_status', data }]
        };
      }
      // Keyed but no match — fall through to schedule-only with an honest note.
    }
    const dep = coerceFlightEndpoint(args?.departure);
    const arr = coerceFlightEndpoint(args?.arrival);
    if (!dep || !arr) {
      return {
        content: key
          ? `No live record found for ${flightNumber} (it may not be operating today). Provide the departure/arrival airports and times you know to render a schedule-only card.`
          : `Live flight tracking is not configured. Provide the departure/arrival airports and scheduled times you know for ${flightNumber} and call this tool again to render a schedule-only card.`,
        notice: {
          level: key ? ('warn' as const) : ('info' as const),
          message: key ? `aviationstack had no live record for ${flightNumber}.` : 'Flight tracking is in schedule-only mode — live status needs a key.',
          fix: key ? undefined : 'Set AVIATIONSTACK_API_KEY (free 100 req/mo: aviationstack.com)'
        }
      };
    }
    const status = FLIGHT_PHASES.includes(args?.status as FlightPhase) ? (args?.status as FlightPhase) : 'scheduled';
    const data: FlightStatusArtifact = {
      airline: str(args?.airline, 60),
      flightNumber,
      status,
      departure: dep,
      arrival: arr,
      progressPct: status === 'landed' ? 100 : status === 'active' ? progressFromTimes(dep, arr) : 0,
      live: false,
      asOf: new Date().toISOString()
    };
    return {
      content: `Rendered ${flightNumber} ${dep.code} → ${arr.code} as a SCHEDULE-ONLY tracker (no live provider configured). Tell the user this reflects the schedule, not live status.`,
      artifacts: [{ type: 'flight_status', data }],
      notice: {
        level: 'info' as const,
        message: 'Flight card is schedule-only — live status/delays need a key.',
        fix: key ? undefined : 'Set AVIATIONSTACK_API_KEY (free 100 req/mo: aviationstack.com)'
      }
    };
  }
};

// ------------------------------------------------------------------ trip budget ---

export const tripBudgetTool: ChatTool = {
  name: 'render_trip_budget',
  description:
    'Render a TRIP BUDGET BURN gauge — total vs spent on a banded fuel gauge, per-category bars, and a pace verdict computed from the trip dates ("at this rate you exceed budget by day 5"). Use when the user shares trip spending, asks "am I on budget", or after logging expenses.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      currency: { type: 'string' },
      total: { type: 'number', description: 'Total trip budget.' },
      spent: { type: 'number', description: 'Spent so far.' },
      startDate: { type: 'string', description: 'ISO trip start (enables the pace verdict).' },
      endDate: { type: 'string', description: 'ISO trip end.' },
      categories: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, spent: { type: 'number' }, budget: { type: 'number' } },
          required: ['label', 'spent']
        }
      }
    },
    required: ['total', 'spent']
  },
  execute: async (args) => {
    const total = num(args?.total);
    const spent = num(args?.spent);
    if (total === undefined || spent === undefined || total <= 0) {
      return { content: 'A trip budget needs a positive total and the amount spent so far.' };
    }
    const categories: BudgetCategory[] = (Array.isArray(args?.categories) ? args.categories : [])
      .flatMap((c): BudgetCategory[] => {
        if (!c || typeof c !== 'object') return [];
        const r = c as Record<string, unknown>;
        const label = str(r.label, 40);
        const catSpent = num(r.spent);
        if (!label || catSpent === undefined) return [];
        return [{ label, spent: catSpent, budget: num(r.budget) }];
      })
      .slice(0, 10);
    const data: TripBudgetArtifact = {
      title: str(args?.title, 80),
      currency: str(args?.currency, 8),
      total,
      spent,
      startDate: str(args?.startDate, 24),
      endDate: str(args?.endDate, 24),
      categories: categories.length ? categories : undefined
    };
    return {
      content: `Rendered the trip budget gauge: ${spent.toFixed(0)} of ${total.toFixed(0)}${data.currency ? ` ${data.currency}` : ''} spent (${Math.round((spent / total) * 100)}%). The card computes the pace verdict — keep prose to one line.`,
      artifacts: [{ type: 'trip_budget', data }]
    };
  }
};

// --------------------------------------------------------------- local cheat-sheet ---

export const cheatsheetTool: ChatTool = {
  name: 'render_cheatsheet',
  description:
    "Render a DESTINATION CHEAT-SHEET — emergency numbers, tipping norms, plug type & voltage, cash/card norms, tap-water safety, 4–6 useful phrases with pronunciation, scam warnings and etiquette. Generate it yourself per city/country (use web_search if unsure about emergency numbers — never guess those). Use before/at the start of a trip or when the user asks 'what should I know about X'.",
  parameters: {
    type: 'object',
    properties: {
      destination: { type: 'string' },
      language: { type: 'string' },
      currency: { type: 'string' },
      emergency: { type: 'string', description: 'General emergency number, e.g. "112".' },
      police: { type: 'string' },
      ambulance: { type: 'string' },
      tipping: { type: 'string', description: 'e.g. "Not expected; round up taxis".' },
      plug: { type: 'string', description: 'e.g. "Type A / B".' },
      voltage: { type: 'string', description: 'e.g. "100V · 50/60Hz".' },
      cashNorm: { type: 'string', description: 'e.g. "Cash-heavy; many izakaya card-free".' },
      tapWater: { type: 'string', description: '"Safe to drink" or "Stick to bottled".' },
      phrases: {
        type: 'array',
        items: {
          type: 'object',
          properties: { local: { type: 'string' }, meaning: { type: 'string' }, say: { type: 'string', description: 'Phonetic hint.' } },
          required: ['local', 'meaning']
        }
      },
      warnings: { type: 'array', items: { type: 'string' }, description: 'Common scams / safety notes.' },
      etiquette: { type: 'array', items: { type: 'string' } }
    },
    required: ['destination']
  },
  execute: async (args) => {
    const destination = str(args?.destination, 80);
    if (!destination) return { content: 'A cheat-sheet needs a destination.' };
    const phrases: CheatsheetPhrase[] = (Array.isArray(args?.phrases) ? args.phrases : [])
      .flatMap((p): CheatsheetPhrase[] => {
        if (!p || typeof p !== 'object') return [];
        const r = p as Record<string, unknown>;
        const local = str(r.local, 80);
        const meaning = str(r.meaning, 80);
        return local && meaning ? [{ local, meaning, say: str(r.say, 80) }] : [];
      })
      .slice(0, 8);
    const data: LocalCheatsheetArtifact = {
      destination,
      language: str(args?.language, 40),
      currency: str(args?.currency, 24),
      emergency: str(args?.emergency, 16),
      police: str(args?.police, 16),
      ambulance: str(args?.ambulance, 16),
      tipping: str(args?.tipping, 120),
      plug: str(args?.plug, 40),
      voltage: str(args?.voltage, 32),
      cashNorm: str(args?.cashNorm, 120),
      tapWater: str(args?.tapWater, 60),
      phrases: phrases.length ? phrases : undefined,
      warnings: strList(args?.warnings, 5, 160),
      etiquette: strList(args?.etiquette, 5, 160)
    };
    return {
      content: `Rendered the ${destination} cheat-sheet (emergency ${data.emergency ?? 'n/a'}, plug ${data.plug ?? 'n/a'}, ${phrases.length} phrases). The card carries the detail — keep prose to one line.`,
      artifacts: [{ type: 'local_cheatsheet', data }]
    };
  }
};

// ---------------------------------------------------------------- loyalty wallet ---

export const loyaltyWalletTool: ChatTool = {
  name: 'render_loyalty_wallet',
  description:
    "Render a LOYALTY WALLET — stacked membership cards (airline/hotel/rail programs) with points balances, tier + progress to the next tier, expiry and your redemption suggestion per program ('use 24k points for this leg?'). Use when the user shares program balances or asks how to use their points. Mask member numbers to the last 4 digits.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      cards: {
        type: 'array',
        description: '1–6 programs.',
        items: {
          type: 'object',
          properties: {
            program: { type: 'string' },
            member: { type: 'string' },
            number: { type: 'string', description: 'Last 4 digits only.' },
            points: { type: 'number' },
            pointsLabel: { type: 'string', description: '"miles", "points", "nights".' },
            tier: { type: 'string' },
            tierProgress: {
              type: 'object',
              properties: { value: { type: 'number' }, max: { type: 'number' }, nextTier: { type: 'string' } },
              required: ['value', 'max']
            },
            expiry: { type: 'string' },
            accent: { type: 'string', description: 'Brand color hex.' },
            note: { type: 'string', description: 'Your redemption suggestion.' }
          },
          required: ['program']
        }
      }
    },
    required: ['cards']
  },
  execute: async (args) => {
    const cards: LoyaltyCard[] = (Array.isArray(args?.cards) ? args.cards : [])
      .flatMap((c): LoyaltyCard[] => {
        if (!c || typeof c !== 'object') return [];
        const r = c as Record<string, unknown>;
        const program = str(r.program, 60);
        if (!program) return [];
        const progRaw = r.tierProgress as Record<string, unknown> | undefined;
        const progValue = num(progRaw?.value);
        const progMax = num(progRaw?.max);
        const number = str(r.number, 24);
        return [
          {
            program,
            member: str(r.member, 60),
            // Defense in depth: never carry more than the last 4 digits forward.
            number: number ? number.replace(/.(?=.{4})/g, '•') : undefined,
            points: num(r.points),
            pointsLabel: str(r.pointsLabel, 16),
            tier: str(r.tier, 32),
            tierProgress:
              progValue !== undefined && progMax !== undefined && progMax > 0
                ? { value: progValue, max: progMax, nextTier: str(progRaw?.nextTier, 32) }
                : undefined,
            expiry: str(r.expiry, 24),
            accent: typeof r.accent === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(r.accent) ? r.accent : undefined,
            note: str(r.note, 160)
          }
        ];
      })
      .slice(0, 6);
    if (!cards.length) return { content: 'No usable loyalty cards were provided (each needs a program name).' };
    const data: LoyaltyWalletArtifact = { title: str(args?.title, 80), cards };
    return {
      content: `Rendered the loyalty wallet (${cards.map((c) => c.program).join(', ')}). The card carries balances and tiers — surface only your best redemption idea.`,
      artifacts: [{ type: 'loyalty_wallet', data }]
    };
  }
};

export const TRAVEL_WIDGET_TOOLS: ChatTool[] = [
  boardingPassTool,
  worldClocksTool,
  packingListTool,
  tripCountdownTool,
  flightStatusTool,
  tripBudgetTool,
  cheatsheetTool,
  loyaltyWalletTool
];
