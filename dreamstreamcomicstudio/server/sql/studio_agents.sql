-- Phase 9 — custom agent library (persisted swarm specialists).
--
-- The swarm ships 8 read-only built-in agents (news, finance, weather, …). This lets a
-- user save their OWN specialists — a focused prompt + an allowlisted tool subset — and
-- reuse them across devices and sessions, instead of re-sending them as request-scoped
-- `extraAgents` each time. Built-ins are NOT stored here; they live in code and are
-- always available. RLS owner-isolated, same pattern as studio_projects: the API writes
-- via the service role, and these policies let a user read/manage their own rows.

create table if not exists public.custom_agents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  -- Stable slug used as the agent id in a swarm run (namespaced "custom_…" server-side).
  slug         text not null,
  name         text not null,
  description  text not null default '',
  system_prompt text not null,
  tool_names   jsonb not null default '[]'::jsonb,   -- string[] of allowlisted tool names
  -- Optional sharing: a user can mark an agent public so others can clone it (read-only).
  is_public    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, slug)
);
create index if not exists custom_agents_user_idx on public.custom_agents (user_id, updated_at desc);
create index if not exists custom_agents_public_idx on public.custom_agents (is_public) where is_public;

alter table public.custom_agents enable row level security;

-- Owners manage their own agents.
drop policy if exists custom_agents_owner on public.custom_agents;
create policy custom_agents_owner on public.custom_agents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Anyone authenticated may READ agents explicitly shared as public (for the library).
drop policy if exists custom_agents_public_read on public.custom_agents;
create policy custom_agents_public_read on public.custom_agents
  for select using (is_public);
