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

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Quadratic-bezier arc between two points (planar lat/lng — for visualization, not
// geodesy). Bows perpendicular to the chord so flights / long hops read as curves.
const buildArc = (a: { lat: number; lng: number }, b: { lat: number; lng: number }, curvature = 0.22, samples = 48): [number, number][] => {
  const dLat = b.lat - a.lat;
  const dLng = b.lng - a.lng;
  const dist = Math.hypot(dLat, dLng);
  if (dist === 0) return [[a.lat, a.lng]];
  const mLat = (a.lat + b.lat) / 2;
  const mLng = (a.lng + b.lng) / 2;
  const nLat = -dLng / dist;
  const nLng = dLat / dist;
  const off = dist * curvature;
  const cLat = mLat + nLat * off;
  const cLng = mLng + nLng * off;
  const out: [number, number][] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const inv = 1 - t;
    out.push([inv * inv * a.lat + 2 * inv * t * cLat + t * t * b.lat, inv * inv * a.lng + 2 * inv * t * cLng + t * t * b.lng]);
  }
  return out;
};

// Stroke-dash "draw-in" for a Leaflet polyline's SVG path, sequenced via `delayMs`
// so a multi-leg trip route paints leg by leg. No-op under reduced motion.
const animateDraw = (poly: L.Polyline, delayMs: number): void => {
  if (prefersReducedMotion()) return;
  const path = poly.getElement() as SVGPathElement | null;
  if (!path || typeof path.getTotalLength !== 'function') return;
  const len = path.getTotalLength();
  if (!len || !Number.isFinite(len)) return;
  path.animate(
    [
      { strokeDasharray: String(len), strokeDashoffset: String(len) },
      { strokeDasharray: String(len), strokeDashoffset: '0' }
    ],
    { duration: 700, delay: delayMs, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'backwards' }
  );
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
    const markers = data.markers.map((m) => {
      const marker = L.marker([m.lat, m.lng], {
        icon: makePin(m.color || accent, leadingNumber(m.label), m.category ? PLACE_KIND_GLYPHS[placeKind(m.category)] : undefined)
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
      const line = L.polyline(pts, { color: accent, weight: 3.5, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(map);
      animateDraw(line, 0);
    }

    // Multi-segment route — day-by-day colored legs and curved flight arcs. Each leg
    // draws in after the previous one so the trip "unfolds"; a color legend names them.
    if (data.segments && data.segments.length) {
      data.segments.forEach((seg, i) => {
        if (!seg.points || seg.points.length < 1) return;
        const pts: [number, number][] =
          seg.arc && seg.points.length >= 2
            ? buildArc(seg.points[0], seg.points[seg.points.length - 1])
            : seg.points.map((p) => [p.lat, p.lng] as [number, number]);
        if (pts.length < 2) return;
        const color = seg.color || accent;
        const dash = seg.dashed || seg.arc ? '6 8' : undefined;
        L.polyline(pts, { color: '#ffffff', weight: 6, opacity: 0.4, lineCap: 'round', lineJoin: 'round' }).addTo(map);
        const line = L.polyline(pts, { color, weight: 3.5, opacity: 0.95, lineCap: 'round', lineJoin: 'round', dashArray: dash }).addTo(map);
        animateDraw(line, i * 220);
      });

      const labeled = data.segments.filter((s) => s.label);
      if (labeled.length > 1) {
        const Legend = L.Control.extend({
          options: { position: 'topright' as const },
          onAdd: () => {
            const el = L.DomUtil.create('div', 'ds-map-legend');
            el.setAttribute(
              'style',
              'background:var(--ds-surface-strong);border:1px solid var(--ds-hairline);border-radius:10px;padding:5px 8px;font:600 11px/1.5 ui-sans-serif,system-ui,sans-serif;color:var(--ds-ink);backdrop-filter:blur(8px);box-shadow:0 1px 2px rgba(0,0,0,0.06);display:flex;flex-direction:column;gap:3px;max-width:170px;'
            );
            el.innerHTML = labeled
              .map(
                (s) =>
                  `<span style="display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><i style="width:10px;height:10px;border-radius:9999px;background:${s.color || accent};display:inline-block;flex:none"></i>${escapeHtml(String(s.label))}</span>`
              )
              .join('');
            L.DomEvent.disableClickPropagation(el);
            return el;
          }
        });
        map.addControl(new Legend());
      }
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

    // Frame everything that's drawn — markers AND every segment point (so a flight
    // arc bowing out of the marker cluster isn't clipped).
    const segPts: [number, number][] = (data.segments ?? []).flatMap((s) => s.points.map((p) => [p.lat, p.lng] as [number, number]));
    const fitPts = [...latlngs, ...segPts];
    if (fitPts.length === 1) {
      map.setView(fitPts[0], 13);
    } else if (fitPts.length > 1) {
      map.fitBounds(L.latLngBounds(fitPts).pad(0.2));
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
