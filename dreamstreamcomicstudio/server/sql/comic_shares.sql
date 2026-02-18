-- Comic Sharing System
-- Supports public links (login required to view) and private sharing
-- with email/username access control, time limits, and download protection.

create table if not exists public.comic_shares (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id),
  share_type text not null check (share_type in ('public', 'private')),
  share_token text unique not null default encode(gen_random_bytes(16), 'hex'),
  allowed_emails text[] default '{}',
  allowed_usernames text[] default '{}',
  expires_at timestamptz,
  allow_download boolean default false,
  allow_reshare boolean default false,
  created_at timestamptz default now(),
  revoked_at timestamptz
);

-- Index for fast token lookups
create index if not exists idx_comic_shares_token on public.comic_shares (share_token);
create index if not exists idx_comic_shares_project on public.comic_shares (project_id);

-- RLS
alter table public.comic_shares enable row level security;

-- Owner can do everything
drop policy if exists shares_owner_all on public.comic_shares;
create policy shares_owner_all on public.comic_shares
  for all to authenticated
  using (owner_id = auth.uid());

-- Recipients can read public shares or shares where their email is allowed
drop policy if exists shares_recipient_read on public.comic_shares;
create policy shares_recipient_read on public.comic_shares
  for select to authenticated
  using (
    revoked_at is null
    and (expires_at is null or expires_at > now())
    and (
      share_type = 'public'
      or auth.jwt()->>'email' = any(allowed_emails)
    )
  );
