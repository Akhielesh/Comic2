// ============================================================================
// Google Maps connector (API key — NOT OAuth)
// ============================================================================
//
// The second connector in the v1 slice, here to PROVE the dual-auth abstraction:
// Maps authenticates with an API key (shared GOOGLE_MAPS_API_KEY or a user-supplied
// key), has no OAuth flow, and is query-on-demand (no background sync). It still
// produces normalized `record` items so its results feed analysis + dashboards.
// ============================================================================

import { ApiKeyConnector, type ApiKeyValidation } from '../base.js';
import { ConnectorRateLimitError } from '../types.js';
import type { ConnectorMetadata, FetchInput, NormalizedItem } from '../types.js';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const PLACES_TEXT_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';

interface MapsLatLng { lat: number; lng: number }
interface MapsResult {
  place_id?: string;
  name?: string;
  formatted_address?: string;
  rating?: number;
  types?: string[];
  geometry?: { location?: MapsLatLng };
}
interface MapsResponse {
  status?: string;
  error_message?: string;
  results?: MapsResult[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET a Maps endpoint with the key in the query, retrying transient quota/5xx. */
const mapsGet = async (
  url: string,
  key: string,
  query: Record<string, string>,
  signal?: AbortSignal
): Promise<MapsResponse> => {
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    u.searchParams.set('key', key);

    const res = await fetch(u.toString(), { signal });
    if (res.status >= 500) {
      if (attempt < maxRetries) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new Error(`Google Maps returned ${res.status}`);
    }
    const json = (await res.json()) as MapsResponse;
    // Maps signals throttling in the BODY with HTTP 200.
    if (json.status === 'OVER_QUERY_LIMIT') {
      if (attempt < maxRetries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw new ConnectorRateLimitError('Google Maps quota exceeded (OVER_QUERY_LIMIT)');
    }
    if (json.status === 'REQUEST_DENIED') {
      throw new Error(json.error_message || 'Google Maps request denied (check the API key + enabled APIs)');
    }
    return json;
  }
  throw new Error('Google Maps request failed');
};

export class GoogleMapsConnector extends ApiKeyConnector {
  readonly metadata: ConnectorMetadata = {
    id: 'google_maps',
    displayName: 'Google Maps',
    description: 'Geocoding and Places search via an API key — results feed analysis and dashboards (no account login).',
    icon: 'MapPin',
    category: 'maps',
    authType: 'api_key',
    requiredScopes: [],
    capabilities: { searchable: true, syncable: false, realtime: false, apiKeyBased: true },
    apiKeyEnv: 'GOOGLE_MAPS_API_KEY',
    userProvidesKey: true,
    docsUrl: 'https://developers.google.com/maps/documentation'
  };

  protected async validateKey(key: string): Promise<ApiKeyValidation> {
    try {
      const json = await mapsGet(GEOCODE_URL, key, { address: 'Googleplex, Mountain View, CA' });
      if (json.status === 'OK' || json.status === 'ZERO_RESULTS') {
        return { valid: true, accountIdentifier: 'google_maps', accountLabel: 'Google Maps (API key)' };
      }
      return { valid: false, reason: json.error_message || `Maps key check returned ${json.status}` };
    } catch (err) {
      return { valid: false, reason: (err as Error)?.message || 'Maps key validation failed' };
    }
  }

  async fetch(input: FetchInput): Promise<unknown> {
    const key = await input.getAccessToken();
    if (input.resource === 'geocode') {
      const json = await mapsGet(GEOCODE_URL, key, { address: String(input.params.address || '') }, input.signal);
      return { raw: json, items: this.normalize(json) };
    }
    if (input.resource === 'reverse_geocode') {
      const latlng = `${Number(input.params.lat)},${Number(input.params.lng)}`;
      const json = await mapsGet(GEOCODE_URL, key, { latlng }, input.signal);
      return { raw: json, items: this.normalize(json) };
    }
    if (input.resource === 'places') {
      const json = await mapsGet(PLACES_TEXT_URL, key, { query: String(input.params.query || '') }, input.signal);
      return { raw: json, items: this.normalize(json) };
    }
    throw new Error(`Unsupported Google Maps resource: ${input.resource}`);
  }

  normalize(raw: unknown): NormalizedItem[] {
    const results = Array.isArray(raw)
      ? (raw as MapsResult[])
      : ((raw as MapsResponse)?.results ?? []);
    return results.map((r) => {
      const externalId = r.place_id || r.formatted_address || `${r.geometry?.location?.lat},${r.geometry?.location?.lng}`;
      return {
        kind: 'record',
        externalId: String(externalId),
        title: r.name || r.formatted_address || 'Place',
        snippet: r.formatted_address || null,
        contentText: [r.name, r.formatted_address].filter(Boolean).join(' — ') || null,
        url: r.place_id ? `https://www.google.com/maps/place/?q=place_id:${r.place_id}` : null,
        author: null,
        occurredAt: null,
        payload: {
          placeId: r.place_id || null,
          location: r.geometry?.location || null,
          rating: typeof r.rating === 'number' ? r.rating : null,
          types: r.types || [],
          address: r.formatted_address || null
        }
      } satisfies NormalizedItem;
    });
  }
}
