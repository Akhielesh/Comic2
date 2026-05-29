-- Social / Community Foundation
-- Tables + RPCs that power the public comic library and the activity stream:
--   project_likes, comments, comment_likes, follows, notifications, reviews
-- Also adds the projects.likes_count / views_count counters and the RPCs that
-- maintain them. Every object here is referenced by services/db.ts.
--
-- Idempotent: safe to re-run. Apply via Supabase SQL Editor or the MCP
-- apply_migration tool.
--
-- NOTE: On the existing "Comic" Supabase project most of these objects already
-- existed; only the reviews table and decrement_project_like were missing. That
-- delta was applied 2026-05-29 (see social_reviews_and_decrement.sql). This file
-- remains the canonical greenfield schema for standing up a fresh environment.

-- ============================================================
-- 0. Project engagement counters (read by mapProjectRow)
-- ============================================================
alter table public.projects add column if not exists likes_count integer not null default 0;
alter table public.projects add column if not exists views_count integer not null default 0;

-- ============================================================
-- 1. project_likes  (toggleProjectLike / getProjectLikeMap)
-- ============================================================
create table if not exists public.project_likes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (project_id, user_id)
);
create index if not exists idx_project_likes_project on public.project_likes (project_id);
create index if not exists idx_project_likes_user on public.project_likes (user_id);

alter table public.project_likes enable row level security;

-- A user only ever queries their own like rows (the public count lives on
-- projects.likes_count), so least-privilege select is scoped to self.
drop policy if exists project_likes_select_own on public.project_likes;
create policy project_likes_select_own on public.project_likes
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists project_likes_insert_own on public.project_likes;
create policy project_likes_insert_own on public.project_likes
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists project_likes_delete_own on public.project_likes;
create policy project_likes_delete_own on public.project_likes
  for delete to authenticated
  using (auth.uid() = user_id);

-- ============================================================
-- 2. comments  (addComment / getComments / updateComment / deleteComment)
-- ============================================================
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create index if not exists idx_comments_project on public.comments (project_id, created_at);

alter table public.comments enable row level security;

-- Readable when the parent project is public (or you own it).
drop policy if exists comments_select_visible on public.comments;
create policy comments_select_visible on public.comments
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = comments.project_id
        and (p.is_public = true or p.user_id = auth.uid())
    )
  );

drop policy if exists comments_insert_own on public.comments;
create policy comments_insert_own on public.comments
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists comments_update_own on public.comments;
create policy comments_update_own on public.comments
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Comment author OR the owner of the project (moderation) may delete.
drop policy if exists comments_delete_own_or_owner on public.comments;
create policy comments_delete_own_or_owner on public.comments
  for delete to authenticated
  using (
    auth.uid() = user_id
    or exists (
      select 1 from public.projects p
      where p.id = comments.project_id and p.user_id = auth.uid()
    )
  );

-- ============================================================
-- 3. comment_likes  (likeComment / unlikeComment / getComments isLiked)
-- ============================================================
create table if not exists public.comment_likes (
  comment_id uuid not null references public.comments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);
create index if not exists idx_comment_likes_comment on public.comment_likes (comment_id);

alter table public.comment_likes enable row level security;

-- Counts/“did I like this” are read broadly; writes are self-only.
drop policy if exists comment_likes_select_all on public.comment_likes;
create policy comment_likes_select_all on public.comment_likes
  for select to anon, authenticated
  using (true);

drop policy if exists comment_likes_insert_own on public.comment_likes;
create policy comment_likes_insert_own on public.comment_likes
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists comment_likes_delete_own on public.comment_likes;
create policy comment_likes_delete_own on public.comment_likes
  for delete to authenticated
  using (auth.uid() = user_id);

-- ============================================================
-- 4. follows  (followUser / unfollowUser / isFollowing / getFollowersCount)
-- ============================================================
create table if not exists public.follows (
  follower_id uuid not null references auth.users(id) on delete cascade,
  following_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);
create index if not exists idx_follows_following on public.follows (following_id);
create index if not exists idx_follows_follower on public.follows (follower_id);

alter table public.follows enable row level security;

-- Follower graph is public (follower counts are shown on profiles).
drop policy if exists follows_select_all on public.follows;
create policy follows_select_all on public.follows
  for select to anon, authenticated
  using (true);

drop policy if exists follows_insert_own on public.follows;
create policy follows_insert_own on public.follows
  for insert to authenticated
  with check (auth.uid() = follower_id);

drop policy if exists follows_delete_own on public.follows;
create policy follows_delete_own on public.follows
  for delete to authenticated
  using (auth.uid() = follower_id);

-- ============================================================
-- 5. notifications  (getNotifications / createNotification / markRead)
--    getNotifications embeds actor:actor_id (username, avatar_url) -> profiles
-- ============================================================
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  type text not null check (type in ('follow', 'comment', 'like', 'system', 'generation')),
  entity_id text,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_notifications_user on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;

-- Only the recipient can read / mark their notifications.
drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select to authenticated
  using (auth.uid() = user_id);

-- Any signed-in user may create a notification for someone else, but only as
-- themselves (the actor) — this backs like/comment/follow side effects.
drop policy if exists notifications_insert_actor on public.notifications;
create policy notifications_insert_actor on public.notifications
  for insert to authenticated
  with check (auth.uid() = actor_id);

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- 6. reviews  (submitReview / getReviews)
-- ============================================================
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

-- ============================================================
-- 7. Engagement counter RPCs
--    SECURITY DEFINER so a viewer (who does not own the project, and is
--    blocked by projects RLS) can still bump the public counter.
-- ============================================================
create or replace function public.increment_project_view(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.projects set views_count = coalesce(views_count, 0) + 1 where id = p_id;
$$;

create or replace function public.increment_project_like(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.projects set likes_count = coalesce(likes_count, 0) + 1 where id = p_id;
$$;

create or replace function public.decrement_project_like(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.projects set likes_count = greatest(coalesce(likes_count, 0) - 1, 0) where id = p_id;
$$;

revoke all on function public.increment_project_view(uuid) from public;
revoke all on function public.increment_project_like(uuid) from public;
revoke all on function public.decrement_project_like(uuid) from public;
grant execute on function public.increment_project_view(uuid) to anon, authenticated;
grant execute on function public.increment_project_like(uuid) to anon, authenticated;
grant execute on function public.decrement_project_like(uuid) to anon, authenticated;
