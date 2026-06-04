# Code Studio v2 — Cloudflare Containers integration plan

**Goal.** The AI builds a complete, runnable stack (front-end *and* back-end when
needed). The project runs **server-side in a Cloudflare Container**, and the user
clicks **"Run live" → a new tab opens the real running app** to test. Small/simple
front-end apps keep the instant **inline Sandpack** preview (free, works on every
device). This retires the desktop-only WebContainer path as the *primary* experience.

> Why this design: WebContainer (the current "Build in Studio") needs
> `SharedArrayBuffer` + cross-origin isolation, so it is desktop-class only with
> constrained beta mobile support — it can never be "any and all web devices." A
> server-side container moves execution off the device; the phone/tablet just opens a
> URL, so it works **everywhere**, and it can run a *real* backend, arbitrary `npm`
> packages, and a terminal.

Grounding sources (verified June 2026):
- [Cloudflare Sandbox SDK overview](https://developers.cloudflare.com/sandbox/) ·
  [Getting started](https://developers.cloudflare.com/sandbox/get-started/) ·
  [Preview URLs](https://developers.cloudflare.com/sandbox/concepts/preview-urls/) ·
  [Expose services](https://developers.cloudflare.com/sandbox/guides/expose-services/)
- [Containers pricing](https://developers.cloudflare.com/containers/pricing/) ·
  [Limits & instance types](https://developers.cloudflare.com/containers/platform-details/limits/)
- [Durable Object Container API](https://developers.cloudflare.com/durable-objects/api/container/)

---

## 1. The two-tier model (when each runtime is used)

| Tier | Runtime | Runs on | Powers | Devices | Cost |
|---|---|---|---|---|---|
| **Quick preview** | Sandpack (in-browser bundler) | the user's browser | front-end-only apps (React/HTML/JS/CSS, bundlable npm deps) | ✅ all incl. mobile | free |
| **Run live** | **Cloudflare Container** (Sandbox SDK) | Cloudflare edge | full stack: real `npm install`, dev/build server, backend, terminal, any framework | ✅ all (just opens a URL) | metered $ |

**Routing decision (which tier a generated app uses):**
1. **Explicit:** the `code_studio` card shows both "Quick preview" and "Run live (new tab)". User can always pick "Run live".
2. **Automatic default** chosen from the artifact:
   - → **Container** if any of: a server entry/file (`server.*`, `app.py`, `main.go`, an Express/Fastify/Next/Vite-SSR/FastAPI dep), a `package.json` `start`/server script, a non-front-end `template`, or > ~12 files.
   - → **Sandpack** otherwise (pure front-end, small, bundlable).
   - This is computed once server-side from the artifact and stored on the card as `recommendedRuntime`.

---

## 2. Architecture & data flow

Cloudflare Containers are driven by a **Worker + a Durable Object** (one DO instance
per container). The existing backend is **Express on Railway**, which is *not* a
Worker — so this introduces **one new Cloudflare Worker** ("studio orchestrator").

```
Browser (Vite app, any device)
   │  1. POST /api/studio/launch   (Supabase JWT)               [existing Railway API]
   ▼
Express API (Railway)  ── authenticates, meters usage/limits, rate-limits ──┐
   │  2. signed service request (HMAC) to the Worker                          │
   ▼                                                                          │
Studio Worker (Cloudflare)  ── owns Sandbox Durable Object + Container ───────┘
   │  3. getSandbox(env.Sandbox, `u_<userId>_<projectId>`)
   │  4. writeFile() all artifact files  →  exec("npm install")  →  startProcess("npm run dev")
   │  5. exposePort(port) → returns preview URL with security token
   ▼
   returns { previewUrl, sandboxId, status } back up to the browser
   │
   ▼  6. window.open(previewUrl)  → NEW TAB → the live running app
Browser ───────────────────── 7. app traffic goes DIRECT to the preview URL
                                  (high-frequency; never through Railway)
```

**Why broker through Railway (step 1–2) instead of browser→Worker directly:**
the launch/build control-plane is low-frequency and must reuse the existing
**auth + `usageEnforcer` metering + rate limits** (see `server/src/services/usageEnforcer.ts`,
`server/src/middleware/limits.ts`). The actual *app traffic* (step 7) goes straight to
the preview URL, so Railway is never in the hot path.

---

## 3. The Studio Worker (new) — `studio-worker/`

A standalone Cloudflare Worker, deployed separately from the Vite frontend.

**`studio-worker/wrangler.jsonc`**
```jsonc
{
  "name": "dreamstream-studio",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "containers": [
    { "class_name": "Sandbox", "image": "./Dockerfile", "instance_type": "standard-2", "max_instances": 50 }
  ],
  "durable_objects": { "bindings": [{ "class_name": "Sandbox", "name": "Sandbox" }] },
  "migrations": [{ "new_sqlite_classes": ["Sandbox"], "tag": "v1" }],
  "routes": [{ "pattern": "*.studio.dreamstream.app/*", "zone_name": "dreamstream.app" }]
}
```

**`studio-worker/Dockerfile`** — bundles the runtimes we support. Node always; add
Python/etc. later (bigger image = slower cold start, so keep it lean to start):
```dockerfile
FROM docker.io/cloudflare/sandbox:0.x
# Node + npm already present in the sandbox base; add extra toolchains here if needed.
EXPOSE 3001
```

**`studio-worker/src/index.ts`** — control endpoints, service-auth guarded:
```ts
import { getSandbox } from "@cloudflare/sandbox";
export { Sandbox } from "@cloudflare/sandbox";

type Env = { Sandbox: DurableObjectNamespace; STUDIO_HMAC_SECRET: string };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    await verifyHmac(req, env.STUDIO_HMAC_SECRET);            // reject anything not from Railway
    const { action, sandboxId, files, port = 3001 } = await req.json();
    const sandbox = getSandbox(env.Sandbox, sandboxId);       // sandboxId = `u_<userId>_<projectId>`

    if (action === "launch") {
      for (const f of files) await sandbox.writeFile(f.path, f.content);
      const install = await sandbox.exec("npm install");      // or detect pnpm/yarn/pip
      if (!install.success) return json({ status: "error", log: install.stderr });
      await sandbox.startProcess(`PORT=${port} npm run dev`);  // long-running dev server
      const { url } = await sandbox.exposePort(port, { hostname: new URL(req.url).hostname });
      return json({ status: "starting", previewUrl: url, sandboxId });
    }
    if (action === "logs")  return streamLogs(sandbox);        // execStream → SSE
    if (action === "stop")  { await sandbox.stop(); return json({ status: "stopped" }); }
    return json({ status: "error", message: "unknown action" }, 400);
  }
};
```

Key SDK facts that shape this:
- `getSandbox(ns, id)` gets/creates a per-id container (DO-backed). **Scope `id` per
  authenticated user** so users can't touch each other's sandboxes.
- `exec()` = run-to-completion (install/build); `execStream()` = live logs;
  `startProcess()` = long-running dev server.
- `exposePort(port, { hostname, token? })` → `{ url }`. Port range **1024–65535,
  excluding 3000**. URL form: `https://{port}-{sandboxId}-{token}.studio.dreamstream.app`.
  A random 16-char token guards each URL; pass a custom token for a stable URL.

---

## 4. Required Cloudflare setup (prerequisites — needs the account owner)

1. **Workers Paid plan** ($5/mo minimum). Containers are not on the free plan.
2. **A custom domain with wildcard DNS**, e.g. `*.studio.dreamstream.app`, on a zone
   in the same Cloudflare account. **`*.workers.dev` does NOT work** — it can't route
   the dynamic preview subdomains. (You already run the frontend on Cloudflare Pages,
   so the zone is in place.)
3. **Docker** locally for building the container image during `wrangler deploy`.
4. Secrets: `STUDIO_HMAC_SECRET` (shared with Railway) via `wrangler secret put`.

---

## 5. Railway / Express changes (control plane)

New router `server/src/routes/studio.ts`, mounted at `/api/studio`:

- `POST /api/studio/launch` — auth (existing middleware) → `reserveForOperation` for
  cost guard → forwards `{ action:"launch", sandboxId, files }` to the Worker with an
  HMAC-signed body → returns `{ previewUrl, sandboxId }`. Settles usage on success.
- `GET  /api/studio/:id/logs` — proxies the Worker's SSE log stream to the client.
- `POST /api/studio/:id/stop` — stops the container; releases any reservation.

Config additions (`server/src/config.ts`): `STUDIO_WORKER_URL`, `STUDIO_HMAC_SECRET`.
Reuse `usageEnforcer` so a "studio.launch" operation is metered like image/chat ops,
and add a **per-user concurrency cap** (e.g. ≤ 2 live sandboxes) + a daily build-minute
cap to bound spend.

---

## 6. Client changes

- **`services/studioLauncher.ts`**: add `launchLiveStudio(artifact)` →
  `POST /api/studio/launch`, then `window.open(previewUrl, "_blank")`. Keep the existing
  `openInStudio` (WebContainer) only as a hidden desktop fallback, or remove it.
- **`components/chat/artifacts/CodeStudioCard.tsx`**: primary CTA becomes **"Run live
  (new tab)"** for `recommendedRuntime === "container"`; **"Quick preview"** (Sandpack)
  stays as the default for small front-end apps; **".zip"** stays.
- **New `components/chat/StudioLaunchModal.tsx`** (or reuse the side panel): shows
  build phases (Booting → Installing → Starting → Live) with **streamed logs** from
  `/api/studio/:id/logs`, an "Open app" button (the new tab), and "Stop".
- **`CodeStudioPanel.tsx`** (Sandpack) keeps the dependency install fix already shipped
  for the small-app tier.

---

## 7. Security & abuse (running arbitrary AI code)

- **Isolation** is provided by the container (microVM-class) + per-user sandbox IDs.
- **Auth at the edge**: the Worker only accepts HMAC-signed requests from Railway;
  Railway authenticates the user first. Preview URLs carry an unguessable token.
- **Resource caps**: `instance_type` (start `standard-2`), `max_instances`, idle
  **sleep timeout** (charges stop on sleep), max session length, per-user concurrency.
- **Egress**: AI code can make outbound calls. Decide whether to allow it; restrict via
  the Worker/container config if needed. Never inject our secrets into the container.
- **Cleanup**: a scheduled job stops/evicts sandboxes past max lifetime.

---

## 8. Cost model (verified pricing)

- CPU: **$0.000020 / vCPU-second**; Memory: **$0.0000025 / GiB-second**; Disk: ~$0.00000007/GB-s.
- Workers Paid includes **375 vCPU-min + 25 GiB-hr + 200 GB-hr** free monthly.
- **Sleeping containers stop CPU billing** (memory/disk while provisioned only). Billing
  is in 10ms increments, starting on first request/start.
- Rough estimate: a `standard-2` (2 vCPU / ~6 GiB) doing a 30s `npm install` + 2 min of
  active testing ≈ a few cents per session. The cost driver is **idle live servers** →
  aggressive `sleepAfter` + concurrency caps are essential.

---

## 9. Phased delivery

- **Phase 0 — Infra (owner):** Workers Paid, `*.studio.dreamstream.app` wildcard DNS,
  Worker skeleton deploys, Docker builds.
- **Phase 1 — Worker:** `launch`/`logs`/`stop`, per-user IDs, timeouts, exposePort. Prove
  a hardcoded React/Express app boots and serves a preview URL.
- **Phase 2 — Railway control plane:** `/api/studio/*` with auth + metering + HMAC +
  caps.
- **Phase 3 — Client:** launch flow, streamed-log build modal, open-in-new-tab, stop;
  tiering (Sandpack vs container).
- **Phase 4 — `generate_app` tool:** broaden to full-stack (allow server files,
  frameworks, a `startCommand`/`port` hint, `recommendedRuntime`).
- **Phase 5 — Hardening:** egress policy, cleanup job, dashboards, spend alerts.

Then **retire** WebContainer (`studio/`) and the unpkg-blob path → from 3 runtimes down
to 2 coherent tiers.

---

## 10. Open decisions needed before coding Phase 1

1. **Domain** for preview URLs (e.g. `studio.dreamstream.app`)? Confirm the zone.
2. **Workers Paid** plan approval (this costs money per run).
3. **Spend caps**: max concurrent live sandboxes/user, idle-sleep timeout, max session.
4. **Egress**: allow AI apps to call the internet, or lock down?
5. **Languages**: Node-only at first, or also Python/others in the image?
