/**
 * A throwaway Worker that runs the APNs HTTP/2 probe from Cloudflare's production network
 * (ADR 0006 D3), so the decision doesn't have to wait for the live Worker's ops route.
 * The "APNs HTTP/2 probe" GitHub workflow deploys it with its own config
 * (`probe.wrangler.jsonc`: workers.dev only, no routes, no bindings) and a random
 * `OPS_KEY` secret, calls it once through `scripts/apnsProbe.mjs`, and deletes it.
 *
 *   POST /probe            x-ops-key: <OPS_KEY>     → ApnsProbeResult JSON
 *   POST /probe?host=production
 *
 * Everything else is 404. Without an `OPS_KEY` of 16+ characters it refuses every call.
 */
import { handleApnsProbe } from './probe';

interface ProbeEnv {
  OPS_KEY?: string;
}

export default {
  async fetch(req: Request, env: ProbeEnv): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname !== '/probe' && pathname !== '/api/ops/apns-probe') return new Response('not found', { status: 404 });
    return handleApnsProbe(req, env.OPS_KEY);
  },
} satisfies ExportedHandler<ProbeEnv>;
