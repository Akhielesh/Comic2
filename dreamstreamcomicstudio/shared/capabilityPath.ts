// Capability-safe paths for logs and telemetry (S19).
//
// An unlisted share slug (/c/<slug>, /api/comic/public/s/<slug>) and a classic share token
// (/share/<token>, /api/shares/token/<token>) are READ CAPABILITIES: whoever holds one can read
// the comic or chat. They must never land in a log line, a telemetry row or the agent log, so
// every sink that records a request path or page path runs it through loggablePath first:
//   - server/src/middleware/requestContext.ts (http_request access log)
//   - server/src/middleware/errors.ts (server_error log + telemetry)
//   - server/src/services/telemetryStore.ts (client-reported surfaces: telemetry_events, user_feedback;
//     plus maskCapabilityUrls over messages and metadata — an error's filename/stack can be the page URL)
//   - api-proxy/src/agent-log.ts (agent_visits path + Referer)
//   - api-proxy/src/cspReport.ts (CSP report document paths)
// The query string and #fragment are always dropped (newsletter ?t=, OAuth ?code=/?state=,
// webhook ?token= …). Everything else passes through unchanged so ordinary ids stay debuggable.
//
// ANY FUTURE CAPABILITY ROUTE (a path segment that grants access by itself) MUST BE ADDED HERE.
// Dependency-free on purpose: the Workers, the Pages Functions and the Node backend all import it.

/** [prefix pattern, masked prefix]. Matched case-insensitively (Express routing is too). */
const CAPABILITY_PREFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/api\/comic\/public\/s\/[^/]+/i, '/api/comic/public/s/:slug'],
  [/^\/api\/shares\/token\/[^/]+/i, '/api/shares/token/:token'],
  [/^\/c\/[^/]+/i, '/c/:slug'],
  [/^\/share\/[^/]+/i, '/share/:token']
];

const MAX_IN = 2048;
const MAX_OUT = 512;

/** A pathname with its capability segment masked (expects no query or fragment). */
const maskPathname = (pathname: string): string => {
  // Collapse repeated slashes so `//c/<slug>` cannot slip past the anchored prefixes.
  const path = pathname.replace(/\/{2,}/g, '/');
  for (const [pattern, masked] of CAPABILITY_PREFIXES) {
    if (pattern.test(path)) return path.replace(pattern, masked);
  }
  return path;
};

/**
 * `value` (a request path such as req.originalUrl, a page pathname, or an absolute http(s) URL)
 * made safe to log: query and fragment dropped, credentials dropped, capability segments masked.
 * Absolute URLs keep their origin. Non-strings and empty values → ''.
 */
export const loggablePath = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const raw = value.trim().slice(0, MAX_IN);
  if (!raw) return '';
  let rest = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return `${url.protocol}//${url.host}${maskPathname(url.pathname)}`.slice(0, MAX_OUT);
    } catch {
      // Unparseable absolute URL: drop the (broken) scheme + authority, mask what follows.
      rest = raw.replace(/^https?:\/\/[^/?#]*/i, '') || '/';
    }
  }
  const path = rest.split(/[?#]/, 1)[0];
  return maskPathname(path).slice(0, MAX_OUT);
};

/** Absolute http(s) URLs inside free text (stops at whitespace, quotes, brackets, backslashes). */
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'`<>()[\]{}\\]+/gi;
const MASKED_PREFIXES = CAPABILITY_PREFIXES.map(([, masked]) => masked);

/**
 * Free text (an error message, a stack trace, a `filename`) with every absolute URL that points
 * at a capability path replaced by its loggablePath form. An error thrown by an inline or
 * extension-injected script reports the PAGE URL (https://…/c/<slug>?…) as its filename and stack
 * frame. Every other URL — script files, API hosts — is left exactly as it was.
 */
export const maskCapabilityUrls = (text: string): string =>
  typeof text === 'string'
    ? text.replace(URL_IN_TEXT, (url) => {
        const safe = loggablePath(url);
        return MASKED_PREFIXES.some((masked) => safe.toLowerCase().includes(masked)) ? safe : url;
      })
    : text;
