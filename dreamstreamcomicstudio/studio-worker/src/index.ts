// DreamStream Studio Worker — Phase 1 (foundation).
//
// Spins up a per-user Cloudflare Container (via the Sandbox SDK), writes the AI-built
// project into it, installs deps, starts the dev server, and returns a tokenized live
// preview URL the user opens in a new tab. Controlled ONLY by our Railway backend via
// HMAC-signed requests, so the container control plane is never exposed to browsers.
//
// STATUS: deploy-ready scaffold. The Sandbox SDK calls below follow the documented API;
// VALIDATE them against the installed @cloudflare/sandbox version on the FIRST
// `wrangler deploy` (method names/return shapes may need minor tweaks per SDK version).
// See README.md for setup, and ../docs/CLOUDFLARE_STUDIO_PLAN.md for the full design.

import { getSandbox, proxyToSandbox } from '@cloudflare/sandbox';
export { Sandbox } from '@cloudflare/sandbox';

export interface Env {
  Sandbox: DurableObjectNamespace;
  /** Shared secret with the Railway backend; rejects any unsigned request. */
  STUDIO_HMAC_SECRET: string;
}

interface StudioFile {
  path: string;
  content: string;
}

interface RequestBody {
  action: 'launch' | 'stop';
  /** `u_<userId>_<projectId>` — ALWAYS scope per authenticated user (set by Railway). */
  sandboxId: string;
  files?: StudioFile[];
  install?: string;
  dev?: string;
  /** App port (1024–65535, not 3000, which the SDK reserves). */
  port?: number;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// Railway signs the raw request body with the shared secret and sends it as
// `x-studio-signature: sha256=<hex>`. We recompute and compare in length-safe fashion.
async function verifyHmac(req: Request, rawBody: string, secret: string): Promise<boolean> {
  if (!secret) return false;
  const provided = req.headers.get('x-studio-signature') || '';
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = 'sha256=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // 1) Preview-URL requests (browser → the running app) get proxied to the right
    //    container. proxyToSandbox returns a Response for preview hosts, else falsy.
    const proxied = await proxyToSandbox(req, env);
    if (proxied) return proxied;

    // 2) Control-plane requests (from Railway only, HMAC-signed): launch / stop.
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

    const rawBody = await req.text();
    if (!(await verifyHmac(req, rawBody, env.STUDIO_HMAC_SECRET))) {
      return json({ error: 'unauthorized' }, 401);
    }

    let body: RequestBody;
    try {
      body = JSON.parse(rawBody) as RequestBody;
    } catch {
      return json({ error: 'invalid json' }, 400);
    }
    if (!body.sandboxId) return json({ error: 'sandboxId required' }, 400);

    const sandbox = getSandbox(env.Sandbox, body.sandboxId);
    const hostname = new URL(req.url).hostname;

    try {
      if (body.action === 'stop') {
        await sandbox.stop();
        return json({ status: 'stopped', sandboxId: body.sandboxId });
      }

      if (body.action === 'launch') {
        const files = Array.isArray(body.files) ? body.files : [];
        if (!files.length) return json({ error: 'no files provided' }, 400);
        const port = body.port && body.port > 1024 && body.port !== 3000 ? body.port : 3001;

        // 1. Write the AI-built project into the container's workspace.
        for (const f of files) {
          const rel = f.path.startsWith('/') ? f.path : `/${f.path}`;
          await sandbox.writeFile(`/workspace${rel}`, f.content);
        }

        // 2. Install dependencies (run to completion).
        const install = await sandbox.exec(body.install || 'cd /workspace && npm install');
        if (!install.success) {
          return json({
            status: 'error',
            phase: 'install',
            log: (install.stderr || '').slice(-4000)
          });
        }

        // 3. Start the long-running dev server (background process).
        await sandbox.startProcess(body.dev || `cd /workspace && PORT=${port} npm run dev`);

        // 4. Expose the port → tokenized preview URL the user opens in a new tab.
        const exposed = await sandbox.exposePort(port, { hostname });
        return json({
          status: 'starting',
          previewUrl: exposed.url,
          sandboxId: body.sandboxId,
          port
        });
      }

      return json({ error: 'unknown action' }, 400);
    } catch (err) {
      return json({ status: 'error', message: (err as Error)?.message || 'studio worker failed' }, 500);
    }
  }
};
