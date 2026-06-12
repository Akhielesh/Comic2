-- Platform model-spend allowance preferences (server/src/services/platformAllowance.ts).
-- One row per user; an absent row means the defaults: run on the platform allowance,
-- and ASK before falling back to a stored BYOK key once the monthly allowance is
-- exhausted. Read/written exclusively by the server (GET /api/usage/allowance,
-- PATCH /api/account/billing-prefs) via the service role, which bypasses RLS — so
-- direct client access is revoked outright, like the user_settings/user_api_keys
-- hardening. Idempotent; safe to re-run.

create table if not exists public.user_billing_prefs (
  user_id uuid primary key,
  use_platform_allowance boolean not null default true,
  byok_fallback_mode text not null default 'ask' check (byok_fallback_mode in ('ask','auto','never')),
  updated_at timestamptz not null default now()
);

alter table public.user_billing_prefs enable row level security;

revoke all on public.user_billing_prefs from anon, authenticated;
