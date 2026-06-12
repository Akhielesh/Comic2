// Space & science tools — ISS position, people in space, earthquakes, rocket
// launches and NASA's Astronomy Picture of the Day. Free; NASA uses DEMO_KEY
// unless a NASA_API_KEY is configured (which lifts the hourly/daily limit).

import type { ChatTool } from './types.js';
import type { DataTableArtifact, MapMarker } from '../../../../apiTypes.js';
import { fetchJson, envKey } from './http.js';

// --- ISS current position (Where the ISS at?) -----------------------------------

export interface IssTelemetry {
  latitude: number;
  longitude: number;
  altitude?: number;
  velocity?: number;
  visibility?: string;
}

/** Build the ISS map marker, with telemetry in the pin description. Pure. */
export const issToMarker = (t: IssTelemetry): MapMarker => {
  const bits: string[] = [];
  if (typeof t.altitude === 'number') bits.push(`altitude ~${Math.round(t.altitude)} km`);
  if (typeof t.velocity === 'number') bits.push(`speed ~${Math.round(t.velocity).toLocaleString()} km/h`);
  if (t.visibility) bits.push(`${t.visibility} side of Earth`);
  return {
    lat: t.latitude,
    lng: t.longitude,
    label: 'ISS 🛰️',
    ...(bits.length ? { description: bits.join(' · ') } : {})
  };
};

export const issLocationTool: ChatTool = {
  name: 'iss_location',
  description:
    'Get the International Space Station\'s current position (latitude, longitude, altitude, speed). Use for "where is the ISS right now" or live-tracking the station.',
  parameters: { type: 'object', properties: {} },
  execute: async (_args, signal) => {
    // Primary: Where the ISS at? (rich: altitude/speed). Fallback: Open Notify
    // iss-now (position only) — keeps the tool working if one host is down.
    let telemetry: IssTelemetry | undefined;
    let extra = '';
    try {
      const d = await fetchJson<{ latitude?: number; longitude?: number; altitude?: number; velocity?: number; visibility?: string }>(
        'https://api.wheretheiss.at/v1/satellites/25544',
        { signal }
      );
      if (typeof d.latitude === 'number' && typeof d.longitude === 'number') {
        telemetry = { latitude: d.latitude, longitude: d.longitude, altitude: d.altitude, velocity: d.velocity, visibility: d.visibility };
        extra = ` (altitude ${Math.round(d.altitude || 0)} km, speed ${Math.round(d.velocity || 0).toLocaleString()} km/h, ${d.visibility || 'unknown'} side)`;
      }
    } catch {
      /* fall through to Open Notify */
    }
    if (!telemetry) {
      try {
        const d = await fetchJson<{ iss_position?: { latitude?: string; longitude?: string } }>(
          'http://api.open-notify.org/iss-now.json',
          { signal }
        );
        const p = d.iss_position;
        if (p?.latitude) {
          const lat = Number(p.latitude);
          const lng = Number(p.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lng)) telemetry = { latitude: lat, longitude: lng };
        }
      } catch {
        /* both failed */
      }
    }
    if (!telemetry) {
      return { content: 'Could not get the ISS position right now (the tracking services are unreachable).' };
    }
    return {
      content: `The ISS is currently at ${telemetry.latitude.toFixed(2)}°, ${telemetry.longitude.toFixed(2)}°${extra}. (A live map with the ISS ground point is shown to the user.)`,
      artifacts: [{ type: 'map', data: { title: 'ISS — live position', markers: [issToMarker(telemetry)] } }]
    };
  }
};

// --- People currently in space (Open Notify) ------------------------------------

/** Map the Open Notify astronaut roster to a data table (name, craft). Pure. */
export const astrosToTable = (people: { name: string; craft: string }[]): DataTableArtifact => ({
  title: 'People in space right now',
  subtitle: `${people.length} aboard ${new Set(people.map((p) => p.craft)).size} spacecraft`,
  columns: [{ label: 'Astronaut' }, { label: 'Spacecraft', kind: 'badge' }],
  rows: people.map((p) => [p.name, p.craft]),
  caption: 'Source: Open Notify'
});

export const peopleInSpaceTool: ChatTool = {
  name: 'people_in_space',
  description:
    'List the astronauts currently in space and the spacecraft they are aboard (via Open Notify). Use for "who is in space right now" or "how many people are in space".',
  parameters: { type: 'object', properties: {} },
  execute: async (_args, signal) => {
    try {
      const d = await fetchJson<{ number?: number; people?: { name: string; craft: string }[] }>(
        'http://api.open-notify.org/astros.json',
        { signal }
      );
      if (!d.people?.length) return { content: 'Could not retrieve who is currently in space.' };
      const byCraft = new Map<string, string[]>();
      for (const p of d.people) {
        const arr = byCraft.get(p.craft) || [];
        arr.push(p.name);
        byCraft.set(p.craft, arr);
      }
      const groups = Array.from(byCraft.entries()).map(([craft, names]) => `• ${craft}: ${names.join(', ')}`);
      return {
        content: `There are currently ${d.number ?? d.people.length} people in space:\n${groups.join('\n')}\n(A roster table is shown to the user — don't repeat the names.)`,
        artifacts: [{ type: 'data_table', data: astrosToTable(d.people) }]
      };
    } catch (err) {
      return { content: `People-in-space lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- Earthquakes (USGS) ---------------------------------------------------------
export interface QuakeFeature {
  properties?: { mag?: number; place?: string; time?: number; url?: string };
  geometry?: { coordinates?: number[] };
}

/** Map USGS GeoJSON quakes to map markers (label = magnitude + place, description = depth/time), capped at 10. Pure. */
export const quakesToMarkers = (quakes: QuakeFeature[]): MapMarker[] =>
  quakes
    .filter((q) => Array.isArray(q.geometry?.coordinates) && q.geometry!.coordinates!.length >= 2 && q.properties?.mag != null)
    .slice(0, 10)
    .map((q) => {
      const [lng, lat, depth] = q.geometry!.coordinates!;
      const p = q.properties!;
      const bits: string[] = [];
      if (typeof depth === 'number' && Number.isFinite(depth)) bits.push(`depth ${Math.round(depth)} km`);
      if (typeof p.time === 'number') bits.push(new Date(p.time).toUTCString());
      return {
        lat,
        lng,
        label: `M${p.mag!.toFixed(1)} — ${p.place || 'unknown location'}`,
        ...(bits.length ? { description: bits.join(' · ') } : {})
      };
    });

export const earthquakesTool: ChatTool = {
  name: 'earthquakes',
  description:
    'Get recent significant earthquakes worldwide from USGS — magnitude, location, time and a map. Use for "recent earthquakes", "any earthquakes in X", or seismic activity questions.',
  parameters: {
    type: 'object',
    properties: {
      minMagnitude: { type: 'number', description: 'Minimum magnitude (default 4.5).' },
      days: { type: 'number', description: 'How many days back to search (default 1, max 30).' }
    }
  },
  execute: async (args, signal) => {
    const minMag = typeof args?.minMagnitude === 'number' && args.minMagnitude > 0 ? args.minMagnitude : 4.5;
    const days = Math.min(30, Math.max(1, typeof args?.days === 'number' ? Math.floor(args.days) : 1));
    const start = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    try {
      const d = await fetchJson<{ features?: QuakeFeature[] }>(
        `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start}&minmagnitude=${minMag}&orderby=magnitude&limit=10`,
        { signal }
      );
      const quakes = (d.features || []).filter((f) => f.properties?.mag != null).slice(0, 10);
      if (!quakes.length) return { content: `No earthquakes ≥ M${minMag} in the last ${days} day(s).` };
      const content = `Earthquakes ≥ M${minMag} (last ${days} day(s)):\n${quakes
        .map((q) => {
          const p = q.properties!;
          return `• M${p.mag?.toFixed(1)} — ${p.place || 'unknown'}${p.time ? ` (${new Date(p.time).toUTCString()})` : ''}`;
        })
        .join('\n')}`;
      const markers = quakesToMarkers(quakes);
      return {
        content: markers.length ? `${content}\n(A quake map is shown to the user — don't repeat the list.)` : content,
        ...(markers.length ? { artifacts: [{ type: 'map', data: { title: 'Recent earthquakes', markers } }] } : {}),
        citations: quakes.filter((q) => q.properties?.url).map((q) => ({ url: q.properties!.url!, title: q.properties!.place }))
      };
    } catch (err) {
      return { content: `Earthquake lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- Rocket launches (SpaceX) ---------------------------------------------------
export interface Launch {
  name?: string;
  date_utc?: string;
  details?: string;
  success?: boolean | null;
  links?: { webcast?: string; patch?: { small?: string } };
}

// Note: the v5 list endpoint only carries a rocket *id*, so the table is
// mission / date / status / details (a rocket name would need an extra call).
/** Map SpaceX launches to a data table; mission links to the webcast when available. Pure. */
export const launchesToTable = (launches: Launch[], when: 'upcoming' | 'recent'): DataTableArtifact => ({
  title: `${when === 'recent' ? 'Recent' : 'Upcoming'} SpaceX launches`,
  columns: [{ label: 'Mission' }, { label: 'Date (UTC)' }, { label: 'Status', kind: 'badge' }, { label: 'Details' }],
  rows: launches.map((l) => {
    const date = l.date_utc ? `${l.date_utc.slice(0, 10)} ${l.date_utc.slice(11, 16)}` : 'TBD';
    const status = when === 'recent' ? (l.success === true ? 'Success' : l.success === false ? 'Failure' : 'Unknown') : 'Upcoming';
    return [
      { value: l.name || 'Mission', href: l.links?.webcast },
      date,
      status,
      l.details ? `${l.details.slice(0, 120)}${l.details.length > 120 ? '…' : ''}` : '—'
    ];
  }),
  caption: 'Source: SpaceX API (r/SpaceX)'
});

export const spaceLaunchesTool: ChatTool = {
  name: 'space_launches',
  description:
    'Get upcoming or recent SpaceX rocket launches — mission name, date, details and webcast. Use for "next rocket launch", "recent SpaceX launches", or spaceflight schedule questions.',
  parameters: {
    type: 'object',
    properties: { when: { type: 'string', enum: ['upcoming', 'recent'], description: 'Upcoming launches or recent past launches (default "upcoming").' } }
  },
  execute: async (args, signal) => {
    const when = args?.when === 'recent' ? 'recent' : 'upcoming';
    try {
      const all = await fetchJson<Launch[]>('https://api.spacexdata.com/v5/launches/' + (when === 'recent' ? 'past' : 'upcoming'), { signal });
      if (!Array.isArray(all) || !all.length) return { content: `No ${when} SpaceX launches found.` };
      const sorted = all
        .filter((l) => l.date_utc)
        .sort((a, b) => (when === 'recent' ? Date.parse(b.date_utc!) - Date.parse(a.date_utc!) : Date.parse(a.date_utc!) - Date.parse(b.date_utc!)))
        .slice(0, 5);
      const content = `${when === 'recent' ? 'Recent' : 'Upcoming'} SpaceX launches:\n${sorted
        .map((l) => {
          const date = l.date_utc ? new Date(l.date_utc).toUTCString() : 'TBD';
          const status = when === 'recent' ? (l.success === true ? ' ✓' : l.success === false ? ' ✗' : '') : '';
          return `• ${l.name}${status} — ${date}${l.details ? `\n  ${l.details.slice(0, 160)}` : ''}`;
        })
        .join('\n')}`;
      const citations = sorted.filter((l) => l.links?.webcast).map((l) => ({ url: l.links!.webcast!, title: `${l.name} webcast` }));
      const images = sorted.filter((l) => l.links?.patch?.small).slice(0, 3).map((l) => ({ url: l.links!.patch!.small!, title: l.name, source: 'SpaceX' }));
      return {
        content: `${content}\n(A launch table is shown to the user — don't repeat the schedule.)`,
        ...(citations.length ? { citations } : {}),
        ...(images.length ? { images } : {}),
        artifacts: [{ type: 'data_table', data: launchesToTable(sorted, when) }]
      };
    } catch (err) {
      return { content: `Launch lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- NASA Astronomy Picture of the Day ------------------------------------------
export const nasaApodTool: ChatTool = {
  name: 'nasa_apod',
  description:
    'Get NASA\'s Astronomy Picture of the Day — a stunning space image (or video) with an expert explanation. Use for "astronomy picture of the day", a space image, or "what is the APOD".',
  parameters: {
    type: 'object',
    properties: { date: { type: 'string', description: 'Optional date YYYY-MM-DD (default today). Must be 1995-06-16 or later.' } }
  },
  execute: async (args, signal) => {
    const key = envKey('NASA_API_KEY') || 'DEMO_KEY';
    const date = typeof args?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? `&date=${args.date}` : '';
    try {
      const d = await fetchJson<{ title?: string; explanation?: string; url?: string; hdurl?: string; media_type?: string; date?: string; copyright?: string }>(
        `https://api.nasa.gov/planetary/apod?api_key=${key}${date}`,
        { signal }
      );
      if (!d.title) return { content: 'Could not fetch the Astronomy Picture of the Day.' };
      const content = `NASA APOD${d.date ? ` (${d.date})` : ''} — ${d.title}${d.copyright ? ` © ${d.copyright.trim()}` : ''}:\n${(d.explanation || '').slice(0, 500)}…\n${d.url || ''}`;
      const isImage = d.media_type !== 'video' && (d.url || d.hdurl);
      return {
        content,
        ...(isImage ? { images: [{ url: d.hdurl || d.url!, title: d.title, source: 'NASA APOD' }] } : {}),
        ...(d.url ? { citations: [{ url: d.url, title: d.title }] } : {})
      };
    } catch (err) {
      return { content: `NASA APOD lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

export const SPACE_TOOLS: ChatTool[] = [issLocationTool, peopleInSpaceTool, earthquakesTool, spaceLaunchesTool, nasaApodTool];
