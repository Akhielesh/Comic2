-- Enforce per-user isolation for projects and allow only public reads for shared comics.
-- Run in Supabase SQL Editor.

alter table public.projects enable row level security;

drop policy if exists projects_select_public_or_owner on public.projects;
create policy projects_select_public_or_owner
on public.projects
for select
to anon, authenticated
using (is_public = true or auth.uid() = user_id);

drop policy if exists projects_insert_owner on public.projects;
create policy projects_insert_owner
on public.projects
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists projects_update_owner on public.projects;
create policy projects_update_owner
on public.projects
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists projects_delete_owner on public.projects;
create policy projects_delete_owner
on public.projects
for delete
to authenticated
using (auth.uid() = user_id);
