-- Supabase full auth + private profile metadata migration
-- Apply this in Supabase SQL Editor.

-- 1) Private profile table (DOB + personal fields)
create table if not exists public.profile_private (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text,
  last_name text,
  phone_number text,
  dob date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profile_private_dob_not_future check (dob is null or dob <= current_date),
  constraint profile_private_phone_format check (
    phone_number is null or phone_number ~ '^[+0-9()\\-\\s]{7,20}$'
  )
);

-- 2) Ensure profiles has required columns used by app
alter table public.profiles add column if not exists terms_accepted boolean not null default false;
alter table public.profiles add column if not exists marketing_consent boolean not null default false;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

-- 3) Username uniqueness (case-insensitive)
create unique index if not exists profiles_username_lower_unique
  on public.profiles (lower(username))
  where username is not null;

-- 4) updated_at helper
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_touch_updated_at on public.profiles;
create trigger trg_profiles_touch_updated_at
before update on public.profiles
for each row execute function public.touch_updated_at();

drop trigger if exists trg_profile_private_touch_updated_at on public.profile_private;
create trigger trg_profile_private_touch_updated_at
before update on public.profile_private
for each row execute function public.touch_updated_at();

-- 5) Auth user -> profile sync with mandatory DOB for new signups
create or replace function public.handle_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
  v_dob_text text;
  v_dob date;
begin
  v_username := nullif(trim(coalesce(new.raw_user_meta_data->>'username','')), '');
  if v_username is null then
    v_username := split_part(new.email, '@', 1);
  end if;

  v_dob_text := nullif(trim(coalesce(new.raw_user_meta_data->>'dob','')), '');
  if v_dob_text is null then
    raise exception 'DOB is required';
  end if;

  begin
    v_dob := v_dob_text::date;
  exception when others then
    raise exception 'DOB must be YYYY-MM-DD';
  end;

  if v_dob > current_date then
    raise exception 'DOB cannot be in the future';
  end if;

  insert into public.profiles (id, email, username, terms_accepted, marketing_consent)
  values (
    new.id,
    new.email,
    v_username,
    coalesce((new.raw_user_meta_data->>'terms_accepted')::boolean, false),
    coalesce((new.raw_user_meta_data->>'marketing_consent')::boolean, false)
  )
  on conflict (id) do update
    set email = excluded.email,
        username = coalesce(excluded.username, public.profiles.username);

  insert into public.profile_private (id, first_name, last_name, phone_number, dob)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data->>'first_name','')), ''),
    nullif(trim(coalesce(new.raw_user_meta_data->>'last_name','')), ''),
    nullif(trim(coalesce(new.raw_user_meta_data->>'phone_number','')), ''),
    v_dob
  )
  on conflict (id) do update
    set first_name = coalesce(excluded.first_name, public.profile_private.first_name),
        last_name = coalesce(excluded.last_name, public.profile_private.last_name),
        phone_number = coalesce(excluded.phone_number, public.profile_private.phone_number),
        dob = coalesce(excluded.dob, public.profile_private.dob);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_auth_user_created();

-- 6) Username -> email resolver for login (security definer)
create or replace function public.resolve_email_from_username(login_username text)
returns table(email text)
language sql
security definer
set search_path = public
as $$
  select p.email
  from public.profiles p
  where lower(p.username) = lower(trim(login_username))
  limit 1;
$$;

revoke all on function public.resolve_email_from_username(text) from public;
grant execute on function public.resolve_email_from_username(text) to anon, authenticated;

-- 7) RLS for private table
alter table public.profile_private enable row level security;

drop policy if exists profile_private_select_own on public.profile_private;
create policy profile_private_select_own
on public.profile_private for select
to authenticated
using (auth.uid() = id);

drop policy if exists profile_private_insert_own on public.profile_private;
create policy profile_private_insert_own
on public.profile_private for insert
to authenticated
with check (auth.uid() = id);

drop policy if exists profile_private_update_own on public.profile_private;
create policy profile_private_update_own
on public.profile_private for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- 8) Backfill private rows for existing users (DOB left null to trigger app prompt)
insert into public.profile_private (id)
select p.id
from public.profiles p
left join public.profile_private pp on pp.id = p.id
where pp.id is null;
