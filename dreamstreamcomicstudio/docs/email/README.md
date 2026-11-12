# Email system

Branded transactional + newsletter email for DreamStream Studio, sent through **Cloudflare
Email Sending** (the send half of Cloudflare Email Service, public beta since April 2026).

- **Cost & limits** → [`cloudflare-email-cost-and-limits.md`](./cloudflare-email-cost-and-limits.md)
- **Setup / owner actions** → [`SETUP.md`](./SETUP.md)
- **Security model** → [`SECURITY.md`](./SECURITY.md)
- **Live design previews** → run `npx tsx scripts/email-preview.ts`, open [`previews/index.html`](./previews/index.html)

## What it does

| Email | Template | Kind | Trigger |
|-------|----------|------|---------|
| Newsletter / register-interest confirm (double opt-in) | `newsletter-confirm` | essential | `POST /api/interest` (current form), `POST /api/newsletter/subscribe` (kind=updates, older tabs), whatever the address's state. Per-inbox throttle: none within 10 min of the last, max 3/day; the inbox (all its aliases) and then the row are claimed before the send, so parallel requests send one; at most half the daily / monthly email caps, shared with `access-requested`; every address gets the same answer while the mailer is capped; no open pixel; no caller-supplied name. The link opens a Confirm page; the button's POST confirms exactly the studios the page named. |
| Newsletter welcome | `newsletter-welcome` | marketing | pressing Confirm on the confirm page (new or returning subscribers only) |
| Product update / broadcast | `product-update` | marketing | `sendProductUpdate(...)` |
| Admin announcement / notice | `announcement` | essential | admin Email Console / `sendAnnouncement(...)` |
| Beta invite / referral | `beta-invite` | essential | `/api/admin/email/invite`, `/api/invites/referral/send` |
| Early-access acknowledgement | `access-requested` | essential | `POST /api/newsletter/subscribe` (kind=access), for a new request only; at most one a day per inbox, sharing the public-form half of the email caps with `newsletter-confirm` (`interestStore.claimAccessReceipt`). |
| Account welcome (fuller onboarding) | `welcome` | essential | `sendWelcome(...)` |
| New sign-in alert | `signin-alert` | essential | `sendSigninAlert(...)` |
| Confirm signup / resend / password reset / magic link | `auth-confirm-signup`, `auth-recovery`, `auth-magic-link` | essential | `POST /api/auth/email/*` (backend `generateLink` + `/send`; see [SETUP](./SETUP.md#auth-emails-go-through-the-backend-default-since-2026-10-22)) |
| Email change / reauthentication / security notices (+ auth fallback) | `auth-*` | essential | Supabase **Send Email Hook** |

**Essential** mail (account, security, transactional) is always sent and **can never be
unsubscribed**. **Marketing** mail carries a working unsubscribe (a link to a page with one Unsubscribe button,
and the RFC 8058 one-click `List-Unsubscribe` header email apps use) and honors the suppression list.

## Sender addresses & reply policy

Each template sends from a fitting **role mailbox** on the verified domain (set in
`shared/email/templates.ts` → `SENDER_ROLE`). With Cloudflare Email Sending you verify the
**domain** once, then any address on it is allowed — no per-address setup:

| Role | From | Used for | Reply notice |
|------|------|----------|--------------|
| `no-reply` | `no-reply@<domain>` | auth links/codes, double-opt-in confirm | "this mailbox isn't monitored — don't reply" |
| `notifications` | `notifications@<domain>` | transactional notices, updates, sign-in alerts | replies route to support |
| `hello` | `hello@<domain>` | welcome, beta invites | replies route to support |

`Reply-To` is always the support mailbox (`EMAIL_REPLY_TO`), so even if someone replies to a
no-reply message it lands somewhere a human can see.

> **Owner action for replies:** to actually *receive* mail at `support@<domain>`, add a
> Cloudflare **Email Routing** rule (`support@dreamstreamstudio.ai` → your inbox). Sending
> from these addresses needs nothing extra.

## Architecture

```
 Browser (WaitlistForm, AuthPage, live app)
        │  POST /api/newsletter/{subscribe,confirm,unsubscribe}
        │  POST /api/auth/email/{signup,resend,recovery,magiclink}  (→ GoTrue admin generateLink)
        ▼
 Railway backend (Express)
   server/src/routes/newsletter.ts, authEmail.ts ─┐
   server/src/services/mailer.ts    │  caps + suppression + log + unsubscribe/pixel links
        │  HMAC-signed POST /send   │
        ▼                           │
 Cloudflare email-worker  ◀─ Supabase Auth (Send Email Hook → POST /auth-hook)
   email-worker/src/index.ts
   renders shared/email/* templates
        │  env.EMAIL.send({from,to,subject,html,text})
        ▼
 Cloudflare Email Sending ──▶ recipient inbox
        ▲
        └─ open pixel → GET /api/email/o/:id.gif → email_log.opened_at
```

The backend **never** touches the email service directly — it only ever signs a request to
the worker, so authentication, branding and abuse-control live in one auditable place.

## Where things live

| Path | Purpose |
|------|---------|
| [`shared/email/`](../../shared/email) | Pure, dependency-free template library (theme, layout helpers, templates, tests). Imported by the worker, the app, and the preview script — single source of truth for design + the essential/marketing classification. |
| [`email-worker/`](../../email-worker) | Cloudflare Worker: `/send` (HMAC), `/auth-hook` (Supabase), `/health`. |
| `server/src/services/mailer.ts` | Backend send API: dormant-until-configured, hard cost cap, suppression, logging, unsubscribe + read-receipt links, typed helpers. |
| `server/src/services/emailStore.ts` | Supabase (service-role) persistence: `email_log`, `email_suppressions`, waitlist double opt-in. |
| `server/src/routes/newsletter.ts` | Public subscribe / confirm (GET page + POST button) / unsubscribe (GET page + POST button, and the RFC 8058 one-click POST). |
| `server/src/services/confirmToken.ts` | Signed double opt-in tokens (address + issue time, HMAC under `EMAIL_HMAC_SECRET`). |
| `server/src/routes/interest.ts` | Public `POST /api/interest` (register interest in studios: Turnstile, per-IP limit, double opt-in through the newsletter row) + admin `GET /api/admin/interest/summary` (counts only). |
| `server/src/services/interestStore.ts` | Interest registration on the `kind='updates'` waitlist row: merged studio picks, the confirmation throttle, token reuse, missing-schema detection, the admin summary. |
| `services/studioInterests.ts` | The one studio list for the form, the API and the SQL `CHECK` (pinned by `services/studioInterests.test.ts`). |
| `server/src/routes/authEmail.ts` | Public auth emails (`/api/auth/email/{signup,resend,recovery,magiclink}`): GoTrue `generateLink` + our templates, Turnstile, per-recipient throttle. |
| `server/src/services/authEmailLinks.ts` | Pure link builder + the strict link-origin allowlist (`APP_PUBLIC_URL` + `AUTH_LINK_ORIGINS`). |
| `server/src/routes/email.ts` | Public open-tracking pixel. |
| `server/sql/email_system.sql` | DB migration (log + suppression + double opt-in columns). |
| `server/sql/register_interest_2026_11.sql` | Register interest: studio `CHECK` on `product_interests`, the summary RPC, the 30-day retention job for unconfirmed / unsubscribed rows and `newsletter-confirm` log rows (never this month's), an `email_log` lookup index, client INSERT limited to `email, kind, source, metadata`, and the `waitlist_client_insert` trigger that stops a client's direct insert from saying whether an address is already listed. Not applied yet. |
| `scripts/email-preview.ts` | Renders every template to `docs/email/previews/`. |

## Storage & logging

Every send attempt writes a row to **`email_log`** (`queued → sent | failed | suppressed |
rate_limited | skipped`, with `message_id`, `error`, `opened_at`). This is the audit trail,
the read-receipt store, and the source of truth for the cost cap. Opt-outs live in
**`email_suppressions`**. Both tables are **service-role only** — no client can read them.
Once `server/sql/register_interest_2026_11.sql` is applied, `newsletter-confirm` log rows are
deleted once they are more than 30 days old and from before the current UTC month (the daily
`waitlist_interest_retention()` job; the monthly cap below counts this month's rows, so they stay
until the month ends); no other `email_log` rows are purged yet.

## Cost safety (hard limits)

The mailer refuses to send past `EMAIL_MAX_PER_DAY` (default 200) / `EMAIL_MAX_PER_MONTH`
(default **2,500**, below Cloudflare's free 3,000/mo). Hitting a cap logs the send as
`rate_limited` and prints a `[email][COST-CAP]` alert; crossing 80% prints a `[email][COST]`
warning. You **cannot** be billed for overage unless you deliberately raise the monthly cap
above 3,000. Details in [`cloudflare-email-cost-and-limits.md`](./cloudflare-email-cost-and-limits.md).
