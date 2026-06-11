// Weather provider chain — commercial-compliance aware.
//
// MET Norway (free, global, commercial use allowed, CC BY 4.0 attribution) is the
// default PRIMARY source. Open-Meteo's free API is non-commercial-only, so it runs
// as primary ONLY when legally configured — a paid customer key (OPEN_METEO_API_KEY)
// or a self-hosted AGPL instance (OPEN_METEO_BASE_URL) — and otherwise serves as a
// last-resort uptime fallback. Air quality + pollen come from Open-Meteo's CAMS API
// and are attached only when the Open-Meteo path is in play.
//
// Geocoding: OSM Nominatim first (fair-use, commercial OK), Open-Meteo geocoder as
// fallback. Returns a structured WeatherArtifact the client renders as a rich card.

import type {
  WeatherArtifact,
  WeatherDaily,
  WeatherHourly,
  WeatherAirQuality,
  WeatherPollen
} from '../../../../apiTypes.js';
import { getMetNoWeather } from './metno.js';
import { TtlCache } from '../../lib/cache.js';
import { assertProviderBudget, noteProviderCall } from '../../lib/providerUsage.js';

const OM_BASE = (): string => (process.env.OPEN_METEO_BASE_URL || '').replace(/\/$/, '');
const OM_KEY = (): string => process.env.OPEN_METEO_API_KEY || '';
/** Open-Meteo is commercially usable only with a paid key or a self-hosted instance. */
export const openMeteoConfigured = (): boolean => Boolean(OM_BASE() || OM_KEY());

const omUrl = (path: 'forecast' | 'air-quality', params: URLSearchParams): string => {
  if (OM_KEY()) params.set('apikey', OM_KEY());
  const base = OM_BASE();
  if (base) return `${base}/v1/${path}?${params}`; // self-hosted (forecast only, typically)
  const host = path === 'air-quality' ? 'air-quality-api.open-meteo.com' : 'api.open-meteo.com';
  const sub = OM_KEY() ? `customer-${host}` : host;
  return `https://${sub}/v1/${path}?${params}`;
};

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = process.env.MET_USER_AGENT || 'DreamStreamComicStudio/1.0 (+https://dreamstreamstudio.ai; support@dreamstreamstudio.ai)';

// WMO weather interpretation codes → human descriptions.
const WMO: Record<number, string> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle',
  56: 'Light freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Light freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Violent showers',
  85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail'
};

export const describeWeatherCode = (code: number): string => WMO[code] || 'Unknown';

// US AQI → human band (EPA breakpoints).
export const aqiCategory = (usAqi?: number): string | undefined => {
  if (typeof usAqi !== 'number') return undefined;
  if (usAqi <= 50) return 'Good';
  if (usAqi <= 100) return 'Moderate';
  if (usAqi <= 150) return 'Unhealthy (sensitive)';
  if (usAqi <= 200) return 'Unhealthy';
  if (usAqi <= 300) return 'Very unhealthy';
  return 'Hazardous';
};

// Aggregate pollen grains/m³ → an overall band (CAMS-style thresholds).
export const pollenLevel = (max?: number): string | undefined => {
  if (typeof max !== 'number') return undefined;
  if (max <= 0) return 'None';
  if (max < 20) return 'Low';
  if (max < 100) return 'Moderate';
  if (max < 300) return 'High';
  return 'Very high';
};

const fetchJson = async <T>(url: string, signal?: AbortSignal): Promise<T> => {
  assertProviderBudget(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let noted = false; // meter exactly once per attempt, whether it resolves or rejects
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: controller.signal });
    noted = true;
    noteProviderCall(url, res.ok);
    if (!res.ok) throw new Error(`Weather request failed (${res.status})`);
    return (await res.json()) as T;
  } catch (err) {
    if (!noted) noteProviderCall(url, false);
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// Pick the 24 hourly entries starting at/after "now" so the strip is forward-looking.
const sliceHourly = (hourly: any): WeatherHourly[] => {
  const times: string[] = hourly?.time || [];
  if (!times.length) return [];
  const now = Date.now();
  let start = times.findIndex((t) => new Date(t).getTime() >= now - 60 * 60 * 1000);
  if (start < 0) start = 0;
  return times.slice(start, start + 24).map((time, i) => {
    const idx = start + i;
    return {
      time,
      tempC: Number(hourly.temperature_2m?.[idx] ?? 0),
      code: Number(hourly.weather_code?.[idx] ?? 0),
      precipProb: num(hourly.precipitation_probability?.[idx]),
      isDay: hourly.is_day ? Number(hourly.is_day[idx]) === 1 : undefined
    };
  });
};

// Best-effort air quality + pollen (Open-Meteo CAMS). Never throws — returns
// undefined on any failure.
const fetchAirQuality = async (
  lat: number,
  lng: number,
  signal?: AbortSignal
): Promise<{ airQuality?: WeatherAirQuality; pollen?: WeatherPollen }> => {
  try {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lng),
      current: 'us_aqi,european_aqi,pm2_5',
      hourly: 'grass_pollen,birch_pollen,alder_pollen,ragweed_pollen,mugwort_pollen,olive_pollen',
      forecast_days: '1',
      timezone: 'auto'
    });
    const data = await fetchJson<any>(omUrl('air-quality', params), signal);
    const cur = data.current || {};
    const usAqi = num(cur.us_aqi);
    const airQuality: WeatherAirQuality = {
      usAqi,
      euAqi: num(cur.european_aqi),
      pm25: num(cur.pm2_5),
      category: aqiCategory(usAqi)
    };
    // First forecast hour as the representative pollen reading.
    const h = data.hourly || {};
    const tree = Math.max(num(h.birch_pollen?.[0]) ?? 0, num(h.alder_pollen?.[0]) ?? 0, num(h.olive_pollen?.[0]) ?? 0);
    const weed = Math.max(num(h.ragweed_pollen?.[0]) ?? 0, num(h.mugwort_pollen?.[0]) ?? 0);
    const grass = num(h.grass_pollen?.[0]) ?? 0;
    const overall = Math.max(tree, weed, grass);
    const pollen: WeatherPollen | undefined =
      h.grass_pollen || h.birch_pollen
        ? { grass, tree, weed, level: pollenLevel(overall) }
        : undefined;
    const hasAir = airQuality.usAqi !== undefined || airQuality.euAqi !== undefined || airQuality.pm25 !== undefined;
    return { airQuality: hasAir ? airQuality : undefined, pollen };
  } catch {
    return {};
  }
};

interface GeoHit {
  latitude: number;
  longitude: number;
  label: string;
}

// Nominatim (OSM) — commercial-OK under fair use; descriptive UA required.
const nominatimGeocode = async (place: string, signal?: AbortSignal): Promise<GeoHit | null> => {
  try {
    const rows = await fetchJson<any[]>(
      `${NOMINATIM}?q=${encodeURIComponent(place)}&format=json&limit=1&addressdetails=0&accept-language=en`,
      signal
    );
    const hit = Array.isArray(rows) ? rows[0] : null;
    const lat = Number(hit?.lat);
    const lon = Number(hit?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    // display_name is verbose ("City, County, State, Zip, Country") — keep it short.
    const parts = String(hit.display_name || place).split(',').map((s: string) => s.trim());
    const label = parts.length > 2 ? [parts[0], parts[1], parts[parts.length - 1]].join(', ') : parts.join(', ');
    return { latitude: lat, longitude: lon, label };
  } catch {
    return null;
  }
};

// Open-Meteo's geocoder wants a SIMPLE name ("Ashburn"), so a "City, Region, Country" string
// (which is exactly what the model passes from the user's location context) returns nothing.
// Try the full string, then progressively simpler forms (first two segments, then the city).
const openMeteoGeocode = async (place: string, signal?: AbortSignal): Promise<GeoHit | null> => {
  const trimmed = place.trim();
  const segs = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  const region = segs[1]?.toLowerCase(); // e.g. "virginia" — used to disambiguate same-named cities
  const variants = Array.from(
    new Set([trimmed, segs.slice(0, 2).join(', '), segs[0]].filter((v) => v && v.length > 0))
  );
  for (const v of variants) {
    const geo = await fetchJson<{ results?: any[] }>(
      `${GEO_URL}?name=${encodeURIComponent(v)}&count=5&language=en&format=json`,
      signal
    ).catch(() => ({ results: undefined as any[] | undefined }));
    const results = geo.results || [];
    if (!results.length) continue;
    // Prefer the result whose region (admin1) or country matches what the user is in, so
    // "Ashburn" picks Ashburn, VIRGINIA — not the more-populous Ashburn, Georgia.
    const pick = (r: any): GeoHit => ({
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      label: [r.name, r.admin1, r.country].filter(Boolean).join(', ')
    });
    if (region) {
      const match = results.find((r) => {
        const a1 = String(r.admin1 || '').toLowerCase();
        const cc = String(r.country_code || '').toLowerCase();
        return a1 === region || a1.includes(region) || region.includes(a1) || cc === region;
      });
      if (match) return pick(match);
    }
    return pick(results[0]);
  }
  return null;
};

const geocodePlace = async (place: string, signal?: AbortSignal): Promise<GeoHit | null> =>
  (await nominatimGeocode(place, signal)) || (await openMeteoGeocode(place, signal));

// Open-Meteo forecast → WeatherArtifact (used when configured, or as uptime fallback).
const getOpenMeteoWeather = async (hit: GeoHit, signal?: AbortSignal): Promise<WeatherArtifact> => {
  const params = new URLSearchParams({
    latitude: String(hit.latitude),
    longitude: String(hit.longitude),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day,precipitation_probability,uv_index,surface_pressure,dew_point_2m,visibility,cloud_cover',
    hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,uv_index_max,precipitation_probability_max,sunrise,sunset',
    forecast_days: '7',
    timezone: 'auto'
  });
  const fc = await fetchJson<any>(omUrl('forecast', params), signal);

  const c = fc.current || {};
  const tempC = Number(c.temperature_2m ?? 0);
  const feelsLikeC = num(c.apparent_temperature);
  const daily: WeatherDaily[] = (fc.daily?.time || []).map((date: string, i: number) => ({
    date,
    minC: Number(fc.daily.temperature_2m_min?.[i] ?? 0),
    maxC: Number(fc.daily.temperature_2m_max?.[i] ?? 0),
    code: Number(fc.daily.weather_code?.[i] ?? 0),
    description: describeWeatherCode(Number(fc.daily.weather_code?.[i] ?? 0)),
    uvMax: num(fc.daily.uv_index_max?.[i]),
    precipProb: num(fc.daily.precipitation_probability_max?.[i]),
    sunrise: typeof fc.daily.sunrise?.[i] === 'string' ? fc.daily.sunrise[i] : undefined,
    sunset: typeof fc.daily.sunset?.[i] === 'string' ? fc.daily.sunset[i] : undefined
  }));

  return {
    location: hit.label,
    coords: { lat: hit.latitude, lng: hit.longitude },
    current: {
      tempC,
      tempF: Math.round((tempC * 9) / 5 + 32),
      feelsLikeC,
      code: Number(c.weather_code ?? 0),
      description: describeWeatherCode(Number(c.weather_code ?? 0)),
      windKph: Number(c.wind_speed_10m ?? 0),
      windDir: num(c.wind_direction_10m),
      windGustKph: num(c.wind_gusts_10m),
      humidity: num(c.relative_humidity_2m),
      uvIndex: num(c.uv_index),
      precipProb: num(c.precipitation_probability),
      pressureHpa: num(c.surface_pressure),
      dewPointC: num(c.dew_point_2m),
      visibilityKm: typeof c.visibility === 'number' ? Math.round(c.visibility / 100) / 10 : undefined,
      cloudCover: num(c.cloud_cover),
      isDay: Number(c.is_day ?? 1) === 1
    },
    hourly: sliceHourly(fc.hourly),
    daily
  };
};

export interface WeatherSource {
  provider: 'metno' | 'open-meteo';
  /** Visible-credit line (CC BY 4.0 requires attribution for both providers). */
  attribution: string;
  url: string;
}

const SOURCES: Record<WeatherSource['provider'], WeatherSource> = {
  metno: { provider: 'metno', attribution: 'Weather data by MET Norway (CC BY 4.0)', url: 'https://www.met.no/en' },
  'open-meteo': { provider: 'open-meteo', attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)', url: 'https://open-meteo.com' }
};

// Forecasts barely change minute-to-minute: a 10-minute cache per place collapses
// repeated agent/widget calls into one upstream fetch (quota + latency win).
const weatherCache = new TtlCache<{ weather: WeatherArtifact; source: WeatherSource }>(10 * 60_000, 200);

export const getWeatherDetailed = async (
  place: string,
  signal?: AbortSignal
): Promise<{ weather: WeatherArtifact; source: WeatherSource }> => {
  // Shared (coalesced) compute — detached from the first caller's abort signal so
  // one user's cancel can't reject everyone awaiting the same place.
  void signal;
  return weatherCache.getOrSet(place.trim().toLowerCase(), () => getWeatherUncached(place, undefined));
};

const getWeatherUncached = async (
  place: string,
  signal?: AbortSignal
): Promise<{ weather: WeatherArtifact; source: WeatherSource }> => {
  const hit = await geocodePlace(place, signal);
  if (!hit) throw new Error(`Couldn't find a place called "${place}".`);

  // Configured Open-Meteo (paid key / self-host) is legally clean AND richer
  // (feels-like, visibility, sunrise/sunset, AQI) — prefer it. Otherwise MET Norway
  // is the commercial-clean default and the free Open-Meteo API is only an
  // availability fallback.
  const chain: WeatherSource['provider'][] = openMeteoConfigured() ? ['open-meteo', 'metno'] : ['metno', 'open-meteo'];
  let weather: WeatherArtifact | undefined;
  let used: WeatherSource['provider'] = chain[0];
  let lastErr: unknown;
  for (const provider of chain) {
    try {
      weather =
        provider === 'metno'
          ? await getMetNoWeather(hit.latitude, hit.longitude, hit.label, describeWeatherCode, signal)
          : await getOpenMeteoWeather(hit, signal);
      used = provider;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!weather) throw lastErr instanceof Error ? lastErr : new Error('Weather lookup failed.');

  // AQI/pollen ride on Open-Meteo's air-quality API — attach when that path is
  // already in play (configured, or because it served as the fallback).
  if (used === 'open-meteo' || openMeteoConfigured()) {
    const { airQuality, pollen } = await fetchAirQuality(hit.latitude, hit.longitude, signal);
    weather.airQuality = airQuality;
    weather.pollen = pollen;
  }
  return { weather, source: SOURCES[used] };
};

export const getWeather = async (place: string, signal?: AbortSignal): Promise<WeatherArtifact> =>
  (await getWeatherDetailed(place, signal)).weather;
