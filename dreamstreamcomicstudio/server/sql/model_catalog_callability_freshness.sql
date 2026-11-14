-- Apply before deploying the maintenance/store change. Additive and idempotent.
-- Discovery time must never be presented as evidence of successful inference.
alter table public.model_catalog_cache
  add column if not exists api_callable_checked_at timestamptz;

comment on column public.model_catalog_cache.api_callable_checked_at is
  'When the platform account last obtained a conclusive hosted-API probe result. NULL is unknown; independent of last_seen_at model discovery.';

-- Intentionally do not backfill from last_seen_at: old flags have no trustworthy probe date.
-- Existing RLS and grants remain unchanged; this server-only table has no client policies.
