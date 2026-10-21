# Email — setup & owner actions

Everything here is a **one-time owner action** (account, DNS, secrets). Until it's done the
mailer stays dormant: the app still works, signups are still captured, no email is sent.

Checklist:

- [ ] 1. Workers Paid plan + verified sending domain (DNS)
- [ ] 2. Apply the DB migration
- [ ] 3. Deploy the email-worker + set its secrets
- [ ] 4. Point the backend at the worker
- [ ] 5. Route Supabase auth emails through the worker (Send Email Hook) — **follow the order**
- [ ] 6. (Recommended) Cloudflare SMTP fallback for when the hook is off
- [ ] 7. Smoke-test

The deployed worker lives at **`https://dreamstream-email.akhieleshsrirangam.workers.dev`**
(Worker name `dreamstream-email` in [`email-worker/wrangler.jsonc`](../../email-worker/wrangler.jsonc);
the backend reaches it via `EMAIL_WORKER_URL` in [`api-proxy/wrangler.jsonc`](../../api-proxy/wrangler.jsonc)).

---

## 1. Cloudflare: plan, domain, DNS

1. Upgrade the Cloudflare account to the **Workers Paid** plan ($5/mo).
2. Dashboard → **Email → Sending** → **Add a domain** (e.g. `dreamstreamstudio.ai`).
3. Cloudflare generates **SPF, DKIM and DMARC** DNS records. If the domain's DNS is on
   Cloudflare they can be added automatically; otherwise copy them to your DNS host. Wait for
   **Verified**.
4. Choose a `from` address on that domain, e.g. `notifications@dreamstreamstudio.ai`.

> Good deliverability needs all three of SPF/DKIM/DMARC passing. A reasonable starter DMARC is
> `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com` — tighten to `quarantine`/`reject` later.

## 2. Database migration

Run [`server/sql/email_system.sql`](../../server/sql/email_system.sql) against Supabase
(SQL editor or `psql`). It's idempotent and adds `email_log`, `email_suppressions`, and the
newsletter double-opt-in columns on `waitlist_signups`. (Apply after `waitlist_signups.sql`.)

## 3. Deploy the email-worker

```bash
cd email-worker
npm ci

# Non-secret config lives in wrangler.jsonc: EMAIL_FROM, EMAIL_FROM_NAME, brand vars,
# SUPABASE_VERIFY_URL (https://bdjfmxfmhqhzvgrhbbzm.supabase.co).

# Shared secret with the backend — generate once, reuse in step 4. Never commit it (public repo).
openssl rand -hex 32                       # copy the output
npx wrangler secret put EMAIL_HMAC_SECRET  # paste it

npm run typecheck
npm run deploy                             # → https://dreamstream-email.akhieleshsrirangam.workers.dev
```

## 4. Backend env

The backend runs as the `dreamstream-api` Worker's container (see
[`docs/infrastructure/`](../infrastructure/README.md)). `EMAIL_WORKER_URL`,
`EMAIL_PUBLIC_BASE_URL` and `APP_PUBLIC_URL` are already non-secret `vars` in
[`api-proxy/wrangler.jsonc`](../../api-proxy/wrangler.jsonc); only the secret needs setting
(D1 `backend_env` row or a Worker secret on `dreamstream-api` — never in `wrangler.jsonc`):

```bash
EMAIL_HMAC_SECRET=<the SAME value you put on the worker in step 3>
EMAIL_MAX_PER_DAY=200
EMAIL_MAX_PER_MONTH=2500     # keep < 3000 to stay free; raising it past 3000 risks charges
```

> `EMAIL_PUBLIC_BASE_URL` is **required for marketing mail** (it builds the working
> unsubscribe + read-receipt links). Without it, essential mail still sends; marketing mail is
> skipped with `status='skipped'`.

The newsletter form then sends a double opt-in confirmation; the welcome email goes out when
the recipient clicks confirm. (These backend caps do **not** cover auth-hook mail — see 5.4.)

## 5. Route Supabase auth emails through the worker (Send Email Hook)

With the hook on, **every** Supabase Auth email — signup confirmation, magic link / email OTP,
password reset, invite, email change, reauthentication code and the security notifications —
is rendered with the branded `auth-*` templates in [`shared/email`](../../shared/email) and sent
from `no-reply@dreamstreamstudio.ai` (security notices from `notifications@`; replies always go
to `support@`). Flows that redirect into the live app (`redirect_to` path `/live…`) are branded
**Stream Studio**; everything else **DreamStream Studio**.

> **Why the order matters:** once the hook is enabled, Supabase sends nothing itself (SMTP is
> not used). If the worker can't verify the call — e.g. `SUPABASE_AUTH_HOOK_SECRET` isn't set,
> so `/auth-hook` answers `503 auth hook disabled` — every signup, sign-in link and password
> reset **fails** until it's fixed. So: worker first, secret second, hook last.

Supabase project **"Comic"** (`bdjfmxfmhqhzvgrhbbzm`). Dashboard pages are linked inline.

### 5.1 Deploy the worker fix

Deploy as in step 3, then check it's live and still disabled (expected at this point):

```bash
curl -s https://dreamstream-email.akhieleshsrirangam.workers.dev/health
# {"ok":true,"service":"dreamstream-email-worker"}
curl -s -X POST https://dreamstream-email.akhieleshsrirangam.workers.dev/auth-hook -H 'content-type: application/json' -d '{}'
# {"error":{"http_code":503,"message":"auth hook disabled"}}
```

### 5.2 Set `SUPABASE_AUTH_HOOK_SECRET` on the worker

1. [Authentication → Hooks](https://supabase.com/dashboard/project/bdjfmxfmhqhzvgrhbbzm/auth/hooks)
   → **Add hook → Send Email hook** → type **HTTPS**, URL
   **`https://dreamstream-email.akhieleshsrirangam.workers.dev/auth-hook`** → **Generate secret**
   and copy the `v1,whsec_…` value. **Don't enable the hook yet** (leave its *Enable* switch
   off, or keep the dialog open until 5.2.3 is done).
2. Put the same value on the worker (prompted, so it never lands in shell history or the repo):
   ```bash
   cd email-worker
   npx wrangler secret put SUPABASE_AUTH_HOOK_SECRET   # paste v1,whsec_…
   ```
   Rotating later? The worker accepts several secrets joined with `|`
   (`v1,whsec_OLD|v1,whsec_NEW`) so old and new can overlap.
3. Prove the secret matches with a **signed no-op** — an unknown action type is acknowledged
   with 200 and nothing is sent:
   ```bash
   read -rs SECRET   # paste the v1,whsec_… value (not echoed)
   KEY_HEX=$(printf '%s' "${SECRET#v1,whsec_}" | base64 -d | od -An -v -tx1 | tr -d ' \n')
   TS=$(date +%s); ID="msg_smoke_$TS"
   BODY='{"user":{"email":"you@example.com"},"email_data":{"email_action_type":"smoke_test"}}'
   SIG=$(printf '%s' "$ID.$TS.$BODY" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$KEY_HEX" -binary | base64)
   curl -s -X POST https://dreamstream-email.akhieleshsrirangam.workers.dev/auth-hook \
     -H 'content-type: application/json' -H "webhook-id: $ID" -H "webhook-timestamp: $TS" \
     -H "webhook-signature: v1,$SIG" -d "$BODY"
   # {"ok":true,"skipped":true,"reason":"unsupported email_action_type \"smoke_test\""}
   # 401 {"error":{…"invalid signature"}} ⇒ the worker secret and this value differ.
   unset SECRET KEY_HEX
   ```

### 5.3 Enable the hook in Supabase

Back in [Authentication → Hooks](https://supabase.com/dashboard/project/bdjfmxfmhqhzvgrhbbzm/auth/hooks),
enable the Send Email hook and save. Then trigger a real email (e.g. "Forgot password" on the
site) and watch it arrive; `npx wrangler tail dreamstream-email` shows one
`[auth-hook] sent recovery → y***@domain (messageId)` line per email (addresses masked, no tokens).

How each Supabase `email_action_type` is handled:

| `email_action_type` | Sent to | Template | Link / code |
|---|---|---|---|
| `signup`, `invite`, `magiclink`, `recovery` | `user.email` | `auth-confirm-signup` / `auth-invite` / `auth-magic-link` / `auth-recovery` | `{SUPABASE_VERIFY_URL}/auth/v1/verify?token=<token_hash>&type=<action>&redirect_to=<redirect_to>` + the 6-digit `token` |
| `email` (email OTP) | `user.email` | `auth-magic-link`, code-first | the 6-digit `token` big, link (`type=email`) as backup |
| `reauthentication` | `user.email` | `auth-reauthentication` | 6-digit `token` only |
| `email_change`, **Secure email change ON** | **two** emails: `user.email` *and* `user.new_email` | `auth-email-change` ("approve" / "confirm new") | current address ← `token_hash_new` + `token`; new address ← `token_hash` + `token_new` (Supabase's names are reversed for backward compatibility). Both links must be used. |
| `email_change`, Secure email change OFF | `user.new_email` only | `auth-email-change` | `token_hash` + `token` (or `token_new`) |
| `*_notification` (password / email / phone changed, identity linked / unlinked, MFA factor enrolled / unenrolled) | `user.email` (email-changed → the **old** address) | `auth-security-notice` | none |
| anything else (a type Supabase adds later) | — | — | **200, nothing sent**, logged `[auth-hook] skipped …` so the user's action never fails |

Security notifications are only sent by Supabase if enabled per type in
[Authentication → Emails](https://supabase.com/dashboard/project/bdjfmxfmhqhzvgrhbbzm/auth/templates)
(Security notifications). Secure email change is the **Secure email change** switch on the
[Email provider](https://supabase.com/dashboard/project/bdjfmxfmhqhzvgrhbbzm/auth/providers?provider=Email).

### 5.4 Raise the auth email rate limit

[Authentication → Rate Limits](https://supabase.com/dashboard/project/bdjfmxfmhqhzvgrhbbzm/auth/rate-limits)
→ **Rate limit for sending emails**. Supabase applies it *before* calling the hook, so it caps
hook-sent mail too (custom-SMTP projects start at **30/hour**). Raise it to your expected peak
(e.g. 100/hour). It is also the **only** cap on auth mail — the backend's `EMAIL_MAX_PER_*`
limits cover `/send` only — so keep `rate × hours` in mind against Cloudflare's 3,000/month
free tier ([cost doc](./cloudflare-email-cost-and-limits.md)). Supabase additionally enforces
a per-user minimum interval (~60 s) between emails.

### 5.5 URL configuration (where the links land)

[Authentication → URL Configuration](https://supabase.com/dashboard/project/bdjfmxfmhqhzvgrhbbzm/auth/url-configuration):

- **Site URL:** `https://dreamstreamstudio.ai` (never `localhost` — any disallowed
  `redirect_to` falls back to it).
- **Redirect URLs:** `https://dreamstreamstudio.ai/**`, `https://comic2.pages.dev/**`,
  `http://localhost:*/**`.

The worker only formats `redirect_to` into the link; Supabase validates it against this list
when the link is opened.

### Turning it off

Disable the hook in Authentication → Hooks: Supabase immediately goes back to sending through
SMTP (step 6, or its rate-limited built-in sender if no SMTP is configured). Deleting the
worker secret instead makes every auth email fail (503) — don't use that as an off switch.

## 6. (Recommended) Cloudflare SMTP fallback

Supabase uses SMTP **only while the hook is off**, so this is the safety net for disabling the
hook (and it replaces the built-in sender, which only mails your team and is heavily
rate-limited). Same Cloudflare Email Sending service and limits as the worker, over SMTP:

[Authentication → SMTP Settings](https://supabase.com/dashboard/project/bdjfmxfmhqhzvgrhbbzm/auth/smtp) → enable custom SMTP:

| Field | Value |
|---|---|
| Sender email | `no-reply@dreamstreamstudio.ai` |
| Sender name | `DreamStream Studio` |
| Host | `smtp.mx.cloudflare.net` |
| Port | `465` (implicit TLS — 587/STARTTLS is not supported) |
| Username | `api_token` (the literal string) |
| Password | a Cloudflare API token with **Email Sending: Edit** (account-owned recommended) |

Create the token in the Cloudflare dashboard → API Tokens; it can send as any onboarded domain
on the account, so treat it like a password (store it only in Supabase).

In this mode Supabase renders its own templates. To keep the branding, generate
Supabase-ready versions of ours and paste them into
[Authentication → Emails](https://supabase.com/dashboard/project/bdjfmxfmhqhzvgrhbbzm/auth/templates):

```bash
npx tsx scripts/email-preview.ts --supabase   # → docs/email/previews/supabase/*.html + index.html (subjects)
```

They use Supabase's `{{ .ConfirmationURL }}`, `{{ .Token }}`, `{{ .NewEmail }}`, `{{ .OldEmail }}`,
`{{ .Provider }}`, `{{ .FactorType }}` placeholders. Limits of this mode: one brand only
(DreamStream Studio — no Stream Studio variant), and with Secure email change on Supabase sends
the same "Change email address" template to both addresses.

## 7. Smoke-test

**Health:**
```bash
curl https://dreamstream-email.akhieleshsrirangam.workers.dev/health
# {"ok":true,"service":"dreamstream-email-worker"}
```

**Signed `/send`** (mirrors what the backend does — replace the recipient; the secret is read
without echoing):
```bash
read -rs SECRET   # paste EMAIL_HMAC_SECRET
BODY='{"template":"welcome","to":"you@yourdomain.com","params":{"firstName":"Ada"}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"
curl -X POST https://dreamstream-email.akhieleshsrirangam.workers.dev/send \
  -H 'content-type: application/json' -H "x-email-signature: $SIG" -d "$BODY"
# {"ok":true,"messageId":"..."}
unset SECRET
```

**Signed `/auth-hook`:** see 5.2.3 (no email sent).

**Newsletter end-to-end:** submit the marketing form (or `POST /api/newsletter/subscribe`
with `{"email":"you@…"}`) → receive the confirm email → click confirm → receive the welcome
email → click **Unsubscribe** → confirm you land on the app with `?newsletter=unsubscribed`
and a row appears in `email_suppressions`.

Inspect delivery + reads in the `email_log` table (backend `/send` mail; auth-hook mail shows in
`wrangler tail` and the Cloudflare Email Sending dashboard logs).
