# 22 — System Architecture Overview

> Part III · Architecture · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Cloudflare topology](../ARCHITECTURE-CLOUDFLARE.md) ·
> [Master Plan §4](../00-MASTER-PLAN.md) ·
> [Enterprise Foundations](../F-ENTERPRISE-FOUNDATIONS.md) ·
> [Domain model](./09-domain-model-glossary.md). Deep-dives: §23 (Cloudflare),
> §24 (the loop), §26 (schema), §27/§28 (APIs), §34 (real-time).

## 22.1 Purpose & honest framing

This section is the **map**: the full set of subsystems, what physically runs where, how
data and control flow through them, and — critically — the **two architectures that coexist**.
Autopilot is not a green-field design. It is a governance + orchestration layer over a product
that already ships, mid-flight through a deliberate migration from a Railway-centric runtime to
a Cloudflare-native one.

Two honesty rules govern everything below:

1. **Shipped vs planned is marked on every box.** A `✅` subsystem exists in this repo today
   (file-referenced); a `📋` subsystem is specced but not built; a `◐` subsystem partly exists
   and is being extended. The deployment picture (`server/src/index.ts`, `railway.json`,
   `vercel.json`, `studio-worker/wrangler.jsonc`) is read straight from the repo.
2. **The target is an evolution, not a rewrite.** Every new primitive lands **behind an
   interface** so the system stays shippable at each step (Master Plan A2; F-series §"Revised
   sequencing"). We never run the autonomous engine without the brakes (A0), and we never cut
   over a subsystem until its replacement is proven.

The detail behind each box lives in its own section; this one exists so the reader holds the
whole shape in their head before descending.

---

## 22.2 Logical architecture (the full component map)

Every subsystem Autopilot touches, grouped by tier, with shipped/planned status:

```
 ┌──────────────────────────────────── CLIENT TIER ─────────────────────────────────────┐
 │  React 19 + Vite SPA (✅)        Operator Console (📋, Epic A8)   Intake wizard (📋,A3)│
 │  Code Studio 3-pane (✅)         Billing/budgets portal (📋,A7)   Mobile-responsive(✅)│
 │  services/*Api.ts (✅) · venturesApi.ts (📋)  ·  SSE today (✅) → WebSocket target (📋)│
 └───────────────────────────────┬───────────────────────────────────────────────────────┘
            HTTPS (REST + SSE today) │ HTTPS + WS (target)
 ┌───────────────────────────────▼──────────── EDGE TIER (Cloudflare) ───────────────────┐
 │  Pages: SPA static hosting (✅)        Worker: edge gateway (◐ today = preview only)    │
 │                                          auth gateway · API/preview routing · WS upgrade │
 │   ┌───────────── studio-worker (✅) ──────────┐   ┌──── UserCoordinatorDO (📋, F4) ────┐│
 │   │ Sandbox Durable Object + Container        │   │ per-user: sessions, presence,       ││
 │   │ (Sandbox SDK): npm i · dev server · exec  │   │ instant revocation, real-time sync  ││
 │   │ · logs · exposePort → preview URL         │   └─────────────────────────────────────┘│
 │   └───────────────────────────────────────────┘   ┌──── VentureDO (📋, A2/target) ─────┐│
 │                                                     │ per-venture: Alarm tick heartbeat,  ││
 │   ┌──── Workflows (📋, target A4) ────┐             │ isolation, concurrency, activity WS ││
 │   │ durable build pipeline per goal:  │◄── starts ──┤                                     ││
 │   │ plan→write→run→observe→fix→ship   │             └─────────────────────────────────────┘│
 │   └───────────────────────────────────┘                                                   │
 └───────┬──────────────────────────────────────────────┬────────────────────────┬─────────┘
   RPC / HTTP │                                     read/write │             enqueue │ (today)
 ┌────────────▼─────────── CONTROL / API TIER ─────────▼──────────┐  ┌──────────────▼────────┐
 │  Railway: Express API (✅)                                       │  │ Railway: workers       │
 │   chat/text/image/vision/studio/billing/admin routes (✅)        │  │  comicforge:worker (✅) │
 │   ventures control plane (📋, A1): CRUD goals/checkpoints/       │  │  ventures:worker(📋,A2) │
 │   budgets/connections/events · RLS hooks · usageEnforcer (✅)    │  │  (BullMQ repeatable     │
 │  Railway: Redis (✅) — BullMQ queue + (target) shared rate limit │  │   tick scheduler)       │
 └────────────┬────────────────────────────────────────────────────┘  └───────────┬───────────┘
   read/write │                                                                     │
 ┌────────────▼──────────────────────── DATA & EXTERNAL TIER ──────────────────────▼─────────┐
 │  Supabase (✅): Postgres system-of-record + Auth (GoTrue/JWT) + RLS owner-isolation         │
 │    existing: studio_projects/files/versions/runs/deployments, token_ledger, etc.            │
 │    new (📋): ventures, venture_goals/runs/checkpoints/budgets/connections/events            │
 │  R2 (◐ artifacts/blobs)  ·  KV (◐ edge cache)  ·  Hyperdrive (📋 PG pooling)                 │
 │  Nango (✅ wiring): BYO provider credentials (encrypted, references only in our DB)          │
 │  Stripe (✅): billing, credits, webhooks  ·  Model providers (✅): OpenRouter, NVIDIA, Gemini│
 │  Deploy targets (◐→📋): managed *.dreamstreamstudio.ai (✅) · BYO CF/Vercel/Railway/Supabase │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
```

Subsystem responsibilities at a glance:

| Subsystem | Status | Owns | Key files / refs |
|---|---|---|---|
| React/Vite SPA | ✅ | All UI; chat, Code Studio; (planned) Console/intake/billing | `components/`, `services/*Api.ts` |
| Cloudflare Pages | ✅ | Static SPA hosting on the production branch | (CF Pages project, `Dreamstrream-v1`) |
| Edge Worker | ◐ | Today: preview routing. Target: auth gateway + API/WS routing | `studio-worker/src/index.ts` |
| studio-worker (Sandbox DO + Container) | ✅ | Sandboxed `npm i` / dev server / exec / preview URLs | `studio-worker/`, `wrangler.jsonc` |
| UserCoordinatorDO | 📋 (F4) | Per-user sessions, presence, instant revocation, real-time sync | §34, ARCHITECTURE-CLOUDFLARE §3 |
| VentureDO | 📋 (A2 target) | Per-venture Alarm tick heartbeat, isolation, concurrency, activity WS | §23, §24 |
| Workflows | 📋 (A4 target) | Durable, resumable per-goal build pipeline | §24 |
| Railway Express API | ✅ | REST surface; (planned) ventures control plane | `server/src/index.ts`, `routes/` |
| Railway worker(s) | ◐ | `comicforge:worker` today; `ventures:worker` planned | `server/src/comicforge/`, `ventures/` (planned) |
| Redis | ✅ | BullMQ queues; (target) shared rate limit + caps (F2) | `comicforge/queue.ts` |
| Supabase | ✅ | Postgres system-of-record, Auth, RLS | `services/supabase.ts`, `server/sql/*` |
| R2 / KV / Hyperdrive | ◐/📋 | Blobs, edge cache, PG pooling | ARCHITECTURE-CLOUDFLARE §1 |
| Nango | ✅ wiring | BYO provider credential vault (references only) | `server/src/ai/tools/nango.ts` |
| Stripe | ✅ | Billing, credits, webhooks | `server/src/services/stripe.ts` |
| Model providers | ✅ | LLM/image generation via the gateway/auto-router | `server/src/ai/gateway.ts`, `autoRouter.ts` |

---

## 22.3 Runtime & deployment topology (what runs where)

Read straight from the deployment config in the repo. The platform spans **three providers**,
each running a distinct class of workload:

```
  PROVIDER        UNIT                              WORKLOAD                         CONFIG
  ─────────────────────────────────────────────────────────────────────────────────────────
  Cloudflare      Pages project                     SPA static assets (build → CDN)  vercel.json*
   (edge)         Worker: dreamstream-studio (✅)    preview routing + Sandbox ctrl   studio-worker/
                  Container: Sandbox standard-3 (✅) 2 vCPU/8GiB/16GB, max 50 inst.   wrangler.jsonc
                   └ + warm pool, standard-2/custom (📋 target, ARCHITECTURE §5)
                  Durable Objects (📋 target)        UserCoordinatorDO · VentureDO    §23
                  Workflows (📋 target)              per-goal durable build pipeline  §24
  ─────────────────────────────────────────────────────────────────────────────────────────
  Railway         Service: API (✅)                  Express, Dockerfile, :PORT       railway.json
                   healthcheck /api/health · restart ON_FAILURE (≤5)
                  Service: comicforge:worker (✅)     BullMQ consumer                  package.json
                  Service: ventures:worker (📋, A2)  repeatable tick scheduler        Master Plan §4.3
                  Service: Redis (✅)                 BullMQ broker / shared state     REDIS_URL
  ─────────────────────────────────────────────────────────────────────────────────────────
  Supabase        Project (✅)                        Postgres + Auth + RLS           services/supabase.ts
   (managed)      (BYO Supabase, per-venture 📋)     provisioned tenant DBs (A5)      adapters/
  ─────────────────────────────────────────────────────────────────────────────────────────
  External SaaS   Nango (✅) · Stripe (✅) · model providers (✅) · BYO CF/Vercel/Railway (📋, A5)

  * vercel.json (SPA rewrite-all-to-index.html) documents the SPA-hosting contract; production
    serves the SPA via Cloudflare Pages on the Dreamstrream-v1 branch (CLAUDE.md "Deploy").
```

Key facts and constraints:

- **The Express API is a normal long-running Node process on Railway** (`npm run start:server`
  → `server/dist/.../index.js`), Dockerfile-built, with a `/api/health` healthcheck and
  `restartPolicyType: ON_FAILURE`. It is the current home of every route and, in the transition,
  the home of the ventures control plane (A1).
- **Background work runs as separate Railway services**, not in the API process — the
  `comicforge:worker` pattern (`tsx server/src/comicforge/worker.ts`) is the template the
  ventures worker mirrors so the autonomous loop never blocks request handling (F2; Master Plan
  §4.3).
- **Sandboxed code execution only ever runs in the Cloudflare Container**, controlled from the
  Worker over **HMAC-signed** requests (`verifyHmac` in `studio-worker/src/index.ts`) so the
  container control plane is never reachable from a browser. One sandbox per `(user, project)`
  (`u_<userId>_<projectId>`) — the isolation boundary Autopilot keeps verbatim (Master Plan §5.2).
- **Preview URLs need no custom-domain plumbing per app:** `exposePort` yields
  `<port>-<sandboxId>-<token>.dreamstreamstudio.ai`, covered by the first-level wildcard route
  and free Universal SSL (`wrangler.jsonc` `routes` + `STUDIO_PREVIEW_DOMAIN`).
- **Supabase is the portable system-of-record.** Keeping it (rather than migrating to D1)
  is the deliberate hedge against Cloudflare vendor concentration (ARCHITECTURE §4): RLS, auth,
  and all durable state stay on Postgres, so BYO deploy targets and an exit path remain viable.

---

## 22.4 Primary data & control flows

Four canonical flows show how the tiers cooperate. Each is drawn in the **target** topology;
where today differs, the divergence is called out (and §22.6 maps the migration).

### Flow A — Intake (idea → approved roadmap) — 📋 A3

```
 User (SPA intake wizard)
   │ POST /api/ventures/intake  {idea}
   ▼
 Control plane (Express/A1) ── creates ventures row (status=draft) ── Supabase
   │ calls intake.ts (reuses studioPlan + swarm planner via autoRouter → model provider)
   ▼
 LLM returns {name, summary, scope, success_metrics, roadmap: VentureGoal[]}  (JSON-validated)
   │ writes venture_goals (status=proposed); raises a roadmap-approval Checkpoint
   ▼
 Operator Console approval queue ── user APPROVES ── POST /:id/approve-roadmap
   │ resolves the checkpoint; scope stored; venture → roadmap_pending → active
   ▼
 Venture is now eligible for the loop (Flow B picks it up).
```

The gate is the **roadmap-approval checkpoint** (Master Plan §8 #6): no autonomous work runs
until the human approves, and `scope` is stored so the scope-guard can keep ORIENT inside it.

### Flow B — One build tick — 📋 A2 (engine) + A4 (real ACT)

```
 Tick driver (today: BullMQ repeatable job on Railway; target: VentureDO Alarm)
   │ admits an active, non-paused, in-budget venture (checks kill switch + concurrency cap)
   ▼
 SENSE ──► ORIENT ──► DECIDE ──► ACT ──────────► VERIFY ──► SHIP ──────► REFLECT ──► sleep
   │         │          │         │                 │         │            │
 signals    LLM picks  pure gate  build engine     verifyApp deploy       append venture_event,
 (backlog,  next goal  (budget?   (buildAgent/      + tests + adapter      update venture_goals,
  health,   + scope)   checkpoint studioGenerate)   safety    (managed     record cost, learnings
  errors)              + scope?)  in studio-worker  scan      auto; prod =
                                  sandbox → new                checkpoint)
                                  studio_version
   GUARDS (DECIDE + continuous): budget caps · checkpoint gates · no-progress · max-ticks ·
                                 wall-clock · global kill switch · concurrency cap
```

- **ACT** dispatches to the **existing** Phase-4 build loop (`server/src/ai/studio/`) against
  the venture's `studio_project`; success creates a `studio_version`. In the target, the
  multi-step ACT→VERIFY→SHIP body becomes a **Workflow** (auto-retry, resumable across restarts)
  — the durability the current one-shot loop lacks.
- **Every spend is metered before it happens**: DECIDE reads `venture_budgets`; REFLECT writes
  cost via `costEstimator.ts` → `billingLedger.ts`, tagged `venture_id`. Breach → pause + notify.
- **Each tick is the atomic resumable unit**, recorded as a span of `venture_events` (no Tick
  table — §9.3). Crash mid-tick resumes from durable state on the next schedule.

### Flow C — A deploy (SHIP) — 📋 A5

```
 SHIP step selects an Adapter by target + available Connection
   │
   ├─ managed-preview (✅ studio-worker) ── auto ── exposePort → preview URL ── studio_deployments
   │
   └─ production (BYO) ── FIRST raises a first-production-deploy Checkpoint ──► (paused)
            │ user APPROVES in Console
            ▼
        Adapter.deploy(ctx, build): cloudflare-pages | vercel | railway   (📋 A5)
            │ credentials resolved from venture_connections → Nango (references only)
            ▼
        Provider builds & publishes ──► DeployResult{url,status} ──► studio_deployments(+venture_id,
            is_production) ──► ventures.deploy_url updated ──► venture_event(ship)
```

The adapter interface (`DeployAdapter` in Master Plan §6) makes SHIP **provider-agnostic**;
managed previews are automatic, **production is always checkpoint-gated** (Master Plan §8 #1),
and deploy tokens are per-venture, least-privilege, never logged.

### Flow D — A real-time update — SSE today (✅) → WebSocket target (📋 F4/A8)

```
 TODAY (✅):  worker appends venture_event ──► Console GET /api/ventures/:id/stream (SSE)
              ──► ActivityFeed / SwarmTraceCard render the event. One-way, polled/streamed.

 TARGET (📋): worker appends event ──► VentureDO broadcasts over a hibernating WebSocket
              ──► every connected Console device updates instantly; UserCoordinatorDO pushes
              session/presence/revocation to all of a user's devices (multi-device convergence).
```

The SSE path is the shipped, honest starting point (Master Plan §4.2 shows SSE on
`/api/ventures/*`; the studio already uses `ActivityFeed`/`SwarmTraceCard`). The WebSocket +
Durable Object path is the target that fixes multi-device sync and instant revocation (F4) — see
§34 for the convergence/conflict model.

---

## 22.5 Tech stack

| Layer | Technology | Status | Notes |
|---|---|---|---|
| Frontend framework | React 19 + Vite 6 | ✅ | SPA; `react-router-dom` 7; Zustand state |
| Styling / UI | Tailwind 3 + Primitive Kit | ✅ | Comic house style; `components/ui/*` (3 primitives, F9 grows it) |
| Editor | Monaco + Sandpack | ✅ | Code Studio panes |
| Frontend hosting | Cloudflare Pages | ✅ | Built from `Dreamstrream-v1` branch |
| Edge compute | Cloudflare Workers | ◐ | Preview routing today; gateway/WS target |
| Sandboxed execution | Cloudflare Containers (Sandbox SDK) | ✅ | `@cloudflare/sandbox` 0.4.x, `standard-3` |
| Coordination / scheduling | Cloudflare Durable Objects + Alarms | 📋 | `VentureDO`, `UserCoordinatorDO` (target) |
| Durable pipelines | Cloudflare Workflows | 📋 | Per-goal build (target A4) |
| API runtime | Node 20 + Express 4 | ✅ | Railway, Dockerfile, `/api/health` |
| Background jobs | BullMQ 5 + ioredis | ✅ | `comicforge:worker`; ventures worker mirrors it |
| Broker / shared state | Redis | ✅ | Queues now; shared rate limit/caps (F2) target |
| System-of-record | Supabase Postgres + RLS | ✅ | Owner-isolation `auth.uid() = user_id` |
| Auth / identity | Supabase Auth (GoTrue/JWT) | ✅ | JWKS local verify + first-party sessions (F3) target |
| Object storage / cache / PG pool | R2 / KV / Hyperdrive | ◐/📋 | Partial; expand per ARCHITECTURE §1 |
| Integrations / secrets vault | Nango | ✅ wiring | BYO creds; references only in our DB |
| Billing | Stripe | ✅ | Credits, webhooks, `stripePriceConfig` |
| Model gateway | OpenRouter · NVIDIA · Gemini | ✅ | `gateway.ts` + `autoRouter.ts`; pool/breaker/failover (F1) target |
| Language | TypeScript 5.8 (strict) | ✅ | Shared `apiTypes.ts` client/server contract |
| Tests | Vitest | ✅ | Unit today; integration/E2E/coverage (F5) target |

Honest deltas the F-series closes (so the table isn't read as "all done"): provider
reliability (F1: key pool, circuit breaker, cross-provider failover); distributed correctness
(F2: Redis-shared limits, optimistic concurrency); observability (F0: Sentry/metrics/tracing
are not yet wired); real-time (F4). These are deep-dived in §29, §25, §38, §34 respectively.

---

## 22.6 Build vs runtime separation

A defining property of the architecture: **the code that builds tenant products is strictly
separated from the code that runs the platform — and from where tenant code executes.** Three
distinct planes, three trust boundaries:

```
  ┌──────────────────┐    HMAC-signed control     ┌────────────────────────────────┐
  │  PLATFORM PLANE   │ ─────────────────────────► │  EXECUTION PLANE (per-tenant)   │
  │  Express API,     │                            │  Cloudflare Container sandbox    │
  │  ventures worker, │  files/cmds in; logs/      │  u_<userId>_<projectId>          │
  │  control plane,   │ ◄───── preview URL out ──── │  npm i · dev server · build      │
  │  guardrails       │                            │  (generated/AI code runs HERE,   │
  │  (TRUSTED)        │                            │   never in platform processes)   │
  └────────┬─────────┘                            └────────────────────────────────┘
           │ reads/writes (RLS, service identity, scoped by venture_id + user_id)
           ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │  STATE PLANE: Supabase Postgres (durable) · Redis (ephemeral coordination) ·   │
  │  R2 (artifacts) · Nango (tenant secrets — references only on the platform side) │
  └──────────────────────────────────────────────────────────────────────────────┘
```

Why this matters:

- **Generated code never executes in a trusted process.** The build engine *orchestrates*;
  the AI-produced code runs only in the per-tenant sandbox. A malicious or confused build cannot
  read another tenant's data or the platform's secrets (Master Plan §5.2).
- **Build artifacts are versioned state, not running services.** ACT produces a
  `studio_version`; SHIP turns a chosen version into a Deployment via an Adapter. The "build"
  output is data in Postgres/R2; the "runtime" of the *tenant product* is whatever the deploy
  target hosts (managed preview or BYO cloud) — entirely separate from the platform runtime.
- **Platform secrets and tenant secrets never mix.** Platform secrets live in host env
  (Railway/Cloudflare); tenant BYO credentials live in Nango and are referenced by
  `venture_connections` — never stored plaintext in our DB or shipped in the client bundle
  (Master Plan §5.3).

This separation is the precondition for safe autonomy: the brakes (A0) govern the platform
plane; isolation governs the execution plane; RLS governs the state plane.

---

## 22.7 Transition architecture (current → target) & the interface seams

The system is mid-migration. The current runtime is **Railway Express + BullMQ/Redis + SSE**;
the target adds **Cloudflare Durable Objects + Workflows + WebSocket**. This is explicitly an
**incremental migration, not a big-bang switch** (ARCHITECTURE §4; Master Plan §4.3, A2).

| Concern | Current (✅ shipped) | Target (📋) | Migration seam |
|---|---|---|---|
| Tick heartbeat / scheduling | BullMQ repeatable job on Railway worker | `VentureDO` Alarm (no cron runner) | `scheduler.ts` interface — swap the driver, keep the tick |
| Build pipeline durability | One-shot in-process loop | Cloudflare **Workflow** per goal (retry/resume) | `tick.ts` ACT calls a `BuildPipeline` interface |
| Per-venture isolation/concurrency | In-memory caps per process | One `VentureDO` per venture | Concurrency check abstracted behind the scheduler |
| Real-time to the Console | SSE `/api/ventures/:id/stream` | `VentureDO` hibernating WebSocket | Console subscribes via a transport-agnostic client |
| Sessions / multi-device | Supabase JWT, per-request `getUser()` | `UserCoordinatorDO` + JWKS + first-party sessions | Auth middleware seam (F3) |
| Shared rate limits / caps | In-memory per process | Redis-atomic (F2) | `rateLimit.ts` / caps interface |

```
  PHASE 0 (today)            PHASE 1 (A0–A2)             PHASE 2 (A4 + F4 target)
  ───────────────            ───────────────             ────────────────────────
  Railway Express only       + ventures control plane    Worker = edge gateway;
  studio-worker sandbox      + ventures:worker (BullMQ)  VentureDO Alarm = heartbeat;
  SSE activity               + brakes (A0)               Workflows = build pipeline;
                             behind interfaces           UserCoordinatorDO + WS = real-time
                                                         (Railway API retained as control plane)
```

The governing principles for the migration:

1. **Interface-first.** The orchestrator is built behind an interface (Master Plan A2) so the
   scheduler driver (BullMQ → DO Alarm) and the build executor (in-process → Workflow) can be
   swapped without rewriting the loop logic. The same applies to the activity transport (SSE →
   WS) and the auth path (per-request `getUser()` → JWKS, F3).
2. **Retire only when proven.** Railway stays as the API/control tier through the transition
   (ARCHITECTURE §5 step 5); a piece is removed only once its DO/Workflow replacement is proven
   in production. Supabase is **never** retired — it is the portable system-of-record.
3. **Brakes before engine, foundations before autonomy.** A0 (budgets/kill-switch/checkpoints/
   audit) and F0–F2 (observability, provider reliability, distributed correctness) ship **before**
   A2 wires real autonomous builds (F-series "Hard rule"). You cannot run an always-on builder
   you cannot observe, on providers that fail silently, with limits that don't hold across
   instances.
4. **Cold-start mitigation.** Containers cold-start and sleep when idle; the target adds a small
   **warm pool** for interactive builds (ARCHITECTURE §5 step 4) — a runtime-topology change, not
   an architecture change.

---

## 22.8 Reuse map (each subsystem → the existing module it builds on)

Autopilot is **mostly orchestration + state + governance over assets that already exist**
(Master Plan §3). The risky/expensive parts — sandboxed execution, billing, multi-model,
the swarm — are done. This is the canonical mapping for the rest of Part III:

| Subsystem (this spec) | Builds on (existing) | Path | New work |
|---|---|---|---|
| Build engine (ACT/VERIFY) | Agentic build loop (Phase 4) | `server/src/ai/studio/` (`buildAgent.ts`, `studioGenerate.ts`, `studioFix.ts`, `verifyApp.ts`, `observation.ts`, `buildGuards.ts`) | wrap in tick; Workflow (A4) |
| Multi-agent decomposition | Agent swarm | `server/src/ai/agents/` (`orchestrator.ts`, `registry.ts`, `swarmTool.ts`, `verify.ts`) | consume for large goals |
| Sandboxed execution | studio-worker (Containers) | `studio-worker/` (`src/index.ts`, `wrangler.jsonc`) | warm pool; managed-preview adapter |
| Codebase substrate | Studio data model | `server/sql/studio_*.sql`, `services/studioRepository.ts`, `studioFiles.ts` | add `venture_id` FK; new `venture_*` tables |
| Tick scheduler / worker | BullMQ + ioredis pattern | `server/src/comicforge/queue.ts`, `worker.ts`, `workers/*` | `server/src/ventures/{queue,scheduler,tick}.ts` |
| Metering & budgets | Usage + billing | `services/usageEnforcer.ts`, `billingLedger.ts`, `costEstimator.ts`, `stripe.ts` | `venture_id` tag; `venture_budgets` gate |
| Model gateway | Auto-router | `server/src/ai/autoRouter.ts`, `providers/` | pool/breaker/failover (F1) |
| BYO connections | Nango connectors | `server/src/ai/tools/nango.ts` | `venture_connections`; deploy adapters |
| Deploy history | studio_deployments | `server/sql/`, deployment records | extend with `venture_id`/`goal_id`/`is_production` |
| Real-time UI | Studio trace components | `components/chat/artifacts/SwarmTraceCard.tsx`, studio `ActivityFeed` | venture event stream; WS (F4) |
| Auth / RLS | Platform backbone | `services/supabase.ts`, `server/src/middleware/auth.ts`, `server/sql/*_rls_*.sql` | mirror RLS onto `venture_*`; F3 hardening |
| Code-safety scan | Guardrails | `server/src/ai/guardrails.ts`, `persona.ts` | extend for diff/secret/dangerous-op scan (A9) |
| Sense signals | Verification runner / jobs | `server/src/verification/runner.ts`, `server/src/jobs/*` | health checks → `venture_events` (A6) |

**Implication:** the new code is the **governance and orchestration shell** — `ventures/`
(queue, scheduler, tick, budget, checkpoints, events, adapters), the `venture_*` schema, the
control-plane routes, and the Operator Console. Everything that actually builds, runs, meters,
and secures is reused. The subsequent Part III sections (§23–§34) detail each shell component;
§25 (multi-tenancy), §26 (schema), and §35 (threat model) detail the isolation guarantees that
make the reuse safe.
