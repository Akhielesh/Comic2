import React, { useEffect, useState } from 'react';
import { MapPin, Clock, Globe, Heart, Navigation, Star } from 'lucide-react';
import type { PlacesResultsArtifact, PlaceResult, MapArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact } from './kit';
import { InlineMap } from './InlineMap';
import { placeKind, PLACE_KIND_ICONS } from './placeKinds';
import { isShortlisted, listShortlist, onShortlistChanged, shortlistId, toggleShortlist } from '../../../services/shortlist';
import { ShortlistPanel } from './ShortlistPanel';

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
  const [shortlistOpen, setShortlistOpen] = useState(false);
  const [savedCount, setSavedCount] = useState(() => listShortlist().length);
  useEffect(() => onShortlistChanged(() => setSavedCount(listShortlist().length)), []);
  if (!data?.results?.length) return null;

  const header = (
    <span className="flex min-w-0 items-center gap-1.5">
      <MapPin className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" />
      <SurfaceTitle className="capitalize">{data.query}</SurfaceTitle>
      <SurfaceSubtitle className="shrink truncate">near {data.near}</SurfaceSubtitle>
    </span>
  );

  // "Shortlist (N)" chip — opens the user's saved picks, grouped by category.
  const shortlistChip = savedCount > 0 && (
    <button
      type="button"
      onClick={() => setShortlistOpen(true)}
      title="Open your shortlist"
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--ds-hairline)] px-2 py-0.5 text-[11px] font-semibold text-[var(--ds-muted)] transition-colors duration-200 hover:border-[var(--ds-accent)] hover:text-[var(--ds-ink)]"
    >
      <Heart className="h-3 w-3 fill-[#D97757] text-[var(--ds-accent)]" /> {savedCount}
    </button>
  );

  // ── Compact: top 3 places at a glance. ──────────────────────────────────────
  if (compact) {
    return (
      <Surface header={header} right={<SurfaceSubtitle>{data.results.length} places</SurfaceSubtitle>}>
        <ul className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
          {data.results.slice(0, 3).map((p, i) => {
            const dist = distanceLabel(p.distanceKm);
            return (
              <li key={`${p.name}-${i}`} className="flex items-center gap-2 px-3 py-1.5">
                <span className="w-3.5 shrink-0 text-[10px] font-semibold text-[var(--ds-muted)]">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--ds-ink)]">{p.name}</span>
                {typeof p.rating === 'number' && (
                  <span className="flex shrink-0 items-center gap-0.5 text-[11px] font-semibold text-amber-600">
                    <Star className="h-3 w-3 fill-amber-500 text-amber-500" />
                    {p.rating.toFixed(1)}
                  </span>
                )}
                {dist && <span className="shrink-0 text-[11px] text-[var(--ds-muted)]">{dist}</span>}
              </li>
            );
          })}
        </ul>
      </Surface>
    );
  }

  // ── Detailed: map + full rows. Markers carry the place category so the map
  //    draws category glyphs (🍽️ 🏨 🌳 …) instead of identical dots. ───────────
  const mapData: MapArtifact = {
    title: `${data.query} near ${data.near}`,
    markers: data.results.map((p) => ({
      lat: p.lat,
      lng: p.lng,
      label: p.name,
      category: placeKind(p.category || p.cuisine || data.query),
      description: [distanceLabel(p.distanceKm), p.cuisine, p.address].filter(Boolean).join(' · ')
    }))
  };

  return (
    <Surface
      header={header}
      right={
        <span className="flex shrink-0 items-center gap-1.5">
          {shortlistChip}
          <SurfaceSubtitle>{data.results.length} places</SurfaceSubtitle>
        </span>
      }
    >
      <div className="px-3 pb-2">
        <InlineMap data={mapData} height={200} />
      </div>
      <ul className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
        {data.results.map((p, i) => (
          <PlaceRow key={`${p.name}-${i}`} place={p} index={i + 1} source={`${data.query} near ${data.near}`} />
        ))}
      </ul>
      {shortlistOpen && <ShortlistPanel onClose={() => setShortlistOpen(false)} />}
    </Surface>
  );
};

const PlaceRow: React.FC<{ place: PlaceResult; index: number; source?: string }> = ({ place, index, source }) => {
  const dist = distanceLabel(place.distanceKm);
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;
  const kind = placeKind(place.category || place.cuisine || source);
  const KindIcon = PLACE_KIND_ICONS[kind];
  // Shortlist heart — kept in sync across every card via the shortlist change event.
  const id = shortlistId(place.name, place.lat, place.lng);
  const [saved, setSaved] = useState(() => isShortlisted(id));
  useEffect(() => onShortlistChanged(() => setSaved(isShortlisted(id))), [id]);
  return (
    <li className="group/place flex gap-3 px-3 py-2.5 transition-colors duration-200 hover:bg-[var(--ds-well)]">
      <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--ds-well)] ring-1 ring-[var(--ds-hairline-soft)]">
        {place.image ? (
          <img src={place.image} alt={place.name} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <KindIcon className="h-6 w-6 text-[var(--ds-muted)] opacity-60" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[11px] font-semibold text-[var(--ds-muted)]">{index}</span>
          <span className="truncate text-[13px] font-semibold leading-snug text-[var(--ds-ink)]">{place.name}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--ds-muted)]">
          {typeof place.rating === 'number' && (
            <span className="flex items-center gap-0.5 font-semibold text-amber-600">
              <Star className="h-3 w-3 fill-amber-500 text-amber-500" />{place.rating.toFixed(1)}
            </span>
          )}
          {typeof place.price === 'number' && place.price > 0 && (
            <span className="font-semibold text-emerald-700">{'$'.repeat(Math.min(4, place.price))}</span>
          )}
          {dist && <span className="flex items-center gap-0.5 font-medium text-[var(--ds-ink)] opacity-80"><Navigation className="h-3 w-3" />{dist}</span>}
          {place.cuisine && <span className="capitalize">{place.cuisine}</span>}
          {place.category && !place.cuisine && <span className="capitalize">{place.category.replace(/_/g, ' ')}</span>}
        </div>
        {place.openingHours && (
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-[var(--ds-muted)]">
            <Clock className="h-3 w-3 shrink-0" /> <span className="truncate">{place.openingHours}</span>
          </div>
        )}
        {place.address && <div className="mt-0.5 truncate text-[11px] text-[var(--ds-muted)]">{place.address}</div>}
        <div className="mt-1 flex items-center gap-3">
          <a href={directions} target="_blank" rel="noopener noreferrer" className="flex items-center gap-0.5 text-[11px] font-semibold text-sky-700 transition-colors duration-200 hover:text-sky-900">
            <Navigation className="h-3 w-3" /> Directions
          </a>
          {place.website && (
            <a href={place.website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-0.5 text-[11px] font-semibold text-[var(--ds-muted)] transition-colors duration-200 hover:text-[var(--ds-ink)]">
              <Globe className="h-3 w-3" /> Website
            </a>
          )}
        </div>
      </div>
      {/* Shortlist heart — saves the place into the user's per-category trip picks. */}
      <button
        type="button"
        onClick={() =>
          toggleShortlist({ id, name: place.name, kind, lat: place.lat, lng: place.lng, address: place.address, source })
        }
        title={saved ? 'Remove from shortlist' : 'Shortlist this place'}
        aria-pressed={saved}
        className={`mt-0.5 h-7 w-7 shrink-0 self-start rounded-lg p-1.5 transition-all duration-200 ${
          saved
            ? 'text-[var(--ds-accent)]'
            : 'text-[var(--ds-faint)] opacity-0 hover:text-[var(--ds-accent)] focus-visible:opacity-100 group-hover/place:opacity-100 [@media(pointer:coarse)]:opacity-70'
        }`}
      >
        <Heart className={`h-4 w-4 transition-transform duration-200 ${saved ? 'scale-110 fill-[#D97757]' : ''}`} />
      </button>
    </li>
  );
};
