# Accounts and studio access (one account, every studio)

DreamStream has **one account system** (Supabase Auth) shared by every studio: the
main app (Comic Studio, Chat Studio — `dreamstreamstudio.ai/`) and Stream Studio
(streaming, the baby monitor, the tracker and family calls). Stream Studio is moving to its
own address, **`stream.dreamstreamstudio.ai`** (like Atlas at `atlas.dreamstreamstudio.ai`),
behind one switch — see [One address per app](#one-address-per-app--streamdreamstreamstudioai).
Until the switch is on it is served at `dreamstreamstudio.ai/live`, where both apps share
one session (`services/supabase.ts`, storage key `dreamstream_auth_token`; Stream Studio
loads that same client). `www.dreamstreamstudio.ai` and `comic2.pages.dev` 301 to the
bare domain (see decision 3). Each account has **one display name** every studio shows,
and an `@username` handle.

## Who can use what — `GET /api/account/studios`

One server answer both apps show ("Your studios": DreamStream → Account → Profile;
Stream Studio → Settings → Account & sync, and chips in the account menu).
`server/src/services/studioAccess.ts` (pure `computeStudioAccess` + loader, tested),
contract in `shared/studioAccess.ts`, client `services/studioAccessApi.ts`.

| Studio | Open when | Otherwise |
|---|---|---|
| Comic Studio, Chat Studio | no `product_access` rows (open beta) **or** an active row | **Locked** — "Ask an admin" (an inactive row reads "access was turned off") |
| Stream Studio | product allowed **and** a Stream Studio membership (`live_profiles`) or an early (grandfathered) account | **One step** — enter the welcome code |
| Baby monitor & family calls | comes with Stream Studio; shows how many nurseries you're in | as Stream Studio |

Code Studio is retired ([ADR 0005](../decisions/0005-retire-code-studio.md)) and is never
listed, not even for admins; the `retiring` status went with it.

Sources (read only): `product_access` (admin-managed, Admin → Studios),
`live_profiles` + `live__legacy_eligible`, `monitor_members`, `user_roles` / owner
emails (rbac, shown as "admin" on the account), `user_plan_subscriptions` (shown as the
plan). The answer also carries the account's `name` (from `live_profiles`,
`profile_private` and `profiles`) and `username` — see below.

## One display name (2026-10-22)

One name per account, shown everywhere: DreamStream (Account → Profile, the header chip,
Chat Studio's greeting), Stream Studio (account menu, dashboard greeting, the default
on-stream name), the baby monitor and calls (what family and nursery members see, and
what people search finds). The `@username` (`profiles.username`) stays the sign-in and
Comic Studio handle (profiles, comments, the gallery) and is never changed by a rename.

- **Where it lives.** Canonical: auth `user_metadata.display_name` (what
  `live__default_name` and a later `live_join` pick up, and what auth emails and Chat
  Studio read). Mirrored into `live_profiles.display_name` (Stream Studio, only when the
  person is a member) and `profile_private.first_name` / `last_name` (first word / the
  rest). No migration was needed.
- **Writing it.** `PATCH /api/account/name { name }` (`server/src/routes/account.ts`,
  service role) cleans the name (`shared/accountName.ts`: trimmed, single-spaced, no
  control characters, 1–40 characters — the `live_profiles` check), then upserts
  `profile_private`, **updates** `live_profiles` (never inserts — membership stays
  welcome-code gated) and merges the auth metadata (a failure there is logged, not
  fatal). Returns `{ ok, name, stream }`. The client (`services/accountName.ts`
  `updateAccountName`) then refreshes the session so the token's metadata is current and
  tells open "Your studios" views to re-read.
- **Reading it.** `GET /api/account/studios` returns `account.name` =
  `resolveName(...)`: the Stream Studio name (what family already sees), else first +
  last, else the `@username`; plus `account.username`. No backfill: the first save from
  either app aligns all three stores.
- **Editing it.** DreamStream: Account → Profile → **Name** (one required field, max 40;
  replaces First/Last). Stream Studio: Settings → Account & sync → **Your name**, for
  members *and* people who haven't entered a welcome code yet. Settings → Scenes has an
  optional **On-stream name** that overrides it for streams only; left empty (the new
  default) the studio uses the account name, so renames flow through.
- **Privacy.** For Stream Studio members the name is visible to their nursery members
  and searchable by other members (as Stream Studio names always were); the field's help
  text says so. People without a membership expose nothing new.

## Signing out (2026-10-21 fix)

Stream Studio used to keep its own copy of the display name (and events, nursery
alert opt-ins, call settings) in `localStorage`, and no sign-out cleared it — so it
greeted the last person by name. Now `live/accountPurge.ts` wipes everything
personal Stream Studio keeps on a device (device preferences such as theme, lens and
tours stay) when:
- you sign out in Stream Studio, or in the main app (`contexts/AuthContext.tsx`);
- Stream Studio loads with no session but a previous owner (`ds-live-owner`), or a
  different person signs in;
- and it unsubscribes the device's `/live` push subscription.

A sign-out in another tab now also drops a Stream Studio tab's own session copy
(sessionStorage, when "Remember me" was off), and `www.dreamstreamstudio.ai` (and since
2026-10-22 `comic2.pages.dev`) redirects to the bare domain (sessions are per host).

When the sign-in server cannot be reached at sign-out (offline, a flaky network), the
auth client keeps the session and fires no `SIGNED_OUT`; the main app's sign-out (and
its 30-day inactivity sign-out) then drops the stored session and the cached token
itself, runs the same purge, and says so: "Signed out on this device. The sign-in server
couldn't be reached, so the sign-out wasn't recorded there — other devices stay signed in
until you sign out on them." A later refresh tick or reload finds no session to resume.

## One address per app — stream.dreamstreamstudio.ai

**The switch.** `shared/streamHost.ts` → `STREAM_HOST_ON` (one constant, read by the Pages
middleware, both apps, the backend and the email Worker). Off (as shipped): everything is
exactly as before. On: Stream Studio lives at `https://stream.dreamstreamstudio.ai/`.

**What the host does** (`functions/_middleware.ts`, tests in `api-proxy/src/index.test.ts`):
- `stream.dreamstreamstudio.ai` serves the live app at `/` (every page is a rewrite to
  `live.html` through the Pages `ASSETS` binding — never a redirect, so no loops); its
  screens are `#/…` routes as before. `/live`, `/live/` and `/live.html` there 301 to `/`
  with the query (old viewer `?e=…` links keep working; browsers keep the `#…` part with
  host and guest keys). `www.stream…` 301s to it. The agent gate is the same. This works
  whether or not the switch is on, so the host can be checked first:
  `npm run ops:live-smoke:stream-host`.
- `/live-api/*` and `/api/*` on the new host are Worker routes (`live-worker/wrangler.jsonc`,
  `api-proxy/wrangler.jsonc`), so the app stays same-origin there.
- With the switch on, `dreamstreamstudio.ai/live`, `/live/` and `/live.html` (and the
  `comic2.pages.dev` / `www` versions, in one hop) 301 to the new host, mapping
  `/live.html?e=X` → `/?e=X`. Cached for a day, not forever, so the switch can be undone.
  Nothing else moves: `/live-api/*`, `/api/*`, `/assets/*`, `/live-sw.js` and
  `/live.webmanifest` stay on the apex for installed apps, old service workers and open
  tabs. `dreamstreamstudio.ai/live.html?legacy=1` still opens the app on the old address
  (for anything left in that origin's storage, e.g. an unsaved recording).

**Sign-in that follows you.** Each address keeps its own session (localStorage is per
origin) and Supabase refresh tokens are single use, so a session is never copied between
them. Instead, crossing over while signed in uses a **one-time sign-in link for your own
account**:
- `POST /api/auth/handoff {to: 'live'|'main', path?}` (`server/src/routes/authHandoff.ts`;
  requireAuth, 10 a minute per account, our two origins only, no-store, never logs the
  token) → `admin.generateLink({type:'magiclink', email: <caller's>})` →
  `https://stream.dreamstreamstudio.ai/?token_hash=…&type=magiclink[&after=<screen>]` or
  `https://dreamstreamstudio.ai/auth/callback?token_hash=…&type=magiclink&next=</ or /?view=…>`.
  Both origins are constants and the path is a strict allowlist (`parseStreamHandoffPath`,
  `parseMainHandoffPath`) — no open redirect. 404 while the switch is off.
- DreamStream → Stream Studio: every "Open Stream Studio" link, "Your studios", the
  stream-only redirect and the `?next=` hand-back use `services/liveLink.ts`
  (`openLiveApp` / `followLiveLink`). Signed out, refused or slow (6 s): the plain link.
  New-tab clicks keep the plain link.
- Stream Studio → DreamStream: "Your studios" entries for the main app use `openMainApp`;
  the main app's `/auth/callback` verifies the link and goes straight on to `next`.
  Privacy/Terms links are plain absolute links (`mainAppUrl`).
- Landing on Stream Studio signed out (an old bookmark, an installed app, a 301): the sign-in
  sheet offers **Continue with DreamStream** → `dreamstreamstudio.ai/?next=<stream screen>` →
  signed in there? straight back, signed in; if not, sign in there once and come back.
  Only the screen travels, never a viewer/studio/guest key.
- Stream Studio finishes `?token_hash=…&type=magiclink` in `live/account.ts`
  (`consumeAuthReturn`, which already verified sign-up links) and removes it from the
  address bar and history.

**Emails.** With the switch on, Stream Studio sign-up confirmations link to
`https://stream.dreamstreamstudio.ai/?after=…&token_hash=…&type=signup`; recovery and magic
links stay on the main app (the new-password screen lives there), even when asked for from
the Stream Studio host (`server/src/services/authEmailLinks.ts`). The Stream Studio email
brand's home link and studio invites point at the new address.

**Sign-out is per address.** Signing out of DreamStream doesn't sign Stream Studio out on the
same device any more (and the other way round) — each has its own sign-out, and each wipes
the Stream Studio data it holds (`live/accountPurge.ts`).

**Installed apps and alerts.** The new host has its own manifest (`public/stream.webmanifest`,
`start_url: /#/monitor`, `scope`/`id` `/`) and the alert service worker is registered at its
root (`live/host.ts`); the apex keeps its old manifest and worker. Existing alert subscriptions
keep receiving pushes, and tapping one opens the new address. To install the app or turn
alerts on at the new address, add it to the Home Screen again from there and turn "Alerts on
this device" on there (the help centre says so once the switch is on).

## Owner decisions — DECIDED 2026-10-22

Asked to choose, the owner said *"you choose what's best"*. Decided as follows:

1. **Welcome-code sign-ups get the whole suite.** Open beta: an account with no
   `product_access` rows can use every studio, wherever it signed up. The welcome code is
   what unlocks Stream Studio and, with it, the baby monitor and family calls; it does not
   confine the account. Admins can still confine any account to particular studios
   (Admin → Studios), which "Your studios" shows. No SQL change.
2. **One display name everywhere; `@username` stays the handle.** Implemented as
   described in [One display name](#one-display-name-2026-10-22): one name in
   `user_metadata.display_name`, mirrored into `live_profiles` and `profile_private`,
   written by `PATCH /api/account/name` and read back by `GET /api/account/studios`. The
   `@username` remains the sign-in and Comic Studio identity.
3. **`comic2.pages.dev` and `www` redirect to `dreamstreamstudio.ai`** — one host, one
   sign-in. `functions/_middleware.ts` answers both hosts (exact match) with a 301 to the
   same path and query; browsers keep the `#…` part, so private studio links, guest keys
   and auth-email tokens still work. Preview and branch deploys
   (`<hash>.comic2.pages.dev`) still serve. Kept on purpose: the Supabase Redirect URLs
   for `comic2` (emails already sent, previews), the live worker's `ALLOWED_ORIGINS` and
   the `live/config.ts` workers.dev fallback (tabs opened before the switch) — remove those
   in a later cleanup. One-time cost for people who used that host: sign in again on
   `dreamstreamstudio.ai` and re-install the home-screen app / re-enable baby-monitor
   alerts there; recordings left unsaved in that host's browser storage can't be
   recovered from the new address (events can be re-imported by their studio link).
   `npm run ops:live-smoke` checks the 301 instead of fetching pages from that host.
4. **Cost centre MRR counts paid subscriptions only.** Revenue is Stripe-backed paying
   subscribers (active/trialing) × the plan's list price. Comped accounts (a paid tier
   set by an admin with no Stripe subscription) are shown separately as "comped" and are
   never counted in revenue (`server/src/services/costCentre.ts`).
5. **Code Studio is retired.** It no longer appears in "Your studios" for anyone; the
   rest of the removal follows [ADR 0005](../decisions/0005-retire-code-studio.md).
