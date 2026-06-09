# Email — security & privacy model

## Threats and controls

| Risk | Control |
|------|---------|
| **Open relay / anyone sending as us** | The email-worker only sends on two authenticated paths. `/send` requires an `x-email-signature` HMAC over the raw body using `EMAIL_HMAC_SECRET` (shared only with the backend). `/auth-hook` requires a valid **Standard Webhooks** signature using `SUPABASE_AUTH_HOOK_SECRET`. Unsigned/invalid → `401`. Browsers can never reach the worker usefully. |
| **Auth-hook spoofing / replay** | Standard Webhooks signature verified with constant-time compare; timestamps older/newer than **5 minutes** are rejected. Hook disabled (503) when no secret is set. |
| **Forged unsubscribe / enumeration** | Unsubscribe links carry an HMAC token (`unsubscribeToken`) bound to the address; verified constant-time. A wrong token can't unsubscribe someone else or enumerate addresses. |
| **Forged newsletter confirm** | The confirm link carries a 24-byte random token stored server-side and compared constant-time; it's single-use (cleared on confirm). |
| **List exfiltration** | `email_log` and `email_suppressions` have RLS enabled with **no client policies** and `REVOKE ALL` from `anon`/`authenticated` — only the service role (server) can read them. `waitlist_signups` stays write-only for clients (existing design). Tokens are never returned to the client. |
| **Injection in templates** | All dynamic values are `escapeHtml`-escaped; URLs pass `safeUrl` (http/https/mailto only — `javascript:`/`data:` neutralised to `#`). Covered by `shared/email/templates.test.ts`. |
| **Spend abuse / runaway cost** | Hard caps (`EMAIL_MAX_PER_DAY` / `EMAIL_MAX_PER_MONTH`, default under the free tier) enforced before every send; over-cap sends are skipped + alerted, never delivered. Per-route rate limits apply (`systemRateLimit`). |
| **Secrets** | `EMAIL_HMAC_SECRET` and `SUPABASE_AUTH_HOOK_SECRET` live as Worker secrets / Railway env, never in the repo. `.env*` is git-ignored (only `.env.example`). |

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
unset (no pixel URL is generated) or strip `params.pixelUrl` in the mailer.

## Bot protection — Cloudflare Turnstile

Turnstile guards the public, abuse-prone entry points. **Fully dormant until keys are set** —
no widget renders and no endpoint is gated, so nothing changes for anyone until you turn it on.

- **Where:** the auth form (`AuthPage` → sign-in / sign-up / magic-link / password-reset, via
  Supabase `captchaToken`) and the public newsletter / request-access form (`WaitlistForm` →
  `/api/newsletter/subscribe`, verified server-side).
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
