-- Billing ledger: no direct client access (gate finding S5). Migration name: billing_ledger_client_lockdown
--
-- Why: token_billing_foundation.sql gives `authenticated` a SELECT policy (`*_read_own`) on three
-- ledger tables, and Supabase's default table grants leave SELECT on for client roles. So a signed-in
-- user could call PostgREST directly with their own session and read their own per-call provider
-- dollars (generation_cost_events.provider_cost_usd / billable_usd, including the RESERVED holds the
-- usage budget writes), usage_daily_rollups.usd_estimated and token_ledger_entries.usd_delta. The
-- owner rule is that governed users never see dollars ("usage left" / "≈N% of your usage"), and the
-- server already strips USD from its own API for them (routes/billing.ts). The budget table itself is
-- locked the same way in user_usage_budgets.sql.
--
-- Who still reads these tables: only the server, through the service-role client (billingLedger,
-- usageAnalytics, costCentre, platformAllowance, stripe, dailyBillingReconciliation, costReconciliation,
-- comic/safety/store, comic/library/repo) and the SECURITY DEFINER billing_* / usage_budget_* functions
-- (EXECUTE for service_role only). The service role bypasses RLS and keeps its grants; definer
-- functions run as their owner. No client code (components/**, services/**, hooks/**, lib/**,
-- contexts/**, live/**), Pages function or Worker reads them (verified by grep on 2026-10-23), so
-- nothing user-facing breaks.
--
-- What it does (idempotent; every step guarded, safe to re-run):
--   1. Drops the three *_read_own SELECT policies.
--   2. Revokes every table privilege from public, anon and authenticated — the lasting layer: if
--      token_billing_foundation.sql is ever re-applied it re-creates the policies, which stay inert
--      without a grant. (Do NOT re-apply the foundation file to undo this: it upserts billing_plans.)
--   3. Re-grants select/insert/update/delete to service_role (harmless; the server's role).
--   4. Keeps RLS enabled (no policy left → no row for a client role even if a grant ever returns).
--   5. Scrubs the server-only publish-gate cost (`costUsd`) from comic_publications.safety rows written
--      before the app stopped storing it (the owner can read their own row via
--      comic_publications_select_own). Nothing reads that key; the anon RPCs read only safety->>'rating'.
--      Only rows that still carry the key are touched; the table has no triggers.
--
-- Deliberately NOT touched: token_wallets (the client reads its token columns in services/db.ts).
--
-- Deploy order: ship the app first (publication.ts no longer writes safety.costUsd), then apply this
-- file; re-applying later is harmless and catches any row written in between. Then run the checks at
-- the bottom and get_advisors(security).

-- ── 1–4. Ledger tables: server only ─────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.generation_cost_events') is not null then
    drop policy if exists generation_cost_events_read_own on public.generation_cost_events;
    alter table public.generation_cost_events enable row level security;
    revoke all on table public.generation_cost_events from public, anon, authenticated;
    grant select, insert, update, delete on table public.generation_cost_events to service_role;
  else
    raise notice 'billing_ledger_client_lockdown: public.generation_cost_events does not exist, skipped';
  end if;

  if to_regclass('public.usage_daily_rollups') is not null then
    drop policy if exists usage_daily_rollups_read_own on public.usage_daily_rollups;
    alter table public.usage_daily_rollups enable row level security;
    revoke all on table public.usage_daily_rollups from public, anon, authenticated;
    grant select, insert, update, delete on table public.usage_daily_rollups to service_role;
  else
    raise notice 'billing_ledger_client_lockdown: public.usage_daily_rollups does not exist, skipped';
  end if;

  if to_regclass('public.token_ledger_entries') is not null then
    drop policy if exists token_ledger_entries_read_own on public.token_ledger_entries;
    alter table public.token_ledger_entries enable row level security;
    revoke all on table public.token_ledger_entries from public, anon, authenticated;
    grant select, insert, update, delete on table public.token_ledger_entries to service_role;
  else
    raise notice 'billing_ledger_client_lockdown: public.token_ledger_entries does not exist, skipped';
  end if;
end $$;

-- ── 5. Publication rows: drop the stored gate cost ──────────────────────────────────────────────
do $$
begin
  if to_regclass('public.comic_publications') is not null then
    update public.comic_publications
       set safety = safety - 'costUsd'
     where safety ? 'costUsd';
  end if;
end $$;

-- ── Post-apply checks (read-only; run by hand) ──────────────────────────────────────────────────
-- Client roles hold no privilege on the three tables (all false):
-- select t, has_table_privilege('authenticated', 'public.' || t, 'select') as auth_select,
--           has_table_privilege('anon', 'public.' || t, 'select') as anon_select
--   from unnest(array['generation_cost_events', 'usage_daily_rollups', 'token_ledger_entries']) as t;
-- No client policy is left on them (0 rows):
-- select tablename, policyname from pg_policies
--  where schemaname = 'public' and tablename in ('generation_cost_events', 'usage_daily_rollups', 'token_ledger_entries');
-- The server's role still has them (all true):
-- select t, has_table_privilege('service_role', 'public.' || t, 'select,insert,update') from unnest(array['generation_cost_events', 'usage_daily_rollups', 'token_ledger_entries']) as t;
-- No stored gate cost is left (0):
-- select count(*) from public.comic_publications where safety ? 'costUsd';
-- No view a client role can read is built on these tables (0 rows expected):
-- select distinct v.relname from pg_depend d join pg_rewrite r on r.oid = d.objid join pg_class v on v.oid = r.ev_class
--  where d.refobjid in ('public.generation_cost_events'::regclass, 'public.usage_daily_rollups'::regclass, 'public.token_ledger_entries'::regclass)
--    and v.oid not in ('public.generation_cost_events'::regclass, 'public.usage_daily_rollups'::regclass, 'public.token_ledger_entries'::regclass)
--    and has_table_privilege('authenticated', v.oid, 'select');
--
-- Rollback (restores the previous exposure; only if a client reader turns up):
-- grant select on table public.generation_cost_events, public.usage_daily_rollups, public.token_ledger_entries to authenticated;
-- then re-create the three *_read_own policies from token_billing_foundation.sql (that block only).
