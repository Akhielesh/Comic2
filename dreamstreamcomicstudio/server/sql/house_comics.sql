-- House comics (apply name: house_comics). The platform makes a few comics a day on its own system account; this
-- file holds the run's config, its runs and comics, the spend ledger, and the money functions every paid house call
-- goes through (server/src/comic/house/*; the lists and ceilings mirror shared/comic/house.ts).
--
-- Tables
--   * house_config  one row (id = 1): the switch, the mode, the caps and each payer's budget. The admin console edits
--                   it; CHECKs hold the compiled ceilings ($7 per comic, 10 comics and $70 a day, 2 image slots, payer
--                   budgets), so a value above them can never be stored, whoever writes it.
--   * house_runs    one row per run day (unique): the run's frozen mode, status, step lease and summary.
--   * house_comics  one row per slot of a run (slots 1..10): the slate, what ran, the stage, the status and the
--                   held reason. A comic always carries its run's day (composite foreign key).
--   * house_spend   the money truth: one row per paid call, reserved before the call and settled after it. A row
--                   always carries its comic's run and day (composite foreign key), never the clock's date.
--
-- Money functions (plain SECURITY INVOKER, search_path pinned; the server calls them with the service role)
--   * house_reserve(...)  before every paid call. Under a row lock on house_config, in one transaction: expire holds
--                         older than 15 minutes (counted as spent at their estimate), then refuse when the run is
--                         switched off, when a rehearsal asks for any money, when the comic was discarded, purged or
--                         skipped, or when the estimate would pass the comic cap (less the finishing reserve unless
--                         finishing), the run day's cap, the payer's day budget (runway-aware), the payer's credit
--                         expiry or the payer's credit stop. Otherwise book a pending hold. The day is always the
--                         run's day (p_day), never now().
--   * house_settle(...)   after the call: book the cost to the payer of the model that served it (the hold moves) and
--                         say whether a cap is now passed (`over`).
--   * house_release(...)  only for a call that was never sent: a pending hold goes to $0. An expired hold stays spent.
--   * house_expire_holds() the 15-minute expiry on its own (the three above run it first).
-- Every bad input raises; the server refuses the call on any error (fail closed).
--
-- What counts: a pending hold counts its estimate, a settled or expired row its cost, a released hold nothing.
-- `platform` rows (the safety checks on the platform key) are recorded for information only: never capped here and
-- never counted in a house cap.
--
-- Access: see the PRIVILEGES section at the end (RLS on, no policies, clients revoked, the service role granted).
-- Idempotent: safe to re-run; the config row is created once and never reset. Needs auth.users and public.projects.

do $guard$
begin
  if to_regclass('auth.users') is null or to_regclass('public.projects') is null then
    raise exception 'house_comics.sql needs auth.users and public.projects (apply on the Supabase project)';
  end if;
end;
$guard$;

-- ── 1. Config ────────────────────────────────────────────────────────────────────────────────────────────────────

-- The CHECK on house_config.payers: exactly the three capped payers, each with a bounded day cap, a stated credit
-- (null = no credit stop), a stop fraction in (0, 0.95] and optional ISO dates. Mirrors HOUSE_LIMITS
-- (capDayMaxUsd 70, creditMaxUsd 5000, stopFractionMax 0.95).
create or replace function public.house_payers_ok(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  k text;
  v jsonb;
  f text;
  n numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  if (select array_agg(x order by x) from jsonb_object_keys(p) as x)
     is distinct from array['anthropic_credit', 'house_openrouter', 'openai_credit'] then
    return false;
  end if;
  for k, v in select e.key, e.value from jsonb_each(p) as e loop
    if jsonb_typeof(v) <> 'object' then
      return false;
    end if;
    if jsonb_typeof(v -> 'day_cap_usd') is distinct from 'number' then
      return false;
    end if;
    n := (v ->> 'day_cap_usd')::numeric;
    if n < 0 or n > 70 then
      return false;
    end if;
    if not (v ? 'credit_usd') or jsonb_typeof(v -> 'credit_usd') not in ('null', 'number') then
      return false;
    end if;
    if jsonb_typeof(v -> 'credit_usd') = 'number' then
      n := (v ->> 'credit_usd')::numeric;
      if n < 0 or n > 5000 then
        return false;
      end if;
    end if;
    if jsonb_typeof(v -> 'stop_fraction') is distinct from 'number' then
      return false;
    end if;
    n := (v ->> 'stop_fraction')::numeric;
    if n <= 0 or n > 0.95 then
      return false;
    end if;
    foreach f in array array['runway_until', 'expires_on'] loop
      if coalesce(jsonb_typeof(v -> f), 'null') not in ('null', 'string') then
        return false;
      end if;
      if jsonb_typeof(v -> f) = 'string'
         and (v ->> f) !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' then
        return false;
      end if;
    end loop;
  end loop;
  return true;
end;
$$;

create table if not exists public.house_config (
  id smallint primary key default 1,
  enabled boolean not null default false,
  mode text not null default 'off',
  daily_count smallint not null default 3,
  cap_comic_usd numeric(10, 4) not null default 7,
  finish_reserve_usd numeric(10, 4) not null default 0.40,
  cap_day_usd numeric(10, 4) not null default 30,
  image_slots smallint not null default 2,
  allow_4k boolean not null default false,
  release_per_day smallint not null default 2,
  model_weights jsonb not null default '{}'::jsonb,
  payers jsonb not null default '{
    "openai_credit":    {"day_cap_usd": 12, "credit_usd": 200, "stop_fraction": 0.90, "runway_until": null, "expires_on": null},
    "anthropic_credit": {"day_cap_usd": 5,  "credit_usd": 200, "stop_fraction": 0.90, "runway_until": null, "expires_on": null},
    "house_openrouter": {"day_cap_usd": 10, "credit_usd": null, "stop_fraction": 0.90, "runway_until": null, "expires_on": null}
  }'::jsonb,
  house_user_id uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

-- Checks (re-created on every apply, so the ceilings are always in place).
alter table public.house_config drop constraint if exists house_config_single_row_check;
alter table public.house_config add constraint house_config_single_row_check check (id = 1);
alter table public.house_config drop constraint if exists house_config_mode_check;
alter table public.house_config add constraint house_config_mode_check
  check (mode in ('off', 'rehearsal', 'calibration', 'daily'));
alter table public.house_config drop constraint if exists house_config_daily_count_check;
alter table public.house_config add constraint house_config_daily_count_check check (daily_count between 1 and 10);
-- The hard ceiling per comic: $7.
alter table public.house_config drop constraint if exists house_config_cap_comic_check;
alter table public.house_config add constraint house_config_cap_comic_check check (cap_comic_usd > 0 and cap_comic_usd <= 7);
alter table public.house_config drop constraint if exists house_config_finish_reserve_check;
alter table public.house_config add constraint house_config_finish_reserve_check
  check (finish_reserve_usd >= 0 and finish_reserve_usd <= 2 and finish_reserve_usd < cap_comic_usd);
alter table public.house_config drop constraint if exists house_config_cap_day_check;
alter table public.house_config add constraint house_config_cap_day_check check (cap_day_usd > 0 and cap_day_usd <= 70);
alter table public.house_config drop constraint if exists house_config_image_slots_check;
alter table public.house_config add constraint house_config_image_slots_check check (image_slots between 1 and 2);
alter table public.house_config drop constraint if exists house_config_release_per_day_check;
alter table public.house_config add constraint house_config_release_per_day_check check (release_per_day between 0 and 10);
alter table public.house_config drop constraint if exists house_config_model_weights_check;
alter table public.house_config add constraint house_config_model_weights_check check (jsonb_typeof(model_weights) = 'object');
alter table public.house_config drop constraint if exists house_config_payers_check;
alter table public.house_config add constraint house_config_payers_check check (public.house_payers_ok(payers));

-- The one row, switched off. Never reset by a re-apply.
insert into public.house_config (id) values (1) on conflict (id) do nothing;

-- ── 2. Runs ──────────────────────────────────────────────────────────────────────────────────────────────────────

create table if not exists public.house_runs (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  mode text not null,
  status text not null default 'running',
  slots smallint not null default 0,
  lease_until timestamptz,
  lease_owner text,
  started_by text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb not null default '{}'::jsonb,
  constraint house_runs_day_key unique (day),
  constraint house_runs_id_day_key unique (id, day)
);

alter table public.house_runs drop constraint if exists house_runs_mode_check;
alter table public.house_runs add constraint house_runs_mode_check check (mode in ('rehearsal', 'calibration', 'daily'));
alter table public.house_runs drop constraint if exists house_runs_status_check;
alter table public.house_runs add constraint house_runs_status_check check (status in ('running', 'done', 'stopped'));
alter table public.house_runs drop constraint if exists house_runs_slots_check;
alter table public.house_runs add constraint house_runs_slots_check check (slots between 0 and 10);
alter table public.house_runs drop constraint if exists house_runs_started_by_check;
alter table public.house_runs add constraint house_runs_started_by_check check (started_by in ('schedule', 'dispatch', 'admin'));
alter table public.house_runs drop constraint if exists house_runs_summary_check;
alter table public.house_runs add constraint house_runs_summary_check check (jsonb_typeof(summary) = 'object');
alter table public.house_runs drop constraint if exists house_runs_lease_owner_check;
alter table public.house_runs add constraint house_runs_lease_owner_check check (lease_owner is null or char_length(lease_owner) <= 100);

-- ── 3. Comics ────────────────────────────────────────────────────────────────────────────────────────────────────

create table if not exists public.house_comics (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  day date not null,
  slot smallint not null,
  project_id uuid references public.projects(id) on delete set null,
  slate jsonb not null default '{}'::jsonb,
  ran jsonb not null default '{}'::jsonb,
  stage text not null default 'slate',
  status text not null default 'queued',
  held_reason text,
  attempts jsonb not null default '{}'::jsonb,
  redraws smallint not null default 0,
  title text,
  logline text,
  publication_slug text,
  released_at timestamptz,
  released_by uuid references auth.users(id) on delete set null,
  judgement text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  -- The comic's day is its run's day. No cascade: a run with comics is never deleted.
  constraint house_comics_run_fkey foreign key (run_id, day) references public.house_runs (id, day),
  constraint house_comics_run_slot_key unique (run_id, slot),
  constraint house_comics_id_run_day_key unique (id, run_id, day)
);

alter table public.house_comics drop constraint if exists house_comics_slot_check;
alter table public.house_comics add constraint house_comics_slot_check check (slot between 1 and 10);
alter table public.house_comics drop constraint if exists house_comics_stage_check;
alter table public.house_comics add constraint house_comics_stage_check
  check (stage in ('slate', 'brief', 'create', 'plan', 'sheets', 'pages', 'cover', 'letter', 'editions', 'publish', 'done'));
alter table public.house_comics drop constraint if exists house_comics_status_check;
alter table public.house_comics add constraint house_comics_status_check
  check (status in ('queued', 'running', 'held', 'ready', 'released', 'skipped', 'discarded', 'purged'));
-- A gate card an action posts during a house run holds the comic as gate_<reason>.
alter table public.house_comics drop constraint if exists house_comics_held_reason_check;
alter table public.house_comics add constraint house_comics_held_reason_check
  check (held_reason is null
         or held_reason in ('brief_rejected', 'topic_blocked', 'incomplete', 'overfull', 'low_quality', 'gate_blocked',
                            'rating_above_slate', 'payer_cap', 'timeout', 'switched_off', 'pipeline_mismatch',
                            'model_paused', 'error')
         or held_reason ~ '^gate_[a-z_]{1,32}$');
alter table public.house_comics drop constraint if exists house_comics_held_needs_reason_check;
alter table public.house_comics add constraint house_comics_held_needs_reason_check
  check (status <> 'held' or held_reason is not null);
alter table public.house_comics drop constraint if exists house_comics_redraws_check;
alter table public.house_comics add constraint house_comics_redraws_check check (redraws between 0 and 2);
alter table public.house_comics drop constraint if exists house_comics_judgement_check;
alter table public.house_comics add constraint house_comics_judgement_check
  check (judgement is null or judgement in ('bar', 'close', 'no'));
alter table public.house_comics drop constraint if exists house_comics_json_check;
alter table public.house_comics add constraint house_comics_json_check
  check (jsonb_typeof(slate) = 'object' and jsonb_typeof(ran) = 'object' and jsonb_typeof(attempts) = 'object');
alter table public.house_comics drop constraint if exists house_comics_text_check;
alter table public.house_comics add constraint house_comics_text_check
  check ((title is null or char_length(title) <= 200)
         and (logline is null or char_length(logline) <= 600)
         and (publication_slug is null or char_length(publication_slug) <= 120));

-- ── 4. Spend ─────────────────────────────────────────────────────────────────────────────────────────────────────

create table if not exists public.house_spend (
  id uuid primary key default gen_random_uuid(),
  comic_id uuid not null,
  run_id uuid not null,
  day date not null,
  payer text not null,
  provider text,
  model text,
  kind text,
  stage text,
  est_usd numeric(12, 6) not null,
  cost_usd numeric(12, 6),
  status text not null default 'pending',
  reserved_at timestamptz not null default now(),
  settled_at timestamptz,
  -- The row's run and day are its comic's. No cascade: money rows are never deleted with a comic.
  constraint house_spend_comic_fkey foreign key (comic_id, run_id, day) references public.house_comics (id, run_id, day)
);

alter table public.house_spend drop constraint if exists house_spend_payer_check;
alter table public.house_spend add constraint house_spend_payer_check
  check (payer in ('openai_credit', 'anthropic_credit', 'house_openrouter', 'platform'));
alter table public.house_spend drop constraint if exists house_spend_status_check;
alter table public.house_spend add constraint house_spend_status_check check (status in ('pending', 'settled', 'released', 'expired'));
-- No single call is ever estimated above the $7 comic ceiling. (cost_usd has no upper bound: an actual cost is
-- always booked, even one above its estimate.)
alter table public.house_spend drop constraint if exists house_spend_est_check;
alter table public.house_spend add constraint house_spend_est_check check (est_usd >= 0 and est_usd <= 7);
alter table public.house_spend drop constraint if exists house_spend_cost_check;
alter table public.house_spend add constraint house_spend_cost_check
  check ((cost_usd is null or cost_usd >= 0)
         and ((status = 'pending') = (cost_usd is null))
         and (status <> 'released' or cost_usd = 0));
alter table public.house_spend drop constraint if exists house_spend_stage_check;
alter table public.house_spend add constraint house_spend_stage_check
  check (stage is null
         or stage in ('slate', 'brief', 'create', 'plan', 'sheets', 'pages', 'cover', 'letter', 'editions', 'publish', 'done'));
alter table public.house_spend drop constraint if exists house_spend_text_check;
alter table public.house_spend add constraint house_spend_text_check
  check ((provider is null or char_length(provider) <= 64)
         and (model is null or char_length(model) <= 200)
         and (kind is null or char_length(kind) <= 64));

-- ── 5. Indexes ───────────────────────────────────────────────────────────────────────────────────────────────────

create index if not exists house_spend_day_payer_idx on public.house_spend (day, payer);
create index if not exists house_spend_comic_idx on public.house_spend (comic_id);
create index if not exists house_spend_payer_idx on public.house_spend (payer);
create index if not exists house_spend_pending_idx on public.house_spend (reserved_at) where status = 'pending';
create index if not exists house_comics_day_idx on public.house_comics (day);
-- A project belongs to at most one house comic (the admin pages route looks house comics up by project).
create unique index if not exists house_comics_project_key on public.house_comics (project_id) where project_id is not null;

-- ── 6. updated_at bookkeeping ────────────────────────────────────────────────────────────────────────────────────

create or replace function public.house_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists house_config_touch on public.house_config;
create trigger house_config_touch before update on public.house_config
  for each row execute function public.house_touch_updated_at();
drop trigger if exists house_comics_touch on public.house_comics;
create trigger house_comics_touch before update on public.house_comics
  for each row execute function public.house_touch_updated_at();

-- ── 7. Money functions ───────────────────────────────────────────────────────────────────────────────────────────

-- Holds left pending for more than 15 minutes (a restart mid-call) become expired: counted as spent at their
-- estimate, never released. Returns how many expired. The one place the TTL lives (HOUSE_LIMITS.holdTtlMs).
create or replace function public.house_expire_holds()
returns integer
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  update public.house_spend
     set status = 'expired', cost_usd = est_usd, settled_at = now()
   where status = 'pending' and reserved_at < now() - interval '15 minutes';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- The first house cap that `p_est` more on this comic, run day and payer would pass, or null when it fits.
-- Internal: the callers hold the house_config row lock. `platform` is never capped.
--   comic   = comic total + est > min(cap_comic, 7) − (finishing ? 0 : finish_reserve)
--   day     = run-day total + est > min(cap_day, 70)
--   payer   = after the credit's expiry day: refused; lifetime + est > credit × min(stop, 0.95); payer-day total + est
--             > the payer's day budget: min(day_cap, room) and, with a runway date, room / days left (run day and the
--             runway's last day included; the runway ends at the expiry when that is sooner), where room is the stop
--             less what the payer spent on other run days.
create or replace function public.house_cap_refusal(
  p_cfg public.house_config,
  p_comic uuid,
  p_day date,
  p_payer text,
  p_est numeric,
  p_finishing boolean
)
returns jsonb
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_cap_comic numeric := least(coalesce(p_cfg.cap_comic_usd, 0), 7);
  v_reserve numeric := case when p_finishing then 0 else greatest(coalesce(p_cfg.finish_reserve_usd, 0), 0) end;
  v_cap_day numeric := least(coalesce(p_cfg.cap_day_usd, 0), 70);
  v_p jsonb := p_cfg.payers -> p_payer;
  v_comic numeric;
  v_day numeric;
  v_payer_day numeric;
  v_payer_other numeric;
  v_day_cap numeric;
  v_credit numeric;
  v_stop numeric;
  v_room numeric;
  v_budget numeric;
  v_runway date;
  v_expires date;
  v_end date;
begin
  if p_payer = 'platform' then
    return null;
  end if;

  select coalesce(sum(case s.status when 'pending' then s.est_usd when 'released' then 0 else s.cost_usd end), 0)
    into v_comic
    from public.house_spend s
   where s.comic_id = p_comic and s.payer <> 'platform';
  if v_comic + p_est > v_cap_comic then
    return jsonb_build_object('reason', 'comic_cap', 'limit_usd', round(v_cap_comic, 6), 'total_usd', round(v_comic, 6));
  end if;
  if v_comic + p_est > v_cap_comic - v_reserve then
    return jsonb_build_object('reason', 'comic_finish_reserve', 'limit_usd', round(v_cap_comic - v_reserve, 6), 'total_usd', round(v_comic, 6));
  end if;

  select coalesce(sum(case s.status when 'pending' then s.est_usd when 'released' then 0 else s.cost_usd end), 0)
    into v_day
    from public.house_spend s
   where s.day = p_day and s.payer <> 'platform';
  if v_day + p_est > v_cap_day then
    return jsonb_build_object('reason', 'day_cap', 'limit_usd', round(v_cap_day, 6), 'total_usd', round(v_day, 6));
  end if;

  if v_p is null or jsonb_typeof(v_p) <> 'object' then
    return jsonb_build_object('reason', 'payer_day_cap', 'limit_usd', 0, 'total_usd', 0);
  end if;
  v_expires := (v_p ->> 'expires_on')::date;
  if v_expires is not null and p_day > v_expires then
    return jsonb_build_object('reason', 'payer_expired', 'limit_usd', 0, 'total_usd', 0);
  end if;

  select coalesce(sum(case when s.day = p_day then
                        case s.status when 'pending' then s.est_usd when 'released' then 0 else s.cost_usd end end), 0),
         coalesce(sum(case when s.day <> p_day then
                        case s.status when 'pending' then s.est_usd when 'released' then 0 else s.cost_usd end end), 0)
    into v_payer_day, v_payer_other
    from public.house_spend s
   where s.payer = p_payer;

  v_day_cap := least(greatest(coalesce((v_p ->> 'day_cap_usd')::numeric, 0), 0), 70);
  v_credit := (v_p ->> 'credit_usd')::numeric;
  v_budget := v_day_cap;
  if v_credit is not null then
    v_stop := greatest(v_credit, 0) * least(greatest(coalesce((v_p ->> 'stop_fraction')::numeric, 0), 0), 0.95);
    if v_payer_day + v_payer_other + p_est > v_stop then
      return jsonb_build_object('reason', 'payer_stop', 'limit_usd', round(v_stop, 6), 'total_usd', round(v_payer_day + v_payer_other, 6));
    end if;
    v_room := greatest(v_stop - v_payer_other, 0);
    v_budget := least(v_budget, v_room);
    v_runway := (v_p ->> 'runway_until')::date;
    if v_runway is not null then
      v_end := case when v_expires is not null and v_expires < v_runway then v_expires else v_runway end;
      v_budget := least(v_budget, v_room / greatest(1, (v_end - p_day) + 1));
    end if;
  end if;
  if v_payer_day + p_est > v_budget then
    return jsonb_build_object('reason', 'payer_day_cap', 'limit_usd', round(v_budget, 6), 'total_usd', round(v_payer_day, 6));
  end if;
  return null;
end;
$$;

-- Before every paid house call. Returns {"ok": true, "spend_id", "payer", "expired"} or
-- {"ok": false, "reason", "payer", "limit_usd"?, "total_usd"?, "expired"}. Reasons: switched_off, rehearsal,
-- comic_closed, comic_cap, comic_finish_reserve, day_cap, payer_expired, payer_stop, payer_day_cap. Raises on bad
-- input.
create or replace function public.house_reserve(
  p_comic uuid,
  p_run uuid,
  p_day date,
  p_payer text,
  p_provider text,
  p_model text,
  p_kind text,
  p_est numeric,
  p_finishing boolean default false
)
returns jsonb
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_cfg public.house_config;
  v_run public.house_runs;
  v_stage text;
  v_status text;
  v_expired integer;
  v_refusal jsonb;
  v_id uuid;
begin
  if p_est is null or p_est < 0 then
    raise exception 'house_reserve: the estimate must be 0 or more';
  end if;
  if p_payer is null or p_payer not in ('openai_credit', 'anthropic_credit', 'house_openrouter', 'platform') then
    raise exception 'house_reserve: unknown payer';
  end if;
  if p_day is null then
    raise exception 'house_reserve: the run day is required';
  end if;

  -- One money decision at a time, across every server instance: the expiry, the sums and the insert are one step.
  select * into v_cfg from public.house_config where id = 1 for update;

  select * into v_run from public.house_runs where id = p_run;
  if v_run.id is null then
    raise exception 'house_reserve: unknown run';
  end if;
  if v_run.day <> p_day then
    raise exception 'house_reserve: p_day must be the run''s day';
  end if;
  select c.stage, c.status into v_stage, v_status from public.house_comics c where c.id = p_comic and c.run_id = p_run;
  if not found then
    raise exception 'house_reserve: the comic is not in this run';
  end if;

  v_expired := public.house_expire_holds();

  if v_cfg.id is null or not v_cfg.enabled or v_cfg.mode = 'off' then
    return jsonb_build_object('ok', false, 'reason', 'switched_off', 'payer', p_payer, 'expired', v_expired);
  end if;
  if p_est > 0 and (v_cfg.mode = 'rehearsal' or v_run.mode = 'rehearsal') then
    return jsonb_build_object('ok', false, 'reason', 'rehearsal', 'payer', p_payer, 'expired', v_expired);
  end if;
  -- A discarded, purged or skipped comic never spends (a step racing a Discard click).
  if v_status in ('discarded', 'purged', 'skipped') then
    return jsonb_build_object('ok', false, 'reason', 'comic_closed', 'payer', p_payer, 'expired', v_expired);
  end if;

  v_refusal := public.house_cap_refusal(v_cfg, p_comic, p_day, p_payer, p_est, coalesce(p_finishing, false));
  if v_refusal is not null then
    return jsonb_build_object('ok', false, 'payer', p_payer, 'expired', v_expired) || v_refusal;
  end if;

  insert into public.house_spend (comic_id, run_id, day, payer, provider, model, kind, stage, est_usd)
  values (p_comic, p_run, p_day, p_payer, left(p_provider, 64), left(p_model, 200), left(p_kind, 64), v_stage, p_est)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'spend_id', v_id, 'payer', p_payer, 'expired', v_expired);
end;
$$;

-- After a paid call. p_payer is the payer of the model that served it (null keeps the reserved payer); the row and
-- its amount move there. A late settle of an expired hold never books less than the hold. Returns
-- {"ok": true, "payer", "from_payer", "cost_usd", "over", "over_reason"} or {"ok": false, "reason": "already_settled"}.
-- Raises on bad input, and on any move to or from the `platform` payer.
create or replace function public.house_settle(
  p_spend uuid,
  p_cost numeric,
  p_payer text default null,
  p_model text default null
)
returns jsonb
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_cfg public.house_config;
  v_row public.house_spend;
  v_payer text;
  v_cost numeric;
  v_over jsonb;
begin
  if p_cost is null or p_cost < 0 then
    raise exception 'house_settle: the cost must be 0 or more';
  end if;
  if p_payer is not null and p_payer not in ('openai_credit', 'anthropic_credit', 'house_openrouter', 'platform') then
    raise exception 'house_settle: unknown payer';
  end if;

  select * into v_cfg from public.house_config where id = 1 for update;
  perform public.house_expire_holds();

  select * into v_row from public.house_spend where id = p_spend for update;
  if v_row.id is null then
    raise exception 'house_settle: unknown spend row';
  end if;
  if v_row.status = 'settled' then
    return jsonb_build_object('ok', false, 'reason', 'already_settled', 'payer', v_row.payer);
  end if;
  v_payer := coalesce(p_payer, v_row.payer);
  if v_payer <> v_row.payer and 'platform' in (v_payer, v_row.payer) then
    raise exception 'house_settle: platform spend never moves to or from a capped payer';
  end if;
  v_cost := case when v_row.status = 'expired' then greatest(v_row.est_usd, p_cost) else p_cost end;

  update public.house_spend
     set status = 'settled', cost_usd = v_cost, payer = v_payer, model = coalesce(left(p_model, 200), model), settled_at = now()
   where id = p_spend;

  if v_cfg.id is null then
    v_over := jsonb_build_object('reason', 'switched_off');
  else
    v_over := public.house_cap_refusal(v_cfg, v_row.comic_id, v_row.day, v_payer, 0, true);
  end if;
  return jsonb_build_object('ok', true, 'payer', v_payer, 'from_payer', v_row.payer, 'cost_usd', round(v_cost, 6),
                            'over', v_over is not null, 'over_reason', v_over ->> 'reason');
end;
$$;

-- Only for a call that was never sent: a pending hold goes to $0. Returns {"ok": true} or
-- {"ok": false, "reason": <the row's status>} (an expired hold stays spent). Raises on an unknown row.
create or replace function public.house_release(p_spend uuid)
returns jsonb
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  perform 1 from public.house_config where id = 1 for update;
  perform public.house_expire_holds();

  select s.status into v_status from public.house_spend s where s.id = p_spend for update;
  if not found then
    raise exception 'house_release: unknown spend row';
  end if;
  if v_status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', v_status);
  end if;
  update public.house_spend set status = 'released', cost_usd = 0, settled_at = now() where id = p_spend;
  return jsonb_build_object('ok', true);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- PRIVILEGES (grants, revokes and row level security; review this section on its own)
--   * RLS on all four tables, with no policies: a client role sees and writes nothing even if a grant reappears.
--   * Every privilege of public, anon and authenticated revoked on the tables and the functions.
--   * The service role (the server) granted the tables and the functions it calls. Supabase's default privileges
--     already give it these; the grants make the file stand on its own.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

alter table public.house_config enable row level security;
alter table public.house_runs enable row level security;
alter table public.house_comics enable row level security;
alter table public.house_spend enable row level security;

revoke all on table public.house_config, public.house_runs, public.house_comics, public.house_spend
  from public, anon, authenticated;
grant select, insert, update, delete on table public.house_config, public.house_runs, public.house_comics, public.house_spend
  to service_role;

revoke all on function public.house_payers_ok(jsonb) from public, anon, authenticated;
revoke all on function public.house_touch_updated_at() from public, anon, authenticated;
revoke all on function public.house_expire_holds() from public, anon, authenticated;
revoke all on function public.house_cap_refusal(public.house_config, uuid, date, text, numeric, boolean) from public, anon, authenticated;
revoke all on function public.house_reserve(uuid, uuid, date, text, text, text, text, numeric, boolean) from public, anon, authenticated;
revoke all on function public.house_settle(uuid, numeric, text, text) from public, anon, authenticated;
revoke all on function public.house_release(uuid) from public, anon, authenticated;

-- house_payers_ok runs inside the house_config CHECK, which needs EXECUTE for the writer.
grant execute on function public.house_payers_ok(jsonb) to service_role;
grant execute on function public.house_expire_holds() to service_role;
grant execute on function public.house_cap_refusal(public.house_config, uuid, date, text, numeric, boolean) to service_role;
grant execute on function public.house_reserve(uuid, uuid, date, text, text, text, text, numeric, boolean) to service_role;
grant execute on function public.house_settle(uuid, numeric, text, text) to service_role;
grant execute on function public.house_release(uuid) to service_role;

-- ── Post-apply checks (read-only) ───────────────────────────────────────────────────────────────────────────────
-- 1) RLS on, no policies, no client privilege:
--    select relname, relrowsecurity from pg_class where relname in ('house_config', 'house_runs', 'house_comics', 'house_spend');
--    select count(*) from pg_policies where tablename like 'house\_%';                                              -- 0
--    select grantee, privilege_type from information_schema.role_table_grants
--     where table_name like 'house\_%' and grantee in ('anon', 'authenticated');                                    -- 0 rows
-- 2) No client can call the money functions:
--    select has_function_privilege('authenticated', 'public.house_reserve(uuid, uuid, date, text, text, text, text, numeric, boolean)', 'execute'); -- false
-- 3) The config row is switched off and inside the ceilings:
--    select enabled, mode, daily_count, cap_comic_usd, cap_day_usd from public.house_config;                       -- false, off, 3, 7, 30
