import React, { useEffect, useMemo, useState } from 'react';
import { Wind, Droplets, MapPin, Sun, Umbrella, Gauge, Eye, Cloud, Thermometer, Leaf, Map as MapIcon, BarChart3 } from 'lucide-react';
import type { WeatherArtifact } from '../../../apiTypes';
import { Surface, Chart, LinearGauge, SunArc, Badge, WeatherIcon, useCompact, useCountUp } from './kit';
import type { ChartPoint } from './kit';
import { prefersReducedMotion, useMeasure } from './kit/Chart';
import { InlineMap } from './InlineMap';

// Flagship weather card, in two densities:
//  • compact — a glance card: location, big temp, condition, hi/lo and the next few
//    hours in one quiet strip.
//  • detailed — the full station: animated sky hero, a gauge grid for every sensor
//    (UV, humidity, wind compass, pressure, visibility, cloud, dew, precip), an
//    hourly temperature chart, a 7-day forecast, air quality + pollen, a
//    sunrise/sunset arc, and a map view. All dependency-free SVG.
//
// The detailed layout is FLUID: the card is a flex column, so when it's given more
// height (drag-resize, the expanded lightbox) the hourly chart and the 7-day strip
// stretch to use it — no more tiny chart in a sea of empty space. The hourly chart
// is container-responsive (kit Chart + aspect), C/F switches morph the curve, and
// the day-range bars draw in with a soft stagger.

// --- helpers (shared with the legacy card's logic) ---
type Sky = 'clear' | 'cloud' | 'rain' | 'snow' | 'storm' | 'fog';
const skyOf = (code: number): Sky => {
  if (code === 0 || code === 1) return 'clear';
  if (code <= 3) return 'cloud';
  if (code <= 48) return 'fog';
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 85 && code <= 86) return 'snow';
  if (code >= 95) return 'storm';
  if (code >= 51) return 'rain';
  return 'cloud';
};

const HERO_BG: Record<Sky, { day: string; night: string }> = {
  clear: { day: 'from-sky-400 to-blue-500', night: 'from-indigo-900 to-slate-900' },
  cloud: { day: 'from-sky-300 to-slate-400', night: 'from-slate-700 to-slate-900' },
  rain: { day: 'from-slate-400 to-slate-600', night: 'from-slate-700 to-slate-900' },
  snow: { day: 'from-sky-200 to-indigo-300', night: 'from-slate-600 to-slate-800' },
  storm: { day: 'from-slate-500 to-indigo-800', night: 'from-slate-800 to-black' },
  fog: { day: 'from-slate-300 to-slate-500', night: 'from-slate-700 to-slate-900' }
};

const cToF = (c: number): number => Math.round((c * 9) / 5 + 32);
const defaultUnit = (): 'C' | 'F' => {
  try {
    const region = (navigator.language || '').split('-')[1]?.toUpperCase();
    return region && ['US', 'LR', 'MM'].includes(region) ? 'F' : 'C';
  } catch {
    return 'C';
  }
};
const uvBand = (uv: number): { label: string; color: string } => {
  if (uv < 3) return { label: 'Low', color: '#059669' };
  if (uv < 6) return { label: 'Moderate', color: '#d97706' };
  if (uv < 8) return { label: 'High', color: '#ea580c' };
  if (uv < 11) return { label: 'Very high', color: '#dc2626' };
  return { label: 'Extreme', color: '#a21caf' };
};
const aqiColor = (n: number): string =>
  n <= 50 ? '#059669' : n <= 100 ? '#d97706' : n <= 150 ? '#ea580c' : n <= 200 ? '#dc2626' : '#a21caf';
const AQI_BANDS = [
  { to: 50 / 300, color: '#059669' },
  { to: 100 / 300, color: '#d97706' },
  { to: 150 / 300, color: '#ea580c' },
  { to: 200 / 300, color: '#dc2626' },
  { to: 1, color: '#a21caf' }
];

const cardinal = (deg?: number): string => {
  if (typeof deg !== 'number') return '';
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
};
const hourLabel = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(undefined, { hour: 'numeric' });
};
const dayName = (date: string): string => {
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { weekday: 'short' });
};

// --- animated sky scene ---
const SkyScene: React.FC<{ sky: Sky; isDay: boolean }> = ({ sky, isDay }) => (
  <svg className="pointer-events-none absolute inset-0 h-full w-full opacity-90" viewBox="0 0 120 70" preserveAspectRatio="xMidYMid slice" aria-hidden>
    {sky === 'clear' && isDay && (
      <g className="wx-spin" style={{ transformOrigin: '95px 16px' }}>
        {Array.from({ length: 8 }).map((_, i) => (
          <line key={i} x1="95" y1="16" x2={95 + 13 * Math.cos((i * Math.PI) / 4)} y2={16 + 13 * Math.sin((i * Math.PI) / 4)} stroke="#fde68a" strokeWidth="1.4" strokeLinecap="round" opacity="0.8" />
        ))}
        <circle cx="95" cy="16" r="7" fill="#fde047" />
      </g>
    )}
    {sky === 'clear' && !isDay && (
      <>
        <circle cx="96" cy="15" r="7" fill="#e2e8f0" />
        <circle cx="93" cy="13" r="6" fill="#1e293b" opacity="0.001" />
        {[[20, 12], [40, 22], [70, 10], [55, 30], [30, 34]].map(([x, y], i) => (
          <circle key={i} className="wx-twinkle" style={{ animationDelay: `${i * 0.6}s` }} cx={x} cy={y} r="0.9" fill="#fff" />
        ))}
      </>
    )}
    {(sky === 'cloud' || sky === 'rain' || sky === 'storm' || sky === 'snow' || sky === 'fog') && (
      <>
        <g className="wx-drift" fill="#f8fafc" opacity={sky === 'fog' ? 0.55 : 0.92}>
          <ellipse cx="78" cy="20" rx="16" ry="8" />
          <ellipse cx="92" cy="17" rx="12" ry="7" />
          <ellipse cx="66" cy="17" rx="10" ry="6" />
        </g>
        <g className="wx-drift2" fill="#e2e8f0" opacity="0.7">
          <ellipse cx="30" cy="14" rx="12" ry="6" />
          <ellipse cx="42" cy="12" rx="9" ry="5" />
        </g>
      </>
    )}
    {sky === 'rain' &&
      Array.from({ length: 10 }).map((_, i) => (
        <line key={i} className="wx-fall" style={{ animationDelay: `${(i % 5) * 0.18}s` }} x1={58 + i * 5} y1="28" x2={56 + i * 5} y2="34" stroke="#bae6fd" strokeWidth="1.4" strokeLinecap="round" />
      ))}
    {sky === 'snow' &&
      Array.from({ length: 9 }).map((_, i) => (
        <circle key={i} className="wx-fall" style={{ animationDelay: `${(i % 5) * 0.22}s` }} cx={58 + i * 5} cy="30" r="1.3" fill="#fff" />
      ))}
    {sky === 'storm' && (
      <>
        {Array.from({ length: 8 }).map((_, i) => (
          <line key={i} className="wx-fall" style={{ animationDelay: `${(i % 4) * 0.16}s` }} x1={58 + i * 6} y1="28" x2={56 + i * 6} y2="34" stroke="#cbd5e1" strokeWidth="1.2" strokeLinecap="round" />
        ))}
        <polygon className="wx-flash" points="80,24 76,34 80,34 77,44 86,31 81,31 84,24" fill="#fde047" />
      </>
    )}
  </svg>
);

// A single sensor tile in the conditions grid. Uniform height + a fixed rhythm (label
// pinned top, value anchored bottom) so the whole grid reads as one clean, even block.
const Tile: React.FC<{ icon: React.ReactNode; label: string; children: React.ReactNode }> = ({ icon, label, children }) => (
  <div className="group/tile flex min-h-[88px] flex-col gap-1.5 rounded-xl border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] p-2.5 transition-all duration-200 hover:-translate-y-0.5 hover:border-[var(--ds-hairline)] hover:bg-[var(--ds-well-strong)] hover:shadow-[0_4px_14px_-6px_rgba(0,0,0,0.25)]">
    <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)] transition-colors duration-200 group-hover/tile:text-[var(--ds-ink)]">
      {icon}
      {label}
    </span>
    <div className="flex flex-1 flex-col justify-end">{children}</div>
  </div>
);

// The big number + unit inside a tile — one consistent treatment across every metric.
const TileValue: React.FC<{ value: React.ReactNode; unit?: string; color?: string }> = ({ value, unit, color }) => (
  <div className="flex items-baseline gap-1">
    <span className="text-2xl font-semibold leading-none tracking-tight tabular-nums" style={{ color: color ?? 'var(--ds-ink)' }}>{value}</span>
    {unit && <span className="text-[11px] font-medium text-[var(--ds-muted)]">{unit}</span>}
  </div>
);

export const WeatherStation: React.FC<{ data: WeatherArtifact }> = ({ data }) => {
  const compact = useCompact();
  const [unit, setUnit] = useState<'C' | 'F'>(defaultUnit);
  const [tab, setTab] = useState<'forecast' | 'map'>('forecast');
  const [radar, setRadar] = useState(false); // live precipitation overlay (RainViewer)
  // The map pane is measured so the (fixed-height) InlineMap can fill stretched cards.
  const [mapRef, mapSize] = useMeasure<HTMLDivElement>();
  // Day-range bars draw in (width 0 → full) with a soft stagger, re-running when the
  // forecast tab comes back. Reduced motion renders them settled immediately.
  const [barsIn, setBarsIn] = useState(false);
  useEffect(() => {
    if (tab !== 'forecast') return;
    if (prefersReducedMotion()) {
      setBarsIn(true);
      return;
    }
    setBarsIn(false);
    const raf = requestAnimationFrame(() => setBarsIn(true));
    return () => cancelAnimationFrame(raf);
  }, [tab]);

  const c = data.current;
  const sky = skyOf(c.code);
  const bg = HERO_BG[sky][c.isDay ? 'day' : 'night'];
  const t = useMemo(() => (valC: number) => (unit === 'F' ? cToF(valC) : Math.round(valC)), [unit]);
  const today = data.daily[0];
  // The headline temperature glides into place (and morphs on a °C↔°F switch).
  const heroTemp = Math.round(useCountUp(t(c.tempC), { duration: 700 }));

  const hourlyPoints: ChartPoint[] = useMemo(
    () => (data.hourly ?? []).map((h) => ({ label: hourLabel(h.time), value: unit === 'F' ? cToF(h.tempC) : Math.round(h.tempC) })),
    [data.hourly, unit]
  );

  // ── Compact: the glance card — temp, condition, hi/lo, next hours. ──────────
  if (compact) {
    const nextHours = (data.hourly ?? []).slice(0, 6);
    return (
      <Surface>
        <div className="flex items-start justify-between gap-3 p-3 pb-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-1 text-[11px] text-[var(--ds-muted)]">
              <MapPin className="h-3 w-3 shrink-0" />
              <span className="truncate">{data.location}</span>
            </div>
            <div className="mt-0.5 text-4xl font-semibold leading-none tracking-tight text-[var(--ds-ink)]">
              {heroTemp}°<span className="align-top text-lg text-[var(--ds-muted)]">{unit}</span>
            </div>
            <div className="mt-1 truncate text-[11px] text-[var(--ds-muted)]">
              {c.description}
              {today && (
                <span className="ml-1.5 text-[var(--ds-ink)] opacity-80">
                  H {t(today.maxC)}° · L {t(today.minC)}°
                </span>
              )}
            </div>
          </div>
          <WeatherIcon code={c.code} isDay={c.isDay} size={44} className="shrink-0" />
        </div>
        {nextHours.length > 1 && (
          <div className="flex justify-between border-t border-[var(--ds-hairline-soft)] px-3 py-2">
            {nextHours.map((h) => (
              <div key={h.time} className="flex min-w-0 flex-col items-center gap-0.5">
                <span className="text-[10px] text-[var(--ds-muted)]">{hourLabel(h.time)}</span>
                <WeatherIcon code={h.code} isDay={h.isDay ?? c.isDay} size={18} still />
                <span className="text-[11px] font-semibold text-[var(--ds-ink)]">{t(h.tempC)}°</span>
              </div>
            ))}
          </div>
        )}
      </Surface>
    );
  }

  // ── Detailed: the full station. ──────────────────────────────────────────────
  const mapData = data.coords
    ? { title: data.location, markers: [{ lat: data.coords.lat, lng: data.coords.lng, label: data.location, description: `${t(c.tempC)}°${unit} · ${c.description}` }] }
    : null;

  const uv = c.uvIndex;
  const aq = data.airQuality;
  const pollen = data.pollen;

  // Shared scale for the 7-day hi/lo range bars.
  const weekMin = data.daily.length ? Math.min(...data.daily.map((x) => x.minC)) : 0;
  const weekMax = data.daily.length ? Math.max(...data.daily.map((x) => x.maxC)) : 1;
  const weekSpan = weekMax - weekMin || 1;

  return (
    <Surface className="flex min-h-[calc(100%-1rem)] flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        <span className="flex min-w-0 items-center gap-1 text-xs font-semibold text-[var(--ds-muted)]">
          <MapPin className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{data.location}</span>
        </span>
        {/* Unit toggle — calm pill (no longer buried inside a colored block). */}
        <div className="flex shrink-0 overflow-hidden rounded-full border border-[var(--ds-hairline)] text-[11px] font-semibold">
          {(['C', 'F'] as const).map((u) => (
            <button
              key={u}
              onClick={() => setUnit(u)}
              aria-pressed={unit === u}
              className={`px-2 py-0.5 transition-colors duration-200 ${unit === u ? 'bg-[var(--ds-ink)] text-[var(--ds-canvas)]' : 'text-[var(--ds-muted)] hover:bg-[var(--ds-well)]'}`}
            >
              °{u}
            </button>
          ))}
        </div>
      </div>

      {/* Tabs */}
      {mapData && (
        <div className="flex gap-1 px-3 pb-1 pt-2">
          {([['forecast', 'Forecast', BarChart3], ['map', 'Map', MapIcon]] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              aria-pressed={tab === id}
              className={`flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] font-semibold transition-colors duration-200 ${
                tab === id ? 'border-transparent bg-[var(--ds-ink)] text-[var(--ds-canvas)]' : 'border-[var(--ds-hairline)] text-[var(--ds-muted)] hover:bg-[var(--ds-well)]'
              }`}
            >
              <Icon className="h-3 w-3" /> {label}
            </button>
          ))}
        </div>
      )}

      {tab === 'map' && mapData ? (
        /* The map pane grows with the card: the wrapper is measured and the map gets
           the real pixel height, so an expanded/stretched card shows a BIG map. */
        <div className="flex grow animate-fade-in flex-col p-3 pt-1">
          <div className="mb-1.5 flex justify-end">
            <button
              onClick={() => setRadar((r) => !r)}
              aria-pressed={radar}
              className={`rounded-lg border px-2 py-0.5 text-[11px] font-semibold transition-colors duration-200 ${
                radar ? 'border-transparent bg-[var(--ds-accent)] text-white' : 'border-[var(--ds-hairline)] text-[var(--ds-muted)] hover:bg-[var(--ds-well)]'
              }`}
              title="Live precipitation radar (RainViewer)"
            >
              Radar {radar ? 'on' : 'off'}
            </button>
          </div>
          <div ref={mapRef} className="min-h-[260px] grow">
            <InlineMap data={mapData} height={Math.max(260, Math.floor(mapSize.height))} radar={radar} />
          </div>
        </div>
      ) : (
        <>
          {/* Calm current-conditions header — same glass language as the compact glance
              card. The animation lives in a small contained weather mark, not a
              full-bleed saturated gradient (which clashed with the studio language). */}
          <div className="flex animate-fade-in items-start justify-between gap-3 px-3 pb-3 pt-1">
            <div className="min-w-0">
              <div className="flex items-end gap-1 leading-none">
                <span className="text-6xl font-semibold tracking-tight tabular-nums text-[var(--ds-ink)]">{heroTemp}°</span>
                <span className="mb-1 text-2xl font-medium text-[var(--ds-muted)]">{unit}</span>
              </div>
              <div className="mt-2 text-sm font-semibold text-[var(--ds-ink)]">{c.description}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--ds-muted)]">
                {typeof c.feelsLikeC === 'number' && <span>Feels {t(c.feelsLikeC)}°</span>}
                {today && (
                  <span className="font-medium tabular-nums text-[var(--ds-ink)]">
                    H {t(today.maxC)}° · L {t(today.minC)}°
                  </span>
                )}
              </div>
            </div>
            {/* Animated weather mark — a living glyph in a calm, bordered tile. */}
            <div className={`relative h-20 w-24 shrink-0 overflow-hidden rounded-2xl border border-[var(--ds-hairline-soft)] bg-gradient-to-br ${bg} opacity-95`}>
              <SkyScene sky={sky} isDay={c.isDay} />
              <span className="absolute inset-0 flex items-center justify-center">
                <WeatherIcon code={c.code} isDay={c.isDay} size={46} className="drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)]" />
              </span>
            </div>
          </div>

          {/* Conditions grid — one uniform, value-forward treatment per metric (a thin
              indicator where it's a 0–100 quantity). Tiles reveal with a soft stagger
              and lift on hover. Reads as a single calm block. */}
          <div className="studio-stagger grid grid-cols-2 gap-2 px-3 pb-3 sm:grid-cols-4">
            {typeof uv === 'number' && (
              <Tile icon={<Sun className="h-3 w-3" />} label="UV index">
                <TileValue value={Math.round(uv)} color={uvBand(uv).color} />
                <span className="mt-0.5 text-[10px] font-semibold" style={{ color: uvBand(uv).color }}>{uvBand(uv).label}</span>
              </Tile>
            )}
            {typeof c.windKph === 'number' && (
              <Tile icon={<Wind className="h-3 w-3" />} label="Wind">
                <TileValue value={Math.round(c.windKph)} unit="km/h" />
                <span className="mt-0.5 text-[10px] font-semibold text-[var(--ds-muted)]">
                  {cardinal(c.windDir)}
                  {typeof c.windGustKph === 'number' ? ` · gust ${Math.round(c.windGustKph)}` : ''}
                </span>
              </Tile>
            )}
            {typeof c.humidity === 'number' && (
              <Tile icon={<Droplets className="h-3 w-3" />} label="Humidity">
                <TileValue value={c.humidity} unit="%" />
                <div className="mt-1.5"><LinearGauge value={c.humidity} max={100} color="#0ea5e9" height={5} /></div>
                {typeof c.dewPointC === 'number' && <span className="mt-1 text-[10px] text-[var(--ds-muted)]">Dew {t(c.dewPointC)}°</span>}
              </Tile>
            )}
            {typeof c.pressureHpa === 'number' && (
              <Tile icon={<Gauge className="h-3 w-3" />} label="Pressure">
                <TileValue value={Math.round(c.pressureHpa)} unit="hPa" />
                <span className="mt-0.5 text-[10px] text-[var(--ds-muted)]">{c.pressureHpa >= 1013 ? 'High' : 'Low'}</span>
              </Tile>
            )}
            {typeof c.precipProb === 'number' && (
              <Tile icon={<Umbrella className="h-3 w-3" />} label="Precip">
                <TileValue value={c.precipProb} unit="%" />
                <div className="mt-1.5"><LinearGauge value={c.precipProb} max={100} color="#3B82F6" height={5} /></div>
              </Tile>
            )}
            {typeof c.cloudCover === 'number' && (
              <Tile icon={<Cloud className="h-3 w-3" />} label="Cloud">
                <TileValue value={c.cloudCover} unit="%" />
                <div className="mt-1.5"><LinearGauge value={c.cloudCover} max={100} color="#64748b" height={5} /></div>
              </Tile>
            )}
            {typeof c.visibilityKm === 'number' && (
              <Tile icon={<Eye className="h-3 w-3" />} label="Visibility">
                <TileValue value={c.visibilityKm} unit="km" />
                <div className="mt-1.5"><LinearGauge value={Math.min(c.visibilityKm, 20)} max={20} color="#14b8a6" height={5} /></div>
              </Tile>
            )}
            {typeof c.feelsLikeC === 'number' && (
              <Tile icon={<Thermometer className="h-3 w-3" />} label="Feels like">
                <TileValue value={`${t(c.feelsLikeC)}°`} />
                <span className="mt-0.5 text-[10px] text-[var(--ds-muted)]">Actual {t(c.tempC)}°</span>
              </Tile>
            )}
          </div>

          {/* Hourly temperature chart — the primary flexible region. It grows when
              the card is stretched (kit Chart fills its measured box) and the C/F
              toggle morphs the curve instead of snapping. */}
          {hourlyPoints.length > 2 && (
            <div className="flex grow-[2] flex-col px-1 pb-1">
              <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Next 24 hours</div>
              <div className="relative grow">
                <Chart
                  points={hourlyPoints}
                  variant="area"
                  color={c.isDay ? '#0ea5e9' : '#6366f1'}
                  height={104}
                  aspect={0.2}
                  maxHeight={320}
                  formatValue={(n) => `${Math.round(n)}°${unit}`}
                />
              </div>
              <div className="flex overflow-x-auto px-2 pb-1 pt-0.5">
                {(data.hourly ?? []).map((h) => (
                  <div key={h.time} className="flex min-w-[30px] flex-1 shrink-0 flex-col items-center gap-0.5 text-center">
                    <WeatherIcon code={h.code} isDay={h.isDay ?? c.isDay} size={20} still />
                    {typeof h.precipProb === 'number' && h.precipProb > 0 && <span className="text-[9px] font-semibold text-sky-600">{h.precipProb}%</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 7-day forecast — rows breathe apart when the card has extra height, and
              each hi/lo range bar grows in from its cold end with a soft stagger. */}
          {data.daily.length > 0 && (
            <div className="flex grow flex-col border-t border-[var(--ds-hairline-soft)] px-3 py-2">
              <div className="flex grow flex-col justify-evenly gap-1">
                {data.daily.slice(0, 7).map((d, i) => {
                  const lo = t(d.minC);
                  const hi = t(d.maxC);
                  const left = ((d.minC - weekMin) / weekSpan) * 100;
                  const width = ((d.maxC - d.minC) / weekSpan) * 100;
                  return (
                    <div key={d.date} className="flex items-center gap-2 text-xs">
                      <span className="w-9 font-semibold text-[var(--ds-ink)]">{dayName(d.date)}</span>
                      <span className="flex w-5 justify-center" title={d.description}><WeatherIcon code={d.code} size={20} still /></span>
                      {typeof d.precipProb === 'number' && d.precipProb > 0 ? (
                        <span className="w-8 text-[10px] font-semibold text-sky-600">{d.precipProb}%</span>
                      ) : (
                        <span className="w-8" />
                      )}
                      <span className="w-7 text-right font-medium tabular-nums text-[var(--ds-muted)]">{lo}°</span>
                      <div className="relative h-1.5 flex-1 rounded-full bg-[var(--ds-well-strong)]">
                        <div
                          className="absolute h-full rounded-full bg-gradient-to-r from-sky-400 to-orange-400 transition-[width,opacity] duration-500 ease-out"
                          style={{
                            left: `${left}%`,
                            width: barsIn ? `${Math.max(width, 4)}%` : '0%',
                            opacity: barsIn ? 1 : 0,
                            transitionDelay: `${i * 45}ms`
                          }}
                        />
                      </div>
                      <span className="w-7 font-semibold tabular-nums text-[var(--ds-ink)]">{hi}°</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Air quality, pollen, sun */}
          {(aq || pollen || today?.sunrise) && (
            <div className="grid gap-3 border-t border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] p-3 sm:grid-cols-2">
              {aq && (aq.usAqi !== undefined || aq.euAqi !== undefined) && (
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="flex items-center gap-1 text-[11px] font-semibold text-[var(--ds-ink)]"><Gauge className="h-3.5 w-3.5 text-[var(--ds-muted)]" /> Air quality</span>
                    <Badge color={aqiColor(aq.usAqi ?? 0)}>{aq.category || `AQI ${aq.usAqi ?? aq.euAqi}`}</Badge>
                  </div>
                  <LinearGauge value={Math.min(aq.usAqi ?? aq.euAqi ?? 0, 300)} max={300} bands={AQI_BANDS} height={9} />
                  <div className="mt-1 flex justify-between text-[10px] text-[var(--ds-muted)]">
                    <span>US AQI {aq.usAqi ?? '—'}</span>
                    {typeof aq.pm25 === 'number' && <span>PM2.5 {Math.round(aq.pm25)}</span>}
                  </div>
                </div>
              )}
              {pollen && pollen.level && (
                <div>
                  <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-[var(--ds-ink)]"><Leaf className="h-3.5 w-3.5 text-emerald-500" /> Pollen · {pollen.level}</div>
                  <div className="space-y-1">
                    {([['Tree', pollen.tree], ['Grass', pollen.grass], ['Weed', pollen.weed]] as const).map(([lbl, val]) => (
                      <div key={lbl} className="flex items-center gap-2">
                        <span className="w-9 text-[10px] text-[var(--ds-muted)]">{lbl}</span>
                        <LinearGauge value={Math.min(val ?? 0, 100)} max={100} color="#10b981" height={6} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {today?.sunrise && (
                <div className="sm:col-span-2">
                  <div className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold text-[var(--ds-ink)]"><Sun className="h-3.5 w-3.5 text-amber-500" /> Sun</div>
                  <SunArc sunrise={today.sunrise} sunset={today.sunset} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Surface>
  );
};
