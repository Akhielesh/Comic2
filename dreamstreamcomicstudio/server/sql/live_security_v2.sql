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

-- ============================================== two-step sign-in, as Stream Studio counts it
-- Supabase Auth lets the FIRST authenticator be added by anyone holding a signed-in session, and
-- can't be told to ask for more (its MFA-verification hook isn't on our plan). So here an
-- authenticator only COUNTS once it was switched on through live_mfa_activate(), which for the
-- first one demands a fresh sign-in (a password typed, or an email link opened, in the last 30
-- minutes), hands out recovery codes and records an emailed security event. One added any other
-- way — a stolen session calling the auth API directly — changes nothing for the account and is
-- tidied away after an hour (live_mfa_status). Losing the phone has a way back
-- (live_mfa_recover, with a recovery code), and "Not you?" removes authenticators switched on
-- since the sign-in it reports (live_secure_account). A parent is never locked out by a feature
-- that was meant to protect them.
create table if not exists public.live_mfa_factors (
  factor_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The session that switched it on ("Not you?" removes what an intruder's session added).
  session_id uuid,
  activated_at timestamptz not null default now()
);
create index if not exists idx_live_mfa_factors_user on public.live_mfa_factors (user_id);

-- When two-step sign-in was (last) switched on. Sessions signed in BEFORE then stay valid for
-- watching — the nursery camera and bedside monitors don't go dark because a parent turned it on
-- from another room — while anything that changes who can see a nursery still needs the code.
create table if not exists public.live_mfa_on (
  user_id uuid primary key references auth.users(id) on delete cascade,
  since timestamptz not null default now()
);

-- Single-use recovery codes (shown once, when two-step sign-in is turned on). Only a salted
-- sha256 is kept; the codes carry ~59 random bits and guesses are rate limited.
create table if not exists public.live_mfa_recovery_codes (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  code_hash text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create unique index if not exists live_mfa_recovery_codes_hash on public.live_mfa_recovery_codes (user_id, code_hash);

-- Wrong recovery codes, for the rate limit (5 per 15 minutes per account).
create table if not exists public.live_mfa_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  at timestamptz not null default now()
);
create index if not exists idx_live_mfa_attempts_user_at on public.live_mfa_attempts (user_id, at desc);

do $$
declare
  t text;
begin
  foreach t in array array['live_mfa_factors', 'live_mfa_on', 'live_mfa_recovery_codes', 'live_mfa_attempts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Has this person two-step sign-in on: a verified authenticator that was switched on here?
create or replace function public.live__has_mfa(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_uid is not null and exists (
    select 1
    from auth.mfa_factors f
    join public.live_mfa_factors a on a.factor_id = f.id and a.user_id = f.user_id
    where f.user_id = p_uid and f.status = 'verified'
  );
$$;

-- Was this session signed in before two-step sign-in was switched on? Then it may keep WATCHING
-- without the code until it signs out (see live_mfa_on).
create or replace function public.live__mfa_grace(p_uid uuid, p_sid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_uid is not null and p_sid is not null and exists (
    select 1
    from public.live_mfa_on o
    join auth.sessions s on s.user_id = o.user_id
    where o.user_id = p_uid and s.id = p_sid and s.created_at < o.since
  );
$$;

-- What's wrong with the caller's session, if anything:
--   null              fine (or nobody signed in — callers handle that themselves)
--   'session_revoked' the token's session no longer exists (signed out everywhere, "Not you?",
--                     password reset, or an admin revoke) — the JWT alone is still unexpired
--   'mfa_required'    the person has two-step sign-in on, this token is only aal1, and the
--                     session was signed in after it was switched on (an older session may keep
--                     watching — live__mfa_grace — but live__step_up_problem() still asks it
--                     for the code before anything that changes who can see a nursery)
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
  if public.live__has_mfa(v_uid) and coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2'
     and not public.live__mfa_grace(v_uid, v_sid) then
    return 'mfa_required';
  end if;
  return null;
end;
$$;

-- The stricter check for actions that change who can see a nursery or how the account is
-- protected (adding or removing people, deleting a nursery, devices, recovery codes): once
-- two-step sign-in is on, every session needs the code — including one old enough to keep
-- watching without it. Callers run live__session_problem() first.
create or replace function public.live__step_up_problem()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when public.live__has_mfa(auth.uid()) and coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2' then 'mfa_required'
  end;
$$;

-- A fresh sign-in on this session: a first factor (password, email link, …) used in the last
-- p_minutes, by the token's `amr` timestamps or the session's own age. A stolen long-lived
-- session can't produce one without the password or the mailbox.
create or replace function public.live__recent_sign_in(p_minutes integer)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_floor double precision := extract(epoch from now()) - greatest(1, p_minutes) * 60;
  v_amr jsonb := auth.jwt()->'amr';
  v_sid uuid;
  e jsonb;
begin
  if jsonb_typeof(v_amr) = 'array' then
    for e in select * from jsonb_array_elements(v_amr) loop
      if jsonb_typeof(e) = 'object'
         and coalesce(e->>'method', '') not in ('', 'totp', 'mfa/totp', 'mfa/phone', 'mfa/webauthn', 'mfa/recovery_code', 'token_refresh', 'anonymous')
         and jsonb_typeof(e->'timestamp') = 'number'
         and (e->>'timestamp')::double precision >= v_floor then
        return true;
      end if;
    end loop;
  end if;
  begin
    v_sid := nullif(auth.jwt()->>'session_id', '')::uuid;
  exception when others then
    v_sid := null;
  end;
  return v_sid is not null and exists (
    select 1 from auth.sessions s
    where s.id = v_sid and s.user_id = auth.uid() and s.created_at >= to_timestamp(v_floor)
  );
end;
$$;

-- The caller's session id, or null (never raises on a malformed claim).
create or replace function public.live__jwt_sid()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return nullif(auth.jwt()->>'session_id', '')::uuid;
exception when others then
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
  check (kind in ('sign_in', 'secured', 'device_added', 'device_revoked',
                  -- two-step sign-in: switched on, another authenticator added, one gone, new
                  -- recovery codes, switched off with a recovery code
                  'mfa_on', 'mfa_added', 'mfa_removed', 'mfa_codes', 'mfa_recovered'));
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
  -- Changes who can see a nursery: the code even on a session old enough to keep watching without it.
  v_problem := coalesce(public.live__session_problem(), public.live__step_up_problem());
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
  -- Changes who can see a nursery: the code even on a session old enough to keep watching without it.
  v_problem := coalesce(public.live__session_problem(), public.live__step_up_problem());
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
-- p_kind: 'sign_in' (the hook), or a two-step sign-in change — 'mfa_on', 'mfa_added',
-- 'mfa_recovered' — each with its own one-time "Not you? Secure my account" link.
create or replace function public.live__send_security_alert(p_uid uuid, p_event bigint, p_kind text, p_ua text, p_ip text, p_method text)
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
  if p_kind is null or p_kind not in ('sign_in', 'mfa_on', 'mfa_added', 'mfa_recovered') then
    return false;
  end if;
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
    'kind', p_kind,
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

-- The new-sign-in alert (the hook's caller; kept under its own name).
create or replace function public.live__send_signin_alert(p_uid uuid, p_event bigint, p_ua text, p_ip text, p_method text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select public.live__send_security_alert(p_uid, p_event, 'sign_in', p_ua, p_ip, p_method);
$$;

-- Email the person about a two-step sign-in change made from the CALLER's session (device and
-- network from that session). Never fails the change it reports: no email is the worst case.
create or replace function public.live__notify_mfa(p_uid uuid, p_event bigint, p_kind text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ua text;
  v_ip inet;
begin
  begin
    select left(s.user_agent, 300), s.ip into v_ua, v_ip
      from auth.sessions s where s.id = nullif(auth.jwt()->>'session_id', '')::uuid;
    update public.security_events set ua = v_ua, ip_masked = public.live__mask_ip(v_ip) where id = p_event;
    perform public.live__send_security_alert(p_uid, p_event, p_kind, v_ua, public.live__mask_ip(v_ip), null);
  exception when others then
    raise warning 'live__notify_mfa: no email for event % (%)', p_event, sqlstate;
  end;
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
--   * adds `ds_mfa` (true when the person has two-step sign-in on) so the Worker can demand
--     aal2 without asking the database, and `ds_mfa_grace` (true when this session was signed
--     in before it was switched on: it may keep watching without the code — never for admin
--     actions);
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
  begin
    v_claims := jsonb_set(v_claims, '{ds_mfa_grace}',
      to_jsonb(coalesce(v_mfa, false) and coalesce(public.live__mfa_grace(v_uid, v_sid), false)), true);
  exception when others then
    v_claims := v_claims - 'ds_mfa_grace';
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

-- ========================================================= two-step sign-in RPCs

-- How a recovery code is kept: salted with the account, ignoring case, spaces and dashes.
create or replace function public.live__recovery_hash(p_uid uuid, p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(p_uid::text || ':' || lower(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'sha256'), 'hex');
$$;

-- Ten new recovery codes for p_uid (any older set stops working), returned in plain text as
-- "abcd-efgh-jkmn" — the only time they exist outside the person's hands.
create or replace function public.live__new_recovery_codes(p_uid uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_alpha constant text := '23456789abcdefghjkmnpqrstuvwxyz'; -- no 0/o, 1/i/l
  v_codes jsonb := '[]'::jsonb;
  v_bytes bytea;
  v_code text;
  i integer;
  j integer;
begin
  delete from public.live_mfa_recovery_codes where user_id = p_uid;
  for i in 1..10 loop
    v_bytes := extensions.gen_random_bytes(12);
    v_code := '';
    for j in 0..11 loop
      v_code := v_code || substr(v_alpha, (get_byte(v_bytes, j) % 31) + 1, 1);
    end loop;
    insert into public.live_mfa_recovery_codes (user_id, code_hash)
    values (p_uid, public.live__recovery_hash(p_uid, v_code));
    v_codes := v_codes || to_jsonb(substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4) || '-' || substr(v_code, 9, 4));
  end loop;
  return v_codes;
end;
$$;

-- Bring our record in line with Supabase Auth's: an authenticator that was never switched on
-- here goes after an hour (a set-up abandoned half-way, or one added by a stolen session straight
-- through the auth API); one removed in Supabase is noted as 'mfa_removed'; with none left, two-step
-- sign-in is off and its recovery codes go too. Returns whether two-step sign-in is on.
create or replace function public.live__mfa_tidy(p_uid uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_gone record;
  v_on boolean;
begin
  begin
    delete from auth.mfa_factors f
     where f.user_id = p_uid and f.status = 'verified' and f.created_at < now() - interval '1 hour'
       and not exists (select 1 from public.live_mfa_factors a where a.factor_id = f.id);
  exception when others then
    raise warning 'live__mfa_tidy: could not remove stray authenticators (%)', sqlstate;
  end;
  for v_gone in
    delete from public.live_mfa_factors a
     where a.user_id = p_uid
       and not exists (select 1 from auth.mfa_factors f where f.id = a.factor_id and f.user_id = p_uid and f.status = 'verified')
    returning a.factor_id
  loop
    insert into public.security_events (user_id, session_id, kind, detail)
    values (p_uid, public.live__jwt_sid(), 'mfa_removed', jsonb_build_object('factor_id', v_gone.factor_id));
  end loop;
  v_on := public.live__has_mfa(p_uid);
  if not v_on then
    delete from public.live_mfa_on where user_id = p_uid;
    delete from public.live_mfa_recovery_codes where user_id = p_uid;
  end if;
  return v_on;
end;
$$;

-- Settings → Security: is two-step sign-in on, with which authenticators, how many recovery codes
-- are left, and may this session watch without the code (`grace`).
create or replace function public.live_mfa_status()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
  v_on boolean;
  v_aal text := coalesce(auth.jwt()->>'aal', 'aal1');
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'signed_out');
  end if;
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  v_on := public.live__mfa_tidy(v_uid);
  return jsonb_build_object(
    'ok', true,
    'on', v_on,
    'aal', v_aal,
    'since', (select o.since from public.live_mfa_on o where o.user_id = v_uid and v_on),
    'grace', v_on and v_aal <> 'aal2' and public.live__mfa_grace(v_uid, public.live__jwt_sid()),
    'factors', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'name', coalesce(f.friendly_name, ''), 'created_at', f.created_at,
                                          'activated_at', a.activated_at) order by a.activated_at)
      from auth.mfa_factors f
      join public.live_mfa_factors a on a.factor_id = f.id
      where f.user_id = v_uid and f.status = 'verified'
    ), '[]'::jsonb),
    'codes_left', (select count(*) from public.live_mfa_recovery_codes c where c.user_id = v_uid and c.used_at is null),
    'codes_total', (select count(*) from public.live_mfa_recovery_codes c where c.user_id = v_uid)
  );
end;
$$;

-- Switch on an authenticator the caller has just verified (the session is aal2 with it). The
-- FIRST one needs a fresh sign-in — a password typed, or an email link opened, in the last 30
-- minutes (`reauth_required` otherwise) — so a stolen session can't turn two-step sign-in on and
-- lock the parent out. It returns ten recovery codes (shown once), sets `since` (sessions signed
-- in before now keep watching without the code) and emails the person with a "Not you?" link
-- that removes it again. A second authenticator needs only the code (the session is aal2).
create or replace function public.live_mfa_activate(p_factor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
  v_first boolean;
  v_codes jsonb;
  v_event bigint;
  v_kind text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'signed_out');
  end if;
  v_problem := public.live__session_problem();
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  if coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2' then
    -- The new authenticator's code hasn't been given on this session.
    return jsonb_build_object('ok', false, 'error', 'mfa_required');
  end if;
  v_first := not public.live__mfa_tidy(v_uid);
  if not exists (select 1 from auth.mfa_factors f
                  where f.id = p_factor and f.user_id = v_uid and f.status = 'verified' and f.factor_type = 'totp') then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if exists (select 1 from public.live_mfa_factors a where a.factor_id = p_factor) then
    return jsonb_build_object('ok', true, 'already', true, 'first', false, 'codes', '[]'::jsonb);
  end if;
  if v_first and not public.live__recent_sign_in(30) then
    return jsonb_build_object('ok', false, 'error', 'reauth_required');
  end if;
  insert into public.live_mfa_factors (factor_id, user_id, session_id) values (p_factor, v_uid, public.live__jwt_sid());
  if v_first then
    insert into public.live_mfa_on (user_id, since) values (v_uid, now())
      on conflict (user_id) do update set since = excluded.since;
    v_codes := public.live__new_recovery_codes(v_uid);
  end if;
  v_kind := case when v_first then 'mfa_on' else 'mfa_added' end;
  insert into public.security_events (user_id, session_id, kind, detail)
  values (v_uid, public.live__jwt_sid(), v_kind, jsonb_build_object('factor_id', p_factor))
  returning id into v_event;
  perform public.live__notify_mfa(v_uid, v_event, v_kind);
  return jsonb_build_object('ok', true, 'already', false, 'first', v_first, 'codes', coalesce(v_codes, '[]'::jsonb));
end;
$$;

-- A new set of recovery codes (the old ones stop working). Needs the code on this session.
create or replace function public.live_mfa_codes_regenerate()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
  v_codes jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'signed_out');
  end if;
  v_problem := coalesce(public.live__session_problem(), public.live__step_up_problem());
  if v_problem is not null then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  if not public.live__mfa_tidy(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'not_on');
  end if;
  v_codes := public.live__new_recovery_codes(v_uid);
  insert into public.security_events (user_id, session_id, kind) values (v_uid, public.live__jwt_sid(), 'mfa_codes');
  return jsonb_build_object('ok', true, 'codes', v_codes);
end;
$$;

-- Lost the phone: a recovery code, typed after the password (this session still owes the
-- code), switches two-step sign-in OFF so the person can get back in — Supabase Auth can't be
-- told to accept a recovery code as the second step, so every authenticator goes, the lost one
-- with it, and the app asks them to set it up again on the new phone. Single use; 5 wrong codes
-- per 15 minutes; emailed with a "Not you?" link.
create or replace function public.live_mfa_recover(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_problem text;
  v_id bigint;
  v_removed integer := 0;
  v_event bigint;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'signed_out');
  end if;
  -- A session that still owes the code is exactly who this is for: only a dead one is refused.
  v_problem := public.live__session_problem();
  if v_problem = 'session_revoked' then
    return jsonb_build_object('ok', false, 'error', v_problem);
  end if;
  if not public.live__has_mfa(v_uid) then
    return jsonb_build_object('ok', true, 'removed', 0, 'already_off', true);
  end if;
  if (select count(*) from public.live_mfa_attempts t where t.user_id = v_uid and t.at > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  select c.id into v_id from public.live_mfa_recovery_codes c
   where c.user_id = v_uid and c.used_at is null and c.code_hash = public.live__recovery_hash(v_uid, p_code)
   for update;
  if v_id is null then
    insert into public.live_mfa_attempts (user_id) values (v_uid);
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;
  begin
    delete from auth.mfa_factors where user_id = v_uid;
    get diagnostics v_removed = row_count;
    update public.live_mfa_recovery_codes set used_at = now() where id = v_id;
  exception when others then
    -- Nothing changed and the code still works: never "used up" without getting them back in.
    raise warning 'live_mfa_recover: could not remove authenticators (%)', sqlstate;
    return jsonb_build_object('ok', false, 'error', 'failed');
  end;
  delete from public.live_mfa_factors where user_id = v_uid;
  delete from public.live_mfa_on where user_id = v_uid;
  delete from public.live_mfa_recovery_codes where user_id = v_uid;
  delete from public.live_mfa_attempts where user_id = v_uid;
  insert into public.security_events (user_id, session_id, kind, detail)
  values (v_uid, public.live__jwt_sid(), 'mfa_recovered', jsonb_build_object('removed', v_removed))
  returning id into v_event;
  perform public.live__notify_mfa(v_uid, v_event, 'mfa_recovered');
  return jsonb_build_object('ok', true, 'removed', v_removed);
end;
$$;

-- ==================================================== "Not you? Secure my account"
-- Redeems the one-time token from a security email — a new sign-in, or two-step sign-in being
-- switched on or off (single use, 7 days):
--   * ends every session of the account (refresh tokens go with them), so every device must
--     sign in again — and the Worker refuses their access tokens from the next check;
--   * revokes devices enrolled since that sign-in (an intruder's watch or browser);
--   * removes authenticators switched on since then, or by the session it reports (a password
--     thief who turned on two-step sign-in can't lock the parent out of their own account), and
--     recovery codes that may be in their hands; authenticators the parent had before stay;
--   * records a 'secured' event.
-- Callable without a session (the person may be locked out). The backend's
-- POST /api/auth/email/secure calls it with the service role and then emails a password-reset
-- link and asks the live Worker to close the account's open sockets; only that caller gets the
-- address, the account id and its nurseries back, everyone else gets a masked hint.
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
  v_factors integer := 0;
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
  -- Authenticators switched on since that event (or by the session it reports, or the one it is
  -- about), and any added in that window that were never switched on here.
  begin
    delete from auth.mfa_factors f
     where f.user_id = v_ev.user_id
       and (f.created_at >= v_ev.at - interval '1 minute'
            or exists (select 1 from public.live_mfa_factors a
                        where a.factor_id = f.id
                          and (a.activated_at >= v_ev.at - interval '1 minute'
                               or (v_ev.session_id is not null and a.session_id = v_ev.session_id)))
            or f.id::text = coalesce(v_ev.detail->>'factor_id', ''));
    get diagnostics v_factors = row_count;
  exception when others then
    raise warning 'live_secure_account: could not remove authenticators (%)', sqlstate;
    v_factors := -1;
  end;
  delete from public.live_mfa_factors a
   where a.user_id = v_ev.user_id and not exists (select 1 from auth.mfa_factors f where f.id = a.factor_id);
  if not public.live__has_mfa(v_ev.user_id) then
    delete from public.live_mfa_on where user_id = v_ev.user_id;
    delete from public.live_mfa_recovery_codes where user_id = v_ev.user_id;
  elsif exists (select 1 from public.security_events e
                 where e.user_id = v_ev.user_id and e.kind = 'mfa_codes' and e.at >= v_ev.at - interval '1 minute') then
    -- New recovery codes were made since: whoever made them may hold them. The parent makes a
    -- fresh set once they're back in (their authenticator still works).
    delete from public.live_mfa_recovery_codes where user_id = v_ev.user_id;
  end if;
  insert into public.security_events (user_id, kind, detail)
  values (v_ev.user_id, 'secured', jsonb_build_object('from_event', v_ev.id, 'sessions', v_sessions,
          'devices', jsonb_array_length(v_devices), 'factors', v_factors));

  select u.email into v_email from auth.users u where u.id = v_ev.user_id;
  v_hint := case when v_email is null then null
                 else left(split_part(v_email, '@', 1), 1) || '•••@' || split_part(v_email, '@', 2) end;
  return jsonb_build_object('ok', true, 'sessions_ended', v_sessions, 'devices_revoked', v_devices,
                            'factors_removed', v_factors, 'email_hint', v_hint)
    || case when v_service then jsonb_build_object(
         'user_id', v_ev.user_id,
         'email', v_email,
         -- Where the account's sockets and alert subscriptions live, for the server-side kick
         -- (its own token can't list them any more: every session just ended).
         'nurseries', coalesce((select jsonb_agg(m.nursery_id) from public.monitor_members m where m.user_id = v_ev.user_id), '[]'::jsonb)
       ) else '{}'::jsonb end;
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
      'aal', coalesce(auth.jwt()->>'aal', 'aal1'),
      -- Signed in before two-step sign-in was switched on: watching works without the code.
      'mfa_grace', coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2'
                   and public.live__mfa_grace(v_uid, nullif(auth.jwt()->>'session_id', '')::uuid));
  end if;
  return jsonb_build_object('signed_in', true, 'member', false, 'user_id', v_uid,
    'needs_code', not public.live__legacy_eligible(v_uid),
    'suggested_name', public.live__default_name(v_uid));
end;
$$;

-- The live Worker's authorization check for a monitor socket (the connecting user's own token).
-- Adds `error` ('session_revoked' | 'mfa_required') on refusal, and `mfa`/`aal`/`mfa_grace` on
-- success so the room's role cache knows to demand aal2 on later re-auths (`mfa_grace`: this
-- session predates two-step sign-in and may keep watching without the code).
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
    'aal', coalesce(auth.jwt()->>'aal', 'aal1'),
    'mfa_grace', coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2'
                 and public.live__mfa_grace(v_uid, nullif(auth.jwt()->>'session_id', '')::uuid)
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
  -- Changes who can see a nursery: the code even on a session old enough to keep watching without it.
  v_problem := coalesce(public.live__session_problem(), public.live__step_up_problem());
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
  -- Changes who can see a nursery: the code even on a session old enough to keep watching without it.
  v_problem := coalesce(public.live__session_problem(), public.live__step_up_problem());
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
  -- Changes who can see a nursery: the code even on a session old enough to keep watching without it.
  v_problem := coalesce(public.live__session_problem(), public.live__step_up_problem());
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
    'public.live__mfa_grace(uuid, uuid)',
    'public.live__session_problem()',
    'public.live__step_up_problem()',
    'public.live__recent_sign_in(integer)',
    'public.live__jwt_sid()',
    'public.live__mask_ip(inet)',
    'public.live__device_json(public.live_devices)',
    'public.live__send_security_alert(uuid, bigint, text, text, text, text)',
    'public.live__send_signin_alert(uuid, bigint, text, text, text)',
    'public.live__notify_mfa(uuid, bigint, text)',
    'public.live__note_session(uuid, uuid, text)',
    'public.live__recovery_hash(uuid, text)',
    'public.live__new_recovery_codes(uuid)',
    'public.live__mfa_tidy(uuid)'
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
    'public.live_security_events(integer)',
    'public.live_mfa_status()',
    'public.live_mfa_activate(uuid)',
    'public.live_mfa_codes_regenerate()',
    -- (serves a session that still owes the code, but refuses one that was ended)
    'public.live_mfa_recover(text)'
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
        -- Wrong recovery codes only matter for the 15-minute limit.
        delete from public.live_mfa_attempts where at < now() - interval '1 day';
      $job$
    );
  end if;
end $$;
