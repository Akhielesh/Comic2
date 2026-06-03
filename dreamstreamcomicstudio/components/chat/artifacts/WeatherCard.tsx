import React, { useMemo, useState } from 'react';
import { Wind, Droplets, MapPin, Sun, Umbrella, ChevronDown, Sunrise, Sunset, Leaf, Gauge } from 'lucide-react';
import type { WeatherArtifact } from '../../../apiTypes';

// Map WMO code → emoji glyph (cheap, dependency-free icon).
const glyph = (code: number, isDay = true): string => {
  if (code === 0) return isDay ? '☀️' : '🌙';
  if (code <= 2) return isDay ? '🌤️' : '☁️';
  if (code === 3) return '☁️';
  if (code <= 48) return '🌫️';
  if (code <= 57) return '🌦️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '❄️';
  if (code <= 82) return '🌧️';
  if (code <= 86) return '🌨️';
  return '⛈️';
};

const dayName = (date: string): string => {
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { weekday: 'short' });
};

const hourLabel = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: 'numeric' });
};

const clockTime = (iso?: string): string | undefined => {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

// Default temperature unit from the browser locale (US/LR/MM ⇒ °F).
const defaultUnit = (): 'C' | 'F' => {
  try {
    const region = (navigator.language || '').split('-')[1]?.toUpperCase();
    return region && ['US', 'LR', 'MM'].includes(region) ? 'F' : 'C';
  } catch {
    return 'C';
  }
};

const cToF = (c: number): number => Math.round((c * 9) / 5 + 32);

// UV index → color + label band.
const uvBand = (uv: number): { label: string; cls: string } => {
  if (uv < 3) return { label: 'Low', cls: 'text-emerald-600' };
  if (uv < 6) return { label: 'Moderate', cls: 'text-amber-600' };
  if (uv < 8) return { label: 'High', cls: 'text-orange-600' };
  if (uv < 11) return { label: 'Very high', cls: 'text-red-600' };
  return { label: 'Extreme', cls: 'text-fuchsia-700' };
};

const aqiColor = (usAqi?: number): string => {
  if (typeof usAqi !== 'number') return 'text-slate-500';
  if (usAqi <= 50) return 'text-emerald-600';
  if (usAqi <= 100) return 'text-amber-600';
  if (usAqi <= 150) return 'text-orange-600';
  if (usAqi <= 200) return 'text-red-600';
  return 'text-fuchsia-700';
};

export const WeatherCard: React.FC<{ data: WeatherArtifact }> = ({ data }) => {
  const [unit, setUnit] = useState<'C' | 'F'>(defaultUnit);
  const [expanded, setExpanded] = useState(false);
  const c = data.current;

  // Render a Celsius value in the active unit.
  const t = useMemo(
    () => (valC: number) => (unit === 'F' ? cToF(valC) : Math.round(valC)),
    [unit]
  );

  const uv = c.uvIndex;
  const aq = data.airQuality;
  const pollen = data.pollen;
  const hasExtras = Boolean(aq || pollen || data.daily[0]?.sunrise);

  return (
    <div className="my-2 rounded-xl border-2 border-black overflow-hidden shadow-comic animate-fade-in">
      {/* Hero */}
      <div className={`relative p-4 ${c.isDay ? 'bg-gradient-to-br from-sky-400 to-blue-500' : 'bg-gradient-to-br from-slate-700 to-slate-900'} text-white`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 text-xs font-bold opacity-90"><MapPin className="w-3.5 h-3.5" /> {data.location}</div>
          {/* °C / °F toggle */}
          <div className="flex rounded-full border border-white/50 overflow-hidden text-[11px] font-bold">
            {(['C', 'F'] as const).map((u) => (
              <button
                key={u}
                onClick={() => setUnit(u)}
                className={`px-2 py-0.5 transition-colors ${unit === u ? 'bg-white text-slate-900' : 'text-white/90 hover:bg-white/20'}`}
                aria-pressed={unit === u}
              >°{u}</button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between mt-1">
          <div>
            <div className="text-4xl font-display leading-none">{t(c.tempC)}°<span className="text-xl align-top">{unit}</span></div>
            <div className="text-sm font-semibold mt-0.5">{c.description}</div>
            {typeof c.feelsLikeC === 'number' && (
              <div className="text-xs opacity-90 mt-0.5">Feels like {t(c.feelsLikeC)}°{unit}</div>
            )}
          </div>
          <div className="text-5xl drop-shadow-sm">{glyph(c.code, c.isDay)}</div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs font-semibold opacity-95">
          <span className="flex items-center gap-1"><Wind className="w-3.5 h-3.5" /> {Math.round(c.windKph)} km/h</span>
          {typeof c.humidity === 'number' && <span className="flex items-center gap-1"><Droplets className="w-3.5 h-3.5" /> {c.humidity}%</span>}
          {typeof c.precipProb === 'number' && <span className="flex items-center gap-1"><Umbrella className="w-3.5 h-3.5" /> {c.precipProb}%</span>}
          {typeof uv === 'number' && <span className="flex items-center gap-1"><Sun className="w-3.5 h-3.5" /> UV {Math.round(uv)}</span>}
        </div>
      </div>

      {/* Hourly strip (next 24h) */}
      {data.hourly && data.hourly.length > 0 && (
        <div className="bg-white border-t-2 border-black/10 px-2 py-2 overflow-x-auto">
          <div className="flex gap-3 min-w-min">
            {data.hourly.map((h) => (
              <div key={h.time} className="flex flex-col items-center gap-0.5 text-center shrink-0 w-11">
                <span className="text-[10px] font-bold text-slate-500">{hourLabel(h.time)}</span>
                <span className="text-base leading-none">{glyph(h.code, h.isDay ?? true)}</span>
                <span className="text-[11px] font-bold">{t(h.tempC)}°</span>
                {typeof h.precipProb === 'number' && h.precipProb > 0 && (
                  <span className="text-[9px] text-sky-600 font-semibold">{h.precipProb}%</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Daily forecast */}
      {data.daily.length > 0 && (
        <div className="grid grid-cols-7 bg-white border-t-2 border-black/10 divide-x divide-black/5">
          {data.daily.slice(0, 7).map((d) => (
            <div key={d.date} className="flex flex-col items-center gap-0.5 py-2 text-center">
              <span className="text-[10px] font-bold text-slate-500">{dayName(d.date)}</span>
              <span className="text-lg leading-none" title={d.description}>{glyph(d.code)}</span>
              <span className="text-[11px] font-bold">{t(d.maxC)}°</span>
              <span className="text-[11px] text-slate-400">{t(d.minC)}°</span>
              {typeof d.precipProb === 'number' && d.precipProb > 0 && (
                <span className="text-[9px] text-sky-600">{d.precipProb}%</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Expandable premium details: AQI, pollen, UV band, sun times */}
      {hasExtras && (
        <>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center justify-center gap-1 bg-slate-50 border-t-2 border-black/10 py-1.5 text-[11px] font-bold text-slate-600 hover:bg-slate-100 transition-colors"
          >
            {expanded ? 'Less detail' : 'More detail'}
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
          {expanded && (
            <div className="bg-white border-t border-black/5 p-3 grid grid-cols-2 gap-3 text-xs animate-fade-in">
              {typeof uv === 'number' && (
                <div className="flex items-center gap-2">
                  <Sun className="w-4 h-4 text-amber-500" />
                  <div>
                    <div className="font-bold">UV index {Math.round(uv)}</div>
                    <div className={`${uvBand(uv).cls} font-semibold`}>{uvBand(uv).label}</div>
                  </div>
                </div>
              )}
              {aq && (aq.usAqi !== undefined || aq.euAqi !== undefined) && (
                <div className="flex items-center gap-2">
                  <Gauge className={`w-4 h-4 ${aqiColor(aq.usAqi)}`} />
                  <div>
                    <div className="font-bold">Air quality {aq.usAqi ?? aq.euAqi}</div>
                    <div className={`${aqiColor(aq.usAqi)} font-semibold`}>{aq.category || (typeof aq.pm25 === 'number' ? `PM2.5 ${Math.round(aq.pm25)}` : 'AQI')}</div>
                  </div>
                </div>
              )}
              {pollen && pollen.level && (
                <div className="flex items-center gap-2">
                  <Leaf className="w-4 h-4 text-emerald-500" />
                  <div>
                    <div className="font-bold">Pollen {pollen.level}</div>
                    <div className="text-slate-500">
                      {[pollen.tree ? `tree ${Math.round(pollen.tree)}` : '', pollen.grass ? `grass ${Math.round(pollen.grass)}` : '', pollen.weed ? `weed ${Math.round(pollen.weed)}` : '']
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </div>
                  </div>
                </div>
              )}
              {(clockTime(data.daily[0]?.sunrise) || clockTime(data.daily[0]?.sunset)) && (
                <div className="flex items-center gap-3">
                  {clockTime(data.daily[0]?.sunrise) && (
                    <span className="flex items-center gap-1"><Sunrise className="w-4 h-4 text-orange-400" /> {clockTime(data.daily[0]?.sunrise)}</span>
                  )}
                  {clockTime(data.daily[0]?.sunset) && (
                    <span className="flex items-center gap-1"><Sunset className="w-4 h-4 text-indigo-400" /> {clockTime(data.daily[0]?.sunset)}</span>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};
