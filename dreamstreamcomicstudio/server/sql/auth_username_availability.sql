-- Apply before releasing the username availability and private password sign-in routes.
-- Existing case and casing of display names stay intact. As of 2026-11-23 the Comic
-- project has zero rows with edge whitespace or duplicate lower(trim(username)).
begin;
create unique index if not exists profiles_username_lower_unique
  on public.profiles (lower(username)) where username is not null;
do $$ begin
  if not exists (select from pg_constraint where conrelid = 'public.profiles'::regclass
    and conname = 'profiles_username_trimmed') then
    alter table public.profiles add constraint profiles_username_trimmed check (username = btrim(username)) not valid;
  end if;
end $$;
alter table public.profiles validate constraint profiles_username_trimmed;

-- The server accepts at most four validated handles. It uses the private profile ID
-- to verify a password against that same current account, never a cached email address.
create or replace function public.lookup_signup_handles(candidates text[])
returns table(handle text, profile_id uuid)
language sql stable security invoker set search_path = '' as $$
  select lower(p.username), p.id from public.profiles p
  where p.username is not null and lower(p.username) = any(
    array(select lower(btrim(c)) from unnest(candidates[1:4]) c))
$$;
revoke all on function public.lookup_signup_handles(text[]) from public, anon, authenticated;
grant execute on function public.lookup_signup_handles(text[]) to service_role;
commit;
