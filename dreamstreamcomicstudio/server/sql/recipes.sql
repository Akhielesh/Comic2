-- Recipe library: a user's saved, reusable agent workflows (a native port of goose
-- recipes). The full sanitized recipe is stored as JSONB; the slug is the stable,
-- per-user identifier used by the API. Mirrors the custom_agents table.
--
-- Apply in the Supabase SQL editor (or via migration tooling). Safe to re-run.

create table if not exists public.recipes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  slug        text not null,
  recipe      jsonb not null,
  is_public   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, slug)
);

create index if not exists recipes_user_idx on public.recipes (user_id, updated_at desc);
create index if not exists recipes_public_idx on public.recipes (is_public) where is_public = true;

-- Row-level security: a user can only see/modify their own recipes (public ones are
-- still surfaced through the service role in a curated route, not via anon RLS).
alter table public.recipes enable row level security;

drop policy if exists "recipes_owner_select" on public.recipes;
create policy "recipes_owner_select" on public.recipes
  for select using (auth.uid() = user_id);

drop policy if exists "recipes_owner_modify" on public.recipes;
create policy "recipes_owner_modify" on public.recipes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Keep updated_at fresh on every write. search_path is pinned empty (the body only
-- calls now() from pg_catalog) to satisfy the function_search_path_mutable linter.
create or replace function public.touch_recipes_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists recipes_touch_updated_at on public.recipes;
create trigger recipes_touch_updated_at
  before update on public.recipes
  for each row execute function public.touch_recipes_updated_at();
