/**
 * dreamstream-data-egress — allowlisted upstream fetch relay on Cloudflare's edge.
 *
 * Why: the Railway backend's egress IPs are blocked by several market-data
 * upstreams (Yahoo Finance chart/quote hosts, Stooq, Treasury FiscalData
 * intermittently) — every stock/metals/ticker widget returned nothing in
 * production while working everywhere else. Cloudflare's edge fetches these
 * public endpoints fine, so the backend retries failed calls through this
 * worker (see server/src/lib/egressProxy.ts).
 *
 * Hard constraints:
 *  - GET only, https only, hostname must be in ALLOWED_HOSTS (public market
 *    data — this can never be a general proxy).
 *  - Optional shared secret: set EGRESS_SHARED_SECRET (wrangler secret) and
 *    the same value as DATA_EGRESS_SECRET on the backend to require the
 *    x-egress-key header. Unset = open but still allowlisted-only.
 *  - accept / user-agent / cookie pass through (Yahoo's crumb flow needs the
 *    cookie); set-cookie passes back.
 */

interface Env {
  EGRESS_SHARED_SECRET?: string;
}

const ALLOWED_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'fc.yahoo.com',
  'stooq.com',
  'api.fiscaldata.treasury.gov'
]);

const FORWARD_REQ_HEADERS = ['accept', 'user-agent', 'cookie', 'accept-language'];
const FORWARD_RES_HEADERS = ['content-type', 'set-cookie'];
const UPSTREAM_TIMEOUT_MS = 12_000;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== 'GET' || !url.pathname.endsWith('/fetch')) {
      return json(404, 'Not found — GET <route>/fetch?url=…');
    }
    if (env.EGRESS_SHARED_SECRET && req.headers.get('x-egress-key') !== env.EGRESS_SHARED_SECRET) {
      return json(403, 'Bad or missing x-egress-key');
    }

    let target: URL;
    try {
      target = new URL(url.searchParams.get('url') || '');
    } catch {
      return json(400, 'url parameter must be an absolute URL');
    }
    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
      return json(403, `Host not allowlisted: ${target.hostname}`);
    }

    const headers = new Headers();
    for (const h of FORWARD_REQ_HEADERS) {
      const v = req.headers.get(h);
      if (v) headers.set(h, v);
    }

    try {
      const upstream = await fetch(target.toString(), {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });
      const out = new Headers();
      for (const h of FORWARD_RES_HEADERS) {
        const v = upstream.headers.get(h);
        if (v) out.set(h, v);
      }
      out.set('x-egress-host', target.hostname);
      return new Response(upstream.body, { status: upstream.status, headers: out });
    } catch (err) {
      return json(502, `Upstream fetch failed: ${(err as Error)?.message || 'unknown'}`);
    }
  }
};

const json = (status: number, message: string): Response =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
