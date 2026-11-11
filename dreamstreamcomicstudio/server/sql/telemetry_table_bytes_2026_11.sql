-- telemetry_table_bytes (2026-11) — the size the telemetry store checks before it writes (abuse-ops-3).
--
-- server/src/services/telemetryStore.ts calls public.telemetry_table_bytes() at most once per 5
-- minutes; above 150 MB in telemetry_events + user_feedback it stops storing (everything is still
-- logged), except a signed-in person's feedback (to 160 MB) and the server's own 5xx records (to
-- 170 MB). Until this function exists the check is skipped.
--
-- This is only the read-only size function from SECURITY-PLAN §2.4f, identical to it. The purge and
-- its cron schedule in §2.4f delete data, so they wait for the owner to choose the retention periods
-- (O8) and are not here.
--
-- STABLE SECURITY DEFINER with `search_path = ''`; EXECUTE for service_role only (a new function is
-- executable by PUBLIC, anon and authenticated by default — SECURITY-PLAN N4 — hence the revoke).
-- Additive and idempotent. Rollback: drop function if exists public.telemetry_table_bytes();

create or replace function public.telemetry_table_bytes() returns bigint language sql stable security definer set search_path = '' as $$
  select pg_total_relation_size('public.telemetry_events') + pg_total_relation_size('public.user_feedback')
$$;
revoke all on function public.telemetry_table_bytes() from public, anon, authenticated;
grant execute on function public.telemetry_table_bytes() to service_role;
