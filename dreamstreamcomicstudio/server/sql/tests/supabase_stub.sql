-- A minimal stand-in for the parts of Supabase that the Stream Studio SQL touches, so
-- server/sql/live_accounts_and_monitor.sql and live_security_v2.sql can be applied and
-- behaviour-checked on a plain local Postgres (see harness.mjs). NOT for any real database.
--
-- What it imitates:
--   * the anon / authenticated / service_role / supabase_auth_admin roles;
--   * auth.users, auth.sessions, auth.refresh_tokens, auth.mfa_factors (the columns we read);
--   * auth.jwt() and auth.uid(), driven by the `request.jwt.claims` setting exactly as PostgREST
--     sets it — a test "signs in" with set_config('request.jwt.claims', '{"sub":…}', false);
--   * Vault (vault.decrypted_secrets) and pg_net (net.http_post records its calls in net.calls).

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
do $$ begin create role supabase_auth_admin nologin; exception when duplicate_object then null; end $$;

create schema auth;
create schema extensions;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
-- Like Supabase: every new function in public is executable by the API roles unless revoked,
-- so a function that forgets its revoke shows up in member_rpc_guards' catalogue check.
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz default now(),
  raw_user_meta_data jsonb default '{}'
);
create type auth.factor_status as enum ('unverified', 'verified');
create table auth.mfa_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  status auth.factor_status,
  factor_type text default 'totp'
);
create table auth.sessions (
  id uuid primary key,
  user_id uuid references auth.users on delete cascade,
  created_at timestamptz default now(),
  user_agent text,
  ip inet,
  not_after timestamptz
);
create table auth.refresh_tokens (
  id bigserial primary key,
  session_id uuid references auth.sessions on delete cascade
);

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt()->>'sub', '')::uuid
$$;
grant execute on function auth.jwt() to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- The main app's profiles table (live__default_name reads its username).
create table public.profiles (id uuid primary key, username text, email text);

create schema vault;
create table vault.secrets (name text, decrypted_secret text);
create view vault.decrypted_secrets as select * from vault.secrets;

create schema net;
create table net.calls (id bigserial primary key, url text, body jsonb, headers jsonb);
create function net.http_post(
  url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000
) returns bigint language plpgsql as $$
begin
  insert into net.calls (url, body, headers) values (url, body, headers);
  return 1;
end $$;
