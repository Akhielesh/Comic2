-- ComicForge v1 full pipeline schema (idempotent)
-- Adapted to existing DreamStream projects table.

begin;

alter table if exists public.projects
  add column if not exists status text default 'setup',
  add column if not exists format_spec jsonb,
  add column if not exists style_bible jsonb,
  add column if not exists page_plan jsonb,
  add column if not exists beat_sheet jsonb;

create table if not exists public.scripts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  version int default 1,
  raw_input text,
  structured_script jsonb,
  scene_list jsonb,
  cast_list jsonb,
  prop_list jsonb,
  ambiguity_flags jsonb,
  tone text,
  genre text,
  created_at timestamptz default now()
);

create table if not exists public.asset_cards (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  card_type text not null,
  name text not null,
  canonical_description text,
  do_not_change jsonb,
  negative_constraints jsonb,
  allowed_variants jsonb,
  reference_images jsonb,
  consistency_method text,
  hash text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.layout_templates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid,
  name text,
  panel_count int,
  grid_definition jsonb,
  gutter_px int,
  caption_style text,
  balloon_style text,
  sfx_style text,
  source text,
  preview_image_url text,
  created_at timestamptz default now()
);

create table if not exists public.pages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  page_number int not null,
  purpose text,
  layout_template_id uuid references public.layout_templates(id) on delete set null,
  balloon_safe_zones jsonb,
  assembled_image_url text,
  status text default 'planned',
  created_at timestamptz default now()
);

create table if not exists public.panels (
  id uuid primary key default gen_random_uuid(),
  page_id uuid references public.pages(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  panel_index int not null,
  panel_description text,
  camera_shot text,
  characters_present jsonb,
  props_present jsonb,
  location_id uuid,
  time_of_day text,
  generation_prompt text,
  reference_image_urls jsonb,
  thumbnail_url text,
  draft_image_url text,
  final_image_url text,
  model_used text,
  generation_cost numeric(10,6),
  qc_passed boolean,
  qc_flags jsonb,
  version int default 1,
  created_at timestamptz default now()
);

create table if not exists public.panel_lettering (
  id uuid primary key default gen_random_uuid(),
  panel_id uuid references public.panels(id) on delete cascade,
  elements jsonb,
  rendered_svg text,
  created_at timestamptz default now()
);

create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  entity_id uuid,
  entity_type text,
  task_type text,
  model_used text,
  status text default 'queued',
  cost numeric(10,6),
  input_payload jsonb,
  output_payload jsonb,
  error_message text,
  created_at timestamptz default now(),
  completed_at timestamptz
);

create index if not exists idx_scripts_project_id on public.scripts(project_id);
create index if not exists idx_asset_cards_project_id on public.asset_cards(project_id);
create index if not exists idx_pages_project_id on public.pages(project_id);
create index if not exists idx_panels_project_id on public.panels(project_id);
create index if not exists idx_panels_page_id on public.panels(page_id);
create index if not exists idx_panel_lettering_panel_id on public.panel_lettering(panel_id);
create index if not exists idx_layout_templates_project_id on public.layout_templates(project_id);
create index if not exists idx_generation_jobs_project_id on public.generation_jobs(project_id);
create index if not exists idx_generation_jobs_status on public.generation_jobs(status);
create index if not exists idx_generation_jobs_task_type on public.generation_jobs(task_type);
create index if not exists idx_generation_jobs_created_at on public.generation_jobs(created_at);

alter table public.scripts enable row level security;
alter table public.asset_cards enable row level security;
alter table public.layout_templates enable row level security;
alter table public.pages enable row level security;
alter table public.panels enable row level security;
alter table public.panel_lettering enable row level security;
alter table public.generation_jobs enable row level security;

-- Ownership via projects.user_id
drop policy if exists scripts_owner_policy on public.scripts;
create policy scripts_owner_policy on public.scripts
  for all
  using (
    exists (
      select 1 from public.projects p
      where p.id = scripts.project_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      where p.id = scripts.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists asset_cards_owner_policy on public.asset_cards;
create policy asset_cards_owner_policy on public.asset_cards
  for all
  using (
    exists (
      select 1 from public.projects p
      where p.id = asset_cards.project_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      where p.id = asset_cards.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists layout_templates_owner_policy on public.layout_templates;
create policy layout_templates_owner_policy on public.layout_templates
  for all
  using (
    project_id is null or exists (
      select 1 from public.projects p
      where p.id = layout_templates.project_id and p.user_id = auth.uid()
    )
  )
  with check (
    project_id is null or exists (
      select 1 from public.projects p
      where p.id = layout_templates.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists pages_owner_policy on public.pages;
create policy pages_owner_policy on public.pages
  for all
  using (
    exists (
      select 1 from public.projects p
      where p.id = pages.project_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      where p.id = pages.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists panels_owner_policy on public.panels;
create policy panels_owner_policy on public.panels
  for all
  using (
    exists (
      select 1 from public.projects p
      where p.id = panels.project_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      where p.id = panels.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists panel_lettering_owner_policy on public.panel_lettering;
create policy panel_lettering_owner_policy on public.panel_lettering
  for all
  using (
    exists (
      select 1
      from public.panels pa
      join public.projects p on p.id = pa.project_id
      where pa.id = panel_lettering.panel_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.panels pa
      join public.projects p on p.id = pa.project_id
      where pa.id = panel_lettering.panel_id and p.user_id = auth.uid()
    )
  );

drop policy if exists generation_jobs_owner_policy on public.generation_jobs;
create policy generation_jobs_owner_policy on public.generation_jobs
  for all
  using (
    exists (
      select 1 from public.projects p
      where p.id = generation_jobs.project_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      where p.id = generation_jobs.project_id and p.user_id = auth.uid()
    )
  );

commit;
