# 06 — Data Model (persistence & versioning)

Containers are **disposable**; the **project is durable**. We persist files + history in
Supabase so a sleeping/evicted container never loses work, and users can re-open, diff,
and restore. RLS owner-isolated, matching existing patterns (`server/sql/projects_rls_owner_isolation.sql`).

## New tables (Supabase Postgres)

```sql
-- One AI-built app.
create table studio_projects (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  template     text not null default 'react-ts',     -- react-ts | node-api | static | …
  github_repo  text,                                  -- "owner/repo" once linked
  deploy_url   text,                                  -- last deployed public URL
  current_version_id uuid,                            -- → studio_versions.id
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- The current file tree (one row per file).
create table studio_files (
  project_id   uuid not null references studio_projects(id) on delete cascade,
  path         text not null,                         -- "/src/App.tsx"
  content      text not null,
  language     text,
  updated_at   timestamptz not null default now(),
  primary key (project_id, path)
);

-- Snapshots / history (for diff + restore).
create table studio_versions (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references studio_projects(id) on delete cascade,
  label        text,                                  -- "build ✓", "before deploy", manual
  files        jsonb not null,                        -- {path: content} OR a storage ref if large
  created_by   text not null default 'agent',         -- agent | user
  created_at   timestamptz not null default now()
);

-- Each container session (metering + analytics).
create table studio_runs (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references studio_projects(id) on delete cascade,
  user_id       uuid not null,
  sandbox_id    text not null,                         -- u_<userId>_<projectId>
  status        text not null,                         -- starting|live|error|stopped|slept
  preview_url   text,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  awake_seconds integer,                               -- billed awake time
  cost_usd      numeric,                               -- computed compute cost
  metadata      jsonb
);

-- Deploy history.
create table studio_deployments (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references studio_projects(id) on delete cascade,
  target      text not null,                           -- cloudflare-pages | vercel | …
  url         text,
  status      text not null,                           -- queued|building|live|failed
  created_at  timestamptz not null default now()
);
```

## RLS (every table)
Owner-only: `using (auth.uid() = user_id)` for project-scoped tables (join through
`studio_projects` for child tables). Mirror `server/sql/projects_rls_owner_isolation.sql`.
Migrations go in `server/sql/` and are applied via the existing migration flow.

## File storage strategy
- **Small projects:** store file content directly in `studio_files` (Postgres). Cheap,
  simple, queryable.
- **Large files / binary assets:** store in **Cloudflare R2** (free egress, $0.015/GB)
  and keep a reference; serve images from R2 (see `07-INTEGRATIONS.md`).
- **Versions:** `files jsonb` inline for normal projects; spill to R2 for big ones.

## Lifecycle
1. First build → create `studio_project` + `studio_files` + first `studio_version`.
2. Each successful agent build → new `studio_version` (so history/diff/restore works).
3. Each container launch/stop → a `studio_run` row (powers cost display + analytics +
   `usageEnforcer` reconciliation).
4. Deploy → `studio_deployment` row; update `studio_projects.deploy_url`.

## Reuse / consistency
- Mirrors the existing `projects` / `artifacts` tables and RLS.
- `studio_runs.cost_usd` ties into the existing `token_ledger_entries` / `usageEnforcer`
  so studio compute shows up in the same billing/usage views.
- Existing `image_assets` + `comic-assets` storage bucket patterns inform the R2 setup.
