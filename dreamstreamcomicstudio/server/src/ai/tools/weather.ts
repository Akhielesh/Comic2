// Weather via Open-Meteo — free, keyless, open. Geocodes a place name then fetches
// current conditions + a short forecast. Returns a structured WeatherArtifact the
// client renders as a card (not plain text).
//
// Like the other tools, these public endpoints can't be runtime-verified in the
// build sandbox; failures degrade to a clear message.

import type { WeatherArtifact, WeatherDaily } from '../../../../apiTypes.js';

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

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
    current: 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min',
    forecast_days: '5',
    timezone: 'auto'
  });
  const fc = await fetchJson<any>(`${FORECAST_URL}?${params.toString()}`, signal);

  const c = fc.current || {};
  const tempC = Number(c.temperature_2m ?? 0);
  const daily: WeatherDaily[] = (fc.daily?.time || []).map((date: string, i: number) => ({
    date,
    minC: Number(fc.daily.temperature_2m_min?.[i] ?? 0),
    maxC: Number(fc.daily.temperature_2m_max?.[i] ?? 0),
    code: Number(fc.daily.weather_code?.[i] ?? 0),
    description: describeWeatherCode(Number(fc.daily.weather_code?.[i] ?? 0))
  }));

  return {
    location: label,
    current: {
      tempC,
      tempF: Math.round((tempC * 9) / 5 + 32),
      code: Number(c.weather_code ?? 0),
      description: describeWeatherCode(Number(c.weather_code ?? 0)),
      windKph: Number(c.wind_speed_10m ?? 0),
      humidity: typeof c.relative_humidity_2m === 'number' ? c.relative_humidity_2m : undefined,
      isDay: Number(c.is_day ?? 1) === 1
    },
    daily
  };
};
