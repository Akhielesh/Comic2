/**
 * dreamstream-data-egress — allowlisted upstream fetch relay on Cloudflare's edge.
 *
 * Why: the backend's datacenter egress IPs are blocked by several market-data
 * upstreams (Yahoo Finance chart/quote hosts, Stooq, Treasury FiscalData
 * intermittently) — every stock/metals/ticker widget returned nothing in
 * production while working everywhere else. Cloudflare's edge fetches these
 * public endpoints fine, so the backend retries failed calls through this
 * worker (see server/src/lib/egressProxy.ts).
 *
 * Hard constraints:
 *  - GET only, https only, hostname must be in ALLOWED_HOSTS (public market
 *    data — this can never be a general proxy).
 *  - Shared secret, REQUIRED: EGRESS_SHARED_SECRET (wrangler secret) must
 *    equal the backend's DATA_EGRESS_SECRET, which it sends as x-egress-key
 *    (server/src/lib/egressProxy.ts). Unset fails CLOSED (503, logged) — an
 *    open relay let anyone spend this worker on the allowlisted hosts
 *    (abuse-ops-12). The header is compared in constant time.
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
let warnedUnset = false;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== 'GET' || !url.pathname.endsWith('/fetch')) {
      return json(404, 'Not found — GET <route>/fetch?url=…');
    }
    const secret = (env.EGRESS_SHARED_SECRET || '').trim(); // the backend trims DATA_EGRESS_SECRET too
    if (!secret) {
      // Deploy order: set the secret on this worker AND on the backend first (owner step O4).
      // Logged once per isolate (every refused request still gets the 503).
      if (!warnedUnset) console.error('[data-egress] EGRESS_SHARED_SECRET is not set: refusing every request (fail closed). Set it with `wrangler secret put EGRESS_SHARED_SECRET` and the same value as the backend\'s DATA_EGRESS_SECRET.');
      warnedUnset = true;
      return json(503, 'Relay not configured');
    }
    if (!(await sameSecret(req.headers.get('x-egress-key') || '', secret))) {
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

/**
 * Constant-time comparison of the presented key with the secret: both are hashed first (SHA-256), so
 * neither the content nor the length of the secret shows in the timing. Web Crypto only, which the
 * Workers runtime and Node (tests) both have.
 */
export async function sameSecret(presented: string, secret: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(presented)),
    crypto.subtle.digest('SHA-256', enc.encode(secret))
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 && presented.length > 0;
}

const json = (status: number, message: string): Response =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
