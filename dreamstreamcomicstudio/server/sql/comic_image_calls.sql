-- Comic Studio per-call image facts (models.md §5.1 M1-CATALOG, §4.5 S7, §2.3 observed price, §2.4 R4, AT-9).
--
-- One row per image call the studio makes (written by the server with the service role: M1-LOCK-SERVER's
-- recording, the admin Model Lab). It is what "your last 4 pages: $0.043–0.054", the 24 h success / 429 rate
-- and the "Most used by DreamStream creators" trend are computed from. Rows hold ids, sizes, outcomes and
-- provider-reported costs — never a prompt, an image or an error body.
--
-- Access:
--   * RLS ON. A signed-in user may SELECT only their own rows; nobody else has a policy.
--   * Inserts, updates and deletes come only from the service role (it bypasses RLS); every client
--     privilege except that owner SELECT is revoked.
--   * Platform aggregates go through the security-definer comic_image_model_stats(p_since), which drops every
--     (model, kind, resolution) group with fewer than 5 distinct users, and reports a cost (median / min / max
--     of the newest ≤ 20 priced calls, with that n) only when those calls come from at least 5 distinct users.
--     Executable by the service role only.
--   * Retention: 180 days (purge_comic_image_calls(), daily through pg_cron when it is installed).
--
-- Idempotent and guarded: safe to re-run; columns and named checks converge on this file. Apply BEFORE the
-- server that writes it (harmless earlier). Inspect first:
--   select column_name, data_type from information_schema.columns where table_name = 'comic_image_calls';

do $guard$
begin
  if to_regclass('auth.users') is null then
    raise exception 'comic_image_calls.sql needs auth.users (apply on the Supabase project, not a bare Postgres)';
  end if;
end;
$guard$;

-- ── 1. Table ─────────────────────────────────────────────────────────────────────────────────

create table if not exists public.comic_image_calls (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid,
  model_id text,
  provider_model text,
  route text,
  provider_name text,
  kind text,
  res text,
  aspect text,
  refs smallint,
  outcome text,
  http_status smallint,
  error_code text,
  provider_cost_usd numeric(12, 6), -- null = the provider did not report a cost
  billed_usd numeric(12, 6),
  byok boolean,
  latency_ms int,
  created_at timestamptz not null default now()
);

-- A table created by an earlier draft converges on the column list above.
alter table public.comic_image_calls add column if not exists project_id uuid;
alter table public.comic_image_calls add column if not exists model_id text;
alter table public.comic_image_calls add column if not exists provider_model text;
alter table public.comic_image_calls add column if not exists route text;
alter table public.comic_image_calls add column if not exists provider_name text;
alter table public.comic_image_calls add column if not exists kind text;
alter table public.comic_image_calls add column if not exists res text;
alter table public.comic_image_calls add column if not exists aspect text;
alter table public.comic_image_calls add column if not exists refs smallint;
alter table public.comic_image_calls add column if not exists outcome text;
alter table public.comic_image_calls add column if not exists http_status smallint;
alter table public.comic_image_calls add column if not exists error_code text;
alter table public.comic_image_calls add column if not exists provider_cost_usd numeric(12, 6);
alter table public.comic_image_calls add column if not exists billed_usd numeric(12, 6);
alter table public.comic_image_calls add column if not exists byok boolean;
alter table public.comic_image_calls add column if not exists latency_ms int;
alter table public.comic_image_calls add column if not exists created_at timestamptz not null default now();

-- Checks are (re)declared by name so a re-run converges on the current lists.
alter table public.comic_image_calls drop constraint if exists comic_image_calls_route_check;
alter table public.comic_image_calls add constraint comic_image_calls_route_check
  check (route in ('openrouter', 'gemini'));
alter table public.comic_image_calls drop constraint if exists comic_image_calls_outcome_check;
alter table public.comic_image_calls add constraint comic_image_calls_outcome_check
  check (outcome in ('ok', 'failed', 'blocked'));

create index if not exists comic_image_calls_model_created_idx on public.comic_image_calls (model_id, created_at desc);
create index if not exists comic_image_calls_user_created_idx on public.comic_image_calls (user_id, created_at desc);
-- The platform aggregate and the retention purge filter on created_at alone (across all users and models).
create index if not exists comic_image_calls_created_idx on public.comic_image_calls (created_at);

-- ── 2. Access: owner SELECT, service-role writes ────────────────────────────────────────────

alter table public.comic_image_calls enable row level security;

revoke all on table public.comic_image_calls from public, anon, authenticated;
grant select on table public.comic_image_calls to authenticated;
grant all on table public.comic_image_calls to service_role;
do $seq$
begin
  execute 'revoke all on sequence public.comic_image_calls_id_seq from public, anon, authenticated';
  execute 'grant usage, select on sequence public.comic_image_calls_id_seq to service_role';
exception when undefined_table then
  raise notice 'comic_image_calls_id_seq not found; nothing to revoke';
end;
$seq$;

drop policy if exists comic_image_calls_select_own on public.comic_image_calls;
create policy comic_image_calls_select_own
  on public.comic_image_calls for select
  to authenticated
  using (auth.uid() = user_id);

-- ── 3. Platform aggregate (≥ 5 distinct users per group) ─────────────────────────────────────

drop function if exists public.comic_image_model_stats(timestamptz);
-- Per (model, kind, resolution) since p_since (never past the 180-day retention):
--   calls / ok / failed / rate_limited / distinct_users  — counts over every call that reached a provider;
--   priced_calls                                         — ok calls with a provider-reported cost;
--   cost_n, median / min / max, cost_from / cost_to      — over the NEWEST ≤ 20 priced calls of the group
--                                                          (models.md §2.3 "the last ≤ 20 calls"), and only
--                                                          when those ≤ 20 calls come from ≥ 5 distinct users.
-- Groups with fewer than 5 distinct users are not returned at all.
create function public.comic_image_model_stats(p_since timestamptz)
returns table (
  model_id text,
  kind text,
  res text,
  calls bigint,
  ok bigint,
  failed bigint,
  rate_limited bigint,
  distinct_users bigint,
  priced_calls bigint,
  cost_n bigint,
  median_cost_usd numeric,
  min_cost_usd numeric,
  max_cost_usd numeric,
  cost_from timestamptz,
  cost_to timestamptz,
  first_at timestamptz,
  last_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with scoped as (
    select c.*
      from public.comic_image_calls c
     where c.created_at >= greatest(coalesce(p_since, now() - interval '180 days'), now() - interval '180 days')
       and c.outcome in ('ok', 'failed') -- 'blocked' never reached a provider
       and c.model_id is not null
  ), grouped as (
    select s.model_id,
           s.kind,
           s.res,
           count(*) as calls,
           count(*) filter (where s.outcome = 'ok') as ok,
           count(*) filter (where s.outcome = 'failed') as failed,
           count(*) filter (where s.outcome = 'failed' and (s.http_status = 429 or s.error_code = 'RATE_LIMIT')) as rate_limited,
           count(distinct s.user_id) as distinct_users,
           count(*) filter (where s.outcome = 'ok' and s.provider_cost_usd is not null) as priced_calls,
           min(s.created_at) as first_at,
           max(s.created_at) as last_at
      from scoped s
     group by s.model_id, s.kind, s.res
  ), recent as (
    select s.model_id, s.kind, s.res, s.user_id, s.provider_cost_usd, s.created_at,
           row_number() over (partition by s.model_id, s.kind, s.res order by s.created_at desc, s.id desc) as rn
      from scoped s
     where s.outcome = 'ok' and s.provider_cost_usd is not null
  ), costs as (
    select r.model_id,
           r.kind,
           r.res,
           count(*) as cost_n,
           count(distinct r.user_id) as cost_users,
           (percentile_cont(0.5) within group (order by r.provider_cost_usd))::numeric as median_cost,
           min(r.provider_cost_usd) as min_cost,
           max(r.provider_cost_usd) as max_cost,
           min(r.created_at) as cost_from,
           max(r.created_at) as cost_to
      from recent r
     where r.rn <= 20
     group by r.model_id, r.kind, r.res
  )
  select g.model_id,
         g.kind,
         g.res,
         g.calls,
         g.ok,
         g.failed,
         g.rate_limited,
         g.distinct_users,
         g.priced_calls,
         case when c.cost_users >= 5 then c.cost_n end,
         case when c.cost_users >= 5 then round(c.median_cost, 6) end,
         case when c.cost_users >= 5 then c.min_cost end,
         case when c.cost_users >= 5 then c.max_cost end,
         case when c.cost_users >= 5 then c.cost_from end,
         case when c.cost_users >= 5 then c.cost_to end,
         g.first_at,
         g.last_at
    from grouped g
    left join costs c
      on c.model_id = g.model_id and c.kind is not distinct from g.kind and c.res is not distinct from g.res
   where g.distinct_users >= 5
   order by g.calls desc, g.model_id, g.kind, g.res;
$$;

revoke all on function public.comic_image_model_stats(timestamptz) from public, anon, authenticated;
grant execute on function public.comic_image_model_stats(timestamptz) to service_role;

-- ── 4. Retention: 180 days ──────────────────────────────────────────────────────────────────

create or replace function public.purge_comic_image_calls()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with d as (
    delete from public.comic_image_calls where created_at < now() - interval '180 days' returning 1
  )
  select count(*)::int from d;
$$;
revoke all on function public.purge_comic_image_calls() from public, anon, authenticated;
grant execute on function public.purge_comic_image_calls() to service_role;

do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'comic-image-calls-purge-daily';
    perform cron.schedule('comic-image-calls-purge-daily', '41 3 * * *', $job$select public.purge_comic_image_calls();$job$);
  else
    raise notice 'pg_cron not installed; run select public.purge_comic_image_calls(); daily yourself.';
  end if;
exception when undefined_table or undefined_function or invalid_schema_name then
  raise notice 'pg_cron unavailable; schedule purge_comic_image_calls() yourself.';
end;
$do$;

-- ── Post-apply checks (read-only) ───────────────────────────────────────────────────────────
-- 1) RLS on, one owner SELECT policy, no other client privilege:
--    select relrowsecurity from pg_class where relname = 'comic_image_calls';                         -- true
--    select policyname, cmd, roles from pg_policies where tablename = 'comic_image_calls';            -- 1 row, SELECT, {authenticated}
--    select grantee, privilege_type from information_schema.role_table_grants
--     where table_name = 'comic_image_calls' and grantee in ('anon', 'authenticated');                 -- authenticated SELECT only
-- 2) The aggregate is not callable by clients:
--    select has_function_privilege('authenticated', 'public.comic_image_model_stats(timestamptz)', 'execute'); -- false
-- 3) Retention is scheduled:
--    select jobname, schedule from cron.job where jobname = 'comic-image-calls-purge-daily';
