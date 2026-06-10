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
  TripCountdownArtifact
} from '../../../../apiTypes.js';
import { getWeather } from './weather.js';

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

export const TRAVEL_WIDGET_TOOLS: ChatTool[] = [boardingPassTool, worldClocksTool, packingListTool, tripCountdownTool];
