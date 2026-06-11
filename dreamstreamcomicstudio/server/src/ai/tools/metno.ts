// Weather via MET Norway Locationforecast 2.0 — free, global, and licensed for
// commercial use (NLOD/CC BY 4.0, attribution required). This is the PRIMARY
// weather source for the commercial product: Open-Meteo's free API is
// non-commercial-only, so it serves only as a resilience fallback (or as the
// primary when a paid key / self-hosted instance is configured — see weather.ts).
//
// TOS requirements honored here (https://api.met.no/doc/TermsOfService):
//   - identifying User-Agent with contact info (override via MET_USER_AGENT)
//   - coordinates truncated to max 4 decimals
//   - attribution: callers surface "Weather data by MET Norway" (weather.ts).

import type { WeatherArtifact, WeatherDaily, WeatherHourly } from '../../../../apiTypes.js';

const MET_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';

const metUserAgent = (): string =>
  process.env.MET_USER_AGENT || 'DreamStreamComicStudio/1.0 (+https://dreamstreamstudio.ai; support@dreamstreamstudio.ai)';

// MET symbol_code (suffix stripped) → nearest WMO interpretation code, so the
// existing WeatherCard icon/description pipeline works unchanged.
const SYMBOL_TO_WMO: Record<string, number> = {
  clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3, fog: 45,
  lightrain: 61, rain: 63, heavyrain: 65,
  lightrainshowers: 80, rainshowers: 81, heavyrainshowers: 82,
  lightsleet: 66, sleet: 66, heavysleet: 67,
  lightsleetshowers: 66, sleetshowers: 66, heavysleetshowers: 67,
  lightsnow: 71, snow: 73, heavysnow: 75,
  lightsnowshowers: 85, snowshowers: 85, heavysnowshowers: 86
};

/** Map a MET Norway symbol_code (e.g. "lightrainshowers_day") to a WMO code. */
export const metnoSymbolToWmo = (symbolCode: string): number => {
  const base = symbolCode.split('_')[0].toLowerCase();
  if (base.includes('thunder')) return 95;
  if (SYMBOL_TO_WMO[base] !== undefined) return SYMBOL_TO_WMO[base];
  // Unknown compound (new codes appear occasionally) — coarse keyword fallback.
  if (base.includes('snow')) return 73;
  if (base.includes('sleet')) return 66;
  if (base.includes('rain')) return 63;
  if (base.includes('cloud')) return 3;
  return 1;
};

/** Day/night from the symbol suffix, else a longitude-based local-hour estimate. */
export const metnoIsDay = (symbolCode: string | undefined, isoTime: string, lon: number): boolean => {
  if (symbolCode?.endsWith('_day')) return true;
  if (symbolCode?.endsWith('_night')) return false;
  const utcHour = new Date(isoTime).getUTCHours() + new Date(isoTime).getUTCMinutes() / 60;
  const localHour = (utcHour + lon / 15 + 24) % 24;
  return localHour >= 6 && localHour < 18;
};

interface MetEntry {
  time: string;
  data?: {
    instant?: { details?: Record<string, number> };
    next_1_hours?: { summary?: { symbol_code?: string }; details?: Record<string, number> };
    next_6_hours?: { summary?: { symbol_code?: string }; details?: Record<string, number> };
    next_12_hours?: { summary?: { symbol_code?: string }; details?: Record<string, number> };
  };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const kph = (ms?: number): number | undefined => (ms === undefined ? undefined : Math.round(ms * 3.6 * 10) / 10);

const entrySymbol = (e: MetEntry): string | undefined =>
  e.data?.next_1_hours?.summary?.symbol_code || e.data?.next_6_hours?.summary?.symbol_code || e.data?.next_12_hours?.summary?.symbol_code;

const entryPrecipProb = (e: MetEntry): number | undefined =>
  num(e.data?.next_1_hours?.details?.probability_of_precipitation) ??
  num(e.data?.next_6_hours?.details?.probability_of_precipitation);

/** Aggregate the MET timeseries into the 7-day strip the WeatherCard renders. */
export const aggregateMetnoDaily = (series: MetEntry[], describe: (code: number) => string): WeatherDaily[] => {
  const byDate = new Map<string, MetEntry[]>();
  for (const e of series) {
    const date = e.time.slice(0, 10);
    const arr = byDate.get(date) || [];
    arr.push(e);
    byDate.set(date, arr);
  }
  const days: WeatherDaily[] = [];
  for (const [date, entries] of byDate) {
    const temps = entries.map((e) => num(e.data?.instant?.details?.air_temperature)).filter((t): t is number => t !== undefined);
    if (!temps.length) continue;
    // Representative symbol: the entry closest to midday that carries a summary.
    const withSymbol = entries.filter((e) => entrySymbol(e));
    const midday = withSymbol.sort(
      (a, b) => Math.abs(new Date(a.time).getUTCHours() - 12) - Math.abs(new Date(b.time).getUTCHours() - 12)
    )[0];
    const code = midday ? metnoSymbolToWmo(entrySymbol(midday)!) : 3;
    const probs = entries.map(entryPrecipProb).filter((p): p is number => p !== undefined);
    const uvs = entries
      .map((e) => num(e.data?.instant?.details?.ultraviolet_index_clear_sky))
      .filter((u): u is number => u !== undefined);
    days.push({
      date,
      minC: Math.min(...temps),
      maxC: Math.max(...temps),
      code,
      description: describe(code),
      precipProb: probs.length ? Math.round(Math.max(...probs)) : undefined,
      uvMax: uvs.length ? Math.max(...uvs) : undefined
    });
    if (days.length >= 7) break;
  }
  return days;
};

/** Fetch a full WeatherArtifact from MET Norway for already-geocoded coordinates. */
export const getMetNoWeather = async (
  lat: number,
  lng: number,
  label: string,
  describe: (code: number) => string,
  signal?: AbortSignal
): Promise<WeatherArtifact> => {
  // TOS: max 4 decimals — also makes responses cacheable on their side.
  const la = Math.round(lat * 1e4) / 1e4;
  const lo = Math.round(lng * 1e4) / 1e4;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let series: MetEntry[];
  try {
    const res = await fetch(`${MET_URL}?lat=${la}&lon=${lo}`, {
      headers: { Accept: 'application/json', 'User-Agent': metUserAgent() },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`MET Norway request failed (${res.status})`);
    const data = (await res.json()) as { properties?: { timeseries?: MetEntry[] } };
    series = data.properties?.timeseries || [];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  if (!series.length) throw new Error('MET Norway returned no forecast data');

  const nowEntry = series[0];
  const d = nowEntry.data?.instant?.details || {};
  const symbol = entrySymbol(nowEntry);
  const code = symbol ? metnoSymbolToWmo(symbol) : 3;
  const tempC = num(d.air_temperature) ?? 0;

  const hourly: WeatherHourly[] = series
    .filter((e) => e.data?.next_1_hours)
    .slice(0, 24)
    .map((e) => {
      const sym = entrySymbol(e);
      return {
        time: e.time,
        tempC: num(e.data?.instant?.details?.air_temperature) ?? 0,
        code: sym ? metnoSymbolToWmo(sym) : 3,
        precipProb: entryPrecipProb(e),
        isDay: metnoIsDay(sym, e.time, lo)
      };
    });

  return {
    location: label,
    coords: { lat, lng },
    current: {
      tempC,
      tempF: Math.round((tempC * 9) / 5 + 32),
      feelsLikeC: undefined, // MET exposes no apparent temperature
      code,
      description: describe(code),
      windKph: kph(num(d.wind_speed)) ?? 0,
      windDir: num(d.wind_from_direction),
      windGustKph: kph(num(d.wind_speed_of_gust)),
      humidity: num(d.relative_humidity),
      uvIndex: num(d.ultraviolet_index_clear_sky),
      precipProb: entryPrecipProb(nowEntry),
      pressureHpa: num(d.air_pressure_at_sea_level),
      dewPointC: num(d.dew_point_temperature),
      cloudCover: num(d.cloud_area_fraction),
      isDay: metnoIsDay(symbol, nowEntry.time, lo)
    },
    hourly,
    daily: aggregateMetnoDaily(series, describe)
  };
};
