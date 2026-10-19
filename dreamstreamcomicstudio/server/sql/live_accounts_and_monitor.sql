-- Stream Studio accounts (welcome-code gated), the people directory, and the
-- Baby Monitor's nurseries + roles.
--
-- Security model
-- --------------
-- * The welcome code is NEVER stored in the repo or shipped to clients. Only a
--   bcrypt hash lives in live_private_config (no client grants at all). Set or
--   rotate it as the database owner:
--       select public.live_admin_set_welcome_code('<code>');
--   Comparison is bcrypt (case-sensitive, slow by design).
-- * Every guess is rate limited server-side: per hashed client IP, per user,
--   and a global ceiling, so the code cannot be brute forced. Attempts are
--   logged without raw IPs (sha256 only) and swept after 7 days.
-- * Functions return {ok:false,...} instead of raising on a wrong code so the
--   failed attempt is committed (a raise would roll the rate-limit row back).
-- * Membership (live_profiles) is written only by these SECURITY DEFINER
--   functions. Creating a Supabase account directly through the API (bypassing
--   the UI) yields NO Stream Studio access: hosting, the directory and the
--   baby monitor all require a live_profiles row.
-- * Accounts that existed before launch are grandfathered (legacy_cutoff);
--   every newer account must present the code (or a ticket minted by it).
--
-- Idempotent; apply with the Supabase MCP apply_migration (see CLAUDE.md).

create extension if not exists pgcrypto with schema extensions;

-- ------------------------------------------------------------- private config
create table if not exists public.live_private_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.live_private_config enable row level security;
revoke all on public.live_private_config from anon, authenticated;

-- Pre-launch accounts keep access without a code. Set once, never moved.
insert into public.live_private_config (key, value)
values ('legacy_cutoff', now()::text)
on conflict (key) do nothing;

-- ------------------------------------------------------------------- members
create table if not exists public.live_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  search_name text generated always as (lower(display_name)) stored,
  verified_via text not null check (verified_via in ('welcome_code', 'legacy', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_live_profiles_search on public.live_profiles (search_name text_pattern_ops);
-- No direct client access: every read/write goes through the RPCs below.
alter table public.live_profiles enable row level security;
revoke all on public.live_profiles from anon, authenticated;

-- ------------------------------------------------------- welcome rate limits
create table if not exists public.live_welcome_attempts (
  id bigint generated always as identity primary key,
  bucket text not null,
  ok boolean not null,
  at timestamptz not null default now()
);
create index if not exists idx_live_welcome_attempts_bucket on public.live_welcome_attempts (bucket, at desc);
create index if not exists idx_live_welcome_attempts_at on public.live_welcome_attempts (at desc);
alter table public.live_welcome_attempts enable row level security;
revoke all on public.live_welcome_attempts from anon, authenticated;

-- One-time tickets: the code is checked BEFORE an account exists, then the
-- ticket (not the code) rides the sign-up and is redeemed on first sign-in.
create table if not exists public.live_welcome_tickets (
  token_hash text primary key,
  expires_at timestamptz not null,
  used_by uuid references auth.users(id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.live_welcome_tickets enable row level security;
revoke all on public.live_welcome_tickets from anon, authenticated;

-- ---------------------------------------------------------------- internals
create or replace function public.live__client_ip_hash()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  h json;
  ip text;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    h := null;
  end;
  ip := coalesce(
    nullif(h->>'cf-connecting-ip', ''),
    nullif(trim(split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1)), ''),
    nullif(h->>'x-real-ip', ''),
    'unknown'
  );
  return encode(extensions.digest(ip, 'sha256'), 'hex');
end;
$$;

-- Throttle state for a bucket: per-bucket failures (15 min) + global failures (1 h).
create or replace function public.live__throttled(p_bucket text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select count(*) from public.live_welcome_attempts a
      where a.bucket = p_bucket and not a.ok and a.at > now() - interval '15 minutes') >= 6
    or
    (select count(*) from public.live_welcome_attempts a
      where not a.ok and a.at > now() - interval '1 hour') >= 300;
$$;

create or replace function public.live__verify_code(p_code text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hash text;
begin
  if p_code is null or char_length(p_code) = 0 or char_length(p_code) > 64 then
    return false;
  end if;
  select value into v_hash from public.live_private_config where key = 'welcome_code_hash';
  if v_hash is null then
    return false; -- no code configured ⇒ nobody gets in by code
  end if;
  return extensions.crypt(p_code, v_hash) = v_hash;
end;
$$;

create or replace function public.live__default_name(p_uid uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select left(coalesce(
    nullif(trim(u.raw_user_meta_data->>'display_name'), ''),
    nullif(trim(concat_ws(' ', u.raw_user_meta_data->>'first_name', u.raw_user_meta_data->>'last_name')), ''),
    nullif(trim(p.username), ''),
    split_part(u.email, '@', 1),
    'Member'
  ), 40)
  from auth.users u
  left join public.profiles p on p.id = u.id
  where u.id = p_uid;
$$;

create or replace function public.live__is_member(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.live_profiles where user_id = p_uid);
$$;

create or replace function public.live__legacy_eligible(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.users u
    where u.id = p_uid
      and u.created_at < coalesce(
        (select value::timestamptz from public.live_private_config where key = 'legacy_cutoff'),
        '-infinity'::timestamptz)
  );
$$;

create or replace function public.live__profile_json(p_uid uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', lp.user_id,
    'display_name', lp.display_name,
    'verified_via', lp.verified_via,
    'created_at', lp.created_at
  )
  from public.live_profiles lp where lp.user_id = p_uid;
$$;

-- ------------------------------------------------------------- public RPCs

-- Check a welcome code before an account exists. Returns a one-time ticket.
create or replace function public.live_welcome_check(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_bucket text := 'ip:' || public.live__client_ip_hash();
  v_ok boolean;
  v_token text;
begin
  if public.live__throttled(v_bucket) then
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
  end if;
  v_ok := public.live__verify_code(p_code);
  insert into public.live_welcome_attempts (bucket, ok) values (v_bucket, v_ok);
  if not v_ok then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;
  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.live_welcome_tickets (token_hash, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), now() + interval '7 days');
  return jsonb_build_object('ok', true, 'ticket', v_token);
end;
$$;

-- Who am I to Stream Studio? Used by the app and by the live worker to verify
-- a bearer token + membership in one round trip.
create or replace function public.live_me()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('signed_in', false, 'member', false);
  end if;
  if public.live__is_member(v_uid) then
    return jsonb_build_object('signed_in', true, 'member', true, 'user_id', v_uid,
      'profile', public.live__profile_json(v_uid));
  end if;
  return jsonb_build_object('signed_in', true, 'member', false, 'user_id', v_uid,
    'needs_code', not public.live__legacy_eligible(v_uid),
    'suggested_name', public.live__default_name(v_uid));
end;
$$;

-- Become a member: with a sign-up ticket, with the code, or (pre-launch
-- accounts) with nothing. Idempotent for existing members.
create or replace function public.live_join(p_ticket text default null, p_code text default null, p_display_name text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_via text;
  v_bucket text;
  v_ok boolean;
  v_ticket_hash text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
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
  v_name text := left(trim(coalesce(p_display_name, '')), 40);
begin
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
  v_q text := lower(trim(coalesce(p_query, '')));
  v_like text;
begin
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

-- --------------------------------------------------------- baby monitor
create table if not exists public.monitor_nurseries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  baby_name text check (baby_name is null or char_length(baby_name) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_monitor_nurseries_owner on public.monitor_nurseries (owner_id);

create table if not exists public.monitor_members (
  nursery_id uuid not null references public.monitor_nurseries(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('parent', 'caregiver', 'viewer')),
  label text check (label is null or char_length(label) <= 30),
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (nursery_id, user_id)
);
create index if not exists idx_monitor_members_user on public.monitor_members (user_id);

-- RPC-only, like live_profiles: RLS on, no client grants, no policies.
alter table public.monitor_nurseries enable row level security;
alter table public.monitor_members enable row level security;
revoke all on public.monitor_nurseries from anon, authenticated;
revoke all on public.monitor_members from anon, authenticated;

create or replace function public.monitor__role(p_nursery uuid, p_uid uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role from public.monitor_members m
  where m.nursery_id = p_nursery and m.user_id = p_uid
    and exists (select 1 from public.live_profiles lp where lp.user_id = p_uid);
$$;

create or replace function public.monitor__nursery_json(p_nursery uuid, p_uid uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', n.id,
    'name', n.name,
    'baby_name', n.baby_name,
    'owner_id', n.owner_id,
    'owner_name', (select lp.display_name from public.live_profiles lp where lp.user_id = n.owner_id),
    'my_role', m.role,
    'my_label', m.label,
    'member_count', (select count(*) from public.monitor_members mm where mm.nursery_id = n.id),
    'created_at', n.created_at
  )
  from public.monitor_nurseries n
  join public.monitor_members m on m.nursery_id = n.id and m.user_id = p_uid
  where n.id = p_nursery;
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
begin
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
  v_id uuid;
  v_name text := left(trim(coalesce(p_name, '')), 60);
begin
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
  v_name text := left(trim(coalesce(p_name, '')), 60);
begin
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
begin
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
begin
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

-- Add someone (found by name) or change their role/label. Parents only.
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
begin
  if public.monitor__role(p_nursery, v_uid) is distinct from 'parent' then
    -- Anyone may relabel THEMSELVES (e.g. "Grandma") without changing their role.
    if p_user = v_uid and public.monitor__role(p_nursery, v_uid) is not null then
      update public.monitor_members set label = v_label where nursery_id = p_nursery and user_id = v_uid;
      return jsonb_build_object('ok', true);
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
  if not exists (select 1 from public.monitor_members where nursery_id = p_nursery and user_id = p_user)
     and (select count(*) from public.monitor_members where nursery_id = p_nursery) >= 20 then
    return jsonb_build_object('ok', false, 'error', 'limit_reached');
  end if;
  insert into public.monitor_members (nursery_id, user_id, role, label, added_by)
  values (p_nursery, p_user, p_role, v_label, v_uid)
  on conflict (nursery_id, user_id) do update set role = excluded.role, label = excluded.label;
  return jsonb_build_object('ok', true);
end;
$$;

-- Parents remove anyone but the owner; anyone (but the owner) may leave.
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
begin
  select owner_id into v_owner from public.monitor_nurseries where id = p_nursery;
  if v_owner is null or p_user = v_owner then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_user <> v_uid and public.monitor__role(p_nursery, v_uid) is distinct from 'parent' then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  delete from public.monitor_members where nursery_id = p_nursery and user_id = p_user;
  return jsonb_build_object('ok', true);
end;
$$;

-- The live worker's authorization check for a monitor socket (called with the
-- connecting user's own bearer token).
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
begin
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
    'baby_name', (select baby_name from public.monitor_nurseries where id = p_nursery)
  );
end;
$$;

-- Current member ids — lets the room drop sockets of people just removed.
create or replace function public.monitor_member_ids(p_nursery uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
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

-- ------------------------------------------------------------------ admin
create or replace function public.live_admin_set_welcome_code(p_code text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_code is null or char_length(p_code) < 6 or char_length(p_code) > 64 then
    raise exception 'welcome code must be 6–64 characters';
  end if;
  insert into public.live_private_config (key, value, updated_at)
  values ('welcome_code_hash', extensions.crypt(p_code, extensions.gen_salt('bf', 10)), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$$;

-- ------------------------------------------------------------------ grants
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.live__client_ip_hash()',
    'public.live__throttled(text)',
    'public.live__verify_code(text)',
    'public.live__default_name(uuid)',
    'public.live__is_member(uuid)',
    'public.live__legacy_eligible(uuid)',
    'public.live__profile_json(uuid)',
    'public.monitor__nursery_json(uuid, uuid)',
    'public.monitor__role(uuid, uuid)',
    'public.live_admin_set_welcome_code(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;

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
    'public.monitor_set_member(uuid, uuid, text, text)',
    'public.monitor_remove_member(uuid, uuid)',
    'public.monitor_my_role(uuid)',
    'public.monitor_member_ids(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  -- The only anonymous entry point: check a code before an account exists.
  revoke all on function public.live_welcome_check(text) from public;
  grant execute on function public.live_welcome_check(text) to anon, authenticated;
end $$;

-- ------------------------------------------------------------------ janitor
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'live-welcome-sweep';
    perform cron.schedule(
      'live-welcome-sweep',
      '23 4 * * *',
      $job$
        delete from public.live_welcome_attempts where at < now() - interval '7 days';
        delete from public.live_welcome_tickets where expires_at < now() - interval '1 day';
      $job$
    );
  end if;
end $$;
