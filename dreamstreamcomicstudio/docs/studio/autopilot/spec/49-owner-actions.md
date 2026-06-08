# 49 — Owner Actions & External Dependencies

> Part V · Delivery · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan §12 owner actions (consolidated)](../00-MASTER-PLAN.md#12-owner-actions) +
> the per-epic **Owner action** lines (A0–A9) · [Enterprise Foundations](../F-ENTERPRISE-FOUNDATIONS.md)
> (F0 observability, F6 migrations, F8 supply-chain) · existing studio checklist
> [`../OWNER-ACTIONS.md`](../OWNER-ACTIONS.md). Sibling sections referenced inline:
> [05 pricing](./05-business-model-pricing.md), [26 schema](./26-data-model-schema.md),
> [30 integrations](./30-integrations-framework.md), [31 deploy adapters](./31-deploy-adapters.md),
> [33 sessions/identity](./33-sessions-identity.md), [35 security](./35-security-threat-model.md),
> [38 observability](./38-observability.md), [40 cost/FinOps](./40-cost-finops.md),
> [44 CI/CD](./44-cicd-release.md).

## 49.1 What this section is

This is the **owner's one-stop checklist**: a single, consolidated, prioritized list of
everything Autopilot needs that **only the human owner can do** — not Claude. Claude builds
all the *code* behind flags; this list is the *human-only* surface: provider accounts,
secrets/env vars set in host dashboards, DB migrations to apply, infra steps, money
decisions, and GA approvals.

It supersedes nothing — it **consolidates** what is scattered across the Master Plan §12
table, the per-epic "Owner action" lines (A0–A9), and the live studio checklist in
[`../OWNER-ACTIONS.md`](../OWNER-ACTIONS.md) — and adds the items the deep spec sections
surfaced after the plan was written (Sentry, `audit_log`/`user_devices`/`sessions`
migrations, the `VENTURES_*` flags, per-venture BYO).

**Honest framing, restated from the plan:** *nothing below blocks Claude from writing the
code.* Every epic ships flag-gated and no-op until configured. These actions **light up live
behavior** and **gate GA**. Values are set in host dashboards (Cloudflare Pages, Railway,
Supabase, Stripe, Nango) and **never committed** — the repo's standing rule is "secrets are
never printed." Session telemetry confirms the relevant vars are currently **UNSET** in this
environment (see §49.6); that is expected — they are owner-set in prod, not in the build
sandbox.

**Status legend:** ✅ done (verified live) · ⏳ pending · ❓ owner to confirm · 🔮 future ·
— not applicable.

---

## 49.2 The master checklist — `action | why | when (gating epic) | how | status`

Ordered by the epic that first **gates** on it. "Gating epic" = the earliest epic that
cannot go *live* (not "cannot be built") without it. P-rank carries the studio-checklist
priority where it maps.

### 49.2.1 Already done (inherited from the live studio — do not redo)

| Action | Why | Gating epic | How | Status |
|---|---|---|---|---|
| Cloudflare **Workers Paid** ($5/mo) | Containers aren't on Free; the studio-worker sandbox + future DO/Workflows need it | A4 (real builds) | Cloudflare dashboard → Workers Paid | ✅ done (worker deployed = plan active) |
| Zone `dreamstreamstudio.ai` + Universal SSL | Preview/prod hostnames + wildcard | A5 (managed deploy) | Cloudflare zone | ✅ done (live, verified) |
| Wildcard preview DNS `A * → 192.0.2.0` (proxied) | `*.dreamstreamstudio.ai` previews route to the worker | A5 | Cloudflare → DNS | ✅ done |
| Deploy the **studio-worker** | Runs AI-built apps in the sandbox | A4 | `wrangler deploy` | ✅ done (`dreamstream-studio` live) |
| `STUDIO_HMAC_SECRET` (worker + Railway) | Control-plane → worker auth hop | A4 | both hosts' env | ✅ done (both sides) |
| Studio DB tables applied | Run metering, project/version persistence, MCP/agents | A4 | Supabase | ✅ done (7 tables, RLS on, advisors clean) |
| `SUPABASE_SERVICE_ROLE_KEY` in prod | Server-side persistence | A1+ | Railway env | ✅ done (image pipeline uses it) |

> These are real prerequisites Autopilot inherits, not new work. They are listed so the
> owner does not re-do them and so the dependency chain is complete.

### 49.2.2 New / pending for Autopilot (the actual to-do list)

| Action | Why | When (gating epic) | How | Status |
|---|---|---|---|---|
| Apply migration **M1 `audit_log.sql`** | Append-only forensic trail; the kill-switch flip + role changes must be auditable from day one ([33 §26.11](./33-sessions-identity.md), [26 §26.13](./26-data-model-schema.md)) | **A0** (brakes) | Supabase migration runner (§49.4) | ⏳ pending |
| Apply migration **M2 `user_devices.sql`** | Creates the **missing** device-registry table the live code already writes to but has no DDL for ([33 §33.3.3](./33-sessions-identity.md)) | A0/F3 | Supabase, after M1 | ⏳ pending |
| Apply migration **M3 `sessions.sql`** | Session table (FK → `user_devices`); idle/abs/revoke + step-up ([33 §33.5](./33-sessions-identity.md)) | A0/F3 | Supabase, **after M2** (FK order) | ⏳ pending |
| Apply migration **M5 `ventures_foundation.sql`** | `ventures`, `venture_budgets`, `venture_checkpoints`, `venture_events` + RLS owner-isolation — the governance substrate | **A0** | Supabase | ⏳ pending |
| Apply migration **M6 `ventures_control_plane.sql`** | `venture_goals`, `venture_runs`, `venture_connections`; `alter studio_projects/studio_deployments add venture_id …` | **A1** | Supabase, **after M5** | ⏳ pending |
| Set **`VENTURES_ENABLED`** (default **false**) | Master flag gating *all* autonomy; stays false until A9 GA ([44 §44 release matrix](./44-cicd-release.md)) | A0 (define) → A9 (flip) | Railway env | ⏳ pending (leave false) |
| Wire the **`VENTURES_KILL`** global kill switch | One flag pauses **every** venture; re-checked at schedule time *and* in the DECIDE gate ([42 §42.8 DR](./42-disaster-recovery.md)) | A0 | Railway env + admin route | ⏳ pending |
| Provision **`REDIS_URL`** for the ventures worker | BullMQ scheduler/queue; may reuse the ComicForge Redis or a dedicated instance | **A2** (loop engine) | Railway env (the worker service) | ⏳ pending |
| Add the **ventures worker as a Railway service** | The autonomous scheduler runs as a separate process so the loop never blocks the API (`npm run ventures:worker`) | **A2** | Railway → new service from the same repo | ⏳ pending |
| Confirm `VITE_STUDIO_LIVE_ENABLED=true` | Reveals "Run live" to non-admins; A4 reuses the same sandbox path | **A4** | Cloudflare Pages env → rebuild | ❓ owner to confirm |
| Confirm `STUDIO_WORKER_URL` is set | Control-plane → worker URL for real sandboxed builds | **A4** | Railway env → redeploy | ❓ owner to confirm |
| Nango self-host: `NANGO_ENCRYPTION_KEY` (generate once, never rotate) | Encrypts BYO credentials at rest; **mandatory** for the connector stack ([30 §30](./30-integrations-framework.md)) | **A5** (BYO) | `openssl rand -base64 32` → compose env, store securely | ⏳ pending |
| Nango self-host: `NANGO_HOST` + `NANGO_SECRET_KEY` | App-server → Nango server-to-server calls; secret copied from the Nango dashboard after first boot | A5 | run `deploy/studio-tools/docker-compose.yml`; copy secret | ⏳ pending |
| Per-venture **BYO provider connections** (Cloudflare / Vercel / Railway / Supabase / GitHub) | Deploy to the *user's* own accounts; tokens become per-venture, revocable, least-privilege ([31 §31](./31-deploy-adapters.md)) | **A5** | Operator Console connect flow (Nango/OAuth/PAT) — per venture, not global | ⏳ per-venture, owner+user |
| (Optional) platform deploy tokens: `CLOUDFLARE_API_TOKEN`+`CLOUDFLARE_ACCOUNT_ID`, `VERCEL_TOKEN`, `RAILWAY_TOKEN` | Managed-mode deploys we front | A5 (managed) | Railway env | ❓ optional |
| GitHub connect: `GITHUB_OAUTH_CLIENT_ID` + `_SECRET` (+ callback URL) | Repo create/push/PR per venture; two-way sync already coded | A5 | GitHub OAuth/App → Railway env | ⏳ pending (P1) |
| Supabase-per-project: `SUPABASE_OAUTH_CLIENT_ID`/`_SECRET` **or** `SUPABASE_MANAGEMENT_TOKEN` | Agent provisions DB/auth/storage for *generated* apps (distinct from the platform Supabase) | A5 (provision) | Supabase OAuth app or mgmt PAT → Railway env | 🔮 optional |
| Confirm **Stripe** product/price config for credits + plans | The central billing portal: credit packs + Pro/Team plans (reuse existing IDs) | **A7** (portal) | Stripe dashboard; `STRIPE_*` env (§49.6) | ❓ confirm existing |
| Set **money defaults** (markup, budget defaults, plan prices) | Owner sets margin + the default budget caps; see §49.5 | A7 | Railway env + Stripe + plan-entitlement rows | ⏳ owner decision |
| Create a **Sentry** project → `SENTRY_DSN` (server) + client DSN | Error tracking / observability; F0 prerequisite for GA ([38 §38](./38-observability.md), [35 §35](./35-security-threat-model.md)) | **A9** (GA / F0) | Sentry dashboard → Railway + Pages env | ⏳ pending |
| Provide **notification webhooks** (pager + ops channel) | Spend/health/anomaly alerts route somewhere a human sees ([38 §38](./38-observability.md)) | A9 (recommended A7) | host env for the alerter | ⏳ pending |
| Enable **Dependabot / CodeQL**; set explicit `ADMIN_EMAILS` in prod | Supply-chain (F8) + lock down who is admin before plan-gating ([35 §35](./35-security-threat-model.md)) | **A9** | repo settings + Railway env | ⏳ pending |
| **Review the security report + approve GA** | The human gate that flips autonomy admin-only → plan-gated; provision any production secrets | **A9** | read `/security-review` output + pen-test sign-off (§49.7) | ⏳ pending |
| (Optional) tool-sourcing keys: `TAVILY_API_KEY`/`BRAVE_API_KEY`, `FOURSQUARE_API_KEY`, `SHADCN_GITHUB_TOKEN` | Raise sense-layer / tool reliability | A6 (optional) | Railway env | 🔮 optional |
| (Optional) BYO analytics keys (per venture) | Richer SENSE signal for the iterate loop | A6 (optional) | per-venture connection | 🔮 optional |
| (Optional) `www` record + `.com → .ai` 301 | Vanity domains | any | Cloudflare | ❓ optional |

> **One-line owner summary by milestone:** **A0–A2** = apply 5 migrations + set the two
> `VENTURES_*` flags + Redis + a Railway worker service. **A3–A5** = confirm the two studio
> envs, stand up Nango, connect per-venture provider accounts. **A7** = confirm Stripe +
> set money defaults. **A9** = Sentry, supply-chain, security review, **approve GA**.

---

## 49.3 Accounts the owner must hold

Every external account Autopilot relies on, with who pays and the risk if it lapses. Most
already exist for the live studio; the **new** ones are Nango (self-host) and Sentry.

| Provider / account | Why Autopilot needs it | New for Autopilot? | Who pays | Gating epic |
|---|---|---|---|---|
| **Cloudflare (Workers Paid)** | Sandbox containers, preview/prod hosting, DO/Workflows, wildcard DNS | No (live) | Owner (platform); user in BYO | A4/A5 |
| **Supabase** | System-of-record (Postgres + auth + RLS) for all `venture_*` + studio tables | No (live, project `Comic`) | Owner | A0+ |
| **Stripe** | Plans, credit packs, top-ups, overage capture | No (live) | Owner (collects) | A7 |
| **Nango (self-hosted, Elastic License v2)** | OAuth/connection broker + BYO key custody for BYO accounts | **Yes** | Owner (self-host infra) | A5 |
| **Model providers** (OpenRouter / Gemini / NVIDIA / Pixazo) | Inference for ORIENT + the build loop; platform key funds paid tier, BYOK collapses COGS to ~0 | No (live) | Owner (platform key) or user (BYOK) | A2+ |
| **Sentry** | Error tracking; F0 observability prerequisite for GA | **Yes** | Owner | A9 |
| **Railway** | Express API + the new ventures-worker service (transitional, retires as coordination moves to DOs per [40 §40.2](./40-cost-finops.md)) | Service is new; account exists | Owner | A2 |
| **GitHub** (OAuth/App) | Repo create/push/PR per venture | App is new; account exists | Owner sets app; user authorizes | A5 |
| **DNS registrar** (domains owned) | `dreamstreamstudio.ai`/`.com` already bought | No | Owner | — |

---

## 49.4 DB migrations — apply order & how

All migrations are **forward-only + idempotent**; "rollback" is a new forward migration, never
an in-place edit ([26 §26.13](./26-data-model-schema.md)). **FK order is load-bearing** — apply
top-to-bottom.

| Step | File | Adds | Epic | Depends on |
|---|---|---|---|---|
| 1 | `audit_log.sql` (M1) | `audit_log` (admin-only, RLS deny-all to clients) | F0/A0 | none — ships first |
| 2 | `user_devices.sql` (M2) | `user_devices` (the missing table) | F3 | — |
| 3 | `sessions.sql` (M3) | `sessions` (FK → `user_devices`) | F3 | **M2** |
| 4 | `user_settings.sql` (M4) | `user_settings` (notify prefs) | — | — |
| 5 | `ventures_foundation.sql` (M5) | `ventures`, `venture_budgets`, `venture_checkpoints`, `venture_events` + RLS | **A0** | — |
| 6 | `ventures_control_plane.sql` (M6) | `venture_goals`, `venture_runs`, `venture_connections`; `alter studio_projects/studio_deployments add venture_id …` | **A1** | **M5** (+ `ventures` for the studio_* FKs) |

**How:** adopt the Supabase migration runner (`supabase/migrations/`, ordered + versioned)
per [26 §26.13](./26-data-model-schema.md); the owner applies via the existing Supabase
access (the studio tables were applied the same way). **Verify after each:** RLS enabled on
every new table, `get_advisors` clean (mirrors the studio migration acceptance bar). Owner
action per the Master Plan A1 line: "apply the two [ventures] migrations via the existing
Supabase migration flow" — this section adds M1–M4 (foundations) ahead of them.

---

## 49.5 Money decisions (owner-only)

[05 — Business Model & Pricing](./05-business-model-pricing.md) and
[40 — Cost & FinOps](./40-cost-finops.md) provide the model; **these knobs are the owner's to
set.** Every number below is *illustrative/proposed* — nothing is a commitment until the
owner picks it.

| Decision | Lever (where it's set) | Current / proposed default | Notes |
|---|---|---|---|
| **Platform markup on metered compute** | `BILLING_PLATFORM_MARKUP` env → `DEFAULT_MARKUP` | **1.30** (+30%) — live | One knob = gross margin on managed compute ([05 §5.2](./05-business-model-pricing.md)). BYOK bills $0. |
| **Plan prices** | Stripe + plan-entitlement rows | Free $0 · Pro **~$29/mo** · Team **~$99/seat/mo** (proposed) | Re-skin existing `free/creator/pro/studio` plans; entitlements are data, no migration ([05 §5.3](./05-business-model-pricing.md)). |
| **Included credits / mo** | plan-entitlement rows (CT) | Free ~10,000 CT (≈$1) · Pro ~240,000 CT (≈$24) (illustrative) | `CT_USD = 0.0001` (10,000 CT = $1). |
| **Credit pack pricing** | `CREDIT_PACKS` + Stripe price IDs | $10→100k · $25→260k · $100→1.1M CT (live, volume-discounted) | Reuse verbatim — already shipped + idempotent. |
| **Default venture budget caps** | `venture_budgets` defaults | owner-set: `usd_per_day`, `usd_total`, `max_tokens`, `max_container_minutes` | **Set conservative defaults for managed** — these are the financial brakes; managed previews must be quota-tight ([40 §40.1](./40-cost-finops.md)). |
| **Account-level spend cap** | account spend cap + daily guardrail | owner-set | Global backstop above per-venture budgets. |
| **Free-tier managed quota** | entitlement row | 1 venture · 1 tick · tight managed-minute pool · preview-only | Free is bounded by *managed cost*, never by punishing BYOK ([05 §5.3](./05-business-model-pricing.md)). |
| **Managed minute rate** | `STUDIO_COST_PER_AWAKE_SEC` + the `other_billable` axis | `0.00003`/awake-sec (live) | Rolls per-tick container cost into the venture ledger ([05 §5.2](./05-business-model-pricing.md)). |

**Honest note (carried from the plan §11 + [40 §40.1](./40-cost-finops.md)):** in **managed**
hosting *we* front provider cost, so budgets + caps + the kill switch are **mandatory** — they
are how managed hosting "can't bankrupt us." In **BYO** the user pays providers directly and we
meter only orchestration. Set managed defaults tight; nudge real production to BYO.

---

## 49.6 Secrets / env vars — grouped

Grouped exactly as requested. **None of these are committed**; they are set in host
dashboards. Session check (§49.1) confirms all are currently **UNSET** in this build sandbox
— expected.

### A. Existing-but-unset (set for prod; some already set in prod, unset only in this sandbox)

| Var | Purpose | Host | Note |
|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side persistence | Railway | ✅ set in prod (image pipeline); unset in sandbox |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_*`, `STRIPE_PRICE_ID_CREDIT_PACK_*` | Billing + credits | Railway | Confirm price IDs for A7 |
| `OPENROUTER_API_KEY` (+ `NVIDIA_API_KEY`, `GEMINI_API_KEY`) | Platform-funded inference; BYOK bypasses | Railway | Optional if BYOK-only |
| `STUDIO_WORKER_URL`, `STUDIO_HMAC_SECRET` | Control-plane → sandbox worker | Railway | HMAC ✅ set; confirm URL (A4) |
| `VITE_STUDIO_LIVE_ENABLED` | Reveal "Run live" to non-admins | Cloudflare Pages | Confirm `=true` (A4) |
| `BILLING_PLATFORM_MARKUP` | Margin knob (default 1.30) | Railway | §49.5 |
| `REDIS_URL` | Queue/worker backend | Railway | Shared with ComicForge or dedicated (A2) |

### B. New for Autopilot

| Var | Purpose | Default | Host | Epic |
|---|---|---|---|---|
| `VENTURES_ENABLED` | Master autonomy flag | **false** until GA | Railway | A0→A9 |
| `VENTURES_KILL` | Global kill switch (one flag halts all) | false | Railway + admin route | A0 |
| `REDIS_URL` (ventures worker) | Scheduler/queue | — | the worker service | A2 |
| `SENTRY_DSN` (+ client DSN) | Error tracking (F0) | — | Railway + Pages | A9 |
| `ADMIN_EMAILS` | Explicit admin allowlist before plan-gating | — | Railway | A9 |
| notification webhooks (pager + ops) | Alert routing | — | Railway | A7/A9 |

### C. Nango self-host (BYO connector stack — [30 §30](./30-integrations-framework.md))

| Var | Purpose | Note |
|---|---|---|
| `NANGO_ENCRYPTION_KEY` | Encrypts BYO creds at rest | **Generate once, never rotate** (`openssl rand -base64 32`) — mandatory |
| `NANGO_HOST` / `NANGO_SECRET_KEY` | App → Nango server-to-server | Secret copied from Nango dashboard after first boot |
| `NANGO_DEFAULT_CONNECTION_ID` | Optional test connection | Lets agents inspect real response shapes |

### D. Per-venture BYO tokens (set by owner *or* end-user, per venture — not global)

| Connection | Token(s) | Set via |
|---|---|---|
| Cloudflare | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | Operator Console connect flow (Nango/PAT), stored as a `venture_connections` reference — never in our DB plaintext |
| Vercel | `VERCEL_TOKEN` | same |
| Railway | `RAILWAY_TOKEN` | same |
| Supabase (per-project provision) | `SUPABASE_OAUTH_*` or `SUPABASE_MANAGEMENT_TOKEN` | same |
| GitHub | `GITHUB_OAUTH_CLIENT_ID` + `_SECRET` (platform app) → per-user OAuth | OAuth app (owner) + per-user authorize |

> **Secret-handling stance ([Master Plan §5.3](../00-MASTER-PLAN.md#5-security--multi-tenancy)):**
> BYO credentials live **only** in Nango (encrypted), never in our DB plaintext, never in the
> client bundle. `venture_connections` stores a Nango reference + metadata only. Platform
> secrets stay in host env. Deploy tokens are per-venture, least-privilege, revocable, and
> **never logged**.

---

## 49.7 GA approvals (the human gates)

Some things **cannot** be auto-resolved by Claude — they require human judgement and are
hard gates on going live. From [Master Plan A9](../00-MASTER-PLAN.md#epic-a9--multi-tenant-security-hardening--ga)
+ [35 §35](./35-security-threat-model.md).

| Approval | What the owner reviews | Gate it unblocks |
|---|---|---|
| **Roadmap approval** (per venture) | The agent-drafted roadmap before autonomous work starts (a checkpoint, A3) | The A2 loop begins working a venture |
| **Production-deploy checkpoint** (per venture) | First prod deploy + custom-domain go-live | Anything public ships |
| **Spend / destructive checkpoints** | Paid resource, domain purchase, DB/resource delete | Money is spent or data is destroyed |
| **Security review sign-off** | `/security-review` of the whole `venture_*` surface; tenant-isolation audit; secret-handling review; external pen-test | **GA** — flip `VENTURES_ENABLED` admin-only → plan-gated |
| **GA go-live** | The go-live checklist; production secrets provisioned (Sentry, admin allowlist) | Public launch (A9) |

**The GA gate is non-negotiable** (plan §5 stance: "we never run the engine without the
brakes"; treat A9 as a real gate, not a formality). No autonomous work reaches non-admin
users until the owner has read the security report and explicitly approved.

---

## 49.8 External dependencies & their risk

The providers Autopilot leans on, the failure mode if each degrades, and the mitigation
already designed elsewhere in the spec. This is the owner's "what could bite me" view.

| Dependency | Failure mode | Risk | Mitigation (where specced) |
|---|---|---|---|
| **Cloudflare** (Workers/Containers/DO/Workflows) | Sandbox or hosting outage → builds/previews fail | **High** (core compute) | Tick is resumable + idempotent; DR posture ([42](./42-disaster-recovery.md)); managed quota caps blast radius |
| **Supabase** (Postgres/auth) | System-of-record down → no state, no auth | **High** | Append-only `audit_log`/`venture_events` + R2 cold archive; RPO/RTO in [42 §42](./42-disaster-recovery.md) |
| **Model providers** (OpenRouter/Gemini/NVIDIA) | Rate limit, price spike, model retired | **Medium** | Multi-provider routing + fallback ([29 model gateway](./29-model-gateway.md)); BYOK shifts cost+limits to the user; budget caps absorb price spikes |
| **Nango (self-host)** | Connector broker down → BYO deploys/connects fail | **Medium** | Self-hosted = owner controls uptime; managed-preview path needs no Nango; encryption key must be backed up (loss = unrecoverable creds) |
| **Stripe** | Billing/webhook outage → top-ups/overage stall | **Medium** | Idempotent webhooks; reconciliation ([41 §41](./41-billing-metering.md)); credits buffer short outages |
| **Sentry** | Telemetry blind spot | **Low** | Degrades observability only, not the product; structured logs remain |
| **Railway** (transitional) | API/worker host outage | **Medium** | Loop is crash-safe + resumable; retires as coordination moves to DOs ([40 §40.2](./40-cost-finops.md)) |
| **GitHub** | Repo sync/PR fails | **Low–Med** | Per-venture, optional; build loop works without it; degrades to local versions |
| **BYO user accounts** (CF/Vercel/Railway/Supabase) | User's own quota/billing/permission failure | **Medium** | Surfaced as a per-venture deploy failure → checkpoint, not a platform incident; least-privilege scopes |

**Cross-cutting risk (carried honestly from the plan §11):** the sharpest edge is
**multi-tenant secrets** — Nango + RLS + least-privilege adapters + the A9 audit are the
mitigation; treat A9 as a real gate. And **managed hosting = we carry cost/abuse risk** —
which is exactly why budgets + quotas + the kill switch (A0) ship *before* the engine (A2).

---

## 49.9 Cross-reference map

| Topic | Authoritative section |
|---|---|
| Per-epic owner-action lines (A0–A9) | [Master Plan §9](../00-MASTER-PLAN.md#9-the-epic--sprint-backlog) |
| Consolidated plan-level table | [Master Plan §12](../00-MASTER-PLAN.md#12-owner-actions) |
| Live studio checklist (P0/P1/P2) | [`../OWNER-ACTIONS.md`](../OWNER-ACTIONS.md) |
| Pricing, markup, plans, credits | [05](./05-business-model-pricing.md) · [40](./40-cost-finops.md) · [41](./41-billing-metering.md) |
| Migrations (ordered M1–M6) | [26 §26.13](./26-data-model-schema.md) |
| Auth/session/device tables | [33](./33-sessions-identity.md) |
| Nango / connectors | [30](./30-integrations-framework.md) |
| Deploy adapters + BYO tokens | [31](./31-deploy-adapters.md) |
| Sentry / alerting / F0 | [38](./38-observability.md) |
| Security review + GA gate | [35](./35-security-threat-model.md) · [Master Plan A9](../00-MASTER-PLAN.md#epic-a9--multi-tenant-security-hardening--ga) |
| Release flags + `VENTURES_*` matrix | [44](./44-cicd-release.md) |
| Kill switch / DR | [42](./42-disaster-recovery.md) |
| Full env-var reference (appendix) | [52 — Appendix A](./52-appendix-config.md) *(planned)* |

> **Maintenance rule** (per [44 §44.3](./44-cicd-release.md) + [OPERATING-MODEL.md](../OPERATING-MODEL.md)):
> whenever a new owner action or deferred validation appears during a build, add it **here**
> *and* to [`../OWNER-ACTIONS.md`](../OWNER-ACTIONS.md). This table is the source of truth
> for "what still needs the human."
