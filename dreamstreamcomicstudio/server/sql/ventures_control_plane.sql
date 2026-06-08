-- Autopilot — Epic A1 (control plane): goals, runs, connections + links to studio tables.
-- Additive + non-destructive (CREATE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS). Builds on
-- ventures_foundation.sql. Same conventions: service-role writes, RLS owner-SELECT, user_id
-- on every row for cheap isolation. Apply via the Supabase migration flow.

-- ---------------------------------------------------------------------------------------
-- venture_goals: the backlog/roadmap. One row per epic/feature/task/fix/chore.
-- ---------------------------------------------------------------------------------------
create table if not exists public.venture_goals (
  id          uuid primary key default gen_random_uuid(),
  venture_id  uuid not null references public.ventures(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  detail      text,
  kind        text not null default 'feature',   -- epic|feature|task|fix|chore
  status      text not null default 'proposed',  -- proposed|queued|in_progress|verifying|shipped|failed|blocked
  priority    integer not null default 100,      -- lower = higher priority
  depends_on  jsonb,                             -- optional array of goal ids
  project_id  uuid,                              -- link to studio_projects once built
  result      jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists venture_goals_venture_idx on public.venture_goals (venture_id, status, priority);
create index if not exists venture_goals_user_idx on public.venture_goals (user_id);
alter table public.venture_goals enable row level security;
drop policy if exists venture_goals_owner_select on public.venture_goals;
create policy venture_goals_owner_select on public.venture_goals
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------------------
-- venture_runs: one autonomous loop session (made of many ticks). Metering + analytics.
-- ---------------------------------------------------------------------------------------
create table if not exists public.venture_runs (
  id           uuid primary key default gen_random_uuid(),
  venture_id   uuid not null references public.ventures(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  status       text not null default 'starting',  -- starting|running|paused|completed|failed
  ticks        integer not null default 0,
  cost_usd     numeric not null default 0,
  pause_reason text,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  metadata     jsonb
);
create index if not exists venture_runs_venture_idx on public.venture_runs (venture_id, started_at);
create index if not exists venture_runs_active_idx on public.venture_runs (user_id) where ended_at is null;
alter table public.venture_runs enable row level security;
drop policy if exists venture_runs_owner_select on public.venture_runs;
create policy venture_runs_owner_select on public.venture_runs
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------------------
-- venture_connections: a user's BYO provider account (via Nango / PAT) for deploy adapters.
-- Stores only a reference (Nango connection id) — never a raw secret.
-- ---------------------------------------------------------------------------------------
create table if not exists public.venture_connections (
  id                   uuid primary key default gen_random_uuid(),
  venture_id           uuid not null references public.ventures(id) on delete cascade,
  user_id              uuid not null references auth.users(id) on delete cascade,
  provider             text not null,            -- cloudflare|vercel|railway|supabase|github
  nango_connection_id  text,
  status               text not null default 'connected',  -- connected|expired|revoked|error
  scopes               text,
  metadata             jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists venture_connections_venture_provider_idx
  on public.venture_connections (venture_id, provider);
create index if not exists venture_connections_user_idx on public.venture_connections (user_id);
alter table public.venture_connections enable row level security;
drop policy if exists venture_connections_owner_select on public.venture_connections;
create policy venture_connections_owner_select on public.venture_connections
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------------------
-- Link existing studio tables to a venture (nullable, additive — existing rows unaffected).
-- ---------------------------------------------------------------------------------------
alter table public.studio_projects    add column if not exists venture_id uuid;
alter table public.studio_deployments add column if not exists venture_id uuid;
create index if not exists studio_projects_venture_idx on public.studio_projects (venture_id);
create index if not exists studio_deployments_venture_idx on public.studio_deployments (venture_id);
