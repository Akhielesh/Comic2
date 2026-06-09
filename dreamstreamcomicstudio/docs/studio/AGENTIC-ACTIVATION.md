# Turn ON the agentic Studio — the one-page activation guide

> **TL;DR:** The Code Studio ships with a real **agentic build loop** (it runs your app in a
> cloud sandbox, reads the *runtime* errors, and edits the files itself until it works). That loop
> is **OFF by default** because it needs a Cloudflare Worker you provision once. Until it's on, the
> studio uses the **one-shot fallback** (generate → static-verify → repair) — which is why builds
> can feel "it just builds, it isn't agentic." This page is the switch.

## The two modes (know which one you're in)

| | One-shot fallback (DEFAULT today) | Agentic loop (after activation) |
|---|---|---|
| Generates a multi-file app | ✅ | ✅ |
| Verifies the code | static only (`verifyApp`) | static **+ real run in a cloud sandbox** |
| Reads **runtime** errors & self-edits | ❌ (in-browser preview auto-fix only) | ✅ `PLAN→RUN→OBSERVE→FIX` (`runBuildAgent`) |
| Build keeps running if you leave / switch projects | ❌ (runs in your tab) | ✅ (runs server-side in the worker) |
| Live preview URL on any device | ❌ | ✅ `<port>-<id>-<token>.dreamstreamstudio.ai` |
| Needs | a coding model key (BYOK/free) | the above **+** the Cloudflare Worker below |

The agentic path is **already built and unit-tested** (`server/src/ai/studio/buildAgent.ts`,
`server/src/services/studioBuildService.ts`, `studio-worker/`). Activation is wiring + infra, not
new architecture.

## The switch — 3 layers, set in order

Detailed, copy-paste deploy steps live in **[`../../studio-worker/README.md`](../../studio-worker/README.md)**.
This is the checklist of what must be true:

1. **Deploy the Cloudflare Worker** (`studio-worker/`). Needs: Workers **Paid** ($5/mo, containers
   aren't free), the **`dreamstreamstudio.ai`** zone in Cloudflare (custom domain is *required* —
   `*.workers.dev` can't host the preview sub-subdomains), and Docker locally. Set its
   `STUDIO_HMAC_SECRET` secret. `npm run deploy` prints the worker's control URL.

2. **Point the Railway API at the worker** (API service → Variables → redeploy):
   - `STUDIO_WORKER_URL = https://dreamstream-studio.<account>.workers.dev`
   - `STUDIO_HMAC_SECRET = <the same secret from step 1>`

   Without **both**, `POST /api/studio/build` returns **503** *"Live Studio is not configured on
   this server yet"* (`server/src/routes/studio.ts`) and the UI uses the one-shot fallback.

3. **Reveal it in the frontend** (Cloudflare Pages → env → rebuild):
   - `VITE_STUDIO_LIVE_ENABLED = true` (admins see it without this flag)
   - apply the Supabase studio migrations (`server/sql/studio_*.sql`)

## Verify it's actually live

- `POST /api/studio/build` no longer 503s (the control plane reaches the worker).
- The studio shows a **"Run live"** affordance, and a build streams a real
  **plan → run → observe → fix** trace (not just "Building…").
- The preview opens at `https://<port>-…-….dreamstreamstudio.ai` in a new tab.
- You can navigate away / switch projects and the build keeps progressing server-side.

## Cost & safety (already enforced)

- Per-user caps: `STUDIO_MAX_CONCURRENT_PER_USER` (2), `STUDIO_DAILY_BUILD_MINUTES` (120),
  metered by `usageEnforcer`. Free-only mode never silently escalates to a paid model.
- The agent's terminal is allow-listed (`sanitizeStudioCommand`); fix file-writes are sanitized
  (`sanitizeFixFiles`); the build loop is bounded (`buildGuards`: max-iters + stuck detector).
- Everything is **safe-by-default**: with the env unset, production behaves exactly as it does
  today — the one-shot fallback — so nothing breaks until you deliberately flip these.

---
*Why this page exists:* the activation steps were spread across `studio-worker/README.md`,
`OWNER-ACTIONS.md`, and config. This is the single "is the agentic loop on, and how do I turn it
on?" reference. See also `04-AGENTIC-ENGINE.md` (how the loop works) and
`agent-constitution/02_ORCHESTRATOR.md` (the loop's rules).
