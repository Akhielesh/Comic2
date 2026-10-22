-- Comic Studio v4 documents (docs/features/comic-studio-v4.md §4 "Persistence").
--
-- APPLY TO: Supabase project "Comic" (ref bdjfmxfmhqhzvgrhbbzm) — via the Supabase MCP
-- `apply_migration` (name: comic_studio_v4_comic_docs) or the SQL editor. Idempotent:
-- safe to re-run.
--
-- One row per v4 project. The ComicDoc (jsonb) is the single source of truth for the
-- conversational studio; public.projects stays the listing record (the server mirrors
-- name/updated_at/a minimal legacy state onto it). Writes are SERVER-ONLY (service role
-- bypasses RLS); the owner may SELECT their own rows. There are deliberately no client
-- insert/update/delete policies.
--
-- Also extends public.collect_active_image_paths() so the 45-day image retention job
-- (server/sql/image_assets_retention.sql) treats every `path` string inside a
-- comic_docs.doc (renders, render history, sheets, style boards, uploads, attachments)
-- as live — without this the GC would delete studio assets 45 days after upload.

create table if not exists public.comic_docs (
  project_id uuid primary key references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  doc jsonb not null,
  rev integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint comic_docs_doc_is_object check (jsonb_typeof(doc) = 'object'),
  constraint comic_docs_rev_nonnegative check (rev >= 0)
);

create index if not exists comic_docs_user_id_idx
  on public.comic_docs (user_id, updated_at desc);

alter table public.comic_docs enable row level security;

-- Owner read (auth.uid() = user_id). `(select auth.uid())` is evaluated once per query
-- instead of per row (Supabase RLS performance advisor).
drop policy if exists comic_docs_select_own on public.comic_docs;
create policy comic_docs_select_own
on public.comic_docs for select
to authenticated
using ((select auth.uid()) = user_id);

-- Belt and braces: RLS already denies client writes (no policies); revoke the grants too.
revoke insert, update, delete on public.comic_docs from anon, authenticated;
revoke all on public.comic_docs from anon;

-- Current definition from server/sql/image_assets_retention.sql (live def also carries
-- `set search_path = public` from security_hardening_2026_06.sql — kept here, since
-- CREATE OR REPLACE resets function SET options), plus the comic_docs branch.
create or replace function public.collect_active_image_paths()
returns table(path text)
language sql
stable
set search_path = public
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
  ),
  comic_doc_paths as (
    -- Every AssetRef.path anywhere in a v4 document (current renders, history, sheets,
    -- style board/options, user refs, conversation attachments).
    select nullif(trim(p #>> '{}'), '') as path
    from public.comic_docs d,
         lateral jsonb_path_query(d.doc, 'lax $.**.path') p
    where jsonb_typeof(p) = 'string'
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
