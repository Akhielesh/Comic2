// Multi-modal directions — the "how do I get there?" experience, keyless.
//
// Pipeline: geocode origin + destination via Nominatim (same anchor approach as
// places.ts) → ask the FOSSGIS OSRM public instances (keyless, fair-use) for
// drive / bike / walk routes IN PARALLEL with alternatives → parse + downsample
// each geometry into a DirectionsArtifact the client renders as an animated
// route card. A mode that fails (timeout, out-of-coverage, 5xx) is simply
// omitted. Transit has no comparable open routing API, so the artifact carries
// a Google Maps transit deep link (`transitUrl`) instead.
//
// Public endpoints; the OSRM call goes through the metered fetchJson so the
// host is budget-guarded. Pure parsers/builders are unit-tested (directions.test.ts).

import type { DirectionsArtifact, DirectionsModeResult, DirectionsRoute } from '../../../../apiTypes.js';
import { fetchJson } from './http.js';
import { geocodeAnchor } from './places.js';

export type DirectionsMode = 'drive' | 'walk' | 'bike';

// Overridable for self-hosted OSRM (or proxies/test environments); the default
// is the FOSSGIS public instance.
const OSRM_BASE = process.env.OSRM_BASE_URL?.replace(/\/$/, '') || 'https://routing.openstreetmap.de';
// FOSSGIS selects the routing profile via the path PREFIX; the inner segment
// after /route/v1/ is always "driving" and is ignored by the server.
const MODE_PROFILES: Record<DirectionsMode, string> = {
  drive: 'routed-car',
  bike: 'routed-bike',
  walk: 'routed-foot'
};
const MODE_ORDER: DirectionsMode[] = ['drive', 'bike', 'walk'];
const OSRM_TIMEOUT_MS = 9_000;
/** Default uniform-stride cap (used by the standalone downsamplePath helper). */
const MAX_PATH_POINTS = 240;
/** Cap applied to a route AFTER shape-preserving simplification. High enough that a
 *  faithfully-simplified route is never re-decimated (Leaflet renders it fine); only
 *  pathological geometries hit the uniform-stride fallback. */
const MAX_RENDER_POINTS = 1200;
/** A walk this short (best route, minutes) makes 'walk' the default mode. */
const WALK_DEFAULT_MAX_MIN = 25;

/** OSRM route URL for one mode. `steps=true` because FOSSGIS only fills
 *  legs[].summary (the road names behind the "via …" labels) when steps are
 *  requested — verified live; with steps=false every summary comes back "".
 *  The parser ignores the step payloads themselves. */
export const buildOsrmUrl = (
  mode: DirectionsMode,
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): string =>
  `${OSRM_BASE}/${MODE_PROFILES[mode]}/route/v1/driving/` +
  `${from.lng},${from.lat};${to.lng},${to.lat}` +
  '?alternatives=true&overview=full&geometries=geojson&steps=true';

/** Universal cross-platform Google Maps directions link. */
export const buildGoogleMapsUrl = (from: string, to: string): string =>
  `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}`;

/** Same link pre-set to public transit (our honest "transit mode"). */
export const buildTransitUrl = (from: string, to: string): string =>
  `${buildGoogleMapsUrl(from, to)}&travelmode=transit`;

/** Uniform-stride downsample to ≤ maxPoints, always keeping the first and last
 *  point so the line still touches both pins. Pure. */
export const downsamplePath = (
  path: Array<[number, number]>,
  maxPoints = MAX_PATH_POINTS
): Array<[number, number]> => {
  if (path.length <= maxPoints) return path;
  const stride = Math.ceil((path.length - 1) / (maxPoints - 1));
  const out: Array<[number, number]> = [];
  for (let i = 0; i < path.length; i += stride) out.push(path[i]);
  const last = path[path.length - 1];
  const tail = out[out.length - 1];
  if (tail[0] !== last[0] || tail[1] !== last[1]) out.push(last);
  return out;
};

/** Perpendicular distance (planar lat/lng degrees) from point `p` to segment a→b.
 *  Good enough at city/route scale to drive the shape-preserving simplifier below. */
const perpDist = (p: [number, number], a: [number, number], b: [number, number]): number => {
  const dy = b[0] - a[0];
  const dx = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dy + (p[1] - a[1]) * dx) / (dy * dy + dx * dx);
  const cl = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + cl * dy), p[1] - (a[1] + cl * dx));
};

/** Ramer–Douglas–Peucker simplification — keeps every bend above `tolerance`
 *  (≈3 m by default) and the endpoints, dropping only redundant near-collinear
 *  points. This makes the drawn route FAITHFULLY hug the roads instead of cutting
 *  corners the way a blind uniform stride does. Iterative (no recursion blowups on
 *  long geometries). Pure. */
export const simplifyPath = (
  path: Array<[number, number]>,
  tolerance = 0.00003
): Array<[number, number]> => {
  if (path.length <= 2) return path;
  const keep = new Array<boolean>(path.length).fill(false);
  keep[0] = true;
  keep[path.length - 1] = true;
  const stack: Array<[number, number]> = [[0, path.length - 1]];
  while (stack.length) {
    const seg = stack.pop()!;
    const [s, e] = seg;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i += 1) {
      const d = perpDist(path[i], path[s], path[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tolerance && idx !== -1) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out: Array<[number, number]> = [];
  for (let i = 0; i < path.length; i += 1) if (keep[i]) out.push(path[i]);
  return out;
};

/** Parse an OSRM /route/v1 response into DirectionsRoutes (pure + testable).
 *  Converts GeoJSON [lng,lat] → Leaflet [lat,lng], rounds distance to 0.1 km and
 *  duration to whole minutes, downsamples geometry, and turns the legs' road-name
 *  summaries into a "via …" label when present. Invalid routes are dropped. */
export const parseOsrmRoutes = (json: any): DirectionsRoute[] => {
  if (!json || json.code !== 'Ok' || !Array.isArray(json.routes)) return [];
  const out: DirectionsRoute[] = [];
  for (const r of json.routes) {
    const coords = r?.geometry?.coordinates;
    if (!Array.isArray(coords)) continue;
    const path: Array<[number, number]> = [];
    for (const c of coords) {
      const lng = Number(c?.[0]);
      const lat = Number(c?.[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) path.push([lat, lng]);
    }
    const distance = Number(r?.distance);
    const duration = Number(r?.duration);
    if (path.length < 2 || !Number.isFinite(distance) || !Number.isFinite(duration)) continue;
    const legs: any[] = Array.isArray(r.legs) ? r.legs : [];
    const names = legs
      .map((l) => (typeof l?.summary === 'string' ? l.summary.trim() : ''))
      .filter(Boolean);
    const summary = names.length ? `via ${[...new Set(names)].join(', ')}` : undefined;
    out.push({
      ...(summary ? { summary } : {}),
      distanceKm: Math.round(distance / 100) / 10,
      durationMin: Math.max(1, Math.round(duration / 60)),
      // Shape-preserving simplify FIRST (faithful to the roads), then a high cap as a
      // safety net — never the blind 240-stride that cut corners on real routes.
      path: downsamplePath(simplifyPath(path), MAX_RENDER_POINTS)
    });
  }
  return out;
};

/** Google-style default: walk when it's a short walk, else drive, else whatever
 *  mode we actually have. Pure. */
export const pickDefaultMode = (modes: DirectionsModeResult[]): DirectionsMode | undefined => {
  const withRoutes = modes.filter((m) => m.routes.length > 0);
  if (withRoutes.length === 0) return undefined;
  const walk = withRoutes.find((m) => m.mode === 'walk');
  if (walk && Math.min(...walk.routes.map((r) => r.durationMin)) <= WALK_DEFAULT_MAX_MIN) return 'walk';
  if (withRoutes.some((m) => m.mode === 'drive')) return 'drive';
  return withRoutes[0].mode;
};

export interface GetDirectionsArgs {
  from: string;
  to: string;
  /** Preferred mode — pre-selects the card's tab when that mode routed. */
  mode?: DirectionsMode;
}

export const getDirections = async (
  args: GetDirectionsArgs,
  signal?: AbortSignal
): Promise<DirectionsArtifact> => {
  const from = (args.from || '').trim();
  const to = (args.to || '').trim();
  if (!from || !to) throw new Error('I need both a starting point and a destination for directions.');

  const [origin, destination] = await Promise.all([
    geocodeAnchor(from, signal).catch(() => null),
    geocodeAnchor(to, signal).catch(() => null)
  ]);
  if (signal?.aborted) throw new Error('Directions request was cancelled.');
  if (!origin) throw new Error(`Couldn't find "${from}" — try a more specific place name.`);
  if (!destination) throw new Error(`Couldn't find "${to}" — try a more specific place name.`);

  // All three modes in parallel; a failed mode is simply omitted.
  const results = await Promise.all(
    MODE_ORDER.map(async (mode): Promise<DirectionsModeResult | null> => {
      try {
        const json = await fetchJson(buildOsrmUrl(mode, origin, destination), {
          signal,
          timeoutMs: OSRM_TIMEOUT_MS
        });
        const routes = parseOsrmRoutes(json);
        return routes.length > 0 ? { mode, routes } : null;
      } catch (err) {
        if (signal?.aborted) throw err; // user cancel — don't mask it
        return null;
      }
    })
  );
  const modes = results.filter((m): m is DirectionsModeResult => m !== null);
  if (modes.length === 0) {
    throw new Error(
      `Couldn't get directions from ${origin.label} to ${destination.label} — the routing service returned no routes for any travel mode.`
    );
  }

  const preferred = args.mode && modes.some((m) => m.mode === args.mode) ? args.mode : undefined;
  return {
    origin: { label: origin.label, lat: origin.lat, lng: origin.lng },
    destination: { label: destination.label, lat: destination.lat, lng: destination.lng },
    modes,
    defaultMode: preferred ?? pickDefaultMode(modes),
    googleMapsUrl: buildGoogleMapsUrl(from, to),
    transitUrl: buildTransitUrl(from, to)
  };
};
