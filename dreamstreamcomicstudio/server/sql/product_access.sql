-- Per-product access + Stream Studio settings sync.
--
-- 1) product_access generalizes stream_studio_access: an admin can onboard a
--    user to ANY single studio standalone (Stream Studio, Comic Studio, Chat
--    Studio) or revoke one. Semantics:
--      - no rows for a user            → default access (open beta, everything)
--      - rows present                  → the user's allowed products are exactly
--                                        the rows with active = true ("standalone")
--      - row with active = false       → that product is explicitly revoked
--    Writes are service-role only (same hardening as access_invites); users can
--    read their own rows so each app can gate itself client-side too.
--
-- 2) stream_studio_settings: the user's Stream Studio preferences (one jsonb
--    blob), synced across devices. RLS owner-locked.

create table if not exists public.product_access (
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null check (product in ('stream_studio', 'comic_studio', 'chat_studio')),
  active boolean not null default true,
  note text,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, product)
);

alter table public.product_access enable row level security;

drop policy if exists product_access_read_own on public.product_access;
create policy product_access_read_own on public.product_access
  for select
  using (auth.uid() = user_id);

revoke all on public.product_access from anon;
revoke insert, update, delete on public.product_access from authenticated;

-- Carry over any grants made through the earlier stream_studio_access table.
insert into public.product_access (user_id, product, active, note, granted_by, created_at)
select user_id, 'stream_studio', active, note, granted_by, created_at
from public.stream_studio_access
on conflict (user_id, product) do nothing;

create table if not exists public.stream_studio_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  prefs jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.stream_studio_settings enable row level security;

drop policy if exists stream_studio_settings_owner on public.stream_studio_settings;
create policy stream_studio_settings_owner on public.stream_studio_settings
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

revoke all on public.stream_studio_settings from anon;
