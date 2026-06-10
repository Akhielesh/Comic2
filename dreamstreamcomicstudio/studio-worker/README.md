# DreamStream Studio Worker (Phase 1)

A standalone **Cloudflare Worker** that runs AI-built apps inside per-user
[Cloudflare Containers](https://developers.cloudflare.com/containers/) (via the
[Sandbox SDK](https://developers.cloudflare.com/sandbox/)) and returns a tokenized
**live preview URL** the user opens in a new tab. This is the foundation of DreamStream
Studio v2 — see the full docs at [`../docs/studio/`](../docs/studio/) (start at
[`README.md`](../docs/studio/README.md) / [`00-STATUS.md`](../docs/studio/00-STATUS.md)).

> **Validated against the real SDK.** `src/index.ts` typechecks against
> `@cloudflare/sandbox` 0.4.18 (`npm install && npm run typecheck`). It still needs a live
> `wrangler deploy` (Cloudflare account, Workers Paid, Docker, a custom domain) to validate
> end-to-end — it can't run in the app's CI.

## ⚠️ A custom domain is REQUIRED (no way around it on workers.dev)
Cloudflare's Sandbox builds **subdomain** preview URLs (`<port>-<id>-<token>.<domain>`) and
`exposePort()` **throws `CustomDomainRequiredError` on `*.workers.dev`** — that domain has no
wildcard sub-subdomains. (An earlier note here claimed a zero-config tunnel avoided this; that
API does not exist in the SDK. The custom domain is real and unavoidable for live previews.)

**This deployment uses `dreamstreamstudio.ai`** (configured): previews are
`<port>-<id>-<token>.dreamstreamstudio.ai`, covered by **free Universal SSL** (first-level
wildcard). The worker claims ONLY the `*.dreamstreamstudio.ai/*` route, so the bare apex and
`www` stay free for your real site. The **control endpoint stays on the worker's
`*.workers.dev` URL** (control POSTs don't need the domain — only `exposePort` does, and it
reads `STUDIO_PREVIEW_DOMAIN`). `dreamstreamstudio.com` → `.ai` is a Redirect Rule (below).

## Prerequisites (account owner)
1. **Workers Paid** plan ($5/mo) — containers aren't on the free plan.
2. **`dreamstreamstudio.ai` added to Cloudflare as a zone** in this account (update its
   nameservers to Cloudflare's). Universal SSL then covers `*.dreamstreamstudio.ai`.
3. **Docker** running locally (`docker info`) — `wrangler deploy` builds the image.

## Deploy (step by step)
```bash
cd studio-worker
npm install
npm run typecheck                     # should pass clean

# wrangler.jsonc is already set: route *.dreamstreamstudio.ai/* + STUDIO_PREVIEW_DOMAIN.
npx wrangler login
npx wrangler secret put STUDIO_HMAC_SECRET   # paste a strong random string
npm run deploy                        # builds + pushes the image; first deploy ~few min
```
The deploy prints the worker's `https://dreamstream-studio.<account>.workers.dev` URL.

Then in **Railway** (the API service → Variables, redeploy):
- `STUDIO_WORKER_URL = https://dreamstream-studio.<account>.workers.dev`  (the **control** URL)
- `STUDIO_HMAC_SECRET = <the same secret you set above>`

### Route dreamstreamstudio.com → dreamstreamstudio.ai
In Cloudflare: add **`dreamstreamstudio.com`** as a zone too, then **Rules → Redirect Rules →
Create** a dynamic redirect:
- **If** `Hostname` equals `dreamstreamstudio.com` **or** `www.dreamstreamstudio.com`
- **Then** 301 to expression: `concat("https://dreamstreamstudio.ai", http.request.uri.path)`
- Preserve query string ✓

Then in **Cloudflare Pages** (frontend env, rebuild): `VITE_STUDIO_LIVE_ENABLED = true` to
reveal the "Run live" button. And apply the Supabase migrations (`server/sql/studio_*.sql`).

> After the first deploy, wait ~2–3 minutes for container provisioning before testing.

## API (called only by the Railway backend, HMAC-signed)
`POST /` with `x-studio-signature: sha256=<hmac of raw body>` and JSON:
- `{ action: "launch", sandboxId, files:[{path,content}], install?, dev?, port? }`
  → `{ status:"starting", previewUrl, sandboxId, port }`  (or `{ status:"error", phase:"install", log }`)
- `{ action: "logs", sandboxId }` → `{ status:"ok", stdout, stderr }` — the dev process output
  the Phase 4 build loop reads to self-correct; also powers the in-app log panel.
- `{ action: "stop", sandboxId }` → `{ status:"stopped" }`

Inbound **preview** requests (browser → the running app) are matched by `proxyToSandbox` and
routed to the right container; everything else is a control request. `sandboxId` is scoped per
authenticated user (`u_<userId>_<projectId>`) by the Railway route. Never expose this Worker
directly to browsers.

## How the routing works
`exposePort(port, { hostname })` uses `STUDIO_PREVIEW_DOMAIN` (= `dreamstreamstudio.ai`) as the
base, so the preview URL is `https://<port>-<id>-<token>.dreamstreamstudio.ai`. The single
`*.dreamstreamstudio.ai/*` route sends every such host back to this Worker → `proxyToSandbox` →
the right container. No per-preview DNS records. Control POSTs come in on the worker's
`*.workers.dev` URL (Railway's `STUDIO_WORKER_URL`), which is independent of the preview domain —
so the bare apex `dreamstreamstudio.ai` is never touched by the worker and is free for your site.

<!-- deploy marker: 2026-06-10T15:44:24Z — trigger worker redeploy after token update -->
<!-- deploy marker: 2026-06-10T16:17:19Z — verify rotated Cloudflare token -->
<!-- deploy marker: 2026-06-10T16:23:13Z — token permissions updated -->
