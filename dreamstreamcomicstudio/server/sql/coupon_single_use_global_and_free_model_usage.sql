-- Simplify coupons to token-only single-use global codes and add free-tier model usage caps.

create extension if not exists pgcrypto;

alter table if exists public.coupon_definitions
  add column if not exists token_amount_ct integer,
  add column if not exists max_redemptions integer,
  add column if not exists redemption_count integer,
  add column if not exists first_redeemed_at timestamptz,
  add column if not exists last_redeemed_at timestamptz,
  add column if not exists first_redeemed_by uuid references auth.users(id),
  add column if not exists last_redeemed_by uuid references auth.users(id),
  add column if not exists coupon_mode text;

-- Existing coupon rows are legacy by default; newly created coupons use single_use_global.
update public.coupon_definitions
set coupon_mode = 'legacy'
where coupon_mode is null;

-- Backfill token amount from legacy policy bonusCt where possible.
update public.coupon_definitions
set token_amount_ct = greatest(
  0,
  coalesce(
    case
      when coalesce(policy ->> 'bonusCt', '') ~ '^-?[0-9]+$'
        then (policy ->> 'bonusCt')::integer
      else null
    end,
    0
  )
)
where token_amount_ct is null;

update public.coupon_definitions
set max_redemptions = 1
where max_redemptions is null or max_redemptions < 1;

update public.coupon_definitions
set redemption_count = 0
where redemption_count is null or redemption_count < 0;

with redeemed as (
  select
    coupon_definition_id,
    user_id,
    created_at,
    row_number() over (partition by coupon_definition_id order by created_at asc, id asc) as rn_first,
    row_number() over (partition by coupon_definition_id order by created_at desc, id desc) as rn_last,
    count(*) over (partition by coupon_definition_id) as redemption_count
  from public.coupon_redemption_events
  where coupon_definition_id is not null and outcome = 'redeemed'
),
aggregated as (
  select
    coupon_definition_id,
    max(redemption_count)::integer as redemption_count,
    min(created_at) as first_redeemed_at,
    max(created_at) as last_redeemed_at,
    max(case when rn_first = 1 then user_id end) as first_redeemed_by,
    max(case when rn_last = 1 then user_id end) as last_redeemed_by
  from redeemed
  group by coupon_definition_id
)
update public.coupon_definitions cd
set
  redemption_count = greatest(cd.redemption_count, a.redemption_count),
  first_redeemed_at = coalesce(cd.first_redeemed_at, a.first_redeemed_at),
  last_redeemed_at = coalesce(cd.last_redeemed_at, a.last_redeemed_at),
  first_redeemed_by = coalesce(cd.first_redeemed_by, a.first_redeemed_by),
  last_redeemed_by = coalesce(cd.last_redeemed_by, a.last_redeemed_by)
from aggregated a
where cd.id = a.coupon_definition_id;

update public.coupon_definitions
set redemption_count = least(greatest(redemption_count, 0), greatest(max_redemptions, 1));

update public.coupon_definitions
set token_amount_ct = 0
where token_amount_ct is null;

alter table public.coupon_definitions
  alter column token_amount_ct set default 0,
  alter column token_amount_ct set not null,
  alter column max_redemptions set default 1,
  alter column max_redemptions set not null,
  alter column redemption_count set default 0,
  alter column redemption_count set not null,
  alter column coupon_mode set default 'single_use_global',
  alter column coupon_mode set not null;

alter table public.coupon_definitions
  drop constraint if exists coupon_definitions_token_amount_non_negative,
  drop constraint if exists coupon_definitions_max_redemptions_positive,
  drop constraint if exists coupon_definitions_redemption_count_bounds,
  drop constraint if exists coupon_definitions_coupon_mode_valid;

alter table public.coupon_definitions
  add constraint coupon_definitions_token_amount_non_negative
    check (token_amount_ct >= 0),
  add constraint coupon_definitions_max_redemptions_positive
    check (max_redemptions >= 1),
  add constraint coupon_definitions_redemption_count_bounds
    check (redemption_count >= 0 and redemption_count <= max_redemptions),
  add constraint coupon_definitions_coupon_mode_valid
    check (coupon_mode in ('single_use_global', 'legacy'));

create index if not exists idx_coupon_definitions_mode_window
  on public.coupon_definitions(coupon_mode, is_active, starts_at, ends_at, created_at desc);

create index if not exists idx_coupon_definitions_redemption_counters
  on public.coupon_definitions(redemption_count, max_redemptions, updated_at desc);

create table if not exists public.free_tier_model_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  model_id text not null,
  usage_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date, model_id),
  constraint free_tier_model_daily_usage_count_non_negative check (usage_count >= 0)
);

create index if not exists idx_free_tier_model_daily_usage_date_model
  on public.free_tier_model_daily_usage(usage_date, model_id, usage_count desc);

alter table public.free_tier_model_daily_usage enable row level security;

drop policy if exists free_tier_model_daily_usage_read_own on public.free_tier_model_daily_usage;
create policy free_tier_model_daily_usage_read_own on public.free_tier_model_daily_usage
for select
to authenticated
using (auth.uid() = user_id);

create or replace function public.free_tier_try_consume_model_usage(
  p_user_id uuid,
  p_model_id text,
  p_usage_date date,
  p_limit integer default 5
)
returns table(
  allowed boolean,
  used_count integer,
  "limit" integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(coalesce(p_limit, 1), 1);
  v_usage_date date := coalesce(p_usage_date, current_date);
  v_row public.free_tier_model_daily_usage%rowtype;
begin
  if p_user_id is null or coalesce(btrim(p_model_id), '') = '' then
    return query select false, 0, v_limit;
    return;
  end if;

  insert into public.free_tier_model_daily_usage (
    user_id,
    usage_date,
    model_id,
    usage_count
  )
  values (
    p_user_id,
    v_usage_date,
    p_model_id,
    0
  )
  on conflict (user_id, usage_date, model_id) do nothing;

  select *
  into v_row
  from public.free_tier_model_daily_usage
  where user_id = p_user_id
    and usage_date = v_usage_date
    and model_id = p_model_id
  for update;

  if not found then
    return query select false, 0, v_limit;
    return;
  end if;

  if v_row.usage_count >= v_limit then
    return query select false, v_row.usage_count, v_limit;
    return;
  end if;

  update public.free_tier_model_daily_usage
  set
    usage_count = usage_count + 1,
    updated_at = now()
  where user_id = p_user_id
    and usage_date = v_usage_date
    and model_id = p_model_id
  returning * into v_row;

  return query select true, v_row.usage_count, v_limit;
end;
$$;

revoke all on function public.free_tier_try_consume_model_usage(uuid, text, date, integer) from public;
grant execute on function public.free_tier_try_consume_model_usage(uuid, text, date, integer) to authenticated;
grant execute on function public.free_tier_try_consume_model_usage(uuid, text, date, integer) to service_role;
