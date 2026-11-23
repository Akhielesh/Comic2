-- Stable-key Director migration. Installing this schema activates no projects.
-- Only a trusted operator that read and SHA-256 verified both byte streams may activate a scope.
begin;

create schema if not exists comic_art_maintenance;
revoke all on schema comic_art_maintenance from public, anon, authenticated;
grant usage on schema comic_art_maintenance to service_role;

create table if not exists comic_art_maintenance.active_projects (
  project_id uuid primary key references public.comic_docs(project_id) on delete cascade,
  owner_id uuid not null,
  revision integer not null check (revision >= 0),
  file_count integer not null check (file_count > 0),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz not null,
  activated_at timestamptz not null default clock_timestamp()
);
alter table comic_art_maintenance.active_projects enable row level security;
revoke all on comic_art_maintenance.active_projects from public, anon, authenticated, service_role;
grant select, insert on comic_art_maintenance.active_projects to service_role;

-- Keep this grammar in sync with legacyArtScope and isPrivateDraftPath, including size variants.
create or replace function comic_art_maintenance.is_legacy_name(name text)
returns boolean language sql immutable strict parallel safe set search_path = '' as $$
  select name ~ '^[A-Za-z0-9_@.-]+$' and name <> '.' and strpos(name,'..') = 0
     and name !~ '^draft-v1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_w480|_w1080)?[.]webp$'
$$;
revoke all on function comic_art_maintenance.is_legacy_name(text) from public, anon, authenticated;
grant execute on function comic_art_maintenance.is_legacy_name(text) to service_role;

create or replace function public.comic_private_art_scopes(p_project_ids uuid[])
returns table(project_id uuid, owner_id uuid)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_project_ids is null or cardinality(p_project_ids) > 128 then
    raise exception 'Invalid artwork scope batch' using errcode='22023';
  end if;
  -- Omitting an existing broken marker would make the caller choose the uncut public bucket.
  if exists (
    select 1 from comic_art_maintenance.active_projects a
    where a.project_id=any(p_project_ids) and not exists (
      select 1 from public.projects p join public.comic_docs d on d.project_id=p.id and d.user_id=p.user_id
      where p.id=a.project_id and p.user_id=a.owner_id
    )
  ) then raise exception 'Artwork scope is inconsistent' using errcode='55000'; end if;
  return query
    select a.project_id, a.owner_id from comic_art_maintenance.active_projects a
    join public.projects p on p.id=a.project_id and p.user_id=a.owner_id
    join public.comic_docs d on d.project_id=a.project_id and d.user_id=a.owner_id
    where a.project_id = any(p_project_ids);
end $$;
revoke all on function public.comic_private_art_scopes(uuid[]) from public, anon, authenticated;
grant execute on function public.comic_private_art_scopes(uuid[]) to service_role;

-- No trigger on Supabase-managed storage tables. A NOWAIT metadata fence during activation prevents phantom
-- source/destination rows. Deploy the stable-key-aware writers and drain old render/maintenance jobs first.
create or replace function public.comic_activate_private_art(
  p_project_id uuid, p_owner_id uuid, p_expected_rev integer, p_verified_at timestamptz, p_manifest jsonb
) returns integer
language plpgsql volatile security invoker set search_path = '' as $$
declare
  prefix text := 'u/' || p_owner_id::text || '/p/' || p_project_id::text || '/img/';
  active comic_art_maintenance.active_projects%rowtype;
  current_doc jsonb;
  current_rev integer;
  item_count integer;
  fingerprint text;
  mismatches integer;
begin
  if p_project_id is null or p_owner_id is null or p_expected_rev is null or p_expected_rev < 0
     or p_verified_at is null or not isfinite(p_verified_at) or jsonb_typeof(p_manifest) is distinct from 'array' then
    raise exception 'Invalid artwork cutover request' using errcode='22023';
  end if;
  item_count := jsonb_array_length(p_manifest);
  if item_count not between 1 and 10000 then
    raise exception 'Invalid artwork manifest size' using errcode='22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_manifest) m
    where jsonb_typeof(m) is distinct from 'object'
      or not (m ?& array['name','bytes','sourceId','sourceVersion','sourceUpdatedAt','sourceEtag','sourceSha256',
                          'privateId','privateVersion','privateUpdatedAt','privateEtag','privateSha256'])
      or jsonb_typeof(m->'name') is distinct from 'string'
      or not starts_with(m->>'name', prefix)
      or not comic_art_maintenance.is_legacy_name(substr(m->>'name',length(prefix)+1))
      or jsonb_typeof(m->'bytes') is distinct from 'number' or (m->>'bytes') !~ '^[1-9][0-9]{0,14}$'
      or jsonb_typeof(m->'sourceSha256') is distinct from 'string' or (m->>'sourceSha256') !~ '^[0-9a-f]{64}$'
      or m->>'sourceSha256' is distinct from m->>'privateSha256'
      or jsonb_typeof(m->'privateSha256') is distinct from 'string'
      or jsonb_typeof(m->'sourceId') is distinct from 'string' or jsonb_typeof(m->'privateId') is distinct from 'string'
      or jsonb_typeof(m->'sourceUpdatedAt') is distinct from 'string' or jsonb_typeof(m->'privateUpdatedAt') is distinct from 'string'
      or jsonb_typeof(m->'sourceEtag') not in ('string','null') or jsonb_typeof(m->'privateEtag') not in ('string','null')
      or jsonb_typeof(m->'sourceVersion') not in ('string','null') or jsonb_typeof(m->'privateVersion') not in ('string','null')
    ) or item_count <> (select count(distinct m->>'name') from jsonb_array_elements(p_manifest) m) then
    raise exception 'Invalid or unverified artwork manifest' using errcode='22023';
  end if;
  select encode(sha256(convert_to(jsonb_agg(m order by m->>'name')::text,'UTF8')),'hex')
    into fingerprint from jsonb_array_elements(p_manifest) m;
  -- History writers take this same scoped transaction lock before inspecting the project.
  if to_regclass('public.comic_version_chunks') is not null and
     not pg_try_advisory_xact_lock(hashtextextended('comic_history:' || p_project_id::text,0)) then
    raise exception 'Project history is busy' using errcode='55P03';
  end if;
  select d.rev,d.doc into current_rev,current_doc
    from public.projects p join public.comic_docs d on d.project_id=p.id and d.user_id=p.user_id
    where p.id=p_project_id and p.user_id=p_owner_id for update of p,d nowait;
  if not found then raise exception 'Project scope unavailable' using errcode='22023'; end if;

  select * into active from comic_art_maintenance.active_projects a where a.project_id=p_project_id;
  if found then
    if active.owner_id=p_owner_id and active.manifest_sha256=fingerprint and active.revision=p_expected_rev then
      return active.file_count; -- acknowledgment of the original switch, including after source retirement
    end if;
    raise exception 'A different artwork cutover already exists' using errcode='55000';
  end if;
  if current_rev <> p_expected_rev or p_verified_at > clock_timestamp()
     or p_verified_at < clock_timestamp()-interval '30 minutes' then
    raise exception 'Project or verification is stale' using errcode='55000';
  end if;
  if jsonb_path_exists(current_doc, '$.**.status ? (@ == "queued" || @ == "rendering")')
     or current_doc #>> '{directorDraft,status}' = 'planning' then
    raise exception 'Project work is active' using errcode='55000';
  end if;
  if not exists(select 1 from storage.buckets where id='comic-private' and public=false)
     or not exists(select 1 from storage.buckets where id='comic-assets' and public=true) then
    raise exception 'Storage configuration unavailable' using errcode='55000';
  end if;

  -- A key still referenced by the book (including archived original/thumbnail paths) must not vanish
  -- from the manifest simply because it was absent from both buckets when the operator inventoried it.
  if exists (
    select value #>> '{}' from jsonb_path_query(current_doc, '$.** ? (@.type() == "string")') as value
    where starts_with(value #>> '{}', prefix) and comic_art_maintenance.is_legacy_name(substr(value #>> '{}',length(prefix)+1))
    except select m->>'name' from jsonb_array_elements(p_manifest) m
  ) then raise exception 'Project references missing artwork' using errcode='55000'; end if;

  if to_regclass('public.comic_version_chunks') is not null then
    -- History GC treats the immutable chunk's current paths array as authoritative. Forgotten and
    -- thinned paths are absent there even when an older serialized content string still mentions them.
    if exists (
      select btrim(path) from public.comic_version_chunks c cross join lateral unnest(c.paths) path
      where c.project_id=p_project_id and c.user_id=p_owner_id and starts_with(btrim(path),prefix)
        and comic_art_maintenance.is_legacy_name(substr(btrim(path),length(prefix)+1))
      except select m->>'name' from jsonb_array_elements(p_manifest) m
    ) then raise exception 'Project version references missing artwork' using errcode='55000'; end if;
  end if;

  -- Roster and both copies can no longer change between the checks below and activation commit.
  lock table public.image_assets in share row exclusive mode nowait;
  lock table storage.objects in share mode nowait;
  if exists (
    select 1 from storage.objects o
    where o.bucket_id in ('comic-assets','comic-private') and o.name like prefix || '%'
    and (substr(o.name,length(prefix)+1) !~ '^[A-Za-z0-9_@.-]+$' or substr(o.name,length(prefix)+1)='.' or strpos(o.name,'..')>0)
  ) then raise exception 'Unexpected artwork under project image scope' using errcode='55000'; end if;

  with wanted as materialized (
    select m->>'name' as name,(m->>'bytes')::bigint as bytes,
           m->>'sourceId' as sid,m->>'sourceVersion' as sv,m->>'sourceEtag' as se,(m->>'sourceUpdatedAt')::timestamptz as st,
           m->>'privateId' as did,m->>'privateVersion' as dv,m->>'privateEtag' as de,(m->>'privateUpdatedAt')::timestamptz as dt
    from jsonb_array_elements(p_manifest) m
  ), checked as materialized (
    select o.name,o.bucket_id,o.id::text as id,o.version,o.updated_at,
       case when (o.metadata->>'size') ~ '^[0-9]{1,15}$' then (o.metadata->>'size')::bigint end as bytes,
       coalesce(o.metadata->>'eTag',o.metadata->>'etag',o.metadata->>'ETag') as etag
    from storage.objects o where o.bucket_id in ('comic-assets','comic-private') and o.name like prefix || '%'
      and comic_art_maintenance.is_legacy_name(substr(o.name,length(prefix)+1))
  ), compared as (
    select w.name as expected,o.name,s.bucket,o.id,o.version,o.updated_at,o.bytes,o.etag,
      case when s.bucket='comic-assets' then w.sid else w.did end as expected_id,
      case when s.bucket='comic-assets' then w.sv else w.dv end as expected_version,
      case when s.bucket='comic-assets' then w.st else w.dt end as expected_time,
      case when s.bucket='comic-assets' then w.se else w.de end as expected_etag,
      w.bytes as expected_bytes
    from (wanted w cross join (values ('comic-assets'),('comic-private')) s(bucket))
    full join checked o on o.name=w.name and o.bucket_id=s.bucket
  )
  select count(*) into mismatches from compared
    where name is null or expected is null or id is distinct from expected_id or bytes is distinct from expected_bytes
      or updated_at is null or updated_at is distinct from expected_time or version is distinct from expected_version
      or etag is distinct from expected_etag;
  if mismatches <> 0 then raise exception 'Artwork inventory or object metadata changed' using errcode='55000'; end if;

  insert into comic_art_maintenance.active_projects(project_id,owner_id,revision,file_count,manifest_sha256,verified_at)
  values (p_project_id,p_owner_id,p_expected_rev,item_count,fingerprint,p_verified_at);
  update public.image_assets a set bucket='comic-private'
   where a.user_id=p_owner_id and (a.project_id=p_project_id or a.project_id is null) and a.bucket='comic-assets'
     and a.path in (select m->>'name' from jsonb_array_elements(p_manifest) m);
  return item_count;
end $$;
revoke all on function public.comic_activate_private_art(uuid,uuid,integer,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.comic_activate_private_art(uuid,uuid,integer,timestamptz,jsonb) to service_role;

-- Metadata rows are client-writable in older installations. They may never select the physical bucket or owner.
create or replace function comic_art_maintenance.keep_registry_bucket()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  pieces text[];
  current_owner uuid;
begin
  pieces := regexp_match(new.path,'^u/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/p/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/img/([A-Za-z0-9_@.-]+)$');
  if pieces is null or not comic_art_maintenance.is_legacy_name(pieces[3]) then return new; end if;
  select a.owner_id into current_owner from comic_art_maintenance.active_projects a where a.project_id=pieces[2]::uuid;
  if not found then return new; end if;
  if not exists (
    select 1 from public.projects p join public.comic_docs d on d.project_id=p.id and d.user_id=p.user_id
    where p.id=pieces[2]::uuid and p.user_id=current_owner
  ) then raise exception 'Artwork scope is inconsistent' using errcode='55000'; end if;
  if pieces[1]::uuid <> current_owner or new.user_id is distinct from current_owner
     or (new.project_id is not null and new.project_id <> pieces[2]::uuid) then
    raise exception 'Invalid artwork registry scope' using errcode='23514';
  end if;
  new.bucket := 'comic-private';
  return new;
end $$;
revoke all on function comic_art_maintenance.keep_registry_bucket() from public, anon, authenticated, service_role;
drop trigger if exists comic_private_art_registry_guard on public.image_assets;
create trigger comic_private_art_registry_guard before insert or update of bucket,path,user_id,project_id
on public.image_assets for each row execute function comic_art_maintenance.keep_registry_bucket();
commit;
