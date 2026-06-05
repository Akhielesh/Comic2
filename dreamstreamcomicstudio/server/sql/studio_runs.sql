-- Studio v2 — Phase 2: container session metering.
--
-- One row per live-preview container session, used for per-user caps (concurrency +
-- daily minutes) and cost accounting. Phase 5 adds the rest of the data model
-- (studio_projects / files / versions / deployments) and links project_id to a real
-- project; for now project_id is a free-form id from the launch request.
--
-- The API writes via the service role (bypasses RLS); the SELECT policy lets a user read
-- their own runs directly from the client if needed.

create table if not exists public.studio_runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  project_id    text,
  sandbox_id    text not null,
  status        text not null default 'starting',     -- starting | live | error | stopped | slept
  preview_url   text,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  awake_seconds integer,
  cost_usd      numeric,
  metadata      jsonb
);

create index if not exists studio_runs_user_active_idx
  on public.studio_runs (user_id) where ended_at is null;
create index if not exists studio_runs_user_started_idx
  on public.studio_runs (user_id, started_at);

alter table public.studio_runs enable row level security;

drop policy if exists studio_runs_owner_select on public.studio_runs;
create policy studio_runs_owner_select
  on public.studio_runs for select
  using (auth.uid() = user_id);
