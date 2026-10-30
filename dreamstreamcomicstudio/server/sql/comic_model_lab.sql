-- Comic Studio Model Lab (models.md §2.6 D1–D4; wm-plan M1-MODEL-LAB; the Pro pages A/B P1/P2, plan §7): the
-- owner-approved paid checks, run one provider call per explicit admin click from Admin → Model Lab
-- (server/src/comic/models/lab.ts).
--
-- check_id accepts D1–D4 (this file) and P1, P2 (the Pro pages A/B). The A/B checks need
-- server/sql/comic_model_lab_pro_pages.sql applied AFTER this file: it adds comic_model_lab_reserve_ab, the only way
-- an A/B (P1/P2) run row is created. Without it P1/P2 cannot run.
--
-- Two tables and one function here:
--   * comic_model_lab_runs   one row per click: the idempotency key of that click, which check/model ran, the quote
--                            shown in the confirm (reserved against the daily cap BEFORE the call), the provider-reported
--                            cost, and a JSON row of facts (pixel size, file size, latency, provider-reported model
--                            version, watermark yes/no, where the preview is stored). Never a prompt body, an image or
--                            a key. The same call is also written to comic_image_calls (comic_image_calls.sql).
--   * comic_model_lab_votes  the owner's blind-test (D4) votes: one per pair, with which run was shown as A and B.
--   * comic_model_lab_reserve(...)  the ONLY way a D1–D4 run row is created (it refuses P1/P2, which go through
--                            comic_model_lab_reserve_ab in comic_model_lab_pro_pages.sql): under an advisory lock it returns the existing
--                            row for a repeated idempotency key (no second call), refuses when today's spend (UTC) plus
--                            the quote would pass the cap, and otherwise inserts a 'running' row holding the quote.
--                            The cap is min(the server's cap, $2.00): code can lower it, never raise it past $2 a day.
--
-- Access: RLS ON, no client policies, every client privilege revoked; only the service role (the server, after
-- requireAdmin) reads and writes. Idempotent and guarded: safe to re-run. Inspect first:
--   select to_regclass('public.comic_model_lab_runs'), to_regclass('public.comic_model_lab_votes');

do $guard$
begin
  if to_regclass('auth.users') is null then
    raise exception 'comic_model_lab.sql needs auth.users (apply on the Supabase project, not a bare Postgres)';
  end if;
end;
$guard$;

-- ── 1. Runs ──────────────────────────────────────────────────────────────────────────────────

create table if not exists public.comic_model_lab_runs (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  admin_id uuid references auth.users(id) on delete set null,
  check_id text not null,
  item_id text not null,
  model_id text not null,
  provider_model text,
  kind text not null,
  res text,
  aspect text,
  refs smallint not null default 0,
  status text not null default 'running',
  quoted_usd numeric(12, 6) not null,
  cost_usd numeric(12, 6), -- provider-reported; null = not reported (the cap then keeps counting the quote)
  result jsonb not null default '{}'::jsonb,
  day date not null default ((now() at time zone 'utc')::date),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- A table created by an earlier draft converges on the column list above.
alter table public.comic_model_lab_runs add column if not exists idempotency_key text;
alter table public.comic_model_lab_runs add column if not exists admin_id uuid;
alter table public.comic_model_lab_runs add column if not exists check_id text;
alter table public.comic_model_lab_runs add column if not exists item_id text;
alter table public.comic_model_lab_runs add column if not exists model_id text;
alter table public.comic_model_lab_runs add column if not exists provider_model text;
alter table public.comic_model_lab_runs add column if not exists kind text;
alter table public.comic_model_lab_runs add column if not exists res text;
alter table public.comic_model_lab_runs add column if not exists aspect text;
alter table public.comic_model_lab_runs add column if not exists refs smallint not null default 0;
alter table public.comic_model_lab_runs add column if not exists status text not null default 'running';
alter table public.comic_model_lab_runs add column if not exists quoted_usd numeric(12, 6);
alter table public.comic_model_lab_runs add column if not exists cost_usd numeric(12, 6);
alter table public.comic_model_lab_runs add column if not exists result jsonb not null default '{}'::jsonb;
alter table public.comic_model_lab_runs add column if not exists day date not null default ((now() at time zone 'utc')::date);
alter table public.comic_model_lab_runs add column if not exists created_at timestamptz not null default now();
alter table public.comic_model_lab_runs add column if not exists finished_at timestamptz;

-- Checks are (re)declared by name so a re-run converges on the current lists.
alter table public.comic_model_lab_runs drop constraint if exists comic_model_lab_runs_status_check;
alter table public.comic_model_lab_runs add constraint comic_model_lab_runs_status_check
  check (status in ('running', 'ok', 'failed'));
alter table public.comic_model_lab_runs drop constraint if exists comic_model_lab_runs_check_id_check;
alter table public.comic_model_lab_runs add constraint comic_model_lab_runs_check_id_check
  check (check_id in ('D1', 'D2', 'D3', 'D4', 'P1', 'P2')); -- P1/P2: the Pro pages A/B (comic_model_lab_pro_pages.sql)
alter table public.comic_model_lab_runs drop constraint if exists comic_model_lab_runs_quote_check;
alter table public.comic_model_lab_runs add constraint comic_model_lab_runs_quote_check
  check (quoted_usd > 0 and quoted_usd <= 2);
alter table public.comic_model_lab_runs drop constraint if exists comic_model_lab_runs_cost_check;
alter table public.comic_model_lab_runs add constraint comic_model_lab_runs_cost_check
  check (cost_usd is null or cost_usd >= 0);
alter table public.comic_model_lab_runs drop constraint if exists comic_model_lab_runs_key_check;
alter table public.comic_model_lab_runs add constraint comic_model_lab_runs_key_check
  check (idempotency_key ~ '^[A-Za-z0-9_-]{16,80}$');

create unique index if not exists comic_model_lab_runs_key_idx on public.comic_model_lab_runs (idempotency_key);
create index if not exists comic_model_lab_runs_day_idx on public.comic_model_lab_runs (day);
create index if not exists comic_model_lab_runs_created_idx on public.comic_model_lab_runs (created_at desc);

-- ── 2. Blind-test votes (D4) ──────────────────────────────────────────────────────────────────

create table if not exists public.comic_model_lab_votes (
  pair_id text primary key,
  admin_id uuid references auth.users(id) on delete set null,
  pick text not null,
  a_run_id uuid not null references public.comic_model_lab_runs(id) on delete cascade,
  b_run_id uuid not null references public.comic_model_lab_runs(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.comic_model_lab_votes drop constraint if exists comic_model_lab_votes_pick_check;
alter table public.comic_model_lab_votes add constraint comic_model_lab_votes_pick_check
  check (pick in ('A', 'B', 'tie'));
alter table public.comic_model_lab_votes drop constraint if exists comic_model_lab_votes_distinct_check;
alter table public.comic_model_lab_votes add constraint comic_model_lab_votes_distinct_check
  check (a_run_id <> b_run_id);

-- ── 3. Access: service role only ─────────────────────────────────────────────────────────────

alter table public.comic_model_lab_runs enable row level security;
alter table public.comic_model_lab_votes enable row level security;

revoke all on table public.comic_model_lab_runs from public, anon, authenticated;
revoke all on table public.comic_model_lab_votes from public, anon, authenticated;
grant all on table public.comic_model_lab_runs to service_role;
grant all on table public.comic_model_lab_votes to service_role;
-- No policies: with RLS on and no policy, a client role sees and writes nothing even if a grant reappears.

-- ── 4. Reserve: idempotency + the daily cap, atomically ──────────────────────────────────────

drop function if exists public.comic_model_lab_reserve(text, uuid, text, text, text, text, text, text, text, integer, numeric, numeric);
create function public.comic_model_lab_reserve(
  p_key text,
  p_admin uuid,
  p_check text,
  p_item text,
  p_model text,
  p_provider_model text,
  p_kind text,
  p_res text,
  p_aspect text,
  p_refs integer,
  p_quoted numeric,
  p_cap numeric
)
returns table (out_outcome text, out_run_id uuid, out_spent numeric)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_spent numeric;
  v_day date := (now() at time zone 'utc')::date;
  v_cap numeric := least(coalesce(p_cap, 0), 2.00);
begin
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{16,80}$' then
    raise exception 'comic_model_lab_reserve: invalid idempotency key';
  end if;
  if p_quoted is null or p_quoted <= 0 then
    raise exception 'comic_model_lab_reserve: the quote must be positive';
  end if;
  if p_check in ('P1', 'P2') then
    raise exception 'comic_model_lab_reserve: A/B runs reserve through comic_model_lab_reserve_ab';
  end if;

  -- One reservation at a time across every server instance: the key lookup, the sum and the insert are one step.
  perform pg_advisory_xact_lock(hashtext('comic_model_lab_reserve')::bigint);

  select r.id into v_id from public.comic_model_lab_runs r where r.idempotency_key = p_key;
  if v_id is not null then
    return query select 'existing'::text, v_id, null::numeric;
    return;
  end if;

  -- Today's spend: a running call holds its quote; a finished one counts what the provider reported, or the quote
  -- when it reported nothing (never under-count money that may have been spent).
  select coalesce(sum(case when r.status = 'running' then r.quoted_usd else coalesce(r.cost_usd, r.quoted_usd) end), 0)
    into v_spent
    from public.comic_model_lab_runs r
   where r.day = v_day;

  if v_spent + p_quoted > v_cap then
    return query select 'cap'::text, null::uuid, v_spent;
    return;
  end if;

  insert into public.comic_model_lab_runs
    (idempotency_key, admin_id, check_id, item_id, model_id, provider_model, kind, res, aspect, refs, status, quoted_usd, day)
  values
    (p_key, p_admin, p_check, p_item, p_model, p_provider_model, p_kind, p_res, p_aspect, greatest(0, least(coalesce(p_refs, 0), 32)), 'running', p_quoted, v_day)
  returning id into v_id;

  return query select 'reserved'::text, v_id, v_spent + p_quoted;
end;
$$;

revoke all on function public.comic_model_lab_reserve(text, uuid, text, text, text, text, text, text, text, integer, numeric, numeric) from public, anon, authenticated;
grant execute on function public.comic_model_lab_reserve(text, uuid, text, text, text, text, text, text, text, integer, numeric, numeric) to service_role;

-- ── Post-apply checks (read-only) ───────────────────────────────────────────────────────────
-- 1) RLS on, no policies, no client privilege:
--    select relname, relrowsecurity from pg_class where relname in ('comic_model_lab_runs', 'comic_model_lab_votes'); -- true, true
--    select count(*) from pg_policies where tablename in ('comic_model_lab_runs', 'comic_model_lab_votes');           -- 0
--    select grantee, privilege_type from information_schema.role_table_grants
--     where table_name in ('comic_model_lab_runs', 'comic_model_lab_votes') and grantee in ('anon', 'authenticated'); -- 0 rows
-- 2) The reserve function is not callable by clients:
--    select has_function_privilege('authenticated',
--      'public.comic_model_lab_reserve(text, uuid, text, text, text, text, text, text, text, integer, numeric, numeric)', 'execute'); -- false
-- 3) The cap holds even if the server asked for more (run inside a transaction and roll back):
--    begin;
--      select * from public.comic_model_lab_reserve('postapplycheck-0001', null, 'D1', 'probe', 'probe', null, 'page', '1K', '2:3', 0, 1.50, 100);
--      select * from public.comic_model_lab_reserve('postapplycheck-0002', null, 'D1', 'probe', 'probe', null, 'page', '1K', '2:3', 0, 1.00, 100); -- out_outcome = 'cap'
--      select * from public.comic_model_lab_reserve('postapplycheck-0001', null, 'D1', 'probe', 'probe', null, 'page', '1K', '2:3', 0, 1.50, 100); -- out_outcome = 'existing'
--    rollback;
