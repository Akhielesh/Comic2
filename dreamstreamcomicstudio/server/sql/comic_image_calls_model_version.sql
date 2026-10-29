-- comic_image_calls.model_version (models.md §2.5, §3.9; M1-LOCK-SERVER).
--
-- A vendor can route a stable model id to a newer model behind it, and a comic's model lock cannot prevent that. So
-- every comic image call records the model version the provider REPORTED (OpenRouter's `model`, Gemini's
-- `modelVersion`) next to the id we requested (`provider_model`). Insights compares them per locked comic and shows
-- "OpenRouter now serves a newer build of {Model}" when they change. Audit data only: no price, no key, no prompt.
--
-- Apply AFTER server/sql/comic_image_calls.sql (M1-CATALOG). Idempotent and guarded; RLS, grants and policies are
-- unchanged (owners read their own rows, inserts are service-role only). The server keeps writing rows without the
-- column until this is applied (it retries an insert once without model_version).

do $guard$
begin
  if to_regclass('public.comic_image_calls') is null then
    raise exception 'comic_image_calls_model_version.sql needs public.comic_image_calls: apply server/sql/comic_image_calls.sql first';
  end if;
end;
$guard$;

alter table public.comic_image_calls add column if not exists model_version text;

alter table public.comic_image_calls drop constraint if exists comic_image_calls_model_version_len;
alter table public.comic_image_calls add constraint comic_image_calls_model_version_len
  check (model_version is null or char_length(model_version) <= 160);

comment on column public.comic_image_calls.model_version is
  'Model version the provider reported for this call (audit of provider-side redirects; models.md §2.5). Null = not reported.';

-- Read-only post-apply checks:
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'comic_image_calls' and column_name = 'model_version';   -- 1 row, text
--   select relrowsecurity from pg_class where oid = 'public.comic_image_calls'::regclass;                    -- true
