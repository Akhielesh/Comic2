-- Autopilot — Epic A0 (brakes-first): governance foundation.
--
-- The minimum durable state needed to run the autonomous loop SAFELY: a Venture, its
-- Budget (hard caps + running spend), its Checkpoints (human-in-the-loop gate), and an
-- append-only Event audit trail. The loop engine + goals/runs come in A1/A2.
--
-- Conventions match server/sql/studio_runs.sql + projects_rls_owner_isolation.sql:
--   * The API/worker writes via the service role (bypasses RLS).
--   * RLS owner-SELECT policies let a signed-in user read ONLY their own rows.
--   * Every child table carries user_id for direct, cheap owner isolation.
-- Apply via the existing Supabase migration flow. Safe to run repeatedly (IF NOT EXISTS).

-- ---------------------------------------------------------------------------------------
-- ventures: one product/business the agents own.
-- ---------------------------------------------------------------------------------------
create table if not exists public.ventures (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  summary      text,
  scope        text,                                   -- approved scope (scope-guard reference)
  status       text not null default 'draft',          -- draft|roadmap_pending|active|paused|archived
  pause_reason text,                                    -- budget|checkpoint|kill|stuck|manual|null
  deploy_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists ventures_user_idx on public.ventures (user_id);
create index if not exists ventures_user_status_idx on public.ventures (user_id, status);

alter table public.ventures enable row level security;
drop policy if exists ventures_owner_select on public.ventures;
create policy ventures_owner_select on public.ventures
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------------------
-- venture_budgets: hard caps + running spend (one row per venture). The DECIDE gate reads
-- this BEFORE spending; the REFLECT step updates it AFTER. NULL cap = unlimited dimension.
-- ---------------------------------------------------------------------------------------
create table if not exists public.venture_budgets (
  venture_id              uuid primary key references public.ventures(id) on delete cascade,
  user_id                 uuid not null references auth.users(id) on delete cascade,
  usd_per_day             numeric,
  usd_total               numeric,
  max_tokens              bigint,
  max_container_minutes   integer,
  spent_usd_today         numeric not null default 0,
  spent_usd_total         numeric not null default 0,
  tokens_used             bigint  not null default 0,
  container_minutes_used  numeric not null default 0,
  day_anchor              date    not null default current_date,  -- for daily reset
  updated_at              timestamptz not null default now()
);

create index if not exists venture_budgets_user_idx on public.venture_budgets (user_id);

alter table public.venture_budgets enable row level security;
drop policy if exists venture_budgets_owner_select on public.venture_budgets;
create policy venture_budgets_owner_select on public.venture_budgets
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------------------
-- venture_checkpoints: the human-in-the-loop gate. Six kinds always require approval.
-- ---------------------------------------------------------------------------------------
create table if not exists public.venture_checkpoints (
  id          uuid primary key default gen_random_uuid(),
  venture_id  uuid not null references public.ventures(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null,        -- roadmap_approval|prod_deploy|spend_money|destructive|external_publish|scope_change
  status      text not null default 'open',  -- open|approved|denied|expired
  title       text not null,
  detail      text,
  goal_id     uuid,                 -- optional link to a venture_goal (added in A1)
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  expires_at  timestamptz
);

create index if not exists venture_checkpoints_venture_idx on public.venture_checkpoints (venture_id);
create index if not exists venture_checkpoints_open_idx
  on public.venture_checkpoints (user_id) where status = 'open';

alter table public.venture_checkpoints enable row level security;
drop policy if exists venture_checkpoints_owner_select on public.venture_checkpoints;
create policy venture_checkpoints_owner_select on public.venture_checkpoints
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------------------
-- venture_events: append-only audit trail (every sense/decision/action/spend). The writer
-- redacts secrets (ventures/events.ts). No UPDATE/DELETE policy — append + owner-read only.
-- ---------------------------------------------------------------------------------------
create table if not exists public.venture_events (
  id          uuid primary key default gen_random_uuid(),
  venture_id  uuid not null references public.ventures(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null,
  level       text not null default 'info',  -- info|warn|error
  message     text,
  data        jsonb,
  cost_usd    numeric,
  model       text,
  source      text not null default 'engine',
  created_at  timestamptz not null default now()
);

create index if not exists venture_events_venture_idx on public.venture_events (venture_id, created_at);
create index if not exists venture_events_user_idx on public.venture_events (user_id, created_at);

alter table public.venture_events enable row level security;
drop policy if exists venture_events_owner_select on public.venture_events;
create policy venture_events_owner_select on public.venture_events
  for select using (auth.uid() = user_id);
