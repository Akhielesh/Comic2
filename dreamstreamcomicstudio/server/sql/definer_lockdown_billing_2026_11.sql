-- Definer lockdown for billing and usage counters (2026-11). Migration name: definer_lockdown_billing_2026_11
--
-- Why: six SECURITY DEFINER functions in public were EXECUTE-able by PUBLIC / anon / authenticated and
-- trust the caller's arguments (p_user_id etc.) with no auth.uid() / auth.role() check, so anyone with the
-- public anon key could rewrite any user's token_wallets (purchased credits, pending overage, reserved
-- tokens), bump free-tier and model usage counters, or call admin_reset_user. Every legitimate caller is
-- server-side through the service-role client:
--   billing_try_reserve_tokens / billing_release_reserved_tokens / billing_settle_tokens
--     → server/src/services/billingLedger.ts (getBillingAdmin)
--   free_tier_try_consume_model_usage → server/src/services/modelAccessPolicy.ts (getSupabaseAdmin)
--   bump_model_usage                  → server/src/services/modelStats.ts (getSupabaseAdmin)
--   admin_reset_user                  → no caller in the code
-- so revoking client EXECUTE breaks nothing. It complements security_hardening_definer_lockdown_2026_06.sql
-- (never applied; its list omits free_tier_try_consume_model_usage and bump_model_usage).
--
-- What it does (idempotent; every overload of each name, found by name in pg_proc):
--   revoke EXECUTE from PUBLIC, anon, authenticated; grant EXECUTE to service_role.
-- A later `create or replace` keeps these grants; a DROP + CREATE would re-grant EXECUTE to PUBLIC by
-- default, so re-run this file after any such re-creation.
--
-- Deliberately NOT here (client code still calls them; each needs a server path first):
--   resolve_email_from_username (AuthPage username login), increment_/decrement_project_* counters.
--
-- Rollback (restores the previous exposure; only if a client caller turns up):
--   grant execute on function public.<name>(<args>) to anon, authenticated;   -- per function

do $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select p.oid::regprocedure as fn
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname in (
         'billing_settle_tokens',
         'billing_try_reserve_tokens',
         'billing_release_reserved_tokens',
         'free_tier_try_consume_model_usage',
         'bump_model_usage',
         'admin_reset_user'
       )
  loop
    execute format('revoke execute on function %s from public', r.fn);
    execute format('revoke execute on function %s from anon', r.fn);
    execute format('revoke execute on function %s from authenticated', r.fn);
    execute format('grant execute on function %s to service_role', r.fn);
    n := n + 1;
  end loop;
  raise notice 'definer_lockdown_billing_2026_11: % function(s) locked to service_role', n;
end $$;

-- Post-apply assertion: fail the migration rather than leave one of them client-callable.
do $$
begin
  if exists (
    select 1
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname in (
         'billing_settle_tokens',
         'billing_try_reserve_tokens',
         'billing_release_reserved_tokens',
         'free_tier_try_consume_model_usage',
         'bump_model_usage',
         'admin_reset_user'
       )
       and (has_function_privilege('anon', p.oid, 'execute')
            or has_function_privilege('authenticated', p.oid, 'execute')
            or not has_function_privilege('service_role', p.oid, 'execute'))
  ) then
    raise exception 'definer_lockdown_billing_2026_11: a locked function is still client-callable or not server-callable';
  end if;
end $$;

-- Post-apply check (read-only):
-- select p.oid::regprocedure, has_function_privilege('anon', p.oid, 'execute') anon,
--        has_function_privilege('authenticated', p.oid, 'execute') auth,
--        has_function_privilege('service_role', p.oid, 'execute') svc
--   from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
--  where ns.nspname = 'public' and p.proname in ('billing_settle_tokens','billing_try_reserve_tokens',
--    'billing_release_reserved_tokens','free_tier_try_consume_model_usage','bump_model_usage','admin_reset_user');
--   -- anon false, auth false, svc true for every row
