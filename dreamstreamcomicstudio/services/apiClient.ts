import { buildApiUrl } from './clientConfig';
import { getFluxKeyInfo, getOpenRouterKey } from './appSettings';
import { getActiveKeyValue } from './apiKeys';
import { getSelectedTextModel, getModelForStage, getSelectedTextSource, getSourceForStage } from './modelSelection';
import { supabase } from './supabase';
import { isFreeOnly } from './freeOnlyMode';
import { isProviderEnabled, allowedSourcesHeader } from './sourceGovernance';
import { PROVIDERS_ORDERED } from '../shared/providers';
import { withRetry, type RetryOptions } from './retry';
import { isRetryableError } from './apiErrors';
import { appStatus } from './appStatus';

let cachedAccessToken: string | undefined;

// Keep token fresh in memory to avoid redundant storage reads
supabase.auth.onAuthStateChange((_event, session) => {
  cachedAccessToken = session?.access_token;
});

const getGeminiKey = () => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem('dreamstream_api_key');
  } catch {
    return null;
  }
};

// Resolve the BYOK header for every enabled text provider from the shared registry, so a
// key the user added for ANY provider is attached to requests (honoring governance). The
// original providers keep their legacy single-key fallbacks. Image-only providers
// (pixazo/ideogram) are attached separately by the callers.
const providerKeyHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const def of PROVIDERS_ORDERED) {
    if (!isProviderEnabled(def.id)) continue;
    let key = getActiveKeyValue(def.id);
    if (!key && def.id === 'openrouter') key = getOpenRouterKey();
    if (!key && def.id === 'gemini') key = getGeminiKey();
    if (key) headers[def.header] = key;
  }
  return headers;
};

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const parseError = async (res: Response) => {
  try {
    const data = await res.json();
    const message = data?.error?.message || res.statusText;
    return new ApiError(message, res.status, data?.error?.details ?? data);
  } catch {
    return new ApiError(res.statusText, res.status);
  }
};

/**
 * `fetch` rejects with a TypeError ("Failed to fetch" / "NetworkError" / "Load failed")
 * when the request never reaches the server — the usual culprits are a CORS block, a wrong
 * or empty `VITE_API_BASE_URL`, mixed http/https content, or the backend being asleep/down.
 * Browsers deliberately hide the detail, so we turn that opaque failure into one actionable
 * message (status 0) instead of a bare "network error" the user can't act on. User-initiated
 * aborts are rethrown untouched so callers can detect cancellation.
 */
const safeFetch = async (url: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if ((err as Error)?.name === 'AbortError') throw err;
    const target = url || 'the API server';
    // Surface "backend unreachable" in the in-app status bar — this is the failure users
    // hit most and can't otherwise see without the DevTools console/network tab.
    appStatus.report('error', "Couldn't reach the server", {
      detail: `${(err as Error)?.message || 'network error'} · ${url}`,
      source: 'network'
    });
    throw new ApiError(
      `Couldn't reach the AI server (${target}). This is usually a connectivity or CORS issue, or the API URL isn't configured. ` +
        `Check your internet connection and try again — if it persists, the server may be misconfigured.`,
      0,
      { cause: (err as Error)?.message, url }
    );
  }
};

const getAuthToken = async (): Promise<string | undefined> => {
  if (cachedAccessToken) return cachedAccessToken;

  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) {
    cachedAccessToken = session.access_token;
  }
  return session?.access_token;
};

// Build the common request headers (provider keys honoring governance, auth token,
// model/source selection, free-only, allowed-sources). Shared by post + postStream.
const buildRequestHeaders = async (options?: { apiKey?: string; modelId?: string; stage?: string }): Promise<Record<string, string>> => {
  const providerHeaders = providerKeyHeaders();
  const fluxKey = isProviderEnabled('pixazo') ? (getActiveKeyValue('pixazo') || getFluxKeyInfo().key) : null;
  const ideogramKey = isProviderEnabled('ideogram') ? getActiveKeyValue('ideogram') : null;
  const token = await getAuthToken();
  const textModel = options?.stage ? getModelForStage(options.stage) : getSelectedTextModel();
  const textSource = options?.stage ? getSourceForStage(options.stage) : getSelectedTextSource();

  return {
    'Content-Type': 'application/json',
    ...providerHeaders,
    // Explicit per-call Gemini key override (used by the legacy image path) wins.
    ...(options?.apiKey ? { 'X-Gemini-Key': options.apiKey } : {}),
    ...(fluxKey ? { 'X-Pixazo-Key': fluxKey } : {}),
    ...(ideogramKey ? { 'X-Ideogram-Key': ideogramKey } : {}),
    ...(textModel ? { 'X-Text-Model': textModel } : {}),
    ...(textSource ? { 'X-Text-Source': textSource as string } : {}),
    ...(options?.stage ? { 'X-Pipeline-Stage': options.stage } : {}),
    ...(options?.modelId ? { 'X-Gemini-Model': options.modelId } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(isFreeOnly() ? { 'X-Free-Only': 'true' } : {}),
    'X-Allowed-Sources': allowedSourcesHeader()
  };
};

export const post = async <TReq, TRes>(path: string, body: TReq, options?: { signal?: AbortSignal; apiKey?: string; modelId?: string; stage?: string; retry?: RetryOptions }): Promise<TRes> => {
  const attempt = async (): Promise<TRes> => {
    const headers = await buildRequestHeaders(options);
    const res = await safeFetch(buildApiUrl(path), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal
    });

    if (!res.ok) throw await parseError(res);
    return res.json() as Promise<TRes>;
  };
  // Opt-in automatic retry (idempotent calls only) — recovers from a backend cold start or a
  // transient network blip instead of surfacing "Couldn't reach the AI server" on the first miss.
  return options?.retry ? withRetry(attempt, isRetryableError, options.retry) : attempt();
};

/** POST that returns the raw Response for streaming (SSE) reads. Throws ApiError on non-OK. */
export const postStream = async <TReq>(path: string, body: TReq, options?: { signal?: AbortSignal }): Promise<Response> => {
  const headers = await buildRequestHeaders();
  headers.Accept = 'text/event-stream';
  const res = await safeFetch(buildApiUrl(path), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: options?.signal
  });
  if (!res.ok) throw await parseError(res);
  // If the request was misrouted to the static site (e.g. VITE_API_BASE_URL unset, so the
  // call hit the SPA instead of the API), the body is HTML, not an event stream — which
  // otherwise reads as "no response" / hangs. Fail with an actionable message instead.
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    // Status 502 (not 0) so this is NOT treated as a retryable transport error — the
    // buffered endpoint would return the same HTML; surface the actionable message directly.
    throw new ApiError(
      `The chat backend wasn't reachable — the request returned a web page, not a data stream. The API URL is likely misconfigured (VITE_API_BASE_URL).`,
      502,
      { url: buildApiUrl(path), contentType }
    );
  }
  return res;
};

/** DELETE that returns parsed JSON. Throws ApiError on non-OK. */
export const del = async <TRes>(path: string, options?: { signal?: AbortSignal }): Promise<TRes> => {
  const headers = await buildRequestHeaders();
  const res = await safeFetch(buildApiUrl(path), { method: 'DELETE', headers, signal: options?.signal });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<TRes>;
};

/** PUT with a JSON body. Throws ApiError on non-OK. */
export const put = async <TReq, TRes>(path: string, body: TReq, options?: { signal?: AbortSignal }): Promise<TRes> => {
  const headers = await buildRequestHeaders();
  const res = await safeFetch(buildApiUrl(path), { method: 'PUT', headers, body: JSON.stringify(body), signal: options?.signal });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<TRes>;
};

/** PATCH with a JSON body. Throws ApiError on non-OK. */
export const patch = async <TReq, TRes>(path: string, body: TReq, options?: { signal?: AbortSignal }): Promise<TRes> => {
  const headers = await buildRequestHeaders();
  const res = await safeFetch(buildApiUrl(path), { method: 'PATCH', headers, body: JSON.stringify(body), signal: options?.signal });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<TRes>;
};

export const get = async <TRes>(path: string, options?: { modelId?: string; signal?: AbortSignal }): Promise<TRes> => {
  const providerHeaders = providerKeyHeaders();
  const fluxKey = isProviderEnabled('pixazo') ? (getActiveKeyValue('pixazo') || getFluxKeyInfo().key) : null;
  const ideogramKey = isProviderEnabled('ideogram') ? getActiveKeyValue('ideogram') : null;
  const token = await getAuthToken();

  const res = await safeFetch(buildApiUrl(path), {
    signal: options?.signal,
    headers: {
      ...providerHeaders,
      ...(fluxKey ? { 'X-Pixazo-Key': fluxKey } : {}),
      ...(ideogramKey ? { 'X-Ideogram-Key': ideogramKey } : {}),
      ...(getSelectedTextModel() ? { 'X-Text-Model': getSelectedTextModel() as string } : {}),
      ...(getSelectedTextSource() ? { 'X-Text-Source': getSelectedTextSource() as string } : {}),
      ...(options?.modelId ? { 'X-Gemini-Model': options.modelId } : {}),
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(isFreeOnly() ? { 'X-Free-Only': 'true' } : {}),
      'X-Allowed-Sources': allowedSourcesHeader()
    }
  });
  if (!res.ok) throw await parseError(res);
  return res.json() as Promise<TRes>;
};
