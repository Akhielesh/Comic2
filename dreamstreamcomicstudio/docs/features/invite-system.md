# Invite system — end-to-end flow

How access invites work across email, auth, redemption and reporting. This closes the
gaps found in the June 2026 audit: the `?invite=` email link used to land on the home
page and go nowhere, an already-invited person who tried to register got a generic
waitlist response, and neither admins nor inviters could see whether an invite was
accepted.

## The three invite paths

| Path | Who | How | Records |
|---|---|---|---|
| Admin codes | admin | `InviteManager` → `POST /api/admin/invites` (batch, label, max uses, expiry, optional studio confinement) | `access_invites` |
| Admin email invite | admin | Email console → `POST /api/admin/email/invite` (mints a code + sends `beta-invite` email) | `access_invites` + `access_invite_sends` |
| User referral | any signed-in user | `InviteFriends` → `GET /api/invites/referral` (personal link) and `POST /api/invites/referral/send` (≤10 emails) | `access_invites` (label `referral`) + `access_invite_sends` |

## Tables

- `access_invites` — the codes (status, use counts, expiry, `metadata.products` studio confinement).
- `access_invite_redemptions` — who redeemed which code, when (user id + email).
- `access_invite_sends` (NEW, `server/sql/access_invite_sends.sql`) — who each code was
  **emailed to**: one row per (invite, recipient), `kind` (`admin` | `referral` | `resend`),
  `send_count`, `first_sent_at`, `last_sent_at`. Service-role only, like the other two.

`email_log` stays the transport audit; it never stores the invite code, which is why
`access_invite_sends` exists — it's the only way to answer *"does this email hold a
pending invite?"* and *"which of my invites were accepted?"*.

## Invited person's journey (the fixed flow)

1. **Email link** → `/?invite=DS-XXXX-XXXX`. On load, `captureInviteCodeFromUrl()`
   (services/invites.ts) stashes the code in localStorage and strips the param.
2. **Not signed in** → App routes to the auth page, which shows an invite banner and —
   crucially — **unlocks the real Sign Up tab** even while public signups are off
   (`AuthPage.signupsAllowed`). The invited person creates a normal account
   (username, password, verification email — the standard flow).
3. **First signed-in load** → App auto-redeems the stashed code
   (`POST /api/invites/redeem`), shows a success/failure banner, and clears the stash.
   Studio confinement (`metadata.products`) is granted at redemption as before.
   No manual code entry needed; the Settings `RedeemInvite` box still exists as a
   fallback for codes shared out-of-band.

## Someone registers interest (including an already-invited person)

`POST /api/newsletter/subscribe` no longer looks the address up in accounts or invites and
never re-sends an invite. Every valid address gets the same status and body, so the form
cannot be used to learn whether an address has an account or an invite. An invited person
uses the link in their invite email; an admin can re-send it from the admin console
(`resendPendingInvite` stays in `services/invites.ts` for that). The full flow, the
optional questions and the email switch are in [register-interest.md](./register-interest.md).

## Visibility

- **Admin** (`InviteManager`): each code now shows its delivery + redemption timeline —
  *sent to whom, when, how many times, via which path → joined when*. Data comes from
  `listInvites` (`recipients` + `redeemedBy` arrays). Per-user usage analytics live in
  the existing admin **user usage** dashboard (`GET /api/admin/usage/users`) — join on
  the redemption's `user_id`.
- **Inviter** (`InviteFriends`): `GET /api/invites/referral` now returns `invited[]`
  (per emailed friend: invited / joined + dates) and `joinedViaLink`. Deliberately
  accepted-or-not only — an inviter never sees another user's usage analytics.

## Files

- Server: `server/src/services/invites.ts` (recordInviteSend, findPendingInviteForEmail,
  resendPendingInvite, getReferralStats, extended listInvites), routes
  `invites.ts` / `adminEmail.ts` / `newsletter.ts`, SQL `server/sql/access_invite_sends.sql`.
- Client: `services/invites.ts` (capture/pending helpers + types), `App.tsx` (capture +
  auto-redeem + banner), `components/AuthPage.tsx` (invite banner + invite-unlocked
  signup), `components/WaitlistForm.tsx` (register interest),
  `components/InviteFriends.tsx` (referral stats), `components/admin/InviteManager.tsx`
  (timeline).
