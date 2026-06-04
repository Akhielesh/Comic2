// Geography & reference tools — countries, IP geolocation, public holidays,
// sunrise/sunset, world time, postal codes and universities. All free & keyless.

import type { ChatTool } from './types.js';
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
interface Country {
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
      return { content, ...(flag ? { images: [{ url: flag, title: `Flag of ${c.name.common}`, source: 'REST Countries' }] } : {}) };
    } catch (err) {
      return { content: `Country lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- IP / domain geolocation (ip-api.com) ---------------------------------------
export const ipLookupTool: ChatTool = {
  name: 'ip_lookup',
  description:
    'Geolocate an IP address or domain — country, region, city, ISP/organization and coordinates (via ip-api.com). Use for "where is this IP/server", network diagnostics, or locating a hostname.',
  parameters: {
    type: 'object',
    properties: { ip: { type: 'string', description: 'An IPv4/IPv6 address or a domain name, e.g. "8.8.8.8" or "github.com".' } },
    required: ['ip']
  },
  execute: async (args, signal) => {
    const ip = String(args?.ip || '').trim();
    if (!ip) return { content: 'No IP address or domain was provided.' };
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
      return { content };
    } catch (err) {
      return { content: `IP lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- Public holidays (Nager.Date) -----------------------------------------------
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
        .join('\n')}`;
      return { content };
    } catch (err) {
      const msg = (err as Error)?.message || 'unknown error';
      return { content: msg.includes('404') ? `${country} is not a supported country code for holidays.` : `Holiday lookup failed: ${msg}.` };
    }
  }
};

// --- Sunrise / sunset (sunrise-sunset.org) --------------------------------------
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
      const content =
        `Sun times for ${hit.name}${hit.country ? `, ${hit.country}` : ''} (UTC):\n` +
        `• Sunrise: ${fmt(r.sunrise)}\n` +
        `• Sunset: ${fmt(r.sunset)}\n` +
        `• Solar noon: ${fmt(r.solar_noon)}\n` +
        `• Day length: ${r.day_length ? `${Math.round(Number(r.day_length) / 60)} min` : '—'}` +
        (hit.timezone ? `\n(Local timezone: ${hit.timezone})` : '');
      return { content };
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
      return { content: `Current time in ${label} (${tz}): ${formatted}${offset ? ` (${offset})` : ''}` };
    } catch (err) {
      return { content: `World time lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// --- Postal / ZIP codes (Zippopotam) --------------------------------------------
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
      const content = `${d['post code'] || zip}, ${d.country || country.toUpperCase()}:\n${places
        .slice(0, 5)
        .map((p) => `• ${p['place name']}${p.state ? `, ${p.state}` : ''} (${p.latitude}, ${p.longitude})`)
        .join('\n')}`;
      return { content };
    } catch (err) {
      const msg = (err as Error)?.message || 'unknown error';
      return { content: msg.includes('404') ? `No location found for ${zip} (${country.toUpperCase()}).` : `ZIP lookup failed: ${msg}.` };
    }
  }
};

// --- Universities (Hipolabs) ----------------------------------------------------
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
        .join('\n')}${data.length > top.length ? `\n…and ${data.length - top.length} more.` : ''}`;
      const citations = top.filter((u) => u.web_pages?.[0]).map((u) => ({ url: u.web_pages![0], title: u.name }));
      return { content, ...(citations.length ? { citations } : {}) };
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
