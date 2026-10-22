# Supabase Auth Setup Checklist

Use this checklist to make signup verification and account policies work in production.

## Auth Console Configuration

1. Open Supabase Dashboard > `Authentication` > `URL Configuration` (project "Comic",
   ref `bdjfmxfmhqhzvgrhbbzm`).
2. Set `Site URL` to `https://dreamstreamstudio.ai`. **Never leave it on `localhost`** — any
   redirect that isn't allowed falls back to the Site URL, so a localhost value sends every
   confirmation / reset / magic link to a dead page on the user's phone.
3. Add Redirect URLs:
   - `https://dreamstreamstudio.ai/**` (main app `/auth/callback`, Stream Studio `/live?after=…`)
   - `https://comic2.pages.dev/**` and `https://*.comic2.pages.dev/**` — **keep both**, even
     though `comic2.pages.dev` now 301s to the custom domain (2026-10-22): emails already sent
     carry that `redirect_to` (the tokens ride in the `#fragment`, which survives the
     redirect), and Pages preview deploys still serve on `*.comic2.pages.dev`
   - `http://localhost:*/**` (local development)
4. Verify without sending email (an invalid token redirects to the URL GoTrue accepted, or
   to the Site URL if it didn't):
   `curl -s -o /dev/null -w '%{redirect_url}\n' 'https://bdjfmxfmhqhzvgrhbbzm.supabase.co/auth/v1/verify?token=probe&type=signup&redirect_to=https%3A%2F%2Fdreamstreamstudio.ai%2Flive'`
   must print `https://dreamstreamstudio.ai/live#error=…`, not `http://localhost:3000/#error=…`.
5. Open `Authentication` > `Sign In / Providers` > `Email`: enable **Confirm email** for
   signups (and decide on **Secure email change** — the worker handles both modes).

## Auth email delivery (Cloudflare — no third-party ESP)

> **Since 2026-10-22 the backend sends sign-up confirmation, resend, password reset and magic
> link itself** (`POST /api/auth/email/*`: service-role `auth.admin.generateLink` + our
> templates through the email Worker). Supabase's built-in mailer allows ~2 emails/hour for the
> whole project, and its limit applies before the Send Email Hook, so the hook alone could not
> fix failed sign-ups. Supabase now only sends email change, reauthentication, security
> notices, and the client's fallback mail when the backend is unreachable, which makes items
> 6–8 below optional. The backend throttles per IP and per recipient; links point only at
> `APP_PUBLIC_URL` or the exact origins in `AUTH_LINK_ORIGINS`. Details:
> [`docs/email/SETUP.md`](../email/SETUP.md#auth-emails-go-through-the-backend-default-since-2026-10-22).

All auth email goes out through **Cloudflare Email Sending** on the verified domain
`dreamstreamstudio.ai`; there is no Resend/Postmark/SES account. Full steps, commands and the
per-action mapping: [`docs/email/SETUP.md` §5–6](../email/SETUP.md#5-route-supabase-auth-emails-through-the-worker-send-email-hook).

6. **Primary — Send Email Hook → email worker.** Supabase calls
   `https://dreamstream-email.akhieleshsrirangam.workers.dev/auth-hook` (Standard Webhooks
   signed); the worker renders the branded `auth-*` templates (Stream Studio branding for
   `/live` redirects) and sends from `no-reply@dreamstreamstudio.ai`, reply-to `support@`.
   **Order:** deploy the worker → set its `SUPABASE_AUTH_HOOK_SECRET` Worker secret (the
   `v1,whsec_…` value Supabase generates) → verify with the signed no-op → only then enable
   the hook in `Authentication` > `Hooks`. Enabling it first makes every auth email fail.
7. **Fallback — Cloudflare SMTP** (used by Supabase only while the hook is off):
   `Authentication` > `SMTP Settings` → host `smtp.mx.cloudflare.net`, port `465`, username
   `api_token`, password = a Cloudflare API token with **Email Sending: Edit**, sender
   `no-reply@dreamstreamstudio.ai`. Paste the branded templates from
   `npx tsx scripts/email-preview.ts --supabase` into `Authentication` > `Emails`.
8. **Rate limit:** `Authentication` > `Rate Limits` → raise **Rate limit for sending emails**
   (custom-SMTP default is 30/hour). It applies to hook-sent mail too and is the only cap on
   auth mail (backend `EMAIL_MAX_PER_*` covers `/send` only).
9. **Security notifications** (password/email/phone changed, sign-in or 2-step method
   added/removed): enable the ones you want in `Authentication` > `Emails`; the worker sends
   them with the `auth-security-notice` template.
10. Smoke-test: "Forgot password" on the site → a branded email arrives;
    `npx wrangler tail dreamstream-email` shows `[auth-hook] sent recovery → …`.

## SQL Migration Order

Run these scripts in order from the SQL editor:

1. `server/sql/supabase_auth_profile_migration.sql`
2. `server/sql/profile_private_email_preferences.sql`
3. `server/sql/auth_signup_policy_min_age_8.sql`

## Post-Migration Verification

1. Create a new account with an age under 8 -> should fail.
2. Create a valid account and verify email delivery.
3. Attempt sign-in before email verification -> should be blocked.
4. Test resend verification from the login screen (a second resend within a minute must say
   "Please wait N seconds…").
5. Attempt duplicate username signup -> should fail.
6. Attempt duplicate email signup -> should fail.
7. Request a password reset and a magic link for an address with **no** account -> the UI
   shows the same success message as for a real account, and no account is created.
