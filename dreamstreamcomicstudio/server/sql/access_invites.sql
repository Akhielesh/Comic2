-- Early-access / BYOK-tester invites.
--
-- The platform onboards testers via invite codes: an admin generates a batch of
-- codes (and shares them out-of-band), a signed-in user redeems one, and the
-- redemption is recorded. BYOK already works for any signed-in user, so an
-- "active tester" is simply someone who has redeemed an invite — queryable from
-- access_invite_redemptions without overloading the hardened user_roles table.
--
-- Both tables are write-only-by-service-role (RLS on, no anon/authenticated
-- policies, privileges revoked). The server validates + redeems with the service
-- role; codes must never be enumerable or forgeable by clients.

create table if not exists public.access_invites (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  label text,
  note text,
  status text not null default 'active' check (status in ('active', 'redeemed', 'revoked')),
  max_uses integer not null default 1 check (max_uses >= 1),
  use_count integer not null default 0 check (use_count >= 0),
  created_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_access_invites_code on public.access_invites (upper(code));
create index if not exists idx_access_invites_status on public.access_invites (status, created_at desc);

create table if not exists public.access_invite_redemptions (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null references public.access_invites(id) on delete cascade,
  code text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  redeemed_at timestamptz not null default now()
);

-- A given user redeems a given invite at most once.
create unique index if not exists idx_invite_redemption_unique on public.access_invite_redemptions (invite_id, user_id);
create index if not exists idx_invite_redemption_user on public.access_invite_redemptions (user_id, redeemed_at desc);

alter table public.access_invites enable row level security;
alter table public.access_invite_redemptions enable row level security;

revoke all on public.access_invites from anon, authenticated;
revoke all on public.access_invite_redemptions from anon, authenticated;
