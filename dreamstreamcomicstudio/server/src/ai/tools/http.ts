// Small shared fetch helpers for the free-API tool integrations.
//
// Every tool that calls a public REST endpoint uses these so timeout/abort wiring,
// User-Agent and error shaping are uniform. Network failures throw a clear Error
// which each tool catches and degrades into a plain message (never an unhandled
// rejection that would break the agentic loop).

import { assertProviderBudget, noteProviderCall, pageProviderFor, providerForUrl } from '../../lib/providerUsage.js';
import { egressHeaders, egressUrlFor } from '../../lib/egressProxy.js';
import { fetchPublicUrl } from './mcpClient.js';
import { readTextCapped } from './cappedBody.js';

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

/**
 * Run a fetch with a hard timeout chained to an optional caller abort signal. `read` consumes the
 * response INSIDE the same deadline and abort wiring, so a server that sends its headers and then
 * stalls the body can neither hold the call past timeoutMs nor ignore the caller's cancel.
 */
const withTimeout = async <T>(
  url: string,
  accept: string,
  opts: FetchOptions,
  read: (res: Response) => Promise<T>
): Promise<T> => {
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
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept, ...(opts.headers || {}) },
      signal: controller.signal
    });
    return await read(res);
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
// upstreams block this backend's datacenter IPs. Only a failed REQUEST (network error,
// timeout, non-2xx) is retried: a body that arrived but would not parse is the upstream's
// answer, and relaying it again would not change it.
const fetchDirectThenEgress = async <T>(
  url: string,
  accept: string,
  opts: FetchOptions,
  read: (res: Response) => Promise<T>
): Promise<T> => {
  let readFailed = false;
  const okThenRead = (via: string) => async (res: Response): Promise<T> => {
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`${hostOf(url)} returned ${res.status}${via}`);
    }
    try {
      return await read(res);
    } catch (err) {
      readFailed = true;
      throw err;
    }
  };
  try {
    return await withTimeout(url, accept, opts, okThenRead(''));
  } catch (err) {
    const relay = readFailed ? null : egressUrlFor(url);
    if (!relay) throw err;
    return withTimeout(
      relay,
      accept,
      {
        ...opts,
        timeoutMs: Math.max(opts.timeoutMs ?? 0, 14_000),
        headers: { ...(opts.headers || {}), ...egressHeaders() }
      },
      okThenRead(' (via egress)')
    );
  }
};

const isAbortError = (err: unknown): boolean => (err as { name?: string } | null)?.name === 'AbortError';

/**
 * GET JSON, throwing on a non-2xx status or invalid body. Budget-metered. One deadline (and the
 * caller's cancel) covers the headers AND the body.
 */
export const fetchJson = async <T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> => {
  assertProviderBudget(url);
  try {
    const out = await fetchDirectThenEgress(url, opts.accept || 'application/json', opts, async (res) => {
      try {
        return (await res.json()) as T;
      } catch (err) {
        if (isAbortError(err)) throw err; // our deadline or the caller's cancel, mid-body
        // A non-JSON body (HTML error page served with 200, empty body, gateway error) would
        // otherwise surface as an opaque SyntaxError — map it to a clear, honest message.
        throw new Error(`${hostOf(url)} returned an invalid (non-JSON) response`);
      }
    });
    noteProviderCall(url, true);
    return out;
  } catch (err) {
    noteProviderCall(url, false);
    throw err;
  }
};

/** GET text/XML/CSV, throwing on a non-2xx status. Budget-metered; one deadline covers the body. */
export const fetchText = async (url: string, opts: FetchOptions = {}): Promise<string> => {
  assertProviderBudget(url);
  try {
    const out = await fetchDirectThenEgress(url, opts.accept || 'text/plain, */*', opts, (res) => res.text());
    noteProviderCall(url, true);
    return out;
  } catch (err) {
    noteProviderCall(url, false);
    throw err;
  }
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
  /** Body bytes kept (after any Content-Encoding was undone). */
  bytes: number;
  contentType: string;
}

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
    // Still inside the deadline: the body read is covered by the same timer and signal. The
    // text is decoded in the charset the page declares (Content-Type, BOM or <meta charset>).
    const out = await readTextCapped(res, Math.max(0, opts.maxBytes));
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
