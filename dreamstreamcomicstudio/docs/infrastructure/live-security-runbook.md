# Stream Studio security runbook

**Status:** Authoritative for the live stack's security operations (ADR 0006 Phase 0, WS-8).
**Last verified:** 2026-10-29 against the repo (no secret values here — the repo is public).
**Companions:** [`phase0-owner-checklist.md`](./phase0-owner-checklist.md) (every owner step, exact
clicks) · [`ENV_MATRIX.md`](./ENV_MATRIX.md) (every variable) · [`INFRA_MAP.md`](./INFRA_MAP.md) ·
[`SECURITY_FINDINGS.md`](./SECURITY_FINDINGS.md) · ADR
[`0006`](../decisions/0006-native-apps-watch-local-first-security.md) · feature doc
[`baby-monitor.md`](../features/baby-monitor.md) § Security and privacy.

Scope: Stream Studio and its baby monitor — the `dreamstream-live` Worker (MonitorRoom, UserLine,
CallRoom, EventRoom), the `dreamstream-email` Worker's security alerts, the Pages middleware's
browser protections, the Supabase auth settings they depend on, and the admin views that watch them.

> **Ground rules.** Never put a secret in a `wrangler.jsonc`, a doc, an issue or a log line. Never
> weaken an alert, a sound path or camera-offline detection to fix a security problem — turn a
> feature off, not the monitor's safety. Never tell a family more than is true (ADR 0006 D6.4).

---

## 1. Secrets: where each lives, how it is made, how it rotates

Set Worker secrets with `npx wrangler secret put <NAME>` from the Worker's folder
(`dreamstreamcomicstudio/live-worker`, `…/email-worker`), or Cloudflare dashboard → Workers &
Pages → the Worker → Settings → Variables and Secrets. Backend secrets go in D1
`dreamstream-backend-env` or as `dreamstream-api` Worker secrets (`ENV_MATRIX.md` § Where the
backend's env lives). Every feature that needs a secret stays dormant, and says so, until it is set.

| Secret | Lives in | Make it | Rotate | What a rotation costs |
|---|---|---|---|---|
| `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` | `dreamstream-live` | Cloudflare dashboard → Realtime → TURN → create a key | Create a second TURN key, put both secrets, deploy, then delete the old key | Credentials minted from the old key stop working when it is deleted: relayed calls reconnect (clients ask for fresh ICE). Do it in the daytime. |
| `TURN_TAG_SALT` | `dreamstream-live` | 32+ random characters (`openssl rand -base64 32`) | Replace | Every TURN attribution tag changes: per-identifier history restarts. Nothing breaks. |
| `DEVICE_TOKEN_JWK` | `dreamstream-live` | `node scripts/ops/genDeviceTokenKey.mjs` (prints a P-256 private JWK to stdout only) | `node scripts/ops/genDeviceTokenKey.mjs --previous <old.json>` → `{"keys":[new, old]}`; put it; after 30 days (the grant lifetime) put `new` alone | None while both keys are listed. Dropping the old key early signs out every watch/native device (they re-enrol from the phone). |
| `ACT_TOKEN_KEY` | `dreamstream-live` | 32+ random characters | Replace (one key; no overlap) | “I’m on it” from a notification sent in the last 30 minutes fails; the person opens the app instead. **Never rotate during an open incident or at night.** |
| `SECURITY_HOOK_SECRET` | Supabase Vault (name `SECURITY_HOOK_SECRET`), `dreamstream-email`, `dreamstream-live` | 32+ random bytes, base64url | 1. email + live Workers: `old\|new` (both accept either). 2. Vault: `select vault.update_secret((select id from vault.secrets where name = 'SECURITY_HOOK_SECRET'), '<new>');` 3. after 10 minutes, Workers: `new` | None if done in that order. Out of order: new-sign-in emails stop until it matches (sign-ins never fail). |
| `OPS_KEY` | `dreamstream-live` | 16+ random characters | Replace | None (only `POST /api/ops/apns-probe` uses it). |
| `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE` | `dreamstream-live` (Phase 1) | Apple Developer → Keys → + → Apple Push Notifications service | Make a second key (Apple allows two), put it, deploy, revoke the old one | None if the new key is in place first. |
| `FCM_SA_JSON` | `dreamstream-live` (Phase 1) | Google Cloud → IAM → Service accounts → the FCM sender → Keys → Add key (JSON) | Add a new key, put it, delete the old key | None if the new key is in place first. |
| `EMAIL_HMAC_SECRET` | `dreamstream-email` and the backend | 32+ random bytes | Set the Worker to the new value and the backend D1 row in the same minute | Transactional email fails in between (retries cover a minute). |
| `SUPABASE_AUTH_HOOK_SECRET` | `dreamstream-email` | Supabase → Authentication → Hooks → Send Email → generate (`v1,whsec_…`) | Generate a new one in Supabase; the Worker accepts `old\|new` while you switch | Auth emails fail if they don't match. |
| `CF_ANALYTICS_API_TOKEN` | backend (D1 / Worker secret) and the GitHub repository secret of the same name | Cloudflare → My Profile → API Tokens → Account › Account Analytics › Read, scoped to the one account | Make a new token, replace both places, delete the old | Admin → Costs and the daily `stream-cost-watch` show "couldn't measure" until both match. |
| `CLOUDFLARE_API_TOKEN` | GitHub Environment `production-deploy` | One least-privilege token per Worker / Pages project (owner checklist §6) | Make the new token, replace the Environment secret, run one deploy, delete the old | Deploys fail until it matches; nothing live changes. |
| VAPID key pair | Inside the `KEY_HOLDER` Durable Object | Generated by the room | **Never.** It can't be exported, and every web push subscription is bound to it (ADR 0006 D9 #10). | Rotating it would silence every browser's alerts. |

After any suspected leak: rotate first, then look for use. A leaked `TURN_KEY_API_TOKEN` shows up as
TURN egress (Admin → Costs → Stream Studio, alert `turn_leak`); a leaked `DEVICE_TOKEN_JWK` can
mint grants, so rotate **without** keeping the old key and let devices re-enrol.

---

## 2. R2 lifecycle (the backstop behind the rooms' own janitors)

Bucket `dreamstream-live` only (`LIVE_BUCKET`). The rooms purge on time themselves; these rules
catch what a failed sweep or a room that never ended leaves behind. Run once (they persist on the
bucket, not in `wrangler.jsonc`):

```sh
cd dreamstreamcomicstudio/live-worker
npx wrangler r2 bucket lifecycle add dreamstream-live events-expiry events/ --expire-days 9
npx wrangler r2 bucket lifecycle add dreamstream-live events-abort-multipart events/ --abort-multipart-days 1
npx wrangler r2 bucket lifecycle add dreamstream-live quota-rec-expiry quota/rec/ --expire-days 8
npx wrangler r2 bucket lifecycle list dreamstream-live      # expect exactly these three
```

- `events/` must stay **longer than every promise** (replay 24 h, 7-day copies): 9 days.
- `quota/rec/` must stay **longer than 7 days**: each marker counts toward the 10 GB copy
  allowance for 7 days from its upload; deleting sooner would let copies past it.
- Unfinished multipart uploads (a 7-day copy that never completed) go after 1 day instead of R2's
  default 7.
- The monitor stores **nothing** in R2: no video, no audio, no pictures (ADR 0006 D6.4 claim 1).

Check monthly: Admin → Costs → Stream Studio → R2 storage headroom stays far below 10 GB.

---

## 3. Rate limits and caps

Every edge limit **fails open** (no binding, no client address, a limiter error → allowed): the
rooms' own caps and lockouts stand behind them, and a monitor must never stop connecting because a
limiter hiccuped. Workers Rate Limiting counts per Cloudflare location and is eventually
consistent — a brake on floods, not a meter.

| Where | Limit | Key | Refusal | Set in |
|---|---|---|---|---|
| Edge `RL_WS` | 60 WebSocket upgrades / 60 s | client IPv4 or IPv6 /64 | 429 / close 4008 | `live-worker/wrangler.jsonc` `ratelimits` (ADR 0006 WS-7) |
| Edge `RL_GUEST` | 10 share-link joins / 60 s | client address | 429 | same |
| Edge `RL_GUEST_NID` | 30 share-link joins / 60 s | nursery | 429 | same |
| Edge `RL_EVENT` | 10 Stream Studio events created / 60 s | account | 429 | same |
| Edge origin allowlist | upgrades only from `ALLOWED_ORIGINS`, or no `Origin` (native apps) | — | 403 | `live-worker/src/origin.ts` + `ALLOWED_ORIGINS` var |
| MonitorRoom | 14 monitor devices + 24 call lines per nursery (42 sockets in all, with headroom). From WS-9: unauthenticated sockets in their own pool of 8 (oldest evicted first) and 5 s (today 10 s) to authenticate | per room | close 4003 `full` / evicted | `monitorRoom.ts` |
| UserLine | 10 authenticated devices, 6 waiting to authenticate | per member | close | `userLine.ts` |
| Share-link passcodes | Today: 5 wrong in a row lock the **link** 15 min; 20 since the last success turn it off; 12 tries per address per 15 min. Once WS-9 opts in (`lockout: 'guest'`): 5 wrong lock that **address** (hashed) 15 min; 20 in all lock the link 1 h instead of turning it off | per link / hashed address | `locked` / `slow_down` | `monitorGuests.ts` |
| Relay frames | 25 messages/s per camera (burst 8), video ≤ 128 KB | per camera | dropped | `monitorRoom.ts` |
| Auth emails | 10 requests / 10 min per IP; per recipient 1/min, 5/h, 10/day | IP / address | 429 | `server/src/routes/authEmail.ts` |
| Direct calls | 8 calls / 10 min, 40 / day, 15 non-family people / day | caller | `slow_down` | `directCalls.ts` |

To change an edge limit: edit the `ratelimits` entry (limit and period; period must be 10 or 60),
push, and the deploy workflow applies it. Never raise a limit to "fix" a flood without first
reading Admin → Costs → Security (who is refused, on which surface).

---

## 4. Supabase settings checklist (owner actions #3 and #4)

Project **Comic** (`bdjfmxfmhqhzvgrhbbzm`). Menu names move between dashboard versions; if one
isn't where it says, search the dashboard for the setting's name. Exact click paths are in the
owner checklist §3–§4; this is the list to verify against.

| Setting | Should read | Why |
|---|---|---|
| JWT signing keys | **Asymmetric (ES256)** key in use; legacy HS256 secret kept as *previous* only until every Worker verifies via JWKS, then revoked | The Worker verifies tokens locally (`auth/jwks.ts`) instead of asking Supabase; HS256 tokens fall back to an RPC |
| Access token (JWT) expiry | **1200 s (20 min)** | A stolen token dies fast; rooms close a socket at `exp + 120 s` once WS-9 ships |
| Multi-factor | **TOTP enabled** (enrol + verify) | Two-step sign-in; `aal2` enforced for anyone with a factor |
| Secure email change | **On** (both addresses confirm) | An intruder can't quietly move the account |
| Secure password change | **On** (recent sign-in required) | Same |
| Minimum password length | **12** | NIST 800-63B-4 with MFA available; the backend also checks Pwned Passwords at sign-up |
| CAPTCHA | **Turnstile** on sign-in, sign-up and password recovery | Credential stuffing |
| Security notifications | **On** for password changed, email changed, MFA factor added/removed, identity linked/unlinked — delivered through the existing Send Email Hook → `dreamstream-email /auth-hook` | The person hears about every account change; the hook already handles these templates |
| Leaked-password protection | **On** if the plan allows it (Pro) | Free plan: the backend's k-anonymity check covers sign-up only |
| SQL `server/sql/live_security_v2.sql` | **Applied** (after `live_accounts_and_monitor.sql`; re-apply whenever that file is re-applied) | Session-revoked and `mfa_required` checks in every member RPC, devices, `security_events`, the hook |
| Vault secret `SECURITY_HOOK_SECRET` + `live_private_config.security_hook_url` | **Set** (`https://dreamstream-email.akhieleshsrirangam.workers.dev/security`) | The hook can post new-sign-in alerts |
| Auth hook: Customize Access Token (JWT) Claims | **On** → `public.live_access_token_hook` | Adds `ds_mfa`, records sessions, sends new-sign-in alerts |
| Extension `pg_net` | **On** | The hook's HTTP call |

**Verify after any change:** sign in from a new private window → within 2 minutes an email
"New sign-in to your DreamStream account"; Admin → Costs → Security → New sign-ins goes up by one.
A member with TOTP who presents an `aal1` token is refused (`mfa_required`). Re-run
`node server/sql/tests/harness.mjs` locally after any SQL change (it needs Postgres; skipped in CI
without it).

---

## 5. The APNs HTTP/2 probe

Decides whether iPhone alerts go **straight to APNs** or through **FCM for iOS** (ADR 0006 D3). No
Apple account or key needed.

1. GitHub → Actions → **APNs HTTP/2 probe** → Run workflow → host `sandbox` → Run.
   (It deploys a throwaway Worker `dreamstream-apns-probe` with a random `OPS_KEY`, probes, and
   deletes it whatever happens. It uses the `production-deploy` Environment's
   `CLOUDFLARE_API_TOKEN`.)
2. Read the job summary. **Pass** = APNs' JSON error (`MissingProviderToken`) **with an `apns-id`
   header** → send to APNs directly. Anything else → set the live Worker var `PUSH_IOS_VIA=fcm`.
3. Paste the summary's one line under ADR 0006 D3 ("Phase 0 probe"), with the date.
4. Once WS-7 is deployed the same probe runs from production itself:
   `curl -sS -X POST https://dreamstreamstudio.ai/live-api/api/ops/apns-probe -H "x-ops-key: $OPS_KEY"`
   → `{status, apnsId, body, verdict, decision}`. Keep `OPS_KEY` out of shell history
   (`read -s OPS_KEY`).

---

## 6. Watching it: Admin → Costs

Admin console → Costs. Two tabs carry Phase 0:

- **Stream Studio** → *Baby monitor health (ADR 0006)*: DO invocations, rows written and DO GB-s per
  active nursery-day as a **7-day median** against the budgets (≤ 2,600 / ≤ 1,800 / ≤ 40; Cloudflare's
  analytics count each incoming WebSocket message once, the bill 20:1, so 2,600 invocations is the
  ADR's 1,000 billed requests at the simulated night's mix), the
  month average beside it, our-server and relay share of viewer minutes, TURN GB this month, DO
  storage, Glance bumps and pushes per nursery-night.
- **Security**: browser-protection (CSP) reports, new sign-ins and the alerts about them, “Not
  you?” uses, device enrolments, and the live Worker's refusal / disconnect counts.

Everything there is a count. No account, nursery, device, IP address, token, email or page URL is
read for these views. Turn the data on: owner checklist §5b (analytics token), §6c (`CSP_REPORTS`
binding).

| Alert | Means | Do |
|---|---|---|
| `csp_live_blocked` (critical) | The **enforced** policy blocked our own code on Stream Studio | Open the Security tab's CSP table: which directive, which origin. If it is something the monitor needs (a worklet, the model, the Worker, Supabase), set `ENFORCE_LIVE = false` in `functions/_middleware.ts` and ship at once, then fix the policy. Cry detection outranks the CSP. |
| `csp_live_violations` (warning) | First-party report-only violations on Stream Studio in the last 48 h, of the policy `ENFORCE_LIVE` will enforce (Trusted Types reports are not counted: that policy stays report-only for good) | Don't flip `ENFORCE_LIVE` yet. Fix the source or add it to the policy (`tests/edge/liveCsp.built.test.ts` must pass). |
| `not_you_used` (warning) | Someone used “Not you? Secure my account” | §8 playbook if they contact us or it repeats. Their sessions are already ended. |
| `flood:<signal>` (warning) | ≥ 500 of one refusal in a UTC day | Read *Where*. `rate_limited`/`origin_refused` on `edge`: a client loop or probing — check `wrangler tail dreamstream-live` for the pattern (no ids are logged). `mfa_refused` on `monitor`: an app version that doesn't step up — check the client. `preauth_evicted`: socket exhaustion attempt — the caps hold; consider tightening `RL_WS`. |
| `camera_spoof` (warning) | Another account tried to replace a running camera | Usually a family member starting camera mode under their own account. Repeated for one nursery: ask the parents to check People. |
| `request_diet` / `write_diet` / `hibernation` | Phase 0 cost budgets regressed | COST_RUNBOOK §7; `hibernation` is critical — a timer or held-open request keeps rooms awake. |

The **signals** (`shared/stream/signals.ts`) are written by the live Worker into the existing
`stream_usage` Analytics Engine dataset (no new binding): name + surface word + count, coalesced to
≤ 1 point per minute per isolate per signal. Producers call `signal(env, name, surface)` from
`live-worker/src/signals.ts` and `flushSignals(env)` on the rooms' hourly usage flush. Until the
rooms and routes call it (ADR 0006 WS-7/WS-9/WS-10), the Security tab says "not wired", never zero.

---

## 7. Content-Security-Policy operations

- Policy and switch: `functions/_middleware.ts` (`ENFORCE_LIVE`). `/live*` and the Stream Studio
  host get the enforced policy once it is `true`; every other page stays Report-Only.
- Reports: `POST /csp-report` (`functions/csp-report.ts`) counts by disposition, app, directive and
  blocked **origin** — never a URL, a query or a sample.
- Before the flip: 48 h of Admin → Costs → Security → *Stream Studio CSP · last 48 h* = 0 (with the
  binding on) **and** `npm run build && npx vitest run tests/edge/liveCsp.built.test.ts` green.
  That figure counts only the policy the flip enforces. Stream Studio also sends a Trusted Types
  policy (`require-trusted-types-for 'script'`) as a separate Report-Only header, before and after
  the flip, and never enforces it: MediaPipe's loader sets a script's `src`, so every camera that
  loads smart vision in Chrome reports against it. Those reports show as the *Trusted Types
  inventory* line and as `require-trusted-types-for` rows in the table — never in the gate or an
  alert. If one ever arrives as *enforced*, something blocked our code for real:
  `csp_live_blocked` fires and the undo below applies.
- Flip: set `ENFORCE_LIVE = true`, ship, open Stream Studio on a phone, run a camera and a viewer
  for 10 minutes (sound alerts, relay picture, a call). Watch the tab for `csp_live_blocked`.
- Undo: `ENFORCE_LIVE = false`, ship. Takes effect on the next page load.

---

## 8. Incident playbook: suspected account takeover

Triggers: a parent says "that sign-in wasn't me", a “Not you?” use, an unknown member or device in
a nursery, or `not_you_used` in Admin → Costs.

**Goal, in order:** the family keeps monitoring safely → the intruder loses every way in → we learn
how they got in → we tell the family the truth.

1. **Contain (minutes).** Ask the parent to use, from any signed-in device, Stream Studio →
   Settings → **Sign out everywhere** (or the “Not you?” button in the alert email). Once ADR 0006
   WS-5/WS-7 are deployed that ends every session (Supabase `signOut({scope:'global'})`), kicks
   every monitor and call socket (`/api/me/kick`) and, from the email, starts a password reset.
   Before they are deployed, "sign out everywhere" only signs out the device it is pressed on, so
   do the next step too. If they can't sign in at all, or to be sure:
   - Supabase dashboard → Authentication → Users → the user → **Send password recovery**;
   - SQL editor: `delete from auth.sessions where user_id = '<uid>';` — every refresh token dies
     at once, and with `live_security_v2.sql` applied every member RPC refuses those sessions'
     access tokens immediately (`session_revoked`).
   Do not delete the user (that deletes their nurseries). Sockets a revoked session still holds
   close at token expiry + 2 minutes at the latest once WS-9 enforces it (22 minutes with the
   20-minute JWT); until then they close on their next reconnect.
2. **Close every other door.** As the parent, in the nursery:
   - People: remove anyone unknown. Removal closes their sockets, prunes their pushes and (from
     WS-9) rotates the nursery key.
   - Share link: **New link** (or turn it off) and a new passcode — the old link then answers
     "turned off".
   - Devices (Settings → Security → Your devices, and the nursery's Devices list — ADR 0006
     WS-5/WS-6): revoke anything unknown.
   - Turn on two-step sign-in (TOTP, Settings → Security once WS-5 ships).
3. **Look (service role, never in public).** In the Supabase SQL editor:
   `select kind, method, ua, ip_masked, at, notified, secure_used_at from public.security_events where user_id = '<uid>' order by at desc limit 50;`
   IPs are stored masked (/24, /48). Compare with the person's own devices. Check the nursery's
   Security log tab for member, device and share-link changes. Never paste these rows into an
   issue, a chat or a commit — the repo is public.
4. **Ask how.** Reused password (the Pwned Passwords check covers new accounts only — ask them to
   change it everywhere it was used), a phished email, a shared device, a removed family member
   with an old session (pre-WS-9 sockets could outlive removal).
5. **Tell them the truth.** What we saw (sign-in times and rough place from the masked IP), what is
   now closed, what we can't know. Never claim "no one watched" unless the logs show no session
   and no socket in the window; the monitor records no video, so there is nothing to "leak" from
   storage, but a live view at the time is possible if a session was active.
6. **If more than one account is affected,** treat it as a platform incident: §9.
7. **Afterwards:** add a line to `SECURITY_FINDINGS.md` (date, pattern, fix — no personal data).

### 9. Suspected platform compromise (deploy pipeline, Worker code, database)

1. Rotate `CLOUDFLARE_API_TOKEN` (all of them), `SUPABASE_SERVICE_ROLE_KEY`, `DEVICE_TOKEN_JWK`
   (no overlap), `ACT_TOKEN_KEY`, `SECURITY_HOOK_SECRET`, `EMAIL_HMAC_SECRET` (§1).
2. Cloudflare → Workers → each `dreamstream-*` Worker → Deployments: confirm every recent version
   came from a GitHub Actions run of a commit on `Dreamstrream-v1`. Roll back anything else.
3. GitHub → Settings → Security log / Actions runs: unexpected workflow edits (CODEOWNERS
   protects `.github/`), new deploy keys, new collaborators.
4. Be honest about the limit (ADR 0006 D6.4): until Phase 1's verified admission, an **active**
   compromise of our Worker code could enrol a phantom device — every admission is announced to
   parents, so ask families to check their Devices list. Web clients always trust the code we
   serve.

---

## 10. Change log

| Date | Change |
|---|---|
| 2026-10-29 | Created (ADR 0006 WS-8): secrets and rotation, R2 lifecycle, rate limits, Supabase checklist, APNs probe, Admin → Costs Phase 0 views and alerts, CSP operations, account-takeover and platform playbooks. |
