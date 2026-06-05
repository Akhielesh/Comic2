# Phase 0 — Cloudflare infrastructure

**Status:** ⛔ blocked (account owner action) · **Owner:** account holder · **Effort:** ~hours

## Goal
Have the Cloudflare account ready so the Studio Worker can deploy and serve preview URLs.

## Tasks (owner)
1. **Enable Workers Paid** ($5/mo) on the Cloudflare account (Containers aren't on Free).
2. **Choose & confirm the preview/deploy domain**, e.g. `studio.dreamstream.app`, on a
   zone already in this Cloudflare account.
3. **Add wildcard DNS:** `*.studio.<domain>` → routed to the Worker. (`*.workers.dev`
   does **not** support the dynamic preview subdomains — a custom zone is required.)
4. **Install Docker** locally for whoever runs `wrangler deploy` (the image is built then).
5. **Generate `STUDIO_HMAC_SECRET`** (a long random string); it will be set on both the
   Worker (`wrangler secret put`) and Railway env.

## Acceptance criteria
- `wrangler whoami` shows the account on the Workers Paid plan.
- `*.studio.<domain>` resolves and can be pointed at the Worker route.
- The chosen domain is recorded in `00-STATUS.md` and swapped into `studio-worker/wrangler.jsonc`
  + the docs (replace the `studio.dreamstream.app` placeholder).

## Notes
- This is the **only hard external dependency** for the whole project. Everything else is
  engineering we control.
- Cost while idle ≈ the $5 base; per-session compute ≈ 1.5¢ (see `CLOUDFLARE_STUDIO_PLAN.md`).

## When done → unblocks
Phase 1 deploy/validation.
