# 54 — Appendix C: Data Dictionary

> Part V · Delivery · Appendix · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> The field-level companion to [section 26 — Data model & schema](./26-data-model-schema.md).
> Realizes the conceptual entities in [section 09 — Domain model & glossary](./09-domain-model-glossary.md)
> and the existing studio substrate in [`../../06-DATA-MODEL.md`](../../06-DATA-MODEL.md).

## 54.1 What this is (and what it is not)

This appendix is the **column-by-column dictionary** for every table Autopilot touches. Where
section 26 gives the DDL, the RLS shape, the indexing rationale, and the migration ordering,
**this section is the flat reference** — one row per column, so an engineer wiring an API
handler, a reviewer auditing a policy, or an analyst writing a query can look up exactly what a
field is, its type, whether it can be null, its default, what it means, and what it references.

Three honesty rules carry over from §26, unchanged:

1. **Shipped vs new is tagged on every table.** Each table heading is marked **EXISTS TODAY**
   (already in `server/sql/`, reused verbatim or with additive columns) or **NEW** (created by an
   Autopilot migration, with its epic). The venture layer (A0/A1) is `📋 planned` — we do not
   claim it is built; we *do* document the real studio and billing tables faithfully.
2. **DDL is the single source of truth.** This dictionary is *generated from* the migration files
   (§26.13). If a column changes, it changes in the migration first, then here and in §26 — docs
   must not drift from DDL. The conventions match
   [`server/sql/studio_projects.sql`](../../../../server/sql/studio_projects.sql) and
   [`server/sql/token_billing_foundation.sql`](../../../../server/sql/token_billing_foundation.sql).
3. **No secrets are columns.** No table below stores plaintext credentials. BYO provider secrets
   live only in Nango; `venture_connections` keeps a *reference*. `mcp_servers.headers` is the one
   secret-bearing column and is service-role-read-only by design.

**Conventions used in the tables below:**

- **Type** — the Postgres type as declared (`uuid`, `text`, `timestamptz`, `numeric(p,s)`,
  `bigint`, `integer`, `boolean`, `date`, `inet`, `jsonb`). `gen_random_uuid()` requires the
  `pgcrypto` extension (enabled by the foundation migrations).
- **Null?** — `NO` means `not null` is declared; `YES` means the column is nullable.
- **Default** — the column default, or `—` for none. `now()` / `current_date` are evaluated at
  insert.
- **References** — the foreign-key target and its delete behavior, or `—` if not a FK. `PK` marks
  the primary key; `UQ(...)` marks a participation in a unique constraint.
- Enumerated string columns (`status`, `kind`, `type`, …) carry their legal values in the
  description; the full value sets are consolidated in **§54.12 (enums & status values)**.

Tables are grouped: **new Autopilot/foundation tables** (§54.2–§54.11), then the **reused studio
and billing tables** (within their own sub-sections), then the **enums appendix** (§54.12).

---

## 54.2 `ventures` — NEW (A0)

**Purpose:** the root of the autonomy layer — one product/business the agents own end to end
(roadmap, backlog, budget, connections, deployments, audit trail). Root table, `user_id`-isolated.
A Venture **HAS one or more** `studio_projects`.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | Venture identifier; the FK target for all venture children. | PK |
| `user_id` | uuid | NO | — | Owning tenant; the RLS anchor (`auth.uid() = user_id`). | `auth.users(id)` ON DELETE CASCADE |
| `name` | text | NO | `'Untitled venture'` | Human-readable venture name. | — |
| `summary` | text | NO | `''` | Short description of the product/business. | — |
| `scope` | jsonb | NO | `'{}'` | Approved boundary the scope-guard enforces before ORIENT pursues a goal. | — |
| `success_metrics` | jsonb | NO | `'[]'` | Target metrics (`string[]` or `{metric,target}[]`). | — |
| `status` | text | NO | `'draft'` | Lifecycle state (§9.4): `draft \| roadmap_pending \| active \| paused \| archived`. | — |
| `pause_reason` | text | YES | — | Why a `paused` venture is paused: `budget \| checkpoint \| kill \| stuck`. | — |
| `autonomy_level` | text | NO | `'balanced'` | Policy knob (not a code path): `conservative \| balanced \| aggressive`. | — |
| `primary_project_id` | uuid | YES | — | The venture's primary studio project. | `studio_projects(id)` ON DELETE SET NULL |
| `deploy_url` | text | YES | — | Current live URL (managed or BYO). | — |
| `version` | integer | NO | `1` | F2 optimistic-concurrency counter; bumped per write. | — |
| `created_at` | timestamptz | NO | `now()` | Row creation time. | — |
| `updated_at` | timestamptz | NO | `now()` | Last update time. | — |

**Notes:** `primary_project_id` is `SET NULL` because a Venture outlives any single project;
deleting a Venture is *archival* by product design (no cascade-wipe of the user's code).

---

## 54.3 `venture_budgets` — NEW (A0) · 1:1 with a venture

**Purpose:** the spend brake. Read by the deterministic DECIDE gate **before** any spend; REFLECT
updates the rolling counters; breach pauses the venture. Spend caps are a security control. PK is
`venture_id`, which enforces the 1:1 relationship.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `venture_id` | uuid | NO | — | The venture this budget governs; PK enforces 1:1. | PK · `ventures(id)` ON DELETE CASCADE |
| `usd_per_day` | numeric(12,2) | NO | `5` | Hard daily USD cap. | — |
| `usd_total` | numeric(12,2) | NO | `50` | Hard lifetime USD cap. | — |
| `max_tokens` | bigint | NO | `5000000` | Hard lifetime token cap. | — |
| `max_container_minutes` | integer | NO | `600` | Hard lifetime container-minute cap. | — |
| `spent_usd_today` | numeric(12,6) | NO | `0` | Rolling USD spent today; rolls on date change. | — |
| `spent_usd_total` | numeric(12,6) | NO | `0` | Rolling lifetime USD spent. | — |
| `tokens_used_total` | bigint | NO | `0` | Rolling lifetime tokens consumed. | — |
| `container_minutes_used` | integer | NO | `0` | Rolling lifetime container minutes consumed. | — |
| `day_cycle_date` | date | NO | `current_date` | Date the daily counter belongs to; the daily roll resets `spent_usd_today` when this changes. | — |
| `alert_80_sent_at` | timestamptz | YES | — | Dedupe timestamp for the 80%-spend alert (A7). | — |
| `updated_at` | timestamptz | NO | `now()` | Last counter update (at REFLECT). | — |

**Notes:** defaults are deliberately conservative (managed hosting carries our cost). The counter
update and daily roll are transactional so concurrent ticks cannot double-spend.

---

## 54.4 `venture_checkpoints` — NEW (A0)

**Purpose:** a human-approval gate before an irreversible/sensitive action — the human-in-the-loop
brake. Six types (Master Plan §8). The partial `open` index *is* the Approval Queue query.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | Checkpoint identifier. | PK |
| `venture_id` | uuid | NO | — | Owning venture; RLS anchor (via parent). | `ventures(id)` ON DELETE CASCADE |
| `type` | text | NO | — | What needs approval: `prod_deploy \| spend \| destructive \| publish \| scope \| roadmap`. | — |
| `status` | text | NO | `'open'` | Lifecycle (§9.4): `open \| approved \| denied \| expired`. | — |
| `context` | jsonb | NO | `'{}'` | What/why payload the Console renders for the decision. | — |
| `blocks_goal_id` | uuid | YES | — | Goal blocked until this resolves. | `venture_goals(id)` ON DELETE SET NULL |
| `blocks_run_id` | uuid | YES | — | Run blocked until this resolves. | `venture_runs(id)` ON DELETE SET NULL |
| `expires_at` | timestamptz | YES | — | TTL; on pass with no action the checkpoint auto-expires. | — |
| `resolved_by` | uuid | YES | — | Owner who approved/denied (must be the venture owner). | `auth.users(id)` |
| `resolution_note` | text | YES | — | Optional note recorded at resolution. | — |
| `created_at` | timestamptz | NO | `now()` | When the checkpoint was raised. | — |
| `resolved_at` | timestamptz | YES | — | When the checkpoint was approved/denied/expired. | — |

**Notes:** `blocks_*` FKs are `SET NULL` so resolution history survives goal/run cleanup.
`approved` unblocks the goal/run; `denied`/`expired` keep it blocked. Every resolution also writes
a `venture_events` row for audit.

---

## 54.5 `venture_events` — NEW (A0) · append-only

**Purpose:** the single source of truth for "what is my agent doing?" — and the substrate from
which **Ticks** and the live activity stream are derived (there is no Tick table). Append-only:
read + insert only via RLS; never updated or deleted by users.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `id` | bigint | NO | `generated always as identity` | Monotonic event id; cheap SSE cursor and ordering key. | PK |
| `venture_id` | uuid | NO | — | Owning venture; RLS anchor (via parent). | `ventures(id)` ON DELETE CASCADE |
| `run_id` | uuid | YES | — | The Run this event belongs to (if any). | `venture_runs(id)` ON DELETE SET NULL |
| `goal_id` | uuid | YES | — | The Goal this event concerns (if any). | `venture_goals(id)` ON DELETE SET NULL |
| `tick_number` | integer | YES | — | Correlates a span of events into one logical Tick. | — |
| `kind` | text | NO | — | Event kind: `sense \| orient \| decide \| act \| verify \| ship \| reflect \| checkpoint \| budget \| error`. | — |
| `summary` | text | NO | `''` | Short human-readable line for the activity stream. | — |
| `payload` | jsonb | NO | `'{}'` | Structured detail for the event. | — |
| `cost_usd` | numeric(12,6) | YES | — | USD cost attributed to this event (LLM/compute step). | — |
| `model` | text | YES | — | Model that produced an LLM step. | — |
| `prompt_hash` | text | YES | — | Hash for explainability without persisting the raw prompt. | — |
| `created_at` | timestamptz | NO | `now()` | Append time. | — |

**Notes:** the `bigint` identity PK (not uuid) gives a cheap monotonic cursor for the SSE stream
and keeps the hot append path index-friendly. This is the highest-volume table and the prime
candidate for monthly partitioning + R2 cold storage (§26.14). RLS deliberately omits
UPDATE/DELETE policies, making the table append-only even to the owner via the client.

---

## 54.6 `venture_goals` — NEW (A1)

**Purpose:** one backlog/roadmap item (epic → feature → task); the atomic unit of *intent* a Run
executes. The `(venture_id, status, priority)` index serves both the Console board and the loop's
"next goal" pick.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | Goal identifier. | PK |
| `venture_id` | uuid | NO | — | Owning venture; RLS anchor (via parent). | `ventures(id)` ON DELETE CASCADE |
| `parent_goal_id` | uuid | YES | — | Parent in the epic → feature → task tree. | `venture_goals(id)` ON DELETE CASCADE |
| `title` | text | NO | — | Goal title. | — |
| `detail` | text | NO | `''` | Longer description / acceptance notes. | — |
| `kind` | text | NO | `'task'` | Granularity: `epic \| feature \| task \| fix \| chore`. | — |
| `status` | text | NO | `'proposed'` | Lifecycle (§9.4): `proposed \| queued \| in_progress \| verifying \| blocked \| shipped \| failed \| dropped \| deferred`. | — |
| `priority` | integer | NO | `100` | Sort key; lower = sooner. | — |
| `dependencies` | jsonb | NO | `'[]'` | Other goal ids that must complete first (checked at DECIDE). | — |
| `estimate` | text | YES | — | Rough sizing (t-shirt). | — |
| `result` | jsonb | YES | — | Outcome payload (version id, deploy id, notes). | — |
| `block_reason` | text | YES | — | Why a `blocked` goal is blocked: `stuck \| checkpoint`. | — |
| `created_at` | timestamptz | NO | `now()` | Row creation time. | — |
| `updated_at` | timestamptz | NO | `now()` | Last update time. | — |

**Notes:** `shipped`/`failed`/`dropped` are terminal (a follow-up is a *new* goal).
`parent_goal_id` self-FK cascades on parent delete. `dependencies` as `jsonb` (not a join table)
keeps the model lean for realistic backlog sizes.

---

## 54.7 `venture_runs` — NEW (A1)

**Purpose:** one bounded autonomous *session* of the loop on a Venture — the schedulable,
restart-survivable container for many Ticks. Distinct from `studio_runs` (a single sandbox
session); a venture Run *references* the `studio_runs` it spawns.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | Run identifier. | PK |
| `venture_id` | uuid | NO | — | Owning venture; RLS anchor (via parent). | `ventures(id)` ON DELETE CASCADE |
| `status` | text | NO | `'starting'` | Lifecycle (§9.4): `starting \| running \| paused \| completed \| failed`. | — |
| `stop_reason` | text | YES | — | Why the run stopped: `completed \| budget \| kill \| stuck \| checkpoint`. | — |
| `ticks_count` | integer | NO | `0` | Number of Ticks executed in this run. | — |
| `max_ticks` | integer | NO | `50` | Per-run Tick bound — no infinite runs. | — |
| `tokens_used` | bigint | NO | `0` | Tokens consumed by this run. | — |
| `cost_usd` | numeric(12,6) | NO | `0` | USD cost attributed to this run. | — |
| `studio_run_ids` | jsonb | NO | `'[]'` | Container sessions (`studio_runs.id`) this run drove; ties cost to metering. | — |
| `started_at` | timestamptz | NO | `now()` | Run start time. | — |
| `ended_at` | timestamptz | YES | — | Run end time; `null` = active (scheduler picks these). | — |
| `last_tick_at` | timestamptz | YES | — | Heartbeat; drives the stuck/idle timeout. | — |

**Notes:** `max_ticks` + `last_tick_at` are the bounds that make "never stop" *safe*. A crash
mid-Tick resumes from durable state on the next schedule; the scheduler reads active runs via the
partial `where ended_at is null` index.

---

## 54.8 `venture_connections` — NEW (A1)

**Purpose:** a user's bring-your-own provider account (Cloudflare / Vercel / Supabase / Railway /
GitHub), linked via Nango/OAuth/PAT and consumed by Adapters to deploy to the user's own cloud.
Root table, `user_id`-isolated. **No plaintext secrets** — only a Nango reference.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | Connection identifier. | PK |
| `user_id` | uuid | NO | — | Owning tenant; RLS anchor. | `auth.users(id)` ON DELETE CASCADE · UQ(user_id, provider, nango_connection_id) |
| `provider` | text | NO | — | Provider: `cloudflare \| vercel \| supabase \| railway \| github`. | UQ(user_id, provider, nango_connection_id) |
| `nango_connection_id` | text | NO | — | **Reference only** — secret material lives in Nango, never here. | UQ(user_id, provider, nango_connection_id) |
| `label` | text | NO | `''` | User-friendly connection label. | — |
| `scopes` | jsonb | NO | `'[]'` | Least-privilege scopes granted. | — |
| `status` | text | NO | `'active'` | Connection state: `active \| revoked \| error`. | — |
| `last_used_at` | timestamptz | YES | — | Last time an adapter used this connection. | — |
| `metadata` | jsonb | NO | `'{}'` | Account id, region — **never secrets**. | — |
| `created_at` | timestamptz | NO | `now()` | Row creation time. | — |
| `updated_at` | timestamptz | NO | `now()` | Last update time. | — |

**Notes:** the unique constraint prevents duplicate links. Revocation flips `status` to `revoked`
and revokes the underlying Nango connection; the row is retained for audit. Reuses
`server/src/ai/tools/nango.ts`. A Connection is owned by the User and *bound* to a Venture only at
deploy time (the conceptual N:M).

---

## 54.9 `user_devices` — NEW (F3)

**Purpose:** the authoritative device registry. F3 notes the registry exists in code
(`services/deviceSessions.ts`) but has **no migration**, so it is not authoritative; this table
makes it real so "sign out this device" truly invalidates a session. Root table, `user_id`-isolated.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | Device identifier. | PK · UQ(user_id, id) |
| `user_id` | uuid | NO | — | Owning tenant; RLS anchor. | `auth.users(id)` ON DELETE CASCADE · UQ(user_id, id) |
| `device_label` | text | NO | `''` | Friendly label, e.g. "Chrome on macOS". | — |
| `user_agent` | text | YES | — | Captured user-agent string. | — |
| `last_ip` | inet | YES | — | Last seen IP address. | — |
| `last_seen_at` | timestamptz | NO | `now()` | Last activity from this device. | — |
| `trusted` | boolean | NO | `false` | Skip step-up re-auth on trusted devices. | — |
| `revoked_at` | timestamptz | YES | — | Set on "sign out this device"; also kills the refresh token. | — |
| `created_at` | timestamptz | NO | `now()` | First registration time. | — |

**Notes:** revoking a device sets `revoked_at` *and* calls the Supabase admin API to kill that
device's refresh token (the F3 gap). In F4 a `UserCoordinatorDO` pushes the revocation instantly
over WebSocket.

---

## 54.10 `sessions` — NEW (F3)

**Purpose:** first-party session records layered on the Supabase JWT to add idle + absolute
timeouts, session/device binding, and step-up re-auth — none of which the bare JWT provides. Root
table, `user_id`-isolated.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | Session identifier. | PK |
| `user_id` | uuid | NO | — | Owning tenant; RLS anchor. | `auth.users(id)` ON DELETE CASCADE |
| `device_id` | uuid | YES | — | Device this session is bound to. | `user_devices(id)` ON DELETE SET NULL |
| `created_at` | timestamptz | NO | `now()` | Session creation time. | — |
| `last_active_at` | timestamptz | NO | `now()` | Last activity timestamp. | — |
| `idle_expires_at` | timestamptz | NO | — | Idle-timeout expiry; bumped on activity. | — |
| `absolute_expires_at` | timestamptz | NO | — | Hard cap regardless of activity. | — |
| `ip` | inet | YES | — | IP at session creation / activity. | — |
| `step_up_at` | timestamptz | YES | — | Last re-auth for sensitive actions (billing/deploy require recent). | — |
| `revoked_at` | timestamptz | YES | — | Set on revoke; `null` = active. | — |
| `revoke_reason` | text | YES | — | Why revoked: `logout \| admin \| timeout \| suspicious`. | — |

**Notes:** billing and deploy require a recent `step_up_at` (F3/F8). The `idle_expires_at` partial
index lets a cron sweep expire idle sessions cheaply. JWKS local verification (F3) replaces the
per-request `getUser()` round-trip; this table is the server-side authority over the verified JWT.

---

## 54.11 `audit_log` — NEW (F0) · append-only · admin-only

**Purpose:** the platform-wide security/admin audit log — role changes, project deletes, auth
events, deploys, kill-switch flips. Broader than `venture_events` and seeds Autopilot's audit
story. RLS is **enabled with no permissive policy** (deny-all to clients); reads go through an
admin route over the service role.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `id` | bigint | NO | `generated always as identity` | Monotonic audit id. | PK |
| `actor_id` | uuid | YES | — | Who performed the action; `null` = system/service. | `auth.users(id)` ON DELETE SET NULL |
| `target_user_id` | uuid | YES | — | The user the action targeted (if any). | `auth.users(id)` ON DELETE SET NULL |
| `action` | text | NO | — | Action key, e.g. `role.change \| project.delete \| auth.login \| deploy \| kill_switch`. | — |
| `resource` | text | YES | — | Affected resource, e.g. `"studio_project:<id>"`, `"venture:<id>"`. | — |
| `ip` | inet | YES | — | Source IP. | — |
| `request_id` | text | YES | — | F0 correlation id across logs/traces. | — |
| `detail` | jsonb | NO | `'{}'` | Structured detail for the audited action. | — |
| `created_at` | timestamptz | NO | `now()` | Append time. | — |

**Notes:** append-only (no UPDATE/DELETE). Retained ≥ 1 year then archived to R2 (§26.14);
never hard-deleted within the retention window — it is the forensic record.

---

## 54.12 `user_settings` — NEW* · thin preferences row

**Purpose:** a durable home for autonomy + notification defaults. Today preferences are scattered
(profile fields, localStorage, plan rows) with no dedicated table; the `*` flags it is partly
logical today. One row per user (PK is `user_id`). Kept thin and `jsonb`-extensible.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `user_id` | uuid | NO | — | Owning tenant; PK and RLS anchor (one row per user). | PK · `auth.users(id)` ON DELETE CASCADE |
| `default_autonomy_level` | text | NO | `'balanced'` | Default `autonomy_level` for new ventures: `conservative \| balanced \| aggressive`. | — |
| `notify_email` | boolean | NO | `true` | Send checkpoint/budget alerts by email. | — |
| `notify_in_app` | boolean | NO | `true` | Show checkpoint/budget alerts in-app. | — |
| `default_usd_per_day` | numeric(12,2) | NO | `5` | Prefilled daily budget for new ventures. | — |
| `preferences` | jsonb | NO | `'{}'` | UI/theme/misc, forward-compatible. | — |
| `updated_at` | timestamptz | NO | `now()` | Last update time. | — |

**Notes:** notification prefs gate the A7/A8 alert emails; `default_*` prefill the intake wizard.

---

## 54.13 Reused studio tables (EXISTS TODAY)

These are real (`server/sql/`). Autopilot reuses them as-is or with **additive** columns only; RLS
is already enabled and owner-isolated. Additive columns introduced by Autopilot are marked
**(+ NEW)**.

### `studio_projects` — EXISTS · **+ `venture_id`, + `version`**

**Purpose:** the durable per-app codebase row — one AI-built app. A Venture HAS one or more.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | Project identifier. | PK |
| `user_id` | uuid | NO | — | Owning tenant; RLS anchor. | `auth.users(id)` ON DELETE CASCADE |
| `name` | text | NO | `'Untitled app'` | Project name. | — |
| `template` | text | NO | `'react-ts'` | Scaffold template, e.g. `react-ts \| node-api \| static`. | — |
| `github_repo` | text | YES | — | Linked repo as `"owner/repo"`. | — |
| `deploy_url` | text | YES | — | Last deployed public URL. | — |
| `current_version_id` | uuid | YES | — | Pointer to the current snapshot. | → `studio_versions(id)` (logical) |
| `venture_id` **(+ NEW, A1)** | uuid | YES | — | Owning venture (nullable so the standalone studio still works). | `ventures(id)` ON DELETE SET NULL |
| `version` **(+ NEW, A1)** | integer | NO | `1` | F2 optimistic-concurrency counter; stale writes rejected. | — |
| `created_at` | timestamptz | NO | `now()` | Row creation time. | — |
| `updated_at` | timestamptz | NO | `now()` | Last update time. | — |

### `studio_files` — EXISTS · **unchanged**

**Purpose:** the current file tree, one row per file. RLS flows through the parent project. Large
blobs spill to R2 with a reference (§06).

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `project_id` | uuid | NO | — | Parent project; RLS anchor (via parent). | PK(project_id, path) · `studio_projects(id)` ON DELETE CASCADE |
| `path` | text | NO | — | File path, e.g. `"/src/App.tsx"`. | PK(project_id, path) |
| `content` | text | NO | — | File content (or an R2 reference if large). | — |
| `language` | text | YES | — | Detected language for editor/syntax. | — |
| `updated_at` | timestamptz | NO | `now()` | Last write time. | — |

### `studio_versions` — EXISTS · **unchanged**

**Purpose:** snapshots/history for diff + restore; a new version per successful ACT.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | Version identifier. | PK |
| `project_id` | uuid | NO | — | Parent project; RLS anchor (via parent). | `studio_projects(id)` ON DELETE CASCADE |
| `label` | text | YES | — | Snapshot label, e.g. "build ✓", "before deploy". | — |
| `files` | jsonb | NO | — | `{ path: content }` snapshot (or an R2 ref if large). | — |
| `created_by` | text | NO | `'agent'` | Author: `agent \| user`. | — |
| `created_at` | timestamptz | NO | `now()` | Snapshot time. | — |

### `studio_runs` — EXISTS · **unchanged**

**Purpose:** per-container-session metering (cost, awake time). Not the same as a `venture_runs`
row; the venture tag is reached through `project_id → studio_projects.venture_id`.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | Run (container session) identifier. | PK |
| `project_id` | uuid | NO | — | Parent project; RLS anchor (via parent). | `studio_projects(id)` ON DELETE CASCADE |
| `user_id` | uuid | NO | — | Owning tenant (denormalized for owner SELECT). | `auth.users(id)` (logical) |
| `sandbox_id` | text | NO | — | Container id, e.g. `u_<userId>_<projectId>`. | — |
| `status` | text | NO | — | Container state: `starting \| live \| error \| stopped \| slept`. | — |
| `preview_url` | text | YES | — | Live preview URL. | — |
| `started_at` | timestamptz | NO | `now()` | Container start time. | — |
| `ended_at` | timestamptz | YES | — | Container stop time. | — |
| `awake_seconds` | integer | YES | — | Billed awake time. | — |
| `cost_usd` | numeric | YES | — | Computed compute cost; feeds Budget spend. | — |
| `metadata` | jsonb | YES | — | Misc run metadata. | — |

### `studio_deployments` — EXISTS · **+ `venture_id`, + `goal_id`, + `is_production`, + `adapter`**

**Purpose:** deploy history. Deployment is **reused + extended, not a new table**; all adapters
write here. RLS flows through the parent project.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | Deployment identifier. | PK |
| `project_id` | uuid | NO | — | Parent project; RLS anchor (via parent). | `studio_projects(id)` ON DELETE CASCADE |
| `target` | text | NO | — | Deploy target, e.g. `cloudflare-pages \| vercel`. | — |
| `url` | text | YES | — | Deployed URL. | — |
| `status` | text | NO | `'queued'` | Lifecycle (§9.4): `queued \| building \| live \| failed \| rolledback`. | — |
| `venture_id` **(+ NEW, A1)** | uuid | YES | — | Owning venture. | `ventures(id)` ON DELETE SET NULL |
| `goal_id` **(+ NEW, A1)** | uuid | YES | — | Goal that produced this deploy. | `venture_goals(id)` ON DELETE SET NULL |
| `is_production` **(+ NEW, A1)** | boolean | NO | `false` | Production deploy (gated by the first-production Checkpoint). | — |
| `adapter` **(+ NEW, A1)** | text | YES | — | Adapter used: `managed-preview \| cloudflare-pages \| vercel \| railway`. | — |
| `created_at` | timestamptz | NO | `now()` | Row creation time. | — |

**Notes:** a production deployment cannot reach `building` until its first-production Checkpoint is
`approved` (enforced at SHIP, audited in `venture_events`).

### `custom_agents` — EXISTS · **unchanged**

**Purpose:** saved swarm specialists (a focused prompt + an allowlisted tool subset) reused across
devices. RLS owner + public-read for the library.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | Agent identifier. | PK |
| `user_id` | uuid | NO | — | Owning tenant; RLS anchor. | `auth.users(id)` ON DELETE CASCADE · UQ(user_id, slug) |
| `slug` | text | NO | — | Stable slug used as the agent id in a swarm run. | UQ(user_id, slug) |
| `name` | text | NO | — | Display name. | — |
| `description` | text | NO | `''` | Short description. | — |
| `system_prompt` | text | NO | — | The specialist's system prompt. | — |
| `tool_names` | jsonb | NO | `'[]'` | Allowlisted tool names (`string[]`). | — |
| `is_public` | boolean | NO | `false` | If true, readable by any authenticated user (clone). | — |
| `created_at` | timestamptz | NO | `now()` | Row creation time. | — |
| `updated_at` | timestamptz | NO | `now()` | Last update time. | — |

### `mcp_servers` — EXISTS · **unchanged**

**Purpose:** server-side MCP server registry, synced across devices. `headers` is secret-bearing
(service-role read only). RLS owner-isolated.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | Server identifier. | PK |
| `user_id` | uuid | NO | — | Owning tenant; RLS anchor. | `auth.users(id)` ON DELETE CASCADE · UQ(user_id, url) |
| `name` | text | NO | — | Display name. | — |
| `url` | text | NO | — | HTTPS endpoint (SSRF-guarded on write). | UQ(user_id, url) |
| `headers` | jsonb | NO | `'{}'` | Optional auth/extra headers — **secret-bearing**, never exposed to other users. | — |
| `enabled` | boolean | NO | `true` | Whether the server is active in the loop. | — |
| `health` | text | NO | `'unknown'` | Health: `ok \| error \| unknown`. | — |
| `last_checked_at` | timestamptz | YES | — | Last health check time. | — |
| `fail_count` | integer | NO | `0` | Consecutive failures; auto-disables a dead server. | — |
| `created_at` | timestamptz | NO | `now()` | Row creation time. | — |
| `updated_at` | timestamptz | NO | `now()` | Last update time. | — |

---

## 54.14 Reused billing & token tables (EXISTS TODAY)

The metering substrate (`server/sql/token_billing_foundation.sql`). Autopilot writes `venture_id`
into `metadata` and uses `project_id` for the studio link rather than altering the hot ledger —
**additive, no migration on the ledger**. Only the key tables consumed by per-venture spend
rollups are dictionaried here.

### `token_ledger_entries` — EXISTS · **tagged via `metadata`/`project_id`**

**Purpose:** the append-only ledger of every credit movement (charge/credit/reservation). Per-venture
spend = sum of entries tagged with that venture plus joined `studio_runs.cost_usd`.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | Ledger entry id. | PK |
| `user_id` | uuid | NO | — | Owning tenant; RLS anchor. | `auth.users(id)` ON DELETE CASCADE |
| `created_at` | timestamptz | NO | `now()` | Entry time. | — |
| `entry_type` | text | NO | — | Movement type (charge/credit/reservation/settlement). | — |
| `ct_delta` | integer | NO | `0` | Credit-token delta. | — |
| `usd_delta` | numeric(12,6) | NO | `0` | USD delta. | — |
| `provider_cost_usd` | numeric(12,6) | YES | — | Underlying provider cost. | — |
| `billable_usd` | numeric(12,6) | YES | — | Amount billed to the user. | — |
| `operation` | text | YES | — | Originating operation. | — |
| `provider` | text | YES | — | AI provider. | — |
| `model` | text | YES | — | Model used. | — |
| `project_id` | text | YES | — | Studio project link (text id). | — |
| `reservation_id` | uuid | YES | — | Links a reservation to its settlement. | — |
| `is_byok` | boolean | NO | `false` | Bring-your-own-key (tracked, not charged). | — |
| `metadata` | jsonb | NO | `'{}'` | Extra detail; **Autopilot writes `venture_id` here**. | — |

### `token_wallets` — EXISTS · **unchanged** (one row per user)

**Purpose:** the per-user credit wallet — included/purchased/reserved/overage balances and daily
guardrail counters.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `user_id` | uuid | NO | — | Owning tenant; PK and RLS anchor. | PK · `auth.users(id)` ON DELETE CASCADE |
| `plan_tier` | text | NO | `'free'` | Current plan. | `billing_plans(id)` |
| `included_monthly_ct` | integer | NO | `0` | Monthly included credits. | — |
| `used_monthly_ct` | integer | NO | `0` | Credits used this cycle. | — |
| `purchased_ct` | integer | NO | `0` | Purchased credit balance. | — |
| `reserved_ct` | integer | NO | `0` | Credits reserved by in-flight ops. | — |
| `overage_ct` | integer | NO | `0` | Credits consumed beyond included+purchased. | — |
| `daily_guardrail_ct` | integer | NO | `0` | Daily spend guardrail. | — |
| `used_daily_ct` | integer | NO | `0` | Credits used today. | — |
| `daily_cycle_date` | date | NO | `current_date` | Date the daily counter belongs to. | — |
| `cycle_starts_at` | timestamptz | NO | `date_trunc('month', now())` | Monthly cycle start. | — |
| `cycle_ends_at` | timestamptz | NO | `+1 month` | Monthly cycle end. | — |
| `pending_overage_usd` | numeric(12,6) | NO | `0` | Accrued un-billed overage USD. | — |
| `auto_reload_enabled` | boolean | NO | `false` | Auto-purchase a pack at threshold. | — |
| `auto_reload_threshold_ct` | integer | NO | `5000` | Trigger threshold for auto-reload. | — |
| `auto_reload_pack_usd` | numeric(12,2) | NO | `25` | Auto-reload pack size in USD. | — |
| `overage_hard_cap_usd` | numeric(12,2) | NO | `100` | Hard ceiling on overage spend. | — |
| `created_at` | timestamptz | NO | `now()` | Row creation time. | — |
| `updated_at` | timestamptz | NO | `now()` | Last update time. | — |

### `generation_cost_events` — EXISTS · **unchanged**

**Purpose:** per-generation cost record (estimate vs actual) for analytics and reconciliation.

| Column | Type | Null? | Default | Description | References |
|---|---|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` | Event id. | PK |
| `user_id` | uuid | NO | — | Owning tenant; RLS anchor. | `auth.users(id)` ON DELETE CASCADE |
| `project_id` | text | YES | — | Studio project link. | — |
| `comic_id` | text | YES | — | Legacy comic link. | — |
| `operation` | text | NO | — | Operation name. | — |
| `stage` | text | YES | — | Pipeline stage. | — |
| `provider` | text | NO | — | AI provider. | — |
| `model` | text | NO | — | Model used. | — |
| `reservation_id` | uuid | YES | — | Links to the reservation. | — |
| `estimated_ct` | integer | NO | `0` | Estimated credits. | — |
| `actual_ct` | integer | NO | `0` | Actual credits. | — |
| `provider_cost_usd` | numeric(12,6) | NO | `0` | Provider cost. | — |
| `billable_usd` | numeric(12,6) | NO | `0` | Billed amount. | — |
| `is_byok` | boolean | NO | `false` | BYO-key flag. | — |
| `status` | text | NO | `'SETTLED'` | Settlement state, e.g. `SETTLED`. | — |
| `metadata` | jsonb | NO | `'{}'` | Extra detail. | — |
| `created_at` | timestamptz | NO | `now()` | Event time. | — |

**Related billing tables (not dictionaried in full):** `billing_plans` (plan catalog, public-read),
`user_plan_subscriptions` (per-user plan + Stripe subscription), `usage_daily_rollups` (per-user
daily aggregates), `model_pricing_snapshots` / `model_pricing_sources` / `pricing_changelog_entries`
(pricing sync), `payment_profiles` (Stripe customer + payment method), `stripe_webhook_events`
(idempotent webhook log). All carry RLS owner-`SELECT` (or public-read for the pricing/plan
catalogs); their DDL is the source of truth in `token_billing_foundation.sql`.

---

## 54.15 Enums & status values (appendix)

These are **convention-enforced** string values (stored as `text` with a default, validated in the
control plane / loop, not Postgres `enum` types — so they evolve without a type migration). The
authoritative state machines and their legal transitions are in [§09.4](./09-domain-model-glossary.md#94-state-machines).

| Domain | Column | Values | Terminal / notes |
|---|---|---|---|
| **Venture status** | `ventures.status` | `draft`, `roadmap_pending`, `active`, `paused`, `archived` | `archived` terminal; `paused` carries a `pause_reason`. |
| Venture pause reason | `ventures.pause_reason` | `budget`, `checkpoint`, `kill`, `stuck` | Set only while `status = paused`. |
| Autonomy level | `ventures.autonomy_level`, `user_settings.default_autonomy_level` | `conservative`, `balanced`, `aggressive` | Policy knob; never a code-path change. |
| **Goal status** | `venture_goals.status` | `proposed`, `queued`, `in_progress`, `verifying`, `blocked`, `shipped`, `failed`, `dropped`, `deferred` | `shipped`/`failed`/`dropped` terminal. |
| Goal kind | `venture_goals.kind` | `epic`, `feature`, `task`, `fix`, `chore` | Tree granularity. |
| Goal block reason | `venture_goals.block_reason` | `stuck`, `checkpoint` | Set only while `status = blocked`. |
| **Run status** | `venture_runs.status` | `starting`, `running`, `paused`, `completed`, `failed` | `completed`/`failed` terminal. |
| Run stop reason | `venture_runs.stop_reason` | `completed`, `budget`, `kill`, `stuck`, `checkpoint` | Why a run ended/paused. |
| **Checkpoint status** | `venture_checkpoints.status` | `open`, `approved`, `denied`, `expired` | `open` is the Approval Queue; others terminal. |
| **Checkpoint type** | `venture_checkpoints.type` | `prod_deploy`, `spend`, `destructive`, `publish`, `scope`, `roadmap` | The six gates (Master Plan §8). |
| **Event kind** | `venture_events.kind` | `sense`, `orient`, `decide`, `act`, `verify`, `ship`, `reflect`, `checkpoint`, `budget`, `error` | Loop-phase + control events. |
| Connection status | `venture_connections.status` | `active`, `revoked`, `error` | Partial index covers `active`. |
| Connection provider | `venture_connections.provider` | `cloudflare`, `vercel`, `supabase`, `railway`, `github` | BYO targets. |
| Adapter id | `studio_deployments.adapter` (and code) | `managed-preview`, `cloudflare-pages`, `cloudflare-workers`, `vercel`, `railway` | Code interface; `managed-preview` wraps the studio worker. |
| **Deployment status** | `studio_deployments.status` | `queued`, `building`, `live`, `failed`, `rolledback` | `rolledback` added per §9.4. |
| studio_runs status | `studio_runs.status` | `starting`, `live`, `error`, `stopped`, `slept` | Container session state. |
| Session revoke reason | `sessions.revoke_reason` | `logout`, `admin`, `timeout`, `suspicious` | Why a session was revoked. |
| Audit action | `audit_log.action` | `role.change`, `project.delete`, `auth.login`, `deploy`, `kill_switch`, … (open set) | Dotted action keys; extensible. |
| MCP health | `mcp_servers.health` | `ok`, `error`, `unknown` | From the per-server check. |
| Version author | `studio_versions.created_by` | `agent`, `user` | Who created the snapshot. |

**Why `text` not Postgres `enum`:** the loop and control plane evolve these value sets faster than
a schema migration cycle (a new checkpoint type, a new adapter); validating in code keeps the
table additive and idempotent (the §26.13 migration convention) and avoids `ALTER TYPE` locks.

---

## 54.16 Consistency check (this appendix vs §26 / §09)

| Concern | This appendix realizes |
|---|---|
| Every §26 table | A field-level dictionary entry: NEW Autopilot/foundation tables (§54.2–§54.12), reused studio tables (§54.13), key billing/token tables (§54.14). |
| §09 entities | Each conceptual entity → its table's columns; logical entities (Tick, Adapter) noted as code/derived, not rows. |
| §09.4 state machines | Every `status`/`type`/`kind` enum consolidated in §54.15, linked back to the canonical transitions. |
| Reuse, don't replace | Studio tables shown unchanged except additive columns marked **(+ NEW)**; Deployment extended, not new. |
| Secrets | `venture_connections` documented as reference-only; `mcp_servers.headers` flagged secret-bearing/service-role-only; no plaintext credential column anywhere. |
| Single source of truth | Dictionary derived from the migration DDL (§26.13); a column change lands in the migration first, then here and in §26. |

If a column changes in a migration, this appendix and §26 regenerate from it — the DDL, not the
prose, is canon.
