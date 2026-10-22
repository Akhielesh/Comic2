# 45 — Foundations Backlog (F0–F10, Detailed)

> Part V · Delivery · Canon: [SPEC-INDEX](../SPEC-INDEX.md) · This is the sprint-level
> execution backlog for [F-ENTERPRISE-FOUNDATIONS](../F-ENTERPRISE-FOUNDATIONS.md) (the
> source — this section *expands* it). Each foundation epic F0–F10 is broken into 2–5 sprints
> with goal, current-state one-liner (from the 2026-06-07 audit), an ordered task checklist,
> dependencies, rough effort, acceptance criteria, owner actions, and the spec sections that
> detail the design. Deep designs live in: [29 Model Gateway](./29-model-gateway.md) (F1),
> [33 Sessions & Identity](./33-sessions-identity.md) (F3), [38 Observability](./38-observability.md) (F0),
> [43 Testing Strategy](./43-testing-strategy.md) (F5), [26 Data Model](./26-data-model-schema.md) (F6),
> [34 Realtime & Sync](./34-realtime-sync.md) (F4). Sequencing canon (foundations under
> autonomy) is [F-ENTERPRISE §"Revised sequencing"](../F-ENTERPRISE-FOUNDATIONS.md) and
> [00-MASTER-PLAN](../00-MASTER-PLAN.md). The companion autonomy backlog is
> [46 — Autonomy Backlog A0–A9](./46-autonomy-backlog.md).

## 45.1 How to read this backlog

This is a **delivery document**, not a design document. The designs are written and cross-linked
above; this section answers the next question: *in what order, by whom, and how do we know each
piece is done?* Three rules govern it, the same three the rest of the spec lives by:

1. **Audited, not aspirational.** Every epic opens with a one-line current state quoted/derived
   from the real code audit (F-ENTERPRISE scorecard, 2026-06-07). We never plan work against an
   imagined baseline — `[ ]` items are concrete and file-referenced where the file is known.
2. **Flag-safe, additive, shippable.** Every sprint is independently shippable behind a flag and
   reversible by flipping it. No big-bang. A sprint that can't ship on its own is split until it
   can. This mirrors the F-series rule and the §33.8 / §29.5 "wrap, don't replace" discipline.
3. **Acceptance-gated.** A sprint is *done* only when its acceptance line is demonstrably true —
   not when the code merges. Acceptance lines here are the executable form of the F-epic's
   acceptance, sliced per sprint.

**Effort scale.** `S` ≈ 1–3 days · `M` ≈ 4–8 days · `L` ≈ 9–15 days, for one focused engineer.
These are *rough*, for sequencing and capacity — not commitments. Per-epic totals are the sum of
sprint effort, not a parallel-team estimate.

**Owner actions** are the external, human-only dependencies (create a Sentry project, provision
keys, enable repo settings) that the team cannot self-serve. They are gathered per epic and
collected once more in [49 — Owner actions & external dependencies](./49-owner-actions.md).

**The hard rule (restated, because it sequences everything):**
**F0 → F1 → F2 ship before A2 wires real autonomous builds.** You cannot run an always-on builder
you can't observe (F0), on providers that fail silently (F1), with limits that don't hold across
instances (F2). Those three plus A0 (brakes) are the real "production-ready" gate. Everything in
§45.2 marked **P0** is on that critical path; **P1** runs alongside A1–A5; **P2** is GA-hardening
that lands by A9.

---

## 45.2 Summary table — epic priority, effort, dependencies, what it enables

| Epic | Concern | Priority | Effort | Depends on | Enables |
|---|---|---|---|---|---|
| **F0** Observability | error tracking · metrics · tracing · audit log | **P0** | L (≈14d) | — | Everything (you can't run 24/7 blind); seeds `venture_events`; feeds F1/F2 metrics, A0 audit |
| **F1** Provider reliability | key pool · breaker · cross-provider failover | **P0** | L (≈13d) | F0 (metrics) | A2/A4 autonomous build on trustworthy providers; the owner's #1 pain |
| **F2** Distributed correctness | shared limits · optimistic concurrency · idempotency | **P0** | M (≈9d) | F0 (queue metrics) | Running >1 instance safely; A2 concurrency cap; A4 build saves |
| **F3** Sessions & identity | JWKS · sessions · device revoke · MFA · step-up | **P1** | L (≈12d) | F6 (M1/M2/M3 migrations), F0 (audit log) | A1 (auth on `/api/ventures/*`); A7/A8 step-up on $/deploy; F4 live tier |
| **F4** Real-time & sync | UserCoordinatorDO · presence · convergence · outbox | **P1** | L (≈13d) | F3 (sessions), Cloudflare DO enabled; shares work with A2 | A8 Operator Console live stream; instant revocation; multi-device |
| **F5** Testing & quality gates | integration · E2E · contract · coverage ratchet | **P1** | L (≈14d) | F1 (contract fixtures), F6 (test DB DDL), F7/F8 (OpenAPI/zod) | A2 engine durability/brake tests; the GA gate; RLS-regression CI |
| **F6** Schema & migrations | migration runner · missing migrations · RLS-coverage CI | **P1** *(P0 for M1–M3)* | M (≈8d) | — (M1–M3 unblock F0/F3) | F0 audit_log, F3 sessions/devices, A0/A1 `ventures_*`; F5 test DB |
| **F7** API contract & docs | OpenAPI · typed client · unified docs index | **P2** | M (≈8d) | F8 (zod → openapi) | F5 contract tests; A1 client; onboarding |
| **F8** Input validation & supply chain | zod · helmet/CSP · CI security gates · no default-admin | **P2** *(security gates earlier)* | M (≈9d) | F0 (redaction module reuse) | F7 OpenAPI; F5 injection tests; A9 GA security bar |
| **F9** Design system & a11y | single token source · component library · axe in CI | **P2** | L (≈12d) | F5 (visual-regression harness) | A8 Operator Console UI; A9 a11y gate; multi-dimensional displays |
| **F10** Integrations unification | unified catalog · inbound webhooks · connection state | **P2** | M (≈9d) | F0 (events), F3 (step-up on connect) | A6 SENSE layer signal; A5 deploy connections; full integrations |

**Critical-path totals.** P0 (F0+F1+F2) ≈ 36 engineer-days before A2 goes live; with A0 brakes
(see §46) interleaved. P1 (F3–F6) runs alongside A1–A5. P2 (F7–F10) lands by A9/GA.

**Dependency note on F6.** F6 is rated **P1** as a whole, but its first three migrations
**M1 `audit_log` / M2 `user_devices` / M3 `sessions`** are **P0 blockers** for F0 and F3 — they
are pulled forward into Sprint F6.1 and ship on the P0 timeline even though the rest of the
migration-runner work is P1. This is the one place the epic-level priority and the sprint-level
priority diverge; the sprint table below makes it explicit.

---

## 45.3 F0 — Observability *(P0 · top gap #1 · deep design: [§38](./38-observability.md))*

**Goal:** make the platform observable enough to run 24/7 — error tracking, structured logs,
metrics that feed the documented alert thresholds, a `requestId` trace spine, and a durable audit
log. *You cannot run what you cannot see.*

**Current state (audited):** good per-request JSON logs (`requestContext.ts`), health/ready
probes (`system.ts:322`), a live admin dashboard (`systemDashboard.ts`); **no** Sentry / OTel /
Prometheus; **62 raw `console.*`** in `server/src`; the alert thresholds in
`docs/production/alerting-thresholds.md` have nothing emitting their signals.

### Sprint F0.1 — Error tracking + shared redaction *(S–M, ≈4d)*
- [ ] Factor the secret/PII patterns out of `ai/guardrails.ts` (`SECRET_PATTERNS`, `EMAIL_RE`,
      `redactSecret`) into a shared `server/src/lib/redaction.ts` — one definition, three
      consumers (guardrails, pino, Sentry). *(§38.5)*
- [ ] Add Sentry Node SDK in `server/src/index.ts`, gated on `SENTRY_DSN` (absent ⇒ no-op);
      install request/error handlers around the Express router.
- [ ] Tag every event: `requestId` (`req.requestId`), `user.id` only (never email/PII),
      `release` (git SHA), `environment`; `beforeSend` runs the shared scrubber. *(§38.5)*
- [ ] Add the **client** Sentry SDK (separate DSN), source-map upload at build, PII-masked
      replay sampling.
- **Depends on:** none. **Acceptance:** an exception appears in Sentry with `requestId` + user
  id, secrets/PII absent from the payload, client errors carry source-mapped traces.
- **Owner action:** create a Sentry project → set `SENTRY_DSN` (server) + a client DSN.

### Sprint F0.2 — Structured logging (pino) *(S, ≈3d)*
- [ ] Introduce a single pino logger; keep the existing `event:http_request` JSON line at `info`.
- [ ] Replace all **62 `console.*`** calls in `server/src` with leveled logger calls; bind a
      per-request child logger to `requestId` (+ `userId`, `venture_id` when present). *(§38.6)*
- [ ] Wire the shared redaction module (F0.1) as a pino serializer; add `redact` paths for
      known secret-bearing fields; drop `Authorization`/`Cookie` wholesale.
- [ ] Add a `no-console` lint rule for `server/src` (allow the logger module) so the count
      stays at 0.
- **Depends on:** F0.1 (redaction module). **Acceptance:** `console.*` count in `server/src` is
  0 (lint-enforced); logs are level-filterable and `requestId`-correlated; a logged object
  containing a key is redacted.

### Sprint F0.3 — Metrics exporter + `/metrics` *(M, ≈4d)*
- [ ] Add `prom-client`; register default + custom registries; expose `GET /metrics` on the
      system router, **admin/network-guarded** (same posture as the admin dashboard). *(§38.7)*
- [ ] Emit the exact signals `alerting-thresholds.md` lists: `http_requests_total`,
      `http_request_duration_seconds` (histogram for p95/p99), `http_requests_429_total`,
      `image_requests_total`, `model_cost_usd_total{byok}`, `process_*`. *(§38.7 table)*
- [ ] Add the **per-provider** counters (consumed by F1, emitted from `ai/gateway.ts`):
      `provider_requests_total{outcome}`, `provider_request_duration_seconds`, `provider_429_total`,
      `provider_circuit_state` — left as registered no-ops until F1 increments them.
- [ ] Surface gauge values (queue depth, stalled jobs, breaker state) in the admin dashboard so
      ops doesn't need Grafana for routine checks. *(§38.9)*
- **Depends on:** F0.2 (logger). **Acceptance:** `/metrics` exposes the alerting signals;
  latency percentiles compute from histogram buckets near the 2.5s/5s lines.

### Sprint F0.4 — Trace spine + worker/Redis liveness *(M, ≈4d)*
- [ ] Propagate `requestId` as trace context: into the AI gateway as a field, into BullMQ as
      `job.data.traceId`, into the studio worker via the payload, into DO/Workflow sub-requests
      as `X-Request-Id`. *(§38.8)*
- [ ] Emit lightweight manual spans (`span`, `parent`, `startMs`, `durMs`) as pino lines across
      the Express/BullMQ/Workers boundary — no heavy OTel SDK yet (F0 allows manual span ids).
- [ ] Add **BullMQ worker + Redis liveness** (depth, stalled jobs) → `queue_depth` /
      `queue_stalled_jobs` gauges + dashboard panel — closes the "worker/Redis blind" gap. *(§38.3, §38.7)*
- **Depends on:** F0.3. **Acceptance:** a slow/failed ship is followable end-to-end by one
  `requestId` across gateway → queue → worker; queue depth + stalled jobs are gauged and shown.

### Sprint F0.5 — Audit log + alerting *(M, ≈4d)*
- [ ] Land the `audit_log` table via **F6 migration M1** (append-only, per-tenant RLS deny-all
      to clients, service-role write). *(§38.11, §26.11, depends on F6.1)*
- [ ] Add the audit writer: role changes, project deletes, auth events, deploys, budget changes,
      kill-switch triggers, connection lifecycle; payloads run through the shared scrubber;
      best-effort-but-logged (a write failure is itself a Sentry error, never blocks the action).
- [ ] Wire the documented thresholds to real alerts: Sentry alert rules (exception spikes,
      new-issue-in-release, crash-free drops) + a **cron threshold evaluator** that reads
      `/metrics` and evaluates every rule in `alerting-thresholds.md`. *(§38.10)*
- [ ] Route by severity: Critical → pager (ack SLA); Warning → ops channel; cost → also notify
      the Owner. Each alert carries `requestId`/provider/route + a runbook link.
- **Depends on:** F0.3 (metrics), F6.1 (M1). **Acceptance:** a role change and a project delete
  appear in the append-only audit log with actor/target/`requestId`; a 5xx spike pages on-call;
  a cost overrun notifies the Owner.
- **Owner action:** notification channel webhooks (pager + ops channel); the budget figures the
  cost alerts compare against.

**F0 owner-action summary:** Sentry project + DSNs; pager/ops webhooks; budget figures.
**F0 detailed by:** [§38 Observability](./38-observability.md) (whole section).

---

## 45.4 F1 — AI provider reliability *(P0 · top gap #2, owner's #1 pain · deep design: [§29](./29-model-gateway.md))*

**Goal:** make the platform-key path survive a bad key or a provider outage at fleet scale — key
pool, circuit breaker, cross-provider failover, image-gen hardening, provider metrics + contract
tests. **Wrap the existing gateway; do not rewrite it.**

**Current state (audited):** good single-call story — `withRetry` backoff (`utils.ts`),
model-only fallback (`openrouter.ts:332`), resilient catalog (`modelCatalog.ts`); **missing**
key pool/rotation, circuit breaker (grep hits are comments only), cross-provider failover,
image retry parity, per-provider metrics. `platformKeyFor()` returns exactly one key per
provider (`gateway.ts:21`) — the root of the finding.

### Sprint F1.1 — Key pool + per-key 429 cooldown *(M, ≈4d)*
- [ ] Implement `server/src/ai/keyPool.ts` `selectKey(provider)`: read N keys
      (`OPENROUTER_API_KEYS`, `NVIDIA_API_KEYS`, comma-separated; fall back to the single legacy
      var); least-loaded selection; tie-break on fewest recent 429s. *(§29.7.1)*
- [ ] Per-key state in **shared** store (Redis in transition / DO storage on Cloudflare):
      `inFlight`, `cooldownUntil`, `recent429`; atomic increment/decrement; identify keys only
      by non-reversible `hash8(key)`.
- [ ] `onKeyResult`: honor `Retry-After`; set cooldown on 429/quota; increment
      `provider_429_total{provider,keyId}` (F0). Keep the BYOK path entirely outside the pool.
- **Depends on:** F0.3 (metrics), shared store (Redis from F2 or standalone). **Acceptance:**
  with a 2-key pool, forcing one key into permanent cooldown routes all platform traffic to the
  survivor with no caller-visible change. **Owner action (optional, recommended):** provide
  additional provider keys for the pool.

### Sprint F1.2 — Circuit breaker + cross-provider failover *(M, ≈5d)*
- [ ] Implement `server/src/ai/reliableCall.ts` `callWithBreakerAndFailover()` wrapping the
      existing `AIProvider.generate*`: per-`(provider,model)` breaker (closed→open→half-open),
      fail-fast while open, single half-open probe. *(§29.7.2)*
- [ ] Generalize model-only fallback (`openrouter.ts:332`) into a **failover chain** with
      cross-provider hops (OpenRouter ↔ NVIDIA); add the catalog-keyed **equivalence map** so
      failover preserves capability, not just availability. *(§29.6)*
- [ ] Respect the `freeOnly` rule (never silently fall to a paid model — throw instead).
- [ ] Emit `provider_circuit_state`, `provider_failover_total{from,to}` to F0.
- **Depends on:** F1.1, F0.3. **Acceptance:** a simulated OpenRouter outage auto-fails over to
  NVIDIA (fake provider, no live network); the breaker opens under sustained failure and
  half-open-probes back to closed (unit-tested).

### Sprint F1.3 — Timeout budgets, hedging, image hardening *(S–M, ≈3d)*
- [ ] Make the timeout budget **per call kind** (chat 30s, ORIENT 15s, ACT 120s, image 60s) via
      `withTimeout`. *(§29.8)*
- [ ] Optional, flag-gated, conservative **hedging** on the slowest interactive stage only (one
      hedged attempt to the failover hop; first response wins; off by default).
- [ ] Route image generation through `callWithBreakerAndFailover` for retry parity; on
      exhaustion return a typed `{ ok:false, reason:'image_unavailable', triedProviders }`
      instead of a hard 500 (`openrouter.ts:489`). *(§29.8)*
- **Depends on:** F1.2. **Acceptance:** image generation degrades gracefully (typed soft
  failure) instead of 500ing; a hedged interactive call returns the first responder.

### Sprint F1.4 — Provider metrics + contract tests *(S–M, ≈3d)*
- [ ] Increment the F0 per-provider counters at every call site in the reliability layer; surface
      provider error rate + breaker state on the system dashboard. *(§29.9)*
- [ ] Record sanitized provider fixtures (`/chat/completions`, `/models`, image responses,
      scrubbed via the redaction module) and assert the parsers (`extractText`, `extractToolCalls`,
      `extractImages`, `normalizeCatalogModel`, `parseUsage`) still match — these are F5 contract
      tests but owned here because F1 admits the code "can't verify" the shape. *(§29.9, §43.7)*
- [ ] Add `openrouter:smoketest` to the **nightly** CI run against the live API (not the PR path).
- **Depends on:** F1.1–F1.3, F0.3. **Acceptance:** per-provider error rate + breaker state are
  charted; a provider response-shape change fails CI (fixtures); the nightly smoketest runs.

**F1 owner-action summary:** additional provider keys for the pool (optional but recommended).
**F1 detailed by:** [§29 Model Gateway](./29-model-gateway.md).

---

## 45.5 F2 — Distributed correctness *(P0 · top gap #4)*

**Goal:** make limits hold and writes stay consistent the moment we run >1 instance — shared
rate limits, optimistic concurrency on project saves, idempotency, backpressure, a dedicated
worker process.

**Current state (audited):** in-memory rate limiter (`rateLimit.ts:14`); studio caps with a
DB-error "allow" fallback (`studio.ts:516`); delete-then-insert file save
(`studioRepository.ts:53`); worker can run in-process (`index.ts:187`).

### Sprint F2.1 — Shared limits in Redis *(M, ≈4d)*
- [ ] Move the rate limiter (`middleware/rateLimit.ts`) to **Redis** with an atomic
      window/token-bucket so limits hold across instances.
- [ ] Move the studio concurrency caps (`studio.ts:506`, `studioRepository.ts:53`) to the same
      shared store; **remove the fail-open-on-DB-error gap** where it is a real cap (fail closed
      on a genuine limit, not open).
- [ ] Add **backpressure**: reject/queue when the cluster is saturated, tied to F0 `queue_depth`.
- **Depends on:** F0.4 (queue metrics), `REDIS_URL` in prod. **Acceptance:** a 2-instance load
  test enforces **one shared** limit (not 2×); saturation produces controlled rejection, not a
  crash. **Owner action:** ensure `REDIS_URL` is set in production.

### Sprint F2.2 — Optimistic concurrency on project saves *(M, ≈4d)*
- [ ] Add a `version` column to `studio_projects` (and the future `ventures` set via F6); reject
      stale writes with a typed conflict the client can reconcile.
- [ ] Replace the delete-then-insert file save (`studioRepository.ts:53`) with a **versioned,
      transactional upsert** — no interleave corruption between two concurrent saves.
- **Depends on:** F6 (migration to add `version`). **Acceptance:** two concurrent saves to one
  project cannot corrupt files; a stale write is rejected, not silently merged.

### Sprint F2.3 — Idempotency + dedicated worker *(S, ≈2d)*
- [ ] Add **idempotency keys** to mutating routes (build, deploy, billing, intake): same key →
      no-op replay. Store keys in the shared store with a TTL.
- [ ] Run the **BullMQ worker as its own process/service** by default (don't compete with the
      API box); document the Railway split.
- **Depends on:** F2.1 (shared store). **Acceptance:** replaying a build request is a no-op; the
  worker runs as a separate service. **Owner action:** add the worker as a separate Railway service.

**F2 owner-action summary:** `REDIS_URL` in prod; worker as a separate Railway service.
**F2 detailed by:** F-ENTERPRISE §F2; concurrency/isolation context in [§25](./25-multitenancy-isolation.md),
[§39](./39-performance-scalability.md).

---

## 45.6 F3 — Session & identity hardening *(P1 · concern #1 · deep design: [§33](./33-sessions-identity.md))*

**Goal:** layer first-party sessions on top of the Supabase JWT — local JWKS verify (kill the
per-request round-trip), idle/absolute timeouts + binding, an authoritative device registry with
real revocation, MFA, and step-up on sensitive actions. **Layer, don't replace** GoTrue.

**Current state (audited):** identity is *only* a Supabase JWT; `getUser()` per request
(`auth.ts`); real `local`/`others`/`global` sign-out (`AuthContext.tsx`); a **decorative**
device registry whose `removeDevice` does not revoke and whose `user_devices` table **has no
migration** and column-mismatches §26.11 (`deviceSessions.ts:85`).

### Sprint F3.1 — Migrations + start writing sessions/devices *(S, ≈3d · flag `SESSIONS_WRITE`)*
- [ ] Ship migrations **M1 `audit_log` / M2 `user_devices` / M3 `sessions`** (ordered, via F6.1);
      `sessions.device_id` FK → `user_devices(id)`. *(§33.5, §26.11)*
- [ ] **Reconcile `deviceSessions.ts` schema** to the migration source of truth (rename
      `device_name→device_label`, `last_seen→last_seen_at`, add indexed `device_id`, add
      `trusted`) — this mismatch is *why the registry silently no-ops today*. *(§33.3.3)*
- [ ] Start *writing* `sessions` + real `user_devices` rows on sign-in (still verify via
      `getUser` for now).
- **Depends on:** F6.1 (M1/M2/M3). **Acceptance:** device/session rows persist with RLS
  isolation; existing sign-out scopes still work (no regression).

### Sprint F3.2 — Local JWKS verify + session check *(M, ≈4d · flag `SESSIONS_V2`)*
- [ ] Implement `verifyRequest()` (target for `middleware/auth.ts requireAuth`): local JWKS
      signature verify (cached keys, TTL + on-miss refetch for rotation), no `getUser` round-trip.
      *(§33.3.1, §33.7 step 1)*
- [ ] Add the first-party session check: `revoked_at` / idle / absolute / device-IP binding;
      bump `idle_expires_at` on each request; typed 401 reasons. Keep the `getUser` path as the
      instant flag-off rollback. *(§33.3.2, §33.7 steps 2–4)*
- [ ] Add the idle-sweep cron over `sessions_idle_idx` (marks expired rows `revoke_reason='timeout'`).
- **Depends on:** F3.1. **Acceptance:** per-request auth no longer round-trips to Supabase;
  sessions expire on idle and absolute timeout; flipping `SESSIONS_V2` off restores `requireAuth`.

### Sprint F3.3 — Real device revocation *(S, ≈2d · flag `DEVICE_REVOKE`)*
- [ ] Replace the `removeDevice` no-op (`deviceSessions.ts:85`) with real revocation: set
      `user_devices.revoked_at`, mark device `sessions` revoked, call the Supabase **admin API**
      (`getSupabaseAdmin().auth.admin.signOut`) to kill the refresh token, write `audit_log`
      (F0), and (when F4 lands) push the instant WS close. *(§33.3.3)*
- [ ] Make revocation a privileged server route (never a raw client delete).
- **Depends on:** F3.2, F0.5 (audit log). **Acceptance:** "sign out this device" genuinely ends
  that device's access immediately and is auditable; the refresh token cannot silently refresh back.

### Sprint F3.4 — MFA, step-up, suspicious-login *(M, ≈3d · flags `MFA`, `STEP_UP`)*
- [ ] Wrap Supabase native **MFA/TOTP** (`enroll`/`challenge`/`verify`); admins required by
      policy; surface `aal2` in the JWT. *(§33.3.4)*
- [ ] Add **step-up gates** on the §33.6 action set (billing, prod-deploy checkpoint, spend
      checkpoint, add/revoke connection, account changes, device revoke): `401 STEP_UP_REQUIRED`
      → re-auth endpoint stamps `step_up_at`. *(§33.6)*
- [ ] Add **suspicious-login** detection (new device / new country) → notify per `user_settings`
      + `audit_log` (`auth.suspicious_login`); higher risk requires step-up. *(§33.3.5)*
- **Depends on:** F3.2, F0.5. **Acceptance:** billing/deploy require fresh re-auth (or `aal2`);
  a new-device/new-country sign-in notifies + audits.

**F3 owner-action summary:** none — uses the existing Supabase project + service-role key.
**F3 detailed by:** [§33 Sessions & Identity](./33-sessions-identity.md); data model [§26.11](./26-data-model-schema.md).

---

## 45.7 F4 — Real-time & multi-device sync *(P1 · concern #2 · Cloudflare DO · deep design: [§34](./34-realtime-sync.md), [§23.2.1](./23-cloudflare-topology.md))*

**Goal:** stop two tabs/devices clobbering each other and make state converge without a reload —
a per-user coordinator Durable Object (WebSocket Hibernation) for presence, instant revocation,
and real-time convergence; optimistic-concurrency versioning; cross-tab coordination; an offline
write outbox. **Shares the Cloudflare DO+Workflows work with A2.**

**Current state (audited):** login-time + 1.5s-debounced push (`cloudSync.ts`); last-write-wins
chat sync (`chatSync.ts:6`); IndexedDB local cache; **zero** Realtime/WebSocket/SSE/presence.

### Sprint F4.1 — UserCoordinatorDO + WS hibernation *(L, ≈5d)*
- [ ] Stand up the per-user `UserCoordinatorDO` (`idFromName("user:"+userId)`) over WebSocket
      Hibernation; hold each active `(device, session)`; per-user SQLite `sessions` live cache.
      *(§23.2.1, §33.4)*
- [ ] Implement the **Postgres-first, then DO** consistency seam for irreversible facts
      (revocation, `session_epoch` bump) so a cold DO rebuilds correctly. *(§33.5 mirror rule)*
- [ ] Wire **instant revocation push** (`close(4001,'revoked')`, epoch bump, reject stale-epoch
      reconnects) — turns F3's eventually-consistent global sign-out into an instant one.
- **Depends on:** F3.2/F3.3 (sessions + revoke), Cloudflare DO enabled. **Acceptance:** "sign
  out everywhere" closes every other device's socket sub-second. **Owner action:** enable
  Durable Objects (already on Workers Paid).

### Sprint F4.2 — Presence + real-time convergence *(M, ≈4d)*
- [ ] Add presence (which devices online, viewing what) → feeds the A8 Operator Console "also
      signed in on iPhone, viewing Acme Booking."
- [ ] Replace naive last-write-wins (`chatSync.ts:6`) with **optimistic-concurrency versioning**
      (path to CRDT later); broadcast convergent updates over the DO bus.
- **Depends on:** F4.1, F2.2 (versioning pattern). **Acceptance:** an edit on device A appears on
  device B in real time; concurrent edits don't clobber.

### Sprint F4.3 — Cross-tab coordination + offline outbox *(M, ≈4d)*
- [ ] Add **BroadcastChannel** cross-tab coordination so same-device tabs don't race.
- [ ] Add an **offline write outbox** with retry-on-reconnect (not just read-only IndexedDB
      persistence).
- **Depends on:** F4.2. **Acceptance:** same-device tabs converge without races; offline writes
  sync on reconnect.

**F4 owner-action summary:** enable Durable Objects (already on Workers Paid).
**F4 detailed by:** [§34 Realtime & Sync](./34-realtime-sync.md), [§23.2.1](./23-cloudflare-topology.md).

---

## 45.8 F5 — Testing & quality gates *(P1 · top gap #3 · deep design: [§43](./43-testing-strategy.md))*

**Goal:** add the DB-, boundary-, browser-, and load-backed layers the 124-file unit base is
missing; make the suite hermetic; put an honest, ratcheting coverage gate plus engine-specific
durability and brake tests in front of the riskiest thing we run (the autonomous loop).

**Current state (audited):** strong unit base (124 files, 59 server / 65 client) + a healthy
structural-test habit (gallery-coverage, CORS config); **zero** integration/E2E/contract tests;
**no coverage gate**; env-coupled suites; one inline vitest config.

### Sprint F5.1 — Hermetic env + coverage ratchet + vitest projects *(M, ≈4d)*
- [ ] Split the vitest config into `client` (jsdom) and `server` (node) **projects**; fix the
      Supabase-env coupling so a fresh checkout with no env vars runs the unit suite green
      (mock the client in `tests/setup.ts`, not a placeholder URL). *(§43.4, §43.13)*
- [ ] Add `@vitest/coverage-v8`; set per-project floors at *measured baseline − 1%*; a hard 90%
      floor on critical paths (budget/checkpoint/events/DECIDE/guardrails/auth); fail CI on a
      drop; ratchet up in small steps. *(§43.13)*
- **Depends on:** none. **Acceptance:** unit suite runs green with no env vars set; the coverage
  gate blocks a regression and never sets an aspirational red-on-day-one floor.

### Sprint F5.2 — Integration (Express + test DB) incl. RLS isolation *(L, ≈5d)*
- [ ] Build `tests/integration/`: import the real Express app factory, drive with `supertest`,
      against a disposable Postgres (local Supabase or container) seeded with the same DDL+RLS
      F6 ships. *(§43.5)*
- [ ] Cover auth middleware, key routes (studio + `/api/ventures/*`), idempotency (F2), shared
      limits (F2), and the **headline RLS-isolation test** (user A cannot read/update/delete user
      B's rows through the API). *(§43.5)*
- **Depends on:** F6 (test DB DDL/runner), F2 (idempotency/limits to assert). **Acceptance:** an
  RLS regression fails CI; the integration suite owns its disposable DB (hermetic).

### Sprint F5.3 — E2E + visual regression + a11y *(M, ≈4d)*
- [ ] Playwright critical flows: sign-in → chat → build → deploy → billing (+ Autopilot intake →
      approve roadmap → watch a tick → approve a prod checkpoint, SSE coverage). *(§43.6)*
- [ ] Visual-regression snapshots over the gallery (set defined by `GALLERY_DEMO_TYPES`); axe
      a11y at WCAG-AA (zero critical/serious) on gated views. *(§43.8, §43.12; pairs with F9)*
- **Depends on:** F5.1, F9 (gallery extension for full visual coverage — partial without it).
  **Acceptance:** E2E happy-paths run in CI (flakes quarantined); a token change that breaks the
  gallery fails visual regression; axe passes.

### Sprint F5.4 — Engine tests + load (k6) *(M, ≈4d)*
- [ ] Engine-specific tests (gate A2): deterministic tick (inject ORIENT, stub ACT), per-brake
      hard-stop tests (budget/checkpoint/kill/no-progress/scope), crash-resume matrix over the
      seven phase boundaries (never re-charge, never double-ship), golden-path build sims, the
      eval harness. *(§43.10)*
- [ ] Make `load-test-plan.md` executable in **k6** (tiers 100–1000; thresholds encode the plan's
      acceptance); run off the PR path (staging / pre-release). *(§43.9)*
- **Depends on:** F1 (contract fixtures), A0 brakes existing to test. **Acceptance:** budget
  breach pauses; kill switch stops; no-progress raises a checkpoint; a crash mid-tick resumes;
  the load test is runnable.

**F5 owner-action summary:** none.
**F5 detailed by:** [§43 Testing Strategy](./43-testing-strategy.md); CI mechanics [§44](./44-cicd-release.md).

---

## 45.9 F6 — Schema & migration management *(P1 overall; M1–M3 are P0 · top gap #6 · [§26](./26-data-model-schema.md))*

**Goal:** replace loose run-by-hand `.sql` files with an ordered, versioned, idempotent migration
runner; create the missing migrations; add an RLS-coverage CI check; generate a schema reference.

**Current state (audited):** `server/sql/*.sql` + `docs/migrations/*.sql`, applied **manually**;
`user_devices` has **no migration at all** → environment drift and silently-missing security
policies.

### Sprint F6.1 — Migration runner + the P0 missing migrations *(M, ≈4d · pulled forward, P0)*
- [ ] Adopt a migration runner (Supabase migrations dir recommended, or Drizzle); consolidate
      existing `server/sql/` + `docs/migrations/` into ordered, versioned, **idempotent** files.
- [ ] Author the **P0-blocking** migrations: **M1 `audit_log`** (F0), **M2 `user_devices`**,
      **M3 `sessions`** (F3) — ordering M1 → M2 → M3 (FK). All `create … if not exists` /
      `drop policy … create policy`. *(§26.11, §33.5)*
- **Depends on:** none. **Acceptance:** one command applies all migrations in order on a fresh
  DB; M1/M2/M3 exist with RLS — **this unblocks F0.5 and F3.1**. **Owner action:** confirm the
  migration approach (Supabase CLI recommended).

### Sprint F6.2 — `ventures_*` migrations + version columns *(S, ≈2d)*
- [ ] Author the `ventures_*` migration set for A0/A1 (`ventures`, `venture_goals`,
      `venture_checkpoints`, `venture_budgets`, `venture_connections`, `venture_events`, `runs`).
- [ ] Add the `version` columns F2.2 needs (`studio_projects`, `ventures`).
- **Depends on:** F6.1. **Acceptance:** the `ventures_*` schema applies cleanly on a fresh DB
  with RLS; `version` columns exist for optimistic concurrency.

### Sprint F6.3 — RLS-coverage CI + schema reference *(S, ≈2d)*
- [ ] Add an **RLS-coverage check in CI**: fail if any table lacks a policy; run Supabase
      `get_advisors` in CI. *(§43.11)*
- [ ] Generate a **schema reference doc** from the source of truth (feeds [§54 data dictionary](./54-appendix-data-dictionary.md)).
- **Depends on:** F6.1, F5.1 (CI wiring). **Acceptance:** CI fails if a table lacks RLS; no "run
  this SQL by hand" steps remain; a generated schema doc exists.

**F6 owner-action summary:** confirm the migration approach (Supabase CLI recommended).
**F6 detailed by:** [§26 Data Model & Schema](./26-data-model-schema.md).

---

## 45.10 F7 — API contract & documentation *(P2 · top gap #8 / concern #9)*

**Goal:** document the REST surface as OpenAPI generated from the (zod-validated) routes, generate
a typed client as a real client/server contract, and unify docs with a clear shipped-vs-planned
index + an onboarding guide.

**Current state (audited):** broad docs + ADRs + runbooks, but **no OpenAPI**, no onboarding
guide; docs mix shipped vs aspirational.

### Sprint F7.1 — OpenAPI from routes + Swagger UI *(M, ≈4d)*
- [ ] Generate **OpenAPI** from the zod schemas (depends on F8.1) across `server/src/routes/*`;
      serve Swagger UI (admin-guarded). *(§43.7)*
- [ ] Add the **route-coverage test** (gallery-coverage pattern applied to routes): every Express
      route appears in the spec. *(§43.7)*
- **Depends on:** F8.1 (zod). **Acceptance:** every route is in the spec; the coverage test fails
  if a route is missing.

### Sprint F7.2 — Typed client + unified docs *(M, ≈4d)*
- [ ] Generate a **typed client** from the spec; add the client contract test (it compiles and
      round-trips) + response-schema validation in integration tests so the spec can't lie. *(§43.7)*
- [ ] Unify docs into one index that clearly marks **shipped vs planned**; add a dev-setup /
      onboarding + contribution guide.
- **Depends on:** F7.1, F5.2 (integration tests). **Acceptance:** the generated client compiles
  against the spec; a new dev can set up from one guide.

**F7 owner-action summary:** none. **F7 detailed by:** F-ENTERPRISE §F7; contract tests [§43.7](./43-testing-strategy.md).

---

## 45.11 F8 — Input validation & supply-chain security *(P2; security gates earlier · top gap #7 / concern #10)*

**Goal:** systematic zod validation (which also powers OpenAPI), helmet + nonce CSP for the served
frontend, CI security gates (audit/secret-scan/CodeQL), removal of the default admin, and a CSRF
review.

**Current state (audited):** good RLS + guardrails + SSRF guards + hand-rolled CSP
(`security.ts`); manual type guards (`text.validation.ts`); zod only in 2 tool-schema files; an
`admin@test.com` default lurks (`rbac.ts:12`); CI has no dependency/secret scanning.

### Sprint F8.1 — zod validation across routes *(M, ≈4d)*
- [ ] Adopt **zod** for body/query validation across `server/src/routes/*` with consistent error
      shapes; this also powers OpenAPI (F7). *(§43.11 injection)*
- **Depends on:** none. **Acceptance:** all mutating routes validate via zod and reject malformed
  bodies with a consistent error shape (asserted in F5 injection tests).

### Sprint F8.2 — CI security gates + remove default admin *(S, ≈2d · pull earlier)*
- [ ] Add CI security gates: `npm audit` / Dependabot, secret scanning (gitleaks/trufflehog +
      GitHub `run_secret_scanning`), CodeQL — block merge on a known vuln or committed secret.
- [ ] Remove the **`admin@test.com` default** (`rbac.ts:12`); require explicit `ADMIN_EMAILS` in
      prod (fail closed).
- **Depends on:** F5.1 (CI). **Acceptance:** CI blocks on a known vuln or committed secret; no
  default admin in prod. **Owner action:** enable Dependabot/CodeQL in repo settings.

### Sprint F8.3 — helmet + nonce CSP + CSRF review *(S, ≈3d)*
- [ ] Add **helmet** + a **nonce-based CSP** for the served frontend (today's CSP is API-only);
      converge with the hand-rolled headers (`security.ts`) so they can't drift.
- [ ] **CSRF review** for cookie-persisted sessions + credentialed CORS (ties F3/§33.6).
- **Depends on:** F8.1, F3 (session model). **Acceptance:** security headers are unified +
  hardened; the CSRF posture is reviewed and documented.

**F8 owner-action summary:** enable Dependabot/CodeQL in repo settings.
**F8 detailed by:** F-ENTERPRISE §F8; security tests [§43.11](./43-testing-strategy.md); [§35 Threat Model](./35-security-threat-model.md).

---

## 45.12 F9 — Design-system unification & accessibility *(P2 · concern #6)*

**Goal:** one token source feeding both Tailwind and the studio kit (kill the hand-sync), a real
shared component library + an extended living gallery, and an a11y program (axe in CI, WCAG-AA
audit, breakpoint strategy).

**Current state (audited):** two token systems hand-synced (`tailwind.config.cjs:27`,
`kit/theme.ts`); only 3 `ui/` primitives; sparse a11y; the gallery covers chat artifacts only.

### Sprint F9.1 — Single token source *(M, ≈4d)*
- [ ] Establish a **single token source** (CSS custom properties / Style Dictionary) feeding both
      Tailwind and `kit/theme.ts`; remove the hand-sync (`tailwind.config.cjs:27`).
- **Depends on:** none. **Acceptance:** one token source of truth; both consumers read it; no
  hand-sync remains.

### Sprint F9.2 — Component library + extended gallery *(L, ≈5d)*
- [ ] Grow `components/ui/` into a real shared library; extend the living gallery
      (`ComponentGallery.tsx`) to cover **app + studio** components (Storybook-style), not just
      chat artifacts — the substrate for A8's multi-dimensional displays. *(CLAUDE.md gallery rule)*
- **Depends on:** F9.1. **Acceptance:** the catalog covers the app; every component has a gallery
  demo (the structural coverage test extends to the new components).

### Sprint F9.3 — A11y program *(M, ≈3d)*
- [ ] **axe** automated tests in CI (pairs with F5.3); a WCAG-AA contrast + keyboard-nav audit;
      ARIA coverage targets; a documented responsive-breakpoint strategy. *(§43.12, [§20](./20-accessibility.md))*
- **Depends on:** F9.2, F5.3. **Acceptance:** axe passes in CI; breakpoints documented; the
  contrast/keyboard audit is recorded.

**F9 owner-action summary:** none. **F9 detailed by:** F-ENTERPRISE §F9; [§20 Accessibility](./20-accessibility.md); visual regression [§43.8](./43-testing-strategy.md).

---

## 45.13 F10 — Integrations framework unification *(P2 · concern #7)*

**Goal:** one integration model + catalog spanning Nango + MCP (state, scopes, expiry, health,
owner), inbound webhooks beyond Stripe (feeding the A6 SENSE layer), a connection-state UI, and
OAuth lifecycle observability.

**Current state (audited):** Nango meta-tools (`nango.ts`) and an SSRF-guarded MCP client
(`mcpClient.ts`) + registry with auto-disable-after-3-fails (`mcpRegistry.ts`) are **two parallel
mechanisms**; no unified catalog, no inbound webhooks (only Stripe), no connection-state/expiry
tracking.

### Sprint F10.1 — Unified integration model + catalog *(M, ≈4d)*
- [ ] Define one **integration model** spanning Nango + MCP: state, scopes, expiry, health, owner.
- [ ] Build the unified **catalog** surface (one place showing every connection's health/expiry),
      backed by `venture_connections` (no plaintext credentials — Nango reference only). *(§30)*
- **Depends on:** F6 (`venture_connections` migration), F0 (events). **Acceptance:** one catalog
  shows every connection's health and expiry across Nango + MCP.

### Sprint F10.2 — Inbound webhooks + connection-state UI *(M, ≈5d)*
- [ ] Add **inbound webhooks** beyond Stripe (Nango sync events, MCP push) → events into the
      system (feeds Autopilot's SENSE layer, A6).
- [ ] Add the **connection-state UI** ("your Slack connection expired") + retries on MCP calls;
      OAuth token-expiry tracked, not just delegated/forgotten. Step-up on connect/revoke ties F3/§33.6.
- **Depends on:** F10.1, F3.4 (step-up on connect), F0.5 (events/audit). **Acceptance:** a webhook
  event is consumed end-to-end; an expired connection is surfaced to the user.

**F10 owner-action summary:** Nango self-hosted instance configured (`NANGO_SECRET_KEY`) if not
already. **F10 detailed by:** [§30 Integrations Framework](./30-integrations-framework.md).

---

## 45.14 The ship gate before A2 (restated, with the sprint cut-line)

The single most important sequencing fact in this backlog:

```
  F0 (all 5 sprints) ─┐
  F1 (all 4 sprints) ─┼─►  the "production-ready" gate  ─►  A0 brakes  ─►  A2 loop engine
  F2 (all 3 sprints) ─┘     (+ F6.1 M1/M2/M3 pulled fwd)        (stub ACT — see §46)
```

- **Must be GREEN before A2 wires real autonomous builds:** F0.1–F0.5, F1.1–F1.4, F2.1–F2.3, and
  **F6.1** (because F0.5's audit log and F3.1's session tables both need M1/M2/M3). That is the
  ≈36-day P0 critical path plus the F6.1 migration runner (≈4d, parallelizable).
- **Runs alongside A1–A5 (P1):** F3 (sessions — A1 auth surface), F4 (real-time — shares the
  Cloudflare DO work with A2, lands for A8), F5 (testing — engine tests gate A2/A4), the rest of F6.
- **Lands by A9/GA (P2):** F7 (API docs), F8 (validation + security gates — pull F8.2 earlier as
  a cheap, high-value gate), F9 (design system + a11y gate), F10 (integrations — feeds A6 SENSE).

This is the same hard rule from the F-ENTERPRISE source: *you cannot run an always-on builder you
can't observe, on providers that fail silently, with limits that don't hold across instances.*

---

## 45.15 Cross-references & acceptance roll-up

| Epic | Deep design section | F-epic acceptance (source) satisfied by sprints |
|---|---|---|
| F0 | [§38](./38-observability.md) | F0.1 Sentry · F0.2 pino · F0.3 metrics · F0.4 traces/queue · F0.5 audit+alerts |
| F1 | [§29](./29-model-gateway.md) | F1.1 key pool · F1.2 breaker+failover · F1.3 image/budgets · F1.4 metrics+contract |
| F2 | F-ENTERPRISE §F2; [§25](./25-multitenancy-isolation.md), [§39](./39-performance-scalability.md) | F2.1 shared limits · F2.2 optimistic concurrency · F2.3 idempotency+worker |
| F3 | [§33](./33-sessions-identity.md) | F3.1 migrations/write · F3.2 JWKS+sessions · F3.3 device revoke · F3.4 MFA/step-up |
| F4 | [§34](./34-realtime-sync.md), [§23.2.1](./23-cloudflare-topology.md) | F4.1 DO+revocation · F4.2 presence+convergence · F4.3 cross-tab+outbox |
| F5 | [§43](./43-testing-strategy.md) | F5.1 hermetic+coverage · F5.2 integration+RLS · F5.3 E2E+visual+axe · F5.4 engine+load |
| F6 | [§26](./26-data-model-schema.md) | F6.1 runner+M1/M2/M3 · F6.2 ventures+version · F6.3 RLS-coverage+schema doc |
| F7 | F-ENTERPRISE §F7; [§43.7](./43-testing-strategy.md) | F7.1 OpenAPI+coverage · F7.2 typed client+unified docs |
| F8 | F-ENTERPRISE §F8; [§35](./35-security-threat-model.md), [§43.11](./43-testing-strategy.md) | F8.1 zod · F8.2 CI gates+no-default-admin · F8.3 helmet/CSP+CSRF |
| F9 | F-ENTERPRISE §F9; [§20](./20-accessibility.md), [§43.8](./43-testing-strategy.md) | F9.1 token source · F9.2 library+gallery · F9.3 a11y program |
| F10 | [§30](./30-integrations-framework.md) | F10.1 catalog · F10.2 webhooks+connection-state |

**One-line stance:** F-ENTERPRISE graded the gaps from a real audit; this backlog turns each gap
into an ordered, flag-safe, acceptance-gated sprint plan — with F0 → F1 → F2 (+ F6.1) cut as the
hard production-ready gate that must be green before the always-on engine (A2) ships.

---

*Next: [46 — Autonomy Backlog A0–A9](./46-autonomy-backlog.md). Upstream:
[F-ENTERPRISE-FOUNDATIONS](../F-ENTERPRISE-FOUNDATIONS.md) (the source) ·
[00-MASTER-PLAN](../00-MASTER-PLAN.md) (sequencing) ·
[47 — Roadmap & sequencing](./47-roadmap.md) (when these land relative to A0–A9).*
