-- Comic Studio security guard (P0-SEC, 2026-10).
--
-- Apply with the Supabase MCP `apply_migration`, name `comic_security_guard_2026_10`, on the
-- "Comic" project (bdjfmxfmhqhzvgrhbbzm). Every statement is idempotent (create or replace /
-- if not exists / drop ... if exists / on conflict), so re-applying is safe.
--
-- Closes:
--   1. Client `is_public` bypass on Comic Studio v4 projects, and the owner moderation bypass:
--      the `Users can manage their own projects` RLS policy lets the owner write every column,
--      including is_forced_private / forced_private_* / republish_*.
--   2. `increment_project_view` counted views on any project id (private, forced-private, v4).
--   3. Retention: `purge_expired_image_assets(p_bucket)` marked every due row deleted but removed
--      objects only from p_bucket, and `run_image_asset_retention()` covered comic-assets only.
--      The purge also tripped `storage.protect_delete()` (the cron job failed every night).
--   4. The private bucket `comic-private` (refs and quarantine) with NO storage.objects policies.
--   5. A one-off cleanup: public v4 rows never carry a live draft path in state.coverImageId.
--   6. (verification pass) Client re-saves of a v4 row's listing state can't replace the
--      server-mirrored coverImageId / stylePrompt (a stale cached draft cover path would
--      otherwise reach the gallery once the row is public; comic-assets is a public bucket).
--   7. (verification pass) collect_active_image_paths() only knew a fixed list of classic keys;
--      live rows reference images under others (thumbnailImageId, nested imageId), which the
--      now-working purge would have deleted. It now counts every path-like string leaf, and
--      the purge re-checks references at delete time. refresh/collect are no longer client RPCs.
--
-- Caller identity: `coalesce(auth.role(), 'service_role')`. PostgREST sets the JWT claims for
-- anon / authenticated callers; the server's service-role client reports `service_role`; SQL
-- editor, migration and pg_cron sessions carry no claims and coalesce to service_role.
-- SECURITY DEFINER functions invoked by a client keep the client's claims, so an RPC can never
-- launder a client write past the guard.

-- ── 1. projects_guard_client_writes ─────────────────────────────────────────────────────────

create or replace function public.projects_guard_client_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
begin
  if tg_op = 'INSERT' then
    if not v_is_service then
      -- (a) moderation columns are server-only: a client insert always gets the defaults.
      new.is_forced_private := false;
      new.forced_private_reason := null;
      new.forced_private_by := null;
      new.forced_private_at := null;
      new.republish_request_status := 'none';
      new.republish_request_reason := null;
      new.republish_requested_at := null;
      new.republish_requested_by := null;
      new.republish_reviewed_at := null;
      new.republish_reviewed_by := null;
      new.republish_review_reason := null;
    end if;
    -- (c) a project is never created public while forced private.
    if coalesce(new.is_public, false) and coalesce(new.is_forced_private, false) then
      raise exception 'This comic was made private by moderation and cannot be published.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE
  if not v_is_service then
    -- (a) moderation columns are server-only.
    if new.is_forced_private        is distinct from old.is_forced_private
       or new.forced_private_reason is distinct from old.forced_private_reason
       or new.forced_private_by     is distinct from old.forced_private_by
       or new.forced_private_at     is distinct from old.forced_private_at
       or new.republish_request_status is distinct from old.republish_request_status
       or new.republish_request_reason is distinct from old.republish_request_reason
       or new.republish_requested_at   is distinct from old.republish_requested_at
       or new.republish_requested_by   is distinct from old.republish_requested_by
       or new.republish_reviewed_at    is distinct from old.republish_reviewed_at
       or new.republish_reviewed_by    is distinct from old.republish_reviewed_by
       or new.republish_review_reason  is distinct from old.republish_review_reason then
      raise exception 'Moderation fields can only be changed by DreamStream.'
        using errcode = '42501';
    end if;

    if exists (select 1 from public.comic_docs d where d.project_id = old.id) then
      -- (b) v4 visibility is server-only (the studio Share sheet publishes through the server).
      if new.is_public is distinct from old.is_public then
        raise exception 'Publish Comic Studio comics from the studio Share sheet.'
          using errcode = '42501';
      end if;
      -- (e) The v4 listing state's cover path and style text are server-owned. The classic
      -- client re-saves its cached state (rename, overview edits); that copy can carry a live
      -- draft cover path written while the row was private, which the gallery would then show
      -- (comic-assets is a public bucket). Keep whatever the server mirror last wrote.
      if new.state is distinct from old.state then
        new.state := (coalesce(new.state, '{}'::jsonb) - 'coverImageId' - 'stylePrompt')
          || jsonb_strip_nulls(jsonb_build_object(
               'coverImageId', coalesce(old.state, '{}'::jsonb) -> 'coverImageId',
               'stylePrompt', coalesce(old.state, '{}'::jsonb) -> 'stylePrompt'));
      end if;
    end if;
  end if;

  -- (c) false -> true while forced private is refused for every caller: a public,
  -- forced-private row is never a valid state (the moderation approve flow clears
  -- is_forced_private in the same statement, so it passes).
  if coalesce(new.is_public, false)
     and not coalesce(old.is_public, false)
     and coalesce(new.is_forced_private, false) then
    raise exception 'This comic was made private by moderation and cannot be published.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.projects_guard_client_writes() from public, anon, authenticated;

drop trigger if exists projects_guard_client_writes on public.projects;
create trigger projects_guard_client_writes
  before insert or update on public.projects
  for each row execute function public.projects_guard_client_writes();

-- ── 2. increment_project_view: public, non-forced, classic projects only ────────────────────
-- v4 views will go through the publication tracker (P1-PUBLISH); a private, forced-private or
-- v4 id is a silent no-op.

create or replace function public.increment_project_view(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.projects p
     set views_count = coalesce(p.views_count, 0) + 1
   where p.id = p_id
     and p.is_public = true
     and coalesce(p.is_forced_private, false) = false
     and not exists (select 1 from public.comic_docs d where d.project_id = p.id);
end;
$$;

revoke all on function public.increment_project_view(uuid) from public;
grant execute on function public.increment_project_view(uuid) to anon, authenticated, service_role;

-- ── 3. Retention: per-bucket purge, both buckets ────────────────────────────────────────────
-- 3a. collect_active_image_paths(): the old version only looked at a fixed list of classic
-- state keys. Live classic rows also reference images under other keys (verified 2026-10-22:
-- `thumbnailImageId`, nested `imageId`s outside panels/characters/items/locations), so those
-- assets would be marked unreferenced and — now that the purge actually runs — deleted. Every
-- string leaf containing a '/' anywhere in projects.state / artifacts.data / comic_docs.doc
-- now counts as referenced (a superset of the old list; ~2 s on the live data, nightly).

create or replace function public.collect_active_image_paths()
returns table(path text)
language sql
stable
set search_path = public
as $$
  with project_paths as (
    select nullif(btrim(v #>> '{}'), '') as path
      from public.projects p,
           lateral jsonb_path_query(coalesce(p.state, '{}'::jsonb), 'strict $.**') v
     where jsonb_typeof(v) = 'string'
       and position('/' in (v #>> '{}')) > 0
    union all
    select nullif(btrim(jk), '')
      from public.projects p,
           lateral jsonb_object_keys(case when jsonb_typeof(p.state -> 'imageTags') = 'object' then p.state -> 'imageTags' else '{}'::jsonb end) jk
  ),
  artifact_paths as (
    select nullif(btrim(v #>> '{}'), '') as path
      from public.artifacts a,
           lateral jsonb_path_query(coalesce(a.data, '{}'::jsonb), 'strict $.**') v
     where jsonb_typeof(v) = 'string'
       and position('/' in (v #>> '{}')) > 0
  ),
  comic_doc_paths as (
    select nullif(btrim(v #>> '{}'), '') as path
      from public.comic_docs d,
           lateral jsonb_path_query(d.doc, 'strict $.**') v
     where jsonb_typeof(v) = 'string'
       and position('/' in (v #>> '{}')) > 0
  )
  select distinct path
    from (
      select path from project_paths
      union all
      select path from artifact_paths
      union all
      select path from comic_doc_paths
    ) combined
   where path is not null and path <> '';
$$;

-- `due` is filtered by bucket, so a purge only marks rows whose objects it removes. Quarantine
-- rows (`q/...` in comic-private) carry a 90-day expires_at set when quarantined; the purge only
-- takes rows whose expires_at has passed, and refresh_image_asset_references() keeps an
-- existing expires_at (coalesce), so the 90-day hold is respected.
--
-- NON-DESTRUCTIVE by design. storage.protect_delete() refuses direct deletes from storage.objects
-- (the previous version failed every night because of it). Bypassing it with
-- `storage.allow_delete_query` would remove the object ROW but strand the blob in the backing
-- store forever — unreachable, uncleanable, still billed. So this function only COUNTS rows that
-- are expired and referenced by nothing (re-checked against collect_active_image_paths() at call
-- time); it deletes nothing and marks nothing. A server-side sweep through the Storage API (which
-- deletes the blob and the row together) is the follow-up that will act on this set and then set
-- image_assets.deleted_at.

create or replace function public.purge_expired_image_assets(p_bucket text default 'comic-assets')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket text := coalesce(nullif(btrim(p_bucket), ''), 'comic-assets');
  v_due integer := 0;
begin
  if v_bucket not in ('comic-assets', 'comic-private') then
    raise exception 'purge_expired_image_assets: unknown bucket %', v_bucket using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.image_assets
     where deleted_at is null
       and expires_at is not null
       and expires_at <= now()
       and coalesce(bucket, 'comic-assets') = v_bucket
  ) then
    return 0;
  end if;

  with active as materialized (
    select a.path from public.collect_active_image_paths() a
  )
  select count(*) into v_due
    from public.image_assets ia
   where ia.deleted_at is null
     and ia.expires_at is not null
     and ia.expires_at <= now()
     and coalesce(ia.bucket, 'comic-assets') = v_bucket
     -- Never count a path something references right now, even if it was marked earlier.
     and not exists (select 1 from active a where a.path = ia.path);

  return v_due;
end;
$$;

create or replace function public.run_image_asset_retention()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_marked integer := 0;
  v_deleted_assets integer := 0;
  v_deleted_private integer := 0;
begin
  select marked_count into v_marked from public.refresh_image_asset_references(30, 15);
  v_deleted_assets := public.purge_expired_image_assets('comic-assets');
  v_deleted_private := public.purge_expired_image_assets('comic-private');

  -- Nothing is deleted here (see purge_expired_image_assets): these are counts of expired,
  -- unreferenced objects awaiting the Storage API sweep.
  return jsonb_build_object(
    'marked_for_expiry', coalesce(v_marked, 0),
    'deleted', 0,
    'due_for_sweep', coalesce(v_deleted_assets, 0) + coalesce(v_deleted_private, 0),
    'due_for_sweep_by_bucket', jsonb_build_object(
      'comic-assets', coalesce(v_deleted_assets, 0),
      'comic-private', coalesce(v_deleted_private, 0)
    ),
    'run_at', now()
  );
end;
$$;

-- Retention is a cron/service job, never a client RPC (all four were executable by anon;
-- refresh is SECURITY DEFINER and full-scans every project, comic doc and artifact).
revoke all on function public.purge_expired_image_assets(text) from public, anon, authenticated;
revoke all on function public.refresh_image_asset_references(integer, integer) from public, anon, authenticated;
revoke all on function public.collect_active_image_paths() from public, anon, authenticated;
grant execute on function public.refresh_image_asset_references(integer, integer) to service_role;
grant execute on function public.collect_active_image_paths() to service_role;
revoke all on function public.run_image_asset_retention() from public, anon, authenticated;
grant execute on function public.purge_expired_image_assets(text) to service_role;
grant execute on function public.run_image_asset_retention() to service_role;

-- ── 4. Private bucket comic-private (refs + quarantine) ────────────────────────────────────
-- No storage.objects policies at all: only the service role (the server) can read or write it;
-- the owner gets 5-minute signed URLs from the server.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('comic-private', 'comic-private', false, 10485760, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ASSERTION (verified live on 2026-10-22): anon has NO SELECT on storage.objects for
-- comic-assets or comic-private, so neither bucket can be listed anonymously. comic-assets
-- objects are fetchable only by exact path (public bucket); comic-private only via server-signed
-- URLs. The only storage.objects policies are owner-folder scoped (`Authenticated Manage`,
-- `Authenticated Upload` on comic-assets/<uid>/..., and the comic-aasets typo-bucket folder
-- policies). The block below fails the migration if that ever stops being true.
do $$
begin
  if exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and (coalesce(qual, '') ilike '%comic-private%' or coalesce(with_check, '') ilike '%comic-private%')
  ) then
    raise exception 'comic-private must have no storage.objects policies';
  end if;
  if exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and cmd in ('SELECT', 'ALL')
       and (roles && array['anon', 'public']::name[])
       and (coalesce(qual, '') ilike '%comic-assets%' or coalesce(qual, '') = '' or coalesce(qual, '') = 'true')
       and coalesce(qual, '') not ilike '%auth.uid()%'
  ) then
    raise exception 'anon must not be able to list storage.objects in comic-assets';
  end if;
end;
$$;

-- ── 5. Cleanup: no live draft path on public v4 rows ───────────────────────────────────────
-- The gallery reads projects.state of public rows. A v4 row carries coverImageId only while
-- private (P1-PUBLISH later writes the opaque pub/ cover). There were 0 public v4 rows on
-- 2026-10-22; this keeps the invariant if any appeared before the guard landed.

update public.projects p
   set state = (p.state - 'coverImageId') || jsonb_build_object('stylePrompt', '')
 where p.is_public = true
   and exists (select 1 from public.comic_docs d where d.project_id = p.id)
   and (
     (p.state ? 'coverImageId' and coalesce(p.state ->> 'coverImageId', '') not like 'pub/%')
     or coalesce(p.state ->> 'stylePrompt', '') <> ''
   );
