// Geocoding via OpenStreetMap Nominatim — free, keyless. Turns place names into
// map markers for the map artifact. Nominatim asks for a descriptive User-Agent
// and light usage; we geocode a handful of places sequentially.
//
// Public endpoint — not runtime-verifiable in the sandbox; failures degrade.

import type { MapMarker } from '../../../../apiTypes.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = 'DreamStreamComicStudio/1.0 (chat maps tool)';

const geocodeOne = async (place: string, signal?: AbortSignal): Promise<MapMarker | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(
      `${NOMINATIM}?q=${encodeURIComponent(place)}&format=json&limit=1&addressdetails=0`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: controller.signal }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as any[];
    const hit = Array.isArray(rows) ? rows[0] : null;
    if (!hit) return null;
    const lat = Number(hit.lat);
    const lng = Number(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      lat,
      lng,
      label: place,
      description: typeof hit.display_name === 'string' ? hit.display_name : undefined
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

export const geocodePlaces = async (places: string[], signal?: AbortSignal): Promise<MapMarker[]> => {
  const markers: MapMarker[] = [];
  for (const place of places.slice(0, 8)) {
    const m = await geocodeOne(place, signal);
    if (m) markers.push(m);
  }
  return markers;
};
