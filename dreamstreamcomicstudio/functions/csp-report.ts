/**
 * POST /csp-report — the Content-Security-Policy violation counter (ADR 0006, WS-1).
 *
 * Every page the Pages middleware serves names this endpoint twice: `report-to csp` (with a
 * `Reporting-Endpoints: csp="…/csp-report"` header, used by Chromium) and `report-uri
 * /csp-report` (Firefox and Safari). Two body shapes arrive here:
 *
 *   - Reporting API, `Content-Type: application/reports+json`: an array of
 *     `{ type: 'csp-violation', url, body: { documentURL, blockedURL, effectiveDirective,
 *     disposition, sourceFile, sample, … } }`.
 *   - Legacy report-uri, `Content-Type: application/csp-report` (some browsers say
 *     `application/json`): `{ "csp-report": { "document-uri", "blocked-uri",
 *     "effective-directive" | "violated-directive", "disposition", "source-file", … } }`.
 *
 * What we keep is a COUNT per (disposition, page kind, directive, blocked origin, source
 * origin) — never a URL. Paths can carry share tokens (/share/<token>), queries can carry
 * legacy keys (?k=, &g=), and `sample` can carry page text, so none of those is ever read
 * into a log line: a blocked or source URL is cut down to its origin (or a keyword such as
 * `inline`, `eval`, `data:`), and the document is cut down to which app it was (`live`,
 * `main`, `srcdoc`). Browser-extension noise is labelled `extension` so the "zero
 * first-party violations on /live" acceptance number can ignore it.
 *
 * Where the counts go:
 *   - An Analytics Engine dataset bound as `CSP_REPORTS`, when the owner adds the binding
 *     (Pages → Settings → Functions → Bindings). One data point per violation; query it with
 *     the SQL API. Dormant (no binding) until then — nothing breaks.
 *   - A bounded log line: the 1st, 10th, 100th, … violation of each key in an isolate, so
 *     `wrangler pages deployment tail` shows what is happening without one line per report.
 *
 * It always answers 204 to a well-formed POST (browsers don't retry and don't care), 413 to a
 * body over 64 KiB, 415 to a content type it doesn't know, and 405 to anything but POST and
 * OPTIONS. It never touches /api/* — the backend container stays asleep.
 */
import { isLegacyLivePath, isStreamHost } from '../shared/streamHost';

/** The path every policy reports to. Same-origin on every host the middleware serves. */
export const CSP_REPORT_PATH = '/csp-report';
/** The Reporting API group name used by `report-to`. */
export const CSP_REPORT_GROUP = 'csp';

export const MAX_REPORT_BYTES = 64 * 1024;
/** A batch from the Reporting API can hold many reports; we look at no more than this. */
export const MAX_REPORTS_PER_REQUEST = 50;

/** Analytics Engine binding shape (only what we call). */
export interface AnalyticsEngineDatasetLike {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export interface CspReportEnv {
  CSP_REPORTS?: AnalyticsEngineDatasetLike;
}

export interface CspViolation {
  /** 'enforce' | 'report' | 'unknown' */
  disposition: string;
  /** 'live' (Stream Studio) | 'main' (the comic / chat app) | 'srcdoc' (a chat artifact frame) | 'other' */
  page: string;
  /** The effective directive, e.g. 'script-src-elem', 'connect-src'. */
  directive: string;
  /** Origin or keyword: 'https://example.com', 'inline', 'eval', 'wasm-eval', 'data:', 'blob:', 'extension', … */
  blocked: string;
  /** Where the offending code ran from, same normalisation as `blocked` ('' when unknown). */
  source: string;
  /** True when nothing points at a browser extension, so it counts against our own code. */
  firstParty: boolean;
}

const KEYWORDS = new Set([
  'inline', 'eval', 'wasm-eval', 'self', 'data', 'blob',
  'trusted-types-policy', 'trusted-types-sink', 'about', 'none',
]);
const EXTENSION_SCHEMES = /^(chrome|moz|safari|safari-web|ms-browser|edge)-extension:/i;

const clip = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');

/**
 * A URL-or-keyword from a report → something safe to count: an origin, a scheme, or a
 * keyword. Never a path, query or fragment.
 */
export function normalizeReportedUrl(raw: unknown): string {
  const value = clip(raw, 2048).trim();
  if (!value) return '';
  const lower = value.toLowerCase();
  if (KEYWORDS.has(lower)) return lower === 'data' || lower === 'blob' ? `${lower}:` : lower;
  if (EXTENSION_SCHEMES.test(value)) return 'extension';
  if (/^(data|blob|about|filesystem|mediastream):/i.test(value)) return `${lower.slice(0, lower.indexOf(':'))}:`;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ws:' || url.protocol === 'wss:') {
      return `${url.protocol}//${url.host}`.toLowerCase();
    }
    return `${url.protocol}`.toLowerCase();
  } catch {
    return 'other';
  }
}

/** Which app the violating document was: no path, no query, no fragment survives. */
export function classifyDocument(raw: unknown): string {
  const value = clip(raw, 2048).trim();
  if (!value) return 'other';
  if (value.toLowerCase().startsWith('about:srcdoc')) return 'srcdoc';
  try {
    const url = new URL(value);
    if (isStreamHost(url.hostname) || isLegacyLivePath(url.pathname)) return 'live';
    if (url.protocol === 'https:' || url.protocol === 'http:') return 'main';
    return 'other';
  } catch {
    return 'other';
  }
}

const directiveOf = (effective: unknown, violated: unknown): string => {
  const name = (clip(effective, 64) || clip(violated, 256)).trim().split(/\s+/)[0].toLowerCase();
  return /^[a-z][a-z-]{0,39}$/.test(name) ? name : 'unknown';
};

const dispositionOf = (raw: unknown): string => {
  const value = clip(raw, 16).toLowerCase();
  return value === 'enforce' || value === 'report' ? value : 'unknown';
};

function toViolation(fields: {
  documentURL: unknown; blockedURL: unknown; effectiveDirective: unknown;
  violatedDirective?: unknown; disposition: unknown; sourceFile: unknown;
}): CspViolation {
  const blocked = normalizeReportedUrl(fields.blockedURL) || 'none';
  const source = normalizeReportedUrl(fields.sourceFile);
  return {
    disposition: dispositionOf(fields.disposition),
    page: classifyDocument(fields.documentURL),
    directive: directiveOf(fields.effectiveDirective, fields.violatedDirective),
    blocked,
    source,
    firstParty: blocked !== 'extension' && source !== 'extension',
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Parse either body shape. Unknown report types (deprecation, intervention, …) are skipped. */
export function parseCspReports(contentType: string, text: string): CspViolation[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const out: CspViolation[] = [];
  const type = contentType.toLowerCase();
  if (type.includes('application/reports+json') || Array.isArray(json)) {
    if (!Array.isArray(json)) return null;
    for (const entry of json.slice(0, MAX_REPORTS_PER_REQUEST)) {
      if (!isRecord(entry) || entry.type !== 'csp-violation' || !isRecord(entry.body)) continue;
      const b = entry.body;
      out.push(toViolation({
        documentURL: b.documentURL ?? entry.url,
        blockedURL: b.blockedURL,
        effectiveDirective: b.effectiveDirective,
        disposition: b.disposition,
        sourceFile: b.sourceFile,
      }));
    }
    return out;
  }
  if (!isRecord(json) || !isRecord(json['csp-report'])) return null;
  const r = json['csp-report'];
  out.push(toViolation({
    documentURL: r['document-uri'],
    blockedURL: r['blocked-uri'],
    effectiveDirective: r['effective-directive'],
    violatedDirective: r['violated-directive'],
    disposition: r.disposition,
    sourceFile: r['source-file'],
  }));
  return out;
}

/** Per-isolate counts, so the log stays bounded (1st, 10th, 100th, … of each key). */
const counts = new Map<string, number>();
const MAX_KEYS = 500;

/** Exposed for tests. */
export function resetCspCounts(): void {
  counts.clear();
}

export function recordViolation(v: CspViolation, env: CspReportEnv | undefined, log: (line: string) => void = console.log): number {
  const key = `${v.disposition}|${v.page}|${v.directive}|${v.blocked}|${v.source}`;
  if (!counts.has(key) && counts.size >= MAX_KEYS) counts.clear();
  const n = (counts.get(key) ?? 0) + 1;
  counts.set(key, n);
  try {
    env?.CSP_REPORTS?.writeDataPoint({
      indexes: [v.directive],
      blobs: [v.disposition, v.page, v.directive, v.blocked, v.source, v.firstParty ? 'first' : 'extension'],
      doubles: [1],
    });
  } catch {
    /* a counter must never fail the request */
  }
  if (/^10*$/.test(String(n))) {
    log(JSON.stringify({ evt: 'csp_violation', n, ...v }));
  }
  return n;
}

async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      try {
        await reader.cancel();
      } catch { /* already closed */ }
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const reply = (status: number, extra: Record<string, string> = {}) =>
  new Response(null, { status, headers: { 'cache-control': 'no-store', ...extra } });

const ACCEPTED_TYPES = ['application/reports+json', 'application/csp-report', 'application/json'];

export async function handleCspReport(request: Request, env?: CspReportEnv, log?: (line: string) => void): Promise<Response> {
  if (request.method === 'OPTIONS') return reply(204, { allow: 'POST, OPTIONS' });
  if (request.method !== 'POST') return reply(405, { allow: 'POST, OPTIONS' });
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!ACCEPTED_TYPES.some((t) => contentType.startsWith(t))) return reply(415);
  const text = await readCapped(request, MAX_REPORT_BYTES);
  if (text === null) return reply(413);
  const violations = parseCspReports(contentType, text);
  for (const v of violations ?? []) recordViolation(v, env, log);
  return reply(204);
}

interface PagesFunctionContext {
  request: Request;
  env?: CspReportEnv;
}

export const onRequest = ({ request, env }: PagesFunctionContext): Promise<Response> => handleCspReport(request, env);
