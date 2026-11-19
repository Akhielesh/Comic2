-- house_comics.sql (daily house comics, package DC-H2) on a throwaway Postgres with a stand-in for public.projects.
-- Synthetic data only: made-up ids, model names and amounts.
--   * the file applies twice (idempotent), and again with data in place without resetting the config row;
--   * RLS is on with no policies on all four tables; anon and authenticated hold no privilege on any table and
--     cannot execute any house function; the service role can do both; the functions are plain (not SECURITY
--     DEFINER) with a pinned search_path;
--   * the CHECKs hold the compiled ceilings ($7 per comic, 10 comics and $70 a day, 2 image slots, payer budgets),
--     the lists (modes, statuses, stages, payers, held reasons) and the run day (a comic and its spend always carry
--     their run's day);
--   * house_reserve refuses at every cap boundary (comic, finishing reserve, run day, payer day, runway-adjusted
--     payer day, credit expiry, lifetime stop), refuses a rehearsal any estimate above 0, refuses when switched off,
--     and raises on bad input (the server then refuses: fail closed);
--   * a hold older than 15 minutes expires, is counted as spent and is never released; a late settle never books less
--     (settle runs the expiry itself);
--   * settle books the served payer, moves the amount, books a BYOK fee row in the same step and says when a cap is
--     now passed; a platform row stays platform;
--   * the day is the run's day (p_day), never now(): a step after midnight for yesterday's run counts against
--     yesterday;
--   * one money decision at a time: a second session's reserve waits for this one's reserve, settle or release
--     (the house_config row lock) and then sees it, so two sessions can never pass a cap together (dblink).
\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- Like Supabase: new tables in public are granted to the API roles unless revoked.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

-- ── Stand-in for the production table this file references ─────────────────────────────────────────────────────
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  name text
);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000a001', 'house@example.com'),
  ('00000000-0000-4000-8000-00000000a002', 'admin@example.com');
insert into public.projects (id, user_id, name) values
  ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000a001', 'House comic one'),
  ('00000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000a001', 'House comic two');

\ir ../house_comics.sql
\ir ../house_comics_grants.sql
\ir ../house_comics.sql
\ir ../house_comics_grants.sql

-- ── Test helpers (schema t; plain SECURITY INVOKER functions, so they run with the caller's rights) ─────────────
create schema t;
grant usage on schema t to public;

-- The error a statement raises (its SQLSTATE), or null when it runs. A statement that runs keeps its effect.
create function t.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;

-- Loose caps everywhere, so each section can test one cap at a time.
create function t.loose() returns void language sql as $$
  update public.house_config
     set enabled = true, mode = 'daily', daily_count = 10, cap_comic_usd = 7, finish_reserve_usd = 0.40, cap_day_usd = 70,
         payers = '{"openai_credit":    {"day_cap_usd": 70, "credit_usd": 5000, "stop_fraction": 0.95, "runway_until": null, "expires_on": null},
                    "anthropic_credit": {"day_cap_usd": 70, "credit_usd": 5000, "stop_fraction": 0.95, "runway_until": null, "expires_on": null},
                    "house_openrouter": {"day_cap_usd": 70, "credit_usd": null, "stop_fraction": 0.90, "runway_until": null, "expires_on": null}}'::jsonb
   where id = 1;
$$;

-- An empty ledger (no spend, comics or runs) and loose caps.
create function t.reset() returns void language plpgsql as $$
begin
  delete from public.house_spend;
  delete from public.house_comics;
  delete from public.house_runs;
  perform t.loose();
end $$;

-- One payer's settings.
create function t.payer(p_payer text, p_patch jsonb) returns void language sql as $$
  update public.house_config set payers = jsonb_set(payers, array[p_payer], (payers -> p_payer) || p_patch) where id = 1;
$$;

-- A new comic in the next free slot of the day's run (the run is created on first use).
create function t.comic(p_day date, p_mode text default 'daily') returns uuid language plpgsql as $$
declare
  v_run uuid;
  v_slot int;
  v_id uuid;
begin
  insert into public.house_runs (day, mode, started_by) values (p_day, p_mode, 'admin') on conflict (day) do nothing;
  select id into v_run from public.house_runs where day = p_day;
  select coalesce(max(slot), 0) + 1 into v_slot from public.house_comics where run_id = v_run;
  insert into public.house_comics (run_id, day, slot, stage, status) values (v_run, p_day, v_slot, 'pages', 'running')
  returning id into v_id;
  return v_id;
end $$;

-- house_reserve for a comic, on its own run and day.
create function t.reserve(p_comic uuid, p_payer text, p_est numeric, p_finishing boolean default false) returns jsonb
language sql as $$
  select public.house_reserve(c.id, c.run_id, c.day, p_payer, 'openrouter',
           case p_payer when 'openai_credit' then 'openai/test-image-model'
                        when 'anthropic_credit' then 'anthropic/test-text-model'
                        else 'google/test-image-model' end,
           'page', p_est, p_finishing)
    from public.house_comics c where c.id = p_comic
$$;

create function t.ok(j jsonb) returns boolean language sql immutable as $$ select coalesce((j ->> 'ok')::boolean, false) $$;
create function t.sid(j jsonb) returns uuid language sql immutable as $$ select (j ->> 'spend_id')::uuid $$;
create function t.num(j jsonb, k text) returns numeric language sql immutable as $$ select (j ->> k)::numeric $$;

-- ── 1. Catalogue: tables, RLS, privileges, functions, defaults, indexes ─────────────────────────────────────────
do $$
declare
  tbl text;
  r text;
  f regprocedure;
  n int;
  c public.house_config;
begin
  foreach tbl in array array['public.house_config', 'public.house_runs', 'public.house_comics', 'public.house_spend'] loop
    assert to_regclass(tbl) is not null, tbl || ' exists';
    assert (select relrowsecurity from pg_class where oid = tbl::regclass), tbl || ': RLS on';
    assert not exists (select 1 from pg_policies where schemaname = 'public' and format('public.%I', tablename) = tbl), tbl || ': no policies';
    foreach r in array array['anon', 'authenticated'] loop
      assert not has_table_privilege(r, tbl, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'), r || ' has a privilege on ' || tbl;
      assert not has_any_column_privilege(r, tbl, 'SELECT, INSERT, UPDATE, REFERENCES'), r || ' has a column privilege on ' || tbl;
    end loop;
    assert has_table_privilege('service_role', tbl, 'SELECT'), 'the server reads ' || tbl;
    assert has_table_privilege('service_role', tbl, 'INSERT'), 'the server inserts into ' || tbl;
    assert has_table_privilege('service_role', tbl, 'UPDATE'), 'the server updates ' || tbl;
  end loop;

  -- Every house function: no client execute, plain (not SECURITY DEFINER), search_path pinned, one of each.
  n := 0;
  for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'house\_%' loop
    n := n + 1;
    assert not has_function_privilege('anon', f, 'EXECUTE'), 'anon executes ' || f::text;
    assert not has_function_privilege('authenticated', f, 'EXECUTE'), 'authenticated executes ' || f::text;
    assert not (select prosecdef from pg_proc where oid = f), f::text || ' must not be SECURITY DEFINER';
    assert exists (select 1 from pg_proc p, unnest(coalesce(p.proconfig, '{}')) cfg where p.oid = f and cfg like 'search_path=%'),
      f::text || ' pins its search_path';
  end loop;
  assert n = 7, format('seven house functions, no stray overloads (found %s)', n);
  assert has_function_privilege('service_role', 'public.house_reserve(uuid, uuid, date, text, text, text, text, numeric, boolean)', 'EXECUTE'), 'service_role reserves';
  assert has_function_privilege('service_role', 'public.house_settle(uuid, numeric, text, text, numeric)', 'EXECUTE'), 'service_role settles';
  assert has_function_privilege('service_role', 'public.house_release(uuid)', 'EXECUTE'), 'service_role releases';
  assert has_function_privilege('service_role', 'public.house_expire_holds()', 'EXECUTE'), 'service_role expires holds';
  assert has_function_privilege('service_role', 'public.house_payers_ok(jsonb)', 'EXECUTE'), 'service_role passes the payers CHECK';

  -- The single config row, switched off, with the spec's defaults.
  assert (select count(*) from public.house_config) = 1, 'one config row';
  select * into c from public.house_config;
  assert c.id = 1 and not c.enabled and c.mode = 'off', 'switched off by default';
  assert c.daily_count = 3 and c.cap_comic_usd = 7 and c.finish_reserve_usd = 0.40 and c.cap_day_usd = 30, 'default caps';
  assert c.image_slots = 2 and not c.allow_4k and c.release_per_day = 2 and c.model_weights = '{}'::jsonb, 'default slots, 4K, releases, weights';
  assert c.house_user_id is null, 'no house account until start sets it';
  assert (c.payers -> 'openai_credit' ->> 'day_cap_usd')::numeric = 12 and (c.payers -> 'openai_credit' ->> 'credit_usd')::numeric = 200
     and (c.payers -> 'openai_credit' ->> 'stop_fraction')::numeric = 0.90, 'OpenAI credit defaults';
  assert (c.payers -> 'anthropic_credit' ->> 'day_cap_usd')::numeric = 5 and (c.payers -> 'anthropic_credit' ->> 'credit_usd')::numeric = 200,
    'Anthropic credit defaults';
  assert (c.payers -> 'house_openrouter' ->> 'day_cap_usd')::numeric = 10 and jsonb_typeof(c.payers -> 'house_openrouter' -> 'credit_usd') = 'null',
    'house OpenRouter: $10 a day, no credit stop (its key has its own daily limit)';
  assert not (c.payers ? 'platform'), 'the platform payer is never capped here';

  foreach r in array array['house_spend_day_payer_idx', 'house_spend_comic_idx', 'house_spend_payer_day_idx', 'house_spend_pending_idx',
                           'house_comics_day_idx', 'house_comics_project_key'] loop
    assert exists (select 1 from pg_indexes where schemaname = 'public' and indexname = r), 'index ' || r;
  end loop;
  assert exists (select 1 from pg_indexes where indexname = 'house_spend_day_payer_idx' and indexdef like '%(day, payer)%'), 'spend (day, payer)';
  assert exists (select 1 from pg_indexes where indexname = 'house_spend_payer_day_idx'
                 and indexdef like '%(payer, day) INCLUDE (status, est_usd, cost_usd)%'), 'spend (payer, day) covering the lifetime sums';
end $$;

-- The grants file alone gives the service role its rights (whatever the platform's default privileges are).
revoke all on table public.house_config, public.house_runs, public.house_comics, public.house_spend from service_role;
revoke all on function public.house_payers_ok(jsonb), public.house_expire_holds(),
  public.house_cap_refusal(public.house_config, uuid, date, text, numeric, boolean),
  public.house_reserve(uuid, uuid, date, text, text, text, text, numeric, boolean),
  public.house_settle(uuid, numeric, text, text, numeric), public.house_release(uuid) from service_role;
do $$
begin
  assert not has_table_privilege('service_role', 'public.house_spend', 'INSERT'), 'revoked for the check below';
  assert not has_function_privilege('service_role', 'public.house_reserve(uuid, uuid, date, text, text, text, text, numeric, boolean)', 'EXECUTE'),
    'revoked for the check below';
end $$;
\ir ../house_comics_grants.sql
do $$
declare
  tbl text;
  f text;
begin
  foreach tbl in array array['public.house_config', 'public.house_runs', 'public.house_comics', 'public.house_spend'] loop
    assert has_table_privilege('service_role', tbl, 'SELECT, INSERT, UPDATE, DELETE'), 'the grants file gives the server ' || tbl;
  end loop;
  foreach f in array array['public.house_payers_ok(jsonb)', 'public.house_expire_holds()',
                           'public.house_cap_refusal(public.house_config, uuid, date, text, numeric, boolean)',
                           'public.house_reserve(uuid, uuid, date, text, text, text, text, numeric, boolean)',
                           'public.house_settle(uuid, numeric, text, text, numeric)', 'public.house_release(uuid)'] loop
    assert has_function_privilege('service_role', f, 'EXECUTE'), 'the grants file gives the server ' || f;
  end loop;
  assert not has_table_privilege('anon', 'public.house_spend', 'SELECT') and not has_table_privilege('authenticated', 'public.house_spend', 'SELECT'),
    'the grants file gives clients nothing';
end $$;

-- ── 2. Ceilings and lists (CHECKs; the $7 per comic ceiling is one of them) ────────────────────────────────────
do $$
declare
  v_run uuid;
  v_other uuid;
  v_comic uuid;
begin
  -- house_config: the compiled ceilings.
  assert t.err('update public.house_config set cap_comic_usd = 7.01') = '23514', 'cap_comic_usd 7.01 is refused';
  assert t.err('update public.house_config set cap_comic_usd = 7') is null, 'cap_comic_usd 7 is allowed';
  assert t.err('update public.house_config set cap_comic_usd = 0') = '23514', 'cap_comic_usd 0 is refused';
  assert t.err('update public.house_config set daily_count = 11') = '23514', 'daily_count 11 is refused';
  assert t.err('update public.house_config set daily_count = 10') is null, 'daily_count 10 is allowed';
  assert t.err('update public.house_config set daily_count = 0') = '23514', 'daily_count 0 is refused';
  assert t.err('update public.house_config set cap_day_usd = 70.01') = '23514', 'cap_day_usd 70.01 is refused';
  assert t.err('update public.house_config set cap_day_usd = 70') is null, 'cap_day_usd 70 is allowed';
  assert t.err('update public.house_config set image_slots = 3') = '23514', 'image_slots 3 is refused';
  assert t.err('update public.house_config set image_slots = 0') = '23514', 'image_slots 0 is refused';
  assert t.err('update public.house_config set release_per_day = 11') = '23514', 'release_per_day 11 is refused';
  assert t.err('update public.house_config set release_per_day = -1') = '23514', 'release_per_day -1 is refused';
  assert t.err('update public.house_config set finish_reserve_usd = 7') = '23514', 'the finishing reserve stays below the comic cap';
  assert t.err('update public.house_config set finish_reserve_usd = 2.01') = '23514', 'finishing reserve above $2 is refused';
  assert t.err('update public.house_config set finish_reserve_usd = -0.01') = '23514', 'a negative finishing reserve is refused';
  assert t.err('update public.house_config set mode = ''turbo''') = '23514', 'an unknown mode is refused';
  assert t.err('update public.house_config set model_weights = ''[]''') = '23514', 'model weights are an object';
  assert t.err('insert into public.house_config (id) values (2)') = '23514', 'one config row only';
  assert t.err('update public.house_config set house_user_id = ''00000000-0000-4000-8000-00000000dead''') = '23503', 'the house account must exist';
  assert t.err('update public.house_config set house_user_id = ''00000000-0000-4000-8000-00000000a001''') is null, 'start sets the house account';

  -- house_config.payers: each capped payer present, its numbers bounded, never the platform payer.
  assert t.err($q$update public.house_config set payers = jsonb_set(payers, '{openai_credit,day_cap_usd}', '70.01')$q$) = '23514', 'payer day cap above $70';
  assert t.err($q$update public.house_config set payers = jsonb_set(payers, '{openai_credit,day_cap_usd}', '-1')$q$) = '23514', 'negative payer day cap';
  assert t.err($q$update public.house_config set payers = jsonb_set(payers, '{openai_credit,day_cap_usd}', '"12"')$q$) = '23514', 'a day cap is a number';
  assert t.err($q$update public.house_config set payers = jsonb_set(payers, '{openai_credit,stop_fraction}', '0.96')$q$) = '23514', 'stop above 95%';
  assert t.err($q$update public.house_config set payers = jsonb_set(payers, '{openai_credit,stop_fraction}', '0')$q$) = '23514', 'stop of 0';
  assert t.err($q$update public.house_config set payers = jsonb_set(payers, '{openai_credit,credit_usd}', '5000.01')$q$) = '23514', 'credit above $5,000';
  assert t.err($q$update public.house_config set payers = payers #- '{openai_credit,credit_usd}'$q$) = '23514', 'the credit is stated (null = none)';
  assert t.err($q$update public.house_config set payers = jsonb_set(payers, '{openai_credit,runway_until}', '"2031-13-01"')$q$) = '23514', 'a runway date is a date';
  assert t.err($q$update public.house_config set payers = jsonb_set(payers, '{openai_credit,expires_on}', '20310101')$q$) = '23514', 'an expiry is a date string';
  -- A date that matches the pattern but is not on the calendar: stored, it would make every reserve and settle of the
  -- payer raise (the money functions cast it), so a paid call's settle would be lost.
  assert t.err($q$update public.house_config set payers = jsonb_set(payers, '{house_openrouter,expires_on}', '"2031-02-30"')$q$) = '23514', 'no 30 February';
  assert t.err($q$update public.house_config set payers = jsonb_set(payers, '{house_openrouter,expires_on}', '"2031-04-31"')$q$) = '23514', 'no 31 April';
  assert t.err($q$update public.house_config set payers = jsonb_set(payers, '{anthropic_credit,runway_until}', '"2031-02-29"')$q$) = '23514', 'no 29 February outside a leap year';
  assert t.err($q$update public.house_config set payers = jsonb_set(payers, '{anthropic_credit,runway_until}', '"2032-02-29"')$q$) is null, '29 February of a leap year is allowed';
  assert t.err($q$update public.house_config set payers = jsonb_set(payers, '{anthropic_credit,runway_until}', 'null')$q$) is null, 'and cleared again';
  assert t.err($q$update public.house_config set payers = payers || '{"platform": {"day_cap_usd": 1, "credit_usd": null, "stop_fraction": 0.9}}'$q$) = '23514',
    'the platform payer is never capped here';
  assert t.err($q$update public.house_config set payers = payers - 'house_openrouter'$q$) = '23514', 'every capped payer is present';
  assert t.err($q$update public.house_config set payers = jsonb_set(payers, '{openai_credit,runway_until}', '"2031-02-01"')$q$) is null, 'a runway date is allowed';
  assert t.err($q$update public.house_config set payers = jsonb_set(payers, '{openai_credit,credit_usd}', 'null')$q$) is null, 'no credit stop is allowed';

  -- house_runs.
  insert into public.house_runs (day, mode, started_by) values ('2030-01-01', 'daily', 'schedule') returning id into v_run;
  assert t.err($q$insert into public.house_runs (day, mode, started_by) values ('2030-01-01', 'daily', 'admin')$q$) = '23505', 'one run per day';
  assert t.err($q$insert into public.house_runs (day, mode, started_by) values ('2030-01-02', 'off', 'admin')$q$) = '23514', 'a run never runs in mode off';
  assert t.err($q$insert into public.house_runs (day, mode, started_by) values ('2030-01-02', 'daily', 'cron')$q$) = '23514', 'unknown starter';
  assert t.err($q$insert into public.house_runs (day, mode, started_by, status) values ('2030-01-02', 'daily', 'admin', 'paused')$q$) = '23514', 'unknown run status';
  assert t.err($q$insert into public.house_runs (day, mode, started_by, slots) values ('2030-01-02', 'daily', 'admin', 11)$q$) = '23514', 'at most 10 slots';
  insert into public.house_runs (day, mode, started_by) values ('2030-01-02', 'rehearsal', 'dispatch') returning id into v_other;

  -- house_comics.
  assert t.err(format($q$insert into public.house_comics (run_id, day, slot) values (%L, '2030-01-01', 11)$q$, v_run)) = '23514', 'slot 11 is refused';
  assert t.err(format($q$insert into public.house_comics (run_id, day, slot) values (%L, '2030-01-01', 0)$q$, v_run)) = '23514', 'slot 0 is refused';
  assert t.err(format($q$insert into public.house_comics (run_id, day, slot) values (%L, '2030-01-02', 1)$q$, v_run)) = '23503', 'a comic carries its run''s day';
  insert into public.house_comics (run_id, day, slot, project_id) values (v_run, '2030-01-01', 1, '00000000-0000-4000-8000-00000000b001') returning id into v_comic;
  assert t.err(format($q$insert into public.house_comics (run_id, day, slot) values (%L, '2030-01-01', 1)$q$, v_run)) = '23505', 'one comic per slot';
  assert t.err(format($q$insert into public.house_comics (run_id, day, slot, project_id) values (%L, '2030-01-02', 1, '00000000-0000-4000-8000-00000000b001')$q$, v_other)) = '23505',
    'a project belongs to one house comic';
  assert t.err(format($q$update public.house_comics set status = 'held' where id = %L$q$, v_comic)) = '23514', 'a held comic has a reason';
  assert t.err(format($q$update public.house_comics set status = 'held', held_reason = 'bored' where id = %L$q$, v_comic)) = '23514', 'unknown held reason';
  assert t.err(format($q$update public.house_comics set status = 'held', held_reason = 'gate_budget' where id = %L$q$, v_comic)) is null, 'a gate reason is allowed';
  assert t.err(format($q$update public.house_comics set status = 'held', held_reason = 'payer_cap' where id = %L$q$, v_comic)) is null, 'payer_cap is allowed';
  assert t.err(format($q$update public.house_comics set status = 'finished' where id = %L$q$, v_comic)) = '23514', 'unknown comic status';
  assert t.err(format($q$update public.house_comics set stage = 'drafting' where id = %L$q$, v_comic)) = '23514', 'unknown stage';
  assert t.err(format($q$update public.house_comics set redraws = 3 where id = %L$q$, v_comic)) = '23514', 'at most 2 redraws per comic';
  assert t.err(format($q$update public.house_comics set judgement = 'great' where id = %L$q$, v_comic)) = '23514', 'unknown judgement';
  assert t.err(format($q$update public.house_comics set judgement = 'bar' where id = %L$q$, v_comic)) is null, 'judgement bar is allowed';
  assert t.err(format($q$update public.house_comics set slate = '[]' where id = %L$q$, v_comic)) = '23514', 'the slate is an object';

  -- house_spend: the $7 ceiling per call, the lists, and the run day.
  assert t.err(format($q$insert into public.house_spend (comic_id, run_id, day, payer, est_usd) values (%L, %L, '2030-01-01', 'house_openrouter', 7.01)$q$, v_comic, v_run)) = '23514',
    'one call can never be estimated above the $7 comic ceiling';
  assert t.err(format($q$insert into public.house_spend (comic_id, run_id, day, payer, est_usd) values (%L, %L, '2030-01-01', 'house_openrouter', -0.01)$q$, v_comic, v_run)) = '23514',
    'a negative estimate is refused';
  assert t.err(format($q$insert into public.house_spend (comic_id, run_id, day, payer, est_usd) values (%L, %L, '2030-01-01', 'someone', 1)$q$, v_comic, v_run)) = '23514',
    'unknown payer';
  assert t.err(format($q$insert into public.house_spend (comic_id, run_id, day, payer, est_usd, status, cost_usd) values (%L, %L, '2030-01-01', 'house_openrouter', 1, 'paid', 1)$q$, v_comic, v_run)) = '23514',
    'unknown spend status';
  assert t.err(format($q$insert into public.house_spend (comic_id, run_id, day, payer, est_usd, cost_usd) values (%L, %L, '2030-01-01', 'house_openrouter', 1, 1)$q$, v_comic, v_run)) = '23514',
    'a pending hold has no cost yet';
  assert t.err(format($q$insert into public.house_spend (comic_id, run_id, day, payer, est_usd, status) values (%L, %L, '2030-01-01', 'house_openrouter', 1, 'settled')$q$, v_comic, v_run)) = '23514',
    'a settled row has a cost';
  assert t.err(format($q$insert into public.house_spend (comic_id, run_id, day, payer, est_usd, status, cost_usd) values (%L, %L, '2030-01-01', 'house_openrouter', 1, 'settled', -1)$q$, v_comic, v_run)) = '23514',
    'a negative cost is refused';
  assert t.err(format($q$insert into public.house_spend (comic_id, run_id, day, payer, est_usd) values (%L, %L, '2030-01-02', 'house_openrouter', 1)$q$, v_comic, v_run)) = '23503',
    'spend carries its comic''s run day';
end $$;

-- ── 3. The switch and the mode ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  c uuid;
  j jsonb;
begin
  delete from public.house_comics;
  delete from public.house_runs;
  update public.house_config set enabled = false, mode = 'off' where id = 1;
  c := t.comic('2031-01-05');
  j := t.reserve(c, 'house_openrouter', 0.10);
  assert not t.ok(j) and j ->> 'reason' = 'switched_off', 'switched off by default: ' || j::text;
  update public.house_config set enabled = true, mode = 'off' where id = 1;
  j := t.reserve(c, 'house_openrouter', 0.10);
  assert not t.ok(j) and j ->> 'reason' = 'switched_off', 'mode off refuses: ' || j::text;
  update public.house_config set enabled = false, mode = 'daily' where id = 1;
  j := t.reserve(c, 'house_openrouter', 0.10);
  assert not t.ok(j) and j ->> 'reason' = 'switched_off', 'disabled refuses whatever the mode: ' || j::text;

  update public.house_config set enabled = true, mode = 'rehearsal' where id = 1;
  j := t.reserve(c, 'house_openrouter', 0.01);
  assert not t.ok(j) and j ->> 'reason' = 'rehearsal', 'rehearsal refuses any estimate above 0: ' || j::text;
  j := t.reserve(c, 'house_openrouter', 0);
  assert t.ok(j), 'rehearsal allows a $0 call: ' || j::text;

  -- The run's own frozen mode counts too.
  update public.house_config set mode = 'daily' where id = 1;
  c := t.comic('2031-01-06', 'rehearsal');
  j := t.reserve(c, 'house_openrouter', 0.01);
  assert not t.ok(j) and j ->> 'reason' = 'rehearsal', 'a rehearsal run refuses money even when the config says daily: ' || j::text;

  -- No config row at all: refused (fail closed).
  delete from public.house_config;
  j := t.reserve(c, 'house_openrouter', 0);
  assert not t.ok(j) and j ->> 'reason' = 'switched_off', 'no config row refuses: ' || j::text;
  insert into public.house_config (id) values (1);

  assert (select count(*) from public.house_spend) = 1, 'refusals book nothing; only the $0 rehearsal call is booked';
end $$;

-- ── 4. The comic cap and the finishing reserve, at the boundary ────────────────────────────────────────────────
do $$
declare
  c uuid;
  c2 uuid;
  j jsonb;
begin
  perform t.reset();
  c := t.comic('2031-02-01');
  assert t.ok(t.reserve(c, 'house_openrouter', 6.00)), 'first $6.00';
  assert t.ok(t.reserve(c, 'house_openrouter', 0.60)), 'up to exactly cap − finishing reserve ($6.60)';
  j := t.reserve(c, 'house_openrouter', 0.01);
  assert not t.ok(j) and j ->> 'reason' = 'comic_finish_reserve', 'one cent into the finishing reserve: ' || j::text;
  assert t.num(j, 'limit_usd') = 6.60 and t.num(j, 'total_usd') = 6.60, 'the refusal names the limit and the total: ' || j::text;
  assert t.ok(t.reserve(c, 'house_openrouter', 0.40, true)), 'finishing may use the reserve, up to exactly $7.00';
  j := t.reserve(c, 'house_openrouter', 0.01, true);
  assert not t.ok(j) and j ->> 'reason' = 'comic_cap', 'one cent past $7 is refused even when finishing: ' || j::text;
  assert t.num(j, 'limit_usd') = 7 and t.num(j, 'total_usd') = 7, 'comic cap limit and total: ' || j::text;
  j := t.reserve(c, 'anthropic_credit', 0.01, true);
  assert not t.ok(j) and j ->> 'reason' = 'comic_cap', 'the comic cap counts every payer: ' || j::text;

  -- The cap is per comic: another comic of the same run starts from zero.
  c2 := t.comic('2031-02-01');
  assert t.ok(t.reserve(c2, 'house_openrouter', 6.60)), 'another comic has its own cap';

  -- The console can lower the cap.
  update public.house_config set cap_comic_usd = 5 where id = 1;
  c2 := t.comic('2031-02-01');
  assert t.ok(t.reserve(c2, 'house_openrouter', 4.60)), 'a lowered cap: up to $4.60 before finishing';
  j := t.reserve(c2, 'house_openrouter', 0.01);
  assert not t.ok(j) and j ->> 'reason' = 'comic_finish_reserve' and t.num(j, 'limit_usd') = 4.60, 'a lowered cap holds: ' || j::text;
end $$;

-- The code ceiling holds even without the CHECK (defence in depth): drop the CHECK, store $9, still capped at $7.
alter table public.house_config drop constraint house_config_cap_comic_check;
do $$
declare
  c uuid;
  j jsonb;
begin
  perform t.reset();
  update public.house_config set cap_comic_usd = 9 where id = 1;
  c := t.comic('2031-02-02');
  assert t.ok(t.reserve(c, 'house_openrouter', 7.00, true)), '$7.00 fits';
  j := t.reserve(c, 'house_openrouter', 0.01, true);
  assert not t.ok(j) and j ->> 'reason' = 'comic_cap' and t.num(j, 'limit_usd') = 7, 'the functions never use a comic cap above $7: ' || j::text;
  update public.house_config set cap_comic_usd = 7 where id = 1;
end $$;
-- Applying the file again with data in place restores the CHECK and keeps the config row.
update public.house_config set cap_day_usd = 33 where id = 1;
create temporary table before_reapply as select (select count(*) from public.house_spend) as spend_rows, (select count(*) from public.house_comics) as comics;
\ir ../house_comics.sql
\ir ../house_comics_grants.sql
do $$
begin
  assert exists (select 1 from pg_constraint where conname = 'house_config_cap_comic_check'), 'the $7 CHECK is back';
  assert t.err('update public.house_config set cap_comic_usd = 7.01') = '23514', 'and refuses $7.01 again';
  assert (select cap_day_usd from public.house_config) = 33 and (select enabled from public.house_config), 'the config row is never reset';
  assert (select count(*) from public.house_config) = 1, 'still one config row';
  assert (select spend_rows from before_reapply) = (select count(*) from public.house_spend), 'the ledger is untouched';
  assert (select comics from before_reapply) = (select count(*) from public.house_comics), 'the comics are untouched';
end $$;

-- ── 5. The run day's cap ───────────────────────────────────────────────────────────────────────────────────────
do $$
declare
  a uuid;
  b uuid;
  c uuid;
  ja jsonb;
  j jsonb;
begin
  perform t.reset();
  update public.house_config set cap_day_usd = 10 where id = 1;
  a := t.comic('2031-03-01');
  b := t.comic('2031-03-01');
  ja := t.reserve(a, 'house_openrouter', 6.00, true);
  assert t.ok(ja), 'comic a: $6.00';
  assert t.ok(t.reserve(b, 'anthropic_credit', 4.00, true)), 'comic b: $4.00, the day at exactly $10';
  j := t.reserve(b, 'openai_credit', 0.01, true);
  assert not t.ok(j) and j ->> 'reason' = 'day_cap', 'one cent past the run day''s cap (any payer): ' || j::text;
  assert t.num(j, 'limit_usd') = 10 and t.num(j, 'total_usd') = 10, 'day cap limit and total: ' || j::text;
  c := t.comic('2031-03-02');
  assert t.ok(t.reserve(c, 'house_openrouter', 5.00, true)), 'another run day has its own cap';
  -- A released hold counts nothing.
  assert t.ok(public.house_release(t.sid(ja))), 'release the never-sent call';
  assert t.ok(t.reserve(b, 'house_openrouter', 0.01, true)), 'room again after the release';
end $$;

-- ── 6. The payer's day cap ─────────────────────────────────────────────────────────────────────────────────────
do $$
declare
  a uuid;
  b uuid;
  j jsonb;
begin
  perform t.reset();
  perform t.payer('openai_credit', '{"day_cap_usd": 12}');
  a := t.comic('2031-04-01');
  b := t.comic('2031-04-01');
  assert t.ok(t.reserve(a, 'openai_credit', 7.00, true)), 'OpenAI $7.00';
  assert t.ok(t.reserve(b, 'openai_credit', 5.00, true)), 'OpenAI at exactly its $12 day cap';
  j := t.reserve(b, 'openai_credit', 0.01, true);
  assert not t.ok(j) and j ->> 'reason' = 'payer_day_cap' and j ->> 'payer' = 'openai_credit', 'one cent past the payer''s day: ' || j::text;
  assert t.num(j, 'limit_usd') = 12 and t.num(j, 'total_usd') = 12, 'payer day limit and total: ' || j::text;
  assert t.ok(t.reserve(b, 'house_openrouter', 0.01, true)), 'another payer is not affected';
  assert t.ok(t.reserve(t.comic('2031-04-02'), 'openai_credit', 7.00, true)), 'the next run day starts again';
end $$;

-- ── 7. The runway-adjusted payer day and the credit's expiry ───────────────────────────────────────────────────
do $$
declare
  e0 uuid;
  e1 uuid;
  e2 uuid;
  j jsonb;
begin
  perform t.reset();
  perform t.payer('anthropic_credit', '{"day_cap_usd": 12, "credit_usd": 100, "stop_fraction": 0.9}');
  -- $10 spent on an earlier run day, before the runway date was set: the credit's room is 100 × 0.9 − 10 = $80.
  e0 := t.comic('2031-05-01');
  j := t.reserve(e0, 'anthropic_credit', 7.00, true);
  assert t.ok(public.house_settle(t.sid(j), 7.00)), 'earlier day: $7 settled';
  e0 := t.comic('2031-05-01');
  j := t.reserve(e0, 'anthropic_credit', 3.00, true);
  assert t.ok(public.house_settle(t.sid(j), 3.00)), 'earlier day: $3 settled';
  perform t.payer('anthropic_credit', '{"runway_until": "2031-05-19"}');

  -- On 2031-05-10, 10 days to the runway date (both included): $80 / 10 = $8 a day, under the $12 cap.
  e1 := t.comic('2031-05-10');
  e2 := t.comic('2031-05-10');
  assert t.ok(t.reserve(e1, 'anthropic_credit', 7.00, true)), '$7.00 of the $8 runway day';
  assert t.ok(t.reserve(e2, 'anthropic_credit', 1.00, true)), 'exactly the $8 runway day';
  j := t.reserve(e2, 'anthropic_credit', 0.01, true);
  assert not t.ok(j) and j ->> 'reason' = 'payer_day_cap' and t.num(j, 'limit_usd') = 8, 'one cent past the runway day: ' || j::text;

  -- A credit expiring before the runway date ends the runway there: 4 days left → $20, so the $12 cap rules.
  perform t.payer('anthropic_credit', '{"expires_on": "2031-05-13"}');
  j := t.reserve(e2, 'anthropic_credit', 5.00, true);
  assert not t.ok(j) and j ->> 'reason' = 'payer_day_cap' and t.num(j, 'limit_usd') = 12, 'the expiry shortens the runway: ' || j::text;
  assert t.ok(t.reserve(e2, 'anthropic_credit', 4.00, true)), 'up to exactly $12';

  -- A runway date already past spreads nothing: the whole room, under the day cap.
  perform t.payer('anthropic_credit', '{"runway_until": "2031-05-01", "expires_on": null}');
  j := t.reserve(e2, 'anthropic_credit', 0.01, true);
  assert not t.ok(j) and j ->> 'reason' = 'payer_day_cap' and t.num(j, 'limit_usd') = 12, 'a past runway date: ' || j::text;

  -- The credit is usable on its expiry day, not after.
  perform t.payer('anthropic_credit', '{"runway_until": null, "expires_on": "2031-05-11", "day_cap_usd": 70}');
  assert t.ok(t.reserve(t.comic('2031-05-11'), 'anthropic_credit', 0.01, true)), 'usable on the expiry day';
  j := t.reserve(t.comic('2031-05-12'), 'anthropic_credit', 0.01, true);
  assert not t.ok(j) and j ->> 'reason' = 'payer_expired' and j ->> 'payer' = 'anthropic_credit', 'refused after the expiry day: ' || j::text;
end $$;

-- ── 8. The lifetime credit stop ────────────────────────────────────────────────────────────────────────────────
do $$
declare
  h0 uuid;
  h1 uuid;
  j jsonb;
begin
  perform t.reset();
  perform t.payer('openai_credit', '{"credit_usd": 200, "stop_fraction": 0.9}');
  -- $175 already spent on an earlier run day (seeded straight into the ledger).
  h0 := t.comic('2031-06-01');
  insert into public.house_spend (comic_id, run_id, day, payer, est_usd, cost_usd, status, settled_at)
  select c.id, c.run_id, c.day, 'openai_credit', 7, 175, 'settled', now() from public.house_comics c where c.id = h0;

  h1 := t.comic('2031-06-02');
  assert t.ok(t.reserve(h1, 'openai_credit', 5.00, true)), 'up to exactly the stop: 200 × 0.9 = $180';
  j := t.reserve(h1, 'openai_credit', 0.01, true);
  assert not t.ok(j) and j ->> 'reason' = 'payer_stop' and j ->> 'payer' = 'openai_credit', 'one cent past the stop: ' || j::text;
  assert t.num(j, 'limit_usd') = 180 and t.num(j, 'total_usd') = 180, 'stop limit and lifetime total (pending holds count): ' || j::text;
  assert t.ok(t.reserve(h1, 'house_openrouter', 0.01, true)), 'the house OpenRouter payer has no credit stop';
end $$;

-- ── 9. Hold expiry: counted as spent, never released ───────────────────────────────────────────────────────────
do $$
declare
  i1 uuid;
  i3 uuid;
  s1 uuid;
  s2 uuid;
  s3 uuid;
  j jsonb;
  r public.house_spend;
begin
  perform t.reset();
  i1 := t.comic('2031-07-01');
  s1 := t.sid(t.reserve(i1, 'house_openrouter', 1.00));
  update public.house_spend set reserved_at = now() - interval '14 minutes' where id = s1;
  assert t.ok(public.house_release(s1)), 'a 14-minute-old hold can still be released';
  select * into r from public.house_spend where id = s1;
  assert r.status = 'released' and r.cost_usd = 0, 'released at $0';

  s2 := t.sid(t.reserve(i1, 'house_openrouter', 1.00));
  update public.house_spend set reserved_at = now() - interval '16 minutes' where id = s2;
  j := public.house_release(s2);
  assert not t.ok(j) and j ->> 'reason' = 'expired', 'a 16-minute-old hold is never released: ' || j::text;
  select * into r from public.house_spend where id = s2;
  assert r.status = 'expired' and r.cost_usd = 1.00, 'expired at its estimate';
  j := public.house_release(s2);
  assert not t.ok(j) and j ->> 'reason' = 'expired', 'and stays expired';
  -- Counted as spent: $1 expired + $6 = the $7 cap.
  assert t.ok(t.reserve(i1, 'house_openrouter', 6.00, true)), 'the expired hold counts: $6.00 more reaches $7';
  j := t.reserve(i1, 'house_openrouter', 0.01, true);
  assert not t.ok(j) and j ->> 'reason' = 'comic_cap', 'the expired dollar is counted: ' || j::text;

  -- Any reserve expires stale holds, on any comic.
  s3 := t.sid(t.reserve(t.comic('2031-07-02'), 'openai_credit', 1.00));
  update public.house_spend set reserved_at = now() - interval '16 minutes' where id = s3;
  i3 := t.comic('2031-07-03');
  j := t.reserve(i3, 'house_openrouter', 0.10);
  assert t.ok(j) and t.num(j, 'expired') >= 1, 'the reserve expired the stale hold: ' || j::text;
  assert (select status from public.house_spend where id = s3) = 'expired', 'stale hold expired';
  assert public.house_expire_holds() = 0, 'nothing left to expire';

  -- A late settle of an expired hold never books less than the hold, and books more when the call cost more.
  j := public.house_settle(s3, 0.25);
  assert t.ok(j) and t.num(j, 'cost_usd') = 1.00, 'late settle keeps the $1 hold: ' || j::text;
  assert (select status from public.house_spend where id = s3) = 'settled', 'and settles it';
  s2 := t.sid(t.reserve(i3, 'house_openrouter', 0.50));
  update public.house_spend set reserved_at = now() - interval '20 minutes' where id = s2;
  j := public.house_settle(s2, 0.80);
  assert t.ok(j) and t.num(j, 'cost_usd') = 0.80, 'a stale hold settled late books the higher actual cost: ' || j::text;

  -- Settle runs the expiry itself: a hold gone stale with no reserve since is still never undercut by a cheaper settle.
  s2 := t.sid(t.reserve(i3, 'house_openrouter', 0.50));
  update public.house_spend set reserved_at = now() - interval '20 minutes' where id = s2;
  assert (select status from public.house_spend where id = s2) = 'pending', 'still pending: nothing has expired it yet';
  j := public.house_settle(s2, 0.20);
  assert t.ok(j) and t.num(j, 'cost_usd') = 0.50, 'settle expired the stale hold first and kept its $0.50: ' || j::text;
  assert (select cost_usd from public.house_spend where id = s2) = 0.50, 'booked at the hold';
end $$;

-- ── 10. Settle: the served payer, the amount moves, `over` when a cap is now passed ────────────────────────────
do $$
declare
  j1 uuid;
  j2 uuid;
  s uuid;
  j jsonb;
  r public.house_spend;
begin
  perform t.reset();
  j1 := t.comic('2031-08-01');
  -- A writer call reserved on the Anthropic credit and served by a Google model lands on the house OpenRouter payer.
  s := t.sid(t.reserve(j1, 'anthropic_credit', 0.50));
  j := public.house_settle(s, 0.60, 'house_openrouter', 'google/test-text-model');
  assert t.ok(j) and j ->> 'payer' = 'house_openrouter' and j ->> 'from_payer' = 'anthropic_credit', 'moved to the served payer: ' || j::text;
  assert t.num(j, 'cost_usd') = 0.60 and not (j ->> 'over')::boolean and j ->> 'over_reason' is null, 'under every cap: ' || j::text;
  select * into r from public.house_spend where id = s;
  assert r.status = 'settled' and r.payer = 'house_openrouter' and r.cost_usd = 0.60 and r.model = 'google/test-text-model' and r.settled_at is not null,
    'the row moved with its amount';
  assert (select coalesce(sum(coalesce(cost_usd, est_usd)), 0) from public.house_spend where payer = 'anthropic_credit') = 0, 'nothing left on the Anthropic credit';

  -- A second settle changes nothing.
  j := public.house_settle(s, 0.10);
  assert not t.ok(j) and j ->> 'reason' = 'already_settled', 'a second settle is refused: ' || j::text;
  assert (select cost_usd from public.house_spend where id = s) = 0.60, 'the cost is unchanged';

  -- A settle that passes the payer's day cap says so, and the next reserve refuses.
  perform t.payer('house_openrouter', '{"day_cap_usd": 1}');
  s := t.sid(t.reserve(j1, 'house_openrouter', 0.30));
  assert s is not null, '0.60 + 0.30 fits the $1 day';
  j := public.house_settle(s, 0.55);
  assert t.ok(j) and (j ->> 'over')::boolean and j ->> 'over_reason' = 'payer_day_cap', 'over the payer day: ' || j::text;
  j := t.reserve(j1, 'house_openrouter', 0.01);
  assert not t.ok(j) and j ->> 'reason' = 'payer_day_cap', 'the next reserve refuses: ' || j::text;

  -- Moved onto a payer that is already past its cap: over.
  s := t.sid(t.reserve(j1, 'anthropic_credit', 0.20));
  j := public.house_settle(s, 0.20, 'house_openrouter');
  assert t.ok(j) and (j ->> 'over')::boolean and j ->> 'over_reason' = 'payer_day_cap', 'moved onto a full payer: ' || j::text;

  -- An actual cost above its hold can pass the comic cap.
  perform t.loose();
  j2 := t.comic('2031-08-01');
  s := t.sid(t.reserve(j2, 'openai_credit', 6.90, true));
  j := public.house_settle(s, 7.20);
  assert t.ok(j) and (j ->> 'over')::boolean and j ->> 'over_reason' = 'comic_cap', 'over the comic cap: ' || j::text;
  -- Settling without a payer keeps the reserved one.
  s := t.sid(t.reserve(t.comic('2031-08-01'), 'openai_credit', 0.10));
  j := public.house_settle(s, 0.10);
  assert t.ok(j) and j ->> 'payer' = 'openai_credit', 'the reserved payer stays: ' || j::text;
  -- A released hold whose call went out after all still books its cost (money spent is never lost).
  s := t.sid(t.reserve(t.comic('2031-08-01'), 'openai_credit', 0.10));
  assert t.ok(public.house_release(s)), 'released';
  j := public.house_settle(s, 0.07);
  assert t.ok(j) and (select status from public.house_spend where id = s) = 'settled' and (select cost_usd from public.house_spend where id = s) = 0.07,
    'a settle after a release books the cost: ' || j::text;

  -- Bad input raises (the server refuses on any error).
  assert t.err(format('select public.house_settle(%L, 0.1, null, null, -0.01)', s)) = 'P0001', 'a negative fee raises';
  assert t.err(format('select public.house_settle(%L, -0.01)', s)) = 'P0001', 'a negative cost raises';
  assert t.err(format('select public.house_settle(%L, null)', s)) = 'P0001', 'a missing cost raises';
  assert t.err(format($q$select public.house_settle(%L, 0.1, 'someone')$q$, s)) = 'P0001', 'an unknown payer raises';
  assert t.err($q$select public.house_settle('00000000-0000-4000-8000-00000000ffff', 0.1)$q$) = 'P0001', 'an unknown row raises';
end $$;

-- ── 10b. The BYOK fee: booked by the settle, in the same step, never refused ───────────────────────────────────
do $$
declare
  c uuid;
  s uuid;
  j jsonb;
  f public.house_spend;
  r public.house_spend;
begin
  perform t.reset();
  c := t.comic('2031-08-05');
  s := t.sid(t.reserve(c, 'openai_credit', 1.00));
  j := public.house_settle(s, 0.80, 'openai_credit', 'openai/test-image-model', 0.04);
  assert t.ok(j) and t.num(j, 'fee_usd') = 0.04 and j ->> 'fee_spend_id' is not null and not (j ->> 'over')::boolean, 'the fee is booked: ' || j::text;
  select * into f from public.house_spend where id = (j ->> 'fee_spend_id')::uuid;
  select * into r from public.house_spend where id = s;
  assert f.payer = 'house_openrouter' and f.status = 'settled' and f.cost_usd = 0.04 and f.est_usd = 0.04 and f.kind = 'byok_fee'
     and f.comic_id = r.comic_id and f.run_id = r.run_id and f.day = r.day and f.model = 'openai/test-image-model' and f.settled_at is not null,
    'one settled house OpenRouter row on the call''s comic, run and day';
  assert r.payer = 'openai_credit' and r.cost_usd = 0.80, 'the call itself stays on its own payer';

  -- A retried settle books no second fee.
  j := public.house_settle(s, 0.80, 'openai_credit', null, 0.04);
  assert not t.ok(j) and j ->> 'reason' = 'already_settled', 'a second settle is refused: ' || j::text;
  assert (select count(*) from public.house_spend where kind = 'byok_fee') = 1, 'one fee row only';

  -- The fee counts in the house caps: 0.84 on the comic, so 5.76 more reaches the finishing line and 5.77 does not.
  j := t.reserve(c, 'house_openrouter', 5.77);
  assert not t.ok(j) and j ->> 'reason' = 'comic_finish_reserve' and t.num(j, 'total_usd') = 0.84, 'the fee counts in the comic cap: ' || j::text;

  -- Never refused at a cap (the money is spent); `over` says when the fee's payer is now past its day.
  perform t.payer('house_openrouter', '{"day_cap_usd": 0.05}');
  s := t.sid(t.reserve(c, 'openai_credit', 0.50));
  j := public.house_settle(s, 0.50, null, null, 0.02);
  assert t.ok(j) and t.num(j, 'fee_usd') = 0.02 and (j ->> 'over')::boolean and j ->> 'over_reason' = 'payer_day_cap',
    'booked past the fee payer''s day cap, and said: ' || j::text;
  assert (select count(*) from public.house_spend where kind = 'byok_fee') = 2, 'the second fee is booked';

  -- No fee, no row.
  s := t.sid(t.reserve(c, 'openai_credit', 0.10));
  j := public.house_settle(s, 0.10, null, null, 0);
  assert t.ok(j) and j ->> 'fee_spend_id' is null and t.num(j, 'fee_usd') = 0, 'a zero fee books nothing: ' || j::text;
  assert (select count(*) from public.house_spend where kind = 'byok_fee') = 2, 'still two fee rows';
end $$;

-- ── 11. The day key is the run's day (p_day), never now() ──────────────────────────────────────────────────────
do $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_yesterday date := (now() at time zone 'utc')::date - 1;
  y1 uuid;
  y2 uuid;
  t1 uuid;
  v_run uuid;
  j jsonb;
begin
  perform t.reset();
  update public.house_config set cap_day_usd = 10 where id = 1;
  -- Yesterday's run filled its day before midnight.
  y1 := t.comic(v_yesterday);
  y2 := t.comic(v_yesterday);
  assert t.ok(t.reserve(y1, 'house_openrouter', 7.00, true)), 'yesterday: $7';
  assert t.ok(t.reserve(y2, 'house_openrouter', 3.00, true)), 'yesterday: $3, the day full';
  -- Now, after midnight, a step of yesterday's run still counts against yesterday.
  j := t.reserve(y2, 'house_openrouter', 0.01, true);
  assert not t.ok(j) and j ->> 'reason' = 'day_cap', 'a step after midnight counts against its own run day: ' || j::text;
  assert (select count(*) from public.house_spend where day <> v_yesterday) = 0, 'every row of yesterday''s run carries yesterday';
  -- Today's run is untouched by yesterday's.
  t1 := t.comic(v_today);
  assert t.ok(t.reserve(t1, 'house_openrouter', 7.00, true)), 'today has its own day';
  -- A step cannot book yesterday's run under today's day.
  select run_id into v_run from public.house_comics where id = y2;
  assert t.err(format($q$select public.house_reserve(%L, %L, %L, 'house_openrouter', 'openrouter', 'google/test-image-model', 'page', 0.01, true)$q$,
                      y2, v_run, v_today)) = 'P0001', 'p_day must be the run''s day';
end $$;

-- ── 12. The platform payer: recorded, never capped, never counted in the house caps ────────────────────────────
do $$
declare
  p1 uuid;
  s uuid;
  j jsonb;
begin
  perform t.reset();
  update public.house_config set cap_day_usd = 10 where id = 1;
  p1 := t.comic('2031-09-01');
  assert t.ok(t.reserve(p1, 'house_openrouter', 6.60)), 'at the finishing line';
  j := t.reserve(p1, 'platform', 5.00);
  assert t.ok(j), 'platform spend is recorded, never capped: ' || j::text;
  s := t.sid(j);
  assert t.ok(t.reserve(p1, 'house_openrouter', 0.40, true)), 'platform spend does not count in the comic cap';
  assert t.ok(t.reserve(t.comic('2031-09-01'), 'house_openrouter', 3.00, true)), 'nor in the run day''s cap';
  -- A platform-key call stays platform whatever the served model's payer is (the billing passes the served model's
  -- payer, which is always a capped one): booked, never moved onto a cap.
  j := public.house_settle(s, 5, 'house_openrouter', 'google/test-text-model');
  assert t.ok(j) and j ->> 'payer' = 'platform' and j ->> 'from_payer' = 'platform' and not (j ->> 'over')::boolean,
    'a platform row settles on platform: ' || j::text;
  assert (select payer from public.house_spend where id = s) = 'platform' and (select cost_usd from public.house_spend where id = s) = 5,
    'the platform cost is booked';
  j := t.reserve(t.comic('2031-09-01'), 'house_openrouter', 0.01, true);
  assert not t.ok(j) and j ->> 'reason' = 'day_cap' and t.num(j, 'total_usd') = 10, 'the settled platform $5 is not in the run day''s total: ' || j::text;
  s := t.sid(t.reserve(t.comic('2031-09-02'), 'house_openrouter', 0.10));
  assert t.err(format($q$select public.house_settle(%L, 0.1, 'platform')$q$, s)) = 'P0001', 'capped spend never moves to the platform payer';
  update public.house_config set enabled = false where id = 1;
  j := t.reserve(p1, 'platform', 0.10);
  assert not t.ok(j) and j ->> 'reason' = 'switched_off', 'the switch stops platform calls too: ' || j::text;
end $$;

-- ── 13. Bad input raises (fail closed) ─────────────────────────────────────────────────────────────────────────
do $$
declare
  c uuid;
  other uuid;
  v_run uuid;
  v_day date;
begin
  perform t.reset();
  c := t.comic('2031-10-01');
  other := t.comic('2031-10-02');
  select run_id, day into v_run, v_day from public.house_comics where id = c;
  assert t.err(format($q$select public.house_reserve(%L, %L, %L, 'house_openrouter', 'openrouter', 'm', 'page', null)$q$, c, v_run, v_day)) = 'P0001', 'no estimate';
  assert t.err(format($q$select public.house_reserve(%L, %L, %L, 'house_openrouter', 'openrouter', 'm', 'page', -0.01)$q$, c, v_run, v_day)) = 'P0001', 'negative estimate';
  assert t.err(format($q$select public.house_reserve(%L, %L, %L, 'someone', 'openrouter', 'm', 'page', 0.01)$q$, c, v_run, v_day)) = 'P0001', 'unknown payer';
  assert t.err(format($q$select public.house_reserve(%L, %L, null, 'house_openrouter', 'openrouter', 'm', 'page', 0.01)$q$, c, v_run)) = 'P0001', 'no day';
  assert t.err(format($q$select public.house_reserve(%L, %L, %L, 'house_openrouter', 'openrouter', 'm', 'page', 0.01)$q$, other, v_run, v_day)) = 'P0001',
    'a comic of another run';
  assert t.err(format($q$select public.house_reserve(%L, '00000000-0000-4000-8000-00000000ffff', %L, 'house_openrouter', 'openrouter', 'm', 'page', 0.01)$q$, c, v_day)) = 'P0001',
    'an unknown run';
  assert t.err($q$select public.house_release('00000000-0000-4000-8000-00000000ffff')$q$) = 'P0001', 'releasing an unknown row';
  assert (select count(*) from public.house_spend) = 0, 'nothing was booked';
end $$;

-- ── 13b. A discarded, purged or skipped comic never spends (a step racing a Discard click) ─────────────────────
do $$
declare
  c uuid;
  s text;
  j jsonb;
begin
  perform t.reset();
  foreach s in array array['discarded', 'purged', 'skipped'] loop
    c := t.comic('2031-10-03');
    update public.house_comics set status = s where id = c;
    j := t.reserve(c, 'house_openrouter', 0.10);
    assert not t.ok(j) and j ->> 'reason' = 'comic_closed', s || ' comics never spend: ' || j::text;
  end loop;
  foreach s in array array['queued', 'running', 'held'] loop
    c := t.comic('2031-10-03');
    update public.house_comics set status = s, held_reason = case when s = 'held' then 'error' end where id = c;
    assert t.ok(t.reserve(c, 'house_openrouter', 0.10)), s || ' comics may spend (a held comic on an admin retry)';
  end loop;
end $$;

-- ── 14. The service role does all of it; the ceilings bind it too ──────────────────────────────────────────────
select t.reset();
set role service_role;
do $$
declare
  c uuid;
  s uuid;
  j jsonb;
begin
  c := t.comic('2031-11-01');
  j := t.reserve(c, 'anthropic_credit', 0.20);
  assert t.ok(j), 'service_role reserves: ' || j::text;
  s := t.sid(j);
  assert t.ok(public.house_settle(s, 0.18, 'anthropic_credit', 'anthropic/test-text-model')), 'service_role settles';
  assert t.ok(public.house_release(t.sid(t.reserve(c, 'house_openrouter', 0.10)))), 'service_role releases';
  assert t.err('update public.house_config set cap_comic_usd = 7.01') = '23514', 'the $7 ceiling binds the service role';
  assert t.err('update public.house_config set daily_count = 11') = '23514', 'the 10-a-day ceiling binds the service role';
  assert t.err($q$update public.house_config set payers = jsonb_set(payers, '{house_openrouter,day_cap_usd}', '9')$q$) is null, 'service_role edits payers';
  perform 1 from public.house_runs;
end $$;
reset role;

-- ── 15. Clients: no read, no write, no execute; RLS is the backstop ────────────────────────────────────────────
set role anon;
do $$ begin perform 1 from public.house_config; raise exception 'anon read house_config'; exception when insufficient_privilege then null; end $$;
do $$ begin perform 1 from public.house_runs; raise exception 'anon read house_runs'; exception when insufficient_privilege then null; end $$;
do $$ begin perform 1 from public.house_comics; raise exception 'anon read house_comics'; exception when insufficient_privilege then null; end $$;
do $$ begin perform 1 from public.house_spend; raise exception 'anon read house_spend'; exception when insufficient_privilege then null; end $$;
do $$ begin update public.house_config set enabled = true; raise exception 'anon wrote house_config'; exception when insufficient_privilege then null; end $$;
do $$ begin
  perform public.house_reserve(null, null, null, 'house_openrouter', null, null, null, 0, false);
  raise exception 'anon executed house_reserve';
exception when insufficient_privilege then null;
end $$;
do $$ begin perform public.house_settle(null, 0); raise exception 'anon executed house_settle'; exception when insufficient_privilege then null; end $$;
do $$ begin perform public.house_release(null); raise exception 'anon executed house_release'; exception when insufficient_privilege then null; end $$;
reset role;

set role authenticated;
do $$ begin perform 1 from public.house_config; raise exception 'authenticated read house_config'; exception when insufficient_privilege then null; end $$;
do $$ begin perform 1 from public.house_runs; raise exception 'authenticated read house_runs'; exception when insufficient_privilege then null; end $$;
do $$ begin perform 1 from public.house_comics; raise exception 'authenticated read house_comics'; exception when insufficient_privilege then null; end $$;
do $$ begin perform 1 from public.house_spend; raise exception 'authenticated read house_spend'; exception when insufficient_privilege then null; end $$;
do $$ begin
  insert into public.house_runs (day, mode, started_by) values ('2032-01-01', 'daily', 'admin');
  raise exception 'authenticated wrote house_runs';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform public.house_reserve(null, null, null, 'house_openrouter', null, null, null, 0, false);
  raise exception 'authenticated executed house_reserve';
exception when insufficient_privilege then null;
end $$;
do $$ begin perform public.house_settle(null, 0); raise exception 'authenticated executed house_settle'; exception when insufficient_privilege then null; end $$;
do $$ begin perform public.house_release(null); raise exception 'authenticated executed house_release'; exception when insufficient_privilege then null; end $$;
do $$ begin perform public.house_expire_holds(); raise exception 'authenticated executed house_expire_holds'; exception when insufficient_privilege then null; end $$;
reset role;

-- A select grant that reappears by mistake still shows a client nothing: RLS on, no policy.
grant select on public.house_spend, public.house_config to authenticated;
set role authenticated;
do $$
begin
  assert (select count(*) from public.house_spend) = 0, 'RLS hides the ledger';
  assert (select count(*) from public.house_config) = 0, 'RLS hides the config';
end $$;
reset role;
revoke select on public.house_spend, public.house_config from authenticated;
do $$ begin assert (select count(*) from public.house_spend) > 0, 'the ledger has rows (the RLS check above was not vacuous)'; end $$;

-- ── 16. updated_at bookkeeping ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  c uuid := t.comic('2031-12-01');
begin
  update public.house_comics set updated_at = '2000-01-01' where id = c;
  assert (select updated_at from public.house_comics where id = c) > '2001-01-01', 'house_comics.updated_at follows every update';
  update public.house_config set updated_at = '2000-01-01' where id = 1;
  assert (select updated_at from public.house_config) > '2001-01-01', 'house_config.updated_at follows every update';
end $$;

-- ── 17. One money decision at a time, across sessions (the house_config row lock) ──────────────────────────────
-- A second session (c2, over dblink) reserves while this session holds the lock in an open transaction. It must wait,
-- then decide on what this session committed. Without the lock both would read the old totals and pass a cap together.
-- Set-up rows are committed in their own statements first: c2 sees only committed rows, and a set-up transaction still
-- open on house_config would block c2 for good. Never read c2's result before this session commits (that would wait on
-- c2 while c2 waits on us).
create extension if not exists dblink with schema t;
create table t.conc (k text primary key, id uuid not null);
create function t.c2_result() returns jsonb language plpgsql as $$
declare
  j jsonb;
begin
  select x.r::jsonb into j from t.dblink_get_result('c2') as x(r text);
  perform 1 from t.dblink_get_result('c2') as x(r text); -- the closing empty result frees the connection
  return j;
end $$;
select t.reset();
insert into t.conc (k, id) values ('a', t.comic('2032-02-01'));
insert into t.conc (k, id) values ('b', t.comic('2032-02-01'));
insert into t.conc (k, id) values ('c', t.comic('2032-02-01'));
insert into t.conc (k, id) select 'b_hold', t.sid(t.reserve((select id from t.conc where k = 'b'), 'house_openrouter', 1.00));
insert into t.conc (k, id) select 'c_hold', t.sid(t.reserve((select id from t.conc where k = 'c'), 'house_openrouter', 6.00));
select t.dblink_connect('c2', format('dbname=%s host=%s port=%s user=%s', current_database(),
                                     split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'), current_user));
select t.dblink_exec('c2', $q$set lock_timeout = '20s'$q$);

-- (a) Reserve against reserve: c1 holds $6.00 on comic a; c2 asks $6.00 more on the same comic.
begin;
do $$ begin assert t.ok(t.reserve((select id from t.conc where k = 'a'), 'house_openrouter', 6.00)), 'c1 reserves $6.00'; end $$;
do $$ begin
  assert t.dblink_send_query('c2', $q$select t.reserve((select id from t.conc where k = 'a'), 'house_openrouter', 6.00)::text$q$) = 1, 'sent';
  perform pg_sleep(0.3);
  assert t.dblink_is_busy('c2') = 1, 'c2''s reserve waits for c1''s';
end $$;
commit;
do $$
declare
  j jsonb := t.c2_result();
begin
  assert not t.ok(j) and j ->> 'reason' = 'comic_cap' and t.num(j, 'limit_usd') = 7 and t.num(j, 'total_usd') = 6,
    'after c1 commits, c2 sees its $6.00 and is refused: ' || j::text;
  assert (select sum(est_usd) from public.house_spend where comic_id = (select id from t.conc where k = 'a')) <= 7, 'the $7 cap holds across sessions';
end $$;

-- (b) Settle against reserve: comic b holds $1.00; c1 settles it at $6.50 while c2 asks $1.00 (finishing) more.
begin;
do $$ begin assert t.ok(public.house_settle((select id from t.conc where k = 'b_hold'), 6.50)), 'c1 settles above the hold'; end $$;
do $$ begin
  assert t.dblink_send_query('c2', $q$select t.reserve((select id from t.conc where k = 'b'), 'house_openrouter', 1.00, true)::text$q$) = 1, 'sent';
  perform pg_sleep(0.3);
  assert t.dblink_is_busy('c2') = 1, 'c2''s reserve waits for c1''s settle';
end $$;
commit;
do $$
declare
  j jsonb := t.c2_result();
begin
  assert not t.ok(j) and j ->> 'reason' = 'comic_cap' and t.num(j, 'total_usd') = 6.50,
    'c2 counts the settled $6.50, not the $1.00 hold: ' || j::text;
end $$;

-- (c) Release against reserve: comic c holds $6.00; c1 releases it while c2 asks $6.00 on the same comic.
begin;
do $$ begin assert t.ok(public.house_release((select id from t.conc where k = 'c_hold'))), 'c1 releases'; end $$;
do $$ begin
  assert t.dblink_send_query('c2', $q$select t.reserve((select id from t.conc where k = 'c'), 'house_openrouter', 6.00)::text$q$) = 1, 'sent';
  perform pg_sleep(0.3);
  assert t.dblink_is_busy('c2') = 1, 'c2''s reserve waits for c1''s release';
end $$;
commit;
do $$
declare
  j jsonb := t.c2_result();
begin
  assert t.ok(j), 'c2 uses the room the release freed: ' || j::text;
  assert (select sum(case status when 'pending' then est_usd else cost_usd end) from public.house_spend
           where comic_id = (select id from t.conc where k = 'c')) = 6, 'only c2''s $6.00 counts on comic c';
end $$;
select t.dblink_disconnect('c2');

\echo HOUSE_COMICS_OK
