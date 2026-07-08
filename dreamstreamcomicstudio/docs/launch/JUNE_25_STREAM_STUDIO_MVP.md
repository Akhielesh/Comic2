# June 25 Stream Studio MVP Launch Plan

> Status: active launch source of truth as of 2026-06-18.
>
> This document supersedes broad-suite positioning for the June 25 beta push. DreamStream can still become a larger creative operating system, but the launch wedge is **Stream Studio**.

## Executive decision

DreamStream should not try to launch as “four products, one studio” by June 25. That framing is too broad for the current proof level and makes the product feel unfocused.

For the technical route/API/data-flow source of truth, see [`STREAM_STUDIO_SYSTEM_MAP.md`](STREAM_STUDIO_SYSTEM_MAP.md). For the current go/no-go evidence and remediation roadmap, see [`STREAM_STUDIO_READINESS_REPORT.md`](STREAM_STUDIO_READINESS_REPORT.md).

**Temporary launch domain:** use `https://comic2.pages.dev/` and `https://comic2.pages.dev/live.html` while `https://dreamstreamstudio.ai/` remains challenged by Cloudflare security verification. The custom domain is still a P0 polish/trust blocker, but it should not stop Stream Studio product work.

The June 25 MVP wedge is:

> **Create, host, and preserve polished private live experiences from your browser — no OBS, no webinar bloat, no surprise streaming bill.**

## Primary ICP

Launch for creators who run intimate sessions for roughly small-to-medium rooms:

- solo creators and educators,
- coaches and workshop hosts,
- paid-community operators,
- indie storytellers/comic creators showing process,
- small classes or private live events.

They care about:

- fast setup,
- viewer links that do not require account creation,
- lobby/chat/moderation,
- guest seats,
- recording/replay,
- professional feel without production complexity,
- predictable operating cost.

## Not the June 25 ICP

Do **not** optimize or market for these yet:

- enterprise webinars,
- massive streams,
- ultra-low-latency gaming,
- full course platforms,
- paid ticketing/paywall infrastructure,
- complex broadcast production,
- container-heavy Code Studio workflows.

## Launch scope

### Must ship / prove

1. **Focused landing path**
   - Stream Studio hero and CTA lead the public page.
   - Chat and Comic are support tools, not equal launch promises.
   - Code remains coming soon / parked.

2. **Account and access**
   - Sign-in works from the main app and `/live.html` hand-back.
   - Product access gating works for `stream_studio`.
   - Signed-out/local-only behavior is clearly explained.

3. **Core event lifecycle**
   - Create event.
   - Schedule or go live now.
   - Share invite.
   - Viewer joins with name.
   - Optional approval lobby.
   - Host starts/pauses/ends stream.
   - Viewer playback works.
   - Replay is visible after the session.

4. **Interaction**
   - Chat.
   - Reactions.
   - Basic moderation.
   - Guest links if stable.
   - Clear beta limits.

5. **Recording and retention**
   - Local recording works.
   - Server recording upload/download works if enabled.
   - Retention messaging is explicit.
   - R2 cleanup/retention jobs are verified.

6. **Trust**
   - `dreamstreamstudio.ai` must be accessible to normal users, not blocked by Cloudflare challenge.
   - Security copy explains private studio links vs viewer links.
   - Privacy, terms, support/contact are reachable.

7. **Ops and QA**
   - `npm run typecheck` passes.
   - `npm run build` passes.
   - [ ] `npm run ops:live-smoke:temporary` passes for the current Pages-domain beta path
   - [ ] `npm run ops:stream-e2e:checklist` has been walked in a real browser for the temporary beta path (create → studio → viewer → chat/reaction → live playback → ended replay)
   - [ ] `npm run ops:live-smoke` passes before canonical/public launch (expected to fail while `dreamstreamstudio.ai` is Cloudflare-challenged)
   - Manual Stream Studio smoke test passes on at least Chrome and Safari before inviting users.

## Hard cuts until after launch proof

- Do not market Code Studio as available.
- Do not expose Cloudflare Container workflows as a launch path.
- Do not lead with “AI everything suite.”
- Do not claim enterprise/webinar/gaming scale.
- Do not claim 200-viewer reliability until load-tested.
- Do not activate paid subscriptions or publish pricing without owner approval.
- Do not run new paid infra, pricing, billing, or subscription decisions without explicit owner approval.

## Approval guardrail

Financial, pricing, subscription, and paid-infra decisions require explicit owner approval.

Any proposal in those categories must include:

- what changes,
- why it matters,
- expected benefit,
- direct and indirect cost,
- risk,
- rollback plan,
- exact approval requested.

## Current launch blockers

| Priority | Blocker | Evidence / reason | Owner |
|---:|---|---|---|
| P0 | Custom domain Cloudflare challenge | `dreamstreamstudio.ai` still returns Cloudflare security verification to automation/curl; temporary launch uses `comic2.pages.dev` until scoped WAF/ruleset access is available | SRE / CTO |
| P0 | Stream Studio E2E not launch-proven | Need create → studio → viewer → chat → live → record → replay smoke in real browsers | QA / Full-stack |
| P1 | Supabase advisor warnings | Live advisors showed many WARN items; prioritize launch-relevant RLS/security items | CISO / Backend |
| P1 | Billing not owner-approved | Stripe foundation exists, but price/tier activation needs explicit approval | CEO / CFO |
| P1 | Container cost risk | Code Studio / containers should remain out of launch funnel | CTO / SRE |

## Recently resolved launch blockers

| Resolved | Evidence | Follow-up |
|---|---|---|
| Private host/guest capability-link leak hardening | New Stream Studio links keep capability keys in URL fragments (`?e=...#/studio?k=...`, `#/guest?g=...`) so keys are not sent in initial HTTP requests, CDN logs, or Referer headers; legacy query links still parse; LinkBox still redacts raw keys and requires a second click before copying private links | Keep manual smoke coverage for copied studio/guest links and continue treating `k`/`g` URLs as bearer secrets |
| Temporary Pages-domain live-worker reachability | `comic2.pages.dev` Stream Studio bundle now references `dreamstream-live.akhieleshsrirangam.workers.dev`; `npm run ops:live-smoke:temporary` passes `stream studio bundle`, `fallback live worker`, and browser-origin CORS preflights for event creation (`POST`) plus recording upload parts (`PUT`) | Keep bundle + CORS preflight smoke in the pre-invite checklist so stale/misbuilt Pages deploys or CORS regressions cannot silently break browser event creation or replay capture |
| Product positioning too broad | Homepage/docs now focus Stream Studio as the June 25 launch wedge | Keep Chat/Comic as support tools and Code Studio parked until Stream Studio is proven |

## Pre-invite smoke checklist

Run this before letting real users in:

- [ ] `npm run typecheck`
- [ ] `npm run build:server`
- [ ] `npm run build`
- [ ] `npx vitest run` or targeted launch suite if time-constrained
- [ ] `npm run ops:live-smoke:temporary` passes for the temporary Pages-domain beta path
- [ ] `npm run ops:stream-e2e:checklist` printed checklist is completed in Chrome for the temporary beta path; save event ID plus pass/fail notes
- [ ] `npm run ops:stream-e2e:checklist` printed checklist is completed in Safari for the temporary beta path; save event ID plus pass/fail notes
- [ ] Temporary launch domain `https://comic2.pages.dev/` returns the app shell
- [ ] Temporary Stream Studio URL `https://comic2.pages.dev/live.html` returns the app shell
- [ ] Deployed Stream Studio bundle is current: the `stream studio bundle` smoke target (run `npm run ops:live-smoke:temporary`) discovers `/assets/live-*.js` from `live.html` and confirms it references `dreamstream-live.akhieleshsrirangam.workers.dev` — guards against a stale/misbuilt Pages deploy that still passes endpoint probes while the studio falls back to dead same-origin `/live-api`
- [ ] Temporary Stream Studio worker URL `https://dreamstream-live.akhieleshsrirangam.workers.dev/api/events/smokeprobe` returns live-worker JSON (404 `not found` is acceptable for the no-write probe; Cloudflare error 1042 or website HTML is a blocker)
- [ ] Temporary Stream Studio worker CORS preflight permits browser event creation from `https://comic2.pages.dev` (`npm run ops:live-smoke:temporary` checks `OPTIONS /api/events` for `Access-Control-Allow-Origin`, `POST`, `content-type`, and `x-host-key`)
- [ ] Temporary Stream Studio recording upload CORS preflight permits browser replay capture from `https://comic2.pages.dev` (`npm run ops:live-smoke:temporary` checks `OPTIONS /api/events/smokeprobe/recordings?...` for `PUT`, `content-type`, and `x-host-key`)
- [ ] `https://dreamstreamstudio.ai/` custom-domain challenge is either fixed or explicitly documented as post-beta blocker
- [ ] Railway `/api/health` works through intended production route
- [ ] Host creates an event
- [ ] Viewer joins with only a name
- [ ] Lobby approval works
- [ ] Host starts stream
- [ ] Viewer receives playback
- [ ] Chat/reactions work
- [ ] Host ends stream
- [ ] Replay/recording path works
- [ ] Support/privacy/terms links are reachable

## Council operating model

During launch sprint, every agent/run should ask:

1. Does this make Stream Studio more launchable by June 25?
2. Does this increase first-session success or trust?
3. Does this reduce cost/risk/operational uncertainty?
4. Is this verified by repo, live infra, test output, or real product behavior?
5. Does it require owner approval because it touches pricing, spend, subscriptions, accounts, production deploys, secrets, or migrations?

If the answer to #1–#3 is “no,” park it.

## Positioning draft

Hero:

> Private live events, from browser to replay.

Subhead:

> Host polished creator sessions without OBS or webinar bloat: invite viewers, manage lobby/chat, bring guests on air, record the moment, and share the replay.

CTA:

> Open Stream Studio

Secondary CTA:

> Request access

## After launch proof

Only after the Stream Studio workflow is reliable and users show repeat intent, revisit:

- subscription packaging,
- paid tiers,
- larger viewer caps,
- AI post-stream recap/content repurposing,
- Comic/Chat deeper integration,
- Code Studio / container workflows,
- broader suite positioning.
