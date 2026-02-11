-- Atomic usage accounting for image generations.
-- Creates the row on first usage, then increments in-place on subsequent calls.
create or replace function public.increment_user_usage(p_user_id uuid)
returns integer
language plpgsql
as $$
declare
  v_new_count integer;
begin
  insert into public.usage_limits (user_id, images_generated_count)
  values (p_user_id, 1)
  on conflict (user_id)
  do update
    set images_generated_count = public.usage_limits.images_generated_count + 1
  returning public.usage_limits.images_generated_count into v_new_count;

  return v_new_count;
end;
$$;
