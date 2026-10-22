/**
 * POST /api/csp-report — Content-Security-Policy violation reports, answered AT THE EDGE.
 * It never reaches (or wakes) the backend container: reports can arrive from every page view.
 *
 * Accepts the legacy `report-uri` format (application/csp-report) and the Reporting API
 * (application/reports+json). Logs a SAMPLED, sanitized summary to Workers logs: the directive,
 * the blocked origin (no path/query), and the document path with share slugs masked (an unlisted
 * slug is a capability and must never land in logs). Always 204; bodies over 16 KB are ignored.
 */
import type { RateLimiter } from './publicComic';

export interface CspReportEnv {
  CSP_REPORT_RL?: RateLimiter;
  /** 0..1, default 0.1. */
  CSP_REPORT_SAMPLE?: string;
}

const MAX_BYTES = 16 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Only the origin of a URL (or the keyword like 'inline' / 'eval'). */
const originOnly = (v: unknown): string => {
  const s = typeof v === 'string' ? v.slice(0, 300) : '';
  if (!s) return '';
  if (/^(inline|eval|wasm-eval|data|blob|self|trusted-types-policy|trusted-types-sink)$/i.test(s)) return s.toLowerCase();
  try {
    return new URL(s).origin;
  } catch {
    return s.split(/[?#]/)[0].slice(0, 60);
  }
};

/** Document path with capability segments masked (/c/<slug>, classic /share/<token>) and no query string. */
export const maskedPath = (v: unknown): string => {
  const s = typeof v === 'string' ? v.slice(0, 500) : '';
  try {
    return new URL(s).pathname
      .replace(/^\/c\/[^/]+/, '/c/:slug')
      .replace(/^\/share\/[^/]+/, '/share/:token')
      .slice(0, 120);
  } catch {
    return '';
  }
};

export interface CspSummary {
  directive: string;
  blocked: string;
  page: string;
  disposition: string;
}

export function summarize(body: unknown): CspSummary[] {
  const reports: Record<string, unknown>[] = [];
  if (Array.isArray(body)) {
    for (const r of body.slice(0, 20)) if (isRecord(r) && isRecord(r.body)) reports.push(r.body);
  } else if (isRecord(body) && isRecord(body['csp-report'])) reports.push(body['csp-report']);
  return reports.map((r) => ({
    directive: String(r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive'] ?? '').slice(0, 60),
    blocked: originOnly(r['blocked-uri'] ?? r.blockedURL),
    page: maskedPath(r['document-uri'] ?? r.documentURL),
    disposition: String(r.disposition ?? '').slice(0, 12)
  }));
}

export async function handleCspReport(req: Request, env: CspReportEnv, random: () => number = Math.random): Promise<Response> {
  const done = new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
  const ip = req.headers.get('cf-connecting-ip') || '0.0.0.0';
  if (env.CSP_REPORT_RL) {
    try {
      if (!(await env.CSP_REPORT_RL.limit({ key: `csp:${ip}` })).success) return done;
    } catch {
      /* limiter outage: keep going */
    }
  }
  const length = Number(req.headers.get('content-length') || '0');
  if (length > MAX_BYTES) return done;
  const text = await req.text().catch(() => '');
  if (!text || text.length > MAX_BYTES) return done;
  const sample = Math.max(0, Math.min(1, Number(env.CSP_REPORT_SAMPLE ?? '0.1') || 0));
  if (random() >= sample) return done;
  try {
    for (const s of summarize(JSON.parse(text))) console.log('csp_violation', s);
  } catch {
    /* not JSON: ignore */
  }
  return done;
}
