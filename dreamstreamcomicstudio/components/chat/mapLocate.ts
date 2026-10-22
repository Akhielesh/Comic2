// Shared "show my location" behaviour for the Leaflet maps (general map + directions).
// Kept in its own module — type-only Leaflet import — so the app's eager bundle never
// pulls Leaflet in; only code that already loaded Leaflet (and passes the `L` it has)
// runs this. Drops a Google-style blue "you are here" dot with a pulsing accuracy
// ring and eases the camera to it.

import type * as Leaflet from 'leaflet';

// User location is conventionally blue (distinct from the terracotta accent used for
// content pins/routes), and it's a fixed signal — not a theme token — so we hardcode it.
const LOCATE_BLUE = '#2D7FF9';

/** A pulsing "you are here" dot. The pulse ring + halo live in `.ds-locate-*` CSS. */
export const makeLocateDot = (L: typeof Leaflet): Leaflet.DivIcon =>
  L.divIcon({
    html: '<span class="ds-locate-dot"></span>',
    className: 'ds-locate-wrap',
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });

/**
 * Geolocate the user and reflect it on `map`: a blue dot + accuracy ring, then an eased
 * `flyTo` (instant under reduced motion). Resolves on success OR failure/denial — the
 * caller just wants its spinner to stop; we never throw or surface a scary error for a
 * declined permission. `layersRef` holds the previous dot/ring so repeated clicks replace
 * rather than stack them.
 */
export const locateOnMap = (
  L: typeof Leaflet,
  map: Leaflet.Map | null,
  layersRef: { current: Leaflet.Layer[] },
  reduceMotion: boolean
): Promise<void> =>
  new Promise((resolve) => {
    if (!map || typeof navigator === 'undefined' || !navigator.geolocation) return resolve();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // The map may have been torn down while the prompt was open.
        if (!map.getContainer || !map.getContainer().isConnected) return resolve();
        const { latitude, longitude, accuracy } = pos.coords;
        for (const layer of layersRef.current) layer.remove();
        layersRef.current = [];

        const radius = Math.min(Math.max(accuracy || 0, 20), 3000);
        const ring = L.circle([latitude, longitude], {
          radius,
          color: LOCATE_BLUE,
          weight: 1,
          opacity: 0.5,
          fillColor: LOCATE_BLUE,
          fillOpacity: 0.12,
          interactive: false
        }).addTo(map);
        const dot = L.marker([latitude, longitude], {
          icon: makeLocateDot(L),
          zIndexOffset: 1200,
          interactive: false,
          keyboard: false
        }).addTo(map);
        layersRef.current = [ring, dot];

        const zoom = Math.max(map.getZoom() ?? 13, 14);
        if (reduceMotion) map.setView([latitude, longitude], zoom);
        else map.flyTo([latitude, longitude], zoom, { duration: 1.1 });
        resolve();
      },
      () => resolve(),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 }
    );
  });
