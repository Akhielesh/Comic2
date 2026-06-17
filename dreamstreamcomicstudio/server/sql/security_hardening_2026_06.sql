-- Security hardening — 2026-06 infra audit
-- Idempotent. Applied to production Supabase project "Comic" (bdjfmxfmhqhzvgrhbbzm)
-- on 2026-06-16 via the Supabase MCP (migrations: harden_function_search_path,
-- harden_comic_assets_public_listing). Kept here for version control per the
-- server/sql convention. See docs/infrastructure/SECURITY_FINDINGS.md.

-- 1) Pin search_path on app functions flagged `function_search_path_mutable`.
--    Pinning to `public` preserves behavior (all referenced objects, incl. the
--    pgvector type/operators, live in public) while removing the mutable-
--    search_path attack vector on SECURITY DEFINER functions.
--    NOTE: admin_reset_user is intentionally left untouched (admin access kept
--    as-is per owner decision, 2026-06-16).
alter function public.handle_new_user() set search_path = public;
alter function public.increment_project_like(uuid) set search_path = public;
alter function public.increment_project_view(uuid) set search_path = public;
alter function public.redeem_coupon(text) set search_path = public;
alter function public.collect_active_image_paths() set search_path = public;
alter function public.increment_venture_spend(uuid, uuid, numeric, bigint, numeric) set search_path = public;
alter function public.match_user_memories(uuid, public.vector, integer) set search_path = public;
alter function public.touch_updated_at() set search_path = public;

-- 2) Remove the broad "Public Access" SELECT policy that let any client enumerate
--    every object in the public `comic-assets` bucket (public_bucket_allows_listing).
--    Safe: the app serves images via public-bucket URLs (getPublicUrl) and
--    service-role signed URLs, both of which bypass this RLS policy; there are no
--    client-side storage .list()/.download() calls on the bucket. Owner-scoped
--    access for signed-in users is preserved by the "Authenticated Manage" /
--    "Authenticated Upload" policies. No object data is deleted.
drop policy if exists "Public Access" on storage.objects;

-- =====================================================================================
-- DEFERRED (NOT applied here — require review/decision; documented for follow-up):
--   * admin_reset_user + the other SECURITY DEFINER functions executable by
--     anon/authenticated — left as-is per owner ("leave admin access as is").
--   * 140 pg_graphql_{anon,authenticated}_table_exposed — RLS already gates rows;
--     revoking anon/authenticated SELECT must be done per-table (the frontend anon
--     client reads several owner-scoped tables directly), so it needs app testing,
--     not a blanket revoke. Risky on the live app.
--   * notifications "always true" INSERT policy — tightening could break
--     cross-user notification creation; needs the insert path audited first.
--   * `vector` extension in `public` schema — moving it risks breaking pgvector
--     usage (match_user_memories); low real risk, left in place.
--   * Auth: enable leaked-password protection — Supabase Auth dashboard setting
--     (Authentication → Settings), no SQL/MCP path.
--   * Storage: a typo'd duplicate bucket `comic-aasets` exists alongside
--     `comic-assets`. Left untouched (may hold orphaned objects — never delete
--     without verifying it is empty / backed up).
-- =====================================================================================
