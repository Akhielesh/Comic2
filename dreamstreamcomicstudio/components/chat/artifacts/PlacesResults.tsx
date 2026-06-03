import React from 'react';
import { MapPin, Map as MapIcon, Clock, Globe, Navigation, Utensils, Star } from 'lucide-react';
import type { PlacesResultsArtifact, PlaceResult } from '../../../apiTypes';
import { useChatPanel } from '../panelContext';

const distanceLabel = (km?: number): string | undefined => {
  if (typeof km !== 'number') return undefined;
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
};

// Rich local-results card: a Google-local-pack-style list (photo, distance, hours,
// website, directions) plus a one-tap map of all results in the side panel.
export const PlacesResults: React.FC<{ data: PlacesResultsArtifact }> = ({ data }) => {
  const openPanel = useChatPanel();
  if (!data?.results?.length) return null;

  const openMap = () => {
    openPanel?.({
      type: 'map',
      data: {
        title: `${data.query} near ${data.near}`,
        markers: data.results.map((p) => ({
          lat: p.lat,
          lng: p.lng,
          label: p.name,
          description: [distanceLabel(p.distanceKm), p.cuisine, p.address].filter(Boolean).join(' · ')
        }))
      }
    });
  };

  return (
    <div className="my-2 border-2 border-black rounded-xl bg-white shadow-comic overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b-2 border-black bg-sky-50">
        <MapPin className="w-4 h-4" />
        <span className="text-[12px] font-extrabold capitalize">{data.query}</span>
        <span className="text-[11px] text-slate-500 font-semibold truncate">near {data.near}</span>
        <button
          onClick={openMap}
          className="ml-auto shrink-0 flex items-center gap-1 text-[11px] font-bold border-2 border-black rounded-full px-2 py-0.5 bg-white hover:bg-brand-yellow"
          title="Show all on a map"
        >
          <MapIcon className="w-3.5 h-3.5" /> Map
        </button>
      </div>
      <ul className="divide-y divide-slate-100">
        {data.results.map((p, i) => (
          <PlaceRow key={`${p.name}-${i}`} place={p} index={i + 1} />
        ))}
      </ul>
    </div>
  );
};

const PlaceRow: React.FC<{ place: PlaceResult; index: number }> = ({ place, index }) => {
  const dist = distanceLabel(place.distanceKm);
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;
  return (
    <li className="flex gap-3 px-3 py-2.5 hover:bg-sky-50/50">
      <div className="shrink-0 w-16 h-16 rounded-lg border-2 border-black overflow-hidden bg-slate-100 flex items-center justify-center">
        {place.image ? (
          <img src={place.image} alt={place.name} loading="lazy" className="w-full h-full object-cover" />
        ) : (
          <Utensils className="w-6 h-6 text-slate-400" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[11px] font-bold text-slate-400">{index}</span>
          <span className="text-[13px] font-bold leading-snug truncate">{place.name}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500 mt-0.5">
          {typeof place.rating === 'number' && (
            <span className="flex items-center gap-0.5 font-bold text-amber-600">
              <Star className="w-3 h-3 fill-amber-500 text-amber-500" />{place.rating.toFixed(1)}
            </span>
          )}
          {typeof place.price === 'number' && place.price > 0 && (
            <span className="font-bold text-emerald-700">{'$'.repeat(Math.min(4, place.price))}</span>
          )}
          {dist && <span className="flex items-center gap-0.5 font-bold text-sky-700"><Navigation className="w-3 h-3" />{dist}</span>}
          {place.cuisine && <span className="capitalize">{place.cuisine}</span>}
          {place.category && !place.cuisine && <span className="capitalize">{place.category.replace(/_/g, ' ')}</span>}
        </div>
        {place.openingHours && (
          <div className="flex items-center gap-1 text-[11px] text-slate-500 mt-0.5">
            <Clock className="w-3 h-3 shrink-0" /> <span className="truncate">{place.openingHours}</span>
          </div>
        )}
        {place.address && <div className="text-[11px] text-slate-400 truncate mt-0.5">{place.address}</div>}
        <div className="flex items-center gap-3 mt-1">
          <a href={directions} target="_blank" rel="noopener noreferrer" className="flex items-center gap-0.5 text-[11px] font-bold text-brand-blue hover:underline">
            <Navigation className="w-3 h-3" /> Directions
          </a>
          {place.website && (
            <a href={place.website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-0.5 text-[11px] font-bold text-slate-600 hover:text-black hover:underline">
              <Globe className="w-3 h-3" /> Website
            </a>
          )}
        </div>
      </div>
    </li>
  );
};
