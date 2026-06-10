import React from 'react';
import { Plane } from 'lucide-react';
import type { ItineraryArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, resolveTheme } from './kit';

// Travel itinerary card — v1 scaffold. Renders the day outline; the full interactive
// build (day tabs, stop timeline, numbered map pins + route, budget, weather strip,
// compact glance mode) lands on top of this shell.

export const ItineraryCard: React.FC<{ data: ItineraryArtifact }> = ({ data }) => {
  const theme = resolveTheme({ palette: (data.palette as never) ?? 'ocean' });
  const stops = data.days.reduce((n, d) => n + d.stops.length, 0);
  return (
    <Surface
      accent={theme.accent}
      header={
        <div className="flex items-center gap-2">
          <Plane className="h-4 w-4" style={{ color: theme.accent }} />
          <div className="min-w-0">
            <SurfaceTitle>{data.title}</SurfaceTitle>
            <SurfaceSubtitle>
              {data.destination ? `${data.destination} · ` : ''}
              {data.days.length} days · {stops} stops
            </SurfaceSubtitle>
          </div>
        </div>
      }
    >
      <ul className="divide-y divide-black/5 border-t border-black/5">
        {data.days.map((d, i) => (
          <li key={i} className="px-3 py-2">
            <p className="text-[13px] font-semibold text-[#1a1915]">
              {d.label ?? `Day ${i + 1}`}
              {d.date ? <span className="ml-1.5 text-[11px] font-normal text-[#6e6a60]">{d.date}</span> : null}
            </p>
            <p className="truncate text-[11px] text-[#6e6a60]">{d.stops.map((s) => s.name).join(' · ')}</p>
          </li>
        ))}
      </ul>
    </Surface>
  );
};
