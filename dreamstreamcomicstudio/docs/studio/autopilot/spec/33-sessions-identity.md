# 33 — Sessions & Identity Architecture

> Part III · Architecture · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [F-Enterprise Foundations](../F-ENTERPRISE-FOUNDATIONS.md) (**F3** — this section is its deep
> design; also F0 audit log, F6 migrations, F8 step-up/CSRF) ·
> [Master Plan](../00-MASTER-PLAN.md) (**A8** Operator Console — device/presence surface) ·
> [Cloudflare Topology](./23-cloudflare-topology.md) (§23.2.1 `UserCoordinatorDO`) ·
> [Data Model & Schema](./26-data-model-schema.md) (§26.11 `sessions`, `user_devices`) ·
> [Realtime & Sync](./34-realtime-sync.md) (instant revocation push).
> Grounded in a real code audit (2026-06): `contexts/AuthContext.tsx`,
> `services/deviceSessions.ts`, `services/supabase.ts`, `server/src/middleware/auth.ts`.

## 33.1 Scope & the honest one-line story

Identity today is **only a Supabase JWT**. There is no first-party session record, no idle or
absolute timeout, no authoritative device control, and every authenticated request pays a
**network round-trip to Supabase** (`supabase.auth.getUser(token)` in
`server/src/middleware/auth.ts`). Sign-out scopes (local / others / global) are real and good;
the device registry is **decorative** — `removeDevice` deletes a row but does not revoke the
session, and the `user_devices` table it writes to **has no migration**.

This section is the F3 design that closes those gaps without throwing away what works. It is
deliberately *layered*: Supabase GoTrue stays the **credential issuer** (we do not rebuild
auth), and we add a thin, first-party **session/identity layer** on top that gives us
timeouts, binding, step-up re-auth, an authoritative device registry, MFA, and suspicious-login
detection — with the live coordination half (instant cross-device revocation, presence) handled
by the `UserCoordinatorDO` (§23.2.1, F4).

Three honesty rules govern this section, the same three the rest of the spec lives by:

1. **Shipped vs planned is marked everywhere.** Each capability is tagged **SHIPPED**,
   **PARTIAL/DECORATIVE**, or **PLANNED (F3)** with a file reference.
2. **Layer, don't replace.** Supabase issues and refreshes credentials; we never mint our own
   primary auth tokens. The first-party layer *augments* the JWT — it never becomes a second
   identity provider.
3. **Postgres is the record, the DO is the live mirror.** The durable truth of "is this session
   revoked / expired?" is a row in Supabase; the `UserCoordinatorDO` is the sub-second push
   channel and presence cache. A cold DO rebuilds from Postgres (§23.2.4).

---

## 33.2 Current state — audited, honest, file-referenced

### 33.2.1 Capability scorecard

| Capability | Verdict | Where / how | The gap |
|---|---|---|---|
| Credential issuance | 🟢 **SHIPPED** | Supabase GoTrue; `createClient` in `services/supabase.ts:88` | none — keep it |
| Session bootstrap & refresh | 🟢 **SHIPPED** | `AuthContext.tsx` `getSession()` + `onAuthStateChange` (`SIGNED_IN`/`TOKEN_REFRESHED`) | none — keep it |
| Sign-out (this device) | 🟢 **SHIPPED** | `signOut()` → `signOut({ scope: 'local' })` (`AuthContext.tsx:100`) | none |
| Sign-out everywhere | 🟢 **SHIPPED** | `signOutAll()` → `scope: 'global'` (`AuthContext.tsx:105`) | revocation is **not instant** on other devices (poll/refresh latency) |
| Sign-out other sessions | 🟢 **SHIPPED** | `signOutOthers()` → `scope: 'others'` (`AuthContext.tsx:111`) | same latency caveat |
| Remember-me / persistence mode | 🟢 **SHIPPED** | `getAuthPersistMode()` + `authStorage` switching `localStorage`↔`sessionStorage` (`services/supabase.ts:45,64`) | none — but no server-side idle/absolute cap behind it |
| Server-side auth check | 🟡 **SHIPPED but costly** | `requireAuth` → `getUser(token)` per request (`middleware/auth.ts:74`) | **network round-trip per request**; hard dependency on Supabase uptime (returns 503 `AUTH_PROVIDER_UNAVAILABLE` if down) |
| First-party session record | 🔴 **MISSING** | — | no idle timeout, no absolute timeout, no device/IP binding, no step-up |
| Device registry | 🟡 **DECORATIVE** | `services/deviceSessions.ts` (`registerDevice`/`listDevices`/`removeDevice`) | `removeDevice` "does **NOT** invalidate its Supabase session" (`deviceSessions.ts:85`); writes to a table that **has no migration** |
| MFA / TOTP | 🔴 **MISSING** | — | no second factor; password + email only |
| Step-up re-auth on sensitive actions | 🔴 **MISSING** | `changePassword` exists (`AuthContext.tsx:138`) but billing/deploy are not gated | a stolen live session can deploy / change billing |
| Suspicious-login detection | 🔴 **MISSING** | — | new device / new geo is silent |

### 33.2.2 The four files, precisely

- **`server/src/middleware/auth.ts`** — `requireAuth` extracts the bearer token and calls
  `resolveAuthUser` → `supabase.auth.getUser(token)`. This is a **GoTrue HTTP call on every
  request**: correct, but it adds latency and couples request success to Supabase availability
  (the catch returns `503 AUTH_PROVIDER_UNAVAILABLE`). `optionalAuth` does the same, fail-open.
  There is **no local verification** and **no session lookup** — the JWT *is* the whole
  identity.

- **`contexts/AuthContext.tsx`** — the client identity surface. It already implements three
  real sign-out scopes (`local`/`global`/`others`), calls `registerDevice(userId)` on sign-in,
  and purges all local BYOK secrets on sign-out (`clearAllKeys()` — a genuinely good
  shared-device protection). It does **not** track or enforce any session lifetime.

- **`services/supabase.ts`** — configures the client with `persistSession: true` and a custom
  `authStorage` that routes the token to `localStorage` (remember-me) or `sessionStorage`
  (per-tab) based on `getAuthPersistMode()`. Good UX; but "remember me" only changes *where the
  refresh token lives*, not *how long a session may live* — there is no server-enforced cap.

- **`services/deviceSessions.ts`** — generates a stable `device_id` (localStorage UUID), derives
  a friendly name from the user-agent, and upserts a `user_devices` row on login. Two problems:
  (1) `removeDevice` only deletes the row (comment is explicit: it does not invalidate the
  session); (2) the columns it writes (`device_id`, `device_name`, `last_seen`,
  `user_agent`) **do not match any migration** — there is no `user_devices` DDL anywhere, so in
  any clean environment these writes silently fail (the `try/catch` swallows it: "Non-critical —
  don't block login"). The registry therefore *looks* like device management but controls
  nothing.

- **Server Supabase clients** (`server/src/services/supabase.ts`) — an anon client (used by
  `getUser`) and a lazily-built **service-role admin client** (`getSupabaseAdmin()`). The admin
  client is the handle F3 needs for **real revocation** (GoTrue admin API:
  `auth.admin.signOut(userId, scope)` / refresh-token revoke) — it already exists; today nothing
  in the device path uses it.

### 33.2.3 What is genuinely good and must be preserved

The three sign-out scopes, the remember-me storage switch, the **on-sign-out secret purge**
(`clearAllKeys` — prevents the previous user leaking BYOK keys on a shared device), and the
fail-closed `503` when the auth provider is unreachable are all correct and stay. F3 adds *on
top of* this; it does not regress any of it.

---

## 33.3 The target (F3) — a layered identity architecture

The target keeps Supabase as the credential authority and adds five things, each independently
shippable behind a flag (`SESSIONS_V2`):

```
        ┌──────────────────────── credential tier (KEEP) ────────────────────────┐
        │  Supabase GoTrue — issues/refreshes JWT, password+MFA, admin revoke API │
        └───────────────┬─────────────────────────────────────────┬──────────────┘
       JWT (signed)     │                                          │ admin API (revoke)
                        ▼                                          ▼
        ┌──────────── verify tier (F3) ────────────┐   ┌──────── record tier (F3) ────────┐
        │ verifyRequest():                          │   │ Supabase Postgres:                │
        │  1. local JWKS verify (cached keys)       │──►│  sessions      (timeouts/binding) │
        │  2. sessions lookup (idle/abs/revoked)    │   │  user_devices  (authoritative)    │
        │  3. step-up freshness for sensitive ops   │   │  audit_log     (F0, auth events)  │
        └───────────────┬───────────────────────────┘   └───────────────────────────────────┘
                        │ verified principal                       ▲
                        ▼                                          │ mirror (epoch, revoked)
        ┌──────────── live tier (F4, §23.2.1) ─────────────────────┘
        │ UserCoordinatorDO — sessions/presence over WS Hibernation,
        │ INSTANT cross-device revocation push, multi-device UI sync
        └──────────────────────────────────────────────────────────┘
```

### 33.3.1 Local JWT verification via JWKS (remove the per-request round-trip)

**Goal:** stop calling `getUser(token)` on every request. Instead, verify the JWT **locally**
against Supabase's JWKS, with the keys cached in process.

Supabase signs JWTs with an **asymmetric signing key** whose public keys are published at the
project JWKS endpoint (`/.well-known/jwks.json`). We fetch and cache those keys, verify the
token's signature + `exp`/`aud`/`iss` locally, and only hit GoTrue when we *must* (a `kid` we
have not seen → refetch JWKS; admin operations; MFA enrollment).

| Aspect | Today (`getUser`) | Target (JWKS) |
|---|---|---|
| Per-request cost | 1 GoTrue HTTP round-trip | in-process signature verify (sub-ms) |
| Supabase uptime coupling | hard (503 on outage) | soft (verify works from cache; only refresh/admin need GoTrue) |
| Key rotation | n/a | handled by JWKS `kid` + cache TTL + on-miss refetch |
| Revocation granularity | GoTrue decides (token expiry) | **our `sessions` table decides** (instant via §33.3.2) |

**Cache discipline:** JWKS cached with a TTL (e.g. 10 min `[design]`) and a **negative-miss
refetch** — an unknown `kid` forces one refetch before rejecting, so a rotated key never causes a
mass 401. The cache is per-process; on Workers it lives in the edge `verifyRequest()` path
(§23.5, the auth gateway) backed by KV for cross-isolate sharing.

**The catch JWKS does not solve:** a valid, unexpired JWT is still *bearer* — possession is use.
Local verify makes auth cheap, but it does **not** give us revocation or timeouts on its own.
That is exactly why JWKS is paired with first-party session records (§33.3.2): the signature
proves *who*, the session row decides *whether this is still allowed right now*.

### 33.3.2 First-party server-side session records (timeouts, binding, step-up)

A `sessions` row (§26.11) is created at sign-in, keyed to the user and a `device_id`, and is the
**server-side authority** layered on the verified JWT. It buys four things the bare JWT cannot:

| Property | Mechanism (`sessions` columns) | Policy default `[design]` |
|---|---|---|
| **Idle timeout** | `idle_expires_at`, bumped on each authenticated request | 30 min idle → expire |
| **Absolute timeout** | `absolute_expires_at`, fixed at issue, never extended | 12 h (remember-me 30 d) |
| **Session binding** | `device_id` + `ip` checked against the request | IP-change → step-up, not hard-fail (mobile roaming) |
| **Step-up re-auth** | `step_up_at` timestamp of last re-auth | sensitive actions require `< 5 min` |
| **Revocation** | `revoked_at` + `revoke_reason` (`logout\|admin\|timeout\|suspicious`) | checked on every verify |

The verify path resolves the JWT → finds the matching active session → checks
`revoked_at is null AND now < idle_expires_at AND now < absolute_expires_at` → bumps
`last_active_at`/`idle_expires_at`. A failing check returns 401 with a machine-readable reason
so the client can route to re-login vs step-up vs "signed out elsewhere." The idle sweep is a
cheap cron over the `sessions_idle_idx` partial index (§26.11) that marks expired rows
`revoked_at = now(), revoke_reason='timeout'`.

**Remember-me, made honest.** Today remember-me only changes storage location
(`authStorage`, `services/supabase.ts`). In the target it *also* selects the session's
`absolute_expires_at` policy (long-lived vs session-scoped), so the choice the user makes at
login has a real, server-enforced lifetime — not just a different bucket the refresh token sits
in.

### 33.3.3 Authoritative device registry (the missing migration + real revocation)

This is the headline F3 fix. Two concrete changes:

1. **Create the `user_devices` migration** (§26.11, F6 migration **M2**). The table becomes
   real, so `registerDevice`/`listDevices` actually persist and RLS isolates them
   (`user_devices_owner`: `auth.uid() = user_id`). **Schema reconciliation is required**: the
   shipped `deviceSessions.ts` writes `device_id` / `device_name` / `last_seen`, while the §26.11
   migration defines `device_label` / `last_seen_at` / `revoked_at` / `trusted`. The migration is
   the source of truth; `deviceSessions.ts` is updated to match (rename `device_name → device_label`,
   `last_seen → last_seen_at`, add the stable per-browser `device_id` as an indexed column, add
   `trusted` for step-up skip). This mismatch is *why the registry silently no-ops today* and
   must be fixed as part of M2, not after.

2. **Make `removeDevice` actually revoke.** Replace the comment-laden no-op with a real
   revocation that (a) sets `user_devices.revoked_at`, (b) marks every `sessions` row for that
   device `revoked_at = now(), revoke_reason='admin'`, (c) calls the **Supabase admin API** via
   the existing service-role client (`getSupabaseAdmin()`) to revoke that device's refresh token
   so it cannot silently refresh back, and (d) tells the `UserCoordinatorDO` to **push the
   revocation instantly** to that device's WebSocket (§23.2.1, F4) and to all observers
   (presence update). Revocation is a privileged server route — never a raw client `delete`.

```
 removeDevice(deviceId):                     [PLANNED F3 — replaces deviceSessions.ts:85 no-op]
   require step-up freshness (sensitive)      -- §33.6
   tx:
     UPDATE user_devices SET revoked_at=now() WHERE id=deviceId AND user_id=:me
     UPDATE sessions     SET revoked_at=now(), revoke_reason='admin'
                         WHERE device_id=deviceId AND user_id=:me AND revoked_at IS NULL
   getSupabaseAdmin().auth.admin.signOut(userId, { ... per-session/refresh-token revoke ... })
   audit_log <- { action:'auth.device_revoke', actor:me, resource:'device:'+deviceId }   -- F0
   USER_COORDINATOR(me).revoke(deviceId)      -- instant WS close (4001) + presence fan-out
```

The result is what the device list *pretends* to do today: "sign out this device" that genuinely
ends that device's access, immediately, and is auditable.

### 33.3.4 MFA / TOTP (Supabase native)

Use **Supabase's native MFA (TOTP)**: `auth.mfa.enroll()` → QR/secret → `auth.mfa.challenge()`
→ `auth.mfa.verify()`. Enrollment is opt-in (required for admins via policy). Once enrolled, the
JWT carries an `aal` (authenticator-assurance-level) claim; our verify path can require `aal2`
for sensitive routes (a stronger, native form of step-up — §33.6). Recovery codes are issued at
enrollment; lost-factor recovery is an admin/owner flow (audited). No custom TOTP code: we wrap
the GoTrue MFA endpoints, keeping Supabase the credential authority per rule #2.

### 33.3.5 Suspicious-login detection

On sign-in / new session creation, compare the request's `device_id`, `ua_hash`, and
coarse geo (from `ip`, e.g. country via the edge `cf` object) against the user's known
`user_devices` and recent `sessions`. A **new device or new country** raises a signal that:
notifies the user (email/in-app per `user_settings.notify_*`, §26.11), writes an `audit_log`
row (F0, `action='auth.suspicious_login'`), and — at higher risk (new country *and* new device)
— can require step-up before the session is fully trusted. Detection is heuristic and tuned to
avoid false positives on legitimate roaming; it never silently locks a user out.

---

## 33.4 The `UserCoordinatorDO` role (live coordination tier)

The session *record* (Postgres) gives correctness; the `UserCoordinatorDO` gives **liveness**.
It is fully specified in [§23.2.1](./23-cloudflare-topology.md); here is its identity-layer role
and the seam to this section.

| Concern | Owned by | Why |
|---|---|---|
| Is this credential valid (signature)? | `verifyRequest()` JWKS (§33.3.1) | stateless, cheap, edge-local |
| Is this session still allowed (timeout/revoked)? | `sessions` table (§33.3.2) | durable record-of-truth |
| Push revocation to a device *now* | `UserCoordinatorDO.revoke()` | sub-second WS close, not poll |
| Which devices are online, viewing what | `UserCoordinatorDO` presence | live cache, feeds A8 console |
| Cross-device UI state (active venture, theme) | `UserCoordinatorDO` LWW bus | converge without DB round-trip |

**One object per user**, addressed `idFromName("user:" + userId)` (§23.2.3), holding each
active `(device, session)` over a **hibernating WebSocket** (no idle billing, §23.2.5). It keeps
a `session_epoch` in its meta table; "sign out everywhere" bumps the epoch, **closes every
socket (`close(4001,'revoked')`)**, and rejects reconnects bearing a stale epoch — turning
today's eventually-consistent `scope: 'global'` sign-out into an **instant** one across devices.

**Consistency seam (the load-bearing rule):** for any *irreversible* identity fact (revocation,
epoch bump), the DO **writes Postgres first** (so a cold DO rebuilds correctly), then updates its
own SQLite and fans out over WS. The DO is authoritative for *liveness*; Postgres is
authoritative for *record* (§23.2.4). Presence and the epoch cache may be lossy on a cold start
— they are rebuilt from reconnecting sockets and the `sessions` table.

The A8 Operator Console reads this DO's presence to render "you're also signed in on iPhone,
viewing Acme Booking" and to drive the device-management UI (list, "sign out this device," "sign
out everywhere") backed by §33.3.3.

---

## 33.5 Session & identity data model + RLS

The DDL is owned by [§26.11](./26-data-model-schema.md) (this section references it, does not
redefine it). Summary for the identity layer:

| Table | Status | RLS anchor | Policy | Purpose here |
|---|---|---|---|---|
| `sessions` | **NEW (F3)**, migration **M3** | `user_id` (root) | `for all using (auth.uid()=user_id)` | idle/absolute timeout, device/IP binding, step-up (`step_up_at`), revocation (`revoked_at`,`revoke_reason`) |
| `user_devices` | **NEW (F3)**, migration **M2** | `user_id` (root) | `for all using (auth.uid()=user_id)` | authoritative device registry; `revoked_at`, `trusted` |
| `audit_log` | **NEW (F0)**, migration **M1** | none (admin-only) | RLS **enabled, deny-all** to clients | auth events (login, revoke, suspicious, MFA enroll), `request_id` correlated |
| `user_settings` | **NEW** | `user_id` | `for all using (auth.uid()=user_id)` | `notify_*` gating suspicious-login alerts |

**Ordering (F6).** `M1 audit_log` → `M2 user_devices` → `M3 sessions` (FK → `user_devices`).
`sessions.device_id` is `references user_devices(id) on delete set null`, so M2 must precede M3
(§26.13). All DDL is idempotent (`create table if not exists`, `drop policy … create policy`).

**RLS posture.** Both `sessions` and `user_devices` are **root** tables with direct
`auth.uid() = user_id` isolation — a user (or a leaked anon key) can only ever read/write their
own session and device rows, defense-in-depth even though the **service role bypasses RLS** for
the privileged revoke/admin paths (§26.1). The auth-event trail goes to `audit_log`, which is
deny-all to clients (admin/service-role reads only) so it cannot be tampered with from the
browser. Pruning of revoked/expired `sessions` runs as a privileged job (~30-day retention,
§26.14); the durable audit fact survives in `audit_log` (≥1 year).

**Mirror table — DO vs Postgres.** The `UserCoordinatorDO` keeps its own per-user `sessions`
table in SQLite (§23.2.1) as the live cache. That is **not** a second source of truth: every
revocation/epoch write lands in Postgres first. If the two ever disagree, Postgres wins on the
next verify (a stale DO cannot un-revoke a Postgres-revoked session, because §33.7 step 3 checks
the `sessions` row).

---

## 33.6 Sensitive-action re-auth (step-up) policy

A live session is not enough to perform an irreversible or money-moving action. These require a
**fresh re-auth** (password or MFA `aal2`) within a short window, recorded as `sessions.step_up_at`.

| Action | Gate | Why |
|---|---|---|
| Change billing / payment method | step-up `< 5 min` **or** `aal2` | money; account-takeover blast radius |
| Approve a **production** deploy checkpoint | step-up `< 5 min` | irreversible public ship (Master Plan §8, §26.6) |
| Approve a **spend** checkpoint (real money) | step-up `< 5 min` | budget brake is a security control (§26.5) |
| Add / revoke a BYO connection (Nango) | step-up `< 5 min` | grants/removes cloud access |
| Change password / email / MFA | step-up `< 5 min` | account recovery surface |
| "Sign out this device" / "everywhere" | step-up `< 5 min` | prevents a hijacked session locking out the owner |
| Delete a venture (hard) | step-up + checkpoint | destructive (§26.14) |
| Normal build / chat / read | none | not sensitive; would harm UX |

The flow: a gated route checks `now - step_up_at < 5 min` (or `aal2` in the JWT). If stale, it
returns `401 { code: 'STEP_UP_REQUIRED' }`; the client prompts for password/TOTP, calls a
re-auth endpoint that verifies against GoTrue and stamps `sessions.step_up_at = now()`, then
retries the original request. **Trusted devices** (`user_devices.trusted = true`) may relax the
window for low-risk gates per `user_settings`, never for billing or prod deploy. Every step-up
and every gated action is written to `audit_log` (F0). This maps directly to F3's "re-auth on
sensitive actions" and F8's CSRF/step-up review.

---

## 33.7 `verifyRequest()` — the pseudocode (JWKS + session check)

This is the target replacement for `requireAuth` (`server/src/middleware/auth.ts`). It runs at
the edge auth gateway on Workers (§23.5) and as Express middleware during the transition; both
share the same logic behind the `SESSIONS_V2` flag, with the current `getUser` path as the
instant rollback.

```ts
// TARGET — replaces middleware/auth.ts requireAuth(); flag: SESSIONS_V2
// Returns a verified principal or a typed 401/503; never a bearer-only pass.

async function verifyRequest(req): Promise<Principal> {
  const token = extractBearerToken(req.headers.authorization);   // unchanged from auth.ts
  if (!token) throw Unauthorized('MISSING_TOKEN');

  // ── 1. LOCAL signature verify (no Supabase round-trip) ──────────────────────────
  const header = decodeJwtHeader(token);                 // { alg, kid }
  let jwk = JWKS_CACHE.get(header.kid);
  if (!jwk) jwk = await refreshJwks(header.kid);          // one refetch on unknown kid (rotation)
  if (!jwk) throw Unauthorized('UNKNOWN_SIGNING_KEY');

  let claims;
  try {
    claims = await verifyJwt(token, jwk, {                // verifies sig + exp + iss + aud locally
      issuer: SUPABASE_ISSUER, audience: 'authenticated', clockToleranceSec: 30,
    });
  } catch (e) {
    throw Unauthorized(isExpired(e) ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN');
  }
  const userId = claims.sub;
  const sessionRef = claims.session_id ?? claims.jti;    // GoTrue session id / jti
  const aal = claims.aal ?? 'aal1';                       // MFA assurance level

  // ── 2. FIRST-PARTY SESSION check (timeouts / binding / revocation) ──────────────
  // Hot path: ask the UserCoordinatorDO live cache first; fall back to Postgres.
  const session = await loadSession(userId, sessionRef); // DO cache → sessions table
  if (!session)               throw Unauthorized('NO_SESSION');           // unknown/cold → re-login
  if (session.revoked_at)     throw Unauthorized('SESSION_REVOKED', session.revoke_reason);
  const now = Date.now();
  if (now >= session.absolute_expires_at) {
    await revokeSession(session.id, 'timeout'); throw Unauthorized('SESSION_EXPIRED_ABSOLUTE');
  }
  if (now >= session.idle_expires_at) {
    await revokeSession(session.id, 'timeout'); throw Unauthorized('SESSION_EXPIRED_IDLE');
  }

  // Binding: device must match; IP change → soft (require step-up), not hard-fail.
  if (session.device_id && req.deviceId && session.device_id !== req.deviceId)
    throw Unauthorized('DEVICE_MISMATCH');
  const ipChanged = session.ip && req.ip && session.ip !== req.ip;

  // ── 3. STEP-UP freshness for sensitive routes (§33.6) ──────────────────────────
  if (isSensitive(req.route)) {
    const fresh = session.step_up_at && (now - session.step_up_at) < STEP_UP_WINDOW_MS;
    if (!(fresh || aal === 'aal2'))  throw Unauthorized('STEP_UP_REQUIRED');
    if (ipChanged)                   throw Unauthorized('STEP_UP_REQUIRED');   // re-auth on new IP for $ ops
  }

  // ── 4. Refresh idle window + presence (cheap, async-safe) ──────────────────────
  await touchSession(session.id, { last_active_at: now, idle_expires_at: now + IDLE_MS, ip: req.ip });
  // (touchSession writes through DO cache; debounced flush to Postgres on the idle index)

  return { userId, email: claims.email, sessionId: session.id, aal,
           deviceId: session.device_id, stepUpFresh: aal === 'aal2' || isStepUpFresh(session) };
}

// Outage posture: if Postgres is unreachable for step 2, FAIL CLOSED on sensitive routes
// (401), and allow read-only routes on a verified-but-unconfirmed JWT only if
// ALLOW_DEGRADED_READS is set — explicit, audited, never the default. (Today's getUser path
// returns 503; we keep that as the fallback when SESSIONS_V2 is off.)
```

**Why this shape.** Step 1 removes the per-request `getUser` round-trip (F3 goal #1). Step 2 is
what the bare JWT can never do — it lets *us*, not GoTrue's token TTL, decide a session is over
(instant revocation, idle/absolute timeout, binding). Step 3 enforces §33.6 without a separate
middleware. The DO-cache-then-Postgres lookup keeps the hot path fast while Postgres stays the
record; a cold DO simply reads Postgres. The outage note keeps the **fail-closed** posture the
current `auth.ts` already has (it returns 503 when GoTrue is down) — we never trade availability
for letting a revoked session through on a money route.

---

## 33.8 Migration & rollout (additive, flag-safe, reversible)

| Phase | Change | Flag | Rollback |
|---|---|---|---|
| 0 (today) | `getUser` per request; decorative device registry; no sessions table | — | n/a |
| 1 | Ship migrations **M1/M2/M3**; reconcile `deviceSessions.ts` schema; start *writing* `sessions` + real `user_devices` on sign-in (still verify via `getUser`) | `SESSIONS_WRITE` | stop writing; tables are additive/idempotent |
| 2 | Turn on JWKS local verify + session check in `verifyRequest()`; `getUser` path kept as fallback | `SESSIONS_V2` | flip flag → old `requireAuth` |
| 3 | Make `removeDevice` revoke for real (admin API + DO push); enable idle/absolute sweep | `DEVICE_REVOKE` | flag off → revoke degrades to row-delete (today's behavior) |
| 4 | Step-up gates on billing/deploy/connections; MFA enrollment | `STEP_UP`, `MFA` | per-flag off |
| 5 | `UserCoordinatorDO` becomes the live tier (instant revocation/presence) — see §23.7 Phase 1 | `VENTURES_ENABLED`/F4 | SSE/poll fallback retained |

Each phase is additive, independently shippable, and reversible by a flag flip — never a
big-bang rewrite of auth. Phases 1–4 are pure F3 and need **no owner action** (they use the
existing Supabase project + service-role key already present in
`server/src/services/supabase.ts`). Phase 5 rides F4's Durable Objects enablement.

---

## 33.9 How this maps to F3 (and A8)

| F3 task ([F-Enterprise §F3](../F-ENTERPRISE-FOUNDATIONS.md)) | Realized in |
|---|---|
| Local JWT verification via JWKS (remove per-call dependency) | §33.3.1, §33.7 step 1 |
| First-party server-side sessions → idle + absolute timeouts, binding, step-up | §33.3.2, §33.5 (`sessions`), §33.6, §33.7 steps 2–3 |
| Make the device registry authoritative (create `user_devices` migration; `removeDevice` revokes) | §33.3.3, §33.5 (M2), §26.11 |
| MFA/TOTP + re-auth on sensitive actions (billing, deploy, account) | §33.3.4, §33.6 |
| Suspicious-login signal (new device/geo) → notify + audit | §33.3.5, §33.5 (`audit_log`, `user_settings`) |
| Instant revocation push + presence + multi-device sync | §33.4, [§23.2.1](./23-cloudflare-topology.md) (F4 seam) |
| **A8** device/presence/"sign out everywhere" surface | §33.4 (DO presence → Operator Console) |

**F3 acceptance, restated and met:** the device list is real and revocation works (§33.3.3);
sessions expire on idle/absolute (§33.3.2); billing/deploy require re-auth (§33.6); per-request
auth no longer round-trips (§33.3.1). **Owner action: none** — the design uses the existing
Supabase project and service-role key throughout.

## 33.10 Acceptance criteria

- Current state is stated honestly with file refs: Supabase GoTrue credential issuance;
  real `local`/`others`/`global` sign-out; remember-me storage switch; the per-request
  `getUser` round-trip; the decorative device registry whose `removeDevice` does not revoke and
  whose `user_devices` table has no migration (and whose columns mismatch §26.11).
- The target specifies JWKS local verification (with cache + rotation discipline), first-party
  `sessions` records enabling idle + absolute timeouts + device/IP binding + step-up, an
  authoritative device registry (the missing `user_devices` migration + real revocation via the
  service-role admin API), MFA/TOTP, and suspicious-login detection.
- The `UserCoordinatorDO` role (authoritative live tier: instant revocation push, presence,
  multi-device sync) is defined with the Postgres-is-record / DO-is-liveness consistency seam,
  linked to §23.2.1.
- The session/identity data model (`sessions`, `user_devices`, `audit_log`, `user_settings`) and
  RLS posture are summarized against §26.11 with the F6 migration ordering.
- The sensitive-action step-up policy is tabulated (billing, prod deploy, spend, connections,
  account, device revoke) with a freshness window and `aal2` path.
- `verifyRequest()` pseudocode shows local JWKS verify → session timeout/binding/revocation
  check → step-up freshness → idle refresh, with the fail-closed outage posture.
- Everything maps to **F3** (and the **A8** console surface), is flag-safe and additive, and
  requires no owner action for the F3 phases.
