-- Stream Studio security, v2 (ADR 0006 Phase 0, WS-4): session revocation, MFA (aal2)
-- enforcement, the account-level device registry, new-sign-in alerts with "Not you?",
-- and membership RPCs that say who changed.
--
-- APPLY ORDER / RE-APPLY RULE
-- ---------------------------
-- * Apply AFTER server/sql/live_accounts_and_monitor.sql. This file redefines EVERY member RPC
--   of that file — live_me, live_join, live_update_profile, live_search_people, monitor_list,
--   monitor_create, monitor_update, monitor_delete, monitor_people, monitor_member_ids,
--   monitor_my_role, monitor_set_member, monitor_remove_member — with the session and MFA
--   checks added (only live_welcome_check, which runs before an account exists, is left as it
--   is). If live_accounts_and_monitor.sql is ever re-applied, apply THIS file again straight
--   after it, or those checks silently disappear.
-- * Idempotent: safe to run twice (the WS-4 "done when"). Checked by the psql harness:
--   node server/sql/tests/harness.mjs (member_rpc_guards.test.sql fails if a live_*/monitor_*
--   function callable by signed-in clients skips the check).
-- * Nothing here changes behaviour for anyone until they enrol a TOTP factor (WS-5's UI), except
--   that a token whose session was revoked ("Sign out everywhere", "Not you?", a password
--   reset) stops working in every member RPC right away instead of at its expiry.
--
-- AFTER APPLYING (owner, ADR 0006 owner actions #3, #4, #5)
-- --------------------------------------------------------
-- 1. Vault secret shared with the email Worker (same value as its SECURITY_HOOK_SECRET):
--        select vault.create_secret('<random 32+ bytes, base64url>', 'SECURITY_HOOK_SECRET');
-- 2. Where the hook posts new-sign-in alerts (the email Worker's /security route):
--        insert into public.live_private_config (key, value)
--        values ('security_hook_url', 'https://<email worker host>/security')
--        on conflict (key) do update set value = excluded.value, updated_at = now();
-- 3. Dashboard → Authentication → Hooks → Customize Access Token (JWT) Claims →
--    Postgres function public.live_access_token_hook.
-- Without 1–2 the hook still adds the `ds_mfa` claim and records sign-ins (Settings shows
-- them); it just sends no email. Without pg_net (Database → Extensions) the same.
-- The emails are safe to switch on before WS-5's "Not you?" page (#/secure) exists: until the
-- email Worker's SECURE_ACCOUNT_PAGE var is "on", they carry no "Not you? Secure my account"
-- button — they send the person to Settings → Security (change password, sign out everywhere)
-- on the main site instead. Set SECURE_ACCOUNT_PAGE only once that page has shipped.
--
-- Security model (same conventions as live_accounts_and_monitor.sql)
-- -------------------------------------------------------------------
-- * Every table is RPC-only: RLS on, no client grants. Owner-only policies exist anyway so a
--   future grant could never expose another person's rows.
-- * SECURITY DEFINER with search_path = '' everywhere; functions return {ok:false, error}
--   rather than raising, so a refused call still commits what it must (e.g. audit rows).
-- * No raw tokens are stored: the "Not you?" token exists only in the email; the table keeps
--   its sha256. IP addresses are stored masked (/24, /48), never whole.
-- * The access-token hook can never block a sign-in: every side effect is wrapped, and a
--   failure only means no email.

create extension if not exists pgcrypto with schema extensions;

-- ===================================================================== helpers

-- Has this person turned on two-step sign-in (a verified MFA factor)?
create or replace function public.live__has_mfa(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_uid is not null and exists (
    select 1 from auth.mfa_factors f where f.user_id = p_uid and f.status = 'verified'
  );
$$;

-- What's wrong with the caller's session, if anything:
--   null              fine (or nobody signed in — callers handle that themselves)
--   'session_revoked' the token's session no longer exists (signed out everywhere, "Not you?",
--                     password reset, or an admin revoke) — the JWT alone is still unexpired
--   'mfa_required'    the person has a verified factor but this token is only aal1
create or replace function public.live__session_problem()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_sid uuid;
begin
  if v_uid is null then
    return null;
  end if;
  begin
    v_sid := nullif(auth.jwt()->>'session_id', '')::uuid;
  exception when others then
    v_sid := null;
  end;
  if v_sid is null or not exists (
    select 1 from auth.sessions s
    where s.id = v_sid and s.user_id = v_uid and (s.not_after is null or s.not_after > now())
  ) then
    return 'session_revoked';
  end if;
  if public.live__has_mfa(v_uid) and coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2' then
    return 'mfa_required';
  end if;
  return null;
end;
$$;

-- An address as we're willing to keep it: IPv4 to /24 ("203.0.113.x"), IPv6 to /48.
create or replace function public.live__mask_ip(p_ip inet)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_ip is null then null
    when family(p_ip) = 4 then regexp_replace(host(p_ip), '\.[0-9]+$', '.x')
    else host(network(set_masklen(p_ip, 48))) || '/48'
  end;
$$;

-- ============================================================ security events
-- One row per first sight of a session (kind 'sign_in'), plus account-level events. Parents'
-- per-nursery security log lives in the MonitorRoom; this is the account's own history.
create table if not exists public.security_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid,
  kind text not null,
  at timestamptz not null default now()
);
alter table public.security_events add column if not exists method text;
alter table public.security_events add column if not exists ua text;
alter table public.security_events add column if not exists ip_masked text;
alter table public.security_events add column if not exists notified boolean not null default false;
alter table public.security_events add column if not exists secure_hash text;
alter table public.security_events add column if not exists secure_used_at timestamptz;
alter table public.security_events add column if not exists detail jsonb;

alter table public.security_events drop constraint if exists security_events_kind_check;
alter table public.security_events add constraint security_events_kind_check
  check (kind in ('sign_in', 'secured', 'device_added', 'device_revoked'));
alter table public.security_events drop constraint if exists security_events_sizes_check;
alter table public.security_events add constraint security_events_sizes_check
  check ((ua is null or char_length(ua) <= 300)
     and (ip_masked is null or char_length(ip_masked) <= 64)
     and (method is null or char_length(method) <= 40));

-- "Seen this session before?" — the hook inserts with ON CONFLICT DO NOTHING on this.
create unique index if not exists security_events_session_uq
  on public.security_events (user_id, session_id) where kind = 'sign_in';
create index if not exists idx_security_events_user_at on public.security_events (user_id, at desc);
create unique index if not exists security_events_secure_hash_uq
  on public.security_events (secure_hash) where secure_hash is not null;

alter table public.security_events enable row level security;
revoke all on public.security_events from anon, authenticated;
drop policy if exists security_events_owner_read on public.security_events;
create policy security_events_owner_read on public.security_events
  for select to authenticated using (user_id = (select auth.uid()));

-- ============================================================ device registry
-- The account-level list of an account's phones, browsers and watches ("Your devices", sign
-- out everywhere, device grants for watches). Cameras have no account and live only in the
-- nursery's own roster (MonitorRoom mon_devices) — ADR 0006 D9 #9.
create table if not exists public.live_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  thumb text not null,
  platform text not null,
  name text not null,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  revoked_at timestamptz
);
alter table public.live_devices drop constraint if exists live_devices_shape_check;
alter table public.live_devices add constraint live_devices_shape_check
  check (thumb ~ '^[A-Za-z0-9_-]{43}$'
     and platform in ('web', 'ios', 'android', 'watchos', 'wearos')
     and char_length(name) between 1 and 40);
-- One live row per (account, hardware key); a revoked key must enrol again as a new row.
create unique index if not exists live_devices_active_thumb
  on public.live_devices (user_id, thumb) where revoked_at is null;
create index if not exists idx_live_devices_user on public.live_devices (user_id, created_at desc);

alter table public.live_devices enable row level security;
revoke all on public.live_devices from anon, authenticated;
drop policy if exists live_devices_owner_read on public.live_devices;
create policy live_devices_owner_read on public.live_devices
  for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.live__device_json(d public.live_devices)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', d.id,
    'platform', d.platform,
    'name', d.name,
    'thumb', d.thumb,
    'created_at', d.created_at,
    'last_seen', d.last_seen,
    'revoked_at', d.revoked_at
  );
$$;

-- Enrol (or refresh) this device's hardware key for the caller. Requires aal2 once MFA is on.
-- p_thumb is the RFC 7638 JWK thumbprint (base64url SHA-256) of the device's P-256 signing key.
create or replace function public.live_device_enroll(p_thumb text, p_platform text, p_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
  v_name text := left(regexp_replace(trim(coalesce(p_name, '')), '[[:cntrl:]<>]', '', 'g'), 40);
  v_row public.live_devices;
begin
  if v_uid is null or not public.live__is_member(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  if p_thumb is null or p_thumb !~ '^[A-Za-z0-9_-]{43}$' then
    return jsonb_build_object('ok', false, 'error', 'bad_key');
  end if;
  if p_platform is null or p_platform not in ('web', 'ios', 'android', 'watchos', 'wearos') then
    return jsonb_build_object('ok', false, 'error', 'bad_platform');
  end if;
  if char_length(v_name) = 0 then
    v_name := case p_platform
      when 'web' then 'Browser' when 'ios' then 'iPhone' when 'android' then 'Android phone'
      when 'watchos' then 'Apple Watch' else 'Wear OS watch' end;
  end if;

  update public.live_devices
     set name = v_name, platform = p_platform, last_seen = now()
   where user_id = v_uid and thumb = p_thumb and revoked_at is null
  returning * into v_row;
  if found then
    return jsonb_build_object('ok', true, 'created', false, 'device', public.live__device_json(v_row));
  end if;

  if (select count(*) from public.live_devices where user_id = v_uid and revoked_at is null) >= 20 then
    return jsonb_build_object('ok', false, 'error', 'limit_reached');
  end if;
  insert into public.live_devices (user_id, thumb, platform, name)
  values (v_uid, p_thumb, p_platform, v_name)
  returning * into v_row;
  insert into public.security_events (user_id, session_id, kind, detail)
  values (v_uid, nullif(auth.jwt()->>'session_id', '')::uuid, 'device_added',
          jsonb_build_object('device_id', v_row.id, 'platform', v_row.platform, 'name', v_row.name));
  return jsonb_build_object('ok', true, 'created', true, 'device', public.live__device_json(v_row));
end;
$$;

-- "Your devices": the caller's own devices (current, and revoked in the last 30 days).
create or replace function public.live_device_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'signed_out');
  end if;
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  return jsonb_build_object('ok', true, 'devices', coalesce((
    select jsonb_agg(public.live__device_json(d) order by d.revoked_at nulls first, d.last_seen desc)
    from public.live_devices d
    where d.user_id = v_uid and (d.revoked_at is null or d.revoked_at > now() - interval '30 days')
  ), '[]'::jsonb));
end;
$$;

-- Revoke one of the caller's devices. Returns the device (with its key thumbprint) so the
-- Worker can fan /x/device-revoked out to the nurseries and refuse its grant.
create or replace function public.live_device_revoke(p_device uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
  v_row public.live_devices;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'signed_out');
  end if;
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  select * into v_row from public.live_devices where id = p_device and user_id = v_uid for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_row.revoked_at is not null then
    return jsonb_build_object('ok', true, 'already', true, 'user_id', v_uid, 'device', public.live__device_json(v_row));
  end if;
  update public.live_devices set revoked_at = now() where id = v_row.id returning * into v_row;
  insert into public.security_events (user_id, session_id, kind, detail)
  values (v_uid, nullif(auth.jwt()->>'session_id', '')::uuid, 'device_revoked',
          jsonb_build_object('device_id', v_row.id, 'platform', v_row.platform, 'name', v_row.name));
  return jsonb_build_object('ok', true, 'already', false, 'user_id', v_uid, 'device', public.live__device_json(v_row));
end;
$$;

-- Is this device grant still good? Called by the Worker when a watch trades its grant for a
-- 10-minute access token — the watch holds no Supabase session, so this is callable without
-- one. It needs the device id AND its key thumbprint (unguessable together) and says only
-- whether it's active and, if so, whose it is (the Worker checks that against the grant's
-- `sub`). Notes last_seen at most every 5 minutes.
create or replace function public.live_device_active(p_device uuid, p_thumb text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.live_devices;
begin
  if p_device is null or p_thumb is null or p_thumb !~ '^[A-Za-z0-9_-]{43}$' then
    return jsonb_build_object('ok', true, 'active', false);
  end if;
  select * into v_row from public.live_devices
   where id = p_device and thumb = p_thumb and revoked_at is null;
  if not found or not public.live__is_member(v_row.user_id) then
    return jsonb_build_object('ok', true, 'active', false);
  end if;
  if v_row.last_seen < now() - interval '5 minutes' then
    update public.live_devices set last_seen = now() where id = v_row.id;
  end if;
  return jsonb_build_object('ok', true, 'active', true, 'user_id', v_row.user_id);
end;
$$;

-- The caller's recent security history (Settings → Security). Never returns token hashes.
create or replace function public.live_security_events(p_limit integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_sid uuid;
  v_problem text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'signed_out');
  end if;
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  v_sid := nullif(auth.jwt()->>'session_id', '')::uuid;
  return jsonb_build_object('ok', true, 'events', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', e.id,
      'kind', e.kind,
      'method', e.method,
      'ua', e.ua,
      'ip', e.ip_masked,
      'at', e.at,
      'this_session', e.session_id is not null and e.session_id = v_sid,
      'active', e.session_id is not null and exists (select 1 from auth.sessions s where s.id = e.session_id),
      'secured', e.secure_used_at is not null,
      'detail', e.detail
    ) order by e.at desc)
    from (
      select * from public.security_events
      where user_id = v_uid
      order by at desc
      limit greatest(1, least(coalesce(p_limit, 20), 100))
    ) e
  ), '[]'::jsonb));
end;
$$;

-- ================================================== new sign-in alerts (the hook)

-- Post one alert to the email Worker. Quietly does nothing until the owner has set the URL
-- (live_private_config 'security_hook_url'), the Vault secret and pg_net. Signs
-- `<unix seconds>.<payload>` with HMAC-SHA256; the payload travels as a JSON *string* inside
-- the body so its exact bytes survive pg_net's jsonb serialisation.
create or replace function public.live__send_signin_alert(p_uid uuid, p_event bigint, p_ua text, p_ip text, p_method text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_email text;
  v_name text;
  v_token text;
  v_payload text;
  v_ts text;
  v_sig text;
begin
  select value into v_url from public.live_private_config where key = 'security_hook_url';
  if v_url is null or v_url !~ '^https://[^[:space:]]+$' then
    return false;
  end if;
  if to_regnamespace('net') is null or to_regclass('vault.decrypted_secrets') is null then
    return false;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
    into v_secret using 'SECURITY_HOOK_SECRET';
  if coalesce(v_secret, '') = '' then
    return false;
  end if;
  select u.email into v_email from auth.users u where u.id = p_uid;
  if v_email is null or position('@' in v_email) = 0 then
    return false;
  end if;
  select lp.display_name into v_name from public.live_profiles lp where lp.user_id = p_uid;

  -- The one-time "Not you? Secure my account" token: 192 random bits, base64url. Only its
  -- sha256 is kept; live_secure_account() redeems it within 7 days.
  v_token := rtrim(translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_'), '=');
  update public.security_events
     set notified = true, secure_hash = encode(extensions.digest(v_token, 'sha256'), 'hex')
   where id = p_event;

  v_payload := jsonb_build_object(
    'v', 1,
    'kind', 'sign_in',
    'email', v_email,
    'name', v_name,
    'at', (extract(epoch from now()) * 1000)::bigint,
    'ua', p_ua,
    'ip', p_ip,
    'method', p_method,
    'token', v_token
  )::text;
  v_ts := (extract(epoch from now()))::bigint::text;
  v_sig := encode(extensions.hmac(v_ts || '.' || v_payload, v_secret, 'sha256'), 'hex');
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 5000)'
    using v_url,
          jsonb_build_object('p', v_payload),
          jsonb_build_object('Content-Type', 'application/json', 'x-ds-signature', 't=' || v_ts || ',v1=' || v_sig);
  return true;
end;
$$;

-- First sight of a session: record it; email the person if it's a genuinely new sign-in.
-- Not emailed: token refreshes (an existing session — including every session alive when the
-- hook is first switched on), anonymous sign-ins, an account's very first session (its
-- sign-up), and more than 5 alerts an hour per account (recorded, not sent).
-- Deliberately NOT skipped: a sign-in whose browser and (masked) network match an earlier one.
-- User-agent strings are shared by millions and a /24 by a whole household or carrier, so that
-- would silence exactly the intruder a baby monitor most needs to catch — someone on the same
-- Wi-Fi. The email therefore says "a new sign-in", never "a device we haven't seen".
create or replace function public.live__note_session(p_uid uuid, p_sid uuid, p_method text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_method text := left(coalesce(p_method, ''), 40);
  v_ua text;
  v_ip inet;
  v_created timestamptz;
  v_id bigint;
  v_ipm text;
begin
  select left(s.user_agent, 300), s.ip, s.created_at into v_ua, v_ip, v_created
    from auth.sessions s where s.id = p_sid;
  v_ipm := public.live__mask_ip(v_ip);

  insert into public.security_events (user_id, session_id, kind, method, ua, ip_masked)
  values (p_uid, p_sid, 'sign_in', nullif(v_method, ''), v_ua, v_ipm)
  on conflict (user_id, session_id) where kind = 'sign_in' do nothing
  returning id into v_id;
  if v_id is null then
    return; -- seen before
  end if;

  -- A refresh of a session that predates the hook is not a sign-in. Without a method (an older
  -- auth server), only a session created moments ago counts as one.
  if v_method in ('token_refresh', 'anonymous')
     or (v_method = '' and (v_created is null or v_created < now() - interval '5 minutes')) then
    return;
  end if;
  -- The account's first session ever (its sign-up) is the baseline, not news.
  if not exists (select 1 from public.security_events e where e.user_id = p_uid and e.kind = 'sign_in' and e.id <> v_id)
     and not exists (select 1 from auth.sessions s where s.user_id = p_uid and s.id <> p_sid) then
    return;
  end if;
  if (select count(*) from public.security_events e
       where e.user_id = p_uid and e.kind = 'sign_in' and e.notified and e.at > now() - interval '1 hour') >= 5 then
    return;
  end if;
  perform public.live__send_signin_alert(p_uid, v_id, v_ua, v_ipm, nullif(v_method, ''));
end;
$$;

-- Supabase Custom Access Token hook. Runs on every token issue (sign-in, MFA verify, refresh):
--   * adds `ds_mfa` (true when the person has a verified factor) so the Worker can demand
--     aal2 without asking the database;
--   * notes the session the first time it's seen and, for a new sign-in, emails the person.
-- It never blocks a sign-in: anything that fails only costs the email.
create or replace function public.live_access_token_hook(event jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := coalesce(event->'claims', '{}'::jsonb);
  v_uid uuid;
  v_sid uuid;
  v_mfa boolean := false;
begin
  begin
    v_uid := nullif(event->>'user_id', '')::uuid;
  exception when others then
    v_uid := null;
  end;
  if v_uid is null then
    return jsonb_build_object('claims', v_claims);
  end if;

  begin
    v_mfa := public.live__has_mfa(v_uid);
  exception when others then
    v_mfa := false;
  end;
  v_claims := jsonb_set(v_claims, '{ds_mfa}', to_jsonb(coalesce(v_mfa, false)), true);

  begin
    v_sid := nullif(v_claims->>'session_id', '')::uuid;
  exception when others then
    v_sid := null;
  end;
  if v_sid is not null then
    begin
      perform public.live__note_session(v_uid, v_sid, event->>'authentication_method');
    exception when others then
      raise warning 'live_access_token_hook: could not note the session (%)', sqlstate;
    end;
  end if;
  return jsonb_build_object('claims', v_claims);
end;
$$;

-- ==================================================== "Not you? Secure my account"
-- Redeems the one-time token from a new-sign-in email (single use, 7 days):
--   * ends every session of the account (refresh tokens go with them), so every device must
--     sign in again — and the Worker refuses their access tokens from the next check;
--   * revokes devices enrolled since that sign-in (an intruder's watch or browser);
--   * records a 'secured' event.
-- Callable without a session (the person may be locked out). The backend's
-- POST /api/auth/email/secure calls it with the service role and then emails a password-reset
-- link; only that caller gets the address back, everyone else gets a masked hint.
create or replace function public.live_secure_account(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ev public.security_events;
  v_sessions integer := 0;
  v_devices jsonb;
  v_email text;
  v_hint text;
  v_service boolean := coalesce(auth.jwt()->>'role', '') = 'service_role';
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{20,128}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  select * into v_ev from public.security_events
   where secure_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if v_ev.secure_used_at is not null then
    return jsonb_build_object('ok', false, 'error', 'used', 'secured_at', v_ev.secure_used_at);
  end if;
  if v_ev.at < now() - interval '7 days' then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  update public.security_events set secure_used_at = now() where id = v_ev.id;
  begin
    delete from auth.sessions where user_id = v_ev.user_id;
    get diagnostics v_sessions = row_count;
  exception when others then
    -- Never pretend: report that sign-out everywhere didn't happen (the token stays spent so
    -- it can't be replayed; the reset email still goes out).
    raise warning 'live_secure_account: could not end sessions (%)', sqlstate;
    v_sessions := -1;
  end;
  with gone as (
    update public.live_devices
       set revoked_at = now()
     where user_id = v_ev.user_id and revoked_at is null and created_at >= v_ev.at - interval '1 minute'
    returning id, thumb
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'thumb', thumb)), '[]'::jsonb) into v_devices from gone;
  insert into public.security_events (user_id, kind, detail)
  values (v_ev.user_id, 'secured', jsonb_build_object('from_event', v_ev.id, 'sessions', v_sessions, 'devices', jsonb_array_length(v_devices)));

  select u.email into v_email from auth.users u where u.id = v_ev.user_id;
  v_hint := case when v_email is null then null
                 else left(split_part(v_email, '@', 1), 1) || '•••@' || split_part(v_email, '@', 2) end;
  return jsonb_build_object('ok', true, 'sessions_ended', v_sessions, 'devices_revoked', v_devices, 'email_hint', v_hint)
    || case when v_service then jsonb_build_object('user_id', v_ev.user_id, 'email', v_email) else '{}'::jsonb end;
end;
$$;

-- ========================================= existing RPCs, now session + MFA aware
-- Bodies as in live_accounts_and_monitor.sql, plus the checks (see the re-apply rule above).

-- Who am I to Stream Studio? A revoked session reads as signed out; an MFA user on an aal1
-- token is told to finish the second step (`mfa_required`) rather than treated as a member.
create or replace function public.live_me()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
begin
  if v_uid is null then
    return jsonb_build_object('signed_in', false, 'member', false);
  end if;
  v_problem := public.live__session_problem();
  if v_problem = 'session_revoked' then
    return jsonb_build_object('signed_in', false, 'member', false, 'error', 'session_revoked');
  end if;
  if v_problem = 'mfa_required' then
    return jsonb_build_object('signed_in', true, 'member', false, 'user_id', v_uid,
      'error', 'mfa_required', 'mfa_required', true, 'needs_code', false);
  end if;
  if public.live__is_member(v_uid) then
    return jsonb_build_object('signed_in', true, 'member', true, 'user_id', v_uid,
      'profile', public.live__profile_json(v_uid),
      'mfa', public.live__has_mfa(v_uid),
      'aal', coalesce(auth.jwt()->>'aal', 'aal1'));
  end if;
  return jsonb_build_object('signed_in', true, 'member', false, 'user_id', v_uid,
    'needs_code', not public.live__legacy_eligible(v_uid),
    'suggested_name', public.live__default_name(v_uid));
end;
$$;

-- The live Worker's authorization check for a monitor socket (the connecting user's own token).
-- Adds `error` ('session_revoked' | 'mfa_required') on refusal, and `mfa`/`aal` on success so
-- the room's role cache knows to demand aal2 on later re-auths.
create or replace function public.monitor_my_role(p_nursery uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_problem text;
begin
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  v_role := public.monitor__role(p_nursery, v_uid);
  if v_role is null then
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object(
    'ok', true,
    'user_id', v_uid,
    'role', v_role,
    'label', (select label from public.monitor_members where nursery_id = p_nursery and user_id = v_uid),
    'display_name', (select display_name from public.live_profiles where user_id = v_uid),
    'nursery_name', (select name from public.monitor_nurseries where id = p_nursery),
    'baby_name', (select baby_name from public.monitor_nurseries where id = p_nursery),
    'mfa', public.live__has_mfa(v_uid),
    'aal', coalesce(auth.jwt()->>'aal', 'aal1')
  );
end;
$$;

-- Add someone (found by name) or change their role/label. Parents only (anyone may relabel
-- themselves). Returns `changed` — the user ids whose role or label changed — so the Worker's
-- POST /api/monitor/:nid/members can tell the room exactly whom to re-check, plus `role`,
-- `previous_role` and `added` for the parents' notice.
create or replace function public.monitor_set_member(p_nursery uuid, p_user uuid, p_role text, p_label text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_label text := nullif(left(trim(coalesce(p_label, '')), 30), '');
  v_problem text;
  v_prev text;
begin
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  if public.monitor__role(p_nursery, v_uid) is distinct from 'parent' then
    -- Anyone may relabel THEMSELVES (e.g. "Grandma") without changing their role.
    if p_user = v_uid and public.monitor__role(p_nursery, v_uid) is not null then
      update public.monitor_members set label = v_label where nursery_id = p_nursery and user_id = v_uid;
      return jsonb_build_object('ok', true, 'changed', jsonb_build_array(v_uid), 'added', false);
    end if;
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_role not in ('parent', 'caregiver', 'viewer') then
    return jsonb_build_object('ok', false, 'error', 'bad_role');
  end if;
  if not public.live__is_member(p_user) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  select owner_id into v_owner from public.monitor_nurseries where id = p_nursery;
  if p_user = v_owner and p_role <> 'parent' then
    return jsonb_build_object('ok', false, 'error', 'owner_is_parent');
  end if;
  select role into v_prev from public.monitor_members where nursery_id = p_nursery and user_id = p_user;
  if v_prev is null
     and (select count(*) from public.monitor_members where nursery_id = p_nursery) >= 20 then
    return jsonb_build_object('ok', false, 'error', 'limit_reached');
  end if;
  insert into public.monitor_members (nursery_id, user_id, role, label, added_by)
  values (p_nursery, p_user, p_role, v_label, v_uid)
  on conflict (nursery_id, user_id) do update set role = excluded.role, label = excluded.label;
  return jsonb_build_object('ok', true, 'changed', jsonb_build_array(p_user), 'role', p_role,
    'previous_role', v_prev, 'added', v_prev is null);
end;
$$;

-- Parents remove anyone but the owner; anyone (but the owner) may leave. Returns `removed`
-- (and `changed`): the ids actually removed, empty when they weren't a member.
create or replace function public.monitor_remove_member(p_nursery uuid, p_user uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_problem text;
  v_n integer;
begin
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  select owner_id into v_owner from public.monitor_nurseries where id = p_nursery;
  if v_owner is null or p_user = v_owner then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_user <> v_uid and public.monitor__role(p_nursery, v_uid) is distinct from 'parent' then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  delete from public.monitor_members where nursery_id = p_nursery and user_id = p_user;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true,
    'removed', case when v_n > 0 then jsonb_build_array(p_user) else '[]'::jsonb end,
    'changed', case when v_n > 0 then jsonb_build_array(p_user) else '[]'::jsonb end,
    'left', v_n > 0 and p_user = v_uid);
end;
$$;

-- The rest of the member RPCs: everything else that reads or changes a nursery, its people,
-- the caller's profile or the people directory. Same bodies (and signatures, so CREATE OR
-- REPLACE keeps the grants) as live_accounts_and_monitor.sql; the session check runs first, so
-- a phished password (aal1 of someone with a second factor) or a token whose session was
-- ended can't delete, rename or list a nursery, add one, read the family's names and labels,
-- rename the account, or search the directory. Signed-out callers get the old answers.

create or replace function public.live_join(p_ticket text default null, p_code text default null, p_display_name text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
  v_name text;
  v_via text;
  v_bucket text;
  v_ok boolean;
  v_ticket_hash text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  if public.live__is_member(v_uid) then
    return jsonb_build_object('ok', true, 'profile', public.live__profile_json(v_uid));
  end if;

  v_name := left(coalesce(nullif(trim(p_display_name), ''), public.live__default_name(v_uid)), 40);

  if p_ticket is not null and char_length(p_ticket) between 16 and 128 then
    v_ticket_hash := encode(extensions.digest(p_ticket, 'sha256'), 'hex');
    update public.live_welcome_tickets
       set used_by = v_uid, used_at = now()
     where token_hash = v_ticket_hash and used_at is null and expires_at > now();
    if found then
      v_via := 'welcome_code';
    end if;
  end if;

  if v_via is null and p_code is not null then
    v_bucket := 'user:' || v_uid::text;
    if public.live__throttled(v_bucket) or public.live__throttled('ip:' || public.live__client_ip_hash()) then
      return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
    end if;
    v_ok := public.live__verify_code(p_code);
    insert into public.live_welcome_attempts (bucket, ok) values (v_bucket, v_ok);
    if not v_ok then
      return jsonb_build_object('ok', false, 'error', 'invalid_code');
    end if;
    v_via := 'welcome_code';
  end if;

  if v_via is null and public.live__legacy_eligible(v_uid) then
    v_via := 'legacy';
  end if;

  if v_via is null then
    return jsonb_build_object('ok', false, 'error', 'welcome_code_required');
  end if;

  insert into public.live_profiles (user_id, display_name, verified_via)
  values (v_uid, v_name, v_via)
  on conflict (user_id) do nothing;
  return jsonb_build_object('ok', true, 'profile', public.live__profile_json(v_uid));
end;
$$;

create or replace function public.live_update_profile(p_display_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
  v_name text := left(trim(coalesce(p_display_name, '')), 40);
begin
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  if v_uid is null or not public.live__is_member(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  if char_length(v_name) = 0 then
    return jsonb_build_object('ok', false, 'error', 'name_required');
  end if;
  update public.live_profiles set display_name = v_name, updated_at = now() where user_id = v_uid;
  return jsonb_build_object('ok', true, 'profile', public.live__profile_json(v_uid));
end;
$$;

-- Find people by name (members only, names only — never emails).
create or replace function public.live_search_people(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
  v_q text := lower(trim(coalesce(p_query, '')));
  v_like text;
begin
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  if v_uid is null or not public.live__is_member(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  if char_length(v_q) < 2 then
    return jsonb_build_object('ok', true, 'people', '[]'::jsonb);
  end if;
  v_q := left(v_q, 40);
  v_like := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  return jsonb_build_object('ok', true, 'people', coalesce((
    select jsonb_agg(jsonb_build_object('user_id', r.user_id, 'display_name', r.display_name))
    from (
      select lp.user_id, lp.display_name
      from public.live_profiles lp
      where lp.user_id <> v_uid
        and lp.search_name like '%' || v_like || '%'
      order by (lp.search_name like v_like || '%') desc, lp.search_name
      limit 12
    ) r
  ), '[]'::jsonb));
end;
$$;

create or replace function public.monitor_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
begin
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  if v_uid is null or not public.live__is_member(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  return jsonb_build_object('ok', true, 'nurseries', coalesce((
    select jsonb_agg(public.monitor__nursery_json(m.nursery_id, v_uid) order by n.created_at)
    from public.monitor_members m
    join public.monitor_nurseries n on n.id = m.nursery_id
    where m.user_id = v_uid
  ), '[]'::jsonb));
end;
$$;

create or replace function public.monitor_create(p_name text, p_baby_name text default null, p_label text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
  v_id uuid;
  v_name text := left(trim(coalesce(p_name, '')), 60);
begin
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  if v_uid is null or not public.live__is_member(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  if char_length(v_name) = 0 then
    return jsonb_build_object('ok', false, 'error', 'name_required');
  end if;
  if (select count(*) from public.monitor_nurseries where owner_id = v_uid) >= 5 then
    return jsonb_build_object('ok', false, 'error', 'limit_reached');
  end if;
  insert into public.monitor_nurseries (owner_id, name, baby_name)
  values (v_uid, v_name, nullif(left(trim(coalesce(p_baby_name, '')), 40), ''))
  returning id into v_id;
  insert into public.monitor_members (nursery_id, user_id, role, label, added_by)
  values (v_id, v_uid, 'parent', nullif(left(trim(coalesce(p_label, '')), 30), ''), v_uid);
  return jsonb_build_object('ok', true, 'nursery', public.monitor__nursery_json(v_id, v_uid));
end;
$$;

create or replace function public.monitor_update(p_nursery uuid, p_name text, p_baby_name text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
  v_name text := left(trim(coalesce(p_name, '')), 60);
begin
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  if public.monitor__role(p_nursery, v_uid) is distinct from 'parent' then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if char_length(v_name) = 0 then
    return jsonb_build_object('ok', false, 'error', 'name_required');
  end if;
  update public.monitor_nurseries
     set name = v_name, baby_name = nullif(left(trim(coalesce(p_baby_name, '')), 40), ''), updated_at = now()
   where id = p_nursery;
  return jsonb_build_object('ok', true, 'nursery', public.monitor__nursery_json(p_nursery, v_uid));
end;
$$;

create or replace function public.monitor_delete(p_nursery uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
begin
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  delete from public.monitor_nurseries where id = p_nursery and owner_id = v_uid;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.monitor_people(p_nursery uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
begin
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  if public.monitor__role(p_nursery, v_uid) is null then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  return jsonb_build_object('ok', true, 'people', coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', m.user_id,
      'display_name', coalesce(lp.display_name, 'Member'),
      'role', m.role,
      'label', m.label,
      'is_owner', m.user_id = n.owner_id,
      'is_me', m.user_id = v_uid
    ) order by (m.user_id = n.owner_id) desc, m.created_at)
    from public.monitor_members m
    join public.monitor_nurseries n on n.id = m.nursery_id
    left join public.live_profiles lp on lp.user_id = m.user_id
    where m.nursery_id = p_nursery
  ), '[]'::jsonb));
end;
$$;

-- Current member ids — lets the room drop sockets of people just removed. A refusal (`ok`
-- false, with or without `error`) is never read as "nobody is a member": the room re-checks
-- roles instead of cutting anyone off (monitorRoom.onMembersChanged).
create or replace function public.monitor_member_ids(p_nursery uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
begin
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  if public.monitor__role(p_nursery, v_uid) is null then
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object('ok', true, 'ids', coalesce((
    select jsonb_agg(m.user_id) from public.monitor_members m
    where m.nursery_id = p_nursery
      and exists (select 1 from public.live_profiles lp where lp.user_id = m.user_id)
  ), '[]'::jsonb));
end;
$$;

-- ================================================================== grants
do $$
declare
  f text;
begin
  -- Internal helpers: nobody calls these directly.
  foreach f in array array[
    'public.live__has_mfa(uuid)',
    'public.live__session_problem()',
    'public.live__mask_ip(inet)',
    'public.live__device_json(public.live_devices)',
    'public.live__send_signin_alert(uuid, bigint, text, text, text)',
    'public.live__note_session(uuid, uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;

  -- Signed-in callers (every one checks the session first).
  foreach f in array array[
    'public.live_me()',
    'public.live_join(text, text, text)',
    'public.live_update_profile(text)',
    'public.live_search_people(text)',
    'public.monitor_list()',
    'public.monitor_create(text, text, text)',
    'public.monitor_update(uuid, text, text)',
    'public.monitor_delete(uuid)',
    'public.monitor_people(uuid)',
    'public.monitor_member_ids(uuid)',
    'public.monitor_my_role(uuid)',
    'public.monitor_set_member(uuid, uuid, text, text)',
    'public.monitor_remove_member(uuid, uuid)',
    'public.live_device_enroll(text, text, text)',
    'public.live_device_list()',
    'public.live_device_revoke(uuid)',
    'public.live_security_events(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  -- No session needed: a watch trading its grant, and the "Not you?" link.
  foreach f in array array[
    'public.live_device_active(uuid, text)',
    'public.live_secure_account(text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;

  -- The access-token hook: Supabase Auth only.
  revoke all on function public.live_access_token_hook(jsonb) from public, anon, authenticated;
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant usage on schema public to supabase_auth_admin';
    execute 'grant execute on function public.live_access_token_hook(jsonb) to supabase_auth_admin';
  end if;
end $$;

-- ================================================================== janitor
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'live-security-sweep';
    perform cron.schedule(
      'live-security-sweep',
      '41 4 * * *',
      $job$
        -- A spent or lapsed "Not you?" token is useless; forget its hash.
        update public.security_events set secure_hash = null
         where secure_hash is not null and (secure_used_at is not null or at < now() - interval '8 days');
        -- History older than 180 days. (A session that outlives its row just reads as a
        -- refresh next time — recorded again, never emailed.)
        delete from public.security_events where at < now() - interval '180 days';
        delete from public.live_devices where revoked_at < now() - interval '180 days';
      $job$
    );
  end if;
end $$;
