-- Stream Studio — account-scoped cloud sync + access control.
--
-- 1) stream_studio_events: each signed-in user's events (id + hostKey live
--    here so the dashboard works from ANY device — fixes "my past sessions
--    are missing"). The hostKey is a capability secret: RLS locks every row
--    to its owner, and the anon key can never enumerate other users' rows.
--
-- 2) stream_studio_access: admin-managed onboarding. No row → user has
--    normal access. A row lets an admin (service role, like access_invites):
--      - revoke streaming        → active = false
--      - onboard a streaming-only user → scope = 'studio_only'
--        (the main app reads this to confine the account to /live.html;
--         the Stream Studio dashboard reads it to show the right framing)
--    Writes go through the service role only — same hardening pattern as
--    access_invites.sql.

create table if not exists public.stream_studio_events (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  host_key text not null,
  title text not null default 'Untitled stream',
  status text not null default 'idle' check (status in ('idle', 'live', 'paused', 'ended')),
  quality text,
  access text,
  cover integer not null default 0,
  scheduled_at_ms bigint,
  started_at_ms bigint,
  ended_at_ms bigint,
  created_at_ms bigint not null,
  peak_viewers integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists idx_stream_studio_events_user on public.stream_studio_events (user_id, created_at_ms desc);

alter table public.stream_studio_events enable row level security;

drop policy if exists stream_studio_events_owner on public.stream_studio_events;
create policy stream_studio_events_owner on public.stream_studio_events
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.stream_studio_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default true,
  scope text not null default 'full' check (scope in ('full', 'studio_only')),
  note text,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.stream_studio_access enable row level security;

-- Users may read their own grant; all writes are service-role only.
drop policy if exists stream_studio_access_read_own on public.stream_studio_access;
create policy stream_studio_access_read_own on public.stream_studio_access
  for select
  using (auth.uid() = user_id);

revoke insert, update, delete on public.stream_studio_access from anon, authenticated;

-- Hardening (applied 2026-06-11): RLS already blocks rows, but table-level
-- privileges for `anon` made these tables discoverable in the GraphQL schema.
-- Only signed-in users ever touch them, so drop anon entirely.
revoke all on public.stream_studio_events from anon;
revoke all on public.stream_studio_access from anon;
