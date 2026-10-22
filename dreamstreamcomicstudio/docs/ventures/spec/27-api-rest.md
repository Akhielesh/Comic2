# 27 — API Surface: REST

> Part III · Architecture · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan](../00-MASTER-PLAN.md) (Epic A1 control plane, §4 architecture) ·
> [Enterprise Foundations](../F-ENTERPRISE-FOUNDATIONS.md) (F7 OpenAPI, F8 zod) ·
> Realtime/SSE & events: [28 — API Surface: Realtime & Events](./28-api-realtime-events.md) ·
> Data model: [26 — Data Model & Schema](./26-data-model-schema.md)

## 27.1 Scope & stance

This section is the **contract for the REST surface**: the cross-cutting conventions every
JSON endpoint obeys, an honest catalog of the **route groups that already ship today**, and
the **full design of the new `/api/ventures/*` surface** that Autopilot adds (Epic A1, with
later epics filling in behaviour). Realtime concerns — SSE streams, the event channel,
webhooks-as-ingest — live in [§28](./28-api-realtime-events.md); this file references them
but does not specify them.

Honesty rule (house style): everything marked **shipped** exists in code today
(`server/src/routes/*`, mounted in `server/src/index.ts`); everything marked **planned**
is specified here but not yet built, and is tagged with the epic that delivers it. The new
ventures surface is **planned in full**; do not assume any of it runs until its epic ships.

The REST surface is intentionally boring and uniform. The interesting, hard-to-get-right
parts are the conventions (auth, errors, idempotency, pagination) — get those identical
across every route and the rest is CRUD.

---

## 27.2 API conventions

These hold for **every** `/api/*` JSON endpoint. They are derived from the existing
middleware (`auth.ts`, `errors.ts`, `rateLimit.ts`, `requestContext.ts`) so the new surface
is consistent with what ships today, not a parallel dialect.

### 27.2.1 Base URL & content type

- Base: `https://api.dreamstreamstudio.ai` (prod) · `http://localhost:8787` (dev). All paths
  below are relative to this host.
- All request and response bodies are `application/json; charset=utf-8`. The lone exception
  is `POST /api/webhook/stripe`, which receives the **raw** body before `express.json()` so
  the Stripe signature can be verified (`server/src/index.ts:93`).
- SSE endpoints respond `text/event-stream` and are excluded from gzip
  (`server/src/index.ts:64`). They are specified in [§28](./28-api-realtime-events.md).

### 27.2.2 Authentication — bearer JWT

Auth is a **Supabase-issued JWT** in the `Authorization` header. There is no cookie session
for the API and no API-key auth on the app surface (the `/api/connect` MCP endpoint is the
one exception: it authenticates with its own bearer token, not the app session).

```
Authorization: Bearer <supabase_access_token>
```

`requireAuth` (`server/src/middleware/auth.ts`) extracts the bearer token, resolves it to a
user via `supabase.auth.getUser(token)`, and sets `req.user = { id, email }`. The global
guard `app.use('/api', requireAuth)` protects everything mounted **after** it; routes mounted
before it are public or use `optionalAuth` (fail-open guest access). Three auth tiers exist:

| Tier | Middleware | Behaviour | Examples |
|---|---|---|---|
| **Required** | `requireAuth` | 401 without a valid token | studio, agents, ventures, chat, image |
| **Optional** | `optionalAuth` | proceeds as guest; `req.user` set if a valid token is present | billing, shares, assistant |
| **Public** | none | open | `/api/health`, `/api/models/catalog`, `/api/keys/validate` |

> **F3 forward-note.** Today auth round-trips to Supabase per request. F3 moves to **local
> JWKS verification + first-party session records** (idle/absolute timeouts, step-up re-auth
> on billing/deploy). The header contract above is unchanged; only verification gets faster
> and stricter. All `/api/ventures/*` mutations that spend money or deploy MUST require
> step-up re-auth once F3 ships.

Auth failure shapes:

| Status | `code` | When |
|---|---|---|
| 401 | `UNAUTHORIZED` | missing or malformed `Authorization`, invalid/expired token |
| 503 | `AUTH_PROVIDER_UNAVAILABLE` | the auth provider (Supabase) is unreachable |

### 27.2.3 Error envelope

Every error — thrown by a route or by the central handler (`server/src/middleware/errors.ts`)
— is a single, predictable envelope. **Clients parse `error.code`, never `error.message`.**

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded for ventures. Retry in 12s.",
    "requestId": "9f1c2a7e-7b3d-4c6e-9b1a-0d2f3e4a5b6c",
    "details": { "scope": "ventures", "limit": 120, "windowMs": 60000 }
  }
}
```

- `code` — stable machine string. Status→code defaults: `400 BAD_REQUEST`, `401 UNAUTHORIZED`,
  `403 FORBIDDEN`, `404 NOT_FOUND`, `409 CONFLICT`, `422 UNPROCESSABLE_ENTITY`,
  `429 RATE_LIMITED`, `500 INTERNAL_ERROR`, `502 BAD_GATEWAY`, `503 SERVICE_UNAVAILABLE`,
  `504 GATEWAY_TIMEOUT`. Routes may set a more specific `publicCode` (e.g.
  `NO_FREE_MODEL_AVAILABLE` → 402, `BUDGET_EXCEEDED` → 402).
- `message` — human-readable; **redacted to a generic string for 5xx in production** so
  internals never leak.
- `requestId` — always present; the same value is echoed in the `X-Request-Id` response
  header (§27.2.8). Quote it in support requests.
- `details` — optional structured context; in production it is **omitted for 5xx** and the
  internal error `code` is suppressed (`internalCode` is dev-only).

Autopilot-specific public error codes (planned, A0/A1):

| `code` | Status | Meaning |
|---|---|---|
| `BUDGET_EXCEEDED` | 402 | venture budget cap would be breached; action refused (see [Master Plan §7](../00-MASTER-PLAN.md)) |
| `CHECKPOINT_REQUIRED` | 409 | action needs an open checkpoint to be approved first |
| `VENTURE_PAUSED` | 409 | venture is paused (budget breach, kill switch, or stuck) |
| `VENTURES_DISABLED` | 404 | `VENTURES_ENABLED=false` — the whole surface is dark for this caller |
| `SCOPE_VIOLATION` | 422 | requested work is outside the venture's approved scope |
| `KILL_SWITCH_ACTIVE` | 503 | global `VENTURES_KILL` is on; no autonomous action accepted |

### 27.2.4 Pagination

Collection endpoints (lists of goals, events, runs, checkpoints) use **cursor pagination** —
stable under inserts, which matters for an append-only event log that grows while you read it.

Request: `?limit=<1..100, default 50>&cursor=<opaque>`. Response wraps the array in a
consistent envelope:

```json
{
  "data": [ /* … items … */ ],
  "page": {
    "limit": 50,
    "nextCursor": "ZXZ0XzAxSFg5...",
    "hasMore": true
  }
}
```

- `nextCursor` is opaque (base64 of `(sort_key, id)`); pass it back as `cursor` for the next
  page. `null` when `hasMore` is false.
- Default sort is `created_at DESC, id DESC` (newest first) unless an endpoint states
  otherwise. `?order=asc` is honoured on the event log for chronological replay.
- Existing shipped list routes (e.g. `GET /api/studio/projects`) return bare arrays today;
  the **new ventures surface adopts the wrapped envelope from day one**, and shipped routes
  migrate to it opportunistically (non-breaking: a bare array stays valid until F7 freezes
  the contract).

### 27.2.5 Idempotency keys

Any **mutating** request that creates state, spends money, or triggers a build/deploy accepts
an idempotency key so a retried request is a safe no-op (F2 requirement).

```
Idempotency-Key: <client-generated UUID, stable across retries of the same logical action>
```

- Scope: keys are stored per `(user_id, route, key)` with the first response, for **24h**.
- A replay with the same key returns the **original** response (status + body) and sets
  `Idempotency-Replayed: true`.
- A replay with the same key but a **different body** → `409 CONFLICT` (`IDEMPOTENCY_MISMATCH`).
- **Required** on: `POST /api/ventures`, `…/goals`, `…/deploy`, `…/intake`, and the billing
  mutations (`/checkout/*`, `/reserve`, `/settle`). Optional but honoured elsewhere.
- Implementation reuses the F2 Redis-backed idempotency store; the venture deploy path treats
  the key as the dedupe key for the underlying `studio_deployments` row.

### 27.2.6 Versioning

- The app surface is **unversioned** (`/api/...`) and evolves additively — new fields are
  optional, never repurposed; removals go through a deprecation window. This matches today's
  reality where only ComicForge carries a version prefix (`/api/v1/comicforge`).
- **New surfaces that warrant a hard contract use the `/api/v1/...` prefix.** The ventures
  surface ships **unversioned** for the A-series (it is flag-gated and pre-GA), and is
  promoted to `/api/v1/ventures` at GA (Epic A9) when the OpenAPI spec (F7) freezes it. Until
  then, breaking changes are allowed behind the `VENTURES_ENABLED` flag.
- Deprecations are announced via the `Deprecation` and `Sunset` response headers plus an
  entry in the OpenAPI spec.

### 27.2.7 Rate limits

Limiting is per-scope, per-requester (`user:<id>` when authenticated, else `ip:<addr>`),
fixed-window, via `createRateLimit` (`server/src/middleware/rateLimit.ts`). Every response
carries the standard headers:

```
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 118
X-RateLimit-Reset: 1717804800
RateLimit-Policy: ventures;w=60;q=120
Retry-After: 12         # only on 429
```

A 429 returns the standard error envelope with `code: "RATE_LIMITED"` and `details` carrying
`scope`, `limit`, `windowMs`, `retryAfterMs`. Scopes in use today: `system`, `text`, `image`,
`vision`, `comicforge`, `admin`, `moderation`, plus per-feature assistant limits.

| Scope | Tier | Applies to |
|---|---|---|
| `system` | system | models, keys, billing, shares, mcp, agents |
| `text` | text | chat, text, studio, recipes |
| `image` / `vision` | image/vision | image & vision generation |
| `ventures` (planned, A1) | text-tier | all `/api/ventures/*` reads + light mutations |
| `ventures-heavy` (planned, A1) | strict | `…/intake`, `…/deploy`, `…/signals` |

> **F2 forward-note.** The limiter is in-memory per-process today, so limits multiply across
> instances. F2 moves it to **Redis (shared, atomic)**. The header contract is unchanged.
> Signals ingestion (`…/signals`, Epic A6) gets its own tight limit because it is called by
> deployed apps, not humans.

### 27.2.8 Request ID & correlation

Every request gets a `requestId` (`server/src/middleware/requestContext.ts`): the inbound
`X-Request-Id` header is honoured (sanitised, ≤128 chars) or a UUID is minted. It is echoed
in the `X-Request-Id` response header and embedded in the error envelope and structured logs.
For ventures, the same id is propagated to the tick (`venture_events.request_id`) so an API
action is traceable from request → tick → deploy (F0 tracing).

---

## 27.3 Existing route groups (shipped)

The platform already exposes a substantial REST surface. Autopilot **consumes** these, it
does not duplicate them. Summary catalog (verified against `server/src/index.ts` mounts and
`server/src/routes/*`); not every sub-route is listed — these are the groups.

| Group | Mount | Auth | Purpose | Status |
|---|---|---|---|---|
| **Health** | `/api/health` | public | liveness | ✅ shipped |
| **System** | `/api/system` | public | `status`, `capabilities`, `dashboard`, `version`, `ready`, `diagnostics` | ✅ shipped |
| **Models** | `/api/models` | public | `catalog` (stale-while-revalidate), `verify` | ✅ shipped |
| **Keys** | `/api/keys` | public | BYOK provider key `validate` | ✅ shipped |
| **Assistant** | `/api/assistant` | optional | in-app help `chat` | ✅ shipped |
| **Billing** | `/api/billing` | optional | pricing catalog, summary, subscription, Stripe checkout/portal, credits, spend cap, usage history, coupons | ✅ shipped |
| **Webhook** | `/api/webhook` | signature | inbound `stripe` (raw body) | ✅ shipped |
| **Shares** | `/api/shares` | optional/required | create/list/revoke share links, token resolve | ✅ shipped |
| **MCP (inbound)** | `/api/connect` | own bearer | external agents call our tool registry as an MCP endpoint | ✅ shipped |
| **Chat** | `/api/chat` | required | `/`, `/stream` (SSE), `/swarm`, `/enhance`, `/memory`, `/unfurl` | ✅ shipped |
| **Text** | `/api/text` | required | script/story/continuity/panel tools, `generate` | ✅ shipped |
| **Image** | `/api/image` | required | `gemini`, `flux`, `ideogram`, `openrouter`, `nvidia` | ✅ shipped |
| **Vision** | `/api/vision` | required | `analyze-layout`, `analyze-style`, `page-layout` | ✅ shipped |
| **Studio** | `/api/studio` | required | the interactive build loop: `clarify`/`plan`/`generate`(+`/stream`)/`build`/`deploy`, project & version CRUD, run logs, `/github/*` two-way sync | ✅ shipped |
| **Agents** | `/api/agents` | required | swarm agent registry CRUD | ✅ shipped |
| **Recipes** | `/api/recipes` | required | saved tool-chains: list/get/create/delete/validate/run/distill | ✅ shipped |
| **MCP (registry)** | `/api/mcp` | required | manage user MCP servers: list/add/check/delete + proxy `/mcp` | ✅ shipped |
| **ComicForge** | `/api/v1/comicforge` | required | the comic pipeline (script→architecture→assets→render→QC→export), job status/events (SSE) | ✅ shipped |
| **Admin** | `/api/admin` | required+admin | user/plan/role management, force-private, `/verification/*` | ✅ shipped |
| **Moderation** | `/api/moderation` | required+admin | republish queue, user actions | ✅ shipped |

The single most important reuse for Autopilot is **Studio**: `/api/studio/build`,
`/api/studio/deploy`, project/version CRUD, and `/github/*` are exactly what a venture tick's
ACT/SHIP steps drive. Ventures add a `venture_id` tag onto `studio_projects`/`studio_runs`/
`studio_deployments` rather than forking these routes (Epic A1/A4/A5).

---

## 27.4 The new surface — `/api/ventures/*` (planned)

Mount (planned, mirroring the existing pattern):

```ts
// server/src/index.ts  — after the global requireAuth guard
app.use('/api/ventures', venturesRateLimit, venturesRouter);   // Epic A1
```

All routes are **auth-required** (global `requireAuth`), **RLS owner-isolated**
(`auth.uid() = user_id`, mirroring `projects_rls_owner_isolation.sql`), and **flag-gated**
by `VENTURES_ENABLED` (a disabled surface returns `404 VENTURES_DISABLED`, so its existence
is not advertised pre-GA). The data model behind these rows is [§26](./26-data-model-schema.md);
this section specifies the wire contract only.

Conventions recap for the whole group: cursor pagination (§27.2.4) on every list;
`Idempotency-Key` (§27.2.5) on every create/deploy/intake; the standard error envelope
(§27.2.3) with the Autopilot codes from §27.2.3.

### 27.4.1 Ventures CRUD — `/api/ventures` · Epic A1

| Method | Path | Auth | Idem | Purpose |
|---|---|---|---|---|
| GET | `/api/ventures` | required | — | list the caller's ventures (paged) |
| POST | `/api/ventures` | required | yes | create a venture (status `draft`) |
| GET | `/api/ventures/:id` | required | — | fetch one venture with rollups |
| PATCH | `/api/ventures/:id` | required | — | update name/summary/scope/autonomy; pause/resume |
| DELETE | `/api/ventures/:id` | required | — | soft-delete (archive) a venture |

`POST /api/ventures` — request:

```json
{ "name": "HabitLoop", "summary": "A habit-tracker SaaS with email reminders" }
```

Response `201`:

```json
{
  "id": "vnt_01HX9...",
  "userId": "usr_8c2...",
  "name": "HabitLoop",
  "summary": "A habit-tracker SaaS with email reminders",
  "status": "draft",
  "autonomyLevel": "checkpointed",
  "scope": null,
  "studioProjectId": null,
  "deployUrl": null,
  "createdAt": "2026-06-07T18:04:22Z",
  "updatedAt": "2026-06-07T18:04:22Z"
}
```

`GET /api/ventures/:id` returns the venture plus lightweight rollups so the Operator Console
(Epic A8) renders without N+1 calls:

```json
{
  "id": "vnt_01HX9...",
  "name": "HabitLoop",
  "status": "active",
  "autonomyLevel": "checkpointed",
  "deployUrl": "https://habitloop.dreamstreamstudio.ai",
  "rollup": {
    "goals": { "total": 14, "done": 5, "inProgress": 1, "blocked": 1 },
    "openCheckpoints": 1,
    "spend": { "usdToday": 2.41, "usdTotal": 18.77, "currency": "USD" },
    "lastRunAt": "2026-06-07T17:58:10Z"
  }
}
```

`PATCH` accepts `status` transitions `draft→active`, `active↔paused`, `*→archived`. Pausing is
the user's manual brake; the system also pauses on budget/kill/stuck. State machine:
`draft → active → (paused ↔ active) → archived`.

**Status transitions:**

| Transition | Trigger | Notes |
|---|---|---|
| `draft → active` | `approve-roadmap` (A3) | requires an approved roadmap checkpoint |
| `active → paused` | user PATCH, budget breach, kill switch, no-progress | source recorded in `venture_events` |
| `paused → active` | user PATCH (resume) | refused with `BUDGET_EXCEEDED` if still over cap |
| `* → archived` | DELETE | soft-delete; loop never schedules archived ventures |

Errors: `404 NOT_FOUND` (not yours / missing), `422 UNPROCESSABLE_ENTITY` (bad transition),
`404 VENTURES_DISABLED` (flag off).

### 27.4.2 Goals — `/api/ventures/:id/goals` · Epic A1 (populated by A3)

The backlog/roadmap. Each goal is an epic→feature→task item with status, priority,
dependencies, and a result.

| Method | Path | Auth | Idem | Purpose |
|---|---|---|---|---|
| GET | `/…/:id/goals` | required | — | list goals (paged; `?status=`, `?order=`) |
| POST | `/…/:id/goals` | required | yes | add a goal manually |
| GET | `/…/:id/goals/:goalId` | required | — | fetch one goal |
| PATCH | `/…/:id/goals/:goalId` | required | — | edit/reprioritize/reorder; `status` override |
| DELETE | `/…/:id/goals/:goalId` | required | — | remove a goal |

Goal shape:

```json
{
  "id": "gol_01HX9...",
  "ventureId": "vnt_01HX9...",
  "title": "Email reminder scheduler",
  "kind": "feature",
  "status": "todo",
  "priority": 80,
  "dependsOn": ["gol_01HX8..."],
  "estimateTicks": 3,
  "result": null,
  "createdAt": "2026-06-07T18:10:00Z"
}
```

`status ∈ {todo, in_progress, blocked, done, abandoned}`. `PATCH` is how the Operator
Console's drag-to-reprioritize writes back. Scope guard (A3): the autonomous loop may not
**create** goals outside the approved `scope` without a `scope` checkpoint — manual user
`POST` is allowed and widens scope implicitly (recorded as an event).

### 27.4.3 Checkpoints — `/api/ventures/:id/checkpoints` (+ approve/deny) · Epic A0

Human-in-the-loop gates. The loop **pauses** on the gated goal until resolved. The six types
(see [Master Plan §8](../00-MASTER-PLAN.md)): `prod_deploy`, `spend_money`, `destructive_op`,
`publish_external`, `scope_change`, `roadmap_approval`.

| Method | Path | Auth | Idem | Purpose |
|---|---|---|---|---|
| GET | `/…/:id/checkpoints` | required | — | list (paged; `?status=open`) |
| POST | `/…/:id/checkpoints` | required | yes | raise one (normally the loop; manual allowed) |
| POST | `/…/:id/checkpoints/:cpId/approve` | required (step-up) | yes | approve → loop resumes |
| POST | `/…/:id/checkpoints/:cpId/deny` | required (step-up) | yes | deny → goal blocked, loop moves on |

Checkpoint shape:

```json
{
  "id": "chk_01HX9...",
  "ventureId": "vnt_01HX9...",
  "goalId": "gol_01HX9...",
  "type": "prod_deploy",
  "status": "open",
  "title": "Deploy HabitLoop to production",
  "context": {
    "target": "cloudflare-pages",
    "connectionId": "cxn_01HX9...",
    "previewUrl": "https://habitloop.dreamstreamstudio.ai",
    "diffSummary": "12 files changed, lighthouse 96"
  },
  "createdAt": "2026-06-07T18:30:00Z",
  "resolvedAt": null,
  "resolvedBy": null,
  "decision": null
}
```

`POST …/approve` — request `{ "note": "looks good, ship it" }` → response `200` with the
checkpoint now `status: "approved"`, `decision: "approve"`, `resolvedBy` and `resolvedAt`
set. Approving a `prod_deploy` releases the SHIP step (A5); approving a `roadmap_approval`
flips the venture `draft → active` (A3). `deny` sets the goal `blocked` and writes an event.

> **Step-up auth (F3):** approving a `spend_money` / `prod_deploy` / `destructive_op`
> checkpoint requires re-auth; without it → `403 FORBIDDEN` (`REAUTH_REQUIRED`). A 24h-stale
> checkpoint auto-expires to `status: "expired"` and the loop treats it as a soft deny.

Errors: `409 CONFLICT` (already resolved), `404 NOT_FOUND`, `403 FORBIDDEN` (re-auth needed).

### 27.4.4 Budget — `/api/ventures/:id/budget` · Epic A0

Hard caps. The DECIDE gate reads these **before** spending; REFLECT updates spend; breach →
the venture pauses (`status: paused`) and notifies. One budget row per venture.

| Method | Path | Auth | Idem | Purpose |
|---|---|---|---|---|
| GET | `/…/:id/budget` | required | — | current caps + live spend |
| PUT | `/…/:id/budget` | required (step-up) | — | set/replace caps |

`GET` response:

```json
{
  "ventureId": "vnt_01HX9...",
  "caps": {
    "usdPerDay": 5.0,
    "usdTotal": 100.0,
    "maxTokens": 5000000,
    "maxContainerMinutes": 600
  },
  "spend": {
    "usdToday": 2.41,
    "usdTotal": 18.77,
    "tokensUsed": 1840221,
    "containerMinutesUsed": 73,
    "currency": "USD",
    "asOf": "2026-06-07T18:45:00Z"
  },
  "state": "ok"
}
```

`state ∈ {ok, warn, breached}` (warn at ≥80% of any cap — drives the A7 spend alert). `PUT`
replaces `caps` wholesale; raising a cap on a breached venture may move it back to `ok` and
allow resume. Refusing to act mid-tick because a cap would be crossed surfaces as
`402 BUDGET_EXCEEDED` on whatever mutation triggered it. Metering flows through the existing
`costEstimator.ts → billingLedger.ts → usageEnforcer.ts`, tagged with `venture_id`.

### 27.4.5 Connections — `/api/ventures/:id/connections` · Epic A5

BYO provider accounts (Cloudflare/Vercel/Railway/Supabase/GitHub) linked via Nango. **We
store only a Nango connection reference + metadata — never a plaintext token** (Master Plan
§5.3). Deploy adapters pick the right connection by provider.

| Method | Path | Auth | Idem | Purpose |
|---|---|---|---|---|
| GET | `/…/:id/connections` | required | — | list connections + health/expiry |
| POST | `/…/:id/connections` | required (step-up) | yes | begin a connect flow → returns a Nango session/auth link |
| GET | `/…/:id/connections/:cxnId` | required | — | one connection's state |
| DELETE | `/…/:id/connections/:cxnId` | required | — | revoke (and revoke the Nango grant) |

Connection shape (secrets absent by construction):

```json
{
  "id": "cxn_01HX9...",
  "ventureId": "vnt_01HX9...",
  "provider": "cloudflare",
  "nangoConnectionId": "nango_cf_8c2...",
  "scopes": ["pages:write"],
  "status": "active",
  "expiresAt": "2026-12-07T00:00:00Z",
  "lastCheckedAt": "2026-06-07T18:00:00Z"
}
```

`status ∈ {pending, active, expired, revoked, error}`. Creating returns
`{ "authUrl": "...", "connectionId": "cxn_..." }`; the client completes the OAuth dance with
Nango and the connection flips `pending → active` on the Nango callback (ingested per
[§28](./28-api-realtime-events.md) / F10). Provider tokens never appear in any response or log
(adapter least-privilege, Master Plan §5.9).

### 27.4.6 Events — `/api/ventures/:id/events` · Epic A0

The append-only audit log: everything the loop sensed, decided, did, and spent. The source of
truth for "what is my agent doing?" **Read-only over REST**; the live tail is SSE in
[§28](./28-api-realtime-events.md) (`/api/ventures/:id/stream`).

| Method | Path | Auth | Idem | Purpose |
|---|---|---|---|---|
| GET | `/…/:id/events` | required | — | paged audit log (`?since=`, `?type=`, `?order=asc`) |
| GET | `/…/:id/events/:eventId` | required | — | one event (full payload) |

Event shape:

```json
{
  "id": "evt_01HX9...",
  "ventureId": "vnt_01HX9...",
  "runId": "run_01HX9...",
  "tick": 42,
  "phase": "ship",
  "type": "deploy.succeeded",
  "summary": "Deployed preview to habitloop.dreamstreamstudio.ai",
  "costUsd": 0.13,
  "model": "anthropic/claude-...",
  "promptHash": "sha256:4f1c...",
  "requestId": "9f1c2a7e-...",
  "data": { "deploymentId": "dep_01HX9...", "url": "https://habitloop.dreamstreamstudio.ai" },
  "createdAt": "2026-06-07T18:31:11Z"
}
```

`phase ∈ {sense, orient, decide, act, verify, ship, reflect, system}`. Events are
**immutable** — there is no write/delete over REST. Default order is newest-first; pass
`?order=asc&since=<cursor>` for chronological replay (e.g. rebuilding the Operator Console
timeline). Every event carries `model` + `promptHash` so any agent action is explainable.

### 27.4.7 Runs — `/api/ventures/:id/runs` · Epic A2

One autonomous session of the loop (bounded by budget/time), made of many ticks. Read-mostly;
the only mutation is requesting a run or cancelling one.

| Method | Path | Auth | Idem | Purpose |
|---|---|---|---|---|
| GET | `/…/:id/runs` | required | — | list runs (paged) |
| GET | `/…/:id/runs/:runId` | required | — | run detail + tick rollup |
| POST | `/…/:id/runs` | required | yes | request a run now (else the scheduler decides) |
| POST | `/…/:id/runs/:runId/cancel` | required | yes | stop a run after the current tick |

Run shape:

```json
{
  "id": "run_01HX9...",
  "ventureId": "vnt_01HX9...",
  "status": "running",
  "trigger": "scheduled",
  "ticksDone": 42,
  "maxTicks": 100,
  "startedAt": "2026-06-07T17:50:00Z",
  "endedAt": null,
  "stopReason": null,
  "spend": { "usdThisRun": 1.92, "tokens": 540221 }
}
```

`status ∈ {queued, running, paused, completed, cancelled, failed}`. `trigger ∈ {scheduled,
manual, webhook, signal}`. `stopReason` (on stop) ∈ `{budget, kill_switch, no_progress,
max_ticks, wall_clock, checkpoint, cancelled, completed}` — the deterministic guards from
Master Plan §8. `POST …/runs` is advisory: it enqueues a tick respecting the kill switch and
global concurrency cap; under the cap it returns `202 Accepted` with the queued run, or
`503 KILL_SWITCH_ACTIVE` when the global flag is on.

### 27.4.8 Intake — `/api/ventures/intake` & approve-roadmap · Epic A3

The on-ramp: idea → venture spec + structured roadmap the user approves before any autonomous
work. This is the heaviest LLM call in the group (swarm planner) — `ventures-heavy` rate
scope, idempotency required.

| Method | Path | Auth | Idem | Purpose |
|---|---|---|---|---|
| POST | `/api/ventures/intake` | required | yes | idea → draft venture + roadmap |
| POST | `/…/:id/approve-roadmap` | required (step-up) | yes | resolve the roadmap checkpoint → venture `active` |

`POST /api/ventures/intake` — request:

```json
{ "idea": "A habit-tracker SaaS with email reminders and weekly streak reports" }
```

Response `201` (a draft venture with a populated, reviewable backlog and an open
`roadmap_approval` checkpoint):

```json
{
  "venture": {
    "id": "vnt_01HX9...",
    "name": "HabitLoop",
    "summary": "Habit tracking with reminders and streak analytics",
    "scope": "Web SaaS: auth, habit CRUD, email reminders, weekly streak report. Out of scope: mobile native, payments v1.",
    "successMetrics": ["7-day retention", "reminders delivered", "weekly report open rate"],
    "status": "draft"
  },
  "roadmap": [
    { "id": "gol_01HX9a", "title": "Project scaffold + auth", "kind": "epic", "priority": 100 },
    { "id": "gol_01HX9b", "title": "Habit CRUD + dashboard", "kind": "feature", "priority": 90 },
    { "id": "gol_01HX9c", "title": "Email reminder scheduler", "kind": "feature", "priority": 80 }
  ],
  "checkpoint": { "id": "chk_01HX9z", "type": "roadmap_approval", "status": "open" }
}
```

The venture **stays `draft`** — no tick runs — until `POST …/approve-roadmap` resolves the
checkpoint, stores the approved `scope` (the scope guard's reference), and flips the venture
to `active`, at which point the A2 loop begins working the backlog. Intake output is
JSON-validated (`ai/json.ts`, `jsonCoerce.ts`); a malformed plan → `422 UNPROCESSABLE_ENTITY`
after bounded repair attempts.

### 27.4.9 Deploy — `/api/ventures/:id/deploy` · Epic A5

Provider-agnostic deploy via the adapter registry (Master Plan §6). Managed previews are
automatic from the loop; this route is the **explicit** deploy (e.g. user-triggered, or
production after a checkpoint).

| Method | Path | Auth | Idem | Purpose |
|---|---|---|---|---|
| POST | `/…/:id/deploy` | required (step-up for prod) | yes | deploy current version to a target |
| GET | `/…/:id/deploy/:deploymentId` | required | — | deployment status |
| POST | `/…/:id/deploy/:deploymentId/rollback` | required (step-up) | yes | roll back (where the adapter supports it) |

`POST …/deploy` — request:

```json
{ "target": "managed-preview", "env": "preview" }
```

`env: "production"` (or a custom-domain go-live) **requires an approved `prod_deploy`
checkpoint**; without one → `409 CHECKPOINT_REQUIRED` with the checkpoint id to approve.
Response `202`:

```json
{
  "deploymentId": "dep_01HX9...",
  "ventureId": "vnt_01HX9...",
  "target": "cloudflare-pages",
  "env": "production",
  "status": "in_progress",
  "url": null,
  "createdAt": "2026-06-07T18:31:00Z"
}
```

`GET …/deploy/:deploymentId` polls to `status ∈ {in_progress, ready, failed, rolled_back}`
with the live `url` on success. BYO targets resolve their `connectionId` from §27.4.5; the
managed target needs none. Deployments are recorded in `studio_deployments` (with
`venture_id`) and update `ventures.deployUrl`. Deploy tokens are **never** logged or returned.

### 27.4.10 Signals — `/api/ventures/:id/signals` · Epic A6

The SENSE inlet: runtime errors, uptime, basic analytics, and feedback from **deployed apps**
feed the loop so ORIENT proposes improvements, not just the next backlog item. Called by
deployed apps and the health checker, **not** by humans — hence a tight, dedicated rate scope.

| Method | Path | Auth | Idem | Purpose |
|---|---|---|---|---|
| POST | `/…/:id/signals` | required (scoped token) | yes | ingest a signal (rate-limited) |
| GET | `/…/:id/signals` | required | — | list recent signals (paged) |

`POST …/signals` — request:

```json
{
  "kind": "runtime_error",
  "source": "deployed_app",
  "payload": {
    "message": "TypeError: cannot read 'streak' of undefined",
    "stack": "at Dashboard.tsx:42",
    "url": "https://habitloop.dreamstreamstudio.ai/dashboard",
    "count": 3
  }
}
```

`kind ∈ {runtime_error, uptime, analytics, feedback}`. Response `202 Accepted` (fire-and-
forget): `{ "accepted": true, "signalId": "sig_01HX9..." }`. A signal becomes a
`venture_event` of phase `sense`; if it warrants work, ORIENT creates a fix/improve goal
**within scope** (else a `scope_change` checkpoint). The ingest token is per-venture,
owner-scoped, revocable, and never the user's app JWT. Abuse protections: tight rate limit
(`ventures-heavy`), payload size cap, and dedupe via `Idempotency-Key` so a flapping app
can't flood the log.

---

## 27.5 OpenAPI & zod plan (F7 / F8)

The ventures surface is the first surface designed **contract-first**, so it becomes the
template for retrofitting the shipped routes.

- **Validation (F8, zod).** Every request body/query/path on `/api/ventures/*` is validated
  by a **zod schema** at the route boundary, producing the consistent `422
  UNPROCESSABLE_ENTITY` error envelope (with `details.issues[]` listing field-level
  failures). Schemas live next to the router (e.g.
  `server/src/routes/ventures.schemas.ts`) and are the single definition of each shape —
  no hand-rolled type guards (the F8 directive: replace ad-hoc validation like
  `text.validation.ts`).
- **OpenAPI (F7).** The same zod schemas generate the **OpenAPI 3.1** document via
  `@asteasolutions/zod-to-openapi` (or `zod-openapi`). One generator walks the router +
  schema registry and emits `openapi.json`; Swagger UI is served at `/api/docs`
  (admin/network-guarded). The error envelope, pagination wrapper, idempotency header,
  and rate-limit headers are declared once as reusable components and referenced by every
  operation — so the conventions in §27.2 are encoded, not just documented.
- **Generated client.** The frozen spec generates a **typed TypeScript client**
  (`services/venturesApi.ts` mirrors `studioApi.ts`'s ergonomics but is generated, not
  written), giving a real compile-time contract between client and server. CI fails if the
  committed client drifts from the spec (F5/F7 gate). Shared DTOs land in `apiTypes.ts`
  (`Venture`, `VentureGoal`, `VentureRun`, `Checkpoint`, `Budget`, `Connection`,
  `VentureEvent`) as the per-Epic-A1 backlog item.
- **Coverage gate.** F7's acceptance ("every route is in the spec; a generated client
  compiles against it") is enforced for ventures from day one: a test asserts every mounted
  `/api/ventures/*` operation has a zod schema and an OpenAPI entry — the same discipline as
  the gallery-coverage test, applied to the API surface.

> **Net:** zod (F8) is the source of truth; OpenAPI (F7) and the typed client are generated
> from it. The conventions in §27.2 are not prose-only — they are reusable OpenAPI components
> and shared middleware, so a new ventures route gets auth, errors, pagination, idempotency,
> rate limits, and request-id correlation for free, exactly like the shipped surface.
