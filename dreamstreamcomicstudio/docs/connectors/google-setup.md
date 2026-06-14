# Google connectors — exact setup runbook

Covers **Gmail, Drive, Calendar, Sheets, YouTube** (one OAuth client, one consent
screen) and **Google Maps** (an API key). Follow top to bottom. Anywhere you see
`dreamstreamstudio.ai`, that's your domain; replace `<...>` placeholders with your real
values.

> **Time:** ~45–60 min for first-time setup. You can connect + test the same day using
> **Testing mode** (no Google verification needed). Public launch needs verification —
> see Part 8.

---

## Part 0 — What you're creating, and who owns it

- A **Google Cloud organization** tied to `dreamstreamstudio.ai` (not a personal Gmail).
- One **Cloud project** (`dreamstream-prod`) holding:
  - an **OAuth consent screen** (External) shown to users who connect their Google account,
  - one **OAuth client** (Web application) → gives you the **Client ID + Client Secret**,
  - the **enabled APIs** (Gmail/Drive/Calendar/Sheets/YouTube),
  - a **Maps API key** (separate auth model).

You'll end with values for these Railway env vars:

| Env var | Value |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | from the OAuth client (Part 5) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | from the OAuth client (Part 5) — secret |
| `GOOGLE_OAUTH_REDIRECT_URL` | `https://<your-backend-domain>/api/connectors/oauth/callback` |
| `CONNECTORS_APP_RETURN_URL` | `https://dreamstreamstudio.ai/?view=connectors` |
| `GOOGLE_MAPS_API_KEY` | from the Maps key (Part 7) — secret |

> **Find `<your-backend-domain>`:** it's wherever your Railway API is reachable — the
> same origin as `VITE_API_BASE_URL` (e.g. `https://api.dreamstreamstudio.ai`). The
> callback path is always `/api/connectors/oauth/callback`.

---

## Part 1 — Create the company identity (Cloud Identity Free)

This gives you a real Google **organization** + admin console for `dreamstreamstudio.ai`
**without paying for Workspace mailboxes**.

1. Go to **https://workspace.google.com/signup/gcpidentity/welcome** (this is the
   *Cloud Identity Free* signup — not paid Workspace).
2. Enter: business name `DreamStream Studio`, employee count, country → **Next**.
3. "Does your business have a domain?" → **Yes** → enter `dreamstreamstudio.ai`.
4. Create your first admin account, e.g. username `admin` → `admin@dreamstreamstudio.ai`,
   and a strong password. **This is the company owner login — store it in your password
   manager, not on a personal device only.**
5. **Verify domain ownership:** Google gives you a **TXT record**. In **Cloudflare → DNS**
   for `dreamstreamstudio.ai`, add it:
   - Type `TXT`, Name `@`, Content = the `google-site-verification=...` string Google shows.
   - Save, then back in Google click **Verify** (can take a few minutes).
6. (Recommended) In **admin.google.com → Directory → Groups**, create a group
   `gcp-owners@dreamstreamstudio.ai` and add yourself. You'll grant Cloud IAM **Owner** to
   this group instead of a person (continuity / bus-factor).

> **Lighter alternative if you don't want Cloud Identity yet:** create a normal Google
> account whose login is `admin@dreamstreamstudio.ai` via
> **accounts.google.com → Create account → Use my current email instead** (the
> verification code arrives through your Cloudflare email routing). It's off your personal
> email and works immediately, but you don't get the org/admin console. Cloud Identity is
> the cleaner long-term answer.

### ⚠️ You will NOT see Gmail for your domain account — and that's correct

Cloud Identity Free gives you an **identity + admin console + Google Cloud org**, but **no
Gmail mailbox**. So:

- In the app launcher you'll see Drive/Calendar/Cloud etc., but **Gmail will say "Activate"
  / be missing**. That button is an **upsell to paid Google Workspace** — ignore it unless
  you actually want company inboxes (see below).
- **Do NOT change your MX records to Google.** Your domain's inbound email stays on
  **Cloudflare Email Routing** (that's what delivers `support@`, `privacy@`,
  `you@dreamstreamstudio.ai` to your real inbox). Switching MX to Google would break that.
- You do **not** need Gmail for any of this setup. The domain account is only the **owner
  login** for Google Cloud + the OAuth app. The consent-screen support email works as a
  plain identity/Group; users emailing it reach you via Cloudflare routing.

**When to upgrade to Google Workspace (~$7/user/mo):** only if you want real
send-and-receive **company mailboxes** (compose/reply as `support@dreamstreamstudio.ai`
inside Gmail) for yourself and teammates. For running the connectors, **Cloud Identity
Free is $0 and already enough** — the upgrade is purely an email/collaboration decision.

#### Setting up Workspace mailboxes for the team (when you want them)

1. **admin.google.com → Billing → Get/Upgrade subscription** → pick a plan
   (**Business Starter ≈ $7/user/mo** is plenty; Standard adds 2 TB/Meet recording). A
   ~14-day free trial is usually offered. Because you already own the domain via Cloud
   Identity, this **upgrades in place** — same org, same admin.
2. **Activate Gmail → set Google's MX records.** The wizard gives you Google MX entries.
   In **Cloudflare DNS**, **replace the Email Routing MX records with Google's MX**
   (Cloudflare stays your DNS host — only the MX records change). ⚠️ This **supersedes
   Cloudflare Email Routing**: once MX points to Google, Gmail receives all domain mail, so
   manage `support@`/`privacy@` as **Gmail mailboxes or Google Groups** instead of
   Cloudflare forwards.
3. **Directory → Users → Add new user** for each teammate → creates
   `name@dreamstreamstudio.ai` with its own mailbox (one license each = per-mailbox cost).
4. **Directory → Groups** → create `support@` and `privacy@` as Groups (or shared
   mailboxes) so they're not tied to one person.
5. **Re-check SPF / DKIM / DMARC** so **both** Gmail *and* the app's transactional sender
   (the Cloudflare email-worker) pass: SPF should `include` Google + the worker's sender,
   enable DKIM for each, and keep DMARC aligned. (Deliverability config — do this once.)

**Cost** = per mailbox (you + N teammates). **None of this affects the connector OAuth
setup** — that works identically on Cloud Identity Free or Workspace, so you can upgrade
before or after wiring the connectors.

### Professional contact addresses (for the consent screen)

Users will see a **support email** on the Google consent screen. Make it a domain address:
1. In **Cloudflare → Email → Email Routing** for `dreamstreamstudio.ai`, add routes:
   - `support@dreamstreamstudio.ai` → your real inbox
   - `privacy@dreamstreamstudio.ai` → your real inbox
2. You'll use `support@dreamstreamstudio.ai` as the consent-screen user-support email in
   Part 4. (The consent screen's *support email* dropdown only lists the admin account and
   Google Groups you belong to — so either pick `admin@…`, or make `support@` a Group you
   own in the admin console.)

---

## Part 2 — Create the Cloud project

1. Sign in to **https://console.cloud.google.com** as `admin@dreamstreamstudio.ai`.
2. Top bar → project picker → **New Project**.
   - Name: `dreamstream-prod`
   - Organization / Location: pick `dreamstreamstudio.ai` (it appears once Part 1 is done).
   - **Create**, then select the project in the top bar.
3. (Recommended) **IAM & Admin → IAM → Grant access** → add `gcp-owners@dreamstreamstudio.ai`
   as **Owner**.
4. (Recommended) Make a second project `dreamstream-dev` the same way for local testing.

---

## Part 3 — Enable the APIs

In `dreamstream-prod`, go to **APIs & Services → Library** and **Enable** each of these
(search the name, click, **Enable**):

- **Gmail API**
- **Google Drive API**
- **Google Calendar API**
- **Google Sheets API**
- **YouTube Data API v3**
- **Geocoding API**  ← for Maps (Part 7)
- **Places API**     ← for Maps (Part 7)

> You do **not** need to enable a separate API for `userinfo.email`/`profile` — those are
> OpenID Connect scopes resolved at the OAuth layer.

---

## Part 4 — Configure the OAuth consent screen

Console path: **APIs & Services → OAuth consent screen** (newer consoles label this
**"Google Auth Platform"** at `console.cloud.google.com/auth`).

1. **User Type: External** → **Create**. (External is required because your end users
   connect *their own* Google accounts; "Internal" only works for your own org's staff.)
2. **App information:**
   - App name: `DreamStream Studio`
   - User support email: `support@dreamstreamstudio.ai` (or `admin@…`)
   - App logo: optional now, **required for verification** later.
3. **App domain:**
   - Application home page: `https://dreamstreamstudio.ai`
   - Privacy policy: `https://dreamstreamstudio.ai/?view=privacy`
   - Terms of service: `https://dreamstreamstudio.ai/?view=terms`
4. **Authorized domains:** add `dreamstreamstudio.ai`.
5. **Developer contact information:** `admin@dreamstreamstudio.ai`. → **Save and continue**.
6. **Scopes → Add or remove scopes** → paste these **exact** scopes (one per line), tick
   them, **Update**:
   ```
   openid
   https://www.googleapis.com/auth/userinfo.email
   https://www.googleapis.com/auth/userinfo.profile
   https://www.googleapis.com/auth/gmail.readonly
   https://www.googleapis.com/auth/drive.readonly
   https://www.googleapis.com/auth/calendar.events.readonly
   https://www.googleapis.com/auth/spreadsheets.readonly
   https://www.googleapis.com/auth/youtube.readonly
   ```
   - **Sensitive:** Calendar, Sheets, YouTube.
   - **Restricted:** Gmail, Drive — these are the ones that require a security assessment
     before public launch (Part 8).
   - All are **read-only** by design — keep it that way.
   → **Save and continue.**
7. **Test users → Add users:** add your own Google address(es) and any teammates who'll
   test. **In Testing mode, only these users can connect** (up to 100) — and you need
   **no verification**. → **Save and continue.**
8. Leave **Publishing status = Testing** for now.

---

## Part 5 — Create the OAuth client (Client ID + Secret)

Console path: **APIs & Services → Credentials → Create credentials → OAuth client ID**.

1. **Application type: Web application.**
2. Name: `dreamstream-connectors-prod`.
3. **Authorized redirect URIs → Add URI** — add your backend callback **exactly**:
   ```
   https://<your-backend-domain>/api/connectors/oauth/callback
   ```
   (e.g. `https://api.dreamstreamstudio.ai/api/connectors/oauth/callback`)
   For the dev project/client also add:
   ```
   http://localhost:7071/api/connectors/oauth/callback
   ```
4. **Authorized JavaScript origins:** not required for this flow (the token exchange is
   server-side). You may leave it blank, or add `https://dreamstreamstudio.ai` if the
   console insists.
5. **Create.** Copy the **Client ID** and **Client secret** immediately into your password
   manager.

> The redirect URI must match what the server sends **byte-for-byte** (scheme, host, path,
> no trailing slash). If it ever mismatches you'll get Google error `redirect_uri_mismatch`.

---

## Part 6 — Set the env vars in Railway (OAuth)

In **Railway → your backend service → Variables**, set:

```
GOOGLE_OAUTH_CLIENT_ID=<the Client ID from Part 5>
GOOGLE_OAUTH_CLIENT_SECRET=<the Client secret from Part 5>
GOOGLE_OAUTH_REDIRECT_URL=https://<your-backend-domain>/api/connectors/oauth/callback
CONNECTORS_APP_RETURN_URL=https://dreamstreamstudio.ai/?view=connectors
```

- `GOOGLE_OAUTH_REDIRECT_URL` **must equal** the redirect URI you registered in Part 5.
- `CONNECTORS_ENABLED` defaults to `true`; leave it unless you want to hide the feature.
- Redeploy the backend so the new vars load.

**Verify it's wired:** sign into the app, open the browser console on the Connectors page,
or hit `GET /api/connectors/catalog` — the Google connectors should now report
`"configured": true`.

---

## Part 7 — Google Maps API key

Maps uses an API **key** (not OAuth), so it's separate.

1. **APIs & Services → Credentials → Create credentials → API key.** Copy the key.
2. Click the key → **Edit**:
   - **API restrictions → Restrict key →** select **Geocoding API** and **Places API** only.
   - **Application restrictions:** our server calls Maps server-side from Railway (no fixed
     egress IP), so leave **None** *but* rely on the API restrictions above + a budget alert
     (next step). If your Railway plan gives a static egress IP, prefer **IP addresses** and
     add it.
3. **Billing + guardrails:** Maps requires a billing account. Set a **Budget alert**
   (**Billing → Budgets & alerts**) and consider a low quota cap (**APIs & Services →
   Geocoding/Places → Quotas**) so a mistake can't run up a bill.
4. Railway var:
   ```
   GOOGLE_MAPS_API_KEY=<the restricted key>
   ```
   Users can also paste their **own** Maps key in the Connect dialog; this platform key is
   the shared fallback.

---

## Part 8 — Going public (verification) — plan ahead

While **Publishing status = Testing**, only your listed test users can connect, with **no
review**. That's fine for building + demos.

To let **anyone** connect (Publishing status = **In production**), Google requires **OAuth
verification**, and because Gmail + Drive are **restricted** scopes, that includes:

- A **verified domain** (done in Part 1), public **privacy policy** + **terms** (you have
  these), an app **logo**, and a **demo video** showing the consent + data use.
- An **annual independent CASA security assessment** for the restricted scopes (budget time
  + cost; start ~6–8 weeks before launch).

**Recommendation:** ship to your test users now; open the verification track in parallel and
keep scopes minimal/read-only to ease review. If you only need Calendar/Sheets/YouTube at
first (sensitive, not restricted), you can launch those without CASA and add Gmail/Drive
once the assessment clears.

---

## Quick checklist

- [ ] Cloud Identity on `dreamstreamstudio.ai`, domain TXT verified (Part 1)
- [ ] `support@` / `privacy@` routing in Cloudflare (Part 1)
- [ ] Project `dreamstream-prod` created, owner = `gcp-owners@` (Part 2)
- [ ] 7 APIs enabled (Part 3)
- [ ] Consent screen: External, scopes added, **you added as a test user** (Part 4)
- [ ] OAuth Web client created; redirect URI registered (Part 5)
- [ ] Railway OAuth vars set + redeployed; catalog shows `configured: true` (Part 6)
- [ ] Maps key created, restricted, budget alert set; `GOOGLE_MAPS_API_KEY` set (Part 7)
- [ ] Verification/CASA track opened before public launch (Part 8)

When this is done: **app → Connectors → Connect Google → tick services → one Google consent
→ connected.**
