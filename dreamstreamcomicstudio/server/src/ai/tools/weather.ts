// Weather via Open-Meteo — free, keyless, open. Geocodes a place name then fetches
// current conditions, an hourly strip (next 24h), a multi-day forecast, plus UV,
// "feels like", and air-quality/pollen from Open-Meteo's CAMS air-quality API.
// Returns a structured WeatherArtifact the client renders as a rich card.
//
// Like the other tools, these public endpoints can't be runtime-verified in the
// build sandbox; failures degrade (air quality is best-effort and never blocks the
// core forecast).

import type {
  WeatherArtifact,
  WeatherDaily,
  WeatherHourly,
  WeatherAirQuality,
  WeatherPollen
} from '../../../../apiTypes.js';

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`Weather request failed (${res.status})`);
    return (await res.json()) as T;
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

// Best-effort air quality + pollen. Never throws — returns undefined on any failure.
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
    const data = await fetchJson<any>(`${AIR_URL}?${params.toString()}`, signal);
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

export const getWeather = async (
  place: string,
  signal?: AbortSignal
): Promise<WeatherArtifact> => {
  const geo = await fetchJson<{ results?: any[] }>(
    `${GEO_URL}?name=${encodeURIComponent(place)}&count=1&language=en&format=json`,
    signal
  );
  const hit = geo.results?.[0];
  if (!hit) throw new Error(`Couldn't find a place called "${place}".`);

  const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
  const params = new URLSearchParams({
    latitude: String(hit.latitude),
    longitude: String(hit.longitude),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day,precipitation_probability,uv_index',
    hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,uv_index_max,precipitation_probability_max,sunrise,sunset',
    forecast_days: '7',
    timezone: 'auto'
  });
  const fc = await fetchJson<any>(`${FORECAST_URL}?${params.toString()}`, signal);

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

  const { airQuality, pollen } = await fetchAirQuality(Number(hit.latitude), Number(hit.longitude), signal);

  return {
    location: label,
    current: {
      tempC,
      tempF: Math.round((tempC * 9) / 5 + 32),
      feelsLikeC,
      code: Number(c.weather_code ?? 0),
      description: describeWeatherCode(Number(c.weather_code ?? 0)),
      windKph: Number(c.wind_speed_10m ?? 0),
      humidity: num(c.relative_humidity_2m),
      uvIndex: num(c.uv_index),
      precipProb: num(c.precipitation_probability),
      isDay: Number(c.is_day ?? 1) === 1
    },
    hourly: sliceHourly(fc.hourly),
    daily,
    airQuality,
    pollen
  };
};
