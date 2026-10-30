-- Comic Studio Model Lab · Pro pages A/B (plan §7, §10 A6 part 1, B11 part 2; decision PD-8): the owner's paid test
-- drawings of three golden pages with the layout guide off and on (part 1, check 'P1'), then the full engine (part 2,
-- check 'P2'). Run one image call + one page check per explicit admin click from Admin → Model Lab
-- (server/src/comic/models/lab.ts), and only while the server-side switch COMIC_LAB_AB_BUDGET_USD is set.
--
-- Apply AFTER server/sql/comic_model_lab.sql. Re-run this file after any re-run of comic_model_lab.sql (that file
-- re-declares the check_id list as D1–D4 only). Idempotent and guarded: safe to re-run. It adds:
--   * 'P1' and 'P2' to comic_model_lab_runs.check_id (A/B votes reuse comic_model_lab_votes, pair ids 'p1-…');
--   * comic_model_lab_reserve_ab(...): the ONLY way an A/B run row is created. Under the SAME advisory lock as
--     comic_model_lab_reserve, it returns the existing row for a repeated idempotency key (no second call), refuses
--     when today's lab spend (UTC, every check) plus the quote would pass the daily cap ('cap'), refuses when the A/B
--     spend so far (P1 and P2, EVERY day) plus the quote would pass the A/B limit ('ab_cap'), and otherwise inserts a
--     'running' row holding the quote. The daily cap is least(p_cap, $2.00) and the A/B limit least(p_ab_cap, $1.20):
--     code can lower either, never raise them.
--
-- Access: unchanged (RLS on, no client policies; service role only). Nothing here reads or changes a comic.

do $guard$
begin
  if to_regclass('public.comic_model_lab_runs') is null then
    raise exception 'comic_model_lab_pro_pages.sql needs public.comic_model_lab_runs: apply server/sql/comic_model_lab.sql first';
  end if;
end;
$guard$;

-- ── 1. Check ids: D1–D4 and the A/B parts ────────────────────────────────────────────────────

alter table public.comic_model_lab_runs drop constraint if exists comic_model_lab_runs_check_id_check;
alter table public.comic_model_lab_runs add constraint comic_model_lab_runs_check_id_check
  check (check_id in ('D1', 'D2', 'D3', 'D4', 'P1', 'P2'));

-- The A/B limit sums every A/B row across days.
create index if not exists comic_model_lab_runs_check_idx on public.comic_model_lab_runs (check_id);

-- ── 2. Reserve an A/B run: idempotency + the daily cap + the A/B limit, atomically ─────────────

drop function if exists public.comic_model_lab_reserve_ab(text, uuid, text, text, text, text, text, text, text, integer, numeric, numeric, numeric);
create function public.comic_model_lab_reserve_ab(
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
  p_cap numeric,
  p_ab_cap numeric
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
  v_ab_spent numeric;
  v_day date := (now() at time zone 'utc')::date;
  v_cap numeric := least(coalesce(p_cap, 0), 2.00);
  v_ab_cap numeric := least(coalesce(p_ab_cap, 0), 1.20);
begin
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{16,80}$' then
    raise exception 'comic_model_lab_reserve_ab: invalid idempotency key';
  end if;
  if p_quoted is null or p_quoted <= 0 then
    raise exception 'comic_model_lab_reserve_ab: the quote must be positive';
  end if;
  if p_check is null or p_check not in ('P1', 'P2') then
    raise exception 'comic_model_lab_reserve_ab: only Pro pages A/B checks (P1, P2) reserve here';
  end if;

  -- The same lock as comic_model_lab_reserve: one reservation at a time across every check and server instance.
  perform pg_advisory_xact_lock(hashtext('comic_model_lab_reserve')::bigint);

  select r.id into v_id from public.comic_model_lab_runs r where r.idempotency_key = p_key;
  if v_id is not null then
    return query select 'existing'::text, v_id, null::numeric;
    return;
  end if;

  -- Spend is counted as everywhere in the lab: a running call holds its quote; a finished one counts what the
  -- provider reported, or the quote when it reported nothing (never under-count money that may have been spent).
  select coalesce(sum(case when r.status = 'running' then r.quoted_usd else coalesce(r.cost_usd, r.quoted_usd) end), 0)
    into v_spent
    from public.comic_model_lab_runs r
   where r.day = v_day;

  if v_spent + p_quoted > v_cap then
    return query select 'cap'::text, null::uuid, v_spent;
    return;
  end if;

  select coalesce(sum(case when r.status = 'running' then r.quoted_usd else coalesce(r.cost_usd, r.quoted_usd) end), 0)
    into v_ab_spent
    from public.comic_model_lab_runs r
   where r.check_id in ('P1', 'P2');

  if v_ab_spent + p_quoted > v_ab_cap then
    return query select 'ab_cap'::text, null::uuid, v_ab_spent;
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

revoke all on function public.comic_model_lab_reserve_ab(text, uuid, text, text, text, text, text, text, text, integer, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.comic_model_lab_reserve_ab(text, uuid, text, text, text, text, text, text, text, integer, numeric, numeric, numeric) to service_role;

-- ── Post-apply checks (read-only) ───────────────────────────────────────────────────────────
-- 1) The check list holds the A/B parts:
--    select pg_get_constraintdef(oid) from pg_constraint where conname = 'comic_model_lab_runs_check_id_check';
--    -- CHECK ((check_id = ANY (ARRAY['D1'::text, 'D2'::text, 'D3'::text, 'D4'::text, 'P1'::text, 'P2'::text])))
-- 2) The reserve function is not callable by clients:
--    select has_function_privilege('authenticated',
--      'public.comic_model_lab_reserve_ab(text, uuid, text, text, text, text, text, text, text, integer, numeric, numeric, numeric)', 'execute'); -- false
-- 3) The A/B limit holds even if the server asked for more, and a D check can't use it (run inside a transaction and roll back):
--    begin;
--      select * from public.comic_model_lab_reserve_ab('postapplyab-00000001', null, 'P1', 'probe', 'probe', null, 'page', '2K', '2:3', 0, 1.00, 2, 100);
--      select * from public.comic_model_lab_reserve_ab('postapplyab-00000002', null, 'P2', 'probe', 'probe', null, 'page', '2K', '2:3', 0, 0.30, 2, 100); -- out_outcome = 'ab_cap' (1.00 + 0.30 > 1.20)
--      select * from public.comic_model_lab_reserve_ab('postapplyab-00000001', null, 'P1', 'probe', 'probe', null, 'page', '2K', '2:3', 0, 1.00, 2, 100); -- out_outcome = 'existing'
--      select * from public.comic_model_lab_reserve_ab('postapplyab-00000003', null, 'D1', 'probe', 'probe', null, 'page', '2K', '2:3', 0, 0.10, 2, 100); -- raises: only P1, P2
--    rollback;
