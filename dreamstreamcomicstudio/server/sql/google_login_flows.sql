-- Short-lived state for Google login. Apply before deploying the login API.
begin;
create table if not exists public.google_login_flows (
  id_hash text primary key check (id_hash ~ '^[0-9a-f]{64}$'),
  stage text not null check (stage in ('authorize', 'complete')),
  browser_challenge text not null check (browser_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  ciphertext text not null,
  iv text not null,
  expires_at timestamptz not null
);
create index if not exists google_login_flows_expiry on public.google_login_flows(expires_at);
alter table public.google_login_flows enable row level security;
revoke all on public.google_login_flows from public, anon, authenticated;
grant select, insert, delete on public.google_login_flows to service_role;
commit;
