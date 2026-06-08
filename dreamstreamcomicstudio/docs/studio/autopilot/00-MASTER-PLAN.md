# Code Studio Autopilot — Master Plan (always-on autonomous ventures)

> **What this is.** The plan for the layer that turns DreamStream's *interactive* Code
> Studio (chat → agent builds one app → preview/deploy) into an **always-on autonomous
> product team**: the user gives a **business/product idea**, and agents continuously
> **plan → build → test → deploy → observe → iterate**, 24/7, with **hard budgets and
> human checkpoints**, hosting on **our managed infra or the user's own accounts**, billed
> through **one central portal**.
>
> **This is a NEW workstream layered on the existing studio** (Phases 0–11). It does not
> replace them — it *consumes* them. Read [`../00-STATUS.md`](../00-STATUS.md) and
> [`../01-VISION.md`](../01-VISION.md) first; `01-VISION.md` explicitly listed "24/7
> always-on as the core loop" as a **non-goal** — this plan is the deliberate decision to
> build that layer now, safely.

**Status:** 📋 planned (backlog defined; nothing built yet) · **Tracker:**
[`STATUS.md`](./STATUS.md) · **How Claude builds it:**
[`OPERATING-MODEL.md`](./OPERATING-MODEL.md)

**Owner decisions locked (2026-06-07):**
- **Hosting:** Hybrid — managed preview deploys now (`*.dreamstreamstudio.ai`, infra is
  live) + bring-your-own provider accounts (Cloudflare / Vercel / Supabase / Railway) via
  the existing **Nango** connectors, phased in second.
- **First scope:** Generalize the existing Code Studio (idea → web app / landing / simple
  SaaS, live). Reuse what's built; don't boil the ocean.
- **Autonomy:** Continuous with checkpoints + budgets. "Never stop iterating" — yes;
  ungoverned — no. Brakes are built *before* the engine.
- **Codebase:** Extend this repo (`dreamstreamcomicstudio/`).

---

## Table of contents
1. [The vision delta (what's actually new)](#1-the-vision-delta)
2. [Glossary — the new concepts](#2-glossary)
3. [What we build on (reuse inventory)](#3-what-we-build-on)
4. [Target architecture — the autonomous loop](#4-target-architecture)
5. [Security & multi-tenancy model](#5-security--multi-tenancy)
6. [Hosting model (hybrid) & deploy adapters](#6-hosting-model--deploy-adapters)
7. [Billing, budgets & the central portal](#7-billing-budgets--the-central-portal)
8. [Guardrails & checkpoints (the brakes)](#8-guardrails--checkpoints)
9. [The Epic → Sprint backlog (A0–A9)](#9-the-epic--sprint-backlog)
10. [Milestones & sequencing](#10-milestones--sequencing)
11. [Risks & honest caveats](#11-risks--honest-caveats)
12. [Owner actions (consolidated)](#12-owner-actions)

---

## 1. The vision delta

The existing studio already does, or has specced, the **one-shot interactive build**:
PLAN → ACT → RUN → OBSERVE → FIX, with persistence, versioning, GitHub sync, and (planned)
one-click deploy. That is a *Lovable/Emergent-class* product.

**Autopilot adds three things on top, and only these three are genuinely new:**

| New capability | One-line definition | Why it's hard |
|---|---|---|
| **Continuous autonomy** | A durable, always-on loop that keeps building/iterating a product against a roadmap, across days/weeks, surviving restarts. | Must be crash-safe, budgeted, and never spin forever or burn money. |
| **The "Venture" abstraction** | A product/business (not a single app) the agents *own*: a roadmap, a backlog, deployments, analytics, a budget, connected accounts. | Higher-level than `studio_projects`; needs goal/decision/audit state. |
| **Hybrid hosting + central billing for autonomy** | Ship to our managed infra *or* the user's own cloud accounts, metered + billed per venture through one portal. | Multi-tenant secrets, provider adapters, per-venture metering. |

Everything else (the actual building, the editor, the swarm, the tools, the previews) is
**reused, not rebuilt**.

**Plain-English promise (honest version):** "Describe your product. Autopilot drafts a
roadmap you approve, then works it 24/7 — building, testing, and shipping features —
pausing only to ask you about money, production launches, or anything risky, and stopping
the moment it hits the budget you set."

---

## 2. Glossary

- **Venture** — the top-level unit. A product/business idea the user hands to Autopilot.
  Owns a roadmap, a backlog, one or more `studio_projects` (the actual codebases),
  deployments, connected accounts, a budget, and an audit trail. *(new table: `ventures`)*
- **Goal** — one item of work in a venture's backlog/roadmap (epic → feature → task).
  Has status, priority, dependencies, an estimate, and a result. *(new: `venture_goals`)*
- **Run** — one autonomous *session* of the loop working a venture (bounded by budget/time).
  A run is made of many **ticks**. *(new: `venture_runs`)*
- **Tick** — one pass of the loop: SENSE → ORIENT → DECIDE → ACT → VERIFY → SHIP → REFLECT.
  The atomic, resumable unit. Each tick is metered and logged.
- **Checkpoint** — a point where the loop **pauses for human approval** (deploy to prod,
  spend money, destructive op, scope change). *(new: `venture_checkpoints`)*
- **Budget** — hard caps (USD/day, USD total, tokens, container-minutes) per venture; on
  breach the venture **pauses** and notifies. *(new: `venture_budgets`)*
- **Connection** — a user's BYO provider account (Cloudflare/Vercel/Supabase/Railway/GitHub)
  linked via Nango/OAuth/PAT, used by deploy adapters. *(new: `venture_connections`)*
- **Adapter** — a pluggable `deploy()` / `provision()` implementation for one provider.
- **Event** — an append-only audit record of everything the loop sensed, decided, did, and
  spent. The source of truth for "what is my agent doing?" *(new: `venture_events`)*

---

## 3. What we build on

The point of "extend this repo" is **maximum reuse**. Concrete map of what Autopilot
consumes (do not rebuild these):

| Need in Autopilot | Existing asset to reuse | Path |
|---|---|---|
| Build one feature (plan→write→run→observe→fix) | Agentic build loop (Phase 4) | `server/src/ai/studio/` (`buildAgent.ts`, `studioGenerate.ts`, `studioFix.ts`, `verifyApp.ts`, `observation.ts`, `buildGuards.ts`) |
| Multi-agent decomposition / specialists | Agent swarm | `server/src/ai/agents/` (`orchestrator.ts`, `registry.ts`, `swarmTool.ts`, `verify.ts`) |
| Run code + logs in a sandbox | Studio Worker (Cloudflare Containers) | `studio-worker/` (`src/index.ts`, `wrangler.jsonc`) |
| Durable project/files/versions | Studio data model | `server/sql/studio_projects.sql`, `studio_files`, `studio_versions`, `studio_runs`, `studio_deployments`; `server/src/services/studioRepository.ts`, `studioFiles.ts` |
| Background jobs / queue | BullMQ + ioredis + worker pattern | `server/src/comicforge/queue.ts`, `worker.ts`, `workers/*` |
| Metering + caps + ledger | Usage + billing | `server/src/services/usageEnforcer.ts`, `billingLedger.ts`, `costEstimator.ts`, `stripe.ts` |
| Model routing (incl. coding pref) | Auto-router | `server/src/ai/autoRouter.ts`, `providers/` |
| Connect user's external accounts | Nango connectors | `server/src/ai/tools/nango.ts`, `deploy/studio-tools/docker-compose.yml`, `.env.studio-tools.example` |
| GitHub two-way sync | Studio GitHub | `server/src/services/studioGithub.ts`, `routes/studioGithub.ts` |
| MCP tools / marketplace | MCP registry | `server/src/services/mcpRegistry.ts`, `ai/tools/mcpClient.ts`, `routes/mcp.ts` |
| Output safety / persona | Guardrails (Phase 11) | `server/src/ai/guardrails.ts`, `persona.ts` |
| Scheduled self-checks pattern | Verification runner / jobs | `server/src/verification/runner.ts`, `server/src/jobs/*` |
| Live activity UI | Studio trace components | `components/chat/artifacts/SwarmTraceCard.tsx`, the studio `ActivityFeed` |
| Auth + RLS + Supabase | Platform backbone | `services/supabase.ts`, `server/src/middleware/auth.ts`, `server/sql/*_rls_*.sql` |

**Implication:** Autopilot is mostly *orchestration + state + governance* over assets that
already exist. The risky/expensive parts (sandboxed execution, billing, multi-model,
swarm) are done.

---

## 4. Target architecture

### 4.1 The loop (OODA over the existing build loop)

Autopilot's loop wraps the existing PLAN→ACT→RUN→OBSERVE→FIX **inside** a higher-level
governance loop:

```
   ┌──────────────────────────── ONE TICK (resumable, metered, logged) ───────────────────────────┐
   │                                                                                                │
   │  SENSE ──► ORIENT ──► DECIDE ──► ACT ──────────► VERIFY ──► SHIP ──────────► REFLECT ──► (next) │
   │   │          │          │         │                 │         │                 │              │
   │  signals   LLM:        gate:     run the          tests,    deploy via       append event,     │
   │  (errors,  assess vs   budget?   existing         build,    adapter          update goals,      │
   │  analytics,roadmap,    checkpoint Phase-4 build   preview   (managed or      cost, learnings    │
   │  backlog,  pick next   needed?    loop / swarm    health,   BYO); prod =      → sleep until      │
   │  health,   highest-    safe?      on the chosen   guardrail behind a          next tick/trigger  │
   │  feedback) value goal             goal            scan      checkpoint                           │
   │                                                                                                │
   │  GUARDS (apply at DECIDE + continuously): budget caps · checkpoint gates · no-progress detector │
   │  · max ticks/run · wall-clock per tick · global kill switch · concurrency cap                   │
   └────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **SENSE** — gather: open goals (backlog), last deploy health, runtime errors, uptime,
  basic analytics, and any user feedback/messages. (Epic A6 feeds this; until then SENSE =
  just the backlog + last run result.)
- **ORIENT** — an LLM call (cost-aware model, like the swarm planner) assesses venture
  state vs roadmap and proposes the next highest-value goal + a brief rationale. Updates
  goal priorities.
- **DECIDE** — pure, deterministic gate (no LLM): is there budget? does the chosen action
  require a checkpoint? is it within the venture's declared scope? If blocked → enqueue a
  checkpoint and pause; else proceed.
- **ACT** — run the existing agentic build loop / swarm code agent against the chosen goal,
  producing/modifying a `studio_project` (new `studio_version` on success).
- **VERIFY** — typecheck/build/tests + preview health (`verifyApp.ts`) + a **code-safety +
  secret scan** (Epic A9) before anything ships.
- **SHIP** — deploy via an adapter. Managed preview is automatic; **production deploys are
  gated by a checkpoint**.
- **REFLECT** — write a `venture_event` (what/why/cost/result), update `venture_goals`,
  record learnings, then sleep until the next tick or an external trigger (cron, webhook,
  user message).

### 4.2 Components

```
                ┌─────────────────────────────────────────────────────────────┐
                │  Operator Console (React)  — Epic A8                          │
                │  live status · roadmap board · approval queue · budget meter  │
                │  pause/resume/kill · logs · deployments · preview links       │
                └───────────────▲───────────────────────────────┬─────────────┘
                                │ /api/ventures/* (SSE + REST)   │
                ┌───────────────┴───────────────────────────────▼─────────────┐
                │  Control plane (Express, Railway) — Epic A1                   │
                │  ventures CRUD · goals · checkpoints · budgets · connections  │
                │  RLS owner-isolation · usageEnforcer hooks · audit events     │
                └───────────────▲───────────────────────────────┬─────────────┘
                                │ enqueue / status               │ read/write
                ┌───────────────┴───────────────┐   ┌────────────▼─────────────┐
                │  Ventures Worker — Epic A2     │   │  Supabase (Postgres)      │
                │  BullMQ repeatable scheduler   │   │  ventures, venture_goals, │
                │  runs the loop per active      │◄──┤  venture_runs,            │
                │  venture; crash-safe; bounded  │   │  venture_checkpoints,     │
                │  ticks; kill-switch aware      │   │  venture_budgets,         │
                └───┬───────────────┬───────────┘   │  venture_connections,     │
                    │ ACT/VERIFY    │ SHIP          │  venture_events +          │
        ┌───────────▼──────┐  ┌─────▼──────────┐    │  existing studio_* tables │
        │ Existing build   │  │ Deploy adapters│    └───────────────────────────┘
        │ loop + swarm     │  │ (A5): managed  │
        │ (Phase 4 / A4)   │  │ CF preview +   │    ┌───────────────────────────┐
        │ studio-worker    │  │ BYO via Nango  │───►│ User's / our cloud accounts│
        │ sandbox          │  │ CF/Vercel/etc. │    │ (Cloudflare/Vercel/Railway/│
        └──────────────────┘  └────────────────┘    │  Supabase)                 │
                                                     └───────────────────────────┘
```

### 4.3 Where the worker lives

Reuse the **BullMQ + ioredis** pattern from `server/src/comicforge/`. Add
`server/src/ventures/` with `queue.ts`, `scheduler.ts` (the repeatable tick driver), and
`tick.ts` (one tick). Run it as a separate process (a new `npm run ventures:worker`,
mirroring `comicforge:worker`), deployable as its own Railway service so the autonomous
loop never blocks the API. The actual code *execution* still happens in the existing
`studio-worker/` Cloudflare sandbox.

---

## 5. Security & multi-tenancy

This is the word that makes the vision real. Always-on agents writing and running code,
holding users' cloud credentials, deploying to the internet — get this wrong and it's a
breach or a runaway bill. **Non-negotiables:**

1. **Tenant isolation.** Every venture row + child row is RLS owner-isolated
   (`auth.uid() = user_id`), mirroring `server/sql/projects_rls_owner_isolation.sql`. The
   ventures worker uses a service identity but **always scopes queries by `venture_id` +
   `user_id`**; no cross-tenant reads.
2. **Sandboxed execution.** Generated code only ever runs in the per-tenant Cloudflare
   Container sandbox (already chosen), never in the API/worker process. One sandbox per
   `(user, project)` (`u_<userId>_<projectId>`), as today.
3. **Secret handling.** BYO provider credentials live in **Nango** (encrypted, never in our
   DB in plaintext, never in the client bundle). `venture_connections` stores only a Nango
   connection reference + metadata. Platform secrets stay in host env (Railway/CF), never
   committed (the repo already enforces "secrets never printed").
4. **Code-safety scan before ship.** Extend `server/src/ai/guardrails.ts`: scan generated
   diffs for committed secrets, obvious injection sinks, and dangerous ops (e.g. `rm -rf`,
   network exfiltration, `eval`) before VERIFY passes. Run `mcp__github__run_secret_scanning`
   / dependency audit on pushes.
5. **Egress & resource quotas.** Per-sandbox CPU/mem/time quotas + a wall-clock cap per
   tick. Egress is allowed (decided) but rate-limited; log outbound calls.
6. **Spend caps are a security control.** Budget breach = hard pause (Epic A0). A
   compromised or confused agent cannot exceed the cap.
7. **Global kill switch + concurrency cap.** A single flag pauses *all* ventures; a global
   max-concurrent-ticks protects the providers and our bill.
8. **Auditability.** `venture_events` is append-only; every decision, action, deploy, and
   dollar is recorded with the model + prompt hash, so any action is explainable and
   reversible.
9. **Least privilege for adapters.** Each adapter requests the **minimum** scopes; deploy
   tokens are per-venture, revocable, and never logged.
10. **Human gate on irreversibles.** Production deploys, spending money, buying domains,
    and destructive resource ops are **always** checkpoints (Epic A8), regardless of
    autonomy level.

> **Stance:** Autopilot is "secure by construction" — the brakes (Epic A0) and isolation
> ship *before* the autonomy (Epic A2). We never run the engine without the brakes.

---

## 6. Hosting model & deploy adapters

**Hybrid, in two phases:**

### Phase one — Managed (instant gratification, infra already live)
- Deploy previews to `*.dreamstreamstudio.ai` via the existing `studio-worker/` + wildcard
  DNS (already done per `OWNER-ACTIONS.md`). The "few clicks → it's live" wow.
- Strict per-venture quotas + budgets so managed hosting can't be abused.

### Phase two — Bring-your-own accounts (power + cost pass-through)
- User connects their own provider accounts via **Nango** (already wired) or PAT, stored as
  `venture_connections`. The user pays the provider directly; we bill only for the agent
  service.

### Adapter interface (Epic A5)
A single contract so the loop is provider-agnostic:

```ts
// server/src/ventures/adapters/types.ts
export interface DeployAdapter {
  id: 'cloudflare-pages' | 'cloudflare-workers' | 'vercel' | 'railway' | 'managed-preview';
  provision?(ctx: VentureCtx): Promise<ProvisionResult>;   // optional: DB/storage/etc.
  deploy(ctx: VentureCtx, build: BuildArtifact): Promise<DeployResult>; // → { url, status }
  status(ctx: VentureCtx, deploymentId: string): Promise<DeployResult>;
  rollback?(ctx: VentureCtx, deploymentId: string): Promise<void>;
}
```

- **managed-preview** — reuse `studio-worker/` (no creds needed).
- **cloudflare-pages / -workers** — `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (per
  `OWNER-ACTIONS.md` P1).
- **vercel** — `VERCEL_TOKEN`. **railway** — `RAILWAY_TOKEN`.
- **supabase (provision)** — Supabase Management token/OAuth for per-project DB/auth/storage.
- Results recorded in the existing `studio_deployments` table (+ a `venture_id` column).

Owner credentials/tokens needed for BYO are already enumerated in
[`../OWNER-ACTIONS.md`](../OWNER-ACTIONS.md) P1 — Autopilot makes them **per-venture
connections** instead of one global set.

---

## 7. Billing, budgets & the central portal

"One central payment portal that is our Code Studio" = extend what exists, don't rebuild.

- **Metering.** Every tick records token + compute (container-minutes) + managed-hosting
  cost via the existing `costEstimator.ts` → `billingLedger.ts` → `usageEnforcer.ts`,
  tagged with `venture_id`. Studio compute already flows through `studio_runs.cost_usd`;
  add the venture tag.
- **Budgets (`venture_budgets`).** Per-venture caps: `usd_per_day`, `usd_total`,
  `max_tokens`, `max_container_minutes`. The DECIDE gate reads these *before* spending; the
  REFLECT step updates spend; breach → pause + notify. (Epic A0 builds this first.)
- **Plans & credits.** Reuse `stripe.ts`, `stripePriceConfig.ts`, coupons, and the
  `token_ledger_entries` foundation. A venture draws from the user's credit balance / plan.
- **The portal (Epic A7 UI).** A "Code Studio → Billing" surface: per-venture spend, budget
  sliders, plan, credit top-up (Stripe Checkout), invoices, and a global spend alert.
- **Honest note.** In **managed** hosting we front provider cost → metering + caps are
  mandatory. In **BYO** the user pays providers directly → we only meter agent + our
  compute. The portal shows both clearly so there are no billing surprises.

---

## 8. Guardrails & checkpoints

The single most important design principle: **build the brakes before the engine** (Epic A0
precedes Epic A2).

**Always-on guards (deterministic, no LLM):**
- **Budget caps** (§7) — hard pause on breach.
- **Max ticks per run** + **wall-clock per tick** — no infinite loops.
- **No-progress detector** — same goal fails / same error repeats N times → pause + raise a
  checkpoint asking the user, instead of looping (reuse the Phase-4 "stuck" detector idea).
- **Global kill switch** — one flag halts every venture.
- **Concurrency cap** — global max concurrent ticks.
- **Scope guard** — ORIENT may not pursue goals outside the venture's approved spec without
  a checkpoint (prevents drift / runaway feature invention).

**Checkpoints (human-in-the-loop, always required regardless of autonomy level):**
1. **First production deploy** of a venture (and any custom-domain go-live).
2. **Spending real money** — paid provider resource, domain purchase, paid API beyond budget.
3. **Destructive operations** — deleting a DB/resource/deployment, dropping data.
4. **Publishing externally** — anything that puts the product/user's brand in public.
5. **Scope changes** — work materially outside the approved roadmap.
6. **Roadmap approval** — the initial roadmap (Epic A3) before autonomous work begins.

Checkpoints land in an **approval queue** in the Operator Console (Epic A8) and notify the
user (in-app + email via the Gmail tool / Stripe-style email). The venture stays paused on
that goal until approved/denied; everything else can continue if independent.

---

## 9. The Epic → Sprint backlog

Epics are sequenced **safety-first**. Each is a shippable increment with a checklist,
files to touch, acceptance criteria, and any owner action. Mark `[x]` as you ship. Keep
[`STATUS.md`](./STATUS.md) + [`../CHANGELOG.md`](../CHANGELOG.md) current after every epic
(mandatory per [`../AGENTS.md`](../AGENTS.md)).

> **Numbering:** the existing studio uses Phases 0–11. Autopilot uses the **A-series
> (A0–A9)** to avoid collision and signals "the autonomous layer."

---

### Epic A0 — Brakes first: budgets, kill-switch, checkpoints, audit
**Goal:** make autonomy *safe to turn on later* by shipping every governance primitive
before any loop exists. Everything is admin-only + flag-gated (`VENTURES_ENABLED=false`).

- [x] Migration `server/sql/ventures_foundation.sql`: tables `ventures`, `venture_budgets`,
      `venture_checkpoints`, `venture_events` (+ RLS owner-isolation mirroring
      `projects_rls_owner_isolation.sql`). ✅ shipped (apply via Supabase migration flow).
- [x] `server/src/ventures/budget.ts` — pure budget evaluator: given a venture + a proposed
      spend, return `allow | pause-budget`. Unit-tested. ✅ + `budgetAlertLevel` (80/100%).
- [x] `server/src/ventures/checkpoints.ts` — create/list/resolve checkpoints; the 6
      checkpoint types from §8. Unit-tested. ✅ (`checkpointForAction`, transitions, resolve).
- [x] `server/src/ventures/events.ts` — append-only event writer (what/why/cost/result +
      model). Unit-tested. ✅ (pure shaping + secret redaction; DB append lands in A1).
- [x] Global kill switch: `VENTURES_KILL=true` env + runtime override
      (`server/src/ventures/killSwitch.ts`); the future worker checks it every tick.
      (Admin route to flip it at runtime lands with the A1 control plane.)
- [ ] Wire metering tags: extend `costEstimator.ts`/`billingLedger.ts` calls to accept a
      `venture_id` tag (additive, no behavior change).
- [x] Feature flag `VENTURES_ENABLED` (default false) gating all of the above
      (`server/src/config.ts`), + `VENTURES_MAX_CONCURRENT_TICKS` + default budget caps.
- [x] Tests: budget breach + alert levels; checkpoint lifecycle; event append/redaction;
      kill switch honored. ✅ 35 unit tests, server+client typecheck green.

**Acceptance:** with `VENTURES_ENABLED=false` nothing changes for users; with it on (admin),
you can create a venture row, set a budget, raise/resolve a checkpoint, and read the audit
trail — but no autonomous work runs yet. Typecheck + server build + vitest green.

**Owner action:** none (admin-gated, no new accounts).

---

### Epic A1 — Venture control plane (data + API, no autonomy yet)
**Goal:** full CRUD + state for ventures, goals, runs, connections — the substrate the loop
will drive. Still no loop.

- [x] Migration `server/sql/ventures_control_plane.sql`: `venture_goals`, `venture_runs`,
      `venture_connections`; added `venture_id` to `studio_projects` + `studio_deployments`.
      RLS on all. ✅ **applied to the Comic Supabase project** (additive; existing data untouched).
- [x] Venture persistence repository — typed CRUD mirroring `studioRepository.ts` patterns,
      shipped as `server/src/ventures/repository.ts` (ventures + budgets + checkpoints + events:
      create/get/list/status, getBudget/upsertBudget/recordSpend, checkpoint create/list/
      approve-deny/expire, append/list events). Goals/runs/connections CRUD follow with their
      migration below.
- [x] `server/src/routes/ventures.ts` — `/api/ventures` (list/create/get), `/:id/status`,
      `/:id/goals`, `/:id/budget` (get/put), `/:id/checkpoints` (+ `/:cid/resolve`),
      `/:id/events`, `/:id/connections`, and admin `/admin/kill`. Mounted in `index.ts` after
      global `requireAuth`; flag-gated + admin-only until GA. ✅ shipped.
- [ ] Client API `services/venturesApi.ts` (mirror `studioApi.ts`) — pending (lands with A8 UI).
- [ ] Shared types in `apiTypes.ts` (Venture, VentureGoal, VentureRun, Checkpoint, Budget,
      Connection, VentureEvent) — pending (lands with A8 UI).
- [x] Tests: pure input validation (`ventures/validate.ts`, 14 tests) shipped. RLS-isolation +
      CRUD integration tests deferred to F5 (no integration harness yet).

**Acceptance:** an admin can fully manage a venture + its backlog + budget + connections
over the API, owner-isolated. No loop yet. Verify suite green.

**Owner action:** apply the two migrations (via existing Supabase migration flow).

---

### Epic A2 — The autonomous loop engine (bounded, crash-safe)
**Goal:** the heart — a repeatable scheduler that runs SENSE→…→REFLECT ticks per active
venture, governed by A0's brakes. Still building *nothing real* yet — ACT is a stub that
just logs — so we can prove the governance + durability in isolation.

- [x] `server/src/ventures/queue.ts` — guarded BullMQ queue (mirror `comicforge/queue.ts`),
      per-venture jobId de-dupe. ✅
- [x] `server/src/ventures/scheduler.ts` — fans out a tick per ACTIVE venture; respects
      `VENTURES_ENABLED` + kill switch + `VENTURES_MAX_CONCURRENT_TICKS`. ✅ (in-budget/checkpoint
      filtering happens inside the tick's DECIDE gate.)
- [x] `server/src/ventures/tick.ts` — one tick: SENSE (backlog) → ORIENT (deterministic
      priority pick for now; LLM goal-selection in A3/A4) → DECIDE (A0 gate) → **ACT (stub)** →
      REFLECT (event + goal update + metered spend). Durable-state resumable; no-progress
      detector → pause 'stuck'. Real-persistence adapter in `tickRunner.ts`. ✅ (wall-clock +
      max-ticks-per-run guards are an A2 follow-up.)
- [x] `npm run ventures:worker` script + separate process entry (`worker.ts`, mirrors
      `comicforge:worker`); deployable as its own Railway service. ✅
- [x] Tests: tick advances a goal; budget breach pauses (pre-spend); kill switch halts;
      no-progress → stuck; gated→approved→advances; priority selection. ✅ 9 DI tests (70 total).
      (Crash-resume is durable-by-construction; an integration test lands with F5.)

**Acceptance:** with the flag on, a seeded venture's backlog visibly advances tick-by-tick
(in `venture_events`/`venture_goals`), stops on budget/kill/stuck, and survives a worker
restart — **without building any code yet**. This de-risks the engine before wiring real
builds. Verify green.

**Owner action:** provision a Redis URL for the worker if not shared (`REDIS_URL`); add the
worker as a Railway service.

---

### Epic A3 — Intake → roadmap (idea → approved backlog)
**Goal:** the on-ramp. User describes a business/product idea; an agent produces a venture
spec + a structured roadmap (epics→features→tasks) the user **approves** (a checkpoint)
before any autonomous work.

- [x] `server/src/ventures/intake.ts` — LLM flow: idea → `{ name, summary, scope, goals[] }`,
      DI `complete` (mirrors `studioPlan.ts`), robust object extraction (prose/fence/nested-array
      safe). ✅
- [x] Route `POST /api/ventures/intake` (creates draft venture + default budget + goals +
      `roadmap_approval` checkpoint, status `roadmap_pending`) + `POST /:id/approve-roadmap`
      (resolves the roadmap checkpoint → flips to `active`). Reuses exported `studioStageComplete`. ✅
- [x] Scope guard wiring: approved `scope` stored on the venture; the DECIDE gate enforces
      `inScope` (scope_change checkpoint). (partial — plumbing done; LLM ORIENT scope-check is A4.)
- [ ] Client intake UI (a wizard) — pending (lands with A8 console).
- [x] Tests: intake parses a valid roadmap, retries on bad output, gives up gracefully; goals
      normalized; venture stays `roadmap_pending` until approved. ✅ 9 tests (79 total).

**Acceptance:** "Build me a habit-tracker SaaS with email reminders" → a reviewable roadmap
of concrete goals; approving it activates the venture and the A2 loop starts working it.
Verify green.

**Owner action:** none.

---

### Epic A4 — Wire ACT/VERIFY to the real build engine
**Goal:** replace A2's stub ACT with the **existing agentic build loop + swarm code agent**,
so ticks actually produce/modify code with real verification.

- [ ] In `tick.ts` ACT: dispatch the chosen goal to the Phase-4 build loop
      (`server/src/ai/studio/buildAgent.ts` / `studioGenerate.ts` / `studioFix.ts`) against
      the venture's `studio_project`; create a `studio_version` on success.
- [ ] VERIFY: run `verifyApp.ts` + build/typecheck + tests + the A9 code-safety scan
      (initially a basic secret/dangerous-op check; full scan in A9).
- [ ] Use the swarm's `code` agent for decomposition on larger goals (the PHASE-9
      integration item, now actually consumed).
- [ ] Minimal-diff iteration + per-goal iteration cap (reuse `buildGuards.ts`).
- [ ] Tests: a real goal (e.g. "add a landing page") yields a passing `studio_version`;
      a failing build triggers FIX within the cap then a checkpoint if stuck.

**Acceptance:** an approved venture autonomously builds its first few backlog goals into a
working `studio_project` with versions + metered cost, pausing if it gets stuck. Verify green.

**Owner action:** confirm `VITE_STUDIO_LIVE_ENABLED`/`STUDIO_WORKER_URL` (already on the
existing studio checklist) so the sandbox runs builds.

---

### Epic A5 — Deploy adapters (managed + BYO)
**Goal:** SHIP becomes real. Provider-agnostic deploy; managed previews automatic;
production behind a checkpoint; BYO accounts via Nango.

- [ ] `server/src/ventures/adapters/types.ts` (the interface in §6) + a registry.
- [ ] `adapters/managedPreview.ts` — wrap `studio-worker/` (no creds).
- [ ] `adapters/cloudflarePages.ts`, `vercel.ts`, `railway.ts` — BYO via
      `venture_connections` (Nango) / PAT; least-privilege scopes.
- [ ] `adapters/supabaseProvision.ts` — optional per-project DB/auth/storage provision.
- [ ] SHIP in `tick.ts`: managed preview auto; **prod deploy raises a checkpoint**; record
      `studio_deployments` (with `venture_id`); update `ventures.deploy_url`.
- [ ] Connection flow: `services/chatConnectors.ts` + Nango (`ai/tools/nango.ts`) → connect
      Cloudflare/Vercel/Railway/Supabase/GitHub; store reference in `venture_connections`.
- [ ] Tests: managed deploy returns a preview URL; prod deploy blocks on a checkpoint; BYO
      adapter selected when a connection exists; tokens never logged.

**Acceptance:** a venture ships to a managed preview automatically and, after the owner
approves the production checkpoint, deploys to the user's connected Cloudflare/Vercel/
Railway account. Verify green.

**Owner action:** per-venture — connect provider accounts (the P1 tokens from
`OWNER-ACTIONS.md`, now per-venture). Optionally set platform deploy tokens for managed mode.

---

### Epic A6 — Sense layer (close the iterate loop with real signal)
**Goal:** "never stop *iterating*" needs eyes. Feed real signals into SENSE so ORIENT
chooses improvements, not just the next backlog item.

- [ ] Deploy/uptime health check per live deployment (extend `verification/runner.ts`
      patterns); write results to `venture_events`.
- [ ] Runtime error ingestion: a tiny error-collector injected into deployed apps →
      `POST /api/ventures/:id/signals` (rate-limited, owner-scoped).
- [ ] Basic analytics + a feedback widget hook (page views / events) → signals.
- [ ] SENSE in `tick.ts` consumes signals → ORIENT can create *new* goals (bug fixes, perf,
      UX) — within scope, else a scope checkpoint.
- [ ] Tests: an injected error becomes a signal → ORIENT proposes a fix goal → loop fixes it.

**Acceptance:** a deployed venture that throws a runtime error gets a fix goal created and
shipped autonomously (within budget/checkpoints) — the visible "it keeps improving itself"
behavior. Verify green.

**Owner action:** none (managed); BYO analytics keys optional.

---

### Epic A7 — Central billing & budgets portal
**Goal:** the "one payment portal." Per-venture spend, budgets, credits, alerts — all
through Stripe + the existing ledger.

- [ ] Surface per-venture metering (tokens + compute + managed hosting) from
      `billingLedger`/`studio_runs` tagged by `venture_id`.
- [ ] Budget UI: sliders for `usd_per_day` / `usd_total` / token / minute caps → writes
      `venture_budgets`; live spend vs cap meter.
- [ ] Credits/top-up via Stripe Checkout (reuse `stripe.ts`, `stripePriceConfig.ts`); plan
      entitlements (reuse `rbac.ts`/`modelAccessPolicy.ts`).
- [ ] Spend alerts (80%/100% of cap) → notify (in-app + email).
- [ ] Reconciliation: extend `dailyBillingReconciliation.ts` to include venture compute.
- [ ] Tests: spend accrues per venture; hitting a cap pauses the venture + alerts; top-up
      raises the cap; reconciliation matches.

**Acceptance:** the owner sees exactly what each venture costs, sets a hard budget, tops up
credits, and gets alerted before overspend. Verify green.

**Owner action:** confirm Stripe product/price config for credits/plans (reuse existing).

---

### Epic A8 — Operator Console (the 24/7 workspace UI)
**Goal:** the user-facing cockpit. Watch agents work live, approve checkpoints, steer.

- [ ] Route + shell `components/ventures/` (reuse the studio's Linear/dark design system,
      `components/ui/*`, `lib/utils` `cn`).
- [ ] **Live activity stream** (reuse `ActivityFeed` + `SwarmTraceCard` patterns) over an
      SSE `/api/ventures/:id/stream` of `venture_events`.
- [ ] **Roadmap/backlog board** (goals by status) — drag to reprioritize (writes goals).
- [ ] **Approval queue** for checkpoints — approve/deny with one click + context.
- [ ] **Budget meter** + spend; **pause / resume / kill** controls (per venture + global).
- [ ] **Deployments** panel (preview/prod links, status, rollback) + **logs**.
- [ ] Venture list/dashboard; intake wizard (from A3); mobile-responsive.
- [ ] Tests + a Gallery demo entry (per `CLAUDE.md` rule) for any new artifact components.

**Acceptance:** from one screen the user creates a venture, approves its roadmap, watches it
build live, approves the prod deploy, sees spend, and can pause/kill — on desktop and
mobile. Verify green.

**Owner action:** none.

---

### Epic A9 — Multi-tenant security hardening & GA
**Goal:** earn the word "secure" and open the gate. Audit + harden everything before GA.

- [ ] Full **code-safety scan** before ship: committed-secret detection, dangerous-op
      patterns, dependency audit, `mcp__github__run_secret_scanning` on pushes (extend
      `guardrails.ts`).
- [ ] Tenant-isolation audit: prove no cross-venture data access (automated test +
      `get_advisors`); RLS coverage check across all `venture_*` + `studio_*` tables.
- [ ] Secret handling review: confirm BYO creds only in Nango; nothing sensitive in DB/logs/
      client.
- [ ] Rate limits + global concurrency caps + per-sandbox resource quotas verified under
      load (reuse `load-test-plan.md`).
- [ ] Abuse/anomaly detection: spend spikes, runaway loops, suspicious egress → auto-pause +
      alert.
- [ ] Incident runbook (`docs/studio/autopilot/INCIDENT-RUNBOOK.md`) + the global kill
      switch drill.
- [ ] GA gating: flip `VENTURES_ENABLED` from admin-only → plan-gated; go-live checklist
      (reuse `go-live-checklist.md`).
- [ ] Tests + a security review (`/security-review`) of the whole `venture_*` surface.

**Acceptance:** an external security pass finds no cross-tenant leak, no secret exposure, no
uncapped spend path; the kill switch works; GA gating is in place. Verify green +
security-review clean.

**Owner action:** review the security report + approve GA; provision any production secrets.

---

## 10. Milestones & sequencing

```
A0 brakes ─► A1 control plane ─► A2 loop engine (stub ACT)
                                      │
                                      ▼
                               A3 intake/roadmap ─► A4 real build (ACT/VERIFY)
                                      │
                                      ▼
                               A5 deploy adapters ─► A6 sense layer
                                      │
                                      ▼
                               A7 billing portal ─► A8 operator console ─► A9 hardening/GA
```

- **M-A1 — "Governed but idle":** A0–A2. Ventures + budgets + checkpoints + a *provably
  safe* loop that advances a backlog (stub builds). Proves the brakes before the engine.
- **M-A2 — "It builds itself, end to end":** A3–A5. Idea → roadmap → autonomous build →
  managed preview → (checkpointed) production deploy.
- **M-A3 — "It keeps improving":** A6. Real signals create fix/improve goals; the iterate
  loop closes.
- **M-A4 — "A product":** A7–A8. Central billing portal + the 24/7 operator console.
- **M-A5 — "Secure & GA":** A9. Hardened, audited, gated, launched.

**Rough effort (sequencing only, not commitments):** A0 ~2–3d · A1 ~2–3d · A2 ~1wk (the
durability/governance is the care) · A3 ~3–4d · A4 ~1wk (wiring + edge cases) · A5 ~1wk
(per-provider) · A6 ~4–5d · A7 ~4–5d · A8 ~1wk · A9 ~1wk. **Build A0→A2 first; do not skip
the brakes.**

---

## 11. Risks & honest caveats

- **"Never stop" literally is a trap.** Unbounded autonomy = runaway cost + thrash. The
  design is *continuous with hard budgets + checkpoints* (your chosen autonomy level). Truly
  ungoverned auto-build is intentionally **not** built. If you ever want "more autonomous,"
  it's a budget/checkpoint-policy change, not a rewrite.
- **Managed hosting = we carry cost/abuse risk.** That's why budgets + quotas + the kill
  switch are A0, not an afterthought. Keep managed previews quota-tight; push real
  production to BYO accounts.
- **LLMs are not reliable builders for arbitrary scope.** The realistic first scope (web
  apps / landing / simple SaaS) is where the existing build loop already works. Broad
  "any product" is a later expansion, not the MVP — matches your "generalize the studio"
  choice.
- **Self-hosting models stays out of scope** (per `01-VISION.md` — $10k–25k/mo per user).
  Autopilot uses API/BYOK models. Frontier coding models via BYOK/credits for hard goals.
- **Multi-tenant secrets are the sharpest edge.** Nango + RLS + least-privilege adapters +
  the A9 audit are the mitigation; treat A9 as a real gate, not a formality.
- **This is weeks of work, not a weekend** — but it's mostly orchestration over assets that
  already exist, and every epic is small, shippable, and reversible behind a flag.

---

## 12. Owner actions (consolidated)

Nothing below blocks Claude from building the *code*; these light up live behavior. Values
are set in host dashboards, never committed. (Cross-references existing
[`../OWNER-ACTIONS.md`](../OWNER-ACTIONS.md).)

| When | Action | Why |
|---|---|---|
| Before A1 | Apply `ventures_foundation.sql` + `ventures_control_plane.sql` migrations | Venture state + RLS |
| Before A2 | Ensure `REDIS_URL` for the ventures worker; add it as a Railway service | The autonomous scheduler |
| A4 | Confirm `VITE_STUDIO_LIVE_ENABLED` + `STUDIO_WORKER_URL` (already on studio checklist) | Real sandboxed builds |
| A5 (per venture, BYO) | Connect Cloudflare/Vercel/Railway/Supabase/GitHub (P1 tokens, now per-venture) | Deploy to user accounts |
| A5 (managed, optional) | Platform `CLOUDFLARE_API_TOKEN`/`VERCEL_TOKEN`/`RAILWAY_TOKEN` | Managed deploys |
| A7 | Confirm Stripe credit/plan price config (reuse existing) | Central billing portal |
| A9 | Review security report; approve GA; set production secrets | Safe launch |

**The product name in this plan is "Code Studio Autopilot" and the unit is a "Venture" —
say the word if you'd prefer different naming and I'll rename throughout.**
