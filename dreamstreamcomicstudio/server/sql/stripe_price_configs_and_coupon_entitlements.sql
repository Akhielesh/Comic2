-- Stripe price config + assigned coupon entitlement foundation
-- Adds DB-configurable Stripe price mappings (with env fallback in app)
-- and admin-assigned coupon entitlements with one-time redemption audit.

create extension if not exists pgcrypto;

create table if not exists public.stripe_price_configs (
  id uuid primary key default gen_random_uuid(),
  resource_type text not null check (resource_type in ('plan', 'credit_pack')),
  plan_tier text references public.billing_plans(id),
  pack_id text,
  interval text check (interval in ('month', 'year')),
  price_id text not null,
  price_usd numeric(12, 2),
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stripe_price_configs_price_non_negative check (price_usd is null or price_usd >= 0),
  constraint stripe_price_configs_shape check (
    (
      resource_type = 'plan'
      and plan_tier is not null
      and interval is not null
      and pack_id is null
    )
    or
    (
      resource_type = 'credit_pack'
      and pack_id is not null
      and interval is null
      and plan_tier is null
    )
  )
);

create unique index if not exists idx_stripe_price_configs_price_id
  on public.stripe_price_configs(price_id);

create unique index if not exists idx_stripe_price_configs_active_scope
  on public.stripe_price_configs(
    resource_type,
    coalesce(plan_tier, ''),
    coalesce(pack_id, ''),
    coalesce(interval, '')
  )
  where is_active = true;

create index if not exists idx_stripe_price_configs_active
  on public.stripe_price_configs(resource_type, is_active, updated_at desc);

create table if not exists public.coupon_definitions (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  policy jsonb not null default '{}'::jsonb,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coupon_definitions_code_upper check (code = upper(code)),
  constraint coupon_definitions_window_valid check (ends_at > starts_at)
);

create unique index if not exists idx_coupon_definitions_code
  on public.coupon_definitions(code);

create index if not exists idx_coupon_definitions_active_window
  on public.coupon_definitions(is_active, starts_at, ends_at);

create table if not exists public.coupon_assignments (
  id uuid primary key default gen_random_uuid(),
  coupon_definition_id uuid not null references public.coupon_definitions(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  email text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_active boolean not null default true,
  is_redeemed boolean not null default false,
  redeemed_at timestamptz,
  redeemed_by uuid references auth.users(id),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id),
  revoke_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coupon_assignments_target_required check (
    user_id is not null
    or (email is not null and btrim(email) <> '')
  ),
  constraint coupon_assignments_window_valid check (ends_at > starts_at)
);

create index if not exists idx_coupon_assignments_definition
  on public.coupon_assignments(coupon_definition_id, created_at desc);

create index if not exists idx_coupon_assignments_target
  on public.coupon_assignments(user_id, email, is_active);

create unique index if not exists idx_coupon_assignments_active_target
  on public.coupon_assignments(
    coupon_definition_id,
    coalesce(user_id::text, ''),
    coalesce(lower(email), '')
  )
  where is_active = true and revoked_at is null;

create table if not exists public.coupon_redemption_events (
  id uuid primary key default gen_random_uuid(),
  coupon_definition_id uuid references public.coupon_definitions(id) on delete set null,
  assignment_id uuid references public.coupon_assignments(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  email text,
  coupon_code text not null,
  outcome text not null,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_coupon_redemption_events_created
  on public.coupon_redemption_events(created_at desc);

create index if not exists idx_coupon_redemption_events_lookup
  on public.coupon_redemption_events(coupon_code, user_id, email, created_at desc);

alter table public.stripe_price_configs enable row level security;
alter table public.coupon_definitions enable row level security;
alter table public.coupon_assignments enable row level security;
alter table public.coupon_redemption_events enable row level security;
