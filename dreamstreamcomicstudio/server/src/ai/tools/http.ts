// Small shared fetch helpers for the free-API tool integrations.
//
// Every tool that calls a public REST endpoint uses these so timeout/abort wiring,
// User-Agent and error shaping are uniform. Network failures throw a clear Error
// which each tool catches and degrades into a plain message (never an unhandled
// rejection that would break the agentic loop).

import { assertProviderBudget, noteProviderCall, pageProviderFor, providerForUrl } from '../../lib/providerUsage.js';
import { egressHeaders, egressUrlFor } from '../../lib/egressProxy.js';
import { fetchPublicUrl } from './mcpClient.js';

const DEFAULT_TIMEOUT_MS = 10_000;

// A descriptive UA — several free APIs (Wikipedia, Nominatim, USGS) ask callers to
// identify themselves and may rate-limit or block anonymous default agents.
const USER_AGENT = 'DreamStreamComicStudio/1.0 (+https://dreamstream.app; AI tool agent)';

interface FetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  accept?: string;
}

/** Run a fetch with a hard timeout chained to an optional caller abort signal. */
const withTimeout = async (
  url: string,
  accept: string,
  opts: FetchOptions
): Promise<Response> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  // Track whether OUR timeout fired so we can turn the otherwise-opaque
  // DOMException "This operation was aborted" into an honest "<host> timed out".
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept, ...(opts.headers || {}) },
      signal: controller.signal
    });
  } catch (err) {
    // Our timeout → a clear message. A caller-initiated abort (user cancel) or a real
    // network error propagates unchanged so callers can tell them apart.
    if (timedOut) throw new Error(`${hostOf(url)} timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
};

// Direct attempt first; for relay-allowlisted hosts (lib/egressProxy.ts) a
// failure retries once through the edge egress worker — several market-data
// upstreams block this backend's datacenter IPs.
const fetchDirectThenEgress = async (url: string, accept: string, opts: FetchOptions): Promise<Response> => {
  try {
    const res = await withTimeout(url, accept, opts);
    if (res.ok) return res;
    throw new Error(`${hostOf(url)} returned ${res.status}`);
  } catch (err) {
    const relay = egressUrlFor(url);
    if (!relay) throw err;
    const res = await withTimeout(relay, accept, {
      ...opts,
      timeoutMs: Math.max(opts.timeoutMs ?? 0, 14_000),
      headers: { ...(opts.headers || {}), ...egressHeaders() }
    });
    if (!res.ok) throw new Error(`${hostOf(url)} returned ${res.status} (via egress)`);
    return res;
  }
};

/** GET JSON, throwing on a non-2xx status or invalid body. Budget-metered. */
export const fetchJson = async <T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> => {
  assertProviderBudget(url);
  const res = await fetchDirectThenEgress(url, opts.accept || 'application/json', opts).then(
    (r) => (noteProviderCall(url, true), r),
    (err) => (noteProviderCall(url, false), Promise.reject(err))
  );
  // A non-JSON body (HTML error page served with 200, empty body, gateway error) would
  // otherwise surface as an opaque SyntaxError — map it to a clear, honest message.
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`${hostOf(url)} returned an invalid (non-JSON) response`);
  }
};

/** GET text/XML/CSV, throwing on a non-2xx status. Budget-metered. */
export const fetchText = async (url: string, opts: FetchOptions = {}): Promise<string> => {
  assertProviderBudget(url);
  const res = await fetchDirectThenEgress(url, opts.accept || 'text/plain, */*', opts).then(
    (r) => (noteProviderCall(url, true), r),
    (err) => (noteProviderCall(url, false), Promise.reject(err))
  );
  return res.text();
};

export interface CappedFetchOptions extends FetchOptions {
  /** Hard cap on body bytes read (decoded). The download stops there; the rest is never fetched. */
  maxBytes: number;
  /**
   * The URL came from a user or a model: every hop goes through fetchPublicUrl (https, public
   * host, resolved IP pinned, each redirect re-checked). Never relayed through the egress worker.
   */
  publicOnly?: boolean;
  /** Refuse (before reading the body) a response whose Content-Type is set and does not match. */
  contentTypes?: RegExp;
}

export interface CappedText {
  text: string;
  /** True when the body was longer than maxBytes and the read stopped at the cap. */
  truncated: boolean;
  /** Decoded bytes kept. */
  bytes: number;
  contentType: string;
}

/** Read at most maxBytes of a body, then cancel the stream (the connection stops downloading). */
const readCapped = async (res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean; bytes: number }> => {
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body) {
    const all = new TextEncoder().encode(await res.text());
    const kept = all.subarray(0, maxBytes);
    return { text: new TextDecoder().decode(kept), truncated: all.length > maxBytes, bytes: kept.length };
  }
  const reader = body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - bytes;
      if (value.length > room) {
        if (room > 0) text += dec.decode(value.subarray(0, room), { stream: true });
        bytes += Math.max(0, room);
        truncated = true;
        break;
      }
      bytes += value.length;
      text += dec.decode(value, { stream: true });
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { text: text + dec.decode(), truncated, bytes };
};

/**
 * GET text with ONE deadline over the whole exchange — headers AND body — and a streamed byte
 * cap, so a server that trickles bytes or sends gigabytes can neither hold a request open past
 * timeoutMs nor fill memory. `publicOnly` routes through fetchPublicUrl for user/model URLs.
 * Throws on a non-2xx status. Budget-metered like fetchText (a publicOnly page in its own
 * per-host bucket: lib/providerUsage.ts pageProviderFor).
 */
export const fetchTextCapped = async (url: string, opts: CappedFetchOptions): Promise<CappedText> => {
  // A user/model page is metered in its own per-host bucket, never as a named provider.
  const meter = opts.publicOnly ? pageProviderFor(url) : providerForUrl(url);
  assertProviderBudget(url, Date.now(), meter);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  const init: RequestInit = {
    headers: { 'User-Agent': USER_AGENT, Accept: opts.accept || 'text/plain, */*', ...(opts.headers || {}) },
    signal: controller.signal
  };
  try {
    let res: Response;
    try {
      res = opts.publicOnly ? await fetchPublicUrl(url, init) : await fetch(url, init);
    } catch (err) {
      noteProviderCall(url, false, Date.now(), meter);
      throw err;
    }
    noteProviderCall(url, res.ok, Date.now(), meter);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`${hostOf(url)} returned ${res.status}`);
    }
    const contentType = res.headers.get('content-type') || '';
    if (opts.contentTypes && contentType && !opts.contentTypes.test(contentType)) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`${hostOf(url)} returned ${contentType.split(';')[0].trim()}, not a readable page`);
    }
    // Still inside the deadline: the body read is covered by the same timer and signal.
    const out = await readCapped(res, Math.max(0, opts.maxBytes));
    return { ...out, contentType };
  } catch (err) {
    if (timedOut) throw new Error(`${hostOf(url)} timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
};

/** Friendly host label for error messages (e.g. "coingecko.com"). */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'the service';
  }
};

/** Title-case a short label/slug for display. */
export const titleCase = (s: string): string =>
  s
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

/** Read an optional API key from the environment (empty → undefined). */
export const envKey = (name: string): string | undefined => {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
};
