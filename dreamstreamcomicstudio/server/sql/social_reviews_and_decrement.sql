-- Delta applied to the existing "Comic" Supabase project on 2026-05-29.
--
-- Introspection showed the social layer was already largely present
-- (comments, follows, notifications, comment_likes, project_likes, the
-- likes_count/views_count counters, and increment_project_view/like RPCs).
-- Only two pieces were missing, which this migration adds:
--   1. the reviews table (submitReview / getReviews in services/db.ts)
--   2. decrement_project_like — the counterpart to the existing
--      increment_project_like (without it, unliking failed silently and
--      project like counts could only ever increase).
--
-- See social_foundation.sql for the full canonical greenfield schema.
-- Idempotent; safe to re-run.

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  rating numeric,
  scores jsonb,
  text text not null,
  created_at timestamptz not null default now(),
  unique (project_id, user_id)
);
create index if not exists idx_reviews_project on public.reviews (project_id, created_at desc);

alter table public.reviews enable row level security;

drop policy if exists reviews_select_visible on public.reviews;
create policy reviews_select_visible on public.reviews
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = reviews.project_id
        and (p.is_public = true or p.user_id = auth.uid())
    )
  );

drop policy if exists reviews_insert_own on public.reviews;
create policy reviews_insert_own on public.reviews
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists reviews_update_own on public.reviews;
create policy reviews_update_own on public.reviews
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists reviews_delete_own on public.reviews;
create policy reviews_delete_own on public.reviews
  for delete to authenticated
  using (auth.uid() = user_id);

create or replace function public.decrement_project_like(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.projects set likes_count = greatest(coalesce(likes_count, 0) - 1, 0) where id = p_id;
$$;

revoke all on function public.decrement_project_like(uuid) from public;
grant execute on function public.decrement_project_like(uuid) to anon, authenticated;
