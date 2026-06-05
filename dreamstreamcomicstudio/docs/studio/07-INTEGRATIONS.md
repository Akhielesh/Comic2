# 07 — Integrations

## GitHub two-way sync (Phase 6)
**Goal:** connect a repo, push the project, open PRs, pull changes back (Lovable parity).
- **Auth:** GitHub OAuth (or a GitHub App for finer scopes). Store the token encrypted
  (reuse `services/crypto.ts` / `user_api_keys` patterns).
- **Push:** create/select repo → commit the `studio_files` tree → branch + optional PR.
- **Pull:** fetch repo tree → update `studio_files` → new `studio_version`.
- **UI:** `GitHubMenu` (connect, repo picker, "commit", "open PR", sync status).
- **API surface (server):** `/api/studio/github/connect|repos|push|pull`.
- We already use the GitHub API elsewhere — reuse the client + token handling.

## One-click deploy (Phase 6)
**Goal:** publish the built app to a public URL.
- **Primary target:** **Cloudflare Pages/Workers** (we're already on Cloudflare). The
  Studio Worker (or a deploy job) builds the project and publishes it.
- **Flow:** user clicks Deploy → Railway `/api/studio/deploy` → build → publish →
  `studio_deployments` row + `deploy_url` → shown in UI.
- **Later targets:** Vercel, Netlify (token-based), and "export .zip / push to GitHub +
  let their CI deploy".
- **UI:** `DeployMenu` (target, status, public URL, redeploy).

## Per-project backend / database (Phase 7)
Many real apps need auth + a DB (Lovable's signature: a Supabase per app).
- **Start simple:** **SQLite inside the container** for app data during dev — zero infra,
  works for most "build me X" demos.
- **Then:** offer a **Supabase-per-project** (or a shared Supabase with strict RLS and a
  per-project schema) for apps that need real auth/DB/storage. Provision via the Supabase
  Management API; inject connection details as env vars into the container (never our
  platform secrets).
- **Decision pending** (see `00-STATUS.md`): SQLite-first is recommended.

## Models (already integrated — keep BYOK/free-first)
- Inference via OpenRouter / NVIDIA / Gemini (`server/src/ai/providers/`).
- **BYOK** (user keys in `user_api_keys`) or **free hosted** models → $0 platform token cost.
- Build agent routes PLAN/FIX to a **strong coding model**; frontier via BYOK/credits.
- Tools are OpenRouter-only; the Markdown→Studio fallback covers all models (shipped #75).

## Billing / usage (extend existing)
- Add a `studio.run` operation to `usageEnforcer` (container compute) alongside existing
  token metering. BYOK bypasses token cost; compute is metered from `studio_runs`.
- Surface studio cost in the same dashboards as chat/image (`SystemDashboard`, usage views).
- Plans/credits: reuse Stripe + `billing_plans` / `user_plan_subscriptions`.

## Storage / outputs (optimize egress)
- Generated images already → Supabase Storage as WebP (`server/src/services/imageStorage.ts`).
- **Recommended optimization:** serve image/build outputs from **Cloudflare R2**
  ($0.015/GB storage, **free egress**) — best for an image-heavy product. Keep Postgres
  on Supabase. (See `CLOUDFLARE_STUDIO_PLAN.md` cost section.)

## External services summary
| Service | Used for | Notes |
|---|---|---|
| Cloudflare (Workers/Containers/Pages/R2) | sandbox, deploy, output storage | primary infra |
| Supabase | auth, Postgres, storage | existing backbone |
| Railway | Express backend + Redis (queues) | existing |
| OpenRouter / NVIDIA / Gemini | model inference | BYOK / free-first |
| GitHub | repo sync | Phase 6 |
| Stripe | billing/credits | existing |
