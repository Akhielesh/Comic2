-- Image asset metadata + lifecycle retention for Supabase Storage.
-- Apply in Supabase SQL editor after core tables exist.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.image_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid null references public.projects(id) on delete set null,
  bucket text not null default 'comic-assets',
  path text not null unique,
  mime_type text not null default 'image/webp',
  bytes bigint not null default 0,
  width integer null,
  height integer null,
  source text not null default 'upload',
  created_at timestamptz not null default now(),
  last_referenced_at timestamptz not null default now(),
  expires_at timestamptz null,
  deleted_at timestamptz null
);

create index if not exists image_assets_user_created_idx
  on public.image_assets (user_id, created_at desc);

create index if not exists image_assets_project_created_idx
  on public.image_assets (project_id, created_at desc);

create index if not exists image_assets_expires_active_idx
  on public.image_assets (expires_at)
  where deleted_at is null;

alter table public.image_assets enable row level security;

drop policy if exists image_assets_select_own on public.image_assets;
create policy image_assets_select_own
on public.image_assets for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists image_assets_insert_own on public.image_assets;
create policy image_assets_insert_own
on public.image_assets for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists image_assets_update_own on public.image_assets;
create policy image_assets_update_own
on public.image_assets for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create or replace function public.register_image_asset(
  p_path text,
  p_bucket text default 'comic-assets',
  p_mime_type text default 'image/webp',
  p_bytes bigint default 0,
  p_width integer default null,
  p_height integer default null,
  p_source text default 'upload',
  p_project_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;

  insert into public.image_assets (
    user_id, project_id, bucket, path, mime_type, bytes, width, height, source, last_referenced_at, expires_at, deleted_at
  )
  values (
    v_user, p_project_id, coalesce(p_bucket, 'comic-assets'), p_path, coalesce(p_mime_type, 'image/webp'),
    coalesce(p_bytes, 0), p_width, p_height, coalesce(p_source, 'upload'), now(), null, null
  )
  on conflict (path) do update
    set project_id = coalesce(excluded.project_id, public.image_assets.project_id),
        mime_type = excluded.mime_type,
        bytes = excluded.bytes,
        width = excluded.width,
        height = excluded.height,
        source = excluded.source,
        last_referenced_at = now(),
        expires_at = null,
        deleted_at = null
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.register_image_asset(text, text, text, bigint, integer, integer, text, uuid) from public;
grant execute on function public.register_image_asset(text, text, text, bigint, integer, integer, text, uuid) to authenticated;

create or replace function public.collect_active_image_paths()
returns table(path text)
language sql
stable
as $$
  with project_paths as (
    select nullif(trim(p.state->>'coverImageId'), '') as path
    from public.projects p
    union all
    select nullif(trim(p.state->>'coverTemplateImageId'), '')
    from public.projects p
    union all
    select nullif(trim(panel->>'imageId'), '')
    from public.projects p,
         lateral jsonb_array_elements(coalesce(p.state->'panels', '[]'::jsonb)) panel
    union all
    select nullif(trim(history_id), '')
    from public.projects p,
         lateral jsonb_array_elements(coalesce(p.state->'panels', '[]'::jsonb)) panel,
         lateral jsonb_array_elements_text(coalesce(panel->'imageIdHistory', '[]'::jsonb)) history_id
    union all
    select nullif(trim(entity->>'imageId'), '')
    from public.projects p,
         lateral jsonb_array_elements(coalesce(p.state->'characters', '[]'::jsonb)) entity
    union all
    select nullif(trim(entity->>'imageId'), '')
    from public.projects p,
         lateral jsonb_array_elements(coalesce(p.state->'items', '[]'::jsonb)) entity
    union all
    select nullif(trim(entity->>'imageId'), '')
    from public.projects p,
         lateral jsonb_array_elements(coalesce(p.state->'locations', '[]'::jsonb)) entity
    union all
    select nullif(trim(ref_id), '')
    from public.projects p,
         lateral jsonb_array_elements(coalesce(p.state->'characters', '[]'::jsonb)) entity,
         lateral jsonb_array_elements_text(coalesce(entity->'referenceImageIds', '[]'::jsonb)) ref_id
    union all
    select nullif(trim(ref_id), '')
    from public.projects p,
         lateral jsonb_array_elements(coalesce(p.state->'items', '[]'::jsonb)) entity,
         lateral jsonb_array_elements_text(coalesce(entity->'referenceImageIds', '[]'::jsonb)) ref_id
    union all
    select nullif(trim(ref_id), '')
    from public.projects p,
         lateral jsonb_array_elements(coalesce(p.state->'locations', '[]'::jsonb)) entity,
         lateral jsonb_array_elements_text(coalesce(entity->'referenceImageIds', '[]'::jsonb)) ref_id
    union all
    select nullif(trim(variant->>'imageId'), '')
    from public.projects p,
         lateral jsonb_array_elements(coalesce(p.state->'styleVariants', '[]'::jsonb)) variant
    union all
    select nullif(trim(tag_key), '')
    from public.projects p,
         lateral jsonb_object_keys(coalesce(p.state->'imageTags', '{}'::jsonb)) tag_key
  ),
  artifact_paths as (
    select nullif(trim(a.data->>'outputImageId'), '') as path
    from public.artifacts a
    union all
    select nullif(trim(input_id), '')
    from public.artifacts a,
         lateral jsonb_array_elements_text(coalesce(a.data->'inputImageIds', '[]'::jsonb)) input_id
  )
  select distinct path
  from (
    select path from project_paths
    union all
    select path from artifact_paths
  ) combined
  where path is not null and path <> '';
$$;

create or replace function public.refresh_image_asset_references(
  p_stale_days integer default 30,
  p_grace_days integer default 15
)
returns table(marked_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_marked integer := 0;
begin
  update public.image_assets ia
  set last_referenced_at = now(),
      expires_at = null,
      deleted_at = null
  where ia.deleted_at is null
    and ia.path in (select path from public.collect_active_image_paths());

  with active_paths as (
    select path from public.collect_active_image_paths()
  ), marked as (
    update public.image_assets ia
    set expires_at = coalesce(ia.expires_at, now() + make_interval(days => greatest(p_grace_days, 1)))
    where ia.deleted_at is null
      and not exists (select 1 from active_paths ap where ap.path = ia.path)
      and coalesce(ia.last_referenced_at, ia.created_at) <= now() - make_interval(days => greatest(p_stale_days, 1))
    returning ia.id
  )
  select count(*) into v_marked from marked;

  return query select v_marked;
end;
$$;

create or replace function public.purge_expired_image_assets(
  p_bucket text default 'comic-assets'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer := 0;
begin
  with due as (
    select id, path
    from public.image_assets
    where deleted_at is null
      and expires_at is not null
      and expires_at <= now()
  ), remove_storage as (
    delete from storage.objects so
    using due d
    where so.bucket_id = coalesce(p_bucket, 'comic-assets')
      and so.name = d.path
    returning d.id
  ), mark_deleted as (
    update public.image_assets ia
    set deleted_at = now()
    from due d
    where ia.id = d.id
    returning ia.id
  )
  select count(*) into v_deleted from mark_deleted;

  return v_deleted;
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
  v_deleted integer := 0;
begin
  select marked_count into v_marked from public.refresh_image_asset_references(30, 15);
  v_deleted := public.purge_expired_image_assets('comic-assets');

  return jsonb_build_object(
    'marked_for_expiry', coalesce(v_marked, 0),
    'deleted', coalesce(v_deleted, 0),
    'run_at', now()
  );
end;
$$;

-- Optional scheduler setup (requires pg_cron extension on project).
create extension if not exists pg_cron with schema extensions;

do $do$
declare
  v_existing integer;
begin
  select jobid
    into v_existing
  from cron.job
  where jobname = 'image-asset-retention-daily'
  limit 1;

  if v_existing is not null then
    perform cron.unschedule(v_existing);
  end if;

  perform cron.schedule(
    'image-asset-retention-daily',
    '15 3 * * *',
    $job$select public.run_image_asset_retention();$job$
  );
exception when undefined_table then
  raise notice 'cron.job table unavailable; skip schedule setup.';
end $do$;
