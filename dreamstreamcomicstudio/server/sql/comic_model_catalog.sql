-- Comic Studio model catalog history (models.md §5.1 M1-CATALOG, §4.4 T3/T6, §4.5 S1–S3).
--
-- What the server's on-demand catalog (server/src/comic/models) persists besides the existing cache:
--   * model_catalog_cache (EXISTING, model_catalog_cache.sql): the catalog writes its S1/S2 cache there under
--     source 'openrouter_images' (the image model list) and 'openrouter_images_endpoints' (per-endpoint
--     pricing), so a container that wakes up starts from the last fetch instead of OpenRouter.
--   * model_pricing_snapshots (NEW): one row per (OpenRouter model id, resolution) ONLY WHEN a fetched price
--     changes — the "Price changes · Tracking since {first fetch}" trend. Change-only rows are few; kept.
--   * model_uptime_daily (NEW): OpenRouter's documented uptime_last_1d / uptime_last_30m per endpoint, one row
--     per model, provider and UTC day (the last fetch of the day wins) — the OpenRouter half of T6. 180 days.
--
-- All public data (OpenRouter's unauthenticated catalog), no user data. RLS ON with no policies and every
-- client privilege revoked: only the service role (the server) reads and writes. Nothing here runs on a
-- timer in the app; the optional pg_cron purge runs inside the database and never wakes the container.
--
-- Idempotent and guarded: safe to re-run; named checks converge on this file. Apply BEFORE the server that
-- writes these tables (harmless earlier).

do $guard$
begin
  if to_regclass('public.model_catalog_cache') is null then
    raise notice 'model_catalog_cache is missing: apply server/sql/model_catalog_cache.sql too (the catalog then runs memory-only for its cache)';
  end if;
end;
$guard$;

-- ── 1. Price snapshots (change-only) ────────────────────────────────────────────────────────

create table if not exists public.model_pricing_snapshots (
  id bigserial primary key,
  model_id text not null,           -- OpenRouter id, e.g. google/gemini-nano-banana-2.1
  res text not null,
  usd numeric(12, 6),               -- null = OpenRouter gave no number we could map (the note says why)
  basis text not null,
  note text,
  provider text,
  fetched_at timestamptz not null default now()
);

alter table public.model_pricing_snapshots drop constraint if exists model_pricing_snapshots_res_check;
alter table public.model_pricing_snapshots add constraint model_pricing_snapshots_res_check
  check (res in ('512', '1K', '2K', '4K'));
alter table public.model_pricing_snapshots drop constraint if exists model_pricing_snapshots_basis_check;
alter table public.model_pricing_snapshots add constraint model_pricing_snapshots_basis_check
  check (basis in ('openrouter_endpoint', 'vendor_table', 'derived_mp', 'registry'));
alter table public.model_pricing_snapshots drop constraint if exists model_pricing_snapshots_usd_check;
alter table public.model_pricing_snapshots add constraint model_pricing_snapshots_usd_check
  check (usd is null or usd >= 0);
alter table public.model_pricing_snapshots drop constraint if exists model_pricing_snapshots_text_check;
alter table public.model_pricing_snapshots add constraint model_pricing_snapshots_text_check
  check (char_length(model_id) <= 200 and coalesce(char_length(note), 0) <= 500 and coalesce(char_length(provider), 0) <= 120);

create index if not exists model_pricing_snapshots_model_res_idx on public.model_pricing_snapshots (model_id, res, fetched_at desc);
create index if not exists model_pricing_snapshots_fetched_idx on public.model_pricing_snapshots (fetched_at);

alter table public.model_pricing_snapshots enable row level security;
revoke all on table public.model_pricing_snapshots from public, anon, authenticated;
grant all on table public.model_pricing_snapshots to service_role;

-- ── 2. Uptime, one row per model · provider · day ───────────────────────────────────────────

create table if not exists public.model_uptime_daily (
  model_id text not null,
  provider text not null,
  day date not null,
  uptime_1d numeric(7, 4),
  uptime_30m numeric(7, 4),
  fetched_at timestamptz not null default now(),
  primary key (model_id, provider, day)
);

alter table public.model_uptime_daily drop constraint if exists model_uptime_daily_range_check;
alter table public.model_uptime_daily add constraint model_uptime_daily_range_check
  check ((uptime_1d is null or uptime_1d between 0 and 100) and (uptime_30m is null or uptime_30m between 0 and 100));
alter table public.model_uptime_daily drop constraint if exists model_uptime_daily_text_check;
alter table public.model_uptime_daily add constraint model_uptime_daily_text_check
  check (char_length(model_id) <= 200 and char_length(provider) <= 120);

create index if not exists model_uptime_daily_day_idx on public.model_uptime_daily (day);

alter table public.model_uptime_daily enable row level security;
revoke all on table public.model_uptime_daily from public, anon, authenticated;
grant all on table public.model_uptime_daily to service_role;

do $seq$
begin
  execute 'revoke all on sequence public.model_pricing_snapshots_id_seq from public, anon, authenticated';
  execute 'grant usage, select on sequence public.model_pricing_snapshots_id_seq to service_role';
exception when undefined_table then
  raise notice 'model_pricing_snapshots_id_seq not found; nothing to revoke';
end;
$seq$;

-- ── 3. Retention: uptime 180 days (price snapshots are kept: they ARE the history) ──────────

create or replace function public.purge_comic_model_catalog()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with d as (
    delete from public.model_uptime_daily where day < (now() - interval '180 days')::date returning 1
  )
  select count(*)::int from d;
$$;
revoke all on function public.purge_comic_model_catalog() from public, anon, authenticated;
grant execute on function public.purge_comic_model_catalog() to service_role;

do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'comic-model-catalog-purge-daily';
    perform cron.schedule('comic-model-catalog-purge-daily', '47 3 * * *', $job$select public.purge_comic_model_catalog();$job$);
  else
    raise notice 'pg_cron not installed; run select public.purge_comic_model_catalog(); daily yourself.';
  end if;
exception when undefined_table or undefined_function or invalid_schema_name then
  raise notice 'pg_cron unavailable; schedule purge_comic_model_catalog() yourself.';
end;
$do$;

-- ── Post-apply checks (read-only) ───────────────────────────────────────────────────────────
--    select relname, relrowsecurity from pg_class where relname in ('model_pricing_snapshots', 'model_uptime_daily'); -- both true
--    select table_name, grantee from information_schema.role_table_grants
--     where table_name in ('model_pricing_snapshots', 'model_uptime_daily') and grantee in ('anon', 'authenticated'); -- 0 rows
--    select tablename, policyname from pg_policies where tablename in ('model_pricing_snapshots', 'model_uptime_daily'); -- 0 rows
