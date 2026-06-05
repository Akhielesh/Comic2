-- Phase 10 — server-side MCP server registry.
--
-- Today a user's custom MCP servers live in browser localStorage (per-device, capped at
-- ~6, lost on cache clear). This persists them server-side so they sync across devices and
-- survive sessions. The API reads them per-request and wraps their tools into the agentic
-- loop. `headers` can hold auth (Bearer tokens) — treat the column as secret-bearing;
-- it is only ever read via the service role, never exposed to other users. RLS owner-isolated.

create table if not exists public.mcp_servers (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  name            text not null,
  url             text not null,                       -- https endpoint (SSRF-guarded on write)
  headers         jsonb not null default '{}'::jsonb,  -- optional auth/extra headers (secret-bearing)
  enabled         boolean not null default true,
  -- Health, updated by the per-server check: ok | error | unknown.
  health          text not null default 'unknown',
  last_checked_at timestamptz,
  -- Auto-disable after repeated failures so a dead server stops slowing every chat.
  fail_count      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, url)
);
create index if not exists mcp_servers_user_idx on public.mcp_servers (user_id, updated_at desc);

alter table public.mcp_servers enable row level security;

drop policy if exists mcp_servers_owner on public.mcp_servers;
create policy mcp_servers_owner on public.mcp_servers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
