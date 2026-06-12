-- Account-wise upstream-API usage tracking (cloud persistence for the in-process
-- provider meter in server/src/lib/providerUsage.ts).
--
-- Append-only DELTA rows: the backend flushes per-(account, provider, day) call/
-- error/blocked increments every ~60s. Daily totals come from the SUM view below.
-- Append-only inserts are race-free across server instances and restarts.

create table if not exists public.provider_usage_log (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  account_id text not null,          -- auth user id, or 'anon'
  provider text not null,            -- meter name, e.g. 'coingecko', 'metno', 'searxng'
  day date not null,                 -- UTC day the calls belong to
  calls integer not null default 0,
  errors integer not null default 0,
  blocked integer not null default 0 -- budget-guard refusals (quota protection hits)
);

create index if not exists provider_usage_log_day_idx on public.provider_usage_log (day, provider);
create index if not exists provider_usage_log_account_idx on public.provider_usage_log (account_id, day);

-- Daily totals per account & provider.
create or replace view public.provider_usage_daily as
select account_id, provider, day,
       sum(calls)::bigint as calls,
       sum(errors)::bigint as errors,
       sum(blocked)::bigint as blocked,
       max(ts) as last_event_at
from public.provider_usage_log
group by account_id, provider, day;

-- Server-only data: RLS on with NO policies — anon/authenticated clients can't
-- read or write; the backend uses the service-role key (bypasses RLS).
alter table public.provider_usage_log enable row level security;
revoke all on public.provider_usage_log from anon, authenticated;
revoke all on public.provider_usage_daily from anon, authenticated;
