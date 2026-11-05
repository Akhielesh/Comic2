-- comic_image_calls_model_version.sql (models.md §2.5, M1-LOCK-SERVER):
--   * applies twice on top of comic_image_calls.sql (idempotent);
--   * the column takes a reported version, null when none, and nothing longer than 160 characters;
--   * RLS stays on and signed-in users still cannot write rows.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create table public.model_pricing_snapshots (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  model_id text not null
);

\ir ../comic_image_calls.sql
\ir ../comic_image_calls_model_version.sql
\ir ../comic_image_calls_model_version.sql

do $$
declare
  owner_id uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (owner_id);
  insert into public.comic_image_calls (user_id, model_id, provider_model, route, kind, res, outcome, model_version)
       values (owner_id, 'nano-banana-2.1', 'google/gemini-nano-banana-2.1', 'openrouter', 'page', '1K', 'ok', 'google/gemini-nano-banana-2.1-20261006');
  insert into public.comic_image_calls (user_id, model_id, route, kind, outcome) values (owner_id, 'nano-banana-2.1', 'gemini', 'sheet', 'failed');
  assert (select count(*) from public.comic_image_calls where model_version = 'google/gemini-nano-banana-2.1-20261006') = 1, 'version stored';
  assert (select count(*) from public.comic_image_calls where model_version is null) = 1, 'null when not reported';
  begin
    insert into public.comic_image_calls (user_id, model_id, route, kind, outcome, model_version) values (owner_id, 'x', 'openrouter', 'page', 'ok', repeat('v', 161));
    raise exception 'an over-long version was accepted';
  exception when check_violation then
    null;
  end;
  assert (select relrowsecurity from pg_class where oid = 'public.comic_image_calls'::regclass), 'RLS stays on';
  assert not has_table_privilege('authenticated', 'public.comic_image_calls', 'insert'), 'clients still cannot write';
end;
$$;

\echo COMIC_IMAGE_CALLS_MODEL_VERSION_OK
