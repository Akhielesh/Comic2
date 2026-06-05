# DreamStream Studio Worker (Phase 1)

A standalone **Cloudflare Worker** that runs AI-built apps inside per-user
[Cloudflare Containers](https://developers.cloudflare.com/containers/) (via the
[Sandbox SDK](https://developers.cloudflare.com/sandbox/)) and returns a tokenized
**live preview URL** the user opens in a new tab. This is the foundation of DreamStream
Studio v2 — see [`../docs/CLOUDFLARE_STUDIO_PLAN.md`](../docs/CLOUDFLARE_STUDIO_PLAN.md)
(architecture, cost) and [`../docs/PRODUCT_BLUEPRINT.md`](../docs/PRODUCT_BLUEPRINT.md)
(product).

> **This is a deploy-ready scaffold, not yet validated end-to-end.** It can't run in the
> app's CI (it needs a Cloudflare account, Workers Paid, Docker, and a wildcard domain).
> Validate the Sandbox SDK calls in `src/index.ts` on the first `wrangler deploy`.

## Prerequisites (account owner)
1. **Workers Paid** plan ($5/mo) — containers aren't on the free plan.
2. A **custom domain with wildcard DNS**, e.g. `*.studio.dreamstream.app`, on a zone in
   the same Cloudflare account. `*.workers.dev` will **not** work for preview URLs.
3. **Docker** running locally (`docker info`) — `wrangler deploy` builds the image.

## Recommended: start from the official template, then drop in our code
Package/image versions move together with the SDK. The safest path:
```bash
npm create cloudflare@latest -- studio-worker --template=cloudflare/sandbox-sdk/examples/minimal
# then copy our src/index.ts, wrangler.jsonc (routes!) and Dockerfile over the template's,
# keeping the template's package.json versions.
```
Or use the files here directly and `npm install` (versions are best-effort — bump to the
latest the SDK docs list if install complains).

## Configure
- In `wrangler.jsonc`, set `routes[].pattern` + `zone_name` to **your** domain.
- In `Dockerfile`, pin the base image tag to your installed `@cloudflare/sandbox` version.
- Set the shared secret used to authenticate calls from the Railway backend:
  ```bash
  npx wrangler secret put STUDIO_HMAC_SECRET   # same value goes in Railway env
  ```

## Deploy
```bash
npm install
npm run typecheck
npm run deploy        # wrangler deploy (builds the container image)
```

## API (called only by the Railway backend, HMAC-signed)
`POST /` with `x-studio-signature: sha256=<hmac of raw body>` and JSON:
- `{ action: "launch", sandboxId, files:[{path,content}], install?, dev?, port? }`
  → `{ status:"starting", previewUrl, sandboxId, port }`
- `{ action: "stop", sandboxId }` → `{ status:"stopped" }`

`sandboxId` must be scoped per authenticated user (e.g. `u_<userId>_<projectId>`) — the
Railway route sets this after auth. Never expose this Worker directly to browsers.

## Next (Phase 2–3)
- Railway `/api/studio/*` control plane (auth + usage metering + concurrency/idle caps).
- Client launch flow + streamed build logs + open-in-new-tab (see the blueprint roadmap).
