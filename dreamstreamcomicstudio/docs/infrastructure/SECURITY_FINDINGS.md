# Security Findings — Infrastructure

**Status:** Live snapshot. **Last verified:** 2026-06-16 (Supabase `get_advisors` +
repo config); Stream Studio findings (ADR 0006 F1–F18) 2026-10-29. **Companions:** `INFRA_MAP.md`,
[`live-security-runbook.md`](./live-security-runbook.md). Re-run `get_advisors` after any DDL change.

> Not exhaustive app-security review — this captures the **infra-level** posture surfaced
> during the cost/dependency audit. Prioritize the 🔴 items.

---

## ✅ Fixed 2026-06-16 (see `server/sql/security_hardening_2026_06.sql`)

- **`search_path` pinned** on the 8 non-admin functions flagged
  `function_search_path_mutable` (`handle_new_user`, `increment_project_like/view`,
  `redeem_coupon`, `collect_active_image_paths`, `increment_venture_spend`,
  `match_user_memories`, `touch_updated_at`). Verified `search_path=public` on all 8.
- **Public bucket enumeration closed** — dropped the broad `Public Access` SELECT policy
  on `storage.objects` so clients can no longer list every object in `comic-assets`.
  Image display (public URLs / signed URLs) unaffected; verified 0 such policies remain.

## ⏳ Deferred by decision / risk (not applied)

- **Admin SECURITY DEFINER functions** (`admin_reset_user` etc.) — a scoped lockdown
  migration is now **written but NOT yet applied** to prod:
  `server/sql/security_hardening_definer_lockdown_2026_06.sql`. It revokes EXECUTE from
  `anon`/`authenticated`/`public` and grants `service_role` on the 4 functions verified to
  be **never called client-side** (`admin_reset_user`, `billing_try_reserve_tokens`,
  `billing_release_reserved_tokens`, `billing_settle_tokens`) — this preserves admin access
  (service_role + SQL editor) while closing the anon privilege-escalation surface. The
  client-called definer fns (`resolve_email_from_username` [anon login],
  `increment_project_view/like`, `register_image_asset`, `redeem_coupon`) are intentionally
  left callable. **Applying it is a high-severity prod permission change requiring explicit
  authorization** (originally deferred per owner) — apply via Supabase MCP `apply_migration`
  / SQL editor, then re-run `get_advisors(security)`.
- **GraphQL anon/authenticated table exposure (140)** — RLS gates rows; a blanket `anon`
  SELECT revoke would break the frontend's direct reads of owner-scoped tables, so it needs
  per-table review + app testing, not a blind fix.
- **`notifications` always-true INSERT** — tightening risks breaking cross-user notification
  creation; audit the insert path first.
- **`vector` extension in `public`** — moving it risks breaking pgvector usage; low real
  risk, left in place.
- **Leaked-password protection** — Supabase's own check needs the Pro plan (Authentication →
  Attack Protection); decision pending (ADR 0006 owner action #3). Meanwhile the backend checks
  new passwords against Pwned Passwords at sign-up (k-anonymity, `PWNED_PASSWORDS_CHECK`,
  ADR 0006 WS-4).
- **Typo'd duplicate bucket `comic-aasets`** — left untouched (may hold orphaned objects;
  never delete without verifying empty/backed up).

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

- ✅ **`live-worker` `ALLOWED_ORIGINS` tightened** from `"*"` to
  `https://dreamstreamstudio.ai,https://comic2.pages.dev` (2026-06-16, finding H4). Takes
  effect on the next live-worker deploy; append any additional production origin first.
  Since 2026-10-22 `comic2.pages.dev` only 301s to the custom domain, so its entry serves
  tabs opened before the switch; remove it in a later cleanup.
- Verify HMAC secrets (`EMAIL_HMAC_SECRET`, `SUPABASE_AUTH_HOOK_SECRET`,
  `SECURITY_HOOK_SECRET`, `DATA_EGRESS_SECRET`) are set as **secrets** (not vars) on each worker
  and rotated if ever exposed — rotation order for each: `live-security-runbook.md` §1.
  (`STUDIO_HMAC_SECRET` went with Code Studio, ADR 0005 — delete it wherever it still exists.)

---

## Stream Studio / baby monitor — ADR 0006 findings (F1–F18)

From the 2026-10-22 STRIDE study (`docs/research/2026-10-native-watch-localfirst/security.md` §3).
"Built" means the code is written and tested on its workstream branch and switches on when its
wave deploys (capability-gated); "Fixed" means live in production.

| # | Sev | Finding | Status (2026-10-29) |
|---|---|---|---|
| F1 | High | Sockets authorised once, never re-checked | Built: local JWT verification + role cache (WS-4), `reauth` in the apps (WS-5/WS-6). **Open until** the rooms enforce `exp + 120 s` and `reauth` (WS-9/WS-10, Wave 2). |
| F2 | High | Removed members keep getting monitor pushes | **Open until** WS-9 (`/x/members` prunes `push` and `callPush`). |
| F3 | High | A removed guest rejoins with the same link and passcode | Built: `removeGuest` can rotate link + passcode (WS-4), "Link and passcode changed" UI (WS-6). **Open until** WS-9 passes `rotate`. Phase 1: single-use, device-bound invites. |
| F4 | High (design) | Relay frames in plaintext through the DO; SDP readable / modifiable | Built: Nursery Media Key, sealed frames and signaling (WS-2, WS-6). **Open until** the room lists `e2e1` (WS-9). Active server compromise stays possible until Phase 1's verified admission (ADR D6.4). |
| F5 | High | No CSP / headers; refresh token in `localStorage`; no MFA; local-only sign-out | **Fixed (headers):** HSTS, nosniff, Referrer-Policy, Permissions-Policy, framing blocked on Stream Studio (WS-1); CSP Report-Only, enforced on Stream Studio after 48 h clean. Built: TOTP + `aal2`, real "Sign out everywhere" (WS-4/5/7). The token stays in `localStorage` on the web (CSP is the mitigation; native apps use the Keychain / Keystore). |
| F6 | Med | Removal only takes effect if the removing client tells the room | Built: `POST /api/monitor/:nid/members` (WS-7) used by the apps when the room lists `reauth` (WS-6). **Open until** Wave 2. |
| F7 | Med | Any caregiver socket can take over a running camera | **Open until** WS-9 (same uid only; refusals counted as `camera_spoof_refused`). Phase 1: camera pairing credential. |
| F8 | Med | Pre-auth socket exhaustion | Built: `RL_WS` (WS-7). **Open until** WS-9/WS-10's separate pre-auth pool (8, oldest evicted) and 5 s auth timeout. |
| F9 | Med | No MFA, local-only sign-out, no new-device alerts | Built (WS-4/WS-5). Live once the owner applies `live_security_v2.sql`, turns TOTP on and switches the hook on (owner checklist §3–§4). |
| F10 | Med | One shared 24 h TURN credential | **Fixed 2026-10-22:** per room + person + payer, ≤ 4 h members / ≤ 2 h guests, revoked on removal (`ice.ts`). |
| F11 | Med | Guest pass is a 90-day bearer token | Phase 1 (device-bound per-guest invites). |
| F12 | Low–Med | Missing least privilege in `onQuery`, `onLog`; guests can end `everyone` hazards | Built: `guestCaps` / `guestAckEnds` (WS-4). **Open until** WS-9 gates the handlers. |
| F13 | Low–Med | Guest limiter in memory; 20 wrong tries disable a link | Built: `RL_GUEST` / `RL_GUEST_NID` (WS-7), per-guest lockout (WS-4, WS-9 opts in). |
| F14 | Low | `onRtc` lets admin / line sockets signal viewers | **Open until** WS-9 (camera ↔ viewer only). |
| F15 | Low | No `Origin` allowlist on upgrades | Built: `origin.ts` (WS-7). |
| F16 | Low | Stream Studio host / guest keys in query strings | **Open until** WS-11 (first-frame auth, `DS-Event` header, constant-time compare). |
| F17 | Med | Supply chain | **Fixed (WS-1):** `npm audit --omit=dev` 0, `onnxruntime-web` 1.30.0, `supabase-js` 2.118, every action SHA-pinned, Dependabot with a 7-day cooldown, CODEOWNERS, Scorecard, the third-party importmap and the Hugging Face model fallback removed. Owner: one Cloudflare token per Worker, protected Environments (owner checklist §6–§7). |
| F18 | Info | Push payloads carry baby and nursery names | Web Push keeps them (encrypted to the browser). Native pushes never carry the nursery name and seal everything else to the device (WS-3; Phase 1). |

Watch them: Admin → Costs → **Security** (counts only). When something looks wrong:
`live-security-runbook.md` §6 and §8.

---

## Change log

| Date | Change |
|---|---|
| 2026-06-16 | Initial snapshot: 216 Supabase advisories triaged; worker CORS + HMAC notes. |
| 2026-10-02 | AI-agent gate at the edge: AI crawlers/agents get a 50-question check-in + synthetic canary record instead of pages; known AI agents get 403 on `/api/*` before the request reaches Railway (`api-proxy/src/agent-gate.ts`, `functions/_middleware.ts`). Plain HTTP clients, webhooks and search engines are unaffected. |
| 2026-10-29 | Stream Studio / baby monitor findings F1–F18 (ADR 0006) with their Phase 0 status; leaked-password note updated (backend Pwned Passwords check); `SECURITY_HOOK_SECRET` added to the HMAC secrets. Runbook: `live-security-runbook.md`. |
