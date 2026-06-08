# 26 — Data Model & Schema

> Part III · Architecture · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> Realizes the conceptual model in [section 09 — Domain model & glossary](./09-domain-model-glossary.md)
> and the table list in [00-MASTER-PLAN](../00-MASTER-PLAN.md) (A0/A1) +
> [F-ENTERPRISE-FOUNDATIONS](../F-ENTERPRISE-FOUNDATIONS.md) (F0/F3/F6). The existing studio
> substrate is [`../../06-DATA-MODEL.md`](../../06-DATA-MODEL.md); conventions match
> [`server/sql/studio_projects.sql`](../../../../server/sql/studio_projects.sql).

## 26.1 What this section is (and what it is not)

This is the **physical schema** for Autopilot: every table, its columns, types, defaults,
foreign keys, indexes, and its row-level-security (RLS) policy. Section 09 defined the
*concepts* (Venture, Goal, Run, Tick, Checkpoint, Budget, Connection, Event); this section
turns each into DDL that an engineer can apply and a reviewer can audit.

Three honesty rules govern everything below — the same three the rest of the spec lives by:

1. **Mark shipped vs new.** Every table is tagged **EXISTS TODAY** (already in
   `server/sql/`, reused verbatim or with an additive column) or **NEW** (created by an
   Autopilot migration). We do not claim the venture layer is built — A0/A1 are
   `📋 planned`. We *do* protect the studio tables that are real.
2. **Extend, don't replace.** The durable codebase model (`studio_projects`, `studio_files`,
   `studio_versions`, `studio_runs`, `studio_deployments`) is reused. A **Venture HAS one or
   more `studio_projects`**; the only edits to existing tables are *additive* (`venture_id`,
   an optimistic-concurrency `version`, a deploy `is_production` flag).
3. **RLS on every table, no exceptions.** Owner isolation (`auth.uid() = user_id`,
   inherited through the parent for child tables) is the tenant boundary. F6's CI check
   *fails the build* if any table lacks a policy (§26.13). The SQL sketches here are
   "review-grade": they show the shape and the policy; the applied migration files are the
   source of truth.

The DDL targets **Supabase Postgres**. The API/worker writes through the **service role**
(which bypasses RLS); the policies exist so a user reading directly from the client (or a
leaked anon key) can still only ever see their own rows — defense in depth, exactly as
`studio_runs` does today (service-role writes, owner SELECT policy).

---

## 26.2 ER overview

```
                                  ┌───────────────────────────┐
                                  │        auth.users         │  EXISTS · the tenant / RLS anchor
                                  └───┬───────────────┬────┬──┘
        user_id on every root row    │               │    │
   ┌──────────────────────────────────┘               │    └──────────────────────────────┐
   │                 │                 │               │                  │                 │
   ▼                 ▼                 ▼               ▼                  ▼                 ▼
┌────────┐   ┌────────────────┐  ┌──────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐
│ventures│   │venture_        │  │user_     │  │ user_devices │  │  sessions    │  │ audit_log   │
│  NEW   │   │connections NEW │  │settings  │  │   NEW (F3)   │  │  NEW (F3)    │  │  NEW (F0)   │
└───┬────┘   └───────┬────────┘  │ NEW*     │  └──────────────┘  └──────────────┘  └─────────────┘
    │ 1:N            │ used by    └──────────┘   device registry  first-party       append-only
    │   ┌────────────┴───────────┐  adapters                      session records   security log
    │   │ (bound to a venture     │  at deploy
    │   │  at deploy time)        │
    │   ▼                         │
    │  (N:M Venture⇄Connection via the deploy that selects it)
    │
    ├──────────┬───────────┬───────────┬───────────┬─────────────────────────────┐
    ▼          ▼           ▼           ▼           ▼                             ▼
┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐ ┌──────────────┐          ┌──────────────────┐
│venture_│ │venture_│ │venture_│ │venture_  │ │   venture_   │          │  studio_projects │  EXISTS
│ goals  │ │ runs   │ │budgets │ │checkpoints│ │   events     │          │  (+venture_id,   │  (+ FK)
│  NEW   │ │  NEW   │ │ NEW 1:1│ │   NEW    │ │  NEW (append)│          │   + version)     │
└───┬────┘ └───┬────┘ └────────┘ └──────────┘ └──────▲───────┘          └────────┬─────────┘
    │ tree     │ 1:N (logical Ticks                  │ appends                   │ HAS 1:N
    │ parent_  │  = correlated spans of events)      │ (run_id, goal_id)         │
    │ goal_id  └─────────────────────────────────────┘                           ▼
    │                                                                  ┌────────────────────────────┐
    └──► may produce ──► studio_deployments (EXISTS, +venture_id,      │ studio_files / _versions / │  EXISTS
                          +goal_id, +is_production)  ◄──────────────── │ _runs / _deployments       │
                                                       project build   └────────────────────────────┘

  EXISTS TODAY: auth.users, studio_projects, studio_files, studio_versions, studio_runs,
                studio_deployments, custom_agents, mcp_servers, token_ledger_entries (+ billing)
  NEW (A0):     ventures, venture_budgets, venture_checkpoints, venture_events, audit_log
  NEW (A1):     venture_goals, venture_runs, venture_connections  (+ FK/columns on studio_*)
  NEW (F3):     user_devices, sessions
  NEW* :        user_settings  — see §26.11 (a thin preferences table; partly logical today)
  LOGICAL:      Tick (no table — derived from venture_events), Adapter (code interface)
```

Cardinalities (read "→" as "has"): `User → Venture (1:N)`, `User → Connection (1:N)`,
`Venture → Goal (1:N)`, `Venture → Run (1:N)`, `Venture → Budget (1:1)`,
`Venture → Checkpoint (1:N)`, `Venture → Event (1:N)`, `Venture → studio_project (1:N)`,
`Run → Tick (1:N, logical)`, `Goal → Deployment (1:N)`, `Venture ⇄ Connection (N:M, by deploy)`.

---

## 26.3 Existing tables, reused (EXISTS TODAY)

These are real (`server/sql/`). Autopilot reuses them as-is or with **additive** columns
only. RLS is already enabled and owner-isolated; we never weaken it.

### `studio_projects` — EXISTS · **+ `venture_id`, + `version`**

The durable per-app codebase row. The only changes are additive: a nullable `venture_id`
FK (so a project can belong to a Venture without breaking the standalone studio), and a
`version` integer for F2 optimistic concurrency.

```sql
-- Already created by server/sql/studio_projects.sql. Autopilot adds (in
-- server/sql/ventures_control_plane.sql, A1):
alter table public.studio_projects
  add column if not exists venture_id uuid references public.ventures(id) on delete set null,
  add column if not exists version    integer not null default 1;   -- F2 optimistic concurrency

create index if not exists studio_projects_venture_idx
  on public.studio_projects (venture_id) where venture_id is not null;
```
- **RLS (unchanged):** `studio_projects_owner` — `for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id)`.
- **Notes:** `venture_id` is `on delete set null` (deleting a Venture must not cascade-wipe
  a user's code; archival, not deletion, is the venture path). `version` is bumped per write;
  the repository rejects a stale `version` (replaces the delete-then-insert file save with a
  versioned transactional upsert — F2).

### `studio_files` / `studio_versions` — EXISTS · **unchanged**

The file tree (PK `(project_id, path)`) and the snapshot history (`files jsonb`, one row per
successful ACT). No schema change. RLS flows through the parent project
(`exists (select 1 from studio_projects p where p.id = project_id and p.user_id = auth.uid())`).
Large blobs spill to R2 with a reference (per `06-DATA-MODEL.md`); the column shape is unchanged.

### `studio_runs` — EXISTS · **unchanged**

Per-**container-session** metering (`sandbox_id`, `status`, `awake_seconds`, `cost_usd`).
This is **not** the same as a `venture_runs` row — a venture Run may spawn several
`studio_runs` as it builds. The venture tag is reached through the project link
(`studio_runs.project_id → studio_projects.venture_id`), so no column is added here; budget
spend reads `studio_runs.cost_usd` via that join. RLS: owner `SELECT` policy
(`auth.uid() = user_id`); writes are service-role.

### `studio_deployments` — EXISTS · **+ `venture_id`, + `goal_id`, + `is_production`**

The deploy history. Per the domain model, **Deployment is reused + extended, not a new
table.** Adapters (managed-preview, cloudflare-pages, vercel, railway) all write here.

```sql
-- Already created by server/sql/studio_projects.sql. Autopilot adds (A1):
alter table public.studio_deployments
  add column if not exists venture_id    uuid references public.ventures(id) on delete set null,
  add column if not exists goal_id       uuid references public.venture_goals(id) on delete set null,
  add column if not exists is_production  boolean not null default false,
  add column if not exists adapter        text;     -- managed-preview | cloudflare-pages | vercel | railway

create index if not exists studio_deployments_venture_idx
  on public.studio_deployments (venture_id, created_at desc) where venture_id is not null;
```
- **RLS (unchanged):** ownership flows through the parent `studio_projects` (the existing
  `studio_deployments_owner` policy). The new FKs do not change the anchor.
- **Notes:** a production deployment cannot reach `building` until its **first-production
  Checkpoint** is `approved` (enforced in code at SHIP, audited in `venture_events`).
  `status` reuses the existing `queued|building|live|failed` (+ `rolledback` per §9.4).

### `custom_agents` / `mcp_servers` — EXISTS · **unchanged**

Reused verbatim. `custom_agents` (saved swarm specialists, RLS owner + public-read for the
library) and `mcp_servers` (server-side MCP registry, `headers` treated as secret-bearing,
service-role-only read) are consumed by ACT and the integrations layer without modification.
Listed here because §26 is the complete schema map; their DDL lives in
`server/sql/studio_agents.sql` and `server/sql/mcp_servers.sql`.

### Token ledger & billing — EXISTS · **unchanged shape, tagged by `venture_id`**

`token_ledger_entries`, `token_wallets`, `generation_cost_events`, etc.
(`server/sql/token_billing_foundation.sql`) are the metering substrate.
`token_ledger_entries.project_id` and `.metadata jsonb` already exist; Autopilot writes the
`venture_id` into `metadata` (and uses `project_id` for the studio link) rather than altering
the hot ledger table — **additive, no migration on the ledger**. Per-venture spend is the
sum of ledger entries tagged with that venture plus the joined `studio_runs.cost_usd`. RLS:
owner `SELECT` already in place.

---

## 26.4 `ventures` — NEW (A0)

The root of the autonomy layer: a product the agents own.

```sql
-- server/sql/ventures_foundation.sql (Epic A0)
create extension if not exists pgcrypto;

create table if not exists public.ventures (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  name               text not null default 'Untitled venture',
  summary            text not null default '',
  scope              jsonb not null default '{}'::jsonb,   -- approved boundary the scope-guard enforces
  success_metrics    jsonb not null default '[]'::jsonb,   -- string[] / {metric,target}[]
  status             text  not null default 'draft',       -- draft|roadmap_pending|active|paused|archived
  pause_reason       text,                                  -- budget|checkpoint|kill|stuck  (when paused)
  autonomy_level     text  not null default 'balanced',    -- conservative|balanced|aggressive (policy, not engine)
  primary_project_id uuid references public.studio_projects(id) on delete set null,
  deploy_url         text,                                  -- current live URL (managed or BYO)
  version            integer not null default 1,            -- F2 optimistic concurrency
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists ventures_user_idx        on public.ventures (user_id, updated_at desc);
create index if not exists ventures_user_active_idx  on public.ventures (user_id) where status = 'active';

alter table public.ventures enable row level security;
drop policy if exists ventures_owner on public.ventures;
create policy ventures_owner on public.ventures
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```
- **RLS:** root table — direct owner isolation, identical to `studio_projects`.
- **Notes:** `status`/`pause_reason` realize the §9.4 venture state machine; `paused` is one
  state with a reason. `scope` is the contract the scope-guard checks before ORIENT pursues a
  goal. `autonomy_level` is a *policy knob* (which checkpoints fire, how tight budgets
  default) — never a code-path change. `primary_project_id` is `set null` because a Venture
  outlives any single project. The partial active index keeps the scheduler's "pick active
  ventures" query cheap at scale.

---

## 26.5 `venture_budgets` — NEW (A0) · 1:1 with a venture

The spend brake. Read by the deterministic DECIDE gate **before** any spend; the REFLECT
step updates the rolling counters; breach pauses the venture. Spend caps are a **security
control** (a confused/compromised agent cannot exceed them — Master Plan §5.6).

```sql
-- server/sql/ventures_foundation.sql (A0)
create table if not exists public.venture_budgets (
  venture_id            uuid primary key references public.ventures(id) on delete cascade,
  usd_per_day           numeric(12,2) not null default 5,
  usd_total             numeric(12,2) not null default 50,
  max_tokens            bigint        not null default 5000000,
  max_container_minutes integer       not null default 600,
  -- rolling spend counters (updated at REFLECT; daily counter rolls on date change)
  spent_usd_today       numeric(12,6) not null default 0,
  spent_usd_total       numeric(12,6) not null default 0,
  tokens_used_total     bigint        not null default 0,
  container_minutes_used integer      not null default 0,
  day_cycle_date        date          not null default current_date,
  alert_80_sent_at      timestamptz,                    -- spend-alert dedupe (A7)
  updated_at            timestamptz   not null default now()
);

alter table public.venture_budgets enable row level security;
drop policy if exists venture_budgets_owner on public.venture_budgets;
create policy venture_budgets_owner on public.venture_budgets
  for all using (exists (select 1 from public.ventures v
                         where v.id = venture_id and v.user_id = auth.uid()))
  with check (exists (select 1 from public.ventures v
                      where v.id = venture_id and v.user_id = auth.uid()));
```
- **RLS:** child of `ventures` — ownership flows through the parent (the `exists (… v …)`
  pattern from `studio_files`). One policy covers all verbs.
- **Notes:** PK *is* `venture_id` (enforces 1:1). Defaults are deliberately conservative —
  managed hosting carries our cost. The pure budget evaluator (`server/src/ventures/budget.ts`,
  A0) reads this row and returns `allow | pause-budget`; the counter update at REFLECT and the
  daily roll (`day_cycle_date`) are transactional so concurrent ticks can't double-spend.

---

## 26.6 `venture_checkpoints` — NEW (A0)

A human-approval gate before an irreversible/sensitive action — the human-in-the-loop brake.
Six types (Master Plan §8): first production deploy, spending real money, destructive op,
external publish, scope change, roadmap approval.

```sql
-- server/sql/ventures_foundation.sql (A0)
create table if not exists public.venture_checkpoints (
  id              uuid primary key default gen_random_uuid(),
  venture_id      uuid not null references public.ventures(id) on delete cascade,
  type            text not null,        -- prod_deploy|spend|destructive|publish|scope|roadmap
  status          text not null default 'open',   -- open|approved|denied|expired
  context         jsonb not null default '{}'::jsonb,  -- what/why payload the Console renders
  blocks_goal_id  uuid references public.venture_goals(id) on delete set null,
  blocks_run_id   uuid references public.venture_runs(id)  on delete set null,
  expires_at      timestamptz,                    -- TTL → auto-expire
  resolved_by     uuid references auth.users(id), -- owner who acted
  resolution_note text,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

create index if not exists venture_checkpoints_open_idx
  on public.venture_checkpoints (venture_id, created_at desc) where status = 'open';

alter table public.venture_checkpoints enable row level security;
drop policy if exists venture_checkpoints_owner on public.venture_checkpoints;
create policy venture_checkpoints_owner on public.venture_checkpoints
  for all using (exists (select 1 from public.ventures v
                         where v.id = venture_id and v.user_id = auth.uid()))
  with check (exists (select 1 from public.ventures v
                      where v.id = venture_id and v.user_id = auth.uid()));
```
- **RLS:** child of `ventures`. `resolved_by` must equal the venture owner (also enforced in
  code; the policy already prevents writing to another user's checkpoint).
- **Notes:** the partial `open` index *is* the Approval Queue query (Console §14). The FKs to
  goals/runs are `set null` so resolving history survives goal/run cleanup. `approved`
  unblocks the goal/run; `denied`/`expired` keep it blocked and surface a follow-up. Every
  resolution also writes a `venture_events` row for audit.

---

## 26.7 `venture_events` — NEW (A0) · append-only

The single source of truth for "what is my agent doing?" — and the substrate from which
**Ticks** and the live activity stream are derived (there is no Tick table; a Tick is a
correlated span of events). Append-only: **never updated or deleted.**

```sql
-- server/sql/ventures_foundation.sql (A0)
create table if not exists public.venture_events (
  id           bigint generated always as identity primary key,  -- monotonic; cheap ordering/cursoring
  venture_id   uuid not null references public.ventures(id) on delete cascade,
  run_id       uuid references public.venture_runs(id)  on delete set null,
  goal_id      uuid references public.venture_goals(id) on delete set null,
  tick_number  integer,                       -- correlates a span into a logical Tick
  kind         text not null,                 -- sense|orient|decide|act|verify|ship|reflect|
                                              -- checkpoint|budget|error
  summary      text not null default '',
  payload      jsonb not null default '{}'::jsonb,
  cost_usd     numeric(12,6),
  model        text,                          -- which model produced an LLM step
  prompt_hash  text,                          -- explainability without storing the prompt
  created_at   timestamptz not null default now()
);

create index if not exists venture_events_stream_idx
  on public.venture_events (venture_id, id desc);          -- SSE stream + pagination
create index if not exists venture_events_run_idx
  on public.venture_events (run_id, tick_number, id);      -- reconstruct a Tick / Run
create index if not exists venture_events_kind_idx
  on public.venture_events (venture_id, kind, created_at desc);

alter table public.venture_events enable row level security;
-- Append-only to the owner: SELECT + INSERT only; no UPDATE/DELETE policy on purpose.
drop policy if exists venture_events_owner_read on public.venture_events;
create policy venture_events_owner_read on public.venture_events
  for select using (exists (select 1 from public.ventures v
                            where v.id = venture_id and v.user_id = auth.uid()));
drop policy if exists venture_events_owner_insert on public.venture_events;
create policy venture_events_owner_insert on public.venture_events
  for insert with check (exists (select 1 from public.ventures v
                                 where v.id = venture_id and v.user_id = auth.uid()));
```
- **RLS:** child of `ventures`, but **read + insert only** — the deliberate *absence* of
  UPDATE/DELETE policies makes the table append-only even to the owner via the client. The
  service role still bypasses RLS, so retention pruning (§26.14) runs as a privileged job, not
  a user action.
- **Notes:** identity `bigint` PK (not uuid) gives a cheap monotonic cursor for the SSE
  activity stream and keeps the hot append path index-friendly. `prompt_hash`/`model` make
  every LLM decision explainable without persisting raw prompts (privacy). This table is the
  highest-volume one; it is the prime candidate for partitioning by month and R2 cold-storage
  at scale (§26.12, §26.14).

---

## 26.8 `venture_goals` — NEW (A1)

One backlog/roadmap item (epic → feature → task); the atomic unit of *intent* a Run executes.

```sql
-- server/sql/ventures_control_plane.sql (A1)
create table if not exists public.venture_goals (
  id             uuid primary key default gen_random_uuid(),
  venture_id     uuid not null references public.ventures(id) on delete cascade,
  parent_goal_id uuid references public.venture_goals(id) on delete cascade,  -- epic→feature→task tree
  title          text not null,
  detail         text not null default '',
  kind           text not null default 'task',     -- epic|feature|task|fix|chore
  status         text not null default 'proposed', -- proposed|queued|in_progress|verifying|
                                                   -- blocked|shipped|failed|dropped|deferred
  priority       integer not null default 100,     -- lower = sooner
  dependencies   jsonb not null default '[]'::jsonb, -- other goal ids
  estimate       text,                             -- t-shirt / rough sizing
  result         jsonb,                            -- outcome payload (version id, deploy id, notes)
  block_reason   text,                             -- stuck|checkpoint  (when blocked)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists venture_goals_board_idx
  on public.venture_goals (venture_id, status, priority);     -- the roadmap board query
create index if not exists venture_goals_parent_idx
  on public.venture_goals (parent_goal_id) where parent_goal_id is not null;

alter table public.venture_goals enable row level security;
drop policy if exists venture_goals_owner on public.venture_goals;
create policy venture_goals_owner on public.venture_goals
  for all using (exists (select 1 from public.ventures v
                         where v.id = venture_id and v.user_id = auth.uid()))
  with check (exists (select 1 from public.ventures v
                      where v.id = venture_id and v.user_id = auth.uid()));
```
- **RLS:** child of `ventures`.
- **Notes:** `status` realizes the §9.4 goal state machine; `shipped`/`failed`/`dropped` are
  terminal (a follow-up is a *new* goal). `parent_goal_id` self-FK gives the epic tree and
  cascades on parent delete. `dependencies` as `jsonb` (not a join table) keeps the model
  lean for the realistic backlog size; the DECIDE gate checks deps before a Tick picks a goal.
  The `(venture_id, status, priority)` index is exactly the Console board + "next goal" pick.

---

## 26.9 `venture_runs` — NEW (A1)

One bounded autonomous *session* of the loop on a Venture — the schedulable,
restart-survivable container for many Ticks. Distinct from `studio_runs` (which meters a
single sandbox container session); a venture Run *references* the `studio_runs` it spawns.

```sql
-- server/sql/ventures_control_plane.sql (A1)
create table if not exists public.venture_runs (
  id           uuid primary key default gen_random_uuid(),
  venture_id   uuid not null references public.ventures(id) on delete cascade,
  status       text not null default 'starting',  -- starting|running|paused|completed|failed
  stop_reason  text,                              -- completed|budget|kill|stuck|checkpoint
  ticks_count  integer not null default 0,
  max_ticks    integer not null default 50,       -- the per-run bound (no infinite runs)
  tokens_used  bigint  not null default 0,
  cost_usd     numeric(12,6) not null default 0,
  studio_run_ids jsonb not null default '[]'::jsonb,  -- container sessions this run drove
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  last_tick_at timestamptz                        -- heartbeat; drives the stuck/idle timeout
);

create index if not exists venture_runs_venture_idx on public.venture_runs (venture_id, started_at desc);
create index if not exists venture_runs_active_idx   on public.venture_runs (venture_id) where ended_at is null;

alter table public.venture_runs enable row level security;
drop policy if exists venture_runs_owner on public.venture_runs;
create policy venture_runs_owner on public.venture_runs
  for all using (exists (select 1 from public.ventures v
                         where v.id = venture_id and v.user_id = auth.uid()))
  with check (exists (select 1 from public.ventures v
                      where v.id = venture_id and v.user_id = auth.uid()));
```
- **RLS:** child of `ventures`.
- **Notes:** `status`/`stop_reason` realize the §9.4 run state machine. `max_ticks` +
  `last_tick_at` are the bounds that make "never stop" *safe* — a run cannot spin forever and
  a crash mid-Tick resumes from durable state on the next schedule (the scheduler reads
  `ended_at is null` active runs). `studio_run_ids` ties venture cost back to container
  metering for the budget rollup.

---

## 26.10 `venture_connections` — NEW (A1)

A user's bring-your-own provider account (Cloudflare / Vercel / Supabase / Railway / GitHub),
linked via Nango/OAuth/PAT and consumed by Adapters to deploy to the user's own cloud.
**No plaintext secrets** live here — only a Nango reference (Master Plan §5.3).

```sql
-- server/sql/ventures_control_plane.sql (A1)
create table if not exists public.venture_connections (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  provider            text not null,         -- cloudflare|vercel|supabase|railway|github
  nango_connection_id text not null,         -- REFERENCE ONLY — secret material lives in Nango
  label               text not null default '',
  scopes              jsonb not null default '[]'::jsonb,  -- least-privilege scopes granted
  status              text not null default 'active',      -- active|revoked|error
  last_used_at        timestamptz,
  metadata            jsonb not null default '{}'::jsonb,  -- account id, region — never secrets
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (user_id, provider, nango_connection_id)
);

create index if not exists venture_connections_user_idx
  on public.venture_connections (user_id, provider) where status = 'active';

alter table public.venture_connections enable row level security;
drop policy if exists venture_connections_owner on public.venture_connections;
create policy venture_connections_owner on public.venture_connections
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```
- **RLS:** **root** table — `user_id`-scoped directly (a Connection is owned by the user, not a
  venture; it is *bound* to a venture only at deploy time, giving the conceptual N:M). Same
  pattern as `mcp_servers`.
- **Notes:** the `unique` constraint prevents duplicate links. `nango_connection_id` is the
  only handle we keep; revocation flips `status` and revokes the Nango connection. Deploy
  tokens are per-venture, revocable, and never logged (Master Plan §5.9). Reuses the existing
  `server/src/ai/tools/nango.ts` wiring.

---

## 26.11 Foundation tables — `user_devices` (F3), `sessions` (F3), `audit_log` (F0), `user_settings`

These come from the F-series and are listed in §26.1 because §26 is the *complete* schema.
They are not venture-specific but Autopilot depends on them (authoritative device control,
session timeouts, the security audit trail that seeds `venture_events`).

### `user_devices` — NEW (F3) · *creates the missing migration*

F3 calls out that the device registry exists in code (`services/deviceSessions.ts`) but
**has no migration** — so it is not authoritative and `removeDevice` "does NOT invalidate the
Supabase session." This table makes it real.

```sql
-- server/sql/user_devices.sql (F3, also referenced by A0/A1 sequencing)
create table if not exists public.user_devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  device_label  text not null default '',          -- "Chrome on macOS"
  user_agent    text,
  last_ip       inet,
  last_seen_at  timestamptz not null default now(),
  trusted       boolean not null default false,     -- skip step-up on trusted devices
  revoked_at    timestamptz,                        -- set on "sign out this device"
  created_at    timestamptz not null default now(),
  unique (user_id, id)
);
create index if not exists user_devices_user_idx on public.user_devices (user_id, last_seen_at desc);

alter table public.user_devices enable row level security;
drop policy if exists user_devices_owner on public.user_devices;
create policy user_devices_owner on public.user_devices
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```
- **Notes:** revoking a device sets `revoked_at` *and* calls the Supabase admin API to kill
  that device's refresh token (real "sign out this device" — the F3 gap). In F4 a
  `UserCoordinatorDO` pushes the revocation instantly over WebSocket.

### `sessions` — NEW (F3) · first-party session records

Layered on top of the Supabase JWT so we get idle + absolute **timeouts**, session/device
binding, and step-up re-auth — none of which the bare JWT gives us.

```sql
-- server/sql/sessions.sql (F3)
create table if not exists public.sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  device_id     uuid references public.user_devices(id) on delete set null,
  created_at    timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  idle_expires_at     timestamptz not null,    -- bumped on activity (idle timeout)
  absolute_expires_at timestamptz not null,    -- hard cap regardless of activity
  ip            inet,
  step_up_at    timestamptz,                    -- last re-auth for sensitive actions
  revoked_at    timestamptz,
  revoke_reason text                            -- logout|admin|timeout|suspicious
);
create index if not exists sessions_user_active_idx
  on public.sessions (user_id) where revoked_at is null;
create index if not exists sessions_idle_idx on public.sessions (idle_expires_at)
  where revoked_at is null;

alter table public.sessions enable row level security;
drop policy if exists sessions_owner on public.sessions;
create policy sessions_owner on public.sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```
- **Notes:** billing and deploy require a recent `step_up_at` (re-auth on sensitive actions —
  F3/F8). The `idle_expires_at` partial index lets a cron sweep expire idle sessions cheaply.
  JWKS local verification (F3) replaces the per-request `getUser()` round-trip; this table is
  the server-side authority layered on the verified JWT.

### `audit_log` — NEW (F0) · security/admin audit · append-only

F0's security audit log — role changes, project deletes, auth events, deploys. It is broader
than `venture_events` (it covers the whole platform, not just ventures) and **seeds**
Autopilot's audit story.

```sql
-- server/sql/audit_log.sql (F0)
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid references auth.users(id) on delete set null,  -- null = system/service
  target_user_id uuid references auth.users(id) on delete set null,
  action      text not null,        -- role.change|project.delete|auth.login|deploy|kill_switch|…
  resource    text,                 -- "studio_project:<id>", "venture:<id>"
  ip          inet,
  request_id  text,                 -- F0 correlation id across logs/traces
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_log_actor_idx  on public.audit_log (actor_id, created_at desc);
create index if not exists audit_log_action_idx on public.audit_log (action, created_at desc);

alter table public.audit_log enable row level security;
-- No owner policy: admin-only reads via service role / admin route. RLS ON with no
-- permissive policy = locked to anon/authenticated by default (deny-all), readable only by
-- the service role and the admin surface. This is intentional.
```
- **RLS:** intentionally **deny-all** to clients (no policy) — the audit log is admin-only;
  reads go through an admin route over the service role. RLS is still *enabled* so it passes
  the F6 coverage check and a leaked anon key sees nothing.
- **Notes:** append-only (no UPDATE/DELETE). `request_id` ties an audited action to the F0
  trace context. The kill-switch flip is audited here.

### `user_settings` — NEW* · thin preferences row

Referenced in the spec index as an existing concept; today user preferences are scattered
(profile fields, localStorage, plan rows) with **no dedicated `user_settings` table**. Autopilot
needs a durable home for autonomy + notification defaults, so this is created as a small,
honest new table (the `*` flags that it is partly logical today).

```sql
-- server/sql/user_settings.sql (NEW; consolidates scattered prefs)
create table if not exists public.user_settings (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  default_autonomy_level text not null default 'balanced',  -- venture default
  notify_email         boolean not null default true,        -- checkpoint/budget alerts by email
  notify_in_app        boolean not null default true,
  default_usd_per_day  numeric(12,2) not null default 5,     -- prefilled budget for new ventures
  preferences          jsonb not null default '{}'::jsonb,   -- UI/theme/misc, forward-compatible
  updated_at           timestamptz not null default now()
);

alter table public.user_settings enable row level security;
drop policy if exists user_settings_owner on public.user_settings;
create policy user_settings_owner on public.user_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```
- **Notes:** PK is `user_id` (one row per user). Notification prefs gate the A7/A8 alert
  emails; `default_*` prefill the intake wizard. Kept thin and `jsonb`-extensible so it does
  not become a dumping ground.

---

## 26.12 Indexing strategy

Indexes are chosen from the **actual query shapes** the loop, the API, and the Console run —
not speculatively. Principles:

- **Tenant-prefixed.** Every secondary index leads with `user_id` or `venture_id` so RLS-scoped
  queries are covered and never scan another tenant's rows.
- **Partial indexes for hot subsets.** "Active ventures," "open checkpoints," "active runs,"
  and "active connections" are tiny slices of large tables; partial indexes
  (`where status = 'active'`, `where ended_at is null`, `where status = 'open'`) keep the
  scheduler and the Approval Queue O(small) regardless of total history.
- **Board / pick queries.** `venture_goals (venture_id, status, priority)` serves both the
  Console roadmap board and the loop's "next highest-value goal" pick in one index.
- **Stream / cursor.** `venture_events` uses a monotonic `bigint` identity PK and a
  `(venture_id, id desc)` index so the SSE activity stream pages by id (no `OFFSET`, no
  timestamp ties) — the single most-read path in the product.
- **Reconstruction.** `venture_events (run_id, tick_number, id)` rebuilds a logical Tick / Run
  for replay and debugging.
- **Cost rollups** ride existing ledger indexes (`token_ledger_entries (user_id, created_at)`,
  `(project_id)`); the venture join uses `studio_projects_venture_idx`.

| Table | Key index(es) | Serves |
|---|---|---|
| `ventures` | `(user_id, updated_at desc)`; partial `where status='active'` | list; scheduler |
| `venture_goals` | `(venture_id, status, priority)`; `(parent_goal_id)` | board; next-goal; tree |
| `venture_runs` | `(venture_id, started_at desc)`; partial `where ended_at is null` | history; active runs |
| `venture_checkpoints` | partial `(venture_id, created_at desc) where status='open'` | Approval Queue |
| `venture_events` | `(venture_id, id desc)`; `(run_id, tick_number, id)`; `(venture_id, kind, …)` | SSE stream; Tick replay; filters |
| `venture_connections` | partial `(user_id, provider) where status='active'` | adapter selection |
| `studio_projects` | existing `(user_id, updated_at desc)`; new `(venture_id)` | studio; venture link |
| `studio_deployments` | new `(venture_id, created_at desc)` | venture deploy history |
| `sessions` | partial `(user_id) where revoked_at is null`; `(idle_expires_at)` | active sessions; idle sweep |
| `audit_log` | `(actor_id, created_at desc)`; `(action, created_at desc)` | admin audit views |

**Future, at scale (not MVP):** range-**partition `venture_events`** (and `audit_log`) by
month; keep recent partitions hot, archive old ones to R2 (§26.14). Both are append-only, so
partitioning is clean.

---

## 26.13 Migration runner & ordered migration list (F6)

Today migrations are loose, run-by-hand `.sql` files in `server/sql/` + `docs/migrations/`,
and `user_devices` has **no migration at all** — environment drift and silently-missing
security policies (F6's exact complaint). Autopilot does **not** ship more by-hand SQL.

**The approach (F6):**
1. **Adopt the Supabase migration runner** (`supabase/migrations/`, ordered + versioned +
   idempotent). All new files use `create table if not exists` / `add column if not exists` /
   `drop policy if exists … create policy` so they are safe to re-apply (the convention every
   file in §26 already follows).
2. **Consolidate.** Bring the existing `server/sql/*.sql` and `docs/migrations/*.sql` under the
   one ordered runner so a fresh database is reproducible with a single command.
3. **Create the missing migrations:** `user_devices` (F3) and the `ventures_*` set (A0/A1).
4. **RLS-coverage check in CI:** a test asserts *every* table in the schema has at least one
   policy (or is intentionally deny-all like `audit_log`), and runs Supabase `get_advisors`;
   a table without a policy **fails the build**.
5. **Generated schema reference** (the data dictionary, §54) is produced from the runner's
   source of truth, not hand-written — so docs can't drift from DDL.

**Ordered migration list** (dependencies flow downward; FKs require their parent to exist
first):

| # | Migration file | Adds | Epic | Status |
|---|---|---|---|---|
| (existing) | `token_billing_foundation.sql`, `studio_projects.sql`, `studio_runs.sql`, `studio_agents.sql`, `mcp_servers.sql`, `projects_rls_owner_isolation.sql`, … | the studio + billing substrate | Phases 0–11 | **EXISTS** |
| M1 | `audit_log.sql` | `audit_log` | F0 | NEW |
| M2 | `user_devices.sql` | `user_devices` | F3 | NEW |
| M3 | `sessions.sql` | `sessions` (FK → `user_devices`) | F3 | NEW |
| M4 | `user_settings.sql` | `user_settings` | — | NEW |
| M5 | `ventures_foundation.sql` | `ventures`, `venture_budgets`, `venture_checkpoints`, `venture_events` (+ RLS) | A0 | NEW |
| M6 | `ventures_control_plane.sql` | `venture_goals`, `venture_runs`, `venture_connections`; `alter studio_projects add venture_id, version`; `alter studio_deployments add venture_id, goal_id, is_production, adapter` | A1 | NEW |

**Ordering notes:** M5 must precede M6 (`venture_goals`/`venture_runs` FKs are referenced by
`venture_checkpoints`/`venture_events` defined in M5, so those two FK columns are added by M6
once the targets exist — or M5 defines them nullable and M6 attaches the FK; either is
idempotent). The `studio_*` alters in M6 require `ventures` (M5) to exist for the `venture_id`
FK. `audit_log` (M1) has no dependencies and ships first so the kill-switch and role changes
are auditable from day one.

**Rollback posture:** every migration is forward-only + idempotent; "rollback" is a new
forward migration (drop the added column/table), never an in-place edit — so applied state is
always reproducible.

---

## 26.14 RLS coverage & data-retention notes

**RLS coverage policy — every table, no exceptions:**

| Table | RLS anchor | Policy shape |
|---|---|---|
| `ventures`, `venture_connections`, `user_devices`, `sessions`, `user_settings` | `user_id` (root) | `for all using (auth.uid()=user_id)` |
| `venture_budgets`, `venture_goals`, `venture_runs`, `venture_checkpoints` | parent venture | `for all using (exists … v.user_id=auth.uid())` |
| `venture_events` | parent venture | `select` + `insert` only (append-only) |
| `studio_projects` / `_files` / `_versions` / `_runs` / `_deployments` | self / parent project | existing owner policies (unchanged) |
| `custom_agents` | `user_id` (+ public read) | existing |
| `mcp_servers` | `user_id` | existing |
| `audit_log` | none (admin-only) | RLS **enabled, deny-all** to clients; service-role reads |
| token ledger / billing | `user_id` | existing owner `select` |

The control plane (Epic A1) and worker write through the **service role** (bypasses RLS) but
**always scope queries by `venture_id` + `user_id`** in code; there are no cross-tenant reads
(Master Plan §5.1). The F6 CI check fails the build if a new table appears without a policy,
and the A9 tenant-isolation audit proves "user A cannot read user B" with an automated test +
`get_advisors`.

**Data retention:**

- **`venture_events` (highest volume):** the append-only audit and activity substrate. Keep
  **full fidelity ~90 days** hot in Postgres; beyond that, **roll older partitions to R2**
  (cheap, free-egress) as compressed JSONL, keeping a daily-aggregated summary in Postgres for
  long-range charts. Append-only + monotonic id makes this safe and replayable.
- **`audit_log`:** retain **≥ 1 year** (security/compliance), then archive to R2; never
  hard-delete within the retention window (it is the forensic record).
- **`venture_runs` / `venture_goals` / `venture_checkpoints`:** retained for the life of the
  Venture; on **archive** (not delete) the Venture they remain for history. Resolved/expired
  checkpoints stay (their resolution is auditable).
- **`sessions`:** prune **revoked/expired** rows after ~30 days (the audit fact lives in
  `audit_log`); active rows are kept until they expire or are revoked.
- **`venture_connections`:** retained while `active`; on revoke, keep the row (status
  `revoked`) for audit but the Nango secret is destroyed in Nango — we never held it.
- **Deletion vs archival:** deleting a **User** cascades (every `on delete cascade` FK to
  `auth.users`) — a true erasure path for GDPR/CCPA. Deleting a **Venture** is *archival* by
  product design (`on delete set null` on `studio_projects.venture_id`/`studio_deployments`)
  so a user never loses code by archiving a venture; hard venture deletion is an explicit,
  checkpoint-gated, audited admin action. **Secrets are never in these tables** — BYO
  credentials live only in Nango, so no row here is a secret-spill risk.
- **Backups:** Postgres PITR (Supabase) covers all tables; R2 archives are the cold tier for
  the append-only logs. DR specifics are §42.

---

## 26.15 Consistency check (this section vs the rest)

| Concern | This section realizes |
|---|---|
| Conceptual model (§09) | Every §09 entity → a table or an explicit "logical/code" note (Tick = events; Adapter = code). |
| A0 brakes | `ventures`, `venture_budgets`, `venture_checkpoints`, `venture_events` (+ `audit_log`, kill-switch audited). |
| A1 control plane | `venture_goals`, `venture_runs`, `venture_connections`; `venture_id` on `studio_projects`/`studio_deployments`. |
| F0 | `audit_log` (append-only, admin-only, `request_id` trace tie). |
| F3 | `user_devices` (the missing migration) + `sessions` (timeouts, step-up). |
| F6 | Supabase migration runner, ordered list, idempotent DDL, RLS-coverage CI gate. |
| Reuse, don't replace (§06-DATA-MODEL) | studio tables unchanged except additive columns; Deployment extended, not new. |
| Secrets (§5.3) | `venture_connections` holds only a Nango reference; no plaintext anywhere. |

The schema above is the source the **data dictionary (§54)** is generated from; if a column
changes there, it changes in the migration first, then regenerates here and in §54 — DDL is
the single source of truth.
