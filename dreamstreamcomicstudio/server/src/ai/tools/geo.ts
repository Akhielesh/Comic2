// Geography & reference tools — countries, IP geolocation, public holidays,
// sunrise/sunset, world time, postal codes and universities. All free & keyless.
// Structured results also emit rich artifact cards (metric_board / data_table /
// world_clocks) so they render as widgets and pin to dashboards.

import type { ChatTool } from './types.js';
import type { DataTableArtifact, MetricBoardArtifact, MetricTile, WorldClocksArtifact } from '../../../../apiTypes.js';
import { fetchJson } from './http.js';

// Shared geocoder (Open-Meteo) — name → coordinates + IANA timezone. Keyless.
interface GeoHit {
  latitude: number;
  longitude: number;
  name: string;
  country?: string;
  admin1?: string;
  timezone?: string;
}
const geocode = async (place: string, signal?: AbortSignal): Promise<GeoHit | null> => {
  const data = await fetchJson<{ results?: GeoHit[] }>(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`,
    { signal }
  );
  return data.results?.[0] || null;
};

// --- REST Countries -------------------------------------------------------------
export interface Country {
  name?: { common?: string; official?: string };
  capital?: string[];
  population?: number;
  region?: string;
  subregion?: string;
  languages?: Record<string, string>;
  currencies?: Record<string, { name?: string; symbol?: string }>;
  flags?: { png?: string; svg?: string };
  area?: number;
  timezones?: string[];
  cca2?: string;
}

/** ISO 3166-1 alpha-2 → flag emoji via regional indicator symbols. Pure. */
export const flagEmoji = (cca2?: string): string => {
  const code = (cca2 || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
};

/** Map a REST Countries record to a KPI metric board (flag emoji in the title). Pure. */
export const countryToMetrics = (c: Country): MetricBoardArtifact => {
  const tiles: MetricTile[] = [];
  if (typeof c.population === 'number') tiles.push({ label: 'Population', value: c.population });
  if (typeof c.area === 'number') tiles.push({ label: 'Area', value: c.area, unit: 'km²' });
  tiles.push({ label: 'Capital', value: c.capital?.join(', ') || '—' });
  tiles.push({ label: 'Region', value: c.subregion || c.region || '—' });
  const currencies = c.currencies ? Object.entries(c.currencies) : [];
  if (currencies.length) {
    // Glanceable code(s); full currency names stay in the model-facing text.
    const [code, v] = currencies[0];
    tiles.push(
      currencies.length === 1
        ? { label: 'Currency', value: code, unit: v.symbol }
        : { label: 'Currencies', value: currencies.map(([cc]) => cc).slice(0, 3).join(', ') }
    );
  }
  const langs = c.languages ? Object.values(c.languages) : [];
  if (langs.length) {
    tiles.push(
      langs.length <= 2
        ? { label: 'Languages', value: langs.join(', ') }
        : { label: 'Languages', value: langs.length, unit: `incl. ${langs[0]}` }
    );
  }
  if (c.timezones?.length) {
    tiles.push(
      c.timezones.length === 1
        ? { label: 'Timezone', value: c.timezones[0] }
        : { label: 'Timezones', value: c.timezones.length, unit: 'zones' }
    );
  }
  const flag = flagEmoji(c.cca2);
  return { title: `${flag ? `${flag} ` : ''}${c.name?.common || 'Country'}`, columns: 3, tiles };
};

export const countryInfoTool: ChatTool = {
  name: 'country_info',
  description:
    'Get facts about a country: capital, population, region, official languages, currencies, area, timezones and flag. Use whenever the user asks about a country or compares countries.',
  parameters: {
    type: 'object',
    properties: { country: { type: 'string', description: 'Country name or code, e.g. "Japan", "Brazil", "DE".' } },
    required: ['country']
  },
  execute: async (args, signal) => {
    const country = String(args?.country || '').trim();
    if (!country) return { content: 'No country was provided.' };
    try {
      const data = await fetchJson<Country[]>(
        `https://restcountries.com/v3.1/name/${encodeURIComponent(country)}?fields=name,capital,population,region,subregion,languages,currencies,flags,area,timezones,cca2`,
        { signal }
      );
      const c = Array.isArray(data) ? data[0] : undefined;
      if (!c?.name?.common) return { content: `No country found matching "${country}".` };
      const langs = c.languages ? Object.values(c.languages).join(', ') : '—';
      const curr = c.currencies
        ? Object.entries(c.currencies).map(([code, v]) => `${v.name || code} (${v.symbol || code})`).join(', ')
        : '—';
      const content =
        `${c.name.common}${c.name.official && c.name.official !== c.name.common ? ` (${c.name.official})` : ''}\n` +
        `• Capital: ${c.capital?.join(', ') || '—'}\n` +
        `• Population: ${c.population?.toLocaleString() || '—'}\n` +
        `• Region: ${c.subregion || c.region || '—'}\n` +
        `• Languages: ${langs}\n` +
        `• Currency: ${curr}\n` +
        `• Area: ${c.area ? `${c.area.toLocaleString()} km²` : '—'}\n` +
        `• Timezones: ${c.timezones?.slice(0, 4).join(', ') || '—'}`;
      const flag = c.flags?.png;
      return {
        content: `${content}\n(A country fact board is shown to the user — don't repeat the numbers.)`,
        ...(flag ? { images: [{ url: flag, title: `Flag of ${c.name.common}`, source: 'REST Countries' }] } : {}),
        artifacts: [{ type: 'metric_board', data: countryToMetrics(c) }]
      };
    } catch (err) {
      return { content: `Country lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- IP / domain geolocation (IPinfo Lite → ip-api.com) ---------------------------
// IPinfo Lite (free token, unlimited, commercial use allowed with attribution) is the
// primary when IPINFO_TOKEN is set — country/network-level only. The keyless
// ip-api.com endpoint is licensed for NON-commercial use only, so it serves purely as
// the dev/unconfigured fallback and says so honestly in the notice.
export const ipLookupTool: ChatTool = {
  name: 'ip_lookup',
  description:
    'Geolocate an IP address or domain — country, network/ISP and (when available) region, city and coordinates. Use for "where is this IP/server", network diagnostics, or locating a hostname.',
  parameters: {
    type: 'object',
    properties: { ip: { type: 'string', description: 'An IPv4/IPv6 address or a domain name, e.g. "8.8.8.8" or "github.com".' } },
    required: ['ip']
  },
  execute: async (args, signal) => {
    const ip = String(args?.ip || '').trim();
    if (!ip) return { content: 'No IP address or domain was provided.' };
    const token = process.env.IPINFO_TOKEN;
    if (token) {
      try {
        const d = await fetchJson<Record<string, unknown>>(
          `https://api.ipinfo.io/lite/${encodeURIComponent(ip)}?token=${encodeURIComponent(token)}`,
          { signal }
        );
        const content =
          `${d.ip || ip}\n` +
          `• Country: ${[d.country, d.country_code ? `(${d.country_code})` : ''].filter(Boolean).join(' ') || '—'}\n` +
          `• Continent: ${d.continent || '—'}\n` +
          `• Network: ${[d.asn, d.as_name].filter(Boolean).join(' — ') || '—'}\n` +
          `• Operator domain: ${d.as_domain || '—'}\n` +
          `(Country/network-level via IPinfo Lite.)`;
        return { content, citations: [{ url: 'https://ipinfo.io', title: 'IP data by IPinfo' }] };
      } catch {
        /* fall through to the keyless fallback */
      }
    }
    try {
      const d = await fetchJson<Record<string, unknown>>(
        `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,regionName,city,zip,lat,lon,timezone,isp,org,as,query`,
        { signal }
      );
      if (d.status !== 'success') return { content: `Could not locate "${ip}": ${d.message || 'not found'}.` };
      const content =
        `${d.query || ip}\n` +
        `• Location: ${[d.city, d.regionName, d.country].filter(Boolean).join(', ') || '—'}\n` +
        `• Coordinates: ${d.lat}, ${d.lon}\n` +
        `• Timezone: ${d.timezone || '—'}\n` +
        `• ISP / Org: ${[d.isp, d.org].filter(Boolean).join(' / ') || '—'}\n` +
        `• Network: ${d.as || '—'}`;
      return {
        content,
        notice: token
          ? undefined
          : {
              level: 'info',
              message: 'Served by ip-api.com (free tier is licensed for non-commercial use only).',
              fix: 'Set IPINFO_TOKEN (free IPinfo Lite, commercial-OK with attribution) for a compliant primary source'
            }
      };
    } catch (err) {
      return { content: `IP lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- Public holidays (Nager.Date) -----------------------------------------------

/** Weekday name (UTC) for an ISO yyyy-mm-dd date. Pure. */
export const weekdayUtc = (isoDate: string): string => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
};

/** Map Nager.Date holidays to a sortable data table (date, holiday, weekday). Pure. */
export const holidaysToTable = (
  country: string,
  year: number,
  holidays: { date: string; localName: string; name: string }[]
): DataTableArtifact => ({
  title: `Public holidays — ${country} ${year}`,
  columns: [{ label: 'Date' }, { label: 'Holiday' }, { label: 'Weekday' }],
  rows: holidays.map((h) => [
    h.date,
    { value: h.name, sub: h.localName && h.localName !== h.name ? h.localName : undefined },
    weekdayUtc(h.date)
  ]),
  caption: 'Source: Nager.Date'
});

export const publicHolidaysTool: ChatTool = {
  name: 'public_holidays',
  description:
    'List the public/national holidays for a country and year (via Nager.Date). Use for "holidays in X", "is Y a holiday", "next holiday in country Z", or trip/leave planning.',
  parameters: {
    type: 'object',
    properties: {
      country: { type: 'string', description: '2-letter ISO country code, e.g. "US", "GB", "DE", "IN".' },
      year: { type: 'number', description: 'Calendar year (default current year).' }
    },
    required: ['country']
  },
  execute: async (args, signal) => {
    const country = String(args?.country || '').trim().toUpperCase().slice(0, 2);
    const year = typeof args?.year === 'number' && args.year > 1900 ? Math.floor(args.year) : new Date().getUTCFullYear();
    if (!/^[A-Z]{2}$/.test(country)) return { content: 'Provide a 2-letter country code, e.g. "US" or "GB".' };
    try {
      const data = await fetchJson<{ date: string; localName: string; name: string }[]>(
        `https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`,
        { signal }
      );
      if (!Array.isArray(data) || !data.length) return { content: `No public holidays found for ${country} in ${year}.` };
      const content = `Public holidays in ${country} for ${year}:\n${data
        .map((h) => `• ${h.date} — ${h.name}${h.localName && h.localName !== h.name ? ` (${h.localName})` : ''}`)
        .join('\n')}\n(A holiday table is shown to the user — don't repeat the list.)`;
      return { content, artifacts: [{ type: 'data_table', data: holidaysToTable(country, year, data) }] };
    } catch (err) {
      const msg = (err as Error)?.message || 'unknown error';
      return { content: msg.includes('404') ? `${country} is not a supported country code for holidays.` : `Holiday lookup failed: ${msg}.` };
    }
  }
};

// --- Sunrise / sunset (sunrise-sunset.org) --------------------------------------

/** "HH:MM" (UTC) for an ISO timestamp, or "—". Pure. */
const utcClock = (iso?: string): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

/** Map sunrise-sunset.org results to a sun-times metric board. Pure. */
export const sunTimesToMetrics = (place: string, r: Record<string, string>): MetricBoardArtifact => {
  const daySec = Number(r.day_length);
  const dayLen =
    Number.isFinite(daySec) && daySec > 0 ? `${Math.floor(daySec / 3600)}h ${Math.round((daySec % 3600) / 60)}m` : '—';
  return {
    title: `Sun times — ${place}`,
    columns: 2,
    tiles: [
      { label: 'Sunrise', value: utcClock(r.sunrise), unit: 'UTC' },
      { label: 'Sunset', value: utcClock(r.sunset), unit: 'UTC' },
      { label: 'Solar noon', value: utcClock(r.solar_noon), unit: 'UTC' },
      { label: 'Day length', value: dayLen }
    ]
  };
};

export const sunTimesTool: ChatTool = {
  name: 'sun_times',
  description:
    'Get sunrise, sunset, solar noon and day length for a place (geocoded, in UTC). Use for "what time is sunset in X", golden hour, daylight planning, or photography timing.',
  parameters: {
    type: 'object',
    properties: { location: { type: 'string', description: 'A city or place name, e.g. "Reykjavik" or "Sydney".' } },
    required: ['location']
  },
  execute: async (args, signal) => {
    const location = String(args?.location || '').trim();
    if (!location) return { content: 'No location was provided.' };
    try {
      const hit = await geocode(location, signal);
      if (!hit) return { content: `Couldn't locate "${location}".` };
      const data = await fetchJson<{ results?: Record<string, string>; status?: string }>(
        `https://api.sunrise-sunset.org/json?lat=${hit.latitude}&lng=${hit.longitude}&formatted=0`,
        { signal }
      );
      const r = data.results;
      if (!r || data.status !== 'OK') return { content: `No sun times available for ${hit.name}.` };
      const fmt = (iso?: string) => (iso ? new Date(iso).toUTCString().replace(' GMT', ' UTC') : '—');
      const place = `${hit.name}${hit.country ? `, ${hit.country}` : ''}`;
      const content =
        `Sun times for ${place} (UTC):\n` +
        `• Sunrise: ${fmt(r.sunrise)}\n` +
        `• Sunset: ${fmt(r.sunset)}\n` +
        `• Solar noon: ${fmt(r.solar_noon)}\n` +
        `• Day length: ${r.day_length ? `${Math.round(Number(r.day_length) / 60)} min` : '—'}` +
        (hit.timezone ? `\n(Local timezone: ${hit.timezone})` : '') +
        '\n(A sun-times board is shown to the user — don\'t repeat the times.)';
      return { content, artifacts: [{ type: 'metric_board', data: sunTimesToMetrics(place, r) }] };
    } catch (err) {
      return { content: `Sun times lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- World time (computed locally via Intl + geocoded IANA timezone) ------------
// We resolve the place to an IANA timezone with the keyless Open-Meteo geocoder,
// then format "now" in that zone with Intl — no flaky time API, always current.
const offsetForZone = (tz: string, at: Date): string => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(at);
    const tzName = parts.find((p) => p.type === 'timeZoneName')?.value || '';
    return tzName.replace('GMT', 'UTC');
  } catch {
    return '';
  }
};

export const worldTimeTool: ChatTool = {
  name: 'world_time',
  description:
    'Get the current local date/time and UTC offset for a place or IANA timezone. Use for "what time is it in X", scheduling across timezones, or time-difference questions.',
  parameters: {
    type: 'object',
    properties: { location: { type: 'string', description: 'A city/place ("Tokyo") or IANA timezone ("Europe/Paris").' } },
    required: ['location']
  },
  execute: async (args, signal) => {
    const input = String(args?.location || '').trim();
    if (!input) return { content: 'No location was provided.' };
    try {
      let tz = input.includes('/') ? input : '';
      let label = input;
      if (!tz) {
        const hit = await geocode(input, signal);
        if (!hit?.timezone) return { content: `Couldn't determine a timezone for "${input}".` };
        tz = hit.timezone;
        label = `${hit.name}${hit.country ? `, ${hit.country}` : ''}`;
      }
      const now = new Date();
      let formatted: string;
      try {
        formatted = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          weekday: 'short',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        }).format(now);
      } catch {
        return { content: `"${input}" is not a recognized place or timezone.` };
      }
      const offset = offsetForZone(tz, now);
      // The world_clocks card ticks live client-side — a clean fit for one resolved zone.
      const clocks: WorldClocksArtifact = { title: `Time in ${label}`, zones: [{ label, tz }] };
      return {
        content: `Current time in ${label} (${tz}): ${formatted}${offset ? ` (${offset})` : ''}\n(A live ticking clock card is shown to the user.)`,
        artifacts: [{ type: 'world_clocks', data: clocks }]
      };
    } catch (err) {
      return { content: `World time lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- Postal / ZIP codes (Zippopotam) --------------------------------------------

// A blank/garbage coordinate string must become null, not 0 (Number('') === 0).
const coordOrNull = (v?: string): number | null => {
  const s = (v || '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Map Zippopotam places to a data table (place, region, coordinates). Pure. */
export const zipPlacesToTable = (
  postcode: string,
  country: string,
  places: Record<string, string>[]
): DataTableArtifact => ({
  title: `${postcode} — ${country}`,
  columns: [
    { label: 'Place' },
    { label: 'State / region' },
    { label: 'Latitude', kind: 'number', align: 'right' },
    { label: 'Longitude', kind: 'number', align: 'right' }
  ],
  rows: places.map((p) => [p['place name'] || '—', p.state || '—', coordOrNull(p.latitude), coordOrNull(p.longitude)]),
  caption: 'Source: Zippopotam'
});

export const zipLookupTool: ChatTool = {
  name: 'zip_lookup',
  description:
    'Look up the place(s), state/region and coordinates for a postal/ZIP code (via Zippopotam). Use for "what city is ZIP X", validating addresses, or resolving a postcode to a location.',
  parameters: {
    type: 'object',
    properties: {
      zip: { type: 'string', description: 'The postal/ZIP code, e.g. "90210" or "SW1A".' },
      country: { type: 'string', description: '2-letter country code (default "US"), e.g. "US", "GB", "DE".' }
    },
    required: ['zip']
  },
  execute: async (args, signal) => {
    const zip = String(args?.zip || '').trim();
    const country = (String(args?.country || 'us').trim().toLowerCase() || 'us').slice(0, 2);
    if (!zip) return { content: 'No postal/ZIP code was provided.' };
    try {
      const d = await fetchJson<{ 'post code'?: string; country?: string; places?: Record<string, string>[] }>(
        `https://api.zippopotam.us/${country}/${encodeURIComponent(zip)}`,
        { signal }
      );
      const places = d.places || [];
      if (!places.length) return { content: `No location found for ${zip} (${country.toUpperCase()}).` };
      const shown = places.slice(0, 5);
      const content = `${d['post code'] || zip}, ${d.country || country.toUpperCase()}:\n${shown
        .map((p) => `• ${p['place name']}${p.state ? `, ${p.state}` : ''} (${p.latitude}, ${p.longitude})`)
        .join('\n')}\n(A place table is shown to the user.)`;
      return {
        content,
        artifacts: [
          { type: 'data_table', data: zipPlacesToTable(d['post code'] || zip, d.country || country.toUpperCase(), shown) }
        ]
      };
    } catch (err) {
      const msg = (err as Error)?.message || 'unknown error';
      return { content: msg.includes('404') ? `No location found for ${zip} (${country.toUpperCase()}).` : `ZIP lookup failed: ${msg}.` };
    }
  }
};

// --- Universities (Hipolabs) ----------------------------------------------------

/** Map Hipolabs universities to a linked data table. Pure. */
export const universitiesToTable = (
  unis: { name: string; country: string; web_pages?: string[] }[],
  opts: { name?: string; country?: string; total?: number } = {}
): DataTableArtifact => ({
  title: 'Universities',
  subtitle:
    [opts.name ? `matching "${opts.name}"` : '', opts.country ? `in ${opts.country}` : ''].filter(Boolean).join(' ') ||
    undefined,
  columns: [{ label: 'University' }, { label: 'Country' }],
  rows: unis.map((u) => [{ value: u.name, href: u.web_pages?.[0] }, u.country]),
  caption:
    opts.total && opts.total > unis.length
      ? `Showing ${unis.length} of ${opts.total} matches · Source: Hipolabs`
      : 'Source: Hipolabs'
});

export const findUniversityTool: ChatTool = {
  name: 'find_university',
  description:
    'Search for universities/colleges by name and/or country, returning their official websites (via Hipolabs). Use for "universities in X", finding a college\'s website, or higher-education research.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'University name or keyword (optional if country given).' },
      country: { type: 'string', description: 'Country name, e.g. "United States", "Canada", "Germany" (optional).' }
    }
  },
  execute: async (args, signal) => {
    const name = String(args?.name || '').trim();
    const country = String(args?.country || '').trim();
    if (!name && !country) return { content: 'Provide a university name and/or a country.' };
    try {
      const params = [name ? `name=${encodeURIComponent(name)}` : '', country ? `country=${encodeURIComponent(country)}` : '']
        .filter(Boolean)
        .join('&');
      const data = await fetchJson<{ name: string; country: string; web_pages?: string[] }[]>(
        `http://universities.hipolabs.com/search?${params}`,
        { signal }
      );
      if (!Array.isArray(data) || !data.length) return { content: `No universities found for "${name || country}".` };
      const top = data.slice(0, 10);
      const content = `Universities${name ? ` matching "${name}"` : ''}${country ? ` in ${country}` : ''}:\n${top
        .map((u) => `• ${u.name}${u.web_pages?.[0] ? ` — ${u.web_pages[0]}` : ''} (${u.country})`)
        .join('\n')}${data.length > top.length ? `\n…and ${data.length - top.length} more.` : ''}\n(A linked table is shown to the user — don't repeat the list.)`;
      const citations = top.filter((u) => u.web_pages?.[0]).map((u) => ({ url: u.web_pages![0], title: u.name }));
      return {
        content,
        ...(citations.length ? { citations } : {}),
        artifacts: [{ type: 'data_table', data: universitiesToTable(top, { name, country, total: data.length }) }]
      };
    } catch (err) {
      return { content: `University search failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

export const GEO_TOOLS: ChatTool[] = [
  countryInfoTool,
  ipLookupTool,
  publicHolidaysTool,
  sunTimesTool,
  worldTimeTool,
  zipLookupTool,
  findUniversityTool
];
