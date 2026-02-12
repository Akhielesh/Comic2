-- Enforce signup policy: minimum age 8 years, unique username index, and username lookup RPC.
-- Run this after:
--   1) server/sql/supabase_auth_profile_migration.sql
--   2) server/sql/profile_private_email_preferences.sql

create unique index if not exists profiles_username_lower_unique
  on public.profiles (lower(username))
  where username is not null;

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

create or replace function public.handle_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
  v_first_name text;
  v_dob_text text;
  v_dob date;
  v_email_pref_product_updates boolean;
  v_email_pref_marketing boolean;
begin
  v_username := nullif(trim(coalesce(new.raw_user_meta_data->>'username','')), '');
  if v_username is null then
    raise exception 'Username is required';
  end if;

  v_first_name := nullif(trim(coalesce(new.raw_user_meta_data->>'first_name','')), '');
  if v_first_name is null then
    raise exception 'First name is required';
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

  if v_dob > (current_date - interval '8 years')::date then
    raise exception 'Users must be at least 8 years old to sign up';
  end if;

  v_email_pref_product_updates := coalesce((new.raw_user_meta_data->>'email_pref_product_updates')::boolean, true);
  v_email_pref_marketing := coalesce((new.raw_user_meta_data->>'email_pref_marketing')::boolean, false);

  insert into public.profiles (id, email, username, terms_accepted, marketing_consent)
  values (
    new.id,
    new.email,
    v_username,
    coalesce((new.raw_user_meta_data->>'terms_accepted')::boolean, false),
    coalesce((new.raw_user_meta_data->>'marketing_consent')::boolean, v_email_pref_marketing, false)
  )
  on conflict (id) do update
    set email = excluded.email,
        username = excluded.username,
        terms_accepted = excluded.terms_accepted,
        marketing_consent = excluded.marketing_consent;

  insert into public.profile_private (
    id,
    first_name,
    last_name,
    phone_number,
    dob,
    email_pref_product_updates,
    email_pref_marketing
  )
  values (
    new.id,
    v_first_name,
    nullif(trim(coalesce(new.raw_user_meta_data->>'last_name','')), ''),
    nullif(trim(coalesce(new.raw_user_meta_data->>'phone_number','')), ''),
    v_dob,
    v_email_pref_product_updates,
    v_email_pref_marketing
  )
  on conflict (id) do update
    set first_name = coalesce(excluded.first_name, public.profile_private.first_name),
        last_name = coalesce(excluded.last_name, public.profile_private.last_name),
        phone_number = coalesce(excluded.phone_number, public.profile_private.phone_number),
        dob = coalesce(excluded.dob, public.profile_private.dob),
        email_pref_product_updates = coalesce(excluded.email_pref_product_updates, public.profile_private.email_pref_product_updates),
        email_pref_marketing = coalesce(excluded.email_pref_marketing, public.profile_private.email_pref_marketing);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_auth_user_created();
