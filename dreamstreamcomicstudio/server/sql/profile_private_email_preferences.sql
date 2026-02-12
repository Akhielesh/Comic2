-- Adds private email preferences and tightens signup metadata validation.
-- Apply this after server/sql/supabase_auth_profile_migration.sql.

alter table public.profile_private
  add column if not exists email_pref_product_updates boolean not null default true,
  add column if not exists email_pref_marketing boolean not null default false;

update public.profile_private pp
set
  email_pref_product_updates = coalesce(pp.email_pref_product_updates, true),
  email_pref_marketing = coalesce(pp.email_pref_marketing, p.marketing_consent, false)
from public.profiles p
where p.id = pp.id;

create or replace function public.sync_marketing_consent_from_private()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
  set marketing_consent = coalesce(new.email_pref_marketing, false)
  where id = new.id;
  return new;
end;
$$;

drop trigger if exists trg_profile_private_sync_marketing on public.profile_private;
create trigger trg_profile_private_sync_marketing
after insert or update of email_pref_marketing on public.profile_private
for each row execute function public.sync_marketing_consent_from_private();

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
