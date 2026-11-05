-- A moderation hold always unlists the comic (gate F4/S3, 2026-10).
--
-- Apply with the Supabase MCP `apply_migration`, name `comic_hold_unlists_2026_10`, on the "Comic"
-- project (bdjfmxfmhqhzvgrhbbzm), AFTER comic_security_guard_2026_10.sql and comic_publications.sql
-- (comic_studio_v4_publications). Idempotent: create or replace / drop trigger if exists / an
-- update that only touches rows still in the invalid state. Safe to re-apply.
--
-- Why: the v5 hold paths (reader-report auto hold, moderator withhold / force_private) set
-- projects.is_forced_private but left projects.is_public = true, so a held comic stayed in the
-- public gallery (cover, G/PG badge, Kids-friendly filter), on profile pages, in public stats and
-- in direct anonymous REST reads (projects RLS: is_public or owner). The server now writes
-- is_public = false with every hold (safety/store.ts forcePrivate, like routes/admin.ts); this
-- file is the database backstop for every other writer (a future server path, a manual SQL hold):
--   * projects_hold_unlists — BEFORE UPDATE OF is_forced_private: when a hold turns ON
--     (false → true), the same row write also sets is_public := false. Lifting a hold never lists
--     the comic again (the publication stays suspended; the owner republishes).
--   * a one-off heal of rows already in the state comic_security_guard_2026_10.sql calls never
--     valid (forced private AND public).
-- The P0-SEC guard (projects_guard_client_writes (c)) already refuses false → true on is_public
-- while forced private, so together a held comic can never be public.
--
-- Trigger order (BEFORE triggers fire alphabetically): projects_guard_client_writes,
-- projects_guard_publication_state, projects_hold_unlists — the hold's unlisting is the last word.
-- The heal's UPDATE does not name is_forced_private, so neither this trigger nor
-- projects_suspend_publication fires for it; it runs as the migration role (service_role in the
-- guards), so no client guard blocks it.
--
-- PROD STEPS check (expect 0): select count(*) from public.projects where is_forced_private and is_public;

create or replace function public.projects_hold_unlists()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(new.is_forced_private, false) and not coalesce(old.is_forced_private, false) then
    new.is_public := false;
  end if;
  return new;
end;
$$;

revoke all on function public.projects_hold_unlists() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'projects' and column_name = 'is_forced_private') then
    execute 'drop trigger if exists projects_hold_unlists on public.projects';
    execute 'create trigger projects_hold_unlists before update of is_forced_private on public.projects '
         || 'for each row execute function public.projects_hold_unlists()';
    execute 'update public.projects set is_public = false where is_forced_private = true and is_public = true';
  end if;
end $$;

-- Post-apply assertion: fail the migration rather than ship a held, listed comic.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'projects' and column_name = 'is_forced_private') then
    if not exists (select 1 from pg_trigger t
                    where t.tgrelid = 'public.projects'::regclass and t.tgname = 'projects_hold_unlists' and not t.tgisinternal) then
      raise exception 'projects_hold_unlists trigger is missing';
    end if;
    if exists (select 1 from public.projects where is_forced_private = true and is_public = true) then
      raise exception 'a forced-private project is still public';
    end if;
  end if;
end $$;
