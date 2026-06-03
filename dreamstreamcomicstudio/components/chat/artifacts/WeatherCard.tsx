import React from 'react';
import { Wind, Droplets, MapPin } from 'lucide-react';
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

export const WeatherCard: React.FC<{ data: WeatherArtifact }> = ({ data }) => {
  const c = data.current;
  return (
    <div className="my-2 rounded-xl border-2 border-black overflow-hidden shadow-comic animate-fade-in">
      <div className={`p-4 ${c.isDay ? 'bg-gradient-to-br from-sky-400 to-blue-500' : 'bg-gradient-to-br from-slate-700 to-slate-900'} text-white`}>
        <div className="flex items-center gap-1 text-xs font-bold opacity-90"><MapPin className="w-3.5 h-3.5" /> {data.location}</div>
        <div className="flex items-center justify-between mt-1">
          <div>
            <div className="text-4xl font-display leading-none">{Math.round(c.tempC)}°<span className="text-xl align-top">C</span></div>
            <div className="text-sm font-semibold mt-0.5">{c.description} · {c.tempF}°F</div>
          </div>
          <div className="text-5xl">{glyph(c.code, c.isDay)}</div>
        </div>
        <div className="flex items-center gap-4 mt-2 text-xs font-semibold opacity-95">
          <span className="flex items-center gap-1"><Wind className="w-3.5 h-3.5" /> {Math.round(c.windKph)} km/h</span>
          {typeof c.humidity === 'number' && <span className="flex items-center gap-1"><Droplets className="w-3.5 h-3.5" /> {c.humidity}%</span>}
        </div>
      </div>
      {data.daily.length > 0 && (
        <div className="grid grid-cols-5 bg-white divide-x-2 divide-black/10">
          {data.daily.slice(0, 5).map((d) => (
            <div key={d.date} className="flex flex-col items-center gap-0.5 py-2 text-center">
              <span className="text-[10px] font-bold text-slate-500">{dayName(d.date)}</span>
              <span className="text-lg leading-none" title={d.description}>{glyph(d.code)}</span>
              <span className="text-[11px] font-bold">{Math.round(d.maxC)}°</span>
              <span className="text-[11px] text-slate-400">{Math.round(d.minC)}°</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
