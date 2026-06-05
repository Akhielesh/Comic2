// DreamStream Studio Worker — Phase 1 (foundation).
//
// Spins up a per-user Cloudflare Container (via the Sandbox SDK), writes the AI-built
// project into it, installs deps, starts the dev server, and returns a public preview
// URL the user opens in a new tab. Controlled ONLY by our Railway backend via HMAC-signed
// requests, so the container control plane is never exposed to browsers.
//
// Validated against @cloudflare/sandbox 0.4.x (typechecks against the real SDK types).
// Preview URLs come from `exposePort(port, { hostname })`, which builds a subdomain-style
// URL (`<port>-<sandboxId>-<token>.<hostname>`) that Cloudflare routes back to this Worker
// (`*.<worker>.<account>.workers.dev`) — so NO custom domain is required. `proxyToSandbox`
// handles those inbound preview requests. See README.md + ../docs/CLOUDFLARE_STUDIO_PLAN.md.

import { getSandbox, proxyToSandbox, type Sandbox } from '@cloudflare/sandbox';
export { Sandbox } from '@cloudflare/sandbox';

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  /** Shared secret with the Railway backend; rejects any unsigned request. */
  STUDIO_HMAC_SECRET: string;
  /**
   * Domain whose FIRST-LEVEL wildcard serves preview URLs, e.g. `dreamstreamstudio.ai`
   * (previews become `<port>-<id>-<token>.dreamstreamstudio.ai`, covered by free Universal
   * SSL). Set as a wrangler var. Decoupled from the control endpoint on purpose: the worker
   * only needs the `*.<domain>/*` route for previews, leaving the bare apex free for your
   * real site. Falls back to the incoming request host (dev / single-domain setups).
   */
  STUDIO_PREVIEW_DOMAIN?: string;
}

interface StudioFile {
  path: string;
  content: string;
}

interface RequestBody {
  action: 'launch' | 'stop' | 'logs';
  /** `u_<userId>_<projectId>` — ALWAYS scope per authenticated user (set by Railway). */
  sandboxId: string;
  files?: StudioFile[];
  install?: string;
  dev?: string;
  /** App port (1024–65535, not 3000, which the SDK reserves). */
  port?: number;
}

// Deterministic id for the dev server process, so the `logs` action can read its output
// across separate control-plane requests without the launch having to thread an id back.
const DEV_PROCESS_ID = 'dev';

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

    // 2) Control-plane requests (from Railway only, HMAC-signed): launch / stop / logs.
    //    A non-preview GET here is a stray subdomain caught by the `*.<domain>/*` route
    //    (e.g. someone visits www.<domain>) — send them to the real site instead of a 405.
    if (req.method !== 'POST') {
      return env.STUDIO_PREVIEW_DOMAIN
        ? Response.redirect(`https://${env.STUDIO_PREVIEW_DOMAIN}`, 302)
        : json({ error: 'POST only' }, 405);
    }

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

    try {
      if (body.action === 'stop') {
        await sandbox.stop();
        return json({ status: 'stopped', sandboxId: body.sandboxId });
      }

      if (body.action === 'logs') {
        // Live build/dev output — the signal the agentic loop (Phase 4) reads to self-fix.
        try {
          const logs = await sandbox.getProcessLogs(DEV_PROCESS_ID);
          return json({
            status: 'ok',
            sandboxId: body.sandboxId,
            stdout: (logs.stdout || '').slice(-8000),
            stderr: (logs.stderr || '').slice(-8000)
          });
        } catch {
          // No dev process yet (or it was cleaned up) — report what's running instead.
          const procs = await sandbox.listProcesses().catch(() => []);
          return json({ status: 'ok', sandboxId: body.sandboxId, stdout: '', stderr: '', processes: procs.map((p) => ({ id: p.id, command: p.command })) });
        }
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

        // 2. Install dependencies (run to completion in the workspace; npm install is slow).
        const install = await sandbox.exec(body.install || 'npm install', { cwd: '/workspace', timeout: 300_000 });
        if (!install.success) {
          return json({
            status: 'error',
            phase: 'install',
            log: (install.stderr || install.stdout || '').slice(-4000)
          });
        }

        // 3. Start the long-running dev server as a tracked background process. PORT/HOST
        //    are injected so the dev server binds the exposed port on all interfaces.
        await sandbox.startProcess(body.dev || 'npm run dev', {
          processId: DEV_PROCESS_ID,
          cwd: '/workspace',
          env: { PORT: String(port), HOST: '0.0.0.0' }
        });

        // 4. Expose the port → a PUBLIC preview URL on the configured preview domain
        //    (`<port>-<id>-<token>.<STUDIO_PREVIEW_DOMAIN>`), which the `*.<domain>/*` route
        //    sends back here → proxyToSandbox → the container. Falls back to the request
        //    host for local dev. NOTE: exposePort rejects *.workers.dev — a real domain is
        //    required (see README); STUDIO_PREVIEW_DOMAIN must be a zone in this account.
        const hostname = env.STUDIO_PREVIEW_DOMAIN || new URL(req.url).host;
        const exposed = await sandbox.exposePort(port, { hostname });
        return json({ status: 'starting', previewUrl: exposed.url, sandboxId: body.sandboxId, port });
      }

      return json({ error: 'unknown action' }, 400);
    } catch (err) {
      return json({ status: 'error', message: (err as Error)?.message || 'studio worker failed' }, 500);
    }
  }
};
