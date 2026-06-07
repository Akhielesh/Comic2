# 09 — Domain Model & Glossary

> Part II · Product Definition · Canon: [SPEC-INDEX](../SPEC-INDEX.md)

## 9.1 How to read this

This section defines the **conceptual** domain — the entities Autopilot reasons about, how they
relate, and the state machines that govern their lifecycles. It is the shared vocabulary for every
other section: when section 14 says "the Operator Console shows the approval queue," *queue* means
the set of **Checkpoint** entities in the `open` state. When section 24 says "the loop advances a
goal," *goal* and *advance* are defined here.

Two honesty notes set the frame:

1. **This extends, it does not replace.** The existing studio model (`studio_projects`,
   `studio_files`, `studio_versions`, `studio_runs`, `studio_deployments` — see
   [`../../06-DATA-MODEL.md`](../../06-DATA-MODEL.md)) is the durable codebase substrate and is
   **reused as-is**. Autopilot adds a *governance and orchestration* layer **above** it
   (`ventures`, `venture_goals`, `venture_runs`, `venture_checkpoints`, `venture_budgets`,
   `venture_connections`, `venture_events`). A **Venture HAS one or more `studio_projects`**; it
   never re-implements them.
2. **Conceptual, not SQL.** Key attributes here are described in business terms. The full schema,
   column types, indexes, and RLS policies live in
   [section 26 — Data model & schema](./26-data-model-schema.md). Where an attribute maps to an
   existing studio column it is noted, so 26 stays consistent with reality.

Some entities are **logical** (no dedicated table of their own): a **Tick** is a logical unit
recorded as a span of `venture_events` within a Run; an **Adapter** is a code interface, not a row;
a **Deployment** reuses `studio_deployments` with a `venture_id` tag. These distinctions matter for
26 and are flagged per entity.

---

## 9.2 Entity-relationship overview

```
                         ┌──────────────┐
                         │     User     │  auth.users — the tenant boundary (RLS anchor)
                         └──────┬───────┘
            owns 1:N            │ user_id on every root row
        ┌────────────────────────────────────────────────────────┐
        ▼                                                          ▼
  ┌──────────────┐                                          ┌──────────────┐
  │  Connection  │  BYO provider account (Nango ref)        │   Venture    │  the product the
  │ (venture_    │◄──── used by ────┐                        │  (ventures)  │  agents own
  │ connections) │                  │            owns 1:N    └──────┬───────┘
  └──────────────┘                  │     ┌──────────────┬─────────┼──────────┬───────────────┐
                                    │     ▼              ▼         ▼          ▼               ▼
                              ┌─────┴────┐ ┌──────────┐ ┌────────┐ ┌────────┐ ┌──────────┐ ┌──────────────┐
                              │ Adapter  │ │   Goal   │ │ Budget │ │  Run   │ │  Event   │ │studio_project│
                              │(interface│ │(venture_ │ │(venture│ │(venture│ │(venture_ │ │  (existing,  │
                              │ ,code)   │ │ goals)   │ │_budgets│ │ _runs) │ │ events)  │ │  +venture_id)│
                              └────┬─────┘ └────┬─────┘ └────────┘ └───┬────┘ └────▲─────┘ └──────┬───────┘
                                   │ deploy()   │ 1:N               1:N│  contains │ appends      │ HAS 1:N
                                   ▼            ▼                      ▼           │              ▼
                              ┌──────────┐ ┌────────────┐        ┌────────┐       │      ┌──────────────────┐
                              │Deployment│ │ Checkpoint │        │  Tick  │───────┘      │ studio_files /   │
                              │(studio_  │ │ (venture_  │        │(logical│  every       │ studio_versions /│
                              │deploy-   │ │checkpoints)│        │ ; event│  decision,   │ studio_runs /    │
                              │ments     │◄┘ blocks a   │        │ span)  │  action,     │ studio_deploy-   │
                              │+venture_ │  Goal/Run    │        └────────┘  dollar      │ ments (existing) │
                              │ id)      │              │                                └──────────────────┘
                              └──────────┘ └────────────┘

  Relationship cardinalities (read "→" as "has"):
    User → Venture (1:N)         Venture → Goal (1:N)          Venture → Run (1:N)
    User → Connection (1:N)      Venture → Budget (1:1)        Run  → Tick (1:N, logical)
    Venture → Connection (N:M)*  Venture → Checkpoint (1:N)    Venture → studio_project (1:N)
    Goal → Deployment (1:N)      Venture → Event (1:N)         Adapter → Deployment (1:N, by code)
  * a Connection is owned by the User and bound to a Venture when an Adapter uses it.
```

Everything below the `User` row is **owner-isolated**: every root table carries `user_id`, child
tables inherit ownership through their parent, and RLS enforces `auth.uid() = user_id` exactly as
[`server/sql/studio_projects.sql`](../../../../server/sql/studio_projects.sql) does today.

---

## 9.3 Entities

### User
- **Purpose:** the tenant. The unit of isolation, billing, and identity. Autopilot does not
  introduce its own user table — it reuses Supabase `auth.users` and the existing auth middleware.
- **Key attributes:** `id` (the RLS anchor), plan/entitlement (via existing `rbac.ts`), credit
  balance (via the existing `token_ledger_entries` / billing foundation).
- **Relationships:** owns many Ventures and Connections; (transitively) every venture child row.
- **Ownership / RLS:** *is* the ownership root. `auth.uid()` is compared against `user_id` on every
  root table.

### Venture
- **Purpose:** the top-level unit of Autopilot — a product/business the agents own end to end
  (roadmap, backlog, deployments, budget, connected accounts, audit trail). Higher-level than a
  `studio_project`; a Venture **HAS one or more `studio_projects`** (e.g. a web app plus an API).
- **Key attributes:** `name`, `summary`, `scope` (the approved boundary the scope-guard enforces),
  `success_metrics`, `status` (§9.4 state machine), `autonomy_level`, `deploy_url` (current live
  URL), `primary_project_id`.
- **Relationships:** owns Goals, Runs, Checkpoints, Events, exactly one Budget, and one+ `studio_projects`;
  binds Connections at deploy time.
- **Ownership / RLS:** root table `ventures`, `user_id` FK, `for all using (auth.uid() = user_id)`.
- **New vs reuse:** **new** (`ventures`). Adds `venture_id` FK to `studio_projects` (additive).

### Goal
- **Purpose:** one item of work in a venture's backlog/roadmap (epic → feature → task). The atomic
  unit of *intent*; a Run *executes* goals.
- **Key attributes:** `title`, `kind` (epic|feature|task|fix|chore), `status` (§9.4),
  `priority`, `dependencies` (other goal ids), `estimate`, `result`, `parent_goal_id` (tree).
- **Relationships:** belongs to a Venture; may produce Deployments; may be blocked by a Checkpoint.
- **Ownership / RLS:** child of `ventures`; ownership flows through the parent (join to `ventures`,
  mirroring the studio child-table policies).
- **New vs reuse:** **new** (`venture_goals`).

### Run
- **Purpose:** one autonomous *session* of the loop working a Venture, bounded by budget and time.
  A Run is the schedulable, restart-survivable container for many Ticks. Conceptually parallel to —
  but distinct from — `studio_runs` (which meters a single **container session**); a Venture Run may
  drive several `studio_runs` as it builds.
- **Key attributes:** `status` (§9.4), `started_at`, `ended_at`, `ticks_count`, `tokens_used`,
  `cost_usd`, `stop_reason` (completed|budget|kill|stuck|checkpoint).
- **Relationships:** belongs to a Venture; contains Ticks (logical); references the `studio_runs`
  it spawns.
- **Ownership / RLS:** child of `ventures`.
- **New vs reuse:** **new** (`venture_runs`); coexists with and references existing `studio_runs`.

### Tick
- **Purpose:** one pass of the loop — SENSE → ORIENT → DECIDE → ACT → VERIFY → SHIP → REFLECT
  (Master Plan §4.1). The smallest resumable, metered, logged unit.
- **Key attributes (logical):** `tick_number`, `phase` reached, `goal_id` worked, `cost`, `outcome`.
  A Tick is **not a dedicated table**; it is recorded as a correlated span of `venture_events`
  within its Run (cheap, append-only, replayable).
- **Relationships:** belongs to a Run; targets one Goal; emits Events.
- **Ownership / RLS:** inherited via its Events / Run.
- **New vs reuse:** **logical** (derived from `venture_events`); no new table.

### Checkpoint
- **Purpose:** a point where the loop **pauses for explicit human approval** before an irreversible
  or sensitive action. The human-in-the-loop brake. Six types (Master Plan §8): first production
  deploy, spending real money, destructive op, external publish, scope change, roadmap approval.
- **Key attributes:** `type`, `status` (§9.4), `context` (what/why payload for the UI),
  `blocks_goal_id` / `blocks_run_id`, `expires_at`, `resolved_by`, `resolution_note`.
- **Relationships:** belongs to a Venture; blocks a Goal and/or a Run until resolved.
- **Ownership / RLS:** child of `ventures`.
- **New vs reuse:** **new** (`venture_checkpoints`).

### Budget
- **Purpose:** hard caps per Venture; the spend brake. Read by the deterministic DECIDE gate
  *before* any spend; breach pauses the Venture and notifies. Spend caps are treated as a **security
  control** (a confused/compromised agent cannot exceed the cap).
- **Key attributes:** `usd_per_day`, `usd_total`, `max_tokens`, `max_container_minutes`,
  plus rolling spend counters (`spent_usd_today`, `spent_usd_total`).
- **Relationships:** exactly one per Venture (1:1).
- **Ownership / RLS:** child of `ventures`.
- **New vs reuse:** **new** (`venture_budgets`); spend is sourced from the existing
  `costEstimator.ts` → `billingLedger.ts` pipeline, tagged with `venture_id`. `studio_runs.cost_usd`
  is one of the inputs.

### Connection
- **Purpose:** a User's bring-your-own provider account (Cloudflare / Vercel / Supabase / Railway /
  GitHub) linked via Nango/OAuth/PAT, consumed by Adapters to deploy to the user's own cloud.
- **Key attributes:** `provider`, `nango_connection_id` (a **reference only** — no plaintext
  secrets in our DB), `scopes`, `label`, `status` (active|revoked|error), `metadata`.
- **Relationships:** owned by the User; bound to a Venture when an Adapter uses it (effectively N:M
  via the deploy that selects it).
- **Ownership / RLS:** `user_id`-scoped. Secret material lives in Nango, never in this row.
- **New vs reuse:** **new** (`venture_connections`); reuses the existing Nango wiring
  (`server/src/ai/tools/nango.ts`).

### Adapter
- **Purpose:** a pluggable `deploy()` / `provision()` / `status()` / `rollback()` implementation
  for one provider, making SHIP provider-agnostic (Master Plan §6).
- **Key attributes (code, not data):** `id` (`managed-preview` | `cloudflare-pages` |
  `cloudflare-workers` | `vercel` | `railway`), the four method contracts.
- **Relationships:** selected per deploy by provider + available Connection; produces Deployments.
- **Ownership / RLS:** not a row — a registered code interface
  (`server/src/ventures/adapters/`). Each adapter requests least-privilege scopes; deploy tokens
  are per-venture, revocable, never logged.
- **New vs reuse:** **new** code; `managed-preview` wraps the existing `studio-worker/`.

### Deployment
- **Purpose:** one attempt to publish a build to a target (managed preview or BYO production). The
  record of "what is live, where, since when."
- **Key attributes:** `target`, `url`, `status` (§9.4), `created_at`, plus the new `venture_id`,
  `goal_id`, and `is_production` tags.
- **Relationships:** produced by an Adapter for a Goal; references a `studio_project` build.
- **Ownership / RLS:** child of `studio_projects` (ownership flows through it, as today).
- **New vs reuse:** **reuse** of existing `studio_deployments`, **extended** with a `venture_id`
  (and goal/production) column — not a new table.

### Event
- **Purpose:** the append-only audit record of everything the loop sensed, decided, did, shipped,
  and spent. The single source of truth for "what is my agent doing?" — and the substrate from
  which Ticks and the live activity stream are derived.
- **Key attributes:** `kind` (sense|orient|decide|act|verify|ship|reflect|checkpoint|budget|error),
  `run_id`, `goal_id`, `summary`, `payload`, `cost_usd`, `model`, `prompt_hash`, `created_at`.
  **Append-only** — never updated or deleted.
- **Relationships:** belongs to a Venture; correlated to a Run/Tick/Goal.
- **Ownership / RLS:** child of `ventures`; read-only to the owner.
- **New vs reuse:** **new** (`venture_events`).

### Existing studio entities (reused verbatim)
- **studio_projects** — one AI-built app (files, github_repo, deploy_url, current_version_id). A
  Venture **HAS one or more**. The *only* change is an additive `venture_id` FK.
- **studio_files** — the current file tree (one row per file). Unchanged.
- **studio_versions** — snapshots for diff/restore; a new version per successful ACT. Unchanged.
- **studio_runs** — per-container-session metering (cost, awake time). Unchanged; tagged by
  `venture_id` only via the project link.
- **studio_deployments** — see **Deployment** above (extended, not replaced).

| Entity | Table | New / reuse | RLS anchor |
|---|---|---|---|
| User | `auth.users` | reuse | self |
| Venture | `ventures` | new | `user_id` |
| Goal | `venture_goals` | new | parent venture |
| Run | `venture_runs` | new | parent venture |
| Tick | *(none — events)* | logical | via events |
| Checkpoint | `venture_checkpoints` | new | parent venture |
| Budget | `venture_budgets` | new | parent venture |
| Connection | `venture_connections` | new | `user_id` |
| Adapter | *(code interface)* | new code | n/a |
| Deployment | `studio_deployments` (+`venture_id`) | reuse + extend | parent project |
| Event | `venture_events` | new | parent venture |
| Project/Files/Versions/Runs | `studio_*` | reuse | existing |

---

## 9.4 State machines

State machines are **explicit** so the loop, the API, and the Console can all agree on legal
transitions. Each transition lists its **trigger** and its **guard** (the deterministic condition
that must hold). Illegal transitions are rejected by the control plane (Epic A1) and never reached
by the loop.

### Venture lifecycle

```
   draft ──approve roadmap──► roadmap_pending ──roadmap built──► active
                                                                  │  ▲
                                  ┌───────────────────────────────┘  │
                                  │ pause (budget|checkpoint|kill|     │ resume
                                  │        stuck)                      │ (cause cleared)
                                  ▼                                    │
                               paused ─────────────────────────────────┘
                                  │
                                  └────────── archive ──────────► archived (terminal)
   active ─────────────────────── archive ──────────────────────► archived
```

| From | To | Trigger | Guard |
|---|---|---|---|
| draft | roadmap_pending | User submits intake / requests roadmap | Idea text present |
| roadmap_pending | active | Roadmap checkpoint **approved** | Roadmap exists; scope stored |
| roadmap_pending | draft | Roadmap **denied** / withdrawn | — |
| active | paused | Budget breach \| open Checkpoint \| kill switch \| no-progress (stuck) | Pause cause recorded in `stop_reason` |
| paused | active | Cause cleared (budget topped up, checkpoint resolved, kill off, goal unblocked) | No remaining blocking cause |
| active \| paused | archived | User archives | No active Run (drained) |

`paused` is one state with a **reason** (`budget` / `checkpoint` / `kill` / `stuck`); the Console
renders the reason and the unblock action. `archived` is terminal.

### Goal lifecycle

```
   proposed ──prioritized──► queued ──picked by tick──► in_progress ──ACT ok──► verifying
       │                        │                            │                    │
       │                        │                     stuck/blocked          tests pass
       ▼                        ▼                            ▼              ┌─────┴─────┐
   (dropped)               (deferred)                     blocked           ▼           ▼
                                                                          shipped     failed
                                                          blocked ──unblocked──► queued
```

| From | To | Trigger | Guard |
|---|---|---|---|
| proposed | queued | ORIENT prioritizes it | In approved scope |
| queued | in_progress | A Tick picks it | Budget OK; deps satisfied; not checkpoint-blocked |
| in_progress | verifying | ACT produced a build | New `studio_version` created |
| verifying | shipped | VERIFY + (auto/approved) SHIP succeed | Build/tests/safety pass; prod checkpoint approved |
| verifying | failed | VERIFY fails past iteration cap | FIX exhausted |
| in_progress \| verifying | blocked | No-progress detector \| awaiting Checkpoint | Stuck threshold hit or checkpoint open |
| blocked | queued | Checkpoint resolved / human steer | Blocking cause cleared |

`shipped` and `failed` are terminal for that goal (a follow-up is a *new* goal). `blocked` always
routes through a human via a Checkpoint or a re-prioritization.

### Run lifecycle

```
   starting ──scheduler admits──► running ──pause cause──► paused ──resume──► running
                                     │                                          │
                                     ├──── backlog drained / max-ticks ────► completed
                                     └──── unrecoverable error ─────────────► failed
   paused ──── timeout / kill ───────────────────────────────────────────► failed
```

| From | To | Trigger | Guard |
|---|---|---|---|
| starting | running | Scheduler admits the Run | Venture active; under concurrency cap; kill off |
| running | paused | Budget breach \| checkpoint \| kill | Reason recorded |
| paused | running | Cause cleared | No blocking cause; budget remains |
| running | completed | Backlog drained or `max_ticks` reached cleanly | No failures pending |
| running | failed | Unrecoverable error | — |
| paused | failed | Pause exceeds max idle / kill while paused | Timeout elapsed |

A Run is bounded by **max ticks per run** and **wall-clock per tick** (Master Plan §8) — it cannot
spin forever. Crash mid-Tick resumes from durable state on the next schedule.

### Checkpoint lifecycle

```
   open ──user approves──► approved (terminal)
     │
     ├──user denies──────► denied  (terminal)
     │
     └──TTL elapses──────► expired (terminal)
```

| From | To | Trigger | Guard |
|---|---|---|---|
| open | approved | Owner approves in Console | Owner == venture owner |
| open | denied | Owner denies | Owner == venture owner |
| open | expired | `expires_at` passes with no action | TTL configured |

`approved` unblocks the blocked Goal/Run; `denied`/`expired` keep it blocked and surface a follow-up
decision. Resolution is recorded in an Event for audit.

### Deployment lifecycle

```
   queued ──adapter starts──► building ──success──► live
                                  │                   │
                                  └──failure──► failed │
                                                       └──new live deploy──► (prior) rolledback
   live ──rollback()──► rolledback (terminal)
```

| From | To | Trigger | Guard |
|---|---|---|---|
| queued | building | Adapter `deploy()` begins | Connection valid (BYO) or managed |
| building | live | Build + publish succeed | Health check passes |
| building | failed | Build/publish error | — |
| live | rolledback | Adapter `rollback()` \| superseded by a newer live deploy | Adapter supports rollback |

Production deployments cannot reach `building` until their **first-production-deploy Checkpoint** is
`approved`. Managed previews skip that gate.

---

## 9.5 Glossary

Alphabetical. Terms in **bold** within a definition are themselves defined here.

- **ACT** — the loop phase that runs the existing agentic build loop / swarm against the chosen
  **Goal**, producing or modifying a **studio_project**.
- **Adapter** — a pluggable, provider-specific `deploy()`/`provision()` implementation that makes
  **SHIP** provider-agnostic (managed preview, Cloudflare, Vercel, Railway).
- **Approval queue** — the Operator Console view of all **Checkpoints** in the `open` state.
- **Autonomy level** — a per-**Venture** policy controlling how aggressively the loop proceeds
  without asking; "more autonomous" is a checkpoint/budget-policy change, not a rewrite.
- **Budget** — hard caps (USD/day, USD total, tokens, container-minutes) per **Venture**; breach
  pauses the venture. A spend cap is a **security control**.
- **Checkpoint** — a human-approval gate before an irreversible/sensitive action (prod deploy,
  spend, destructive op, external publish, scope change, roadmap approval).
- **Concurrency cap** — a global limit on simultaneous **Ticks**, protecting providers and the bill.
- **Connection** — a User's BYO provider account linked via Nango/OAuth/PAT; stores only a Nango
  reference, never plaintext secrets.
- **Control plane** — the Express/API + DB layer (Epic A1) that owns CRUD and legal state
  transitions for all venture entities.
- **DECIDE** — the deterministic (no-LLM) gate: budget? checkpoint required? in scope? → proceed or
  enqueue a **Checkpoint** and pause.
- **Deployment** — one publish attempt to a target; recorded in extended `studio_deployments`.
- **Durable Object (DO)** — Cloudflare coordination primitive; `VentureDO` drives the **Tick**
  heartbeat via Alarms, `UserCoordinatorDO` handles sessions/real-time (see
  [`../ARCHITECTURE-CLOUDFLARE.md`](../ARCHITECTURE-CLOUDFLARE.md)).
- **Event** — append-only audit record of every sense/decide/act/ship/spend; source of truth and
  basis for **Ticks** and the activity stream.
- **Global kill switch** — a single flag (`VENTURES_KILL`) that pauses **every** Venture at once.
- **Goal** — one backlog/roadmap item (epic → feature → task) the loop executes.
- **Guard** — a deterministic condition that must hold for a state transition or loop action
  (budget, scope, concurrency, no-progress, wall-clock).
- **Managed preview** — Autopilot's own hosted deploy target (`*.dreamstreamstudio.ai`) needing no
  user credentials; the `managed-preview` **Adapter**.
- **No-progress detector** — the guard that pauses and raises a **Checkpoint** when a Goal repeats
  the same failure N times instead of looping.
- **Operator Console** — the 24/7 React UI (Epic A8): live activity, roadmap board, approval queue,
  budget meter, pause/resume/kill, deployments, logs.
- **ORIENT** — the LLM phase that assesses **Venture** state vs roadmap and proposes the next
  highest-value **Goal**.
- **Provision** — an optional Adapter step that creates backing resources (DB/auth/storage) before
  **deploy**.
- **REFLECT** — the final loop phase: write an **Event**, update **Goals**, record learnings, sleep
  until the next **Tick** or trigger.
- **Roadmap** — the approved set of **Goals** produced at intake; autonomous work may not exceed its
  **scope** without a scope **Checkpoint**.
- **RLS (Row-Level Security)** — Supabase owner-isolation (`auth.uid() = user_id`) enforced on every
  venture and studio table.
- **Run** — one bounded autonomous session of the loop on a **Venture**, made of many **Ticks**.
- **Scope** — the approved boundary of a **Venture**; the **scope guard** keeps **ORIENT** inside it.
- **SENSE** — the loop phase that gathers signals: open **Goals**, deploy health, runtime errors,
  analytics, user feedback.
- **SHIP** — the loop phase that deploys via an **Adapter**; managed is automatic, production is
  **Checkpoint**-gated.
- **studio_project / studio_files / studio_versions / studio_runs / studio_deployments** — the
  existing durable codebase model; a **Venture** HAS one or more `studio_projects` and reuses the
  rest verbatim (deployments extended with `venture_id`).
- **Stuck** — a **Venture**/**Run**/**Goal** state caused by the no-progress detector; resolved via
  a **Checkpoint**.
- **Tenant** — a **User**; the isolation, billing, and RLS boundary.
- **Tick** — one full pass of the loop (SENSE→ORIENT→DECIDE→ACT→VERIFY→SHIP→REFLECT); the atomic,
  resumable, metered unit, recorded as a span of **Events**.
- **Venture** — the top-level unit: a product/business the agents own, with a roadmap, backlog,
  budget, connections, deployments, and audit trail; HAS one or more **studio_projects**.
- **VERIFY** — the loop phase that runs typecheck/build/tests + preview health + the code-safety /
  secret scan before anything ships.

---

## 9.6 Consistency notes (extends vs reuses)

| Concern | Decision |
|---|---|
| Codebase substrate | **Reuse** `studio_projects`/`files`/`versions`/`runs` unchanged; add `venture_id` FK to `studio_projects`. |
| Deploy history | **Reuse + extend** `studio_deployments` with `venture_id`/`goal_id`/`is_production`; do not create a new deployments table. |
| Metering | **Reuse** `costEstimator.ts` → `billingLedger.ts`; tag with `venture_id`; `studio_runs.cost_usd` feeds **Budget** spend. |
| Secrets | **Reuse** Nango; `venture_connections` holds only references. |
| Isolation | **Reuse** the studio RLS pattern verbatim on every new `venture_*` table. |
| Ticks / activity | **Derive** from `venture_events` — no Tick table; keeps the model lean and append-only. |
| Governance entities | **New** (`ventures`, `venture_goals`, `venture_runs`, `venture_checkpoints`, `venture_budgets`, `venture_connections`, `venture_events`) — the genuinely new layer. |

The schema realization of all of the above — columns, types, indexes, RLS policies, and the
`venture_id` additions to existing tables — is specified in
[section 26](./26-data-model-schema.md), which this section governs.
