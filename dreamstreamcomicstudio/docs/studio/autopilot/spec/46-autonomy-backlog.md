# 46 — Autonomy Backlog (A0–A9, Detailed)

> Part V · Delivery · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan §9 (the Epic → Sprint backlog A0–A9)](../00-MASTER-PLAN.md#9-the-epic--sprint-backlog) —
> **the source this section expands** · [Master Plan §10 milestones](../00-MASTER-PLAN.md#10-milestones--sequencing) ·
> [F-ENTERPRISE-FOUNDATIONS (F0–F10)](../F-ENTERPRISE-FOUNDATIONS.md) (the F-series prereqs) ·
> [§24 Autonomous engine](./24-autonomous-engine.md) · [§26 Data model & schema](./26-data-model-schema.md) ·
> [§31 Deploy adapters](./31-deploy-adapters.md) · [§14 Operator Console](./14-ux-operator-console.md) ·
> [§41 Billing & metering](./41-billing-metering.md) · [§45 Foundations backlog](./45-foundations-backlog.md)

## 46.1 What this section is, and how to read it

This is the **execution plan** for the autonomy layer (A0–A9). [Master Plan §9](../00-MASTER-PLAN.md#9-the-epic--sprint-backlog)
defines each epic's *intent*, checklist, acceptance, and owner action; this section takes that
source and expands every epic into **2–5 sprints** with a goal, an ordered, file-referenced task
checklist, dependencies (including the **F-series prereqs**), a rough effort, acceptance criteria,
owner actions, and the spec section that details each. Nothing here contradicts the Master Plan —
it adds the finer granularity an engineer schedules against.

Three rules govern this backlog, inherited from the canon:

1. **Brakes before the engine.** The sequencing is safety-first and non-negotiable:
   **A0 → A1 → A2**. Every governance primitive (budgets, kill switch, checkpoints, audit) ships
   and is tested *before* the first loop exists, and the loop runs with a **stub ACT** before it
   wires real builds (A4). The engine is "safe by construction" ([§24.1](./24-autonomous-engine.md)).
2. **F0 → F1 → F2 ship before A2 wires real autonomous builds.** You cannot run an always-on
   builder you can't observe (F0), on providers that fail silently (F1), with limits that don't
   hold across instances (F2) ([F-ENTERPRISE-FOUNDATIONS — revised sequencing](../F-ENTERPRISE-FOUNDATIONS.md#revised-sequencing--foundations-under-autonomy)).
   A0–A1 may proceed in parallel with F0–F2; **A4** is the hard gate that depends on them.
3. **Everything is flag-gated and reversible.** `VENTURES_ENABLED` (default `false`) gates the
   whole layer until A9 flips it to plan-gated; every sprint is additive and shippable behind the
   flag, so a half-built epic never breaks the live studio.

**Effort convention.** Efforts are **rough sizing for sequencing, not commitments** (Master Plan
§10). `1 SP ≈ 1 focused engineer-day`. Epic totals match the Master Plan's "rough effort" line
(A0 ~2–3d · A1 ~2–3d · A2 ~1wk · A3 ~3–4d · A4 ~1wk · A5 ~1wk · A6 ~4–5d · A7 ~4–5d · A8 ~1wk ·
A9 ~1wk).

**Milestones** (Master Plan §10): **M-A1** "governed but idle" (A0–A2) · **M-A2** "it builds
itself end to end" (A3–A5) · **M-A3** "it keeps improving" (A6) · **M-A4** "a product" (A7–A8) ·
**M-A5** "secure & GA" (A9).

---

## 46.2 Summary table — dependencies, F-prereqs, milestones

| Epic | Depends on | F-prereqs | Sprints | Effort | Milestone | Detailed in |
|---|---|---|---|---|---|---|
| **A0** Brakes first | — | F6 (migration runner, soft); F0 (`audit_log` shares writer) | A0.1–A0.3 | ~2–3d | M-A1 | [§24.7](./24-autonomous-engine.md), [§26.4–26.7](./26-data-model-schema.md), [§41](./41-billing-metering.md) |
| **A1** Control plane | A0 | F6 (migrations), F3 (sessions/step-up), F8 (zod) | A1.1–A1.3 | ~2–3d | M-A1 | [§26.8–26.10](./26-data-model-schema.md), [§27](./27-api-rest.md) |
| **A2** Loop engine (stub ACT) | A0, A1 | **F0, F1, F2** (hard before real builds at A4); F0 worker liveness | A2.1–A2.4 | ~1wk | M-A1 | [§24](./24-autonomous-engine.md), [§23](./23-cloudflare-topology.md) |
| **A3** Intake → roadmap | A1, A2 | F8 (intake idempotency/validation) | A3.1–A3.2 | ~3–4d | M-A2 | [§13](./13-ux-intake-onboarding.md), [§24.5](./24-autonomous-engine.md) |
| **A4** Wire ACT/VERIFY (real build) | A2, A3 | **F0, F1, F2** (hard); F5 (build E2E) | A4.1–A4.3 | ~1wk | M-A2 | [§24.6.3–24.6.4](./24-autonomous-engine.md), [§15](./15-ux-build-iterate-preview.md) |
| **A5** Deploy adapters | A4 | F10 (integration catalog), F3 (step-up on deploy) | A5.1–A5.4 | ~1wk | M-A2 | **[§31](./31-deploy-adapters.md)**, [§18](./18-ux-integrations.md) |
| **A6** Sense layer | A5 | F10 (inbound webhooks), F0 (signal metrics) | A6.1–A6.3 | ~4–5d | M-A3 | [§24.8](./24-autonomous-engine.md), [§28](./28-api-realtime-events.md) |
| **A7** Billing & budgets portal | A0, A1 (A5 for hosting cost) | F2 (idempotent billing), F3 (re-auth on spend) | A7.1–A7.3 | ~4–5d | M-A4 | **[§41](./41-billing-metering.md)**, [§17](./17-ux-billing-account.md), [§40](./40-cost-finops.md) |
| **A8** Operator Console | A1, A2, A5, A7 | F4 (real-time DO), F9 (design system) | A8.1–A8.4 | ~1wk | M-A4 | **[§14](./14-ux-operator-console.md)**, [§16](./16-ux-approvals-notifications.md), [§19](./19-mobile.md) |
| **A9** Security hardening & GA | **all (A0–A8)** | F5 (test gates), F8 (CI security), F6 (RLS-coverage gate) | A9.1–A9.4 | ~1wk | M-A5 | [§35](./35-security-threat-model.md), [§25](./25-multitenancy-isolation.md), [§24.11](./24-autonomous-engine.md) |

**Critical path:** `A0 → A1 → A2 → A4 → A5 → A6 → A8 → A9`. A3 forks off A2 and feeds A4; A7
forks off A0/A1 and rejoins at A8. The single most important arrow is **A0 → A2** (and within it
the *order* A0 then A1 then A2): the engine never runs without the brakes.

---

## 46.3 Epic A0 — Brakes first: budgets, kill-switch, checkpoints, audit

**Goal.** Make autonomy *safe to turn on later* by shipping every governance primitive **before any
loop exists**. Everything is admin-only and flag-gated (`VENTURES_ENABLED=false`). This epic is the
literal expression of "build the brakes before the engine" ([Master Plan §8](../00-MASTER-PLAN.md#8-guardrails--checkpoints),
[§24.7](./24-autonomous-engine.md)). Nothing here lets code run autonomously — it only lets a brake
*exist and be tested* in isolation.

**Depends on:** — (first epic). **F-prereqs:** F6 (the Supabase migration runner is the clean way
to land `ventures_foundation.sql`; if F6 lags, the file still ships under the existing by-hand
convention with `if not exists` idempotency). F0's `audit_log` writer is shared by the kill-switch
flip, so coordinate the writer signature with F0. **Effort:** ~2–3d (≈ 3 sprints, A0.1–A0.3).

### Sprint A0.1 — Schema + the spend brake (the budget evaluator)
- [ ] Write migration `server/sql/ventures_foundation.sql`: `ventures`, `venture_budgets`,
      `venture_checkpoints`, `venture_events`, with RLS owner-isolation mirroring
      `server/sql/projects_rls_owner_isolation.sql` — DDL exactly as [§26.4–26.7](./26-data-model-schema.md)
      (idempotent `create table if not exists` / `drop policy … create policy`).
- [ ] `server/src/ventures/budget.ts` — **pure** budget evaluator: given a venture + budget row +
      a proposed spend estimate, return `allow | pause-budget` (day cap, total cap, token cap,
      container-minute cap). No I/O, no LLM — the deterministic spend brake ([§24.6.1](./24-autonomous-engine.md) gate 1).
- [ ] `server/src/ventures/__tests__/budget.test.ts` — unit tests: under/at/over each cap; daily
      roll on `day_cycle_date` change; concurrent-tick double-spend guard (keyed update).

### Sprint A0.2 — Checkpoints + the audit event writer
- [ ] `server/src/ventures/checkpoints.ts` — create / list / resolve checkpoints for the **6 types**
      ([§24.6.2](./24-autonomous-engine.md): `roadmap_approval`, `first_production_deploy`,
      `spend_money`, `destructive_op`, `external_publish`, `scope_change`); `expires_at` TTL →
      `expired`. Resolving writes a `venture_events` row.
- [ ] `server/src/ventures/events.ts` — **append-only** event writer (`kind`, `summary`, `payload`,
      `cost_usd`, `model`, `prompt_hash`); never updates/deletes (the table has no UPDATE/DELETE RLS
      policy by design — [§26.7](./26-data-model-schema.md)).
- [ ] Unit tests: checkpoint lifecycle (open → approved/denied/expired); event append is monotonic;
      a resolution emits an audit event.

### Sprint A0.3 — Kill switch, metering tags, feature flag
- [ ] Global kill switch: `VENTURES_KILL=true` env + an **admin route** to flip it
      (`server/src/routes/venturesAdmin.ts`); the flip is recorded in `audit_log` (F0). The future
      worker must re-check it every tick ([§24.7](./24-autonomous-engine.md) "global kill switch").
- [ ] Wire metering tags: extend `server/src/services/costEstimator.ts` / `billingLedger.ts` call
      sites to accept an optional `venture_id` tag written into `token_ledger_entries.metadata`
      (additive, **no behavior change**, no ledger migration — [§26.3](./26-data-model-schema.md),
      [§41](./41-billing-metering.md)).
- [ ] Feature flag `VENTURES_ENABLED` (default `false`) gating all venture routes/services.
- [ ] Integration tests: budget breach pauses; checkpoint lifecycle; event append; kill switch
      honored by a stubbed "would-spend" call.

**Acceptance** (Master Plan A0): with `VENTURES_ENABLED=false` nothing changes for users; with it
on (admin), you can create a venture row, set a budget, raise/resolve a checkpoint, and read the
audit trail — **but no autonomous work runs**. Client typecheck + `build:server` + `vitest` green.

**Owner action:** none (admin-gated, no new accounts). *(Coordinate with F0 owner action — Sentry
DSN — only insofar as the kill-switch flip should appear in the audit log.)*

---

## 46.4 Epic A1 — Venture control plane (data + API, no autonomy yet)

**Goal.** Full CRUD + state for ventures, goals, runs, connections — the substrate the loop will
drive. **Still no loop.** This is the "venture-shaped" REST surface the Console (A8) and the engine
(A2) both depend on.

**Depends on:** A0 (the foundation tables + RLS pattern). **F-prereqs:** F6 (apply the migrations
through the ordered runner — [§26.13](./26-data-model-schema.md) M5/M6); F8 (zod body/query
validation, consistent error shapes — the new routes should be zod-first from day one); F3 (sessions
+ step-up; deploy/connection mutations later require a recent `step_up_at`). **Effort:** ~2–3d
(≈ 3 sprints, A1.1–A1.3).

### Sprint A1.1 — Control-plane schema + additive studio columns
- [ ] Write migration `server/sql/ventures_control_plane.sql`: `venture_goals`, `venture_runs`,
      `venture_connections` (+ RLS on all), and the **additive** alters — `studio_projects` gains
      `venture_id` + `version`; `studio_deployments` gains `venture_id`, `goal_id`, `is_production`,
      `adapter` — exactly as [§26.8–26.10, §26.3](./26-data-model-schema.md). Ordering: M5 before M6
      ([§26.13](./26-data-model-schema.md)).
- [ ] Indexes per [§26.12](./26-data-model-schema.md): `venture_goals (venture_id, status, priority)`
      (board + next-goal), partial `venture_runs … where ended_at is null`, partial active
      `venture_connections`.

### Sprint A1.2 — Repository + shared types
- [ ] `server/src/services/ventureRepository.ts` — typed CRUD for ventures/goals/runs/connections,
      mirroring `server/src/services/studioRepository.ts` patterns; service-role writes that
      **always scope by `(venture_id, user_id)`** ([§26.14](./26-data-model-schema.md) — no
      cross-tenant reads).
- [ ] Shared types in `apiTypes.ts`: `Venture`, `VentureGoal`, `VentureRun`, `Checkpoint`, `Budget`,
      `Connection`, `VentureEvent` (the contract for client + server, mirroring the studio types).

### Sprint A1.3 — REST routes + client API
- [ ] `server/src/routes/ventures.ts` — `/api/ventures` (list/create/get/update/delete),
      `/api/ventures/:id/goals`, `/checkpoints`, `/budget`, `/connections`, `/events`, `/runs`;
      auth + RLS + caps middleware; **zod-validated** bodies (F8). Detailed in [§27](./27-api-rest.md).
- [ ] Client `services/venturesApi.ts` (mirror `services/studioApi.ts`).
- [ ] Tests: route validation; **RLS isolation** (user A cannot read user B's venture — the
      seed test for the A9 audit); CRUD round-trips; budget/checkpoint sub-routes call into A0 logic.

**Acceptance** (Master Plan A1): an admin can fully manage a venture + backlog + budget +
connections over the API, owner-isolated; no loop yet. Verify suite green.

**Owner action:** apply the two migrations (`ventures_foundation.sql`, `ventures_control_plane.sql`)
via the F6 Supabase migration flow ([Master Plan §12](../00-MASTER-PLAN.md#12-owner-actions-consolidated)).

---

## 46.5 Epic A2 — The autonomous loop engine (bounded, crash-safe)

**Goal.** The heart: a repeatable scheduler that runs SENSE→…→REFLECT ticks per active venture,
governed by A0's brakes, **with a stub ACT** (it only logs) so we prove governance + durability in
isolation *before* wiring real builds. This is the contract [§24](./24-autonomous-engine.md) specs
in full; this epic builds it.

**Depends on:** A0 (brakes), A1 (control plane). **F-prereqs (the hard gate):** **F0** (observability
— you cannot run a 24/7 loop you can't see; worker/Redis liveness in the dashboard), **F1** (provider
reliability — ORIENT's cheap-model call and later ACT need pooling/breaker/failover), **F2**
(distributed correctness — shared Redis limits, the worker as its own process, idempotency keys).
A2 may build the *stub-ACT* loop while F0–F2 finish, but **A4 (real builds) must not start until
F0 → F1 → F2 ship** ([F-series hard rule](../F-ENTERPRISE-FOUNDATIONS.md#revised-sequencing--foundations-under-autonomy)).
**Effort:** ~1wk (≈ 4 sprints, A2.1–A2.4 — the durability/governance is the care).

### Sprint A2.1 — Queue + scheduler/heartbeat (the brakes wired into admission)
- [ ] `server/src/ventures/queue.ts` — BullMQ queue + repeatable job, mirroring
      `server/src/comicforge/queue.ts`.
- [ ] `server/src/ventures/scheduler.ts` — picks active, non-paused, in-budget ventures and enqueues
      a tick; **respects the kill switch + global concurrency cap + max-ticks-per-run** before
      admitting any tick ([§24.10.2](./24-autonomous-engine.md) heartbeat; [§24.7](./24-autonomous-engine.md) guards).
- [ ] `npm run ventures:worker` script + a separate process entry (`server/src/ventures/worker.ts`),
      mirroring `comicforge:worker`; deployable as its own Railway service (F2).

### Sprint A2.2 — The tick phase-ladder (SENSE→ORIENT→DECIDE→stub-ACT→REFLECT)
- [ ] `server/src/ventures/tick.ts` — the resumable phase ladder ([§24.3.2, §24.10.1](./24-autonomous-engine.md)):
      SENSE (backlog only for now), ORIENT (cheap-model goal pick via `server/src/ai/autoRouter.ts`
      `pickTextModel`, JSON-only via `ai/json.ts`/`jsonCoerce.ts` with heuristic fallback), DECIDE
      (calls A0's `budget.ts` + `checkpoints.ts` gates), **ACT (stub — logs only)**, VERIFY (skip),
      SHIP (skip), REFLECT (write event, advance goal).
- [ ] Durable **TickCursor** persisted after each phase ([§24.3.1, §24.9](./24-autonomous-engine.md));
      resume from `cursor.phase` on restart.

### Sprint A2.3 — The guards: no-progress, wall-clock, max-ticks, scope
- [ ] No-progress detector ([§24.7](./24-autonomous-engine.md)): same goal/error signature across
      ticks → block goal + raise a checkpoint, **do not retry** (the cross-tick promotion of the
      inner `buildGuards.ts` `stuck`).
- [ ] Wall-clock per-tick timeout (abort + persist cursor + resume next beat); max-ticks-per-run →
      complete the Run cleanly (`stop_reason:max-ticks`).
- [ ] Scope guard in DECIDE: out-of-scope goal → `scope_change` checkpoint (defense-in-depth with
      the ORIENT prompt — [§24.5.2](./24-autonomous-engine.md)).

### Sprint A2.4 — Crash-safety + tests
- [ ] Idempotency keys on tick writes ([§24.9](./24-autonomous-engine.md): at-most-once spend per
      `(run_id, tick_number, phase)`); per-venture serialization via BullMQ job lock (the transition
      realization of the DO single-threaded guarantee).
- [ ] Tests ([§24.12](./24-autonomous-engine.md)): a tick advances a goal; budget breach mid-run
      pauses; kill switch stops the scheduler; no-progress raises a checkpoint; **crash mid-tick
      resumes cleanly with no double-spend**.

**Acceptance** (Master Plan A2): with the flag on, a seeded venture's backlog visibly advances
tick-by-tick (in `venture_events`/`venture_goals`), stops on budget/kill/stuck, and survives a
worker restart — **without building any code yet**. Verify green.

**Owner action:** provision a Redis URL for the worker if not shared (`REDIS_URL`); add the ventures
worker as a separate Railway service (F2 owner action).

---

## 46.6 Epic A3 — Intake → roadmap (idea → approved backlog)

**Goal.** The on-ramp. The user describes a business/product idea; an agent produces a venture spec
+ a structured roadmap (epics→features→tasks) the user **approves** (the `roadmap_approval`
checkpoint) before any autonomous work begins.

**Depends on:** A1 (the venture + goals substrate), A2 (the loop that consumes the approved roadmap).
**F-prereqs:** F8 (intake is a mutating route — idempotency key + zod validation so a double-submit
doesn't double-create a venture). **Effort:** ~3–4d (≈ 2 sprints, A3.1–A3.2).

### Sprint A3.1 — The intake → roadmap flow + scope storage
- [ ] `server/src/ventures/intake.ts` — LLM flow: idea → `{ name, summary, scope, success_metrics,
      roadmap: VentureGoal[] }`, reusing `server/src/ai/studio/studioPlan.ts` patterns + the swarm
      planner; JSON-validated (`ai/json.ts`, `jsonCoerce.ts`).
- [ ] Store the approved `scope` on the venture so the **scope guard** ([§24.5](./24-autonomous-engine.md))
      can enforce it; ORIENT must stay within it or raise a `scope_change` checkpoint.
- [ ] Tests: intake produces a valid, dependency-consistent roadmap; idempotent on resubmit.

### Sprint A3.2 — Routes + the intake wizard (minimal)
- [ ] Routes: `POST /api/ventures/intake` (creates a `draft` venture + roadmap), `POST
      /api/ventures/:id/approve-roadmap` (resolves the `roadmap_approval` checkpoint → flips
      `status` to `active` → the A2 loop starts working it). Detailed in [§13](./13-ux-intake-onboarding.md).
- [ ] Client intake wizard — minimal for now (full console UI is A8); reuses the studio dark
      design system. Wizard prefill from `user_settings.default_*` ([§26.11](./26-data-model-schema.md)).
- [ ] Tests: venture stays `draft`/`roadmap_pending` until approved; approval activates + the
      scheduler picks it up.

**Acceptance** (Master Plan A3): "Build me a habit-tracker SaaS with email reminders" → a reviewable
roadmap of concrete goals; approving it activates the venture and the A2 loop starts. Verify green.

**Owner action:** none.

---

## 46.7 Epic A4 — Wire ACT/VERIFY to the real build engine

**Goal.** Replace A2's stub ACT with the **existing agentic build loop + swarm code agent** so ticks
actually produce/modify code with real verification. This is where "always-on" stops being a demo
and starts building software ([§24.6.3–24.6.4](./24-autonomous-engine.md)).

**Depends on:** A2 (the loop + stub ACT to replace), A3 (an approved roadmap to build). **F-prereqs
(hard):** **F0/F1/F2** must be shipped — this is the exact line the F-series draws ("F0 → F1 → F2
ship before A2 wires real autonomous builds"). F5 (build E2E happy-path) lands the regression net.
**Effort:** ~1wk (≈ 3 sprints, A4.1–A4.3 — wiring + edge cases).

### Sprint A4.1 — ACT dispatches to the inner build loop
- [ ] In `tick.ts` ACT: dispatch the chosen goal to the Phase-4 build loop —
      `server/src/ai/studio/buildAgent.ts` (`runBuildAgent`), `studioGenerate.ts`, `studioFix.ts` —
      against the venture's `studio_project`; create a `studio_version` on a clean build
      ([§24.4.3](./24-autonomous-engine.md)).
- [ ] Per-goal iteration cap + minimal-diff iteration via `server/src/ai/studio/buildGuards.ts`;
      promote the inner `stuck` result to the outer no-progress detector ([§24.7](./24-autonomous-engine.md)).

### Sprint A4.2 — VERIFY (typecheck/build/tests/health + basic safety scan)
- [ ] VERIFY in `tick.ts`: `server/src/ai/studio/verifyApp.ts` + build/typecheck + tests + preview
      health probe (`observation.ts`), then a **basic** code-safety/secret scan (extend
      `server/src/ai/guardrails.ts`; the full scan is A9) — all sub-checks must pass before SHIP
      ([§24.6.4](./24-autonomous-engine.md)). A detected committed secret is a **hard** block.
- [ ] FIX-within-budget loop on VERIFY failure (bounded by the iteration cap); past the cap → fail
      the goal or raise a checkpoint if stuck.

### Sprint A4.3 — Swarm decomposition for larger goals + tests
- [ ] Route larger / multi-component goals through the swarm `code` agent
      (`server/src/ai/agents/orchestrator.ts`) which decomposes before driving the same build loop
      (the PHASE-9 integration, now consumed — [§24.4.3](./24-autonomous-engine.md)).
- [ ] Tests ([§24.12](./24-autonomous-engine.md) #4): a real goal (e.g. "add a landing page") yields
      a passing `studio_version` with metered cost; a failing build triggers FIX within the cap then
      a checkpoint if stuck.

**Acceptance** (Master Plan A4): an approved venture autonomously builds its first few backlog goals
into a working `studio_project` with versions + metered cost, pausing if it gets stuck. Verify green.

**Owner action:** confirm `VITE_STUDIO_LIVE_ENABLED` + `STUDIO_WORKER_URL` (already on the studio
checklist) so the sandbox runs builds.

---

## 46.8 Epic A5 — Deploy adapters (managed + BYO)

**Goal.** SHIP becomes real. A provider-agnostic deploy contract: managed previews automatic,
production behind a checkpoint, BYO accounts via Nango. Fully specced in **[§31](./31-deploy-adapters.md)**;
this epic builds it.

**Depends on:** A4 (a verified build to ship). **F-prereqs:** F10 (the unified integration catalog +
connection-state/expiry the connect flow surfaces), F3 (step-up re-auth on the deploy mutation).
**Effort:** ~1wk (≈ 4 sprints, A5.1–A5.4 — per-provider work). Maps item-for-item to [§31.10](./31-deploy-adapters.md#3110-mapping-to-epic-a5).

### Sprint A5.1 — The interface, registry, and managed preview
- [ ] `server/src/ventures/adapters/types.ts` — the `DeployAdapter` interface (`id`, `supports`,
      `provision?`, `deploy`, `status`, `rollback?`, `requiredScopes`) exactly as [§31.2](./31-deploy-adapters.md#312-the-deployadapter-interface);
      **no secret crosses it** (`VentureCtx.connection` is a `ConnectionRef`, never a token).
- [ ] `server/src/ventures/adapters/registry.ts` — `getAdapter` / `resolveTarget` ([§31.3](./31-deploy-adapters.md#313-the-adapter-registry)).
- [ ] `server/src/ventures/adapters/managedPreview.ts` — wrap the **shipped** `studio-worker/`
      substrate (no creds) ([§31.5.1](./31-deploy-adapters.md#3151-managed-preview-no-creds)).

### Sprint A5.2 — SHIP wired into the tick (managed auto; prod checkpoint-gated)
- [ ] SHIP in `tick.ts`: build artifact → `resolveTarget` → **managed preview auto**; **prod deploy
      raises a `first_production_deploy` checkpoint** in the deterministic DECIDE path; record
      `studio_deployments` (with `venture_id`, `goal_id`, `is_production`, `adapter`); update
      `ventures.deploy_url` ([§31.4.1–31.4.2](./31-deploy-adapters.md#314-the-deploy-pipeline)).
- [ ] Replay-safe idempotency on `(venture_id, idempotency_key)` ([§31.4.3](./31-deploy-adapters.md#3143-idempotency-versioned-records--metering)).
- [ ] Tests: managed deploy returns a preview URL; prod deploy blocks on a checkpoint.

### Sprint A5.3 — BYO adapters (Cloudflare / Vercel / Railway) + connection flow
- [ ] `adapters/cloudflarePages.ts`, `cloudflareWorkers.ts`, `vercel.ts`, `railway.ts` — BYO via
      `venture_connections` (Nango) / PAT, **least-privilege scopes** per the [§31.5 capability
      matrix](./31-deploy-adapters.md#3157-adapter-capability-matrix).
- [ ] Connection flow: `services/chatConnectors.ts` + `server/src/ai/tools/nango.ts` → connect
      Cloudflare/Vercel/Railway/Supabase/GitHub; store **reference only** in `venture_connections`
      ([§31.7](./31-deploy-adapters.md#317-security--tokens-never-logged-scoped-revocable), [§18.4](./18-ux-integrations.md)).
- [ ] Tests: BYO adapter selected when a connection exists; **tokens never logged** (the hard A5
      gate); 401/403 → Reconnect checkpoint.

### Sprint A5.4 — Supabase provision + rollback + health verify
- [ ] `adapters/supabaseProvision.ts` — optional per-project DB/auth/storage provision; keys land in
      Nango, never our DB; any data-dropping op is a `destructive_op` checkpoint
      ([§31.5.6](./31-deploy-adapters.md#3156-supabase-provision)).
- [ ] `rollback` for versioned providers (CF/Vercel/Railway re-point alias; Supabase branches) +
      post-deploy **health verification** (provider `status()` + HTTP probe → feeds A6 SENSE —
      [§31.6](./31-deploy-adapters.md#316-health-verification-post-deploy-feeds-a6)).
- [ ] Tests: rollback re-points alias; destructive rollback blocked without an approved checkpoint;
      a degraded deploy writes a signal.

**Acceptance** (Master Plan A5): a venture ships to a managed preview automatically and, after the
owner approves the production checkpoint, deploys to the user's connected Cloudflare/Vercel/Railway
account. Verify green.

**Owner action:** per-venture (BYO) — connect provider accounts (the P1 tokens from
[`../OWNER-ACTIONS.md`](../OWNER-ACTIONS.md), now per-venture). Optionally set platform deploy
tokens for managed mode.

---

## 46.9 Epic A6 — Sense layer (close the iterate loop with real signal)

**Goal.** "Never stop *iterating*" needs eyes. Feed real signals into SENSE so ORIENT chooses
improvements, not just the next backlog item — the visible "it keeps improving itself" behavior
([§24.8](./24-autonomous-engine.md)).

**Depends on:** A5 (a live deployment to observe). **F-prereqs:** F10 (inbound webhooks → events
feed SENSE), F0 (signal metrics + the dashboard). **Effort:** ~4–5d (≈ 3 sprints, A6.1–A6.3).

### Sprint A6.1 — Deploy/uptime health → signals
- [ ] Per-live-deployment health check, extending `server/src/verification/runner.ts` patterns;
      write results to `venture_events`; degraded → a fix-goal signal ([§31.6](./31-deploy-adapters.md#316-health-verification-post-deploy-feeds-a6), [§24.8](./24-autonomous-engine.md)).

### Sprint A6.2 — Runtime error + analytics ingestion
- [ ] Tiny error-collector injected into deployed apps → `POST /api/ventures/:id/signals`
      (rate-limited, owner-scoped — [§28](./28-api-realtime-events.md)).
- [ ] Basic analytics + feedback-widget hook (page views / events) → signals; F10 inbound webhooks
      route external events into the same signal pipe.

### Sprint A6.3 — SENSE consumes signals; ORIENT proposes in-scope goals
- [ ] SENSE in `tick.ts` consumes the signals digest → ORIENT may create **new** goals (bug fixes,
      perf, UX) **within scope**, else a `scope_change` checkpoint ([§24.5.1, §24.8](./24-autonomous-engine.md)).
- [ ] Tests ([§24.12](./24-autonomous-engine.md) #8): an injected runtime error becomes a signal →
      ORIENT proposes a fix goal → the loop ships the fix (within budget/checkpoints).

**Acceptance** (Master Plan A6): a deployed venture that throws a runtime error gets a fix goal
created and shipped autonomously — the iterate loop closes. Verify green.

**Owner action:** none (managed); BYO analytics keys optional.

---

## 46.10 Epic A7 — Central billing & budgets portal

**Goal.** The "one payment portal." Per-venture spend, budgets, credits, alerts — all through Stripe
+ the existing ledger. Detailed in **[§41](./41-billing-metering.md)** + [§17](./17-ux-billing-account.md);
the FinOps model is [§40](./40-cost-finops.md).

**Depends on:** A0 (`venture_budgets`), A1 (control plane); A5 for managed-hosting cost surfacing.
**F-prereqs:** F2 (idempotent billing/top-up routes — a replayed Checkout is a no-op), F3 (re-auth /
step-up on spend). **Effort:** ~4–5d (≈ 3 sprints, A7.1–A7.3).

### Sprint A7.1 — Per-venture metering surface + budget UI
- [ ] Surface per-venture metering (tokens + compute + managed hosting) from `billingLedger` /
      `studio_runs` tagged by `venture_id` (the A0 tag — [§26.3](./26-data-model-schema.md), [§41](./41-billing-metering.md)).
- [ ] Budget UI: sliders for `usd_per_day` / `usd_total` / token / minute caps → write
      `venture_budgets`; live **spend-vs-cap meter** ([§17](./17-ux-billing-account.md)).

### Sprint A7.2 — Credits, plans, Stripe top-up
- [ ] Credits/top-up via Stripe Checkout, reusing `server/src/services/stripe.ts` +
      `stripePriceConfig.ts`; plan entitlements via `rbac.ts` / `modelAccessPolicy.ts`. Idempotent
      (F2).

### Sprint A7.3 — Spend alerts + reconciliation
- [ ] Spend alerts at 80%/100% of cap → notify in-app + email (dedupe via
      `venture_budgets.alert_80_sent_at` — [§26.5](./26-data-model-schema.md)); honor
      `user_settings.notify_*`.
- [ ] Extend `dailyBillingReconciliation.ts` to include venture compute; reconcile ledger vs budget
      counters ([§41](./41-billing-metering.md)).
- [ ] Tests: spend accrues per venture; hitting a cap **pauses the venture + alerts** (the brake);
      top-up raises the cap; reconciliation matches.

**Acceptance** (Master Plan A7): the owner sees exactly what each venture costs, sets a hard budget,
tops up credits, and is alerted before overspend. Verify green.

**Owner action:** confirm Stripe product/price config for credits/plans (reuse existing).

---

## 46.11 Epic A8 — Operator Console (the 24/7 workspace UI)

**Goal.** The user-facing cockpit. Watch agents work live, approve checkpoints, steer or stop.
Fully specced in **[§14](./14-ux-operator-console.md)** (+ approvals [§16](./16-ux-approvals-notifications.md),
mobile [§19](./19-mobile.md)). Per [§14.1](./14-ux-operator-console.md), **A8 is mostly presentation
and real-time plumbing over governance state that already exists** — if A0–A7 are right, this is the
easy part.

**Depends on:** A1 (CRUD), A2 (events to stream), A5 (deployments panel), A7 (budget meter).
**F-prereqs:** F4 (real-time Durable Object — the live stream + instant pause/kill push), F9 (design
system — `components/ui/*`, single token source). **Effort:** ~1wk (≈ 4 sprints, A8.1–A8.4).

### Sprint A8.1 — Shell + live activity stream
- [ ] Route + shell under `components/ventures/` reusing the studio Linear/dark design system
      (`components/ui/*`, `lib/utils` `cn`) ([§14.2](./14-ux-operator-console.md)).
- [ ] **Live activity stream** reusing `ActivityFeed` + `SwarmTraceCard` patterns over an SSE
      `/api/ventures/:id/stream` of `venture_events` ([§28](./28-api-realtime-events.md); F4 upgrades
      SSE → DO WebSocket).

### Sprint A8.2 — Roadmap board + approval queue
- [ ] **Roadmap/backlog board** (goals by status) — drag to reprioritize (writes goals via A1)
      ([§14](./14-ux-operator-console.md)).
- [ ] **Approval queue** for `open` checkpoints — approve/deny with one click + context
      ([§16](./16-ux-approvals-notifications.md); the partial `open` index is the query — [§26.6](./26-data-model-schema.md)).

### Sprint A8.3 — Budget meter, controls, deployments, logs
- [ ] **Budget meter** + spend; **pause / resume / kill** controls (per venture + the global kill
      switch from A0) ([§14](./14-ux-operator-console.md)).
- [ ] **Deployments** panel (preview/prod links, status, rollback via A5 adapter `supports`) + logs
      ([§31.3](./31-deploy-adapters.md#313-the-adapter-registry) capability-driven UI).

### Sprint A8.4 — Dashboard, wizard, mobile, gallery
- [ ] Venture list/dashboard; the A3 intake wizard integrated; **mobile-responsive** ([§19](./19-mobile.md)).
- [ ] Tests + a **Gallery demo entry** for any new artifact components (mandatory per `CLAUDE.md`:
      declare type in `apiTypes.ts` → register in `ChatArtifacts.tsx` → add to `GALLERY_DEMOS` in
      `ComponentGallery.tsx`; enforced by `gallery.coverage.test.ts`).

**Acceptance** (Master Plan A8): from one screen the user creates a venture, approves its roadmap,
watches it build live, approves the prod deploy, sees spend, and can pause/kill — desktop and mobile.
Verify green.

**Owner action:** none.

---

## 46.12 Epic A9 — Multi-tenant security hardening & GA

**Goal.** Earn the word "secure" and open the gate. Audit + harden everything before GA. This is the
real gate, not a formality ([Master Plan §11](../00-MASTER-PLAN.md#11-risks--honest-caveats),
[§35 threat model](./35-security-threat-model.md), [§25 multi-tenancy](./25-multitenancy-isolation.md)).

**Depends on:** **all of A0–A8** (you cannot harden what isn't built). **F-prereqs:** F5 (test gates
— integration/E2E/coverage), F8 (CI security — dependency/secret scanning, zod, no default-admin),
F6 (RLS-coverage CI gate). **Effort:** ~1wk (≈ 4 sprints, A9.1–A9.4).

### Sprint A9.1 — Full code-safety scan before ship
- [ ] Full code-safety scan in VERIFY: committed-secret detection, dangerous-op patterns
      (`rm -rf`/`eval`/exfiltration), dependency audit, `mcp__github__run_secret_scanning` on pushes
      (extend `server/src/ai/guardrails.ts`) ([§24.6.4, §24.11](./24-autonomous-engine.md) #8).

### Sprint A9.2 — Tenant-isolation + secret-handling audit
- [ ] Tenant-isolation audit: automated test proving **no cross-venture access** + Supabase
      `get_advisors`; RLS-coverage check across all `venture_*` + `studio_*` tables (F6 gate)
      ([§26.14](./26-data-model-schema.md), [§25](./25-multitenancy-isolation.md)).
- [ ] Secret-handling review: BYO creds only in Nango; nothing sensitive in DB/logs/client
      ([§31.7](./31-deploy-adapters.md#317-security--tokens-never-logged-scoped-revocable)).

### Sprint A9.3 — Quotas under load + abuse/anomaly detection
- [ ] Rate limits + global concurrency caps + per-sandbox resource quotas verified under load
      (reuse `docs/production/load-test-plan.md` via F5's k6).
- [ ] Abuse/anomaly detection: spend spikes, runaway loops, suspicious egress → **auto-pause +
      alert** ([§24.11](./24-autonomous-engine.md) #5).

### Sprint A9.4 — Incident runbook, kill-switch drill, GA gating
- [ ] Incident runbook (`docs/studio/autopilot/INCIDENT-RUNBOOK.md`) + a global **kill-switch drill**.
- [ ] GA gating: flip `VENTURES_ENABLED` from admin-only → plan-gated; go-live checklist (reuse
      `docs/production/go-live-checklist.md`).
- [ ] Tests + a `/security-review` of the whole `venture_*` surface.

**Acceptance** (Master Plan A9): an external security pass finds no cross-tenant leak, no secret
exposure, no uncapped spend path; the kill switch works; GA gating is in place. Verify green +
security-review clean.

**Owner action:** review the security report; approve GA; provision any production secrets.

---

## 46.13 Sequencing, the F-series gate, and milestone roll-up

The dependency graph (Master Plan §10), annotated with the F-series gate:

```
  F0 observability ─┐
  F1 provider reliab.─┼─► (SEE + TRUST the platform)   ◄── HARD GATE before A4 real builds
  F2 distributed corr.┘
        │
  A0 brakes ─► A1 control plane ─► A2 loop engine (stub ACT)     ──► M-A1 "governed but idle"
                                        │
                                        ▼
                                 A3 intake/roadmap ─► A4 real build (needs F0/F1/F2)
                                        │
                                        ▼
                                 A5 deploy adapters ─► A6 sense layer (+F10)   ──► M-A2 / M-A3
                                        │
                                        ▼
                                 A7 billing portal ─► A8 console (+F4/F9) ─► A9 hardening/GA
                                                                              └► M-A4 / M-A5
```

| Milestone | Epics | One-line proof | Gating F-work landed |
|---|---|---|---|
| **M-A1** Governed but idle | A0–A2 | Backlog advances tick-by-tick (stub builds), stops on budget/kill/stuck, survives restart | F6 (migrations) |
| **M-A2** It builds itself, end to end | A3–A5 | Idea → roadmap → autonomous build → managed preview → (checkpointed) prod deploy | **F0/F1/F2** (before A4), F10, F3 |
| **M-A3** It keeps improving | A6 | A deployed venture self-heals a runtime error within budget | F10 webhooks |
| **M-A4** A product | A7–A8 | Central billing portal + the 24/7 operator console | F4 (real-time), F9 (design) |
| **M-A5** Secure & GA | A9 | No cross-tenant leak / secret exposure / uncapped spend; kill switch works; GA gated | F5, F8, F6 |

**The standing reminder, restated.** Brakes before the engine: **A0 → A1 → A2**, then the engine
runs with a *stub ACT* before A4 wires real builds, and A4 does not start until **F0 → F1 → F2** are
shipped. The brakes (A0), the durable cursor, RLS isolation, and the deterministic DECIDE gate are
the difference between an always-on enterprise product and a runaway script
([§24 stance](./24-autonomous-engine.md)).

## 46.14 Acceptance criteria (this section)

- Every epic **A0–A9** is expanded into **2–5 sprints** with a goal, an ordered file-referenced task
  checklist, dependencies (incl. F-series prereqs), a rough effort, acceptance criteria, owner
  actions, and the spec section that details it.
- The plan is **consistent with [Master Plan §9/§10](../00-MASTER-PLAN.md#9-the-epic--sprint-backlog)**:
  epic goals, acceptance lines, owner actions, and per-epic efforts match; this section only adds
  finer granularity.
- **Brakes-before-engine** (A0 → A1 → A2) and the **F0 → F1 → F2 before A4** hard gate are stated
  and reflected in the dependency graph and the summary table.
- File references point at concrete artifacts under `server/src/ventures/*`,
  `server/sql/ventures_*.sql`, `server/src/routes/*`, `server/src/services/*`, and
  `components/ventures/*`, matching [§24](./24-autonomous-engine.md)/[§26](./26-data-model-schema.md)/[§31](./31-deploy-adapters.md).
- The **summary table** (epic | depends-on | F-prereqs | sprints | effort | milestone | detailed-in)
  and the **milestone roll-up** (M-A1..M-A5) are present and internally consistent.
