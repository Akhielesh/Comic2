-- Token billing foundation for DreamStream Comic Studio
-- This migration introduces CT-based wallets, ledgers, pricing snapshots,
-- and payment profile tracking while preserving legacy image counters.

create extension if not exists pgcrypto;

create table if not exists public.billing_plans (
  id text primary key,
  name text not null,
  monthly_included_ct integer not null default 0,
  daily_guardrail_ct integer not null default 0,
  monthly_price_usd numeric(12, 2) not null default 0,
  allow_overage boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_plan_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan_tier text not null default 'free' references public.billing_plans(id),
  status text not null default 'active',
  stripe_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.token_wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan_tier text not null default 'free' references public.billing_plans(id),
  included_monthly_ct integer not null default 0,
  used_monthly_ct integer not null default 0,
  purchased_ct integer not null default 0,
  reserved_ct integer not null default 0,
  overage_ct integer not null default 0,
  daily_guardrail_ct integer not null default 0,
  used_daily_ct integer not null default 0,
  daily_cycle_date date not null default current_date,
  cycle_starts_at timestamptz not null default date_trunc('month', now()),
  cycle_ends_at timestamptz not null default (date_trunc('month', now()) + interval '1 month'),
  pending_overage_usd numeric(12, 6) not null default 0,
  auto_reload_enabled boolean not null default false,
  auto_reload_threshold_ct integer not null default 5000,
  auto_reload_pack_usd numeric(12, 2) not null default 25,
  overage_hard_cap_usd numeric(12, 2) not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.token_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  entry_type text not null,
  ct_delta integer not null default 0,
  usd_delta numeric(12, 6) not null default 0,
  provider_cost_usd numeric(12, 6),
  billable_usd numeric(12, 6),
  operation text,
  provider text,
  model text,
  project_id text,
  reservation_id uuid,
  is_byok boolean not null default false,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_token_ledger_user_created
  on public.token_ledger_entries(user_id, created_at desc);
create index if not exists idx_token_ledger_project
  on public.token_ledger_entries(project_id);
create index if not exists idx_token_ledger_reservation
  on public.token_ledger_entries(reservation_id);

create table if not exists public.usage_daily_rollups (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  ct_spent integer not null default 0,
  ct_byok_tracked integer not null default 0,
  usd_estimated numeric(12, 6) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date)
);

create table if not exists public.model_pricing_snapshots (
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

create index if not exists idx_model_pricing_provider_model_effective
  on public.model_pricing_snapshots(provider, model_id, effective_from desc);
create index if not exists idx_model_pricing_status_effective
  on public.model_pricing_snapshots(status, effective_from desc);

create table if not exists public.model_pricing_sources (
  provider text primary key,
  source_url text not null,
  parser_name text,
  last_checked_at timestamptz,
  last_status text,
  last_error text,
  last_confidence numeric(5, 4),
  last_hash text,
  updated_at timestamptz not null default now()
);

create table if not exists public.pricing_changelog_entries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null default 'daily_pricing_sync',
  status text not null default 'ACTIVE',
  summary text not null,
  details jsonb not null default '{}'::jsonb
);

create index if not exists idx_pricing_changelog_created
  on public.pricing_changelog_entries(created_at desc);

create table if not exists public.generation_cost_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id text,
  comic_id text,
  operation text not null,
  stage text,
  provider text not null,
  model text not null,
  reservation_id uuid,
  estimated_ct integer not null default 0,
  actual_ct integer not null default 0,
  provider_cost_usd numeric(12, 6) not null default 0,
  billable_usd numeric(12, 6) not null default 0,
  is_byok boolean not null default false,
  status text not null default 'SETTLED',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_generation_cost_events_user_created
  on public.generation_cost_events(user_id, created_at desc);
create index if not exists idx_generation_cost_events_project
  on public.generation_cost_events(project_id);
create index if not exists idx_generation_cost_events_comic
  on public.generation_cost_events(comic_id);
create index if not exists idx_generation_cost_events_reservation
  on public.generation_cost_events(reservation_id);

create table if not exists public.payment_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text unique,
  default_payment_method_id text,
  has_payment_method boolean not null default false,
  overage_enabled boolean not null default false,
  payment_method_brand text,
  payment_method_last4 text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.billing_plans (id, name, monthly_included_ct, daily_guardrail_ct, monthly_price_usd, allow_overage)
values
  ('free', 'Free', 10000, 800, 0, false),
  ('creator', 'Creator', 90000, 6000, 19, true),
  ('pro', 'Pro', 240000, 16000, 49, true),
  ('studio', 'Studio', 700000, 50000, 149, true),
  ('custom', 'Custom Credits', 0, 20000, 0, true),
  ('admin', 'Admin', 5000000, 500000, 0, false)
on conflict (id) do update
set
  name = excluded.name,
  monthly_included_ct = excluded.monthly_included_ct,
  daily_guardrail_ct = excluded.daily_guardrail_ct,
  monthly_price_usd = excluded.monthly_price_usd,
  allow_overage = excluded.allow_overage,
  is_active = true,
  updated_at = now();

-- Backfill existing users from usage_limits into subscription + wallet.
insert into public.user_plan_subscriptions (user_id, plan_tier, status)
select
  ul.user_id,
  case
    when lower(coalesce(ul.plan_tier, '')) in ('admin', 'studio', 'creator', 'pro') then lower(ul.plan_tier)
    when ul.is_premium = true then 'pro'
    else 'free'
  end as plan_tier,
  'active' as status
from public.usage_limits ul
on conflict (user_id) do nothing;

insert into public.token_wallets (
  user_id,
  plan_tier,
  included_monthly_ct,
  used_monthly_ct,
  purchased_ct,
  reserved_ct,
  overage_ct,
  daily_guardrail_ct,
  used_daily_ct,
  daily_cycle_date,
  cycle_starts_at,
  cycle_ends_at,
  pending_overage_usd,
  auto_reload_enabled,
  auto_reload_threshold_ct,
  auto_reload_pack_usd,
  overage_hard_cap_usd
)
select
  ups.user_id,
  ups.plan_tier,
  bp.monthly_included_ct,
  0,
  0,
  0,
  0,
  bp.daily_guardrail_ct,
  0,
  current_date,
  date_trunc('month', now()),
  date_trunc('month', now()) + interval '1 month',
  0,
  false,
  5000,
  25,
  100
from public.user_plan_subscriptions ups
join public.billing_plans bp on bp.id = ups.plan_tier
on conflict (user_id) do nothing;
