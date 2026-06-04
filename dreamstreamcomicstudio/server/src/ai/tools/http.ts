// Small shared fetch helpers for the free-API tool integrations.
//
// Every tool that calls a public REST endpoint uses these so timeout/abort wiring,
// User-Agent and error shaping are uniform. Network failures throw a clear Error
// which each tool catches and degrades into a plain message (never an unhandled
// rejection that would break the agentic loop).

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
};

/** GET JSON, throwing on a non-2xx status or invalid body. */
export const fetchJson = async <T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> => {
  const res = await withTimeout(url, opts.accept || 'application/json', opts);
  if (!res.ok) throw new Error(`${hostOf(url)} returned ${res.status}`);
  return (await res.json()) as T;
};

/** GET text/XML/CSV, throwing on a non-2xx status. */
export const fetchText = async (url: string, opts: FetchOptions = {}): Promise<string> => {
  const res = await withTimeout(url, opts.accept || 'text/plain, */*', opts);
  if (!res.ok) throw new Error(`${hostOf(url)} returned ${res.status}`);
  return res.text();
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
