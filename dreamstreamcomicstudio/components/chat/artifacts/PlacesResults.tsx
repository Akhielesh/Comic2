import React from 'react';
import { MapPin, Clock, Globe, Navigation, Utensils, Star } from 'lucide-react';
import type { PlacesResultsArtifact, PlaceResult, MapArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact } from './kit';
import { InlineMap } from './InlineMap';

const distanceLabel = (km?: number): string | undefined => {
  if (typeof km !== 'number') return undefined;
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
};

// Local-results card in two densities:
//  • compact — the top 3 places: name + rating + distance, nothing else.
//  • detailed — a Google-local-pack-style list (photo, distance, hours, website,
//    directions) plus a map of all results.
export const PlacesResults: React.FC<{ data: PlacesResultsArtifact }> = ({ data }) => {
  const compact = useCompact();
  if (!data?.results?.length) return null;

  const header = (
    <span className="flex min-w-0 items-center gap-1.5">
      <MapPin className="h-4 w-4 shrink-0 text-[#6e6a60]" />
      <SurfaceTitle className="capitalize">{data.query}</SurfaceTitle>
      <SurfaceSubtitle className="shrink truncate">near {data.near}</SurfaceSubtitle>
    </span>
  );

  // ── Compact: top 3 places at a glance. ──────────────────────────────────────
  if (compact) {
    return (
      <Surface header={header} right={<SurfaceSubtitle>{data.results.length} places</SurfaceSubtitle>}>
        <ul className="divide-y divide-black/5 border-t border-black/5">
          {data.results.slice(0, 3).map((p, i) => {
            const dist = distanceLabel(p.distanceKm);
            return (
              <li key={`${p.name}-${i}`} className="flex items-center gap-2 px-3 py-1.5">
                <span className="w-3.5 shrink-0 text-[10px] font-semibold text-[#6e6a60]">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[#1a1915]">{p.name}</span>
                {typeof p.rating === 'number' && (
                  <span className="flex shrink-0 items-center gap-0.5 text-[11px] font-semibold text-amber-600">
                    <Star className="h-3 w-3 fill-amber-500 text-amber-500" />
                    {p.rating.toFixed(1)}
                  </span>
                )}
                {dist && <span className="shrink-0 text-[11px] text-[#6e6a60]">{dist}</span>}
              </li>
            );
          })}
        </ul>
      </Surface>
    );
  }

  // ── Detailed: map + full rows. ──────────────────────────────────────────────
  const mapData: MapArtifact = {
    title: `${data.query} near ${data.near}`,
    markers: data.results.map((p) => ({
      lat: p.lat,
      lng: p.lng,
      label: p.name,
      description: [distanceLabel(p.distanceKm), p.cuisine, p.address].filter(Boolean).join(' · ')
    }))
  };

  return (
    <Surface header={header} right={<SurfaceSubtitle>{data.results.length} places</SurfaceSubtitle>}>
      <div className="px-3 pb-2">
        <InlineMap data={mapData} height={200} />
      </div>
      <ul className="divide-y divide-black/5 border-t border-black/5">
        {data.results.map((p, i) => (
          <PlaceRow key={`${p.name}-${i}`} place={p} index={i + 1} />
        ))}
      </ul>
    </Surface>
  );
};

const PlaceRow: React.FC<{ place: PlaceResult; index: number }> = ({ place, index }) => {
  const dist = distanceLabel(place.distanceKm);
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;
  return (
    <li className="flex gap-3 px-3 py-2.5 transition-colors duration-200 hover:bg-black/[0.03]">
      <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/[0.03] ring-1 ring-black/5">
        {place.image ? (
          <img src={place.image} alt={place.name} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <Utensils className="h-6 w-6 text-[#6e6a60]/50" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[11px] font-semibold text-[#6e6a60]">{index}</span>
          <span className="truncate text-[13px] font-semibold leading-snug text-[#1a1915]">{place.name}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[#6e6a60]">
          {typeof place.rating === 'number' && (
            <span className="flex items-center gap-0.5 font-semibold text-amber-600">
              <Star className="h-3 w-3 fill-amber-500 text-amber-500" />{place.rating.toFixed(1)}
            </span>
          )}
          {typeof place.price === 'number' && place.price > 0 && (
            <span className="font-semibold text-emerald-700">{'$'.repeat(Math.min(4, place.price))}</span>
          )}
          {dist && <span className="flex items-center gap-0.5 font-medium text-[#1a1915]/70"><Navigation className="h-3 w-3" />{dist}</span>}
          {place.cuisine && <span className="capitalize">{place.cuisine}</span>}
          {place.category && !place.cuisine && <span className="capitalize">{place.category.replace(/_/g, ' ')}</span>}
        </div>
        {place.openingHours && (
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-[#6e6a60]">
            <Clock className="h-3 w-3 shrink-0" /> <span className="truncate">{place.openingHours}</span>
          </div>
        )}
        {place.address && <div className="mt-0.5 truncate text-[11px] text-[#6e6a60]/80">{place.address}</div>}
        <div className="mt-1 flex items-center gap-3">
          <a href={directions} target="_blank" rel="noopener noreferrer" className="flex items-center gap-0.5 text-[11px] font-semibold text-sky-700 transition-colors duration-200 hover:text-sky-900">
            <Navigation className="h-3 w-3" /> Directions
          </a>
          {place.website && (
            <a href={place.website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-0.5 text-[11px] font-semibold text-[#6e6a60] transition-colors duration-200 hover:text-[#1a1915]">
              <Globe className="h-3 w-3" /> Website
            </a>
          )}
        </div>
      </div>
    </li>
  );
};
