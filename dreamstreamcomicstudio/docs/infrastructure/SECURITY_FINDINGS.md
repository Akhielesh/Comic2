# Security Findings — Infrastructure

**Status:** Live snapshot. **Last verified:** 2026-06-16 (Supabase `get_advisors` +
repo config). **Companion:** `INFRA_MAP.md`. Re-run `get_advisors` after any DDL change.

> Not exhaustive app-security review — this captures the **infra-level** posture surfaced
> during the cost/dependency audit. Prioritize the 🔴 items.

---

## Supabase advisors — "Comic" project (`bdjfmxfmhqhzvgrhbbzm`)

**216 advisories: 189 WARN, 27 INFO.** Grouped:

| Count | Level | Finding | Meaning |
|---|---|---|---|
| 72 | WARN | `pg_graphql_authenticated_table_exposed` | Tables visible in GraphQL to signed-in users (RLS still gates rows) |
| 68 | WARN | `pg_graphql_anon_table_exposed` | Tables visible in GraphQL to `anon` (RLS still gates rows) |
| 27 | INFO | `rls_enabled_no_policy` | RLS on but no policy = locked (safe default) |
| 18 | WARN | `authenticated_security_definer_function_executable` | SECURITY DEFINER fn callable by signed-in users |
| 18 | WARN | `anon_security_definer_function_executable` | 🔴 SECURITY DEFINER fn callable by `anon` |
| 9 | WARN | `function_search_path_mutable` | Functions with mutable `search_path` |
| 1 | WARN | `rls_policy_always_true` | `notifications` INSERT policy allows unrestricted insert |
| 1 | WARN | `public_bucket_allows_listing` | 🔴 `comic-assets` public bucket allows listing all objects |
| 1 | WARN | `extension_in_public` | `vector` extension installed in `public` schema |
| 1 | WARN | `auth_leaked_password_protection` | HaveIBeenPwned check disabled |

### 🔴 Prioritized
1. **`admin_reset_user(target_email text)` executable by `anon`/`authenticated`** as a
   SECURITY DEFINER function — potential privilege escalation. Revoke EXECUTE from
   `anon`/`authenticated` on all admin/privileged SECURITY DEFINER functions; restrict to
   `service_role`. (36 such exposures total.)
2. **`comic-assets` public bucket allows listing** — clients can enumerate every object.
   Tighten the bucket SELECT policy so objects are fetched by known path/signed URL, not
   listed.
3. **GraphQL/PostgREST table exposure (140)** — RLS gates *rows*, but the broad
   `anon`/`authenticated` SELECT surface is large. Revoke SELECT from `anon` on tables that
   should never be client-readable (telemetry, provider_usage, email, verification,
   connector credentials — several already revoked; reconcile the rest).

### 🟡 Quick wins
- Enable leaked-password protection (Supabase Auth setting).
- Pin `search_path` on the 9 flagged functions (`SET search_path = ''` or explicit schema).
- Move the `vector` extension out of `public` into an `extensions` schema.
- Tighten the `notifications` INSERT policy (currently always-true).

---

## Cloudflare Workers

- 🟡 **`live-worker` ships `ALLOWED_ORIGINS: "*"`** (`live-worker/wrangler.jsonc`). Restrict
  to the real origins (`dreamstreamstudio.ai`, `comic2.pages.dev`). Tracked as open item H4
  in `docs/PLATFORM_HEALTH_2026-06.md`.
- Verify HMAC secrets (`STUDIO_HMAC_SECRET`, `EMAIL_HMAC_SECRET`,
  `SUPABASE_AUTH_HOOK_SECRET`, `DATA_EGRESS_SECRET`) are set as **secrets** (not vars) on
  each worker and rotated if ever exposed.

---

## Change log

| Date | Change |
|---|---|
| 2026-06-16 | Initial snapshot: 216 Supabase advisories triaged; worker CORS + HMAC notes. |
