# Enterprise Foundations — the cross-cutting work that makes this production-grade

> **Why this exists.** The [Autopilot Master Plan](./00-MASTER-PLAN.md) describes the
> *autonomous* product. This doc describes the **non-functional foundations** the whole
> platform (the existing Comic/Chat/Studio product **and** Autopilot) needs to stop looking
> like a project and behave like enterprise software: observability, provider reliability,
> distributed correctness, sessions, real-time sync, testing, migrations, API contracts,
> security, design system, integrations.
>
> **These are graded from a real code audit (2026-06-07), not assumptions.** Each verdict
> cites files. Where the gap is real we say so; where something already exists and is good,
> we say that too and protect it. **The F-series is sequenced to run UNDER the A-series** —
> a hardened foundation comes before (and alongside) autonomy.

**Status:** 📋 planned · **Tracker:** [`STATUS.md`](./STATUS.md) · **Architecture for the
Cloudflare-native pieces:** [`ARCHITECTURE-CLOUDFLARE.md`](./ARCHITECTURE-CLOUDFLARE.md)

---

## Current-state scorecard (audited, with file refs)

| # | Concern | Verdict | The one-line gap | Key files |
|---|---|---|---|---|
| 1 | Session & identity | 🟡 partial | No first-party session/timeouts; device registry isn't authoritative (`user_devices` has **no migration**); per-request `getUser()` network round-trip | `contexts/AuthContext.tsx`, `services/deviceSessions.ts`, `server/src/middleware/auth.ts` |
| 2 | Multi-device / real-time sync | 🟡 partial | **No real-time at all**; sync only on login/debounced; naive last-write-wins clobbers concurrent edits | `services/chatSync.ts`, `cloudSync.ts`, `chatStorage.ts` |
| 3 | Concurrency / simultaneous projects | 🟢 good (server) / 🟡 overall | Real per-user studio caps + sandbox isolation exist, but rate limiter + caps are **in-memory per-process** (break on >1 instance); no row-locking on project saves | `server/src/routes/studio.ts:506`, `studioRepository.ts:53`, `middleware/rateLimit.ts:14`, `comicforge/queue.ts` |
| 4 | Model connectivity & sourcing | 🟡 partial (fragile) | **Single platform key per provider, no pool/rotation, no circuit breaker, model-only (not cross-provider) failover** — the owner's complaint is real | `server/src/ai/gateway.ts`, `openrouter.ts:332`, `utils.ts` (`withRetry`), `tools/search.ts` (the good one) |
| 5 | Testing | 🟡 partial | 124 unit files but **zero integration/E2E/contract tests, no coverage gate** | `*.test.ts(x)`, `.github/workflows/*` |
| 6 | Design system | 🟡 partial | Two token systems hand-synced; only 3 `ui/` primitives; sparse a11y; gallery covers chat artifacts only | `tailwind.config.cjs:27`, `components/studio/kit/theme.ts`, `components/chat/ComponentGallery.tsx` |
| 7 | Integrations framework | 🟡 partial | Nango + MCP are two parallel mechanisms; **no unified catalog, no inbound webhooks, no connection-state/expiry tracking** | `server/src/ai/tools/nango.ts`, `mcpClient.ts`, `services/mcpRegistry.ts` |
| 8 | Observability & ops | 🟡 partial (weak) | **No error tracking (Sentry), no tracing, no metrics backend** — the documented alert thresholds have nothing feeding them | `middleware/requestContext.ts`, `services/systemDashboard.ts`, `docs/production/alerting-thresholds.md` |
| 9 | Documentation | 🟡 partial | Broad but scattered; **no OpenAPI/API spec**; mixes shipped vs aspirational | `docs/**`, `docs/decisions/` (ADRs exist) |
| 10 | Security hardening | 🟡 partial | Good RLS + guardrails + SSRF guards; gaps: **no helmet, no zod validation framework, no dependency/secret scanning in CI**, manual-SQL RLS (drift risk), `admin@test.com` default | `server/sql/*_rls_*.sql`, `ai/guardrails.ts`, `middleware/security.ts`, `services/rbac.ts:12` |

**Strengths to preserve (do not regress):** the 7-provider search chain with honest
`ok/empty/error` status (`tools/search.ts`); stale-while-revalidate model catalog with a
durable Supabase mirror (`services/modelCatalog.ts`); studio per-user concurrency caps +
`u_<userId>_<projectId>` sandbox isolation + HMAC-signed worker calls; broad RLS; output
guardrails (secret/PII/fabrication); SSRF guards on user URLs; the test-enforced living
component gallery.

---

## The F-series (foundation epics), ranked by ROI

Sequenced so the highest-leverage reliability/visibility work lands first. Each epic:
flag-safe, additive, shippable, with concrete tasks + file refs + acceptance + owner action.
Mark `[x]` as shipped; keep [`STATUS.md`](./STATUS.md) + [`../CHANGELOG.md`](../CHANGELOG.md)
current (per [`../AGENTS.md`](../AGENTS.md)).

---

### F0 — Observability: error tracking, metrics, tracing, audit log  *(top gap #1)*
**Why:** you can't run anything 24/7 you can't see. The alert thresholds in
`docs/production/alerting-thresholds.md` are aspirational — nothing emits the metrics.
**Current:** good per-request JSON logs (`requestContext.ts`), health/ready endpoints
(`system.ts:322`), an admin dashboard (`systemDashboard.ts`), guardrail notices. **No**
Sentry/OTel/Prometheus; 62 raw `console.*` in `server/src`.

- [ ] Add **Sentry** (server + client): exception capture, release + `requestId` tagging,
      source maps. Scrub PII/secrets (reuse `guardrails.ts` redaction).
- [ ] Replace `console.*` with a structured logger (**pino**) in `server/src`; keep the JSON
      request line; add log levels + redaction.
- [ ] Add a **metrics exporter** (`prom-client`) + `/metrics` (admin/network-guarded):
      5xx rate, p95/p99 latency, 429 ratio, queue depth, **per-provider error/latency
      counters**, cost meters — the exact signals `alerting-thresholds.md` lists.
- [ ] Propagate `requestId` as trace context through the AI gateway, BullMQ jobs, and the
      studio worker (lightweight OTel or manual span ids).
- [ ] Liveness for the **BullMQ worker + Redis** (depth, stalled jobs) surfaced in the
      dashboard.
- [ ] **Security/admin audit log** table + writer: role changes, project deletes, auth
      events, deploys — append-only (this also seeds Autopilot's `venture_events`).
- [ ] Wire the documented thresholds to real alerts (Sentry alerts / a cron check).

**Acceptance:** an exception shows in Sentry with `requestId` + user; `/metrics` exposes the
alerting signals; provider error rate is visible; a role change/delete is in the audit log.
**Owner:** create a Sentry project → set `SENTRY_DSN` (server) + client DSN.

---

### F1 — AI provider reliability: key pool, circuit breaker, cross-provider failover  *(top gap #2 — the owner's #1 pain)*
**Why:** one rate-limited platform key throttles all non-BYOK users; an OpenRouter outage
costs full retry latency on every call; failover only swaps *models on the same provider*.
**Current:** good — `gateway.ts` registry, `withRetry` exponential backoff (`utils.ts`),
model-level fallback (`openrouter.ts:332`), resilient catalog. **Missing:** key
pooling/rotation, circuit breaker (the grep hits are comments only), cross-provider failover,
image-gen retry parity, provider error metrics.

- [ ] **API key pool per provider:** support N keys (`OPENROUTER_API_KEYS`, …), least-loaded
      / round-robin selection, per-key 429 cooldown + rate-limit accounting. Keep BYOK path.
- [ ] **Circuit breaker** per `(provider, model)`: open on sustained failures, half-open
      probe, fail fast while open (no more 3×backoff on a known-down upstream). Wrap in
      `gateway.ts`.
- [ ] **Cross-provider failover** in the generation path: OpenRouter → NVIDIA (and back),
      not just model-on-same-provider (`openrouter.ts:332` → generalize into the gateway).
- [ ] **Image-gen hardening:** retry parity + graceful degradation instead of hard throw
      (`openrouter.ts:489`).
- [ ] **Provider contract tests** (recorded fixtures) to catch response-shape drift the code
      admits it can't verify (`openrouter.ts:8`); run `openrouter:smoketest` in CI nightly.
- [ ] Emit per-provider error/latency/`429` to F0 metrics; surface in the dashboard.
- [ ] Per-call **timeout budgets** + optional hedging on the slowest stage.

**Acceptance:** killing one key doesn't throttle the platform; simulating an OpenRouter
outage auto-fails over to NVIDIA; the breaker opens under sustained failure (tested);
provider error rate is charted.
**Owner:** provide additional provider keys for the pool (optional but recommended).

---

### F2 — Distributed correctness: shared limits, optimistic concurrency, idempotency  *(top gap #4)*
**Why:** the moment you run >1 instance, in-memory limits multiply and project saves can
interleave-corrupt files.
**Current:** in-memory rate limiter (`rateLimit.ts:14`), studio caps with a DB-error
"allow" fallback (`studio.ts:516`), delete-then-insert file save (`studioRepository.ts:53`),
worker can run in-process (`index.ts:187`).

- [ ] Move the **rate limiter + studio concurrency caps to Redis** (shared, atomic) so
      limits hold across instances; remove the fail-open-on-error gap where it's a real cap.
- [ ] **Optimistic concurrency** on `studio_projects` (+ future `ventures`): a `version`
      column; reject stale writes; replace delete-then-insert with a versioned, transactional
      file upsert (no interleave corruption).
- [ ] **Idempotency keys** on mutating routes (build, deploy, billing, intake) — safe retry.
- [ ] **Backpressure**: reject/queue when the cluster is saturated (tie to F0 queue depth).
- [ ] Run the **BullMQ worker as its own process/service** by default (don't compete with
      the API box).

**Acceptance:** a load test across 2 instances enforces one shared limit; two concurrent
saves to one project can't corrupt; replaying a build request is a no-op.
**Owner:** ensure `REDIS_URL` in prod; add the worker as a separate Railway service.

---

### F3 — Session & identity hardening  *(concern #1)*
**Why:** identity is *only* a Supabase JWT — no timeouts, no authoritative device control,
a network round-trip per request.
**Current:** Supabase GoTrue, real global/others sign-out (`AuthContext.tsx:105`),
remember-me storage (`supabase.ts:88`), per-request `getUser()` (`auth.ts`). Device registry
exists but `removeDevice` "does NOT invalidate its Supabase session" and **`user_devices`
has no migration**.

- [ ] **Local JWT verification via JWKS** (cache keys) instead of `getUser()` per request →
      lower latency, no hard per-call dependency on Supabase uptime.
- [ ] **First-party session records** (server-side) layered on the JWT → enables **idle +
      absolute timeouts**, session binding (device/IP), and step-up re-auth.
- [ ] **Make the device registry authoritative:** create the missing `user_devices`
      migration (F6); wire `removeDevice` to actually revoke that device's session (Supabase
      admin API) — real "sign out this device".
- [ ] **MFA/TOTP** enrollment (Supabase native) + **re-auth on sensitive actions** (billing,
      deploy, account changes).
- [ ] Suspicious-login signal (new device/geo) → notify + audit (F0).

**Acceptance:** device list is real and revocation works; sessions expire on idle/absolute;
billing/deploy require re-auth; per-request auth no longer round-trips.
**Owner:** none (uses existing Supabase).

---

### F4 — Real-time & multi-device sync  *(concern #2 — Cloudflare Durable Objects)*
**Why:** two tabs/devices silently clobber each other; nothing converges without a reload.
**Current:** login-time + 1.5s-debounced push (`cloudSync.ts`), last-write-wins chat sync
(`chatSync.ts:6`), IndexedDB local cache. **Zero** Realtime/WebSocket/SSE-channel/presence.
See [`ARCHITECTURE-CLOUDFLARE.md`](./ARCHITECTURE-CLOUDFLARE.md) for the DO design.

- [ ] **Per-user coordinator Durable Object** (WebSocket Hibernation): authoritative device
      sessions, **instant revocation push**, presence, real-time convergence across devices.
- [ ] Replace naive last-write-wins with **optimistic-concurrency versioning** (path to CRDT
      for collaborative editing later).
- [ ] **Cross-tab coordination** (BroadcastChannel) so same-device tabs don't race.
- [ ] **Offline write outbox** with retry-on-reconnect (not just read-only persistence).

**Acceptance:** edits on device A appear on device B in real time; "sign out everywhere" is
instant; offline writes sync on reconnect; concurrent edits don't clobber.
**Owner:** enable Durable Objects (already on Workers Paid).

---

### F5 — Testing & quality gates  *(top gap #3)*
**Why:** 124 unit files, but the most failure-prone code (providers, auth, RLS) has no
integration/E2E/contract coverage, and CI can't catch coverage regressions.
**Current:** vitest unit tests (59 server / 65 client), CI runs `npm test --run` + typecheck;
gallery-coverage + CORS tests; env-coupled suites.

- [ ] **E2E (Playwright):** sign-in, chat, build, deploy, billing happy-paths.
- [ ] **Integration tests:** boot Express + a test DB; cover auth, key routes, and **RLS
      isolation** (user A can't read user B).
- [ ] **Provider contract tests** (F1) against recorded OpenRouter/NVIDIA fixtures.
- [ ] **Coverage** (`@vitest/coverage-v8`) + **CI threshold gate** (start realistic, ratchet).
- [ ] **Visual regression** (Playwright snapshots) for the design-system gallery (F9).
- [ ] **Executable load test** (k6) from `docs/production/load-test-plan.md`.
- [ ] Make suites **hermetic** (fix the Supabase-env coupling noted in `CLAUDE.md`).

**Acceptance:** CI runs unit + integration + E2E + coverage gate; an RLS regression fails CI;
a provider shape change fails CI; load test is runnable.
**Owner:** none.

---

### F6 — Schema & migration management  *(top gap #6)*
**Why:** RLS/tables are loose "run-by-hand" `.sql` files; `user_devices` has no migration at
all → environment drift and silently-missing security policies.
**Current:** `server/sql/*.sql` + `docs/migrations/*.sql`, applied manually.

- [ ] Adopt a **migration runner** (Supabase migrations dir, or Drizzle) with ordered,
      versioned, idempotent migrations; consolidate existing `server/sql/` + `docs/migrations/`.
- [ ] Create the **missing migrations**: `user_devices` (F3), the `ventures_*` set (A0/A1).
- [ ] **RLS-coverage check in CI**: every table has a policy (fail otherwise); run Supabase
      `get_advisors` in CI.
- [ ] Generate a **schema reference doc** from the source of truth.

**Acceptance:** one command applies all migrations in order on a fresh DB; CI fails if a
table lacks RLS; no "run this SQL by hand" steps remain.
**Owner:** confirm the migration approach (Supabase CLI recommended).

---

### F7 — API contract & documentation  *(top gap #8 / concern #9)*
**Why:** the entire REST surface is undocumented except by reading code; docs mix shipped vs
planned.
**Current:** broad docs + ADRs + runbooks, but **no OpenAPI**; no onboarding guide.

- [ ] Generate **OpenAPI** from routes (zod → openapi via F8); serve Swagger UI (admin).
- [ ] Generate a **typed client** from the spec → real contract between client/server.
- [ ] **Unify docs:** one index that clearly marks **shipped vs planned**; add a
      dev-setup/onboarding + contribution guide.

**Acceptance:** every route is in the spec; a generated client compiles against it; a new dev
can set up from one guide.
**Owner:** none.

---

### F8 — Input validation & supply-chain security  *(top gap #7 / concern #10)*
**Why:** route validation is ad-hoc (no zod); CI has no dependency/secret scanning; a
`admin@test.com` default lurks.
**Current:** good RLS + guardrails + SSRF guards + hand-rolled CSP (`security.ts`); manual
type guards (`text.validation.ts`); zod only in 2 tool-schema files.

- [ ] Adopt **zod** for systematic body/query validation across `server/src/routes/*`
      (consistent error shapes); this also powers OpenAPI (F7).
- [ ] Add **helmet** + a **nonce-based CSP** for the served frontend (today's CSP is
      API-only); converge with the hand-rolled headers so they can't drift.
- [ ] **CI security gates:** `npm audit` / Dependabot, secret scanning
      (gitleaks/trufflehog + GitHub `run_secret_scanning`), CodeQL.
- [ ] Remove the **`admin@test.com` default** (`rbac.ts:12`) — require explicit `ADMIN_EMAILS`
      in prod (fail closed).
- [ ] **CSRF review** for cookie-persisted sessions + credentialed CORS.

**Acceptance:** all mutating routes validate via zod; CI blocks on a known vuln or committed
secret; no default-admin; security headers unified + hardened.
**Owner:** enable Dependabot/CodeQL in repo settings.

---

### F9 — Design-system unification & accessibility  *(concern #6)*
**Why:** two token systems kept in sync by hand; only 3 shared UI primitives; sparse a11y;
the gallery covers chat artifacts only.
**Current:** Tailwind theme + a 3-theme studio kit (`kit/theme.ts`), Primitive Kit, the
test-enforced `ComponentGallery`, some a11y hooks.

- [ ] **Single token source** (CSS custom properties / Style Dictionary) feeding both
      Tailwind and `kit/theme.ts` — kill the hand-sync (`tailwind.config.cjs:27`).
- [ ] Grow `components/ui/` into a real shared library; extend the **living gallery** to cover
      app + studio components (Storybook-style), not just chat artifacts.
- [ ] **A11y program:** axe automated tests in CI, a WCAG-AA contrast + keyboard-nav audit,
      ARIA coverage targets, a documented responsive-breakpoint strategy.

**Acceptance:** one token source of truth; the catalog covers the app; axe passes in CI;
breakpoints documented.
**Owner:** none.

---

### F10 — Integrations framework unification  *(concern #7)*
**Why:** Nango and MCP are parallel mechanisms with no unified catalog, no inbound webhooks,
no connection-state/expiry visibility.
**Current:** Nango meta-tools (`nango.ts`), SSRF-guarded MCP client (`mcpClient.ts`), MCP
registry with auto-disable-after-3-fails (`mcpRegistry.ts`). Only Stripe webhooks exist.

- [ ] A **unified integration model + catalog** spanning Nango + MCP: state, scopes, expiry,
      health, owner — one surface.
- [ ] **Inbound webhooks** beyond Stripe (Nango sync events, MCP push) → events into the
      system (feeds Autopilot's SENSE layer, A6).
- [ ] **Connection-state UI** ("your Slack connection expired") + **retries** on MCP calls.
- [ ] OAuth lifecycle observability (token expiry tracked, not just delegated/forgotten).

**Acceptance:** one catalog shows every connection's health/expiry; a webhook event is
consumed end-to-end; an expired connection is surfaced to the user.
**Owner:** Nango self-hosted instance configured (`NANGO_SECRET_KEY`) if not already.

---

## Revised sequencing — foundations under autonomy

The earlier plan jumped to A0 (Autopilot brakes). With the audit in hand, the correct
enterprise order interleaves foundations first:

```
  F0 observability ─┐
  F1 provider reliab.─┼─► (now you can SEE + TRUST the platform)
  F2 distributed corr.┘
        │
        ▼
  A0 brakes ─► A1 control plane ─► A2 loop engine        ← Autopilot can start safely now
        │            │
        │            ├─ needs F6 migrations, F3 sessions
        ▼            ▼
  F3 sessions · F4 real-time(DO) · F5 testing · F6 migrations · F7 API docs · F8 security
        │  (run continuously alongside A3–A9; F4/A2 share the Cloudflare DO+Workflows work)
        ▼
  A3 intake ─► A4 build ─► A5 deploy ─► A6 sense(+F10 webhooks) ─► A7 billing ─► A8 console ─► A9 GA(+F8/F9 gates)
```

**Hard rule:** **F0 → F1 → F2 ship before A2 wires real autonomous builds.** You cannot run
an always-on builder you can't observe, on providers that fail silently, with limits that
don't hold across instances. The brakes (A0) plus these three foundations are the real
"production-ready" gate.

---

## How this maps to the owner's concerns (nothing dropped)

| You said | Addressed by |
|---|---|
| session ids | F3 (first-party sessions + JWKS + timeouts) |
| security, multi-device syncs, multiple sign-ins | F3 (identity) + F4 (real-time DO + revocation) + F8 (security) |
| multiple simultaneous projects | F2 (shared limits + optimistic concurrency) + DO isolation (`ARCHITECTURE-CLOUDFLARE.md`) |
| significant model connection & source issues | **F1** (key pool, circuit breaker, cross-provider failover) + F0 (provider metrics) |
| lack of documentation | F7 (OpenAPI + unified docs) + F9 (component catalog) |
| lack of design | F9 (token source of truth + component library + a11y) |
| lack of testing | F5 (integration + E2E + contract + coverage gate) |
| full integrations | F10 (unified catalog + webhooks + connection state) |
| multi-dimensional displays / component settings | F9 (design system) + F4 (real-time data) + the existing artifact/gallery kit |
| "not planning the minutest details" | this doc — every task is concrete, file-referenced, and acceptance-gated |
