# DreamStream Email Worker

Branded transactional email for DreamStream Studio, sent through **Cloudflare Email
Sending** (`env.EMAIL.send`). This Worker is the **only** thing that talks to the email
service, so all auth, abuse-control and branding live in one place.

It exposes three routes:

| Route | Auth | Used by |
|-------|------|---------|
| `GET /health` | none | uptime checks |
| `POST /send` | HMAC `x-email-signature` | the Railway backend (`server/src/services/mailer.ts`) |
| `POST /auth-hook` | Standard Webhooks signature | Supabase **Send Email Hook** (signup / magic link / reset / …) |

Templates come from [`../shared/email`](../shared/email) — the same module the app and the
preview script use, so the inbox matches the product UI.

## Prerequisites (one-time, owner)

1. **Workers Paid plan** — Email Sending needs it ($5/mo). It also covers the Studio worker.
2. **A verified sending domain** in Cloudflare Email → Sending (e.g. `dreamstream.studio`).
   Cloudflare walks you through the **SPF / DKIM / DMARC** DNS records; add them and verify.
3. Pick a `from` address on that domain, e.g. `notifications@dreamstream.studio`.

## Configure

Edit non-secret values in [`wrangler.jsonc`](./wrangler.jsonc) (`EMAIL_FROM`, brand vars,
`SUPABASE_VERIFY_URL`), then set the secrets:

```bash
cd email-worker
npm install

# Shared with the backend — generate a strong random value and use the SAME one in Railway.
wrangler secret put EMAIL_HMAC_SECRET

# Only if you wire the Supabase auth hook (see ../docs/email/SETUP.md). Paste the v1,whsec_… value.
wrangler secret put SUPABASE_AUTH_HOOK_SECRET
```

## Deploy

```bash
npm run typecheck
npm run deploy   # prints the https://dreamstream-email.<account>.workers.dev URL
```

Put that URL in the backend as `EMAIL_WORKER_URL`, and (for the auth hook) point Supabase's
Send Email Hook at `<that-url>/auth-hook`.

## Test

```bash
curl https://dreamstream-email.<account>.workers.dev/health
# {"ok":true,"service":"dreamstream-email-worker"}
```

A signed `/send` smoke test is in [`../docs/email/SETUP.md`](../docs/email/SETUP.md).

## Cost & hard limits

Cloudflare Email Sending: **3,000 emails/month free**, then **$0.35 / 1,000**. The backend
enforces a hard monthly cap (`EMAIL_MAX_PER_MONTH`, default **2,500** — under the free tier)
so you cannot be billed for overage unless you deliberately raise it. See
[`../docs/email/cloudflare-email-cost-and-limits.md`](../docs/email/cloudflare-email-cost-and-limits.md).
