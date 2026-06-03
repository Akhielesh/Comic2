-- Cross-device sync for the AI Chat Platform (sessions + projects).
-- One row per session/project, stored as JSONB so the client schema can evolve freely.
-- Until this migration is applied, the client falls back to local IndexedDB (no-op sync).

create table if not exists public.chat_sync (
  key text primary key,                 -- "session:<id>" or "project:<id>"
  user_id uuid references auth.users not null,
  kind text not null check (kind in ('session', 'project')),
  data jsonb not null,                  -- the full ChatSession / ChatProject blob
  updated_at timestamptz not null default now()
);

-- Enable RLS — each user only ever sees/writes their own rows.
alter table public.chat_sync enable row level security;

create policy "chat_sync_select_own"
  on public.chat_sync for select
  using (auth.uid() = user_id);

create policy "chat_sync_insert_own"
  on public.chat_sync for insert
  with check (auth.uid() = user_id);

create policy "chat_sync_update_own"
  on public.chat_sync for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "chat_sync_delete_own"
  on public.chat_sync for delete
  using (auth.uid() = user_id);

create index if not exists idx_chat_sync_user_id on public.chat_sync(user_id);
