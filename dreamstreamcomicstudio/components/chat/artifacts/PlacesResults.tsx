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
    <span className="flex min-w-0 items-center gap-2">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#D97757]/10 text-[var(--ds-accent)]">
        <MapPin className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <SurfaceTitle className="capitalize">{data.query}</SurfaceTitle>
        <SurfaceSubtitle className="truncate">near {data.near}</SurfaceSubtitle>
      </span>
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
      <div className="px-3 pb-2.5">
        <div className="overflow-hidden rounded-xl ring-1 ring-[var(--ds-hairline)]">
          <InlineMap data={mapData} height={210} />
        </div>
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

// One small status/meta pill. Keeps the metadata row clean + scannable.
const Pill: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold ${className}`}>{children}</span>
);

const PlaceRow: React.FC<{ place: PlaceResult; index: number; source?: string }> = ({ place, index, source }) => {
  const dist = distanceLabel(place.distanceKm);
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;
  const kind = placeKind(place.category || place.cuisine || source);
  const KindIcon = PLACE_KIND_ICONS[kind];
  // Shortlist heart — kept in sync across every card via the shortlist change event.
  const id = shortlistId(place.name, place.lat, place.lng);
  const [saved, setSaved] = useState(() => isShortlisted(id));
  useEffect(() => onShortlistChanged(() => setSaved(isShortlisted(id))), [id]);
  const categoryLabel = (place.cuisine || place.category)?.replace(/_/g, ' ');
  const openNow = !!place.openingHours && /\bopen\b/i.test(place.openingHours) && !/\bclosed\b/i.test(place.openingHours);

  return (
    <li className="group/place flex gap-3 px-3 py-3 transition-colors duration-200 hover:bg-[var(--ds-well)]">
      {/* Imagery — larger, rounded, with a rank chip + a gentle zoom on hover. */}
      <div className="relative h-[76px] w-[76px] shrink-0 overflow-hidden rounded-xl bg-[var(--ds-well)] ring-1 ring-[var(--ds-hairline)]">
        {place.image ? (
          <img
            src={place.image}
            alt={place.name}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover/place:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <KindIcon className="h-7 w-7 text-[var(--ds-faint)]" />
          </div>
        )}
        <span className="absolute left-1 top-1 grid h-5 min-w-[1.25rem] place-items-center rounded-md bg-black/55 px-1 text-[10px] font-bold leading-none text-white backdrop-blur-sm">
          {index}
        </span>
      </div>

      {/* Body */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <h4 className="truncate text-[13.5px] font-semibold leading-snug text-[var(--ds-ink)]">{place.name}</h4>
          <button
            type="button"
            onClick={() => toggleShortlist({ id, name: place.name, kind, lat: place.lat, lng: place.lng, address: place.address, source })}
            title={saved ? 'Remove from shortlist' : 'Shortlist this place'}
            aria-pressed={saved}
            className={`-mr-1 -mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-all duration-200 ${
              saved
                ? 'text-[var(--ds-accent)]'
                : 'text-[var(--ds-faint)] opacity-0 hover:text-[var(--ds-accent)] focus-visible:opacity-100 group-hover/place:opacity-100 [@media(pointer:coarse)]:opacity-70'
            }`}
          >
            <Heart className={`h-4 w-4 transition-transform duration-200 ${saved ? 'scale-110 fill-[#D97757]' : ''}`} />
          </button>
        </div>

        {/* Metadata — clean pills. */}
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {typeof place.rating === 'number' && (
            <Pill className="bg-amber-500/12 text-amber-600">
              <Star className="h-2.5 w-2.5 fill-amber-500 text-amber-500" />
              {place.rating.toFixed(1)}
            </Pill>
          )}
          {typeof place.price === 'number' && place.price > 0 && (
            <Pill className="bg-emerald-500/12 text-emerald-700">{'$'.repeat(Math.min(4, place.price))}</Pill>
          )}
          {dist && (
            <Pill className="bg-[var(--ds-well-strong)] text-[var(--ds-ink)]">
              <Navigation className="h-2.5 w-2.5" />
              {dist}
            </Pill>
          )}
          {openNow && (
            <Pill className="bg-emerald-500/12 text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Open
            </Pill>
          )}
          {categoryLabel && (
            <span className="rounded-full border border-[var(--ds-hairline)] px-1.5 py-0.5 text-[10.5px] font-medium capitalize text-[var(--ds-muted)]">{categoryLabel}</span>
          )}
        </div>

        {/* Hours + address */}
        {(place.openingHours || place.address) && (
          <div className="mt-1 space-y-0.5">
            {place.openingHours && (
              <p className="flex items-center gap-1 truncate text-[11px] text-[var(--ds-muted)]">
                <Clock className="h-3 w-3 shrink-0" />
                <span className="truncate">{place.openingHours}</span>
              </p>
            )}
            {place.address && <p className="truncate text-[11px] text-[var(--ds-muted)]">{place.address}</p>}
          </div>
        )}

        {/* Actions — quiet glass buttons. */}
        <div className="mt-2 flex items-center gap-1.5">
          <a
            href={directions}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2 py-1 text-[11px] font-semibold text-[var(--ds-ink)] transition-colors duration-200 hover:bg-[var(--ds-hover)]"
          >
            <Navigation className="h-3 w-3 text-[var(--ds-accent)]" /> Directions
          </a>
          {place.website && (
            <a
              href={place.website}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2 py-1 text-[11px] font-semibold text-[var(--ds-muted)] transition-colors duration-200 hover:text-[var(--ds-ink)]"
            >
              <Globe className="h-3 w-3" /> Website
            </a>
          )}
        </div>
      </div>
    </li>
  );
};
