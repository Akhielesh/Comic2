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
import { placeKind, PLACE_KIND_GLYPHS } from './artifacts/placeKinds';

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

// Accent teardrop pin as an inline-SVG divIcon — avoids bundler/asset issues with
// Leaflet's default PNG markers and matches the design accent. Pins are numbered for
// ordered trip stops; otherwise they show the place-category glyph (🍽️ 🏨 🌳 …) so a
// mixed map (eat / stay / see) reads at a glance.
const makePin = (color: string, n?: number, glyph?: string): L.DivIcon =>
  L.divIcon({
    html:
      `<svg width="28" height="38" viewBox="0 0 28 38" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,0.3))">` +
      `<path d="M14 0C6.3 0 0 6.2 0 13.9 0 24.3 14 38 14 38s14-13.7 14-24.1C28 6.2 21.7 0 14 0z" fill="${color}"/>` +
      `<circle cx="14" cy="14" r="8.5" fill="#fff"/>` +
      (typeof n === 'number'
        ? `<text x="14" y="18.5" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" font-weight="700" fill="${color}">${n}</text>`
        : glyph
          ? `<text x="14" y="18" text-anchor="middle" font-size="10">${glyph}</text>`
          : `<circle cx="14" cy="14" r="3.5" fill="${color}"/>`) +
      `</svg>`,
    className: 'ds-map-pin',
    iconSize: [28, 38],
    iconAnchor: [14, 38],
    popupAnchor: [0, -34]
  });

// Haversine length of a route in km — the honest "≈ distance" when the artifact
// didn't carry one (we have no routing API; straight-line legs, clearly marked ≈).
const routeKm = (pts: { lat: number; lng: number }[]): number => {
  let km = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    km += 6371 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }
  return km;
};

// Rough door-to-door speed (km/h) per mode for the ≈duration estimate.
const MODE_SPEEDS: Record<string, number> = { walk: 4.5, transit: 22, train: 80, bus: 45, drive: 75, car: 75, ferry: 28, flight: 700 };
const MODE_GLYPHS: Record<string, string> = { walk: '🚶', transit: '🚇', train: '🚆', bus: '🚌', drive: '🚗', car: '🚗', ferry: '⛴️', flight: '✈️' };

const fmtDuration = (min: number): string => {
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
};

// A leading "3." / "12 — " in a marker label is the visit order — pull it out for the pin.
const leadingNumber = (label: string): number | undefined => {
  const m = label.match(/^\s*(\d{1,2})\s*[.)\-—:]/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 && n < 100 ? n : undefined;
};

const MapPanel: React.FC<{ data: MapArtifact }> = ({ data }) => {
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
    const markers = data.markers.map((m) => {
      const marker = L.marker([m.lat, m.lng], {
        icon: makePin(accent, leadingNumber(m.label), m.category ? PLACE_KIND_GLYPHS[placeKind(m.category)] : undefined)
      })
        .addTo(map)
        .bindPopup(
          `<div class="ds-map-pop"><b>${escapeHtml(m.label)}</b>${m.description ? `<span>${escapeHtml(m.description)}</span>` : ''}</div>`
        );
      return { marker, label: m.label };
    });

    // Zoom-aware detail: once the user zooms in past street level, every pin grows a
    // small permanent name label, so close-up exploration doesn't need popup clicks.
    let labelsOn = false;
    const syncLabels = () => {
      const want = map.getZoom() >= 14;
      if (want === labelsOn) return;
      labelsOn = want;
      for (const { marker, label } of markers) {
        marker.unbindTooltip();
        if (want) {
          marker.bindTooltip(escapeHtml(label.replace(/^\s*\d{1,2}\s*[.)\-—:]\s*/, '')), {
            permanent: true,
            direction: 'right',
            offset: [10, -22],
            className: 'ds-map-label'
          });
        }
      }
    };
    map.on('zoomend', syncLabels);
    syncLabels();

    if (data.route && data.route.length > 1) {
      const pts = data.route.map((p) => [p.lat, p.lng] as [number, number]);
      // Soft halo under a solid accent line — reads cleanly on both light and dark tiles.
      L.polyline(pts, { color: '#ffffff', weight: 7, opacity: 0.55, lineCap: 'round', lineJoin: 'round' }).addTo(map);
      L.polyline(pts, { color: accent, weight: 3.5, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(map);
    }

    // Route summary chip — the user's mode (drive/walk/transit) with ≈time, distance
    // and tolls. Uses the artifact's routeInfo when present; otherwise estimates from
    // the drawn route's length and the mode's rough speed (clearly marked ≈).
    if ((data.route && data.route.length > 1) || data.routeInfo) {
      const info = data.routeInfo ?? {};
      const km = typeof info.distanceKm === 'number' ? info.distanceKm : data.route ? routeKm(data.route) : undefined;
      const mode = (info.mode || '').toLowerCase();
      const mins =
        typeof info.durationMin === 'number'
          ? info.durationMin
          : km !== undefined && MODE_SPEEDS[mode]
            ? (km / MODE_SPEEDS[mode]) * 60
            : undefined;
      const bits = [
        mode ? `${MODE_GLYPHS[mode] ?? ''} ${mode[0].toUpperCase()}${mode.slice(1)}`.trim() : null,
        mins !== undefined ? `≈ ${fmtDuration(mins)}` : null,
        km !== undefined ? `${km >= 100 ? Math.round(km) : km.toFixed(1)} km` : null,
        info.tollCost || null
      ].filter(Boolean);
      if (bits.length) {
        const RouteChip = L.Control.extend({
          options: { position: 'bottomleft' as const },
          onAdd: () => {
            const el = L.DomUtil.create('div', 'ds-map-route-chip');
            el.innerHTML = bits.map((b) => `<span>${escapeHtml(String(b))}</span>`).join('<i></i>');
            return el;
          }
        });
        map.addControl(new RouteChip());
      }
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

  return <div ref={elRef} className="ds-map w-full h-full" />;
};

export default MapPanel;
