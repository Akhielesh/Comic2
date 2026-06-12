import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Bike, Car, ExternalLink, Footprints, Loader2, TramFront } from 'lucide-react';
import type * as Leaflet from 'leaflet';
import type { DirectionsArtifact, DirectionsModeResult, DirectionsRoute } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact } from './kit';

// Google-Maps-feeling directions card in the calm-studio glass language.
//  • compact — a glance card: origin → destination, mode pills with per-mode ETAs,
//    and the big "18 min" line. No map.
//  • detailed — mode pills (drive/bike/walk + a Transit deep link), the primary
//    route's big stat row, a lazy Leaflet map (CARTO basemap, Google-style origin
//    dot + accent teardrop destination pin) where the primary route DRAWS ITSELF
//    from origin to destination (~700 ms, eased rAF), muted clickable alternative
//    polylines, an alternatives list, and an "Open in Google Maps" footer.

type TravelMode = DirectionsModeResult['mode'];

const MODE_ORDER: TravelMode[] = ['drive', 'bike', 'walk'];
const MODE_META: Record<TravelMode, { label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  drive: { label: 'Drive', Icon: Car },
  bike: { label: 'Bike', Icon: Bike },
  walk: { label: 'Walk', Icon: Footprints }
};

const fmtDuration = (min: number): string => {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h} hr ${m} min` : `${h} hr`;
};
/** Short form for the mode pills, like Google's chips ("12 min", "1h 5m"). */
const fmtDurationShort = (min: number): string => {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
};
const fmtKm = (km: number): string => `${km >= 100 ? Math.round(km) : km.toFixed(1)} km`;

const bestMinutes = (m: DirectionsModeResult): number =>
  Math.min(...m.routes.map((r) => r.durationMin));

// ---------------------------------------------------------------- map (lazy) ----
// Same lazy-Leaflet pattern as InlineMap/MapPanel: Leaflet ships as its own chunk
// and only loads when the detailed card actually renders a map.

const isDark = (): boolean =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
};
const TILE_ATTRIBUTION = '© OpenStreetMap · © CARTO · OSRM';

const cssVar = (name: string, fallback: string): string => {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const DRAW_MS = 700;
const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface DirectionsMapProps {
  origin: DirectionsArtifact['origin'];
  destination: DirectionsArtifact['destination'];
  /** All routes for the active mode; `selected` is drawn as the animated primary. */
  routes: DirectionsRoute[];
  selected: number;
  onSelect: (index: number) => void;
}

const createDirectionsMap = (L: typeof Leaflet): React.FC<DirectionsMapProps> => {
  // Accent teardrop destination pin (MapPanel's custom-pin approach) and a small
  // Google-style origin dot, both inline-SVG divIcons.
  const destinationPin = (color: string): Leaflet.DivIcon =>
    L.divIcon({
      html:
        `<svg width="28" height="38" viewBox="0 0 28 38" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,0.3))">` +
        `<path d="M14 0C6.3 0 0 6.2 0 13.9 0 24.3 14 38 14 38s14-13.7 14-24.1C28 6.2 21.7 0 14 0z" fill="${color}"/>` +
        `<circle cx="14" cy="14" r="8.5" fill="#fff"/>` +
        `<circle cx="14" cy="14" r="3.5" fill="${color}"/>` +
        `</svg>`,
      className: 'ds-map-pin',
      iconSize: [28, 38],
      iconAnchor: [14, 38]
    });
  const originDot = (ring: string): Leaflet.DivIcon =>
    L.divIcon({
      html:
        `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,0.3))">` +
        `<circle cx="8" cy="8" r="6" fill="#fff" stroke="${ring}" stroke-width="3"/>` +
        `</svg>`,
      className: 'ds-map-pin',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });

  const DirectionsMap: React.FC<DirectionsMapProps> = ({ origin, destination, routes, selected, onSelect }) => {
    const elRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<Leaflet.Map | null>(null);
    const routeLayersRef = useRef<Leaflet.Layer[]>([]);
    const rafRef = useRef(0);
    const onSelectRef = useRef(onSelect);
    onSelectRef.current = onSelect;

    // Map + endpoint pins (rebuilt only when the endpoints change).
    useEffect(() => {
      if (!elRef.current) return;
      const map = L.map(elRef.current, { scrollWheelZoom: true, zoomControl: true, attributionControl: true });
      mapRef.current = map;
      L.tileLayer(isDark() ? TILES.dark : TILES.light, {
        attribution: TILE_ATTRIBUTION,
        maxZoom: 20,
        detectRetina: true
      }).addTo(map);

      L.marker([origin.lat, origin.lng], { icon: originDot(cssVar('--ds-ink', '#3d3929')), zIndexOffset: 100 })
        .addTo(map)
        .bindTooltip(escapeHtml(origin.label), { direction: 'top', offset: [0, -8], className: 'ds-map-label' });
      L.marker([destination.lat, destination.lng], { icon: destinationPin(cssVar('--ds-accent', '#D97757')), zIndexOffset: 200 })
        .addTo(map)
        .bindTooltip(escapeHtml(destination.label), { direction: 'top', offset: [0, -34], className: 'ds-map-label' });

      // Keep the map sized to its (resizable) container.
      const ro = new ResizeObserver(() => map.invalidateSize());
      ro.observe(elRef.current);
      const t = window.setTimeout(() => map.invalidateSize(), 200);
      return () => {
        ro.disconnect();
        window.clearTimeout(t);
        map.remove();
        mapRef.current = null;
      };
    }, [origin.lat, origin.lng, origin.label, destination.lat, destination.lng, destination.label]);

    // Fit to the whole mode's route family (not on alternative clicks, so promoting
    // a route doesn't yank the camera around).
    useEffect(() => {
      const map = mapRef.current;
      if (!map) return;
      const pts: Array<[number, number]> = [
        [origin.lat, origin.lng],
        [destination.lat, destination.lng]
      ];
      for (const r of routes) pts.push(...r.path);
      map.fitBounds(L.latLngBounds(pts), { padding: [28, 28] });
    }, [routes, origin.lat, origin.lng, destination.lat, destination.lng]);

    // Route layers: muted clickable alternatives under an animated accent primary
    // that progressively draws origin → destination (eased rAF slicing the path).
    useEffect(() => {
      const map = mapRef.current;
      if (!map) return;
      cancelAnimationFrame(rafRef.current);
      for (const layer of routeLayersRef.current) layer.remove();
      routeLayersRef.current = [];

      const accent = cssVar('--ds-accent', '#D97757');
      const muted = cssVar('--ds-muted', '#83827d');

      routes.forEach((r, i) => {
        if (i === selected) return;
        const alt = L.polyline(r.path, { color: muted, weight: 3, opacity: 0.45, lineCap: 'round', lineJoin: 'round' }).addTo(map);
        // A fat transparent twin makes the hairline easy to click/tap.
        const hit = L.polyline(r.path, { color: muted, weight: 16, opacity: 0.001 }).addTo(map);
        for (const line of [alt, hit]) line.on('click', () => onSelectRef.current(i));
        routeLayersRef.current.push(alt, hit);
      });

      const primary = routes[selected] ?? routes[0];
      if (!primary || primary.path.length < 2) return;
      const path = primary.path;
      // Soft halo under a solid accent line — reads on both light and dark tiles.
      const halo = L.polyline([], { color: '#ffffff', weight: 7, opacity: 0.55, lineCap: 'round', lineJoin: 'round' }).addTo(map);
      const line = L.polyline([], { color: accent, weight: 4, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(map);
      routeLayersRef.current.push(halo, line);

      const reduceMotion =
        typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (reduceMotion) {
        halo.setLatLngs(path);
        line.setLatLngs(path);
        return;
      }
      const started = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - started) / DRAW_MS);
        const slice = path.slice(0, Math.max(2, Math.round(easeInOutCubic(t) * path.length)));
        halo.setLatLngs(slice);
        line.setLatLngs(slice);
        if (t < 1) rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
      return () => cancelAnimationFrame(rafRef.current);
    }, [routes, selected]);

    return <div ref={elRef} className="ds-map h-full w-full" />;
  };
  return DirectionsMap;
};

const DirectionsMapLazy = lazy(async () => {
  const [leafletModule] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
  const L = (leafletModule as { default?: typeof Leaflet }).default ?? leafletModule;
  return { default: createDirectionsMap(L) };
});

// ---------------------------------------------------------------------- card ----

export const DirectionsCard: React.FC<{ data: DirectionsArtifact }> = ({ data }) => {
  const compact = useCompact();

  // Modes in stable drive/bike/walk order, hiding any that failed server-side.
  const modes = useMemo(
    () =>
      MODE_ORDER.map((m) => (data.modes ?? []).find((x) => x.mode === m)).filter(
        (m): m is DirectionsModeResult => !!m && m.routes.length > 0
      ),
    [data.modes]
  );

  const [mode, setMode] = useState<TravelMode | undefined>(() =>
    data.defaultMode && modes.some((m) => m.mode === data.defaultMode) ? data.defaultMode : modes[0]?.mode
  );
  const [selected, setSelected] = useState(0);

  const current = modes.find((m) => m.mode === mode) ?? modes[0];
  const routes = current?.routes ?? [];
  const selIdx = Math.min(selected, Math.max(0, routes.length - 1));
  const route = routes[selIdx];

  const pickMode = (m: TravelMode): void => {
    setMode(m);
    setSelected(0); // switching modes re-animates the primary draw from route 0
  };

  const header = (
    <>
      <SurfaceTitle className="flex items-center gap-1.5">
        <span className="min-w-0 truncate">{data.origin.label}</span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" />
        <span className="min-w-0 truncate">{data.destination.label}</span>
      </SurfaceTitle>
      <SurfaceSubtitle>Directions</SurfaceSubtitle>
    </>
  );

  const modePills = (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Travel mode">
      {modes.map((m) => {
        const active = current?.mode === m.mode;
        const { label, Icon } = MODE_META[m.mode];
        return (
          <button
            key={m.mode}
            onClick={() => pickMode(m.mode)}
            aria-pressed={active}
            title={label}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tabular-nums transition-colors duration-200 ${
              active
                ? 'border-[#D97757]/35 bg-[#D97757]/10 text-[var(--ds-accent)]'
                : 'border-[var(--ds-hairline)] text-[var(--ds-muted)] hover:bg-[var(--ds-well)]'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {fmtDurationShort(bestMinutes(m))}
          </button>
        );
      })}
      {data.transitUrl && (
        <a
          href={data.transitUrl}
          target="_blank"
          rel="noreferrer"
          title="Transit directions on Google Maps"
          className="flex items-center gap-1.5 rounded-full border border-[var(--ds-hairline)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ds-muted)] transition-colors duration-200 hover:bg-[var(--ds-well)] hover:text-[var(--ds-ink)]"
        >
          <TramFront className="h-3.5 w-3.5" />
          Transit
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );

  const footer = data.googleMapsUrl && (
    <a
      href={data.googleMapsUrl}
      target="_blank"
      rel="noreferrer"
      className="flex items-center justify-center gap-1 text-[11px] font-semibold text-[var(--ds-muted)] transition-colors duration-200 hover:text-[var(--ds-ink)]"
    >
      Open in Google Maps <ExternalLink className="h-3 w-3" />
    </a>
  );

  // No mode routed at all — stay honest and still give the escape hatch.
  if (!current || !route) {
    return (
      <Surface header={header} footer={footer}>
        <div className="px-3 pb-3 text-xs text-[var(--ds-muted)]">No routes found between these places.</div>
      </Surface>
    );
  }

  // ── Compact: mode pills + the big ETA line — a glance card. ──────────────────
  if (compact) {
    return (
      <Surface header={header}>
        <div className="space-y-2 px-3 pb-3">
          {modePills}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-4xl font-semibold leading-none tracking-tight text-[var(--ds-ink)] tabular-nums">
              {fmtDuration(route.durationMin)}
            </span>
            <span className="text-sm font-medium text-[var(--ds-muted)] tabular-nums">{fmtKm(route.distanceKm)}</span>
            {route.summary && <span className="min-w-0 truncate text-xs text-[var(--ds-muted)]">{route.summary}</span>}
          </div>
        </div>
      </Surface>
    );
  }

  // ── Detailed: pills, big stat row, animated map, alternatives, footer link. ──
  return (
    <Surface header={header} footer={footer}>
      <div className="px-3 pb-2">{modePills}</div>

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 pb-2.5">
        <span className="text-4xl font-semibold leading-none tracking-tight text-[var(--ds-ink)] tabular-nums">
          {fmtDuration(route.durationMin)}
        </span>
        <span className="text-sm font-medium text-[var(--ds-muted)] tabular-nums">{fmtKm(route.distanceKm)}</span>
        {route.summary && <span className="min-w-0 truncate text-xs text-[var(--ds-muted)]">{route.summary}</span>}
      </div>

      <div
        className="relative mx-3 overflow-hidden rounded-xl border border-[var(--ds-hairline)] ring-1 ring-[var(--ds-hairline-soft)]"
        style={{ height: 248 }}
      >
        <Suspense
          fallback={
            <div className="flex h-full w-full items-center justify-center bg-[var(--ds-well)]">
              <Loader2 className="h-5 w-5 animate-spin text-[var(--ds-muted)]" />
            </div>
          }
        >
          <DirectionsMapLazy
            origin={data.origin}
            destination={data.destination}
            routes={routes}
            selected={selIdx}
            onSelect={setSelected}
          />
        </Suspense>
      </div>

      {routes.length > 1 && (
        <div className="mx-3 mt-2 overflow-hidden rounded-xl border border-[var(--ds-hairline-soft)]">
          {routes.map((r, i) => {
            const active = i === selIdx;
            return (
              <button
                key={i}
                onClick={() => setSelected(i)}
                aria-pressed={active}
                className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs transition-colors duration-200 ${
                  i > 0 ? 'border-t border-[var(--ds-hairline-soft)]' : ''
                } ${active ? 'bg-[#D97757]/10' : 'hover:bg-[var(--ds-well)]'}`}
              >
                <span className={`min-w-0 truncate font-medium ${active ? 'text-[var(--ds-ink)]' : 'text-[var(--ds-muted)]'}`}>
                  {r.summary || (i === 0 ? 'Fastest route' : `Route ${i + 1}`)}
                </span>
                <span className="shrink-0 tabular-nums">
                  <span className={`font-semibold ${active ? 'text-[var(--ds-accent)]' : 'text-[var(--ds-ink)]'}`}>
                    {fmtDuration(r.durationMin)}
                  </span>
                  <span className="text-[var(--ds-muted)]"> · {fmtKm(r.distanceKm)}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div className="pb-3" />
    </Surface>
  );
};
