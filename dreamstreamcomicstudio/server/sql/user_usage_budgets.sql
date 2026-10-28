-- Per-user usage budgets (P1-LIMITS, 2026-10-22). Apply with migration name `user_usage_budgets`.
--
-- Owner decision: every non-admin user gets $10 (lifetime, not monthly) of PLATFORM-PAID usage
-- across every studio combined, measured in REAL provider cost (generation_cost_events.
-- provider_cost_usd — not the 1.3x billable figure). BYOK never counts. Admins are exempt (the
-- server never calls the reserve RPC for them). Users only ever see "usage left" as a percent.
--
-- What this file creates (idempotent; safe to re-run):
--   1. public.user_usage_budgets — optional per-user override row (budget, period, exempt,
--      allow_pro). RLS ON with NO client policies and no anon/authenticated grants: users must
--      never read dollar figures. Users without a row get the server's default budget
--      (PLATFORM_ALLOWANCE_DEFAULT_USD, $10) counted over their whole history.
--   2. usage_budget_try_reserve(...) — the ONE atomic pre-spend gate. Per-user advisory lock →
--      resolve budget → spent (SETTLED) + inflight (RESERVED < 20 min) + estimate ≤ budget? →
--      insert the RESERVED cost-event row in the same transaction. Returns percentages only.
--   3. usage_budget_status(...) — read-only status for the server (dollars stay server-side).
--   4. usage_budget_admin_list(...) — admin console listing (served only through requireAdmin).
-- All three functions are SECURITY DEFINER, search_path pinned, EXECUTE for service_role only.
--
-- What counts as spend: generation_cost_events rows of this user with is_byok = false, a
-- reservation_id (i.e. metered through the reserve/settle path) and not flagged
-- metadata.platformPaid (safety checks and the asset library are platform overhead).
-- RESERVED rows older than 20 minutes are ignored, so holds stranded by a container restart
-- can never eat a user's budget.

-- ── 1. Table ────────────────────────────────────────────────────────────────────────────────
create table if not exists public.user_usage_budgets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  budget_usd numeric(10, 4) not null default 10,
  period text not null default 'lifetime',
  period_started_at timestamptz not null default now(),
  exempt boolean not null default false,
  allow_pro boolean not null default false,
  note text,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Columns added after a first apply (re-runs reconcile instead of failing).
alter table public.user_usage_budgets add column if not exists allow_pro boolean not null default false;
alter table public.user_usage_budgets add column if not exists note text;
alter table public.user_usage_budgets add column if not exists updated_by uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_usage_budgets_period_check' and conrelid = 'public.user_usage_budgets'::regclass
  ) then
    alter table public.user_usage_budgets
      add constraint user_usage_budgets_period_check check (period in ('lifetime', 'monthly'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_usage_budgets_budget_check' and conrelid = 'public.user_usage_budgets'::regclass
  ) then
    alter table public.user_usage_budgets
      add constraint user_usage_budgets_budget_check check (budget_usd >= 0 and budget_usd <= 100000);
  end if;
end $$;

alter table public.user_usage_budgets enable row level security;
-- No policies on purpose. Belt and braces: no table privileges for client roles either.
revoke all on table public.user_usage_budgets from public;
revoke all on table public.user_usage_budgets from anon;
revoke all on table public.user_usage_budgets from authenticated;
grant select, insert, update, delete on table public.user_usage_budgets to service_role;

-- The spend sums filter by (user_id, created_at); idx_generation_cost_events_user_created
-- (token_billing_foundation.sql) already serves them. Settle/release update by
-- (reservation_id, user_id); idx_generation_cost_events_reservation serves that.

-- ── 2. Atomic reserve ───────────────────────────────────────────────────────────────────────
create or replace function public.usage_budget_try_reserve(
  p_user_id uuid,
  p_reservation_id text,
  p_estimate_usd numeric,
  p_event jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.user_usage_budgets%rowtype;
  v_has_row boolean := false;
  v_event jsonb := coalesce(p_event, '{}'::jsonb);
  v_reservation uuid;
  v_default numeric;
  v_budget numeric;
  v_since timestamptz;
  v_spent numeric := 0;
  v_inflight numeric := 0;
  v_used numeric := 0;
  v_estimate numeric := greatest(coalesce(p_estimate_usd, 0), 0);
  v_estimated_ct integer := 0;
  v_billable numeric := 0;
  v_pct numeric;
begin
  if p_user_id is null then
    raise exception 'usage_budget_try_reserve: p_user_id is required';
  end if;
  begin
    v_reservation := p_reservation_id::uuid;
  exception when others then
    raise exception 'usage_budget_try_reserve: p_reservation_id must be a uuid';
  end;

  -- One reserve at a time per user: concurrent page renders can never both pass the check.
  perform pg_advisory_xact_lock(hashtextextended('usage_budget:' || p_user_id::text, 0));

  select * into v_row from public.user_usage_budgets where user_id = p_user_id;
  v_has_row := found;

  if v_has_row and v_row.exempt then
    -- `exempt` tells the server this is an admin-granted "no limit" (not merely "no default").
    return jsonb_build_object('governed', false, 'exempt', true, 'allowed', true, 'pct_used', 0, 'pct_left', 100);
  end if;

  if v_has_row then
    v_budget := greatest(v_row.budget_usd, 0);
    v_since := case
      when v_row.period = 'monthly'
        then greatest((date_trunc('month', now() at time zone 'utc') at time zone 'utc'), v_row.period_started_at)
      else v_row.period_started_at
    end;
  else
    begin
      v_default := nullif(v_event->>'default_budget_usd', '')::numeric;
    exception when others then
      v_default := null;
    end;
    -- No row and no positive default → not governed by a budget (the server then keeps the
    -- token wallet's own limits for this user; `exempt:false` says so).
    if v_default is null or v_default <= 0 then
      return jsonb_build_object('governed', false, 'exempt', false, 'allowed', true, 'pct_used', 0, 'pct_left', 100);
    end if;
    v_budget := v_default;
    v_since := '-infinity'::timestamptz;
  end if;

  select
    coalesce(sum(e.provider_cost_usd) filter (where e.status = 'SETTLED'), 0),
    coalesce(sum(e.provider_cost_usd) filter (where e.status = 'RESERVED' and e.created_at > now() - interval '20 minutes'), 0)
  into v_spent, v_inflight
  from public.generation_cost_events e
  where e.user_id = p_user_id
    and e.is_byok = false
    and e.reservation_id is not null
    and e.status in ('SETTLED', 'RESERVED')
    and e.created_at >= v_since
    and coalesce(e.metadata->>'platformPaid', 'false') <> 'true';

  v_used := v_spent + v_inflight;

  if v_estimate > 0 and v_used + v_estimate > v_budget then
    v_pct := case when v_budget <= 0 then 100 else least(100, greatest(0, round((v_used / v_budget) * 100, 1))) end;
    return jsonb_build_object(
      'governed', true,
      'allowed', false,
      'reason', 'USAGE_BUDGET_EXHAUSTED',
      'period', case when v_has_row then v_row.period else 'lifetime' end,
      'pct_used', v_pct,
      'pct_left', 100 - v_pct
    );
  end if;

  begin
    v_estimated_ct := greatest(coalesce(floor(nullif(v_event->>'estimated_ct', '')::numeric)::integer, 0), 0);
  exception when others then
    v_estimated_ct := 0;
  end;
  begin
    v_billable := greatest(coalesce(nullif(v_event->>'billable_usd', '')::numeric, 0), 0);
  exception when others then
    v_billable := 0;
  end;

  insert into public.generation_cost_events (
    id, user_id, project_id, comic_id, operation, stage, provider, model, reservation_id,
    estimated_ct, actual_ct, provider_cost_usd, billable_usd, is_byok, status, metadata, created_at
  ) values (
    gen_random_uuid(),
    p_user_id,
    nullif(v_event->>'project_id', ''),
    coalesce(nullif(v_event->>'comic_id', ''), nullif(v_event->>'project_id', '')),
    left(coalesce(nullif(v_event->>'operation', ''), 'unknown'), 200),
    left(nullif(v_event->>'stage', ''), 120),
    left(coalesce(nullif(v_event->>'provider', ''), 'internal'), 60),
    left(coalesce(nullif(v_event->>'model', ''), 'unknown'), 200),
    v_reservation,
    v_estimated_ct,
    0,
    v_estimate,
    v_billable,
    false,
    'RESERVED',
    -- A metered call is never platform overhead: drop any `platformPaid` flag so caller metadata
    -- can't exclude this row from the user's spend.
    ((case when jsonb_typeof(v_event->'metadata') = 'object' then v_event->'metadata' else '{}'::jsonb end) - 'platformPaid')
      || jsonb_build_object('usageBudget', true),
    now()
  );

  v_used := v_used + v_estimate;
  v_pct := case when v_budget <= 0 then 100 else least(100, greatest(0, round((v_used / v_budget) * 100, 1))) end;
  return jsonb_build_object('governed', true, 'allowed', true, 'pct_used', v_pct, 'pct_left', 100 - v_pct);
end;
$$;

-- ── 3. Read-only status (server-only; dollars never leave the server for users) ─────────────
create or replace function public.usage_budget_status(
  p_user_id uuid,
  p_default numeric default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_row public.user_usage_budgets%rowtype;
  v_has_row boolean := false;
  v_budget numeric;
  v_since timestamptz;
  v_spent numeric := 0;
  v_inflight numeric := 0;
  v_used numeric;
  v_pct numeric;
  v_period text := 'lifetime';
begin
  if p_user_id is null then
    raise exception 'usage_budget_status: p_user_id is required';
  end if;

  select * into v_row from public.user_usage_budgets where user_id = p_user_id;
  v_has_row := found;

  if v_has_row and v_row.exempt then
    return jsonb_build_object(
      'governed', false, 'exempt', true, 'has_row', true, 'allow_pro', v_row.allow_pro,
      'period', v_row.period, 'pct_used', 0, 'pct_left', 100, 'exhausted', false
    );
  end if;

  if v_has_row then
    v_budget := greatest(v_row.budget_usd, 0);
    v_period := v_row.period;
    v_since := case
      when v_row.period = 'monthly'
        then greatest((date_trunc('month', now() at time zone 'utc') at time zone 'utc'), v_row.period_started_at)
      else v_row.period_started_at
    end;
  else
    if p_default is null or p_default <= 0 then
      return jsonb_build_object(
        'governed', false, 'exempt', false, 'has_row', false, 'allow_pro', false,
        'period', 'lifetime', 'pct_used', 0, 'pct_left', 100, 'exhausted', false
      );
    end if;
    v_budget := p_default;
    v_since := '-infinity'::timestamptz;
  end if;

  select
    coalesce(sum(e.provider_cost_usd) filter (where e.status = 'SETTLED'), 0),
    coalesce(sum(e.provider_cost_usd) filter (where e.status = 'RESERVED' and e.created_at > now() - interval '20 minutes'), 0)
  into v_spent, v_inflight
  from public.generation_cost_events e
  where e.user_id = p_user_id
    and e.is_byok = false
    and e.reservation_id is not null
    and e.status in ('SETTLED', 'RESERVED')
    and e.created_at >= v_since
    and coalesce(e.metadata->>'platformPaid', 'false') <> 'true';

  v_used := v_spent + v_inflight;
  v_pct := case when v_budget <= 0 then 100 else least(100, greatest(0, round((v_used / v_budget) * 100, 1))) end;

  return jsonb_build_object(
    'governed', true,
    'exempt', false,
    'has_row', v_has_row,
    'allow_pro', case when v_has_row then v_row.allow_pro else false end,
    'period', v_period,
    'period_started_at', case when v_has_row then v_row.period_started_at else null end,
    'budget_usd', v_budget,
    'spent_usd', v_spent,
    'inflight_usd', v_inflight,
    'pct_used', v_pct,
    'pct_left', 100 - v_pct,
    'exhausted', v_used >= v_budget
  );
end;
$$;

-- ── 4. Admin listing (users with a budget row or any metered platform spend) ─────────────────
create or replace function public.usage_budget_admin_list(
  p_default numeric default 10,
  p_limit integer default 200
)
returns table (
  user_id uuid,
  email text,
  has_row boolean,
  exempt boolean,
  allow_pro boolean,
  budget_usd numeric,
  period text,
  period_started_at timestamptz,
  spent_usd numeric,
  inflight_usd numeric,
  note text,
  updated_at timestamptz,
  last_used_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with candidates as (
    select b.user_id from public.user_usage_budgets b
    union
    select distinct e.user_id
    from public.generation_cost_events e
    where e.is_byok = false
      and e.reservation_id is not null
      and coalesce(e.metadata->>'platformPaid', 'false') <> 'true'
  ),
  resolved as (
    select
      c.user_id,
      (b.user_id is not null) as has_row,
      coalesce(b.exempt, false) as exempt,
      coalesce(b.allow_pro, false) as allow_pro,
      coalesce(b.budget_usd, greatest(coalesce(p_default, 0), 0)) as budget_usd,
      coalesce(b.period, 'lifetime') as period,
      b.period_started_at,
      b.note,
      b.updated_at,
      case
        when b.user_id is null then '-infinity'::timestamptz
        when b.period = 'monthly'
          then greatest((date_trunc('month', now() at time zone 'utc') at time zone 'utc'), b.period_started_at)
        else b.period_started_at
      end as since
    from candidates c
    left join public.user_usage_budgets b on b.user_id = c.user_id
  )
  select
    r.user_id,
    u.email::text,
    r.has_row,
    r.exempt,
    r.allow_pro,
    r.budget_usd,
    r.period,
    r.period_started_at,
    coalesce(s.spent, 0) as spent_usd,
    coalesce(s.inflight, 0) as inflight_usd,
    r.note,
    r.updated_at,
    s.last_used_at
  from resolved r
  left join auth.users u on u.id = r.user_id
  left join lateral (
    select
      sum(e.provider_cost_usd) filter (where e.status = 'SETTLED') as spent,
      sum(e.provider_cost_usd) filter (where e.status = 'RESERVED' and e.created_at > now() - interval '20 minutes') as inflight,
      max(e.created_at) as last_used_at
    from public.generation_cost_events e
    where e.user_id = r.user_id
      and e.is_byok = false
      and e.reservation_id is not null
      and e.status in ('SETTLED', 'RESERVED')
      and e.created_at >= r.since
      and coalesce(e.metadata->>'platformPaid', 'false') <> 'true'
  ) s on true
  order by
    case when r.budget_usd > 0 then coalesce(s.spent, 0) / r.budget_usd else 0 end desc,
    s.last_used_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;

-- ── 5. Lock the functions to the server (service role) ──────────────────────────────────────
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('usage_budget_try_reserve', 'usage_budget_status', 'usage_budget_admin_list')
  loop
    execute format('revoke execute on function %s from public', r.fn);
    execute format('revoke execute on function %s from anon', r.fn);
    execute format('revoke execute on function %s from authenticated', r.fn);
    execute format('grant execute on function %s to service_role', r.fn);
  end loop;
end $$;

-- ── Post-apply checks (read-only; run by hand) ──────────────────────────────────────────────
-- select has_function_privilege('authenticated', 'public.usage_budget_try_reserve(uuid,text,numeric,jsonb)', 'execute'); -- false
-- select has_table_privilege('authenticated', 'public.user_usage_budgets', 'select');                                  -- false
-- select public.usage_budget_status('17933bae-dcc5-49b9-bcf5-9658e3953a84', 10);                                     -- governed, pct
-- Metering integrity: clients must not be able to read or write cost events. After
-- billing_ledger_client_lockdown.sql NO client policy or grant may exist on generation_cost_events
-- (the ledger is service-role only; usage_budget_status is the client's only window) — expect zero rows:
-- select policyname, cmd, roles from pg_policies where schemaname = 'public' and tablename = 'generation_cost_events';
-- select grantee, privilege_type from information_schema.role_table_grants where table_name = 'generation_cost_events' and grantee in ('anon', 'authenticated');
-- Stranded holds (ignored by the budget after 20 min; safe to mark released):
-- select count(*) from public.generation_cost_events where status = 'RESERVED' and created_at < now() - interval '20 minutes';
