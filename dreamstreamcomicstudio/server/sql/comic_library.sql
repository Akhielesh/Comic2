-- Platform asset library for Comic Studio v5 (style previews, genre examples, covers, empty states,
-- onboarding art, paper textures). Migration name: comic_library_v1. Owner: P1-LIBRARY.
--
-- Writes: SERVER-ONLY (service role). Clients can neither write nor read these tables directly;
-- the public reads the published index through GET /api/comic/public/library, which serves only
-- the `published` snapshot of each row. RLS stays on with a published-only select policy as
-- defence in depth (and select is revoked from anon/authenticated anyway).
-- Storage objects live in the public bucket under comic-assets/library/v<ver>/<id>/<rev>[@640|@320].webp
-- and are NOT registered in image_assets, so the retention cron never touches them.
--
-- The build is CLIENT-DRIVEN (decisions-final #4): an admin creates a run, then the console calls
-- POST /runs/:id/step repeatedly. `lease_until` lets exactly one step work on a run at a time
-- (a retried request answers "busy"); `rev_seq` hands every attempt a unique object revision;
-- a partial unique index allows one running run per manifest version.
--
-- Idempotent: safe to run more than once. Apply BEFORE the server that uses it (harmless earlier).

create table if not exists public.library_assets (
  manifest_version integer not null,
  id text not null,
  kind text not null,
  status text not null default 'pending',
  theme text not null default 'any',
  preset_id text null,
  genre text null,
  prompt text not null,
  prompt_hash text not null,
  final_prompt text null,
  model text null,
  resolution text null,
  aspect text not null,
  rev integer not null default 0,
  rev_seq integer not null default 0,
  path text null,
  thumb_paths jsonb not null default '{}'::jsonb,
  width integer null,
  height integer null,
  bytes integer null,
  alt text not null default '',
  caption text null,
  tags text[] not null default '{}',
  palette text[] not null default '{}',
  score numeric(4,3) null,
  analysis jsonb not null default '{}'::jsonb,
  candidates jsonb not null default '[]'::jsonb,
  attempts integer not null default 0,
  cost_usd numeric(10,4) not null default 0,
  error text null,
  run_id uuid null,
  next_step jsonb null,
  published jsonb null,
  reviewed_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz null,
  primary key (manifest_version, id)
);

-- Columns added after the first draft of this file (reconcile an older live table).
alter table public.library_assets add column if not exists rev_seq integer not null default 0;
alter table public.library_assets add column if not exists next_step jsonb null;
alter table public.library_assets add column if not exists published jsonb null;

-- Checks (re-created so a rerun picks up changes; 'approved' is intentionally absent:
-- score ≥ threshold ⇒ published automatically, below ⇒ needs_review).
alter table public.library_assets drop constraint if exists library_assets_id_check;
alter table public.library_assets add constraint library_assets_id_check check (id ~ '^[a-z]+(\.[a-z0-9-]+){1,3}$');
alter table public.library_assets drop constraint if exists library_assets_kind_check;
alter table public.library_assets add constraint library_assets_kind_check
  check (kind in ('style_preview','style_anchor','genre_example','cover_example','empty_state','onboarding','texture_seed'));
alter table public.library_assets drop constraint if exists library_assets_status_check;
alter table public.library_assets add constraint library_assets_status_check
  check (status in ('pending','generating','analyzing','needs_review','published','rejected','failed'));
alter table public.library_assets drop constraint if exists library_assets_theme_check;
alter table public.library_assets add constraint library_assets_theme_check check (theme in ('any','light','dark'));
alter table public.library_assets drop constraint if exists library_assets_path_check;
alter table public.library_assets add constraint library_assets_path_check check (path is null or path like 'library/%');

-- reviewed_by → auth.users (guarded: only when the FK is not there yet).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'library_assets_reviewed_by_fkey' and conrelid = 'public.library_assets'::regclass
  ) then
    alter table public.library_assets
      add constraint library_assets_reviewed_by_fkey foreign key (reviewed_by) references auth.users(id) on delete set null;
  end if;
end $$;

create index if not exists library_assets_published_idx
  on public.library_assets (manifest_version, kind) where published is not null;
create index if not exists library_assets_run_idx
  on public.library_assets (run_id, status) where run_id is not null;

create table if not exists public.library_runs (
  id uuid primary key default gen_random_uuid(),
  manifest_version integer not null,
  started_by uuid null,
  status text not null default 'running',
  budget_usd numeric(10,4) not null,
  spent_usd numeric(10,4) not null default 0,
  request jsonb not null default '{}'::jsonb,
  quote jsonb not null default '{}'::jsonb,
  asset_ids text[] not null default '{}',
  counts jsonb not null default '{}'::jsonb,
  lease_until timestamptz null,
  steps integer not null default 0,
  error text null,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz null
);

alter table public.library_runs add column if not exists asset_ids text[] not null default '{}';
alter table public.library_runs add column if not exists lease_until timestamptz null;
alter table public.library_runs add column if not exists steps integer not null default 0;
alter table public.library_runs add column if not exists updated_at timestamptz not null default now();

alter table public.library_runs drop constraint if exists library_runs_status_check;
alter table public.library_runs add constraint library_runs_status_check
  check (status in ('running','completed','cancelled','budget_exhausted','failed'));
alter table public.library_runs drop constraint if exists library_runs_budget_check;
alter table public.library_runs add constraint library_runs_budget_check check (budget_usd > 0 and budget_usd <= 25);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'library_runs_started_by_fkey' and conrelid = 'public.library_runs'::regclass
  ) then
    alter table public.library_runs
      add constraint library_runs_started_by_fkey foreign key (started_by) references auth.users(id) on delete set null;
  end if;
end $$;

-- One running build per manifest version, across every instance (a second start → 23505 → HTTP 409).
create unique index if not exists library_runs_one_running
  on public.library_runs (manifest_version) where status = 'running';
create index if not exists library_runs_recent_idx on public.library_runs (manifest_version, started_at desc);

-- updated_at bookkeeping (stuck-row detection depends on it). Own function: no dependency on
-- helpers defined in other files.
create or replace function public.library_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.library_touch_updated_at() from public, anon, authenticated;

drop trigger if exists library_assets_touch on public.library_assets;
create trigger library_assets_touch before update on public.library_assets
  for each row execute function public.library_touch_updated_at();
drop trigger if exists library_runs_touch on public.library_runs;
create trigger library_runs_touch before update on public.library_runs
  for each row execute function public.library_touch_updated_at();

-- Access: server-only. RLS on; published-only policy kept as defence in depth.
alter table public.library_assets enable row level security;
alter table public.library_runs enable row level security;

drop policy if exists library_assets_public_read on public.library_assets;
create policy library_assets_public_read on public.library_assets
  for select to anon, authenticated using (published is not null);

revoke all on public.library_assets from anon, authenticated;
revoke all on public.library_runs from anon, authenticated;
grant all on public.library_assets to service_role;
grant all on public.library_runs to service_role;
