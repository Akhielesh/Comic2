// Lazy-loaded Leaflet map (free OpenStreetMap tiles, no API key). Plain Leaflet —
// no react-leaflet — to avoid React-version peer issues. Imported via React.lazy
// so Leaflet ships as its own chunk only when a map is opened.

import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { MapArtifact } from '../../apiTypes';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Emoji pin via divIcon — avoids bundler/asset issues with Leaflet's default PNG icons.
const pinIcon = L.divIcon({
  html: '<div style="font-size:24px;line-height:24px">📍</div>',
  className: 'ds-map-pin',
  iconSize: [24, 24],
  iconAnchor: [12, 24],
  popupAnchor: [0, -24]
});

const MapPanel: React.FC<{ data: MapArtifact }> = ({ data }) => {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    const map = L.map(elRef.current, { scrollWheelZoom: true });
    mapRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);

    const latlngs: [number, number][] = data.markers.map((m) => [m.lat, m.lng]);
    data.markers.forEach((m) => {
      L.marker([m.lat, m.lng], { icon: pinIcon })
        .addTo(map)
        .bindPopup(`<b>${escapeHtml(m.label)}</b>${m.description ? `<br/>${escapeHtml(m.description)}` : ''}`);
    });

    if (data.route && data.route.length > 1) {
      L.polyline(data.route.map((p) => [p.lat, p.lng] as [number, number]), { color: '#3b82f6', weight: 4 }).addTo(map);
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
    // Initial size settle after mount/animation.
    const t = window.setTimeout(() => map.invalidateSize(), 200);

    return () => {
      ro.disconnect();
      window.clearTimeout(t);
      map.remove();
      mapRef.current = null;
    };
  }, [data]);

  return <div ref={elRef} className="w-full h-full" />;
};

export default MapPanel;
