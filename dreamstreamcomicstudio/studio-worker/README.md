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

A **cheap dedicated domain (~$8–10/yr)** is perfect. Use the **apex** (first-level wildcard
`*.EXAMPLE.COM`) so free **Universal SSL** covers preview hosts — a sub-subdomain like
`*.studio.EXAMPLE.COM` would need a paid Advanced Certificate.

## Prerequisites (account owner)
1. **Workers Paid** plan ($5/mo) — containers aren't on the free plan.
2. A **custom domain added to Cloudflare as a zone** in this account (any registrar works;
   Cloudflare Registrar is cheapest/at-cost). Universal SSL on the apex covers `*.EXAMPLE.COM`.
3. **Docker** running locally (`docker info`) — `wrangler deploy` builds the image.

## Deploy (step by step)
```bash
cd studio-worker
npm install
npm run typecheck                     # should pass clean

# 1. Add your domain to wrangler.jsonc: uncomment the "routes" block, replace EXAMPLE.COM.
# 2. Set the shared HMAC secret (the SAME value also goes in Railway env):
npx wrangler login
npx wrangler secret put STUDIO_HMAC_SECRET

# 3. Deploy (builds + pushes the container image; first deploy takes a few minutes):
npm run deploy
```
Then in **Railway** (the API service → Variables, redeploy):
- `STUDIO_WORKER_URL = https://EXAMPLE.COM` (your domain — the control endpoint)
- `STUDIO_HMAC_SECRET = <the same secret you set above>`

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

## How the no-DNS-headache routing works
`exposePort(port, { hostname })` uses the **incoming request host** as the base, so when Railway
POSTs to `https://EXAMPLE.COM` the preview URL becomes `https://<port>-<id>-<token>.EXAMPLE.COM`,
which the `*.EXAMPLE.COM/*` route sends back to this Worker → `proxyToSandbox` → the container.
No per-preview DNS records; the single wildcard route covers them all.
