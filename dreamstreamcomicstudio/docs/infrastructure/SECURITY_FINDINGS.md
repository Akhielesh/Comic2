# Security Findings — Infrastructure

**Status:** Live snapshot. **Last verified:** 2026-06-16 (Supabase `get_advisors` +
repo config); Stream Studio findings (ADR 0006 F1–F18) 2026-10-29; chat web surface and storage
policies (SEC-DS) 2026-11-05. **Companions:** `INFRA_MAP.md`,
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
- **Discover RPCs (`server/sql/comic_discovery.sql`, DS-R2) — written, NOT applied** (lead decision D12 at the S2b
  integration). `comic_discover_list` and `comic_discover_shelves` are SECURITY DEFINER (`search_path = public`) and
  granted EXECUTE to `anon`, so a direct anon RPC call bypasses the edge Worker's `PUBLIC_COMIC_RL` limiter and its 30 s
  cache. Relative rank is visible by paging; no score or count is. A security review of these RPCs comes first, and the
  file is applied with DS-R6 (S3) behind `DISCOVER_V2_STAGE`. Until then the edge route answers 503 calmly. Lead
  decision D11: an `avatarUrl` is sent only from our own storage with no id in the URL, so no owner uid travels in a
  byline (`docs/features/discovery.md` §2).

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

## Chat — connected-account content and model routing (Google Limited Use)

| # | Sev | Finding | Status (2026-11-04) |
|---|---|---|---|
| C1 | High (compliance) | Content from users' connected accounts (Gmail, Drive, Calendar, Sheets, Maps, unified connected-data search, the Nango proxy and the operator's Nango MCP) could reach model endpoints that may log or train on it. OpenRouter request bodies never set `provider.data_collection`; Free only mode (the client default), a pinned free model, the capped-shared-key free chain and the usage-budget free re-plan all ran on `:free` endpoints while connector tools and the connector context block were offered; the swarm's planner and agents (the calendar agent has connector tools) default to a free worker; title / memory / follow-up summaries of such conversations carried no flag; long-term memory distilled from such a conversation was injected into later free turns. | **Partially fixed (C1a, C1d open)** on branch `privacy/connector-routing` (not yet deployed): `server/src/ai/privacy/` decides per turn whether connector content can enter it; such a turn sends `provider: { data_collection: 'deny' }` on every OpenRouter call (tool rounds, retries, fallback, streaming, auto-memory, swarm, recipes, helpers) and never uses a free model (`:free` or $0 in the catalog); free turns get no connector tool, no connector context and no long-term memory; a free turn whose history carries connector content is refused (409, calm copy, nothing sent or spent), with the history recognised by the server's reply provenance store; the free fallbacks never take such a conversation. Turns without connector content are byte-identical. Details: `docs/DATA_CONNECTORS.md` → "Connected-account privacy". |
| C1a | Med | History provenance: the chat client sends history as plain text, so a conversation that read connected data on a standard model and then switches to Free only cannot be recognised from the messages alone. | **Partially fixed.** The server records a hash of every reply connected content actually entered (`chat_connector_replies`, `server/sql/chat_connector_replies.sql`, **apply before deploy**) and refuses a free turn whose history contains one. The chat client now stores the reply's `connectorData: true` on the assistant turn and sends it back in `ChatRequestMessage`. It also marks stored turns whose tool events name a connector tool, and a reply the user stops before it finishes when the stream said the turn may carry connected content (`components/chat/connectorPrivacy.ts`; not yet deployed). **Open:** replies from before the deploy that drew only on the connector context block, while the store is unavailable. Hold the public Limited Use wording until the SQL and both sides have shipped. |
| C1d | Med | Long-term memory: facts distilled from a connected conversation (auto-memory, `POST /api/chat/memory`) were stored unmarked and injected into every later turn, free ones included — server-side (`buildUserMemoryBlock`) and client-side (memory composed into `systemPrompt`). | **Partially fixed.** New memory from such conversations is stored as `chat_studio_connected` and `/memory` answers `connectorData: true`. Every free turn (and the free re-plans, and an unconfirmed direct provider) retrieves memory without the marked rows (`buildUserMemoryBlock(…, { excludeConnected })`), whatever the user's connections; a paid turn that injects a marked row denies data collection. The chat client keeps `/memory`'s `connectorData: true` as a sticky flag on its local memory, synced with the account snapshot, never composes flagged memory into a Free only OpenRouter turn or a turn naming a free model, and sends `memoryConnected: true` with every request while the flag is set: the server then strips that memory from every withheld turn (the usage-budget and capped-key re-plans included), treats it as connector content on paid turns (`deny`), and keeps the `/memory` merge marked (not yet deployed). **Open:** rows written before the deploy are unmarked, so free turns retrieve them (connected users' and users who removed every connection alike). Local memory distilled before the client change is unflagged. |
| C1b | Med (owner) | Direct providers are covered only by the terms of the key's account. Gemini's unpaid API tier may use content to improve products and allows human review. | **Fails closed (not yet deployed).** Until the owner lists a provider in `CONNECTOR_PROVIDERS_CONFIRMED`, a turn on that provider's platform key gets no connected content (no connector tools, no connector context, no memory distilled from connected content; a 409 when the history carries some), and that memory is stored without a Gemini embedding; the memory query of a conversation that may carry connected content is not embedded either (word search instead), nor on any withheld turn of a user with (or maybe with) connections, the usage-budget free re-plan included, whatever is confirmed. **Owner action:** confirm the platform Gemini keys (`GEMINI_API_KEY`, and `ASSISTANT_GEMINI_API_KEY` for memory embeddings) are on a paid (billing-enabled) project; NVIDIA, DeepSeek, Z.ai, MiniMax, Tencent and xAI terms are unverified (`server/src/ai/privacy/providerPolicies.ts`); then set `CONNECTOR_PROVIDERS_CONFIRMED`. Optional: the OpenRouter account's own training opt-out (paid and free). |
| C1c | Low (unverified) | OpenRouter does not document how `data_collection` combines with the `models` fallback array, nor whether providers that keep prompts only for abuse monitoring are excluded under `deny`. | Verify with a real key after deploy: a connector turn on the default chain must answer; a refusal shows "no endpoint for this model promises not to keep or learn from it". |

---

## Chat web surface, MCP, provider budgets and account screens (re-verify of production `4817b38a`, 2026-11-05)

Peer findings from the Atlas session's security re-verify, each reproduced against the code before
it was changed (refuted items would be listed as such; none were). "Fixed" = on branch
`sec/ds-hardening`, with a test that fails without the fix; not yet deployed.

| # | Sev | Finding | Status (2026-11-05) |
|---|---|---|---|
| web-surface-1 | High | `buildMcpTools` honoured a `trusted: true` flag on any server object, and `routes/chat.ts` passes request-body `mcpServers` through unsanitised, so a request could mark `http://127.0.0.1` or cloud metadata as trusted and skip the SSRF guard. | **Fixed:** `trusted` counts only when the URL is one the operator configured (`envDesignMcpServers`, `mayUseInternalHosts` in `mcpClient.ts`), and such a server is then sent exactly as the operator configured it — its URL and its env `*_HEADERS` — never with headers a request attached to a copy of that URL. MCP responses are read with an 8 MB cap after decompression (an error body 16 KB), so a small brotli body cannot inflate past it. The route-side sanitising of `mcpServers` is the Atlas session's PR-1. |
| web-surface-2 / abuse-ops-10 | High | Pre-auth `/api/chat/read-url` and the deep-research reader checked only the first URL (`assertSafePublicUrl` / `isSafeMcpUrl`) and then fetched with redirects followed, so a public page could 302 the server into `127.0.0.1` / `169.254.169.254`. | **Fixed:** both read through `fetchTextCapped({ publicOnly: true })` → `fetchPublicUrl` (every hop re-checked). A 302 to an internal address now fails after exactly one request. |
| abuse-ops-1 | Med–High | Anonymous unfurl / read-url could freeze or exhaust the container: (a) timeouts covered only the headers, (b) bodies were read whole, (c) whole-document regexes backtracked (~7 s on 300 KB), (d) the unfurl cache was unbounded, (e) anonymous callers could spend the shared Jina quota. | **Fixed:** one deadline through the body and a streamed byte cap (`fetchTextCapped`; `fetchJson` / `fetchText` also read their bodies inside the deadline and the caller's cancel); read-url downloads ≤ 1 MB and parses all of it (a `<main>` / `<article>` still open at the cap is read from its opening tag); linear `indexOf` scanners (`htmlScan.ts`) in which every `>` and close-tag search is cached and moves forward only — including a run of openers sharing one far `>` (`'<p'.repeat(n)+'>'`), which the first version still rescanned per opener (3.1 s at 1 MB, now a few ms) — with timing tests at 256 KB and 1 MB; meta tags over 2 KB skipped and attribute values over 1000 chars dropped; lead-image URLs over 2048 chars dropped; unfurl cache LRU-bounded at 500 with clipped owned copies and expiry swept on access (no timer); Jina only when the caller allows it (`readArticle(url, signal, { allowJina })`, defaulting to "a signed-in account is in this request's context", so a route or job with no account context fails closed). Page text is decoded in its declared charset. Page reads are metered per host (`page:<host>`, ≤ 500 hosts tracked) so a URL naming a provider cannot spend that provider's budget. Route-level limiters for `/unfurl` and `/read-url` are the Atlas session's PR-1. |
| abuse-ops-6 | Med | Foursquare and YouTube searches called `fetch` directly and bypassed `assertProviderBudget`; YouTube would also have shared the Custom Search bucket. | **Fixed:** both go through `fetchJson`; budgets Foursquare 20/min · 300/day, YouTube 10/min · 80/day (`DATA_CONNECTORS.md`). The first fix still metered by patterns run over the WHOLE URL, so user text in a query string moved a call between budgets (an anonymous `/api/chat/tool-refresh` `find_places` for "pizza bing.com" metered as `bing-scrape`, a YouTube search for "api.tavily.com" spent Tavily's budget); `providerForUrl` now matches the host only (YouTube = the googleapis host plus its `/youtube/` path). The check now reserves the call before it is sent, so concurrent requests cannot all pass at the same count (30 parallel Foursquare searches reach the network at most 20 times). **Open:** a per-anonymous-caller share of each budget — `providerUsage` has no caller identity beyond `anon`; needs the request IP (or a signed visitor id) threaded into the account context. |
| N8 | Low | DNS rebinding between the resolved-IP check and the connect (`fetch` looked the name up again). | **Fixed** for every MCP request and `fetchPublicUrl`: `pinnedFetch` (`safeNet.ts`) connects with a lookup hook that refuses private / loopback / link-local / ULA / metadata answers (IPv4-mapped, NAT64, 6to4 decoded) and passes only the checked addresses to the socket. `convert_image` (`convertImage.ts`) now fetches through `pinnedFetch` too (a 3xx is refused). |
| authz-data-5 | Low–Med | Settings derived admin / moderator from an email literal (the old test address) whenever `/api/admin/me` failed; the same literal also made the assistant's account summary call that address an admin, defaulted `ADMIN_EMAILS` in the last-admin guard's count, and gated the client's diagnostics probe. | **Fixed:** `useAdminAccess` takes roles only from the server flag; a failed check means no access. `routes/assistant.ts` takes admin only from the server-held plan (tier `admin`; no billing answer = free, not admin); `routes/admin.ts` counts the bootstrap list `requireAdmin` honours (`rbac.parseAdminEmails`); `App.tsx` gates diagnostics on `useAdminAccess`; `UniversalAssistant.tsx` sends no `isAdmin`. `tests/config/adminLiteralGuard.test.ts` fails on the literal in any source file. |
| storage-avatar | Functional | Browser uploads (`saveImage`) wrote to `u/<uid>/tmp/…`, but the `comic-assets` policies ("Authenticated Upload", "Authenticated Manage") require the first folder to be the uid, so every browser upload — avatars included — was refused. Verified with read-only catalog queries (`pg_policies`, 2026-11-05). | **Fixed in code (no SQL):** browser uploads go to `<uid>/<file>`, the classic lane every reader already resolves; only png / jpeg / webp / gif / avif; avatars ≤ 5 MB and not registered with image-asset retention (`profiles.avatar_url` is not scanned by `collect_active_image_paths`, so a registered avatar would be purged after 30 + 15 days). |

**Deferred (design / owner):**
- authz-data-7 — storage paths redesign (signed URLs or opaque copies for classic readers), Program 3.
- Owner storage steps: MIME and size limits on `comic-assets` (currently none; `public = true`); deleting
  the typo bucket `comic-aasets` and its 4 public-role policies (destructive — owner only, after
  checking it is empty or backed up).
- `client_privilege_lockdown_2026_11` (Atlas, owner go pending): `profiles` column-locked to `username`,
  `avatar_url`, `marketing_consent`; `usage_limits` read-only for clients. DreamStream's client writes
  today: `services/db.ts` `updateUserProfile` (username + avatar_url, from `AccountSettings.tsx`; its type
  now admits only the three allowed columns) and `syncMarketingConsentLegacy` (marketing_consent);
  `usage_limits` is only read (`services/db.ts` `getUsageLimits`). Nothing to move server-side first.

### Rule for every new migration (N4 — default ACL)

Supabase grants `anon` and `authenticated` full table privileges on new tables in `public` by default,
so a table without RLS is readable and writable by any client the moment it is created. Every new
`server/sql/*.sql` file must, in the same file:

1. `alter table … enable row level security;` for every table it creates (no exceptions — server-only
   tables get RLS with no policies);
2. `revoke all on … from anon, authenticated;` and then `grant` back only what the client really needs
   (most tables need nothing: the server uses the service role);
3. pin `set search_path = public` (or `''`) on every function, `revoke execute … from public, anon,
   authenticated` on SECURITY DEFINER functions the client does not call, and grant `service_role`;
4. after applying, re-run `get_advisors(security)` and record anything new here.

---

## Change log

| Date | Change |
|---|---|
| 2026-06-16 | Initial snapshot: 216 Supabase advisories triaged; worker CORS + HMAC notes. |
| 2026-10-02 | AI-agent gate at the edge: AI crawlers/agents get a 50-question check-in + synthetic canary record instead of pages; known AI agents get 403 on `/api/*` before the request reaches Railway (`api-proxy/src/agent-gate.ts`, `functions/_middleware.ts`). Plain HTTP clients, webhooks and search engines are unaffected. |
| 2026-10-29 | Stream Studio / baby monitor findings F1–F18 (ADR 0006) with their Phase 0 status; leaked-password note updated (backend Pwned Passwords check); `SECURITY_HOOK_SECRET` added to the HMAC secrets. Runbook: `live-security-runbook.md`. |
| 2026-11-04 | Chat connected-account privacy C1–C1c (Google Limited Use): connector turns deny OpenRouter data collection and never use free models; free turns get no connector content. |
| 2026-11-04 | C1 review: reply provenance store (C1a partly fixed), memory marked and kept off free turns (C1d), $0 catalog models count as free, the operator's Nango MCP is a connector, honest capacity and refusal copy, connector swarm holds priced. C1 status now "Partially fixed". |
| 2026-11-05 | SEC-DS: web-surface-1/2, abuse-ops-1/6/10, N8, authz-data-5 fixed on `sec/ds-hardening` (not yet deployed); browser uploads moved to the policy-allowed `<uid>/<file>` lane; N4 migration rule added; deferred storage and lockdown items listed. |
| 2026-11-05 | SEC-DS review round: host-only provider metering and reserve-at-check budgets (abuse-ops-6); `forEachBlock` made linear and read-url parses its whole 1 MB download (abuse-ops-1); meta / attribute / image-URL limits; charset decoding; explicit `allowJina`; `fetchJson` body inside the deadline; MCP operator headers and an 8 MB response cap (web-surface-1); `convert_image` pinned (N8); the remaining email-literal admin derivations removed (authz-data-5). |
| 2026-11-05 | **Fixed (BK-0):** `POST /api/keys/validate` described the platform OpenRouter key to anyone and `GET /api/models/verify` showed platform-key telemetry to any signed-in user. Both now check only the caller's own keys; platform telemetry is admin-only. |
| 2026-11-05 | **Fixed:** the platform OpenRouter key was sent to other vendors. `platformKeyFor()` fell back to it for any provider without its own platform key, and the public `GET /api/models/catalog` lists every direct provider's models on each request, so the OpenRouter secret went to OpenAI, Anthropic, DeepSeek, xAI, Z.AI, MiniMax and Tencent `/models` endpoints. A named provider now gets only its own platform key, or none (`server/src/ai/gateway.ts`; test `gateway.platformKey.test.ts`). The OpenRouter key should be rotated: those vendors received it in failed-auth requests. |
| 2026-11-12 | **Fixed (C1b gap, not yet deployed):** every signed-in Chat Studio turn with memory on embedded its last user message (up to 8,000 characters) through the platform Gemini key to search long-term memory, on free and withheld turns too and ignoring `CONNECTOR_PROVIDERS_CONFIRMED`; that message can carry connected content (follow-up chips built from connected replies, pasted connected items). The query is now never embedded for a conversation that may carry connected content until `gemini` is confirmed, nor on any withheld turn of a user with (or maybe with) connections, whatever is confirmed: free turns, unconfirmed direct providers and the usage-budget free re-plan, which withholds a turn after it was prepared as paid (`runChatParams` derives that half from `connectorPrivacy`). Memory is found by word search and recency instead (`prepareChat` `memoryNoQueryEmbedding` and `runChatParams` → `services/userMemory.ts` `noQueryEmbedding`; the gate reuses the turn's own connection and provenance lookups; test `routes/chat.memoryQueryAndHelpers.test.ts`). Also: every chat helper (enhance, title, memory, auto-memory, memory import, follow-ups) sent the OpenRouter model slug to direct providers and failed silently; it now calls the provider's own default model (`helperModelFor`), the wave 0 helper gates unchanged, and `POST /api/chat/memory` receives the source the turn ran on from the client (`reqSource`; test `components/chat/AIChatPlatform.memorySource.test.tsx`). |
| 2026-11-12 | S2b integration (`integ/s2b`, not deployed): the Discover RPCs are listed as deferred (D12: security review before they are applied, with DS-R6); Discover bylines never carry an owner uid (D11). One support address on DreamStream surfaces, `SUPPORT_EMAIL` (D9). |
