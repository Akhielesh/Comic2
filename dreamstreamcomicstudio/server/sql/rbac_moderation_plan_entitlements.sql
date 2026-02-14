-- RBAC + moderation + interval plan entitlements
-- Backward compatible: additive migration with legacy `pro` support kept for reads.

create extension if not exists pgcrypto;

alter table public.billing_plans
  add column if not exists daily_limit_enabled boolean not null default true;

update public.billing_plans
set
  monthly_price_usd = case
    when id = 'creator' then 11.99
    when id = 'studio' then 39.99
    when id = 'free' then 0
    else monthly_price_usd
  end,
  daily_guardrail_ct = case
    when id = 'free' then 800
    when id in ('creator', 'studio', 'custom', 'admin') then 0
    else daily_guardrail_ct
  end,
  daily_limit_enabled = case
    when id = 'free' then true
    when id in ('creator', 'studio', 'custom', 'admin') then false
    else true
  end,
  monthly_included_ct = case
    when id = 'free' then 10000
    when id = 'creator' then 120000
    when id = 'studio' then 390000
    when id = 'admin' then 5000000
    else monthly_included_ct
  end,
  is_active = case
    when id = 'pro' then false
    else is_active
  end,
  updated_at = now()
where id in ('free', 'creator', 'pro', 'studio', 'custom', 'admin');

create table if not exists public.billing_plan_entitlements (
  plan_tier text not null references public.billing_plans(id) on delete cascade,
  interval text not null check (interval in ('month', 'year')),
  included_monthly_ct integer not null default 0,
  daily_guardrail_ct integer not null default 0,
  daily_limit_enabled boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (plan_tier, interval)
);

insert into public.billing_plan_entitlements (
  plan_tier,
  interval,
  included_monthly_ct,
  daily_guardrail_ct,
  daily_limit_enabled,
  is_active
)
values
  ('free', 'month', 10000, 800, true, true),
  ('free', 'year', 10000, 800, true, true),
  ('creator', 'month', 120000, 0, false, true),
  ('creator', 'year', 100000, 0, false, true),
  ('studio', 'month', 390000, 0, false, true),
  ('studio', 'year', 340000, 0, false, true),
  ('pro', 'month', 240000, 16000, true, true),
  ('pro', 'year', 240000, 16000, true, true),
  ('custom', 'month', 0, 0, false, true),
  ('custom', 'year', 0, 0, false, true),
  ('admin', 'month', 5000000, 0, false, true),
  ('admin', 'year', 5000000, 0, false, true)
on conflict (plan_tier, interval) do update
set
  included_monthly_ct = excluded.included_monthly_ct,
  daily_guardrail_ct = excluded.daily_guardrail_ct,
  daily_limit_enabled = excluded.daily_limit_enabled,
  is_active = excluded.is_active,
  updated_at = now();

alter table public.token_wallets
  add column if not exists billing_interval text not null default 'month',
  add column if not exists daily_limit_enabled boolean not null default true;

update public.token_wallets tw
set
  billing_interval = coalesce((ups.metadata ->> 'interval'), 'month'),
  daily_limit_enabled = coalesce(bp.daily_limit_enabled, tw.daily_guardrail_ct > 0),
  daily_guardrail_ct = case
    when coalesce(bp.daily_limit_enabled, tw.daily_guardrail_ct > 0) then tw.daily_guardrail_ct
    else 0
  end,
  updated_at = now()
from public.user_plan_subscriptions ups
left join public.billing_plans bp on bp.id = ups.plan_tier
where tw.user_id = ups.user_id;

create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'moderator')),
  is_active boolean not null default true,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop index if exists public.idx_user_roles_unique_active;

create unique index if not exists idx_user_roles_unique_pair
  on public.user_roles(user_id, role);

create index if not exists idx_user_roles_role_active
  on public.user_roles(role, is_active, updated_at desc);

create table if not exists public.user_moderation_status (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'restricted', 'suspended')),
  reason text,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_moderation_actions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('force_private', 'request_republish', 'approve_republish', 'reject_republish')),
  reason text,
  acted_by uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_project_moderation_actions_project_created
  on public.project_moderation_actions(project_id, created_at desc);

alter table public.projects
  add column if not exists is_forced_private boolean not null default false,
  add column if not exists forced_private_reason text,
  add column if not exists forced_private_by uuid references auth.users(id) on delete set null,
  add column if not exists forced_private_at timestamptz,
  add column if not exists republish_request_status text not null default 'none',
  add column if not exists republish_request_reason text,
  add column if not exists republish_requested_at timestamptz,
  add column if not exists republish_requested_by uuid references auth.users(id) on delete set null,
  add column if not exists republish_reviewed_at timestamptz,
  add column if not exists republish_reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists republish_review_reason text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'projects_republish_request_status_check'
  ) then
    alter table public.projects
      add constraint projects_republish_request_status_check
      check (republish_request_status in ('none', 'pending', 'approved', 'rejected'));
  end if;
end;
$$;

create or replace function public.billing_try_reserve_tokens(
  p_user_id uuid,
  p_required_ct integer,
  p_allow_overage boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.token_wallets%rowtype;
  v_daily_remaining integer;
  v_available integer;
begin
  select * into v_wallet
  from public.token_wallets
  where user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'WALLET_NOT_FOUND'
    );
  end if;

  v_daily_remaining := case
    when coalesce(v_wallet.daily_limit_enabled, true)
      then greatest(v_wallet.daily_guardrail_ct - v_wallet.used_daily_ct, 0)
    else 2147483647
  end;
  v_available := greatest((v_wallet.included_monthly_ct - v_wallet.used_monthly_ct) + v_wallet.purchased_ct - v_wallet.reserved_ct, 0);

  if coalesce(v_wallet.daily_limit_enabled, true) and p_required_ct > v_daily_remaining then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'DAILY_LIMIT_EXCEEDED',
      'daily_remaining_ct', v_daily_remaining,
      'available_ct', v_available
    );
  end if;

  if not p_allow_overage and p_required_ct > v_available then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'INSUFFICIENT_CREDITS',
      'daily_remaining_ct', v_daily_remaining,
      'available_ct', v_available
    );
  end if;

  update public.token_wallets
  set
    reserved_ct = reserved_ct + p_required_ct,
    updated_at = now()
  where user_id = p_user_id;

  return jsonb_build_object(
    'allowed', true,
    'reason', 'OK'
  );
end;
$$;

grant execute on function public.billing_try_reserve_tokens(uuid, integer, boolean) to service_role;
