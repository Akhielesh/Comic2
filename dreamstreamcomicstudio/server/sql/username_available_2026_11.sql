-- username_available (2026-11) — sign-up's "is this username free?" without revealing any email.
--
-- Why (authz-data-6): sign-up used to check availability with resolve_email_from_username, which
-- returns the email address behind any username to anyone holding the public anon key. This
-- function answers the only thing sign-up needs — taken or free — and nothing else.
-- components/AuthPage.tsx calls it for the availability check; while it is absent there (before this
-- file is applied) AuthPage skips the pre-check and the unique index profiles_username_lower_unique
-- still refuses a taken name at account creation.
--
-- Agreed shape (with the DreamStream session): returns boolean only; SECURITY DEFINER (anon cannot
-- read public.profiles directly for every row); STABLE; `search_path = ''` with every name
-- schema-qualified; EXECUTE revoked from PUBLIC first (a new function is PUBLIC-executable by
-- default, SECURITY-PLAN N4), then granted to anon and authenticated (sign-up happens signed out)
-- and service_role.
--
-- Matches the unique index's comparison: lower(username) against the trimmed, lower-cased input,
-- so the index serves the lookup. A blank or null input is "not available" (never a free name).
-- It does not throttle: availability is an enumeration oracle by nature, the same one the unique
-- index exposes at sign-up, and usernames are public on profiles already.
--
-- Additive and idempotent. Apply before (or with) the AuthPage deploy; the resolver revoke comes
-- later (SECURITY-PLAN §2.5a: after the sign-in decision and 24 h of zero resolver calls).
-- Rollback: drop function if exists public.username_available(text);

create or replace function public.username_available(p_username text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(trim(p_username), '') is not null
     and not exists (
       select 1
         from public.profiles p
        where lower(p.username) = lower(trim(p_username))
     );
$$;

revoke all on function public.username_available(text) from public;
grant execute on function public.username_available(text) to anon, authenticated, service_role;

-- Post-apply check (read-only): anon true, auth true, and the answer for a blank name is false.
-- select has_function_privilege('anon', 'public.username_available(text)', 'execute') anon,
--        has_function_privilege('authenticated', 'public.username_available(text)', 'execute') auth,
--        public.username_available('  ') blank;
