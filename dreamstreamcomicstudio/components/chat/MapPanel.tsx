// Lazy-loaded Leaflet map. Plain Leaflet (no react-leaflet) to avoid React-version
// peer issues; imported via React.lazy so Leaflet ships as its own chunk only when a
// map is opened.
//
// Styling: the raw OpenStreetMap raster (busy, saturated) is replaced with CARTO's
// minimal basemaps — Positron in light, Dark Matter in dark — so the map reads as part
// of the calm studio language and flips with the theme. Markers are accent teardrop
// pins (numbered for ordered trips), the route uses the terracotta accent, and the
// popups/zoom controls are restyled via the .ds-map-* rules in index.css.

import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { MapArtifact } from '../../apiTypes';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const isDark = (): boolean =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
};
const TILE_ATTRIBUTION = '© OpenStreetMap · © CARTO';

const accentColor = (): string => {
  if (typeof document === 'undefined') return '#D97757';
  const v = getComputedStyle(document.documentElement).getPropertyValue('--ds-accent').trim();
  return v || '#D97757';
};

// Accent teardrop pin (optionally numbered) as an inline-SVG divIcon — avoids
// bundler/asset issues with Leaflet's default PNG markers and matches the design accent.
const makePin = (color: string, n?: number): L.DivIcon =>
  L.divIcon({
    html:
      `<svg width="28" height="38" viewBox="0 0 28 38" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,0.3))">` +
      `<path d="M14 0C6.3 0 0 6.2 0 13.9 0 24.3 14 38 14 38s14-13.7 14-24.1C28 6.2 21.7 0 14 0z" fill="${color}"/>` +
      `<circle cx="14" cy="14" r="8.5" fill="#fff"/>` +
      (typeof n === 'number'
        ? `<text x="14" y="18.5" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" font-weight="700" fill="${color}">${n}</text>`
        : `<circle cx="14" cy="14" r="3.5" fill="${color}"/>`) +
      `</svg>`,
    className: 'ds-map-pin',
    iconSize: [28, 38],
    iconAnchor: [14, 38],
    popupAnchor: [0, -34]
  });

// A leading "3." / "12 — " in a marker label is the visit order — pull it out for the pin.
const leadingNumber = (label: string): number | undefined => {
  const m = label.match(/^\s*(\d{1,2})\s*[.)\-—:]/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 && n < 100 ? n : undefined;
};

// RainViewer live precipitation radar (free, attribution required). The frames
// index is fetched once per session; the newest "past" frame is the live layer.
let radarPathPromise: Promise<string | null> | null = null;
const latestRadarPath = (): Promise<string | null> => {
  if (!radarPathPromise) {
    radarPathPromise = fetch('https://api.rainviewer.com/public/weather-maps.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const past = d?.radar?.past;
        return Array.isArray(past) && past.length ? String(past[past.length - 1].path) : null;
      })
      .catch(() => null);
  }
  return radarPathPromise;
};

const MapPanel: React.FC<{ data: MapArtifact; radar?: boolean }> = ({ data, radar }) => {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    const map = L.map(elRef.current, { scrollWheelZoom: true, zoomControl: true, attributionControl: true });
    mapRef.current = map;

    const tiles = L.tileLayer(isDark() ? TILES.dark : TILES.light, {
      attribution: TILE_ATTRIBUTION,
      maxZoom: 20,
      // CARTO serves @2x retina tiles via the {r} placeholder for crisp rendering.
      detectRetina: true
    }).addTo(map);

    // Swap basemap live when the app theme flips (so an open map isn't stuck light-on-dark).
    const themeObserver = new MutationObserver(() => tiles.setUrl(isDark() ? TILES.dark : TILES.light));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    const accent = accentColor();
    const latlngs: [number, number][] = data.markers.map((m) => [m.lat, m.lng]);
    data.markers.forEach((m) => {
      L.marker([m.lat, m.lng], { icon: makePin(accent, leadingNumber(m.label)) })
        .addTo(map)
        .bindPopup(
          `<div class="ds-map-pop"><b>${escapeHtml(m.label)}</b>${m.description ? `<span>${escapeHtml(m.description)}</span>` : ''}</div>`
        );
    });

    if (data.route && data.route.length > 1) {
      const pts = data.route.map((p) => [p.lat, p.lng] as [number, number]);
      // Soft halo under a solid accent line — reads cleanly on both light and dark tiles.
      L.polyline(pts, { color: '#ffffff', weight: 7, opacity: 0.55, lineCap: 'round', lineJoin: 'round' }).addTo(map);
      L.polyline(pts, { color: accent, weight: 3.5, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(map);
    }

    if (latlngs.length === 1) {
      map.setView(latlngs[0], 13);
    } else if (latlngs.length > 1) {
      map.fitBounds(L.latLngBounds(latlngs).pad(0.2));
    } else {
      map.setView([20, 0], 2);
    }

    // Keep the map sized to its (resizable) container.
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(elRef.current);
    const t = window.setTimeout(() => map.invalidateSize(), 200);

    return () => {
      themeObserver.disconnect();
      ro.disconnect();
      window.clearTimeout(t);
      map.remove();
      mapRef.current = null;
    };
  }, [data]);

  // Weather radar overlay. Declared AFTER the map effect so that on a `data` change
  // (map rebuilt) this re-runs against the NEW map instance, not the removed one.
  useEffect(() => {
    if (!radar) return;
    let layer: L.TileLayer | null = null;
    let cancelled = false;
    void latestRadarPath().then((path) => {
      if (cancelled || !path || !mapRef.current) return;
      layer = L.tileLayer(`https://tilecache.rainviewer.com${path}/256/{z}/{x}/{y}/2/1_1.png`, {
        opacity: 0.7,
        attribution: '© RainViewer'
      }).addTo(mapRef.current);
    });
    return () => {
      cancelled = true;
      if (layer && mapRef.current) mapRef.current.removeLayer(layer);
    };
  }, [radar, data]);

  return <div ref={elRef} className="ds-map w-full h-full" />;
};

export default MapPanel;
