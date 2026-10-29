# ADR 0006 Phase 0 — owner checklist

Everything in ADR 0006 Phase 0 that needs **your** accounts, keys or dashboard clicks, in the order
to do it, with the exact steps. Nothing here can be done from the repo, and no secret value belongs
in the repo, an issue or a chat — paste values only into the dashboards and the `wrangler secret
put` prompt.

- Why each step exists: [ADR 0006](../decisions/0006-native-apps-watch-local-first-security.md) →
  *Owner actions* (the numbers below are that table's).
- What to do when something fires afterwards: [`live-security-runbook.md`](./live-security-runbook.md).
- Menu names move between dashboard versions. If a click path below doesn't match, search the
  dashboard for the setting's name; the setting itself is what matters.

Tick each box as you go. **Order:** §1 and §7 first (they protect everything else), then §3 → §4 →
§5, then §6, then the release steps (§R) as each wave merges.

---

## §1 Hardware-key or passkey 2FA everywhere (owner action #1) — now, 1 h

Until Phase 1, a compromised deploy account is the biggest single path to a family's feed.

- [ ] **GitHub:** Settings → Password and authentication → Passkeys → *Add a passkey* (or Security
      keys → *Register new security key*). Then *Two-factor authentication* → remove SMS as a
      method; keep the recovery codes offline.
- [ ] **Cloudflare:** My Profile → Authentication → *Security Keys* → add one (or a passkey).
      Remove SMS. Account → Members: you are the only Super Administrator; remove stale members.
- [ ] **Supabase:** Account → Security → *Multi-factor authentication* → add an authenticator app
      (Supabase has no hardware-key login; use an app, never SMS). Organization → Members:
      enforce MFA for the org if offered.
- [ ] **Google (the account owning Firebase / Drive OAuth):** myaccount.google.com → Security →
      *Passkeys and security keys* → add; *2-Step Verification* → remove SMS / voice.
- [ ] **Apple ID (developer account, once it exists):** Settings → your name → Sign-In & Security
      → *Security Keys* → add two.
- [ ] Store recovery codes for all five somewhere offline (not in this repo, not in email).

## §2 Legal entity, D-U-N-S, store accounts (owner action #2) — start now, needed by Phase 1 week 4

- [ ] Decide the entity that will own the apps (or decide to start as an individual and transfer
      later — Apple and Google both allow a transfer).
- [ ] Entity: request a D-U-N-S number (free, 1–2 weeks) via Apple's D-U-N-S lookup tool
      (developer.apple.com → Account → Membership → *D-U-N-S Number*).
- [ ] Apple Developer Program → *Enroll* as an Organization ($99/year).
- [ ] Google Play Console → *Create account* → Organization ($25 once). As an individual, plan
      Play's **12 testers for 14 days** before production.
- [ ] Note the Apple Team ID for later (owner action #15).

## §3 Supabase Auth settings (owner action #3) — Phase 0 week 1–2, 1 h

Project **Comic** (`bdjfmxfmhqhzvgrhbbzm`). The list of what each should read, and how to verify,
is in the runbook §4.

- [ ] **Signing keys → ES256.** Project Settings → **JWT Keys** → *Migrate JWT secret* (or *Create
      standby key* → ECC P-256) → *Rotate keys* so the ES256 key signs. Keep the legacy HS256
      secret as *previous* (old tokens still verify) — **don't revoke it yet**: revoke only after
      the live Worker has run with JWKS verification for a full day (ADR 0006 WS-4; the Worker
      falls back to asking Supabase for HS256 tokens, so nothing breaks either way).
- [ ] **Access token expiry → 1200 seconds.** Project Settings → JWT Keys (or Authentication →
      Sessions) → *Access token expiry time* → `1200`.
- [ ] **TOTP.** Authentication → **Multi-Factor** (Sign In / Providers → MFA in some versions) →
      TOTP: *Enabled* for enrolment and verification. Leave phone MFA off.
- [ ] **Secure email change** and **Secure password change** → On. Authentication → Sign In /
      Providers → Email (or Authentication → Settings → User Signups / Security).
- [ ] **Minimum password length → 12.** Same Email provider page → *Minimum password length*.
      Leave the character-class requirements off (NIST: length + breached-password check).
- [ ] **Turnstile CAPTCHA.** Cloudflare → Turnstile → the existing widget (the one whose site key
      is `VITE_TURNSTILE_SITE_KEY`) → copy its *secret key*. Supabase → Authentication → **Attack
      Protection** → *Enable CAPTCHA protection* → provider **Turnstile** → paste the secret →
      Save. (Supabase then demands a captcha token on sign-in, sign-up and recovery; the app
      already sends one where `VITE_TURNSTILE_SITE_KEY` is set — check sign-in on
      `stream.dreamstreamstudio.ai` and `dreamstreamstudio.ai` right after.)
- [ ] **Security notification emails.** Authentication → **Emails** → *Security* (or
      *Notifications*) → turn on: Password changed, Email address changed, MFA factor
      enrolled, MFA factor unenrolled, Identity linked, Identity unlinked. They go out through the
      Send Email Hook that is already on (`dreamstream-email /auth-hook` handles these types).
- [ ] **Decide Pro.** Pro ($25/month) adds leaked-password protection and session controls
      (time-box, single session). If yes: Organization → Billing → upgrade, then Authentication →
      Attack Protection → *Prevent use of leaked passwords* → On.
- [ ] Verify: sign in from a private window → still works; a wrong-length password at sign-up is
      refused; Settings → Security (Stream Studio) can enrol TOTP once WS-5 ships.

## §4 Apply the security SQL and switch on the hook (owner action #4) — Phase 0 week 2, 30 min

**Before you start:** `live_accounts_and_monitor.sql` is applied (it is in production). This file
redefines every member RPC; re-apply it whenever `live_accounts_and_monitor.sql` is re-applied.

- [ ] Supabase → Database → **Extensions** → `pg_net` → enable (schema `extensions`).
- [ ] SQL editor → paste all of `dreamstreamcomicstudio/server/sql/live_security_v2.sql` → Run.
      Run it a second time: it must succeed again (idempotent). Or via the Supabase MCP
      `apply_migration` with the name `live_security_v2`.
- [ ] Make the hook secret (one value, used in three places): run `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`
      locally and keep it in your password manager for the next three steps only.
- [ ] SQL editor:
      `select vault.create_secret('<the value>', 'SECURITY_HOOK_SECRET');`
- [ ] SQL editor:
      `insert into public.live_private_config (key, value) values ('security_hook_url', 'https://dreamstream-email.akhieleshsrirangam.workers.dev/security') on conflict (key) do update set value = excluded.value, updated_at = now();`
- [ ] Email Worker: `cd dreamstreamcomicstudio/email-worker && npx wrangler secret put SECURITY_HOOK_SECRET` → paste the value.
- [ ] Live Worker: `cd ../live-worker && npx wrangler secret put SECURITY_HOOK_SECRET` → the same value (it signs `/x/user/:uid/notify`, WS-7).
- [ ] Authentication → **Hooks** → *Customize Access Token (JWT) Claims* → Postgres function →
      schema `public`, function `live_access_token_hook` → Enable.
- [ ] Verify: sign in from a new private window → within 2 minutes the email *"New sign-in to your
      DreamStream account"* arrives; Admin → Costs → Security → *New sign-ins* counts it. Signing
      in must never fail because of the hook — if it does, disable the hook and tell the team.
- [ ] **“Not you?” button:** the email carries it only when the email Worker's var
      `SECURE_ACCOUNT_PAGE` is `on`. WS-5 (the `#/secure` page) sets it in
      `email-worker/wrangler.jsonc` when it ships; until then the email sends people to
      Settings → Security. After WS-5 deploys, send yourself a sign-in alert and click the button
      once (it really does end every session and start a reset — use a test account).

## §5 Worker secrets (owner action #5) — Phase 0 week 2, 15 min

From `dreamstreamcomicstudio/live-worker` (`npx wrangler secret put <NAME>`, paste when asked):

- [ ] `DEVICE_TOKEN_JWK` — run `node ../scripts/ops/genDeviceTokenKey.mjs` and paste its output
      (one line of JSON). Device grants and 10-minute device tokens (watches, native apps).
- [ ] `ACT_TOKEN_KEY` — `openssl rand -base64 48`. “I’m on it” straight from a notification.
- [ ] `OPS_KEY` — `openssl rand -base64 24`. Only for `POST /api/ops/apns-probe`.
- [ ] `SECURITY_HOOK_SECRET` — done in §4.
- [ ] Later (Phase 1 week 2, after owner actions #9 and #13): `APNS_KEY_P8`, `APNS_KEY_ID`,
      `APNS_TEAM_ID`, `APNS_BUNDLE`, `FCM_SA_JSON`. Native push stays off without them.
- [ ] Verify: `npx wrangler secret list` shows the names (never the values).

### §5b Turn on the measurements (Admin → Costs and the daily cost watch)

- [ ] Cloudflare → My Profile → API Tokens → *Create token* → Custom → permission **Account ›
      Account Analytics › Read**, account resources: only the DreamStream account → Create.
- [ ] Put it in **two** places: (1) the backend — D1 `dreamstream-backend-env` console:
      `INSERT INTO backend_env(name, value) VALUES ('CF_ANALYTICS_API_TOKEN', '<token>') ON CONFLICT(name) DO UPDATE SET value = excluded.value;`
      (and `CLOUDFLARE_ACCOUNT_ID` the same way, if not there); (2) GitHub → repo → Settings →
      Secrets and variables → Actions → *New repository secret* `CF_ANALYTICS_API_TOKEN` (the
      daily `stream-cost-watch` job).
- [ ] Optional but recommended: Cloudflare → Workers & Pages → Durable Objects → copy each
      namespace id of `MonitorRoom`, `EventRoom`, `UserLine`, `CallRoom` → backend var / D1 row
      `STREAM_DO_NAMESPACES` = `MonitorRoom=<id>,EventRoom=<id>,UserLine=<id>,CallRoom=<id>`, and the
      same as a GitHub Actions **variable**. Without it the per-nursery KPIs are account-wide
      upper bounds.
- [ ] Cloudflare → Billing → *Budget alerts* → $10/month (the backstop if metering ever breaks).
- [ ] Verify: Admin → Costs → Stream Studio shows measured figures; Security shows CSP counts
      once §6c is done.

## §6 Cloudflare hardening (owner action #6) — Phase 0, 1 h

- [ ] **One token per deploy target** instead of the shared `CLOUDFLARE_API_TOKEN`. My Profile →
      API Tokens → Create → Custom, for each:
      - `deploy-live` — Account › Workers Scripts › Edit, Account › Workers R2 Storage › Edit (for
        lifecycle rules), Zone › Workers Routes › Edit on `dreamstreamstudio.ai`.
      - `deploy-api` — Workers Scripts › Edit, D1 › Edit, Containers › Edit (if listed), Zone ›
        Workers Routes › Edit.
      - `deploy-email` — Workers Scripts › Edit.
      - `deploy-egress` — Workers Scripts › Edit, Zone › Workers Routes › Edit.
      - Pages builds use the Cloudflare ↔ GitHub integration and need no token.
      Today every workflow reads one secret name, `CLOUDFLARE_API_TOKEN`, from the
      `production-deploy` Environment; splitting it needs a workflow change per token (a follow-up
      in ADR 0006). Until then, create **one** token with exactly the union of those permissions
      (not *Edit Cloudflare Workers* templates with account-wide everything) and replace the
      current one; delete the old token.
- [ ] **Certificate Transparency monitoring:** SSL/TLS → Edge Certificates → *Certificate
      Transparency Monitoring* → On (emails you when any CA issues a certificate for the domain).
- [ ] **HSTS preload — only after checking every subdomain serves HTTPS** (`www`, `stream`,
      `atlas`, any preview CNAMEs): SSL/TLS → Edge Certificates → HSTS → max-age 2 years,
      includeSubDomains, preload → then submit at hstspreload.org. Preload is hard to undo; skip it
      if any subdomain might ever need plain HTTP.
- [ ] **R2 lifecycle rules:** run the four commands in the runbook §2 once.
- [ ] **§6c CSP report counts:** Workers & Pages → the Pages project → Settings → Bindings (older
      dashboards: Settings → Functions → Bindings) → *Add*
      → **Analytics Engine** → variable name `CSP_REPORTS`, dataset `csp_reports` → Save →
      redeploy the latest production deployment (bindings apply to new deployments). If you pick
      another dataset name, set the backend var `CSP_REPORTS_DATASET` to it. Verify: after a day,
      Admin → Costs → Security → *Browser protections* shows "measured".

## §7 GitHub (owner action #7) — Phase 0, 30 min

Repository `Akhielesh/Comic2`, default and production branch `Dreamstrream-v1`.

- [ ] **Environment `production-deploy`:** Settings → Environments → `production-deploy` (it
      already exists if a deploy has run) → *Required reviewers*: you → *Deployment branches and
      tags*: selected → `Dreamstrream-v1` → move `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
      into its *Environment secrets* and delete the repository-level copies. Every production
      deploy then waits for your approval in Actions — that is the point.
- [ ] Phase 1: create `ios-release` and `android-release` the same way (required reviewer, branch
      `Dreamstrream-v1`), empty until the signing secrets exist.
- [ ] **Branch protection:** Settings → Rules → Rulesets → *New branch ruleset* → target
      `Dreamstrream-v1` → Require a pull request before merging (1 approval, *Require review from
      Code Owners*), Require status checks (the `ci` workflow's `verify` and `server-boot` jobs), Block force pushes, Restrict
      deletions. (CODEOWNERS already names `.github/`, `functions/`, `public/_headers`,
      `wrangler.jsonc` files and `server/sql/`.) Note: this changes the "push straight to
      production" habit — merges go through a PR you approve.
- [ ] **Code security:** Settings → Code security → *CodeQL analysis* → **Default setup**;
      *Secret scanning* → On, *Push protection* → On; *Dependabot alerts* → On (Dependabot
      version updates are already configured with a 7-day cooldown);
      **Private vulnerability reporting** → On (`SECURITY.md` and `security.txt` point to it).

## §18 Disclosure policy and privacy policy (owner action #18) — Phase 0 / before the store listing

- [ ] Read `.github/SECURITY.md` and `public/.well-known/security.txt` (contact
      `support@dreamstreamstudio.ai`, expiry 2027-10-01). Approve, or say what to change. Set a
      calendar reminder to renew `Expires` before 2027-10-01.
- [ ] The privacy policy (`components/PrivacyPolicy.tsx`) does not mention the baby monitor yet.
      Approve this text (it follows ADR 0006 D6.4 and says only what is true today) before we add
      it:

      > **Baby monitor.** The monitor never records: no video, audio or pictures are stored on
      > our servers. Video and sound go directly between your devices, encrypted (DTLS-SRTP);
      > when your network can't connect them directly, our relay (Cloudflare TURN) forwards
      > encrypted data it can't read. When even that isn't possible, a lower-quality picture
      > passes through our server's memory to reach you; it is never stored. Our servers do see:
      > your account email, nursery and baby names, who is a member, alert and incident times and
      > kinds, sleep and tracker summaries, the IP address you connect from, and when you use the
      > monitor. Sign-in alerts keep your IP address shortened (the last part removed) for
      > 180 days. Not a medical device.

      Once the Phase 0 relay encryption is live (the room lists `e2e1`), the third sentence becomes:
      "…passes through our server encrypted with a key only your devices hold."

## §R Release steps (ADR 0006 §5) — as each wave merges

- [ ] **R1 — Wave 1 deployed:** pages headers start Report-Only, Worker features dormant. Do §3
      and §4 now.
- [ ] **R2 — APNs probe:** runbook §5 (GitHub → Actions → *APNs HTTP/2 probe* → Run → paste the
      line into ADR 0006 D3).
- [ ] **R3 — Wave 2 deployed** (WS-9/10/11): the room's `hello` lists `reauth, view, eid, e2e1,
      glance1`. Then set the backend var / D1 row **`STREAM_PHASE0_SHIPPED=1`** and the GitHub
      Actions variable of the same name — the Phase 0 cost budgets' alerts switch on.
- [ ] **R4 — 48 h of clean CSP reports** (Admin → Costs → Security → *Stream Studio CSP · last
      48 h* = 0, with §6c done; it counts only the policy the flip enforces — the Trusted Types
      reports from cameras running smart vision are listed separately and don't hold it up): set `ENFORCE_LIVE = true` in `functions/_middleware.ts` (a code
      change — ask the team), then runbook §7's 10-minute phone check.
- [ ] **R5 — 7 days later:** Admin → Costs → Stream Studio → *Baby monitor health* shows the 7-day
      medians with 7 days, all *within budget*; record the three numbers in ADR 0006's acceptance
      list. Only then does Phase 1 cut its first TestFlight build. (The request figure is
      *invocations* as Cloudflare counts them — every incoming WebSocket message once — so its
      budget reads ≤ 2,600, which is the ADR's 1,000 billed requests at the simulated night's mix.)

---

## Change log

| Date | Change |
|---|---|
| 2026-10-29 | Created (ADR 0006 WS-8). |
