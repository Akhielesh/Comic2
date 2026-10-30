-- Comic History: the history tables, content-addressed chunks and their RPCs
-- (versions plan §3.2, §10, §12; package H1).
--
-- APPLY TO: Supabase project "Comic" (ref bdjfmxfmhqhzvgrhbbzm), by the OWNER only (Supabase MCP `apply_migration`,
-- name `comic_history`, or the SQL editor). Builders never apply it. Apply it BEFORE any server runs with
-- COMIC_HISTORY=1. Every statement is idempotent (if not exists / create or replace / guarded DO blocks), so
-- re-applying is safe.
--
-- Before applying, read the live definition (`select pg_get_functiondef('public.collect_active_image_paths()'::regprocedure)`)
-- and confirm that section 6 below is exactly that definition plus the one comic_version_chunks branch.
--
-- STORAGE SWEEPS: any future storage sweep (none exists today: the nightly purge only counts) MUST call
-- public.collect_active_image_paths() immediately before deleting objects, and refuse to run when
-- public.comic_history_assert_gc_roots() raises. Images that only a kept history version references are live:
-- their paths are in comic_version_chunks.paths and nowhere else.
--
-- What it creates:
--   comic_alternatives    "Versions you're trying" (H7). Empty until used: a comic with no rows has one line,
--                         "Original" (alternative_id null on its versions). No backfill.
--   comic_versions        one row per saved moment: a manifest of chunk hashes, never a whole doc.
--   comic_version_chunks  content-addressed sections of a book, keyed by (project_id, hash): no cross-comic
--                         addressing, so nobody can probe whether some content exists in another comic.
-- Server only: RLS on with NO policies, every client grant revoked, and the service role may only SELECT. Every
-- write goes through the SECURITY DEFINER RPCs below (executable by service_role only), which take one per-comic
-- advisory lock and re-check projects.user_id.
--
-- Integrity:
--   * a chunk's hash is verified on insert (sha256 of the content, first 32 hex characters);
--   * a chunk is immutable except `paths`, which may only shrink (forgetting a reference photo, V-4);
--   * a version is immutable except label, name, note, pinned, keep_until, alternative_id, published_rev (a publish
--     marks an unchanged head), and parent_id / undo_id turning null (their row was thinned: on delete set null).
--
-- Errors the RPCs raise (the server maps them; see server/src/comic/history/store.ts):
--   COMIC_HISTORY_FORBIDDEN (42501)  the comic is not this user's: the server answers like a missing one.
--   COMIC_HISTORY_NOT_FOUND (P0002)  a line or version id that is not in this comic.
--   COMIC_HISTORY_MISSING_CHUNKS (23503)  a version references a chunk that is not stored: the whole call rolls back.
--   COMIC_HISTORY_LIMIT:<what> (54000)  named versions, saves per hour, versions you're trying.
--   COMIC_HISTORY_REFUSED:<why> (55000)  not removable (the newest moment, a line's head, not a saved version,
--                                         the line you're on).
--   COMIC_HISTORY_INVALID:<what> (22023) a malformed request.

-- ── 0. pgcrypto (digest) lives in `extensions` on Supabase ─────────────────────────────────────────────────────────

create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if to_regprocedure('extensions.digest(text, text)') is null then
    raise exception 'comic_history.sql: pgcrypto digest(text, text) must be installed in the extensions schema';
  end if;
end $$;

-- ── 1. Tables ───────────────────────────────────────────────────────────────────────────────────────────────────────

create table if not exists public.comic_alternatives (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  from_version_id uuid,                     -- where it started (display)
  head_version_id uuid,                     -- latest saved state of this line (pinned)
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists comic_alternatives_one_active on public.comic_alternatives (project_id) where is_active;
create index if not exists comic_alternatives_project_idx on public.comic_alternatives (project_id, created_at);

create table if not exists public.comic_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  alternative_id uuid references public.comic_alternatives(id) on delete set null,
  parent_id uuid references public.comic_versions(id) on delete set null,      -- ai → before_ai, restore → restored
  undo_id uuid references public.comic_versions(id) on delete set null,        -- restore → its before_restore
  codec text not null default 'v5' check (codec in ('v5', 'legacy')),
  kind text not null check (kind in ('start', 'edits', 'before_ai', 'ai', 'named', 'publish', 'before_restore',
                                     'restore', 'switch', 'import', 'legacy')),
  actor text not null check (actor in ('you', 'ai', 'editor', 'system')),
  label text not null check (char_length(label) <= 160),                       -- server-generated plain words
  name text check (name is null or char_length(name) <= 80),
  note text check (note is null or char_length(note) <= 280),
  pinned boolean not null default false,
  keep_until timestamptz,                                                      -- before_restore: now() + 30 days
  rev integer not null default 0,                                              -- comic_docs.rev (0 for legacy)
  content_at timestamptz not null,                                             -- when this content last changed
  manifest jsonb not null check (octet_length(manifest::text) <= 262144),
  root_hash text not null check (root_hash ~ '^[0-9a-f]{32}$'),
  chunks text[] not null,                                                      -- every chunk hash referenced
  changes jsonb not null default '[]' check (octet_length(changes::text) <= 16384),   -- ≤ 60 ChangeItems
  thumbs jsonb not null default '[]',                                          -- ≤ 8 {key, path}
  stats jsonb not null default '{}',     -- {pages, drawn, lines, langs[], models[], spend:{usd, byok, estimated}}
  model_id text,
  published_rev integer,
  legacy_ref jsonb,                                                            -- {snapshotId, snapshotHash, reason} | {projectId}
  bytes_new integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists comic_versions_timeline on public.comic_versions (project_id, alternative_id, content_at desc);
create index if not exists comic_versions_chunks_gin on public.comic_versions using gin (chunks);
create unique index if not exists comic_versions_legacy_uidx on public.comic_versions (project_id, (legacy_ref ->> 'snapshotId'))
  where codec = 'legacy' and legacy_ref ? 'snapshotId';
-- The self-references and the line reference are `on delete set null`: without these a thinning delete would scan
-- the whole table for referencing rows.
create index if not exists comic_versions_parent_idx on public.comic_versions (parent_id) where parent_id is not null;
create index if not exists comic_versions_undo_idx on public.comic_versions (undo_id) where undo_id is not null;
create index if not exists comic_versions_alternative_idx on public.comic_versions (alternative_id) where alternative_id is not null;

create table if not exists public.comic_version_chunks (
  project_id uuid not null references public.projects(id) on delete cascade,
  hash text not null check (hash ~ '^[0-9a-f]{32}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  codec text not null check (codec in ('v5', 'legacy')),
  kind text not null check (char_length(kind) <= 24),
  content text not null check (octet_length(content) <= case when codec = 'legacy' then 4194304 else 1048576 end),
  bytes integer not null,
  paths text[] not null default '{}' check (cardinality(paths) <= 400),        -- image GC roots in this chunk
  created_at timestamptz not null default now(),
  primary key (project_id, hash)
);

-- A line's start and head are display/pin pointers into comic_versions (added separately: the tables reference each
-- other). A thinned start point reads as "not recorded"; heads are never thinned.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'comic_alternatives_from_version_fk') then
    alter table public.comic_alternatives
      add constraint comic_alternatives_from_version_fk foreign key (from_version_id)
      references public.comic_versions(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'comic_alternatives_head_version_fk') then
    alter table public.comic_alternatives
      add constraint comic_alternatives_head_version_fk foreign key (head_version_id)
      references public.comic_versions(id) on delete set null;
  end if;
end $$;
create index if not exists comic_alternatives_head_idx on public.comic_alternatives (head_version_id) where head_version_id is not null;
create index if not exists comic_alternatives_from_idx on public.comic_alternatives (from_version_id) where from_version_id is not null;

-- lz4 when the server supports it, else the default (pglz). Never fails the migration.
do $$
begin
  if exists (select 1 from pg_settings where name = 'default_toast_compression' and 'lz4' = any (enumvals)) then
    begin
      alter table public.comic_version_chunks alter column content set compression lz4;
      alter table public.comic_versions alter column manifest set compression lz4;
    exception when others then
      raise notice 'comic_history.sql: lz4 is not available here (%); keeping the default compression', sqlerrm;
    end;
  end if;
end $$;

-- ── 2. Integrity triggers ───────────────────────────────────────────────────────────────────────────────────────────

-- A chunk's hash is sha256(content) hex, first 32 characters. `bytes` is the stored size (never the caller's word);
-- `paths` keeps only GC-root-shaped strings: trimmed, with a '/', ≤ 512 characters, never data:/http(s):/blob:.
create or replace function public.comic_version_chunks_verify()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.hash is null or new.content is null
     or left(encode(extensions.digest(new.content, 'sha256'), 'hex'), 32) <> new.hash then
    raise exception 'comic_version_chunks: the hash does not match the content' using errcode = '22000';
  end if;
  new.bytes := octet_length(new.content);
  new.paths := coalesce(array(
    select q from (
      select distinct btrim(p) as q from unnest(coalesce(new.paths, '{}'::text[])) p
    ) s
     where q <> '' and char_length(q) <= 512 and position('/' in q) > 0 and q !~* '^(data|https?|blob):'
     order by q
     limit 400), '{}'::text[]);
  return new;
end;
$$;

-- Immutable except `paths`, which may only shrink (comic_history_forget_path).
create or replace function public.comic_version_chunks_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (to_jsonb(new) - 'paths') is distinct from (to_jsonb(old) - 'paths') then
    raise exception 'comic_version_chunks: a chunk never changes (only its paths may shrink)' using errcode = '42501';
  end if;
  if not (coalesce(new.paths, '{}'::text[]) <@ coalesce(old.paths, '{}'::text[])) then
    raise exception 'comic_version_chunks: paths may only shrink' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Immutable except the listed columns. parent_id / undo_id may only turn null (their row was thinned).
create or replace function public.comic_versions_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_free constant text[] := array['label', 'name', 'note', 'pinned', 'keep_until', 'alternative_id', 'published_rev',
                                  'parent_id', 'undo_id'];
begin
  if (to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free) then
    raise exception 'comic_versions: a saved moment never changes (only its label, name, note and pin may)' using errcode = '42501';
  end if;
  if (new.parent_id is distinct from old.parent_id and new.parent_id is not null)
     or (new.undo_id is distinct from old.undo_id and new.undo_id is not null) then
    raise exception 'comic_versions: parent_id and undo_id may only be cleared' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists comic_version_chunks_verify on public.comic_version_chunks;
create trigger comic_version_chunks_verify
  before insert on public.comic_version_chunks
  for each row execute function public.comic_version_chunks_verify();

drop trigger if exists comic_version_chunks_immutable on public.comic_version_chunks;
create trigger comic_version_chunks_immutable
  before update on public.comic_version_chunks
  for each row execute function public.comic_version_chunks_immutable();

drop trigger if exists comic_versions_guard on public.comic_versions;
create trigger comic_versions_guard
  before update on public.comic_versions
  for each row execute function public.comic_versions_guard();

-- ── 3. RLS and grants: server only ──────────────────────────────────────────────────────────────────────────────────

alter table public.comic_alternatives enable row level security;
alter table public.comic_versions enable row level security;
alter table public.comic_version_chunks enable row level security;

revoke all on table public.comic_alternatives, public.comic_versions, public.comic_version_chunks from public, anon, authenticated;
-- The server reads with the service role; every write goes through the RPCs below (lock, ownership, verification).
revoke all on table public.comic_alternatives, public.comic_versions, public.comic_version_chunks from service_role;
grant select on table public.comic_alternatives, public.comic_versions, public.comic_version_chunks to service_role;

-- ── 4. Internal helpers (no client or service-role execute; called by the RPCs as their owner) ─────────────────────

-- Every chunk hash a v5 manifest references (so a version's `chunks` always covers its manifest: GC never strands one).
create or replace function public.comic_history_manifest_hashes(p_manifest jsonb)
returns setof text
language sql
immutable
set search_path = public
as $$
  select v #>> '{}'
    from (
      select jsonb_path_query(p_manifest, 'lax $.meta') as v
      union all select jsonb_path_query(p_manifest, 'lax $.source')
      union all select jsonb_path_query(p_manifest, 'lax $.style')
      union all select jsonb_path_query(p_manifest, 'lax $.cover')
      union all select jsonb_path_query(p_manifest, 'lax $.places')
      union all select jsonb_path_query(p_manifest, 'lax $.glossary')
      union all select jsonb_path_query(p_manifest, 'lax $.options[*][1]')
      union all select jsonb_path_query(p_manifest, 'lax $.cast[*][1]')
      union all select jsonb_path_query(p_manifest, 'lax $.pages[*][1]')
      union all select jsonb_path_query(p_manifest, 'lax $.pages[*][2]')
      union all select jsonb_path_query(p_manifest, 'lax $.editions.*."_"')
      union all select jsonb_path_query(p_manifest, 'lax $.editions.*.pages[*][1]')
      union all select jsonb_path_query(p_manifest, 'lax $.archive[*]')
      union all select jsonb_path_query(p_manifest, 'lax $.trash[*][1]')
    ) s
   where jsonb_typeof(v) = 'string';
$$;

-- A version row as the server reads it (no manifest, chunk list or owner columns).
create or replace function public.comic_history_row_json(p_row public.comic_versions)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select to_jsonb(p_row) - 'manifest' - 'chunks' - 'project_id' - 'user_id';
$$;

-- Rows thinning may remove: unpinned, past keep_until, not the newest row of their line, not a line's head.
create or replace function public.comic_history_deletable(p_project uuid, p_now timestamptz)
returns setof public.comic_versions
language sql
stable
set search_path = public
as $$
  select v.*
    from public.comic_versions v
   where v.project_id = p_project
     and not v.pinned
     and (v.keep_until is null or v.keep_until <= p_now)
     and not exists (select 1 from public.comic_alternatives a where a.project_id = p_project and a.head_version_id = v.id)
     and v.id not in (
       select distinct on (coalesce(n.alternative_id::text, '')) n.id
         from public.comic_versions n
        where n.project_id = p_project
        order by coalesce(n.alternative_id::text, ''), n.created_at desc, n.id desc);
$$;

-- Thinning (§4.4), one comic, at most p_max deletions:
--   every automatic row for 48 hours, then the newest per hour to 7 days, per day to 90 days, per week after;
--   at most p_unpinned unpinned rows (oldest go first);
--   above p_budget bytes of kept bytes_new, the oldest deletable rows go first (reported as budgetThinned: the
--   recorder posts a notice; thinning is never silent).
create or replace function public.comic_history_thin(p_project uuid, p_unpinned integer, p_budget bigint, p_max integer default 50)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_max integer := greatest(coalesce(p_max, 50), 0);
  v_doomed uuid[] := '{}';
  v_budget_doomed uuid[] := '{}';
  v_count integer;
  v_total bigint;
begin
  if v_max = 0 then
    return jsonb_build_object('thinned', 0, 'budgetThinned', 0);
  end if;

  -- (a) The schedule: rows older than 48 hours keep the newest per hour / day / week of their line.
  select coalesce(array_agg(x.id), '{}') into v_doomed
    from (
      select r.id
        from (
          select d.id, d.content_at,
                 row_number() over (partition by d.line, d.tier, d.bucket
                                    order by d.content_at desc, d.created_at desc, d.id desc) as rn
            from (
              select v.id, v.content_at, v.created_at, coalesce(v.alternative_id::text, '') as line,
                     case when v.content_at > v_now - interval '7 days' then 1
                          when v.content_at > v_now - interval '90 days' then 2
                          else 3 end as tier,
                     case when v.content_at > v_now - interval '7 days' then date_trunc('hour', v.content_at)
                          when v.content_at > v_now - interval '90 days' then date_trunc('day', v.content_at)
                          else date_trunc('week', v.content_at) end as bucket
                from public.comic_history_deletable(p_project, v_now) v
               where v.content_at <= v_now - interval '48 hours'
            ) d
        ) r
       where r.rn > 1
       order by r.content_at asc, r.id asc
       limit v_max
    ) x;

  -- (b) The row cap: at most p_unpinned unpinned rows; the oldest deletable ones go first.
  if cardinality(v_doomed) < v_max and p_unpinned is not null then
    select count(*) into v_count
      from public.comic_versions v
     where v.project_id = p_project and not v.pinned and not (v.id = any (v_doomed));
    if v_count > greatest(p_unpinned, 0) then
      v_doomed := v_doomed || coalesce((
        select array_agg(x.id)
          from (
            select d.id
              from public.comic_history_deletable(p_project, v_now) d
             where not (d.id = any (v_doomed))
             order by d.content_at asc, d.created_at asc, d.id asc
             limit least(v_count - greatest(p_unpinned, 0), v_max - cardinality(v_doomed))
          ) x), '{}');
    end if;
  end if;

  -- (c) The byte budget: over it, the oldest deletable rows go first.
  if cardinality(v_doomed) < v_max and p_budget is not null then
    select coalesce(sum(v.bytes_new), 0) into v_total
      from public.comic_versions v
     where v.project_id = p_project and not (v.id = any (v_doomed));
    if v_total > greatest(p_budget, 0) then
      select coalesce(array_agg(x.id), '{}') into v_budget_doomed
        from (
          select s.id
            from (
              select d.id, d.bytes_new,
                     sum(d.bytes_new) over (order by d.content_at asc, d.created_at asc, d.id asc
                                            rows between unbounded preceding and current row) as cum
                from public.comic_history_deletable(p_project, v_now) d
               where not (d.id = any (v_doomed))
            ) s
           where v_total - (s.cum - s.bytes_new) > greatest(p_budget, 0)
           order by s.cum asc, s.id asc
           limit v_max - cardinality(v_doomed)
        ) x;
    end if;
  end if;

  if cardinality(v_doomed) + cardinality(v_budget_doomed) > 0 then
    delete from public.comic_versions v
     where v.project_id = p_project and v.id = any (v_doomed || v_budget_doomed);
  end if;
  return jsonb_build_object('thinned', cardinality(v_doomed), 'budgetThinned', cardinality(v_budget_doomed));
end;
$$;

-- Chunk GC for ONE comic: chunks no remaining row references and older than 10 minutes (at most p_max).
create or replace function public.comic_history_gc(p_project uuid, p_max integer default 500)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_n integer;
begin
  with refs as materialized (
    select distinct unnest(v.chunks) as h from public.comic_versions v where v.project_id = p_project
  ), doomed as (
    select c.hash
      from public.comic_version_chunks c
     where c.project_id = p_project
       and c.created_at < now() - interval '10 minutes'
       and not exists (select 1 from refs r where r.h = c.hash)
     limit greatest(coalesce(p_max, 500), 0)
  )
  delete from public.comic_version_chunks c
   using doomed d
   where c.project_id = p_project and c.hash = d.hash;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- The per-comic lock every RPC takes first, then ownership (projects.user_id).
create or replace function public.comic_history_lock(p_project uuid, p_user uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_project is null or p_user is null then
    raise exception 'COMIC_HISTORY_INVALID: scope' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('comic_history:' || p_project::text, 0));
  if not exists (select 1 from public.projects p where p.id = p_project and p.user_id = p_user) then
    raise exception 'COMIC_HISTORY_FORBIDDEN' using errcode = '42501';
  end if;
end;
$$;

-- ── 5. RPCs (SECURITY DEFINER, service_role only) ───────────────────────────────────────────────────────────────────

-- One transaction: lock, ownership, chunks (verified by the trigger), presence check (a missing chunk rolls the whole
-- call back), dedupe, insert, thin, GC. Returns {id, deduped, thinned, budgetThinned, gcChunks, bytesNew}.
-- p_version uses the server's VersionInput names (camelCase; times in epoch ms). p_chunks: [{hash, kind, content, paths}].
-- p_policy: {unpinnedRows, bytesPerComic, namedRows, savesPerHour, beforeRestoreDays} (HISTORY_LIMITS by default).
create or replace function public.comic_history_put(
  p_project uuid,
  p_user uuid,
  p_version jsonb,
  p_chunks jsonb default '[]'::jsonb,
  p_policy jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_policy jsonb := case when jsonb_typeof(p_policy) = 'object' then p_policy else '{}'::jsonb end;
  v_unpinned integer := least(greatest(coalesce((v_policy ->> 'unpinnedRows')::integer, 300), 1), 100000);
  v_budget bigint := greatest(coalesce((v_policy ->> 'bytesPerComic')::bigint, 25000000), 0);
  v_named_cap integer := greatest(coalesce((v_policy ->> 'namedRows')::integer, 100), 0);
  v_saves_cap integer := greatest(coalesce((v_policy ->> 'savesPerHour')::integer, 30), 0);
  v_restore_days integer := least(greatest(coalesce((v_policy ->> 'beforeRestoreDays')::integer, 30), 1), 3650);
  v_kind text := p_version ->> 'kind';
  v_codec text := coalesce(nullif(p_version ->> 'codec', ''), 'v5');
  v_root text := p_version ->> 'rootHash';
  v_manifest jsonb := p_version -> 'manifest';
  v_snapshot text := p_version #>> '{legacyRef,snapshotId}';
  v_name text := nullif(left(btrim(coalesce(p_version ->> 'name', '')), 80), '');
  v_note text := nullif(left(btrim(coalesce(p_version ->> 'note', '')), 280), '');
  v_alt uuid;
  v_chunks text[];
  v_missing integer;
  v_bytes_new integer := 0;
  v_head public.comic_versions%rowtype;
  v_keep timestamptz;
  v_id uuid;
  v_thin jsonb;
  v_gc integer;
begin
  if p_version is null or jsonb_typeof(p_version) <> 'object' then
    raise exception 'COMIC_HISTORY_INVALID: version' using errcode = '22023';
  end if;
  if v_kind is null or v_kind not in ('start', 'edits', 'before_ai', 'ai', 'named', 'publish', 'before_restore',
                                      'restore', 'switch', 'import', 'legacy') then
    raise exception 'COMIC_HISTORY_INVALID: kind' using errcode = '22023';
  end if;
  if v_codec not in ('v5', 'legacy') or v_root is null or v_root !~ '^[0-9a-f]{32}$'
     or v_manifest is null or jsonb_typeof(v_manifest) <> 'object' then
    raise exception 'COMIC_HISTORY_INVALID: manifest' using errcode = '22023';
  end if;

  -- 1–2. The per-comic lock, then ownership.
  perform public.comic_history_lock(p_project, p_user);

  v_alt := nullif(p_version ->> 'alternativeId', '')::uuid;
  if v_alt is not null and not exists (
    select 1 from public.comic_alternatives a where a.id = v_alt and a.project_id = p_project and a.user_id = p_user
  ) then
    raise exception 'COMIC_HISTORY_NOT_FOUND: line' using errcode = 'P0002';
  end if;

  -- 3. Chunks (the verify trigger checks every hash; one already stored is skipped).
  if jsonb_typeof(p_chunks) = 'array' and jsonb_array_length(p_chunks) > 0 then
    with incoming as (
      select e ->> 'hash' as hash,
             left(coalesce(nullif(e ->> 'kind', ''), 'chunk'), 24) as kind,
             e ->> 'content' as content,
             case when jsonb_typeof(e -> 'paths') = 'array'
                  then array(select jsonb_array_elements_text(e -> 'paths'))
                  else '{}'::text[] end as paths
        from jsonb_array_elements(p_chunks) e
       where jsonb_typeof(e) = 'object'
    ), ins as (
      insert into public.comic_version_chunks as c (project_id, hash, user_id, codec, kind, content, bytes, paths, created_at)
      select p_project, i.hash, p_user, v_codec, i.kind, i.content, 0, i.paths, now()
        from incoming i
      on conflict (project_id, hash) do nothing
      returning c.bytes
    )
    select coalesce(sum(ins.bytes), 0)::integer into v_bytes_new from ins;
  end if;

  -- 4. Every chunk the version references (its list plus its v5 manifest) must be stored for this comic.
  v_chunks := array(
    select distinct s.h
      from (
        select jsonb_array_elements_text(case when jsonb_typeof(p_version -> 'chunks') = 'array'
                                              then p_version -> 'chunks' else '[]'::jsonb end) as h
        union all
        select m.h from public.comic_history_manifest_hashes(case when v_codec = 'v5' then v_manifest end) as m(h)
      ) s
     where s.h is not null
     order by s.h);
  if cardinality(v_chunks) = 0 or exists (select 1 from unnest(v_chunks) h where h !~ '^[0-9a-f]{32}$') then
    raise exception 'COMIC_HISTORY_INVALID: chunks' using errcode = '22023';
  end if;
  select count(*) into v_missing
    from unnest(v_chunks) h
   where not exists (select 1 from public.comic_version_chunks c where c.project_id = p_project and c.hash = h);
  if v_missing > 0 then
    raise exception 'COMIC_HISTORY_MISSING_CHUNKS: % chunk(s) not stored', v_missing using errcode = '23503';
  end if;

  v_keep := case
    when jsonb_typeof(p_version -> 'keepUntil') = 'number' then to_timestamp((p_version ->> 'keepUntil')::double precision / 1000.0)
    when v_kind = 'before_restore' then now() + make_interval(days => v_restore_days)
  end;

  -- 5. Dedupe. A classic snapshot is imported once (by its id).
  if v_kind = 'legacy' and v_snapshot is not null then
    select * into v_head
      from public.comic_versions v
     where v.project_id = p_project and v.codec = 'legacy' and v.legacy_ref ->> 'snapshotId' = v_snapshot
     limit 1;
    if found then
      return jsonb_build_object('id', v_head.id, 'deduped', true, 'thinned', 0, 'budgetThinned', 0, 'gcChunks', 0,
                                'bytesNew', v_bytes_new);
    end if;
  end if;

  if v_kind = 'named' and (
    select count(*) from public.comic_versions v
     where v.project_id = p_project and v.kind = 'named' and v.created_at > now() - interval '1 hour'
  ) >= v_saves_cap then
    raise exception 'COMIC_HISTORY_LIMIT:saves_per_hour' using errcode = '54000';
  end if;

  -- The newest row of the same line with an equal root: an automatic kind writes nothing; a pinned kind pins (and a
  -- named save names, a publish marks, a before-restore extends) that row instead.
  if v_kind <> 'legacy' then
    select * into v_head
      from public.comic_versions v
     where v.project_id = p_project and v.user_id = p_user
       and (case when v_alt is null then v.alternative_id is null else v.alternative_id = v_alt end)
     order by v.created_at desc, v.id desc
     limit 1;
    if found and v_head.root_hash = v_root then
      if v_kind = 'named' and v_head.name is null and v_head.kind <> 'named' and (
        select count(*) from public.comic_versions v
         where v.project_id = p_project and (v.kind = 'named' or v.name is not null)
      ) >= v_named_cap then
        raise exception 'COMIC_HISTORY_LIMIT:named' using errcode = '54000';
      end if;
      if v_kind in ('start', 'named', 'publish', 'import', 'before_restore') then
        update public.comic_versions v
           set pinned = v.pinned or v_kind in ('start', 'named', 'publish', 'import'),
               name = case when v_kind = 'named' and v_name is not null then v_name else v.name end,
               note = case when v_kind = 'named' and v_note is not null then v_note else v.note end,
               published_rev = case when v_kind = 'publish' and jsonb_typeof(p_version -> 'publishedRev') = 'number'
                                    then (p_version ->> 'publishedRev')::integer else v.published_rev end,
               keep_until = case when v_kind = 'before_restore' then greatest(v.keep_until, v_keep) else v.keep_until end
         where v.id = v_head.id;
      end if;
      return jsonb_build_object('id', v_head.id, 'deduped', true, 'thinned', 0, 'budgetThinned', 0, 'gcChunks', 0,
                                'bytesNew', v_bytes_new);
    end if;
  end if;

  if v_kind = 'named' and (
    select count(*) from public.comic_versions v
     where v.project_id = p_project and (v.kind = 'named' or v.name is not null)
  ) >= v_named_cap then
    raise exception 'COMIC_HISTORY_LIMIT:named' using errcode = '54000';
  end if;

  -- 6. Insert.
  insert into public.comic_versions (
    project_id, user_id, alternative_id, parent_id, undo_id, codec, kind, actor, label, name, note, pinned, keep_until,
    rev, content_at, manifest, root_hash, chunks, changes, thumbs, stats, model_id, published_rev, legacy_ref, bytes_new,
    created_at
  ) values (
    p_project, p_user, v_alt,
    (select v.id from public.comic_versions v
      where v.id = nullif(p_version ->> 'parentId', '')::uuid and v.project_id = p_project and v.user_id = p_user),
    (select v.id from public.comic_versions v
      where v.id = nullif(p_version ->> 'undoId', '')::uuid and v.project_id = p_project and v.user_id = p_user),
    v_codec, v_kind, coalesce(p_version ->> 'actor', 'system'),
    left(coalesce(p_version ->> 'label', ''), 160), v_name, v_note,
    coalesce((p_version ->> 'pinned')::boolean, false)
      or v_kind in ('start', 'named', 'publish', 'import', 'legacy') or v_name is not null,
    v_keep,
    coalesce((p_version ->> 'rev')::integer, 0),
    case when jsonb_typeof(p_version -> 'contentAt') = 'number'
         then to_timestamp((p_version ->> 'contentAt')::double precision / 1000.0) else now() end,
    v_manifest, v_root, v_chunks,
    case when jsonb_typeof(p_version -> 'changes') = 'array' then p_version -> 'changes' else '[]'::jsonb end,
    case when jsonb_typeof(p_version -> 'thumbs') = 'array' then p_version -> 'thumbs' else '[]'::jsonb end,
    case when jsonb_typeof(p_version -> 'stats') = 'object' then p_version -> 'stats' else '{}'::jsonb end,
    nullif(left(coalesce(p_version ->> 'modelId', ''), 120), ''),
    case when jsonb_typeof(p_version -> 'publishedRev') = 'number' then (p_version ->> 'publishedRev')::integer end,
    case when jsonb_typeof(p_version -> 'legacyRef') = 'object' then p_version -> 'legacyRef' end,
    v_bytes_new,
    clock_timestamp()
  )
  returning id into v_id;

  -- 7–8. Thin (≤ 50 deletions) and collect this comic's unreferenced chunks (≤ 500).
  v_thin := public.comic_history_thin(p_project, v_unpinned, v_budget, 50);
  v_gc := public.comic_history_gc(p_project, 500);

  -- 9.
  return jsonb_build_object('id', v_id, 'deduped', false,
                            'thinned', coalesce((v_thin ->> 'thinned')::integer, 0),
                            'budgetThinned', coalesce((v_thin ->> 'budgetThinned')::integer, 0),
                            'gcChunks', v_gc, 'bytesNew', v_bytes_new);
end;
$$;

-- Name, note and pin. p_name / p_note: null keeps, '' clears. Naming an automatic row pins it (unless p_pinned says
-- otherwise); start, named, publish, import and legacy rows stay pinned. Returns the row (comic_history_row_json), or
-- null when the version is not in this comic.
create or replace function public.comic_history_label(
  p_project uuid,
  p_user uuid,
  p_version uuid,
  p_name text default null,
  p_note text default null,
  p_pinned boolean default null,
  p_max_named integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.comic_versions%rowtype;
  v_name text;
  v_note text;
  v_pinned boolean;
begin
  perform public.comic_history_lock(p_project, p_user);
  if p_version is null then
    return null;
  end if;
  select * into v from public.comic_versions x
   where x.id = p_version and x.project_id = p_project and x.user_id = p_user
   for update;
  if not found then
    return null;
  end if;
  v_name := case when p_name is null then v.name else nullif(left(btrim(p_name), 80), '') end;
  v_note := case when p_note is null then v.note else nullif(left(btrim(p_note), 280), '') end;
  if v_name is not null and v.name is null and v.kind <> 'named' and (
    select count(*) from public.comic_versions x
     where x.project_id = p_project and (x.kind = 'named' or x.name is not null)
  ) >= greatest(coalesce(p_max_named, 100), 0) then
    raise exception 'COMIC_HISTORY_LIMIT:named' using errcode = '54000';
  end if;
  v_pinned := case
    when v.kind in ('start', 'named', 'publish', 'import', 'legacy') then true
    when p_pinned is not null then p_pinned
    when v_name is not null and v.name is null then true
    else v.pinned
  end;
  update public.comic_versions x
     set name = v_name, note = v_note, pinned = v_pinned
   where x.id = v.id
  returning * into v;
  return public.comic_history_row_json(v);
end;
$$;

-- Remove a saved (named) version. Never the newest row of its line or a line's head. Then the same chunk GC.
-- Returns false when the version is not in this comic.
create or replace function public.comic_history_delete(p_project uuid, p_user uuid, p_version uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.comic_versions%rowtype;
begin
  perform public.comic_history_lock(p_project, p_user);
  if p_version is null then
    return false;
  end if;
  select * into v from public.comic_versions x
   where x.id = p_version and x.project_id = p_project and x.user_id = p_user
   for update;
  if not found then
    return false;
  end if;
  if v.kind <> 'named' then
    raise exception 'COMIC_HISTORY_REFUSED:not_named' using errcode = '55000';
  end if;
  if v.id = (
    select n.id from public.comic_versions n
     where n.project_id = p_project
       and (case when v.alternative_id is null then n.alternative_id is null else n.alternative_id = v.alternative_id end)
     order by n.created_at desc, n.id desc
     limit 1
  ) then
    raise exception 'COMIC_HISTORY_REFUSED:newest' using errcode = '55000';
  end if;
  if exists (select 1 from public.comic_alternatives a where a.project_id = p_project and a.head_version_id = v.id) then
    raise exception 'COMIC_HISTORY_REFUSED:head' using errcode = '55000';
  end if;
  delete from public.comic_versions x where x.id = v.id;
  perform public.comic_history_gc(p_project, 500);
  return true;
end;
$$;

-- Forget a storage path (a removed reference photo, V-4): drop it from every chunk's `paths` in this comic, so the
-- GC roots release it and restores skip it. Returns the number of chunks changed.
create or replace function public.comic_history_forget_path(p_project uuid, p_user uuid, p_path text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_path text := btrim(coalesce(p_path, ''));
  v_n integer;
begin
  perform public.comic_history_lock(p_project, p_user);
  if v_path = '' then
    return 0;
  end if;
  update public.comic_version_chunks c
     set paths = array_remove(c.paths, v_path)
   where c.project_id = p_project and c.paths @> array[v_path];
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Mark a version as the head of a line (p_alternative null = "Original") and pin it. An alternative's previous head
-- goes back to normal thinning unless it is pinned for its own sake. Returns false when the line or the version is
-- not in this comic.
create or replace function public.comic_history_set_head(p_project uuid, p_user uuid, p_alternative uuid, p_version uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old uuid;
begin
  perform public.comic_history_lock(p_project, p_user);
  if p_version is null or not exists (
    select 1 from public.comic_versions v where v.id = p_version and v.project_id = p_project and v.user_id = p_user
  ) then
    return false;
  end if;
  if p_alternative is not null then
    select a.head_version_id into v_old
      from public.comic_alternatives a
     where a.id = p_alternative and a.project_id = p_project and a.user_id = p_user
     for update;
    if not found then
      return false;
    end if;
    update public.comic_alternatives a set head_version_id = p_version, updated_at = now() where a.id = p_alternative;
    if v_old is not null and v_old <> p_version
       and not exists (select 1 from public.comic_alternatives a where a.project_id = p_project and a.head_version_id = v_old) then
      update public.comic_versions v
         set pinned = false
       where v.id = v_old and v.project_id = p_project
         and v.kind not in ('start', 'named', 'publish', 'import', 'legacy') and v.name is null;
    end if;
  end if;
  update public.comic_versions v set pinned = true where v.id = p_version and not v.pinned;
  return true;
end;
$$;

-- "Versions you're trying" (H7). The comic's lines are "Original" (no row) plus these rows: at most p_max lines in
-- all. The head version (required) is pinned. Returns the new row.
create or replace function public.comic_history_alternative_create(
  p_project uuid,
  p_user uuid,
  p_name text,
  p_from uuid default null,
  p_head uuid default null,
  p_max integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := left(btrim(coalesce(p_name, '')), 60);
  v_row public.comic_alternatives%rowtype;
begin
  perform public.comic_history_lock(p_project, p_user);
  if v_name = '' then
    raise exception 'COMIC_HISTORY_INVALID: name' using errcode = '22023';
  end if;
  if (select count(*) from public.comic_alternatives a where a.project_id = p_project) + 1 >= greatest(coalesce(p_max, 5), 1) then
    raise exception 'COMIC_HISTORY_LIMIT:alternatives' using errcode = '54000';
  end if;
  if p_head is null or not exists (
    select 1 from public.comic_versions v where v.id = p_head and v.project_id = p_project and v.user_id = p_user
  ) then
    raise exception 'COMIC_HISTORY_NOT_FOUND: version' using errcode = 'P0002';
  end if;
  insert into public.comic_alternatives (project_id, user_id, name, from_version_id, head_version_id)
  values (
    p_project, p_user, v_name,
    (select v.id from public.comic_versions v where v.id = p_from and v.project_id = p_project and v.user_id = p_user),
    p_head
  )
  returning * into v_row;
  update public.comic_versions x set pinned = true where x.id = p_head and not x.pinned;
  return to_jsonb(v_row) - 'project_id' - 'user_id';
end;
$$;

-- Rename a line and/or make it the one you're on (p_active true; false = back to "Original"). Null when not found.
create or replace function public.comic_history_alternative_update(
  p_project uuid,
  p_user uuid,
  p_id uuid,
  p_name text default null,
  p_active boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.comic_alternatives%rowtype;
  v_name text;
begin
  perform public.comic_history_lock(p_project, p_user);
  select * into v from public.comic_alternatives a
   where a.id = p_id and a.project_id = p_project and a.user_id = p_user
   for update;
  if not found then
    return null;
  end if;
  if p_name is not null then
    v_name := left(btrim(p_name), 60);
    if v_name = '' then
      raise exception 'COMIC_HISTORY_INVALID: name' using errcode = '22023';
    end if;
  end if;
  if p_active is true then
    update public.comic_alternatives a set is_active = false, updated_at = now()
     where a.project_id = p_project and a.is_active and a.id <> p_id;
  end if;
  update public.comic_alternatives a
     set name = coalesce(v_name, a.name),
         is_active = coalesce(p_active, a.is_active),
         updated_at = now()
   where a.id = p_id
  returning * into v;
  return to_jsonb(v) - 'project_id' - 'user_id';
end;
$$;

-- Remove a line (never the one you're on). Its rows are unpinned (named and other pinned kinds stay pinned) and join
-- "Original" (alternative_id → null); thinning then ages them out. Nothing is deleted here. False when not found.
create or replace function public.comic_history_alternative_remove(p_project uuid, p_user uuid, p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.comic_alternatives%rowtype;
begin
  perform public.comic_history_lock(p_project, p_user);
  select * into v from public.comic_alternatives a
   where a.id = p_id and a.project_id = p_project and a.user_id = p_user
   for update;
  if not found then
    return false;
  end if;
  if v.is_active then
    raise exception 'COMIC_HISTORY_REFUSED:active' using errcode = '55000';
  end if;
  update public.comic_versions x
     set pinned = false
   where x.project_id = p_project
     and (x.alternative_id = p_id
          or (x.id = v.head_version_id
              and not exists (select 1 from public.comic_alternatives a
                               where a.project_id = p_project and a.head_version_id = x.id and a.id <> p_id)))
     and x.pinned
     and x.kind not in ('start', 'named', 'publish', 'import', 'legacy') and x.name is null;
  delete from public.comic_alternatives a where a.id = p_id;
  return true;
end;
$$;

-- ── 6. GC roots: collect_active_image_paths() ──────────────────────────────────────────────────────────────────────
-- Re-created from the LIVE definition (the broad, strict `$.**` rule over projects.state, artifacts.data and
-- comic_docs.doc, mirrored in comic_security_guard_2026_10.sql §3a) — never from the narrower comic_docs.sql /
-- image_assets_retention.sql copies — plus ONE branch: every path a kept history chunk references.

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
  ),
  history_chunk_paths as (
    select nullif(btrim(p), '') as path
      from public.comic_version_chunks c,
           unnest(c.paths) p
  )
  select distinct path
    from (
      select path from project_paths
      union all
      select path from artifact_paths
      union all
      select path from comic_doc_paths
      union all
      select path from history_chunk_paths
    ) combined
   where path is not null and path <> '';
$$;

revoke all on function public.collect_active_image_paths() from public, anon, authenticated;
grant execute on function public.collect_active_image_paths() to service_role;

-- The guard: raises unless collect_active_image_paths() keeps every live `$.**` branch AND the history branch. Run at
-- the end of this file; a future storage sweep calls it before deleting anything.
create or replace function public.comic_history_assert_gc_roots()
returns boolean
language plpgsql
stable
set search_path = public
as $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'collect_active_image_paths' and p.pronargs = 0;
  if v_def is null then
    raise exception 'collect_active_image_paths() is missing: history images would be unprotected';
  end if;
  if position('comic_version_chunks' in v_def) = 0 then
    raise exception 'collect_active_image_paths() lacks the comic_version_chunks branch: history images would be unprotected';
  end if;
  if position('public.projects' in v_def) = 0 or position('public.artifacts' in v_def) = 0
     or position('public.comic_docs' in v_def) = 0 or position('imageTags' in v_def) = 0
     or (char_length(v_def) - char_length(replace(v_def, 'strict $.**', ''))) / char_length('strict $.**') < 3 then
    raise exception 'collect_active_image_paths() is a narrower copy: it must keep the live strict $.** rule over projects.state, artifacts.data and comic_docs.doc';
  end if;
  return true;
end;
$$;

-- ── 7. Execute grants: RPCs to service_role only; helpers and triggers to nobody ───────────────────────────────────

revoke all on function public.comic_version_chunks_verify() from public, anon, authenticated, service_role;
revoke all on function public.comic_version_chunks_immutable() from public, anon, authenticated, service_role;
revoke all on function public.comic_versions_guard() from public, anon, authenticated, service_role;
revoke all on function public.comic_history_manifest_hashes(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.comic_history_row_json(public.comic_versions) from public, anon, authenticated, service_role;
revoke all on function public.comic_history_deletable(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.comic_history_thin(uuid, integer, bigint, integer) from public, anon, authenticated, service_role;
revoke all on function public.comic_history_gc(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.comic_history_lock(uuid, uuid) from public, anon, authenticated, service_role;

revoke all on function public.comic_history_put(uuid, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.comic_history_label(uuid, uuid, uuid, text, text, boolean, integer) from public, anon, authenticated;
revoke all on function public.comic_history_delete(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.comic_history_forget_path(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.comic_history_set_head(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.comic_history_alternative_create(uuid, uuid, text, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.comic_history_alternative_update(uuid, uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.comic_history_alternative_remove(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.comic_history_assert_gc_roots() from public, anon, authenticated;

grant execute on function public.comic_history_put(uuid, uuid, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.comic_history_label(uuid, uuid, uuid, text, text, boolean, integer) to service_role;
grant execute on function public.comic_history_delete(uuid, uuid, uuid) to service_role;
grant execute on function public.comic_history_forget_path(uuid, uuid, text) to service_role;
grant execute on function public.comic_history_set_head(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.comic_history_alternative_create(uuid, uuid, text, uuid, uuid, integer) to service_role;
grant execute on function public.comic_history_alternative_update(uuid, uuid, uuid, text, boolean) to service_role;
grant execute on function public.comic_history_alternative_remove(uuid, uuid, uuid) to service_role;
grant execute on function public.comic_history_assert_gc_roots() to service_role;

-- ── 8. Post-apply assertions (fail the migration rather than ship a hole) ──────────────────────────────────────────

do $$
declare
  t text;
  f regprocedure;
  r text;
begin
  -- The GC roots keep the live rule and gained the history branch.
  perform public.comic_history_assert_gc_roots();

  foreach t in array array['public.comic_alternatives', 'public.comic_versions', 'public.comic_version_chunks'] loop
    if not (select c.relrowsecurity from pg_class c where c.oid = t::regclass) then
      raise exception '% must have row level security on', t;
    end if;
    if exists (select 1 from pg_policies p where p.schemaname = 'public' and format('public.%I', p.tablename) = t) then
      raise exception '% must have no policies (server only)', t;
    end if;
    foreach r in array array['anon', 'authenticated'] loop
      if has_table_privilege(r, t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
         or has_any_column_privilege(r, t, 'SELECT, INSERT, UPDATE, REFERENCES') then
        raise exception '% must have no privilege on %', r, t;
      end if;
    end loop;
    if has_table_privilege('service_role', t, 'INSERT, UPDATE, DELETE, TRUNCATE') then
      raise exception 'service_role writes % only through the comic_history RPCs', t;
    end if;
  end loop;

  for f in
    select p.oid::regprocedure
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like 'comic_history%' or p.proname like 'comic_version%' or p.proname = 'collect_active_image_paths')
  loop
    if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('authenticated', f, 'EXECUTE') then
      raise exception 'clients must not execute %', f;
    end if;
  end loop;
end $$;
