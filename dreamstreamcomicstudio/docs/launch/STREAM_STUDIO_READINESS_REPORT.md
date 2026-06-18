# DreamStream / Stream Studio Launch Readiness Report

> Generated: 2026-06-18 from repo state, live smoke output, Cloudflare/Railway/Supabase CLI evidence, and council findings.
>
> Updated: 2026-06-18 after the Pages fallback live-worker fix. `comic2.pages.dev` now ships a Stream Studio bundle that references `dreamstream-live.akhieleshsrirangam.workers.dev`, and the fallback live-worker smoke passes. The remaining P0 launch blockers are the custom-domain Cloudflare challenge and real browser E2E proof.
>
> Launch source of truth: [`JUNE_25_STREAM_STUDIO_MVP.md`](JUNE_25_STREAM_STUDIO_MVP.md). Technical map: [`STREAM_STUDIO_SYSTEM_MAP.md`](STREAM_STUDIO_SYSTEM_MAP.md).

## Executive verdict

DreamStream is moving in the right direction only if June 25 is treated as a **focused Stream Studio beta**, not a full-suite launch.

The product can become a valuable subscription business, but today it is **not invite-ready** because the canonical custom domain is behind a Cloudflare security challenge and the real browser/media end-to-end Stream Studio flow is not yet proven.

The highest-leverage path is:

1. keep the homepage and docs focused on Stream Studio;
2. keep the temporary Pages-domain live-worker bundle/endpoint smoke green with `npm run ops:live-smoke:temporary`;
3. fix the custom-domain Cloudflare challenge;
4. run a real browser E2E smoke: create → host studio → viewer join → chat/reaction → live stream → end → replay/recording;
5. tighten trust/security/access copy;
6. only then discuss pricing/subscription activation with owner approval.

## Current launch status

| Area | Status | Evidence |
|---|---|---|
| Production branch | Green | `Dreamstrream-v1` clean and pushed. CI `docs: map Stream Studio launch architecture` passed. |
| Frontend temporary app | Pass | `https://comic2.pages.dev/` returns app shell. |
| Stream Studio shell | Pass | `https://comic2.pages.dev/live.html` returns app shell. |
| Main Railway backend | Pass | `https://comic2-production.up.railway.app/api/health` returns health ok; Railway `Comic2` online. |
| Primary custom domain | Fail | `https://dreamstreamstudio.ai/` returns Cloudflare security verification HTTP 403. |
| Temporary live-worker path | Pass | `comic2.pages.dev/live.html` bundle references `dreamstream-live.akhieleshsrirangam.workers.dev`; `npm run ops:live-smoke:temporary` passes the temporary Pages shell, bundle, workers.dev no-write probe, and Railway health targets. |
| Supabase project | Healthy with warnings | Project `Comic` ref `bdjfmxfmhqhzvgrhbbzm` is `ACTIVE_HEALTHY`; advisors show 425 rows, 291 WARN. |
| Product scope | Improved | Homepage/docs now focus Stream Studio as the launch wedge. |
| Subscription activation | Not approved | Must not happen without explicit approval and benefit/cost memo. |

## Evidence commands from this pass

```txt
git status --short --branch
# ## Dreamstrream-v1...origin/Dreamstrream-v1

npm run ops:live-smoke
# FAIL primary app — Cloudflare challenge/interstitial
# PASS fallback app — app shell returned
# PASS stream studio — app shell returned
# PASS stream studio bundle — live bundle references dreamstream-live.akhieleshsrirangam.workers.dev
# PASS fallback live worker — missing-event probe returned JSON 404
# FAIL custom-domain live worker — Cloudflare challenge/interstitial
# PASS railway api — health ok

npm run ops:live-smoke:temporary
# PASS fallback app — app shell returned
# PASS stream studio — app shell returned
# PASS stream studio bundle — live bundle references dreamstream-live.akhieleshsrirangam.workers.dev
# PASS fallback live worker — missing-event probe returned JSON 404
# PASS railway api — health ok

railway status
# Project hospitable-enthusiasm / service Comic2 online

wrangler pages project list
# comic2: comic2.pages.dev, dreamstreamstudio.ai

supabase projects list -o json
# Comic bdjfmxfmhqhzvgrhbbzm ACTIVE_HEALTHY us-west-2

supabase db advisors --linked --type all --level info --fail-on none -o json
# 425 total, 291 WARN, 134 INFO
```

## P0 launch blockers

### Resolved — Temporary Pages live-worker path

**Previous severity:** critical
**Owner:** SRE / Full-stack / CTO
**Current status:** resolved for the temporary Pages fallback; keep smoke checks to prevent regression.

Evidence now passing:

```txt
PASS stream studio bundle — live bundle references dreamstream-live.akhieleshsrirangam.workers.dev
PASS fallback live worker — missing-event probe returned JSON 404
```

Implemented fix path:

1. `live/config.ts` routes `comic2.pages.dev` to `https://dreamstream-live.akhieleshsrirangam.workers.dev`.
2. `live-worker/wrangler.jsonc` enables `workers_dev`.
3. `scripts/ops/liveSmoke.ts` verifies both the reachable worker endpoint and the deployed `live.html` bundle string so stale/misbuilt Pages deploys are caught.

Remaining approval needed:

- Cloudflare WAF/ruleset edit access, or dashboard-guided change, if fixing the canonical custom-domain challenge.

### P0-1 — Primary custom domain is blocked by Cloudflare security verification

**Severity:** critical for public launch; high for controlled beta if using Pages fallback  
**Owner:** SRE / CTO  
**User impact:** users may not reach `dreamstreamstudio.ai`; automation and smoke checks see Cloudflare challenge.

Evidence:

```txt
FAIL primary app (https://dreamstreamstudio.ai/) — HTTP 403 — Cloudflare challenge/interstitial returned instead of app shell
```

Current decision:

- Use `comic2.pages.dev` as temporary launch domain.
- Keep `dreamstreamstudio.ai` as a P0 polish/trust blocker before broader public launch.

Required next approval if fixing:

- Scoped Cloudflare API token or dashboard access for `dreamstreamstudio.ai` WAF/rulesets.
- Do not disable security globally; fix only app/API challenge behavior.

### P0-2 — End-to-end Stream Studio workflow is not proven

**Severity:** critical  
**Owner:** Full-stack QA / UX / SRE  
**User impact:** no confidence that the paid-value path works under real browser/media conditions.

Required smoke:

1. open Stream Studio;
2. create event;
3. open host studio link;
4. open viewer link in second browser/profile;
5. join with only a name;
6. chat/reaction;
7. start stream with camera/screen;
8. verify viewer playback;
9. end stream;
10. verify replay/recording/summary.

No longer blocked by the temporary fallback live-worker route; next blocker is real browser/media execution and, for public launch, the custom-domain challenge.

## P1 high-priority risks

### P1-1 — Supabase security advisor warnings

**Severity:** high but mostly not the first launch blocker  
**Owner:** CISO / Backend  
**Evidence:** Supabase advisors show:

```txt
425 total advisory rows
291 WARN
134 INFO
```

Top warning categories:

| Warning | Count | Launch interpretation |
|---|---:|---|
| `auth_rls_initplan` | 85 | Policy performance/plan stability issue; fix after route blocker unless directly on Stream Studio tables. |
| `pg_graphql_authenticated_table_exposed` | 72 | GraphQL exposure metadata surface; reduce exposure for service-only or irrelevant tables. |
| `pg_graphql_anon_table_exposed` | 68 | More sensitive if anon tables include launch data; triage Stream Studio/product access first. |
| `multiple_permissive_policies` | 26 | Check overlapping policies, especially owner-scoped data. |
| `anon_security_definer_function_executable` | 18 | Audit executable functions. |
| `authenticated_security_definer_function_executable` | 18 | Audit executable functions. |
| `function_search_path_mutable` | 1 | Known hardening item; should fix before broad launch. |
| `extension_in_public` | 1 | Move/accept with rationale. |
| `rls_policy_always_true` | 1 | Must inspect; unsafe if on sensitive table. |
| `auth_leaked_password_protection` | 1 | Enable if available before public signups. |

Guardrail:

- Do not apply Supabase migrations/live DB writes without explicit approval.

### P1-2 — HostKey is a capability secret

**Severity:** high  
**Owner:** CISO / Backend / UX  
**Evidence:** `live/events.ts` stores `hostKey` with local event history; `live/sync.ts` mirrors hostKey to owner-scoped Supabase rows; route contract uses `?e=ID&k=KEY` for host studio and stats/exit operations.

Risk:

- Query-string keys can leak via browser history, screenshots, logs, referrers, shared links, or shared devices.

Launch acceptance:

- Acceptable for controlled beta only if UI copy is honest: private studio links control the event; viewer links are safe to share.

Short-term fixes:

- Clearer copy in dashboard/studio/share modal.
- Avoid exposing `k=` in places not strictly required.
- Add warning before copying host link.
- Purge local event registry on sign-out/shared device, already partially handled by `signOut()`.

### P1-3 — Temporary domain weakens trust

**Severity:** medium-high for public launch  
**Owner:** CEO / Marketing / SRE  
**Issue:** `comic2.pages.dev` is acceptable for controlled beta, but not ideal for subscription trust.

Mitigation:

- For initial private tests: use Pages fallback.
- Before paid/public onboarding: fix `dreamstreamstudio.ai`.

### P1-4 — Billing/pricing not approved

**Severity:** high business guardrail  
**Owner:** CEO / CFO / User  
**Issue:** Stripe/billing foundation may exist, but no pricing or subscription activation is approved.

Rule:

- No prices, tiers, billing activation, paid plan changes, or subscription decisions without explicit approval and cost/benefit memo.

## Product and market direction

### ICP for June 25

Primary ICP:

- solo creators;
- educators;
- coaches;
- workshop hosts;
- small paid-community operators;
- comic/story creators who stream their process.

Not ICP yet:

- enterprise webinars;
- massive streams;
- gaming/ultra-low latency;
- course platforms;
- paid ticketing;
- complex broadcast production.

### Core promise

> Host private creator sessions from the browser, invite viewers with a simple link, interact live, record the session, and leave with replayable content — without OBS or webinar bloat.

### Moat hypothesis

Near-term moat is **not AI alone**. It is:

1. cost-conscious R2/Cloudflare live delivery;
2. no-OBS creator event workflow;
3. lobby/chat/moderation/recording/replay in one browser-native flow;
4. future session-to-content loop: stream → recap → assets/comics/posts.

## Prioritized action plan

### Next 24 hours

1. Keep `npm run ops:live-smoke:temporary` green for the current Pages-domain beta path.
2. Run browser E2E now that the temporary route/base is smokeable.
3. Fix the custom-domain Cloudflare challenge for canonical/public launch.
4. Add/verify UX warning when live backend is not reachable before event create.
5. Keep Code Studio out of homepage/launch funnel.

### Next 48 hours

6. Add a repeatable manual smoke checklist with owner/pass/fail notes.
7. Test Chrome + Safari host/viewer flow.
8. Test local recording and server recording path.
9. Confirm viewer link does not require sign-in.
10. Confirm account sync for signed-in creator dashboard.
11. Verify privacy/terms/support links from temporary launch domain.

### Before inviting first external beta users

12. Fix `dreamstreamstudio.ai` or explicitly invite only through `comic2.pages.dev` with beta context.
13. Confirm Supabase Stream Studio tables/RLS live state.
14. Triage Stream Studio-related Supabase advisor warnings.
15. Add minimal support process: contact email + known limitations.
16. Confirm no paid/container-heavy flows are discoverable from the launch path.

### Before charging money

17. Run cost memo: expected R2/Worker/Railway cost per event/user.
18. Verify Stripe test mode end-to-end.
19. Owner approval for pricing/tier/subscription activation.
20. Verify cancellation/portal/support/refund flows.

## Approval requests queue

| Needed | Why | Benefit | Risk | Approval wording |
|---|---|---|---|---|
| Cloudflare WAF/ruleset scoped fix | Remove challenge from app/API path | Enables canonical domain and custom-domain live-worker API | Misconfiguration could weaken security if broad | “Approve scoped Cloudflare WAF/ruleset fix for app/API paths only.” |
| Browser/media E2E access | Test camera/mic/viewer flow | Proves core value path | Needs camera/mic permission / test account | “Approve browser E2E smoke with camera/mic/test account.” |
| Supabase migration/security hardening | Fix advisor issues | Reduces security exposure | Live DB changes require care | “Approve applying specific migration X after review.” |
| Pricing/subscription activation | Charge users | Revenue path | Business/financial decision | Not approved; requires separate memo. |

## Stop/go recommendation

| Decision | Recommendation |
|---|---|
| Continue building product/code | **Go** |
| Invite internal/manual testers through `comic2.pages.dev` | **Not yet** — live API route must work first |
| Invite external beta users | **No-go** until live API route + E2E smoke pass |
| Public launch on `dreamstreamstudio.ai` | **No-go** until Cloudflare challenge fixed |
| Enable paid subscriptions | **No-go** until owner approves pricing/billing memo |

## Next best task

The next engineering task should be one of these:

1. **Preferred if access approved:** fix Cloudflare app/API challenge and route `dreamstreamstudio.ai/live-api/*` correctly.
2. **Fallback if keeping Pages domain:** expose a safe live-worker base to `comic2.pages.dev` and configure `VITE_LIVE_WORKER_URL` for Pages, then verify with `npm run ops:live-smoke`.
3. **If infra access is deferred:** improve the Create Event UI to hard-block with a helpful explanation when `probeLiveWorker()` fails, so beta users never lose work into a dead backend.
