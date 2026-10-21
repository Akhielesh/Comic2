# Accounts and studio access (one account, every studio)

DreamStream has **one account system** (Supabase Auth) shared by every studio: the
main app (Comic Studio, Chat Studio — `dreamstreamstudio.ai/`) and Stream Studio
(`/live`: streaming, the baby monitor, the tracker and family calls). On the same
host both apps share one session (`services/supabase.ts`, storage key
`dreamstream_auth_token`; Stream Studio loads that same client).

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
| Code Studio | admins only, marked **Retiring** | hidden |

Sources (unchanged): `product_access` (admin-managed, Admin → Studios),
`live_profiles` + `live__legacy_eligible`, `monitor_members`, `user_roles` / owner
emails (rbac), `user_plan_subscriptions` (shown as the plan).

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
(sessionStorage, when "Remember me" was off), and `www.dreamstreamstudio.ai`
redirects to the bare domain (sessions are per host).

## Decisions for the owner

1. **Welcome-code sign-ups get the whole suite.** Stream Studio's own sign-up
   (welcome code, `signup_source: 'stream_studio'`) creates an account with no
   `product_access` rows — which the main app reads as open beta (Comic + Chat too),
   bypassing the main app's invite-only sign-up. To confine those accounts to Stream
   Studio by default, `live_join` would add a `product_access` row
   (`stream_studio`, active) — one SQL change.
2. **Two display names.** Stream Studio uses `live_profiles.display_name`, the main
   app `profiles.username`. "Your studios" shows the Stream Studio name first; one
   editable name for both would need a small migration.
3. **comic2.pages.dev** is still a separate host (its own session). Redirecting it
   to the custom domain would give one sign-in everywhere, at the cost of the
   fallback host.
