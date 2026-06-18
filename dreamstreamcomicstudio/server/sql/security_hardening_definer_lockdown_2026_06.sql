-- Security hardening (follow-up) — lock down anon/authenticated-executable admin/
-- server-only SECURITY DEFINER functions. 2026-06.
--
-- Context: the Supabase security advisor flags `admin_reset_user` (and siblings) as a
-- P0 — a SECURITY DEFINER function callable by `anon` is a privilege-escalation surface
-- (anyone unauthenticated can invoke privileged logic). The 2026-06-16 pass deferred this
-- ("leave admin access as is"); this migration closes it WITHOUT removing admin access:
--   * The app never calls these from the client (verified in source: no supabase.rpc()
--     references). The server calls the billing_* functions via the service-role admin
--     client, which BYPASSES execute grants. admin_reset_user is admin tooling run via
--     the service role / SQL editor. So locking EXECUTE to service_role preserves every
--     real caller while removing the anon/authenticated exposure.
--
-- Deliberately SCOPED to functions confirmed NOT called by the client. The following
-- SECURITY DEFINER functions ARE invoked client-side and are intentionally left callable:
--   resolve_email_from_username (anon username login — needs a rate-limited backend
--   endpoint before it can be revoked), increment_project_view/like, decrement_project_like,
--   register_image_asset, redeem_coupon.
--
-- Idempotent (safe to re-run) and signature-agnostic (handles overloads; skips any
-- function that doesn't exist). Reversible: re-grant EXECUTE to anon, authenticated.
-- After applying, re-run get_advisors(security) to confirm the count dropped.

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'admin_reset_user',
        'billing_try_reserve_tokens',
        'billing_release_reserved_tokens',
        'billing_settle_tokens'
      )
  loop
    execute format('revoke execute on function %s from public', r.fn);
    execute format('revoke execute on function %s from anon', r.fn);
    execute format('revoke execute on function %s from authenticated', r.fn);
    execute format('grant execute on function %s to service_role', r.fn);
  end loop;
end
$$;
