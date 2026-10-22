# Email — setup & owner actions

## Auth emails go through the backend (default since 2026-10-22)

**Why.** Supabase Auth's built-in mailer (`noreply@mail.app.supabase.io`) allows about
**2 emails an hour for the whole project**. Past that, every sign-up failed with
`429: email rate limit exceeded` (`over_email_send_rate_limit`). The Send Email Hook (§5) does
not get around it: GoTrue applies `RATE_LIMIT_EMAIL_SENT` *before* it calls the hook.

**How it works now.** Sign-up confirmation, resend, password reset and magic link no longer
ask Supabase to send anything:

1. The app posts to the backend, `POST /api/auth/email/{signup,resend,recovery,magiclink}`
   ([`server/src/routes/authEmail.ts`](../../server/src/routes/authEmail.ts); client wrapper
   [`services/authEmail.ts`](../../services/authEmail.ts), used by `AuthPage`, `AuthContext`
   and `live/account.ts`).
2. The backend asks GoTrue for the link with the service role,
   `auth.admin.generateLink(...)`. That **sends no email and is not email-rate-limited**.
3. It builds a link on our own domain from `properties.hashed_token` and
   `properties.verification_type` (never the raw `email_otp`, never Supabase's `action_link`):
   - main app: `https://dreamstreamstudio.ai/auth/callback?token_hash=…&type=signup|recovery|magiclink`
     (`App.tsx` verifies it with `verifyOtp`);
   - live-app sign-up: `https://dreamstreamstudio.ai/live?after=monitor|settings|create&token_hash=…&type=signup`
     (`consumeAuthReturn()` in `live/account.ts`).

   Verifying needs the page's JavaScript (a POST), so a mail scanner that prefetches the link
   can't burn the token.
4. It mails the branded `auth-*` template through the mailer → email Worker `/send` (HMAC),
   with `brand: 'stream-studio'` for live-app links and **no read-receipt pixel**. Every send
   is an `email_log` row and counts toward `EMAIL_MAX_PER_DAY` / `EMAIL_MAX_PER_MONTH`.

| Endpoint | Body | What it does | Answers |
|---|---|---|---|
| `/signup` | `app` (`main`\|`live`), `after?`, `email`, `password` (8–72), `data`, `captchaToken?` | Validates like the clients (username `^[A-Za-z0-9_]{3,20}$`, first name, DOB `YYYY-MM-DD` not in the future and **age ≥ 8** — the DB trigger doesn't check age —, terms accepted, display name ≤ 40), keeps only whitelisted metadata keys, creates the account and mails the confirmation. An existing **unconfirmed** account just gets a fresh confirmation (its metadata and password are left alone). | `{ok:true, confirmEmail:true}` · `409 email_exists` · `422 database_error` (the profile trigger failed, e.g. username taken — the live app retries with a new one) · `502 send_failed` with `created:true` (no fallback; the UI offers "Resend") |
| `/resend` | `email`, `app?`, `after?`, `captchaToken` (unless signed in as that address) | Re-sends the confirmation, only to an existing unconfirmed account. Never creates one. | always `{ok:true}` |
| `/recovery` | `email`, `captchaToken` | Password-reset link, always to the **main** app's `/auth/callback` (the new-password screen lives there, also for `/live`). | always `{ok:true}` |
| `/magiclink` | `email`, `captchaToken` | Sign-in link for an existing account. Never creates one (GoTrue would turn a magic link for an unknown address into a sign-up). | always `{ok:true}` |

**Abuse controls.**

- **Turnstile.** A `captchaToken`, when sent, must verify (`400 captcha_failed`). Without one,
  `/signup` is allowed only for `app:'live'` with a valid welcome ticket in `data.live_ticket`
  (its sha256 is an unexpired, unredeemed row in `live_welcome_tickets`); otherwise
  `400 captcha_required` while Turnstile is configured. `/resend`, `/recovery` and `/magiclink`
  **always** need a solved challenge while Turnstile is configured (both apps show the widget
  on those screens) — otherwise anyone could spend a stranger's per-address allowance and lock
  them out of these emails for a day. The one exception: a signed-in user re-sending the
  confirmation to their own address (Settings → Security has no widget).
- **Per IP:** 10 requests per 10 minutes (`auth-email` limiter in `server/src/index.ts`).
- **Per recipient** (durable — counted in `email_log`, auth templates with status
  `queued`/`sent`, so a failed send never locks anyone out; requests for one address are
  queued one at a time in the backend so a burst can't all read "nothing sent yet"): one per 60 s
  (`429 too_soon` with `retryAfterS`, message says how many seconds), at most 5 an hour and
  10 a day (`429 too_many`).
- **No account enumeration:** `/resend`, `/recovery` and `/magiclink` answer the same for
  unknown addresses. `/signup` reveals an existing confirmed account, exactly as the UI always
  has. (As with Supabase's own endpoints, a `429` does show that something was mailed to that
  address in the last minute.)
- Logs mask addresses (`a***@example.com`) and never contain tokens or links.

**Where links may point: `AUTH_LINK_ORIGINS`.** A recovery or magic link signs in whoever opens
it, so link origins come from a strict allowlist: `APP_PUBLIC_URL`'s origin plus the exact
origins in `AUTH_LINK_ORIGINS` (comma-separated, default empty). The request's `Origin` is used
only on an **exact** match; anything else gets `APP_PUBLIC_URL`. Never use wildcards or the CORS
helper `isAllowedOrigin()` here: `*.dreamstreamstudio.ai` includes user-controlled Studio preview
hosts, and a reset link sent there would hand the account to the host's owner. For local dev:

```bash
AUTH_LINK_ORIGINS=http://localhost:3000,http://localhost:7000
```

**Fallback.** The client falls back to its old direct Supabase call (`signUp`, `resend`,
`resetPasswordForEmail`, `signInWithOtp`) **only** when the backend is unreachable: a network
error, a 20 s timeout (the container may be cold), `404`/`405`, a non-JSON body, a
`502`/`503`/`504` without a route `code`, or `503 {code:'email_unavailable', fallback:true}`.
The backend sends that last one *before* it spends the captcha token, so the fallback call can
still use it, whenever the service role key is missing, the mailer isn't configured
(`EMAIL_WORKER_URL` / `EMAIL_HMAC_SECRET`) or the `EMAIL_MAX_PER_*` cap is reached. Every other
answer, `429` included, is final: falling back would only hit Supabase's limit. Fallback mail
still goes through Supabase and its limit (or the hook, if enabled).

**What still goes through Supabase.** Email change, reauthentication codes, security
notifications and every fallback-path email. The Send Email Hook (§5) is now **optional**: keep
it on to brand those and send them from our domain.

**Owner checklist.** Production already has everything this needs (`SUPABASE_SERVICE_ROLE_KEY`,
`EMAIL_WORKER_URL`, `EMAIL_HMAC_SECRET`, `TURNSTILE_SECRET_KEY`, `APP_PUBLIC_URL`).

- Deploy order: email Worker (accepts `brand`) → backend container → Pages. Each step is
  backward-compatible: an older Worker ignores `brand` and sends DreamStream branding.
- Auth mail now counts toward `EMAIL_MAX_PER_DAY` (default 200) and `EMAIL_MAX_PER_MONTH`
  (2,500). When a cap is reached, auth email falls back to Supabase until the next day/month,
  so keep headroom.
- Smoke test: "Forgot password" on the site → a branded email from `no-reply@dreamstreamstudio.ai`
  arrives; `email_log` has an `auth-recovery` row with status `sent`; the backend log shows
  `[auth-email] recovery → y***@domain sent (recovery)`. Asking again within a minute answers
  "Please wait N seconds…".

---

## One-time owner setup

Everything here is a **one-time owner action** (account, DNS, secrets). Until it's done the
mailer stays dormant: the app still works, signups are still captured, no email is sent.

Checklist:

- [ ] 1. Workers Paid plan + verified sending domain (DNS)
- [ ] 2. Apply the DB migration
- [ ] 3. Deploy the email-worker + set its secrets
- [ ] 4. Point the backend at the worker
- [ ] 5. (Optional since 2026-10-22) Route Supabase's remaining auth emails through the worker (Send Email Hook) — **follow the order**
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
the recipient clicks confirm. These caps also cover the backend's own auth emails (sign-up
confirm, resend, reset, magic link — see the top section), but **not** auth-hook mail (see 5.4).
Local dev: set `AUTH_LINK_ORIGINS=http://localhost:3000,http://localhost:7000` so auth links
land back on your dev server.

## 5. Route Supabase auth emails through the worker (Send Email Hook)

> **Optional since 2026-10-22.** Sign-up confirmation, resend, password reset and magic link
> are sent by the backend (top section) and never reach Supabase's mailer or this hook. The hook
> still covers what Supabase sends itself: email change, reauthentication, security notices and
> the client's fallback path when the backend is unreachable.

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
  `https://*.comic2.pages.dev/**`, `http://localhost:*/**`. Keep the `comic2` entries even
  though that host now 301s to the custom domain (2026-10-22): links in emails already sent
  carry it as `redirect_to`, and preview deploys still serve there.

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
