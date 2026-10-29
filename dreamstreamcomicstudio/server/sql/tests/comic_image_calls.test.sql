-- comic_image_calls.sql + comic_model_catalog.sql (models.md §5.1 M1-CATALOG, AT-9):
--   * both files apply twice (idempotent);
--   * a signed-in user reads only their own call rows and cannot write any;
--   * comic_image_model_stats(p_since) drops groups with fewer than 5 distinct users, reports a cost only when
--     5 distinct users have a priced call, and is not executable by clients;
--   * the route / outcome checks hold; the 180-day purge deletes only old rows;
--   * the catalog history tables are service-role only;
--   * the billing table public.model_pricing_snapshots (token billing, in production) is never touched: same
--     columns, same signed-in read policy and privilege after both files applied twice.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- The billing table exactly as token_billing_foundation.sql creates it, with its signed-in read policy. Production
-- has it; a catalog file that reused its name would fail (no column "res") or strip that policy's privilege.
create table public.model_pricing_snapshots (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  model_id text not null,
  input_per_1k numeric(12, 6) not null default 0,
  output_per_1k numeric(12, 6) not null default 0,
  image_per_output numeric(12, 6) not null default 0,
  other_billable_per_unit numeric(12, 6) not null default 0,
  currency text not null default 'USD',
  source_url text,
  status text not null default 'ACTIVE',
  parser_confidence numeric(5, 4) not null default 1,
  fetched_at timestamptz not null default now(),
  effective_from timestamptz not null default now(),
  raw_payload jsonb not null default '{}'::jsonb
);
alter table public.model_pricing_snapshots enable row level security;
create policy model_pricing_snapshots_read on public.model_pricing_snapshots for select to authenticated using (true);
grant select on table public.model_pricing_snapshots to authenticated;
insert into public.model_pricing_snapshots (provider, model_id, image_per_output) values ('openrouter', 'google/gemini-nano-banana-2.1', 0.0336);
create temporary table billing_shape as
  select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position) as cols
    from information_schema.columns where table_schema = 'public' and table_name = 'model_pricing_snapshots';

\ir ../comic_image_calls.sql
\ir ../comic_image_calls.sql
\ir ../comic_model_catalog.sql
\ir ../comic_model_catalog.sql

do $$
declare
  n int;
begin
  assert (select cols from billing_shape) = (select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position)
                                               from information_schema.columns where table_schema = 'public' and table_name = 'model_pricing_snapshots'),
    'the billing table model_pricing_snapshots must keep its columns';
  assert has_table_privilege('authenticated', 'public.model_pricing_snapshots', 'select'), 'signed-in users keep their billing read privilege';
  select count(*) into n from pg_policies where tablename = 'model_pricing_snapshots' and policyname = 'model_pricing_snapshots_read';
  assert n = 1, 'the billing read policy is untouched';
  select count(*) into n from public.model_pricing_snapshots;
  assert n = 1, 'no catalog row lands in the billing table';
  select count(*) into n from pg_constraint where conrelid = 'public.model_pricing_snapshots'::regclass and contype = 'c';
  assert n = 0, 'no catalog check constraint lands on the billing table';
  assert to_regclass('public.comic_model_price_changes') is not null and to_regclass('public.comic_model_uptime_daily') is not null, 'the catalog tables exist';
end $$;

-- ------------------------------------------------------------------ fixtures (synthetic)
insert into auth.users (id, email)
select ('00000000-0000-0000-0000-00000000000' || n)::uuid, 'u' || n || '@example.com' from generate_series(1, 7) n;

-- Group A: nano-banana-2.1 · page · 1K — 5 distinct users, all priced (shown, with a cost).
insert into public.comic_image_calls (user_id, model_id, route, kind, res, outcome, provider_cost_usd, created_at)
select ('00000000-0000-0000-0000-00000000000' || n)::uuid, 'nano-banana-2.1', 'openrouter', 'page', '1K', 'ok', 0.04 + n * 0.001, now() - interval '1 hour'
  from generate_series(1, 5) n;
-- One 429 in group A (failed; counted as rate-limited).
insert into public.comic_image_calls (user_id, model_id, route, kind, res, outcome, http_status, error_code, provider_cost_usd, created_at)
values ('00000000-0000-0000-0000-000000000001', 'nano-banana-2.1', 'openrouter', 'page', '1K', 'failed', 429, 'RATE_LIMIT', 0, now() - interval '30 minutes');
-- Group B: nano-banana-pro · page · 2K — only 4 distinct users (suppressed).
insert into public.comic_image_calls (user_id, model_id, route, kind, res, outcome, provider_cost_usd, created_at)
select ('00000000-0000-0000-0000-00000000000' || n)::uuid, 'nano-banana-pro', 'gemini', 'page', '2K', 'ok', 0.134, now() - interval '2 hours'
  from generate_series(1, 4) n;
-- Group C: nano-banana-2.1 · cover · 2K — 5 users, but only 2 with a priced call (counts shown, no cost).
insert into public.comic_image_calls (user_id, model_id, route, kind, res, outcome, provider_cost_usd, created_at)
select ('00000000-0000-0000-0000-00000000000' || n)::uuid, 'nano-banana-2.1', 'openrouter', 'cover', '2K',
       case when n <= 2 then 'ok' else 'failed' end, case when n <= 2 then 0.054 else 0 end, now() - interval '3 hours'
  from generate_series(1, 5) n;
-- Group D: seedream-5-pro · page · 1K — 25 priced calls from 6 users. The 5 OLDEST cost $1 (outliers); the cost
-- figures cover only the newest 20 ($0.05 each), and n is 20 of 25 priced calls.
insert into public.comic_image_calls (user_id, model_id, route, kind, res, outcome, provider_cost_usd, created_at)
select ('00000000-0000-0000-0000-00000000000' || (n % 6 + 1))::uuid, 'seedream-5-pro', 'openrouter', 'page', '1K', 'ok',
       case when n > 20 then 1.0 else 0.05 end, now() - n * interval '1 minute'
  from generate_series(1, 25) n;
-- Group E: flux-3 · page · 1K — 5 distinct users (shown), but the newest 20 priced calls come from 4 of them:
-- no cost may be shown for that window.
insert into public.comic_image_calls (user_id, model_id, route, kind, res, outcome, provider_cost_usd, created_at)
select ('00000000-0000-0000-0000-00000000000' || (n % 4 + 1))::uuid, 'flux-3', 'openrouter', 'page', '1K', 'ok', 0.048, now() - n * interval '1 minute'
  from generate_series(1, 20) n;
insert into public.comic_image_calls (user_id, model_id, route, kind, res, outcome, provider_cost_usd, created_at)
values ('00000000-0000-0000-0000-000000000005', 'flux-3', 'openrouter', 'page', '1K', 'ok', 0.048, now() - interval '2 hours');
-- Preflight-blocked rows never count; a 200-day-old row is outside every window and purged.
insert into public.comic_image_calls (user_id, model_id, kind, res, outcome, created_at)
select ('00000000-0000-0000-0000-00000000000' || n)::uuid, 'gpt-image-2.5', 'page', '1K', 'blocked', now() - interval '1 hour' from generate_series(1, 6) n;
insert into public.comic_image_calls (user_id, model_id, route, kind, res, outcome, provider_cost_usd, created_at)
values ('00000000-0000-0000-0000-000000000006', 'nano-banana-2.1', 'openrouter', 'page', '1K', 'ok', 0.05, now() - interval '200 days');

-- ------------------------------------------------------------------ checks
do $$
begin
  begin
    insert into public.comic_image_calls (user_id, route, outcome) values ('00000000-0000-0000-0000-000000000001', 'other', 'ok');
    raise exception 'route check missing';
  exception when check_violation then null;
  end;
  begin
    insert into public.comic_image_calls (user_id, route, outcome) values ('00000000-0000-0000-0000-000000000001', 'openrouter', 'maybe');
    raise exception 'outcome check missing';
  exception when check_violation then null;
  end;
end $$;

-- ------------------------------------------------------------------ the platform aggregate
do $$
declare
  a record;
  n int;
begin
  select * into a from public.comic_image_model_stats(now() - interval '1 day') where model_id = 'nano-banana-2.1' and kind = 'page';
  assert a.distinct_users = 5, 'group A has 5 users';
  assert a.calls = 6 and a.ok = 5 and a.failed = 1 and a.rate_limited = 1, format('group A counts %s/%s/%s/%s', a.calls, a.ok, a.failed, a.rate_limited);
  assert a.median_cost_usd = 0.043, format('group A median %s', a.median_cost_usd);
  assert a.min_cost_usd = 0.041 and a.max_cost_usd = 0.045, 'group A min/max';
  assert a.priced_calls = 5 and a.cost_n = 5, format('group A n counts priced calls only: %s / %s', a.priced_calls, a.cost_n);
  assert a.cost_from is not null and a.cost_to >= a.cost_from, 'group A cost window';

  select * into a from public.comic_image_model_stats(now() - interval '1 day') where model_id = 'seedream-5-pro';
  assert a.priced_calls = 25 and a.cost_n = 20, format('group D: 25 priced calls, costs over the newest 20 (got %s / %s)', a.priced_calls, a.cost_n);
  assert a.median_cost_usd = 0.05 and a.max_cost_usd = 0.05, format('the 5 oldest $1 outliers are outside the last-20 window (median %s, max %s)', a.median_cost_usd, a.max_cost_usd);

  select * into a from public.comic_image_model_stats(now() - interval '1 day') where model_id = 'flux-3';
  assert a.distinct_users = 5 and a.priced_calls = 21, 'group E counts are shown';
  assert a.cost_n is null and a.median_cost_usd is null and a.min_cost_usd is null, 'costs from fewer than 5 users in the last-20 window must not be shown';

  select count(*) into n from public.comic_image_model_stats(now() - interval '1 day') where model_id = 'nano-banana-pro';
  assert n = 0, 'a group with 4 distinct users must be suppressed';

  select * into a from public.comic_image_model_stats(now() - interval '1 day') where model_id = 'nano-banana-2.1' and kind = 'cover';
  assert a.distinct_users = 5 and a.calls = 5, 'group C counts are shown';
  assert a.median_cost_usd is null and a.min_cost_usd is null and a.max_cost_usd is null, 'a cost from fewer than 5 priced users must not be shown';
  assert a.priced_calls = 2 and a.cost_n is null, 'group C: 2 priced calls, no cost window';

  select count(*) into n from public.comic_image_model_stats(now() - interval '1 day') where model_id = 'gpt-image-2.5';
  assert n = 0, 'preflight-blocked rows are not calls';

  -- p_since can never reach past the 180-day retention window.
  select count(*) into n from public.comic_image_model_stats('2000-01-01') where model_id = 'nano-banana-2.1' and kind = 'page' and calls = 6;
  assert n = 1, 'the 200-day-old row is outside the window';
end $$;

-- ------------------------------------------------------------------ a signed-in user (RLS)
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', false);
set role authenticated;
do $$
declare
  n int;
begin
  select count(*) into n from public.comic_image_calls;
  assert n = 14, format('user 1 sees only their own 14 rows (5 in groups A–C and blocked, 4 in D, 5 in E), saw %s', n);
  select count(*) into n from public.comic_image_calls where user_id <> '00000000-0000-0000-0000-000000000001';
  assert n = 0, 'no other user''s row is visible';
  begin
    insert into public.comic_image_calls (user_id, model_id, outcome) values ('00000000-0000-0000-0000-000000000001', 'x', 'ok');
    raise exception 'a client insert must be refused';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.comic_image_calls set provider_cost_usd = 0;
    raise exception 'a client update must be refused';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.comic_image_model_stats(now() - interval '1 day');
    raise exception 'clients must not execute the aggregate';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.comic_model_price_changes;
    raise exception 'price snapshots are service-role only';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.comic_model_uptime_daily;
    raise exception 'uptime history is service-role only';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set role anon;
do $$
begin
  begin
    perform 1 from public.comic_image_calls;
    raise exception 'anon must not read call rows';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ------------------------------------------------------------------ the service role writes; retention
set role service_role;
insert into public.comic_model_price_changes (model_id, res, usd, basis, note) values ('google/gemini-nano-banana-2.1', '1K', 0.0336, 'vendor_table', 'test');
insert into public.comic_model_uptime_daily (model_id, provider, day, uptime_1d) values ('google/gemini-nano-banana-2.1', 'Google AI Studio', current_date, 97.7221);
insert into public.comic_model_uptime_daily (model_id, provider, day, uptime_1d) values ('google/gemini-nano-banana-2.1', 'Google AI Studio', current_date - 200, 99.0);
insert into public.comic_image_calls (user_id, model_id, route, kind, res, outcome, provider_cost_usd)
values ('00000000-0000-0000-0000-000000000007', 'nano-banana-2.1', 'gemini', 'sheet', '1K', 'ok', 0.0373);
do $$
declare
  n int;
begin
  n := public.purge_comic_image_calls();
  assert n = 1, format('the purge removes only the 200-day-old call, removed %s', n);
  n := public.purge_comic_model_catalog();
  assert n = 1, format('the purge removes only the 200-day-old uptime row, removed %s', n);
  select count(*) into n from public.comic_image_calls where created_at < now() - interval '180 days';
  assert n = 0, 'nothing older than 180 days remains';
end $$;
reset role;

do $$
begin
  begin
    insert into public.comic_model_price_changes (model_id, res, usd, basis) values ('x/y', '8K', 1, 'vendor_table');
    raise exception 'res check missing';
  exception when check_violation then null;
  end;
  begin
    insert into public.comic_model_uptime_daily (model_id, provider, day, uptime_1d) values ('x/y', 'p', current_date, 120);
    raise exception 'uptime range check missing';
  exception when check_violation then null;
  end;
end $$;

\echo COMIC_IMAGE_CALLS_OK
