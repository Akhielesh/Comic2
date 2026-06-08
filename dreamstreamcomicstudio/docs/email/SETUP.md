# Email — setup & owner actions

Everything here is a **one-time owner action** (account, DNS, secrets). Until it's done the
mailer stays dormant: the app still works, signups are still captured, no email is sent.

Checklist:

- [ ] 1. Workers Paid plan + verified sending domain (DNS)
- [ ] 2. Apply the DB migration
- [ ] 3. Deploy the email-worker + set its secrets
- [ ] 4. Configure the Railway backend env
- [ ] 5. (Optional) Wire Supabase auth emails through the worker
- [ ] 6. Smoke-test

---

## 1. Cloudflare: plan, domain, DNS

1. Upgrade the Cloudflare account to the **Workers Paid** plan ($5/mo).
2. Dashboard → **Email → Sending** → **Add a domain** (e.g. `dreamstream.studio`).
3. Cloudflare generates **SPF, DKIM and DMARC** DNS records. If the domain's DNS is on
   Cloudflare they can be added automatically; otherwise copy them to your DNS host. Wait for
   **Verified**.
4. Choose a `from` address on that domain, e.g. `notifications@dreamstream.studio`.

> Good deliverability needs all three of SPF/DKIM/DMARC passing. A reasonable starter DMARC is
> `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com` — tighten to `quarantine`/`reject` later.

## 2. Database migration

Run [`server/sql/email_system.sql`](../../server/sql/email_system.sql) against Supabase
(SQL editor or `psql`). It's idempotent and adds `email_log`, `email_suppressions`, and the
newsletter double-opt-in columns on `waitlist_signups`. (Apply after `waitlist_signups.sql`.)

## 3. Deploy the email-worker

```bash
cd email-worker
npm install

# Edit wrangler.jsonc: EMAIL_FROM, EMAIL_FROM_NAME, brand vars, SUPABASE_VERIFY_URL.

# Shared secret with the backend — generate once, reuse in step 4:
openssl rand -hex 32                       # copy the output
wrangler secret put EMAIL_HMAC_SECRET      # paste it

npm run typecheck
npm run deploy                             # note the printed https://dreamstream-email.<account>.workers.dev URL
```

## 4. Backend (Railway) env

Set these on the API service (see [`.env.example`](../../.env.example)):

```bash
EMAIL_WORKER_URL=https://dreamstream-email.<account>.workers.dev
EMAIL_HMAC_SECRET=<the SAME value you put on the worker in step 3>
EMAIL_PUBLIC_BASE_URL=https://api.dreamstream.studio   # public origin of THIS backend
APP_PUBLIC_URL=https://dreamstream.studio              # app origin (post-confirm redirect)
EMAIL_MAX_PER_DAY=200
EMAIL_MAX_PER_MONTH=2500     # keep < 3000 to stay free; raising it past 3000 risks charges
```

> `EMAIL_PUBLIC_BASE_URL` is **required for marketing mail** (it builds the working
> unsubscribe + read-receipt links). Without it, essential mail still sends; marketing mail is
> skipped with `status='skipped'`.

Redeploy. The newsletter form now sends a double opt-in confirmation; the welcome email goes
out when the recipient clicks confirm.

## 5. (Optional) Route Supabase auth emails through the worker

This makes signup-confirmation / magic-link / password-reset / email-change / invite emails
branded and sent via Cloudflare instead of Supabase's default sender.

1. Supabase Dashboard → **Authentication → Hooks** → **Send Email Hook** → enable.
   - **URL:** `https://dreamstream-email.<account>.workers.dev/auth-hook`
   - Copy the generated **secret** (looks like `v1,whsec_…`).
2. On the worker, set it:
   ```bash
   cd email-worker
   wrangler secret put SUPABASE_AUTH_HOOK_SECRET   # paste the v1,whsec_… value
   ```
3. Set `SUPABASE_VERIFY_URL` in `wrangler.jsonc` to your project URL
   (`https://<project-ref>.supabase.co`) so confirm links resolve, then `npm run deploy`.

The worker verifies the Standard Webhooks signature, maps the action type to the matching
`auth-*` template, and sends. If `SUPABASE_AUTH_HOOK_SECRET` is unset, `/auth-hook` returns
503 (disabled) rather than accepting unsigned calls.

> Prefer the dashboard's built-in templates instead? Keep the hook off and paste the rendered
> HTML from `docs/email/previews/auth-*.html` into Auth → Email Templates. The hook is the
> cleaner path (one source of truth, sent via Cloudflare).

## 6. Smoke-test

**Health:**
```bash
curl https://dreamstream-email.<account>.workers.dev/health
# {"ok":true,"service":"dreamstream-email-worker"}
```

**Signed `/send`** (mirrors what the backend does — replace the secret + recipient):
```bash
SECRET='<EMAIL_HMAC_SECRET>'
BODY='{"template":"welcome","to":"you@yourdomain.com","params":{"firstName":"Ada"}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"
curl -X POST https://dreamstream-email.<account>.workers.dev/send \
  -H 'content-type: application/json' -H "x-email-signature: $SIG" -d "$BODY"
# {"ok":true,"messageId":"..."}
```

**Newsletter end-to-end:** submit the marketing form (or `POST /api/newsletter/subscribe`
with `{"email":"you@…"}`) → receive the confirm email → click confirm → receive the welcome
email → click **Unsubscribe** → confirm you land on the app with `?newsletter=unsubscribed`
and a row appears in `email_suppressions`.

Inspect delivery + reads in the `email_log` table.
