-- Studio v2 — Phase 5: project persistence & versioning.
--
-- studio_runs (Phase 2) already exists. This adds the durable project model so an
-- AI-built app survives sleep/eviction/reload: the container is disposable, the project
-- is durable. RLS owner-isolated; the API writes via the service role (bypasses RLS),
-- the policies allow a user to read/manage their own rows directly.

create table if not exists public.studio_projects (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  name               text not null default 'Untitled app',
  template           text not null default 'react-ts',
  github_repo        text,
  deploy_url         text,
  current_version_id uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists studio_projects_user_idx on public.studio_projects (user_id, updated_at desc);

create table if not exists public.studio_files (
  project_id uuid not null references public.studio_projects(id) on delete cascade,
  path       text not null,
  content    text not null,
  language   text,
  updated_at timestamptz not null default now(),
  primary key (project_id, path)
);

create table if not exists public.studio_versions (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.studio_projects(id) on delete cascade,
  label      text,
  files      jsonb not null,                          -- { path: content }
  created_by text not null default 'agent',           -- agent | user
  created_at timestamptz not null default now()
);
create index if not exists studio_versions_project_idx on public.studio_versions (project_id, created_at desc);

create table if not exists public.studio_deployments (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.studio_projects(id) on delete cascade,
  target     text not null,                            -- cloudflare-pages | vercel | …
  url        text,
  status     text not null default 'queued',           -- queued | building | live | failed
  created_at timestamptz not null default now()
);

alter table public.studio_projects   enable row level security;
alter table public.studio_files       enable row level security;
alter table public.studio_versions    enable row level security;
alter table public.studio_deployments enable row level security;

drop policy if exists studio_projects_owner on public.studio_projects;
create policy studio_projects_owner on public.studio_projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Child tables: ownership flows through the parent project.
drop policy if exists studio_files_owner on public.studio_files;
create policy studio_files_owner on public.studio_files
  for all using (exists (select 1 from public.studio_projects p where p.id = project_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.studio_projects p where p.id = project_id and p.user_id = auth.uid()));

drop policy if exists studio_versions_owner on public.studio_versions;
create policy studio_versions_owner on public.studio_versions
  for all using (exists (select 1 from public.studio_projects p where p.id = project_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.studio_projects p where p.id = project_id and p.user_id = auth.uid()));

drop policy if exists studio_deployments_owner on public.studio_deployments;
create policy studio_deployments_owner on public.studio_deployments
  for all using (exists (select 1 from public.studio_projects p where p.id = project_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.studio_projects p where p.id = project_id and p.user_id = auth.uid()));
