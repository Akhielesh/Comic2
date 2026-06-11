/**
 * dreamstream-api — same-origin reverse proxy to the Railway backend.
 *
 * Forwards dreamstreamstudio.ai/api/* → BACKEND_ORIGIN/api/* verbatim:
 * method, path, query, headers and body pass through untouched, and the
 * response streams back (SSE chat streaming included — Workers stream
 * pass-through responses by default).
 *
 * The original client IP rides X-Forwarded-For (from CF-Connecting-IP) so
 * the backend's per-IP rate limiting keys on real visitors, not this
 * worker's egress IPs.
 */

interface Env {
  BACKEND_ORIGIN: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const target = new URL(env.BACKEND_ORIGIN.replace(/\/$/, '') + url.pathname + url.search);

    const headers = new Headers(req.headers);
    const clientIp = req.headers.get('CF-Connecting-IP');
    if (clientIp) {
      headers.set('X-Forwarded-For', clientIp);
      headers.set('X-Real-IP', clientIp);
    }
    headers.set('X-Forwarded-Host', url.host);
    headers.set('X-Forwarded-Proto', 'https');

    try {
      return await fetch(target.toString(), {
        method: req.method,
        headers,
        body: req.body,
        redirect: 'manual',
      });
    } catch {
      return new Response(
        JSON.stringify({ error: { message: 'Backend unreachable through the API proxy' } }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      );
    }
  },
};
