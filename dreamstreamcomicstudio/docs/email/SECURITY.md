# Email — security & privacy model

## Threats and controls

| Risk | Control |
|------|---------|
| **Open relay / anyone sending as us** | The email-worker only sends on two authenticated paths. `/send` requires an `x-email-signature` HMAC over the raw body using `EMAIL_HMAC_SECRET` (shared only with the backend). `/auth-hook` requires a valid **Standard Webhooks** signature using `SUPABASE_AUTH_HOOK_SECRET`. Unsigned/invalid → `401`. Browsers can never reach the worker usefully. |
| **Auth-hook spoofing / replay** | Standard Webhooks signature verified with constant-time compare; timestamps older/newer than **5 minutes** are rejected. Hook disabled (503) when no secret is set. |
| **Forged unsubscribe / enumeration** | Unsubscribe links carry an HMAC token (`unsubscribeToken`) bound to the address; verified constant-time. A wrong token can't unsubscribe someone else or enumerate addresses. |
| **Forged newsletter confirm** | The confirm token is signed by this server (`server/src/services/confirmToken.ts`): issue time + nonce, HMAC-bound to the address under `EMAIL_HMAC_SECRET`, compared constant-time. A token anyone else wrote into a row never confirms and is never re-sent. It expires `NEWSLETTER_CONFIRM_TTL_HOURS` after it was first issued (re-sending the same link never extends it), is single-use (cleared on confirm), and is rotated when an unsubscribed address asks again. Confirming takes two steps: `GET /api/newsletter/confirm` (the link) only checks it and shows a page with a Confirm button; only the `POST` from that button subscribes the address, applies studio picks waiting on it, and lifts an earlier marketing unsubscribe. Mail-security scanners that fetch links can't opt anyone in or undo an opt-out. |
| **List exfiltration** | `email_log` and `email_suppressions` have RLS enabled with **no client policies** and `REVOKE ALL` from `anon`/`authenticated` — only the service role (server) can read them. `waitlist_signups` stays write-only for clients (existing design). Tokens are never returned to the client. |
| **Injection in templates** | All dynamic values are `escapeHtml`-escaped; URLs pass `safeUrl` (http/https/mailto only — `javascript:`/`data:` neutralised to `#`). Covered by `shared/email/templates.test.ts`. |
| **Auth-link hijack / account takeover** | The backend's auth emails (`/api/auth/email/*`) carry GoTrue `token_hash` links whose origin comes only from `APP_PUBLIC_URL` or the **exact** origins in `AUTH_LINK_ORIGINS` — never the CORS wildcard, which covers user-controlled `*.dreamstreamstudio.ai` preview hosts. A hostile `Origin` header is ignored. The raw `email_otp` is never mailed. |
| **Auth-email abuse / enumeration** | `/api/auth/email/*`: Turnstile (a sent token must verify; sign-up needs one unless it's a live-app sign-up holding a valid welcome ticket), 10 requests / 10 min per IP, and a durable per-recipient throttle in `email_log` (1/min, 5/h, 10/day). `/resend`, `/recovery`, `/magiclink` answer identically for unknown addresses and never create accounts. Logs mask addresses. |
| **Confirmation-email bombing (abuse-ops-11)** | `POST /api/interest` and `POST /api/newsletter/subscribe` (kind=updates) share `registerInterest` (`server/src/services/interestStore.ts`): Turnstile, one per-IP limiter for both (10 requests / 10 min, `interestRateLimit` in `index.ts`), and a durable per-recipient throttle on `newsletter-confirm`: none within 10 minutes of the last, at most 3 per day. The cooldown runs from the later of the last `email_log` send and the row's `confirm_sent_at`, and the send slot is claimed atomically (a conditional update on `confirm_sent_at`) before mailing, so parallel requests send one email; a failed or capped send gives the slot back. Confirmation mail as a whole may use only half of `EMAIL_MAX_PER_DAY` and of `EMAIL_MAX_PER_MONTH` (`CONFIRM_EMAIL_BUDGET_SHARE`), so unauthenticated requests can't use up the capacity sign-in, recovery and invite mail need. A re-request inside the window re-sends nothing; a still-valid link is re-sent as is. Confirm links are built from `EMAIL_PUBLIC_BASE_URL` / `APP_PUBLIC_URL`, never the request's `Host` header. Mailer logs mask addresses. |
| **Interest list exposure / subscription oracle** | Anyone can type anyone's address, so `POST /api/interest` gives every valid request the same `200 {status:'pending'}` answer and echoes only the studios that request picked: it never says whether the address is new, pending, subscribed, unsubscribed or throttled, and never returns stored picks (the old `/subscribe` answers the same way). An unauthenticated request never changes a subscriber's picks: new ones wait in `metadata.pending_interests` until they press Confirm; an existing row's note is never replaced. The confirm link never reveals state to anyone but the holder of a valid signed token. Clients can't read `waitlist_signups` (no SELECT/UPDATE/DELETE). **Until `server/sql/register_interest_2026_11.sql` is applied, anon/authenticated can INSERT any column** (verified live 2026-11-05); the server already ignores tokens it didn't sign, and that file limits client INSERT to `email, kind, source, metadata` with a policy requiring a lowercase address and default values, so a client can no longer write a "confirmed" row or plant picks. The admin summary (`GET /api/admin/interest/summary`, `requireAdmin`) returns counts per studio only — no address, token or note. Retention, once that file is applied (pg_cron `waitlist_interest_retention()`, daily): unconfirmed rows are deleted 30 days after their last confirmation email, unsubscribed rows 30 days after unsubscribing (unless they asked again), and `email_log` rows of `newsletter-confirm` mail 30 days after sending, whoever they went to. Unsubscribing clears the studio picks (including waiting ones) at once. The marketing suppression list is kept: it is what stops us emailing an address that opted out. Before the file is applied none of this retention runs. |
| **Spend abuse / runaway cost** | Hard caps (`EMAIL_MAX_PER_DAY` / `EMAIL_MAX_PER_MONTH`, default under the free tier) enforced before every send; over-cap sends are skipped + alerted, never delivered. Per-route rate limits apply (`systemRateLimit`). |
| **Forged sign-in alerts** | `POST /security` (new-sign-in alerts from the Supabase access-token hook, ADR 0006) requires an `x-ds-signature` HMAC-SHA256 over `"<t>.<payload>"` with `SECURITY_HOOK_SECRET` (shared only with Supabase Vault and the live Worker), ±5 min; 503 when the secret is unset. IPs arrive already masked and are masked again; the "Not you?" link carries a one-time token whose SHA-256 is all the database keeps. |
| **Secrets** | `EMAIL_HMAC_SECRET`, `SUPABASE_AUTH_HOOK_SECRET` and `SECURITY_HOOK_SECRET` live as Worker secrets (and, for the backend's copy of `EMAIL_HMAC_SECRET`, D1 `backend_env`), never in the repo. `.env*` is git-ignored (only `.env.example`). Rotation order: `docs/infrastructure/live-security-runbook.md` §1. |

## Essential vs marketing (compliance)

Templates are classified in `shared/email/templates.ts` (`TEMPLATE_KIND`):

- **essential** — account/security/transactional (`auth-*`, `welcome`, `signin-alert`,
  `access-requested`, `newsletter-confirm`). Always sent; **no unsubscribe** (shown as a
  "required notification" footer line); bypasses the suppression list.
- **marketing** — opt-in (`newsletter-welcome`, `product-update`). Carries a working
  unsubscribe link **and** an RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` header for
  native one-click unsubscribe in Gmail/Apple Mail; **honors the suppression list**.

The mailer refuses to send a marketing message if it can't build a working unsubscribe link
(missing `EMAIL_PUBLIC_BASE_URL`), so we never send non-compliant marketing mail. Every email
carries the honest "why you're getting this" footer + sender postal address (CAN-SPAM / CASL).

## Read receipts / open tracking — privacy note

Marketing **and** essential mail can embed a 1×1 open-tracking pixel
(`/api/email/o/:id.gif` → stamps `email_log.opened_at`). This is **best-effort**: many clients
block remote images or pre-fetch them, so opens are a weak signal, not proof of reading. The
pixel only records the open timestamp against our own log row — no third-party tracker, no
profile, no cross-site cookies. To disable tracking entirely, leave `EMAIL_PUBLIC_BASE_URL`
unset (no pixel URL is generated) or strip `params.pixelUrl` in the mailer. Mail that carries a
one-time link sends no pixel (`track: false`): the auth emails and the double opt-in
`newsletter-confirm`.

## Bot protection — Cloudflare Turnstile

Turnstile guards the public, abuse-prone entry points. **Fully dormant until keys are set** —
no widget renders and no endpoint is gated, so nothing changes for anyone until you turn it on.

- **Where:** the auth form (`AuthPage` → sign-in via Supabase `captchaToken`; sign-up /
  magic-link / password-reset / resend via `/api/auth/email/*`, verified server-side, with the
  old Supabase call as the fallback) and the public newsletter / request-access form
  (`WaitlistForm` → `/api/newsletter/subscribe`, verified server-side).
- **Client:** `components/Turnstile.tsx`, gated by `VITE_TURNSTILE_SITE_KEY`. Tokens are
  single-use; the widget resets after every attempt.
- **Server:** `server/src/services/turnstile.ts` verifies tokens against Cloudflare's
  siteverify, gated by `TURNSTILE_SECRET_KEY`. **Fails open when unconfigured** (no gate),
  **fails closed when configured** (a network error during verification denies the request).

**Owner setup:** create a Turnstile widget in the Cloudflare dashboard → set
`VITE_TURNSTILE_SITE_KEY` (client) + `TURNSTILE_SECRET_KEY` (server) → and enable Turnstile in
**Supabase → Authentication → bot/abuse protection** so the auth `captchaToken` is validated.

## Failure posture

The mailer **never throws** and email is **best-effort**: a down worker, missing config, or
hit cap returns a structured `{ ok:false, skipped|error }` and is logged — it never blocks a
signup, a confirm, or an API response.
