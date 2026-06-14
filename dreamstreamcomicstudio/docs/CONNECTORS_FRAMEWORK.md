# Account Connectors Framework

A production-grade, **extensible** platform that lets end users connect **their own
accounts** — Gmail, Drive, Calendar, Sheets, YouTube (OAuth) and Google Maps / YouTube
public data (API key) — so connected data feeds three consumers: **chat context/RAG**,
**analysis** (structured queries), and **dashboard generation**.

> **Not to be confused with the _data_ connectors** in
> [`DATA_CONNECTORS.md`](./DATA_CONNECTORS.md). Those are operator-keyed data-source APIs
> (weather/finance/news) wired as chat tools. This framework is **per-user account
> connections** with OAuth/API-key credentials stored (encrypted) per user. The two
> systems share no tables and no code.

Adding a new connector = **implement one interface + register it**. No changes to core
routing, the DB schema, the sync runner, or the UI shell.

---

## 1. Stack (as built)

| Concern | Implementation |
|---|---|
| Frontend | Vite + React 19 SPA, React Router; view-state nav in `App.tsx` |
| API | Express (`server/src`), routers under `/api/...` |
| DB | Supabase Postgres, idempotent SQL in `server/sql/*.sql`, RLS |
| Auth (app login) | Supabase Auth (`requireAuth` → `req.user.id`) |
| Auth (connectors) | **Custom server-side OAuth 2.0 + PKCE** (this framework) |
| Encryption | AES-256-GCM via `server/src/lib/secureStore.ts` |
| Background sync | BullMQ + ioredis (`connectors:worker`), mirrors the ventures worker |
| UI | Tailwind + the "calm studio" `--ds-*` design tokens |

**Why custom OAuth (not Supabase social / not NextAuth):** we need multiple independent
per-service connections with incremental least-privilege scopes, our own refresh/revoke
lifecycle, tokens encrypted in our DB, and — critically — the **same abstraction must
also model API-key connectors** (Maps). Supabase social login conflates app identity
with data access and can't represent the API-key model at all.

---

## 2. Component map

```
server/src/connectors/
  types.ts          # AccountConnector interface + unified models + typed errors
  registry.ts       # ConnectorRegistry (register / get / catalog / syncable)
  base.ts           # GoogleOAuthConnector + ApiKeyConnector base classes
  oauth.ts          # Google OAuth 2.0 + PKCE (auth URL, exchange, refresh, revoke, userinfo)
  googleClient.ts   # centralized authed Google fetch: rate limit, backoff, 401/429 handling
  credentials.ts    # getValidAccessToken (auto-refresh + reconnect marking)
  store.ts          # Supabase persistence + token encryption (all tables)
  catalog.ts        # client-facing catalog (merges code + DB enablement + configured?)
  retrieval.ts      # unified query interface (RAG block, structured rows, dashboard aggregates)
  index.ts          # >>> register connectors here (the ONE place) + seed catalog <<<
  connectors/
    gmail.ts          # Gmail (OAuth)            ┐
    googleDrive.ts    # Drive (OAuth)            │ providerGroup: 'google'
    googleCalendar.ts # Calendar (OAuth)         │ — one consent screen for
    googleSheets.ts   # Sheets (OAuth, on-demand)│   the whole suite
    youtube.ts        # YouTube own channel(OAuth)┘
    googleMaps.ts     # Google Maps (API key)
  sync/
    queue.ts        # BullMQ queue (REDIS_URL)
    runner.ts       # one idempotent, resumable page per call
    worker.ts       # separate process: npm run connectors:worker
    trigger.ts      # enqueue (Redis) or run inline (no Redis)
    webhooks.ts     # Gmail/Drive/Calendar push seam (v1 polls)

server/src/routes/connectors.ts   # public OAuth callback router + authed control plane
server/sql/account_connectors.sql        # schema (UP)
server/sql/account_connectors_down.sql   # schema (DOWN, reversible)

services/connectorsApi.ts                # client API
components/connectors/ConnectorsPage.tsx # top-level "Connectors" nav section
components/connectors/ConnectDialog.tsx  # connect flow (OAuth popup / API-key form)
components/connectors/connectorIcons.tsx # icon + status visuals
```

---

## 3. The connector contract

```ts
interface AccountConnector {
  readonly metadata: ConnectorMetadata; // id, name, icon, category, authType,
                                         // requiredScopes, capabilities{searchable,
                                         // syncable, realtime, apiKeyBased}
  // Auth lifecycle (no-op paths for api_key connectors)
  initiate(input): Promise<InitiateAuthResult>;        // OAuth → redirect; api_key → completed
  handleCallback(input): Promise<HandleCallbackResult>; // OAuth code → tokens + account
  refresh(refreshToken): Promise<TokenSet>;
  revoke(tokens): Promise<void>;
  // Data lifecycle
  syncFull(ctx): Promise<SyncResult>;          // full backfill, paginates via cursor
  syncIncremental(ctx): Promise<SyncResult>;   // resumes from ctx.cursor
  fetch(input): Promise<unknown>;              // on-demand (Maps geocode, Gmail search)
  normalize(raw): NormalizedItem[];            // raw → unified model
}
```

**Dual auth is first-class.** `GoogleOAuthConnector` implements the OAuth lifecycle;
`ApiKeyConnector` implements the no-op auth path + key validation. A connector extends
one base and supplies only its data logic.

**Unified models.** Every connector maps raw payloads to `document | record | event`
(`NormalizedItem`). Downstream consumers never see connector-specific shapes.

---

## 4. Database schema

All tables are idempotent (`CREATE … IF NOT EXISTS`), RLS-enabled, and reversible via
`account_connectors_down.sql`. Status is a CHECK enum (project convention).

```
                         ┌──────────────────────────┐
                         │ auth.users (Supabase)     │
                         └────────────┬─────────────┘
                                      │ user_id (FK, cascade)
        ┌─────────────────────────────┼───────────────────────────────────────┐
        │                             │                                         │
┌───────▼────────┐         ┌──────────▼──────────────┐              ┌──────────▼─────────┐
│ connectors      │◄──────│ user_connections          │              │ connector_oauth_   │
│ (catalog)       │ id    │  id (PK)                  │              │ state (PKCE+CSRF)  │
│  id (PK,text)   │       │  connector_id             │              │  state (PK nonce)  │
│  auth_type      │       │  status (enum)            │              │  encrypted_verifier│
│  enabled,config │       │  account_identifier       │              │  expires_at        │
└─────────────────┘       │  granted_scopes[]         │              │  [deny-all RLS]    │
                          │  last_error, last_sync_at │              └────────────────────┘
                          └───┬─────────┬──────────┬──┘
            connection_id (FK)│         │          │ connection_id (FK)
        ┌─────────────────────▼──┐  ┌───▼──────────▼────────┐   ┌──────────────────────────┐
        │ connection_credentials  │  │ connector_sync_state   │   │ connector_items          │
        │  encrypted_access/iv    │  │  cursor (jsonb)        │   │  kind (doc/record/event) │
        │  encrypted_refresh/iv   │  │  status, last_sync_at  │   │  external_id, title,     │
        │  access_expires_at      │  │  last_full_sync_at     │   │  snippet, content_text,  │
        │  token_type             │  │  items_synced,last_err │   │  occurred_at, url, author│
        │  [deny-all RLS]         │  │  [owner SELECT RLS]    │   │  payload (jsonb)         │
        └─────────────────────────┘  └────────────────────────┘   │  [owner SELECT RLS, FTS] │
                                                                   └──────────────────────────┘
```

**RLS posture**
- `connection_credentials`, `connectors`, `connector_oauth_state`: **deny-all** to
  clients — service role only (secrets / server-managed).
- `user_connections`, `connector_sync_state`, `connector_items`: **owner read** (a user
  can read their own rows directly); writes are server-only via the service role.

**Why hybrid (typed columns + JSONB `payload`)?** The columns the three consumers filter
and sort on (owner, source, kind, title, timestamps, FTS over title/snippet/content) are
typed and indexed; everything connector-specific lives in `payload`. A new connector adds
rows with its own payload shape and needs **zero schema changes**. Fully-typed
per-connector tables would force a migration + new query paths per connector — the exact
coupling this design avoids.

**Indexes** cover the real query patterns: by user (`+ occurred_at desc`), by connector,
by sync status, per-connection, and a GIN FTS index over title/snippet/content_text.

**Apply:** Supabase project **"Comic"** (ref `bdjfmxfmhqhzvgrhbbzm`) via
`apply_migration` (name `account_connectors_framework`). Roll back with
`account_connectors_down.sql`.

---

## 5. OAuth + security

> **Operator setup:** exact, copy-paste provider runbooks live in
> [`connectors/`](./connectors/README.md) — start with
> [`connectors/google-setup.md`](./connectors/google-setup.md).

1. `POST /api/connectors/:id/connect` → connector `initiate()` builds the Google consent
   URL with **PKCE (S256)**, `access_type=offline`, least-privilege scopes. The PKCE
   `code_verifier` is stored **encrypted**, keyed by a random one-time `state` nonce
   (`connector_oauth_state`). Only the exact configured `redirect_uri` is allowed.
2. Browser consents → Google redirects to `GET /api/connectors/oauth/callback` (mounted
   **before** `requireAuth`; a redirect carries no app session). The handler
   **consumes** the `state` row (one-time delete = CSRF + replay guard), recovers the
   originating `user_id`, exchanges the code (PKCE), resolves the account email, stores
   **encrypted** tokens (`connection_credentials`), and triggers the initial sync. It
   redirects the browser back to the SPA.
3. `getValidAccessToken` refreshes a near-expiry token automatically and persists it. On
   a revoked/expired refresh token it marks the connection `expired` so the UI shows a
   **Reconnect** prompt — never a silent failure.
4. All Google calls go through `googleApiFetch`: per-host throttle, **exponential backoff
   with `Retry-After`** on 429 / 403-quota / 5xx, and a typed 401 → reconnect.

Tokens are never logged; the credentials table is deny-all to clients.

### Seamless multi-service Google connect

Connectors with `providerGroup: 'google'` (Gmail, Drive, Calendar, Sheets, YouTube)
render as **one "Google" card**. The user ticks the services they want and
`POST /api/connectors/google/connect { services }` builds **one consent** for the
**union** of those services' least-privilege scopes. `connector_oauth_state.connector_ids`
records the selection; the callback exchanges the single-use code **once** and
materializes a connection per service from that one token (incremental consent via
`include_granted_scopes=true`). Re-opening the dialog lets the user **add** services
(re-consents incrementally) or **remove** them (disconnects) — settings are changeable
anytime. Target: one click in the dialog + one Google screen.

---

## 6. Data → Chat Studio (`retrieval.ts`)

One scoped surface, always filtered by `userId`:
- **RAG / context** → `buildConnectorContextBlock(userId, query)` returns a compact,
  delimited system block; wired into `server/src/ai/chat.ts` behind the opt-in
  `connectorContext` flag (fail-open, time-boxed — same contract as user memory).
- **Analysis** → `retrieveItems({...})` / `POST /api/connectors/query` (filter by
  connector, connection, kind, text, time range).
- **Dashboard** → `connectorDashboardData(userId)` / `GET /api/connectors/dashboard`
  returns typed per-connection counts + kind breakdown to chart.

Permission model: the Chat Studio can only read connections the requesting user owns —
enforced in code (every query takes `userId`) **and** by RLS.

---

## 7. Background sync

- `runConnectorSyncPage` runs **one page** and persists the cursor → idempotent
  (`connector_items` upsert on `connection_id+kind+external_id`) and **resumable** after a
  crash/retry. The worker re-enqueues a follow-up while `hasMore`.
- With Redis: BullMQ jobs (`connectors:worker`, exponential backoff). Without Redis: the
  same runner executes **inline** (bounded), so the feature works in any deployment.
- **Webhook seam** (`sync/webhooks.ts`) is wired for Gmail/Drive/Calendar `watch`: a push
  maps to the owning connection(s) and triggers an incremental sync — the same path as
  polling. v1 polls; registering the `watch` channel is the only remaining piece.

---

## 8. How to add a new connector

1. **Create the connector** in `server/src/connectors/connectors/<id>.ts`.
   - OAuth source → `extends GoogleOAuthConnector` (or a new OAuth base for another
     provider). Implement `metadata`, `syncFull`, `syncIncremental`, `fetch`, `normalize`.
   - API-key source → `extends ApiKeyConnector`. Implement `metadata`, `validateKey`,
     `fetch`, `normalize`.
   - Map every raw payload to `document | record | event` in `normalize()`.
   - Pick least-privilege `requiredScopes` and accurate `capabilities`.
2. **Register it** — add one line to `registerAll([...])` in
   `server/src/connectors/index.ts`. That's the only wiring.
3. **(Icon)** if you used a new lucide icon name, add it to the map in
   `components/connectors/connectorIcons.tsx`.
4. **Tests** — add `<id>.test.ts` next to the connector (normalize + sync via mocked
   endpoints + error paths), mirroring `gmail.test.ts` / `googleMaps.test.ts`.
5. **Apply migrations?** — **No.** The schema already supports any connector. Catalog rows
   are upserted from code at boot.

You do **not** touch: routing, the DB schema, the sync runner, the registry internals, or
the UI shell. The catalog, connect flow, sync, retrieval, and Connectors page pick the new
connector up automatically.

---

## 9. Testing

- **Run:** `npx vitest run server/src/connectors` (unit + integration) — 59 tests.
- **Full suite:** `npx vitest run`. **Typecheck:** `npm run typecheck` (client) +
  `npx tsc -p server/tsconfig.json --noEmit` (server).
- **Coverage targets:** ≥ 90% of the framework core (registry, oauth, googleClient,
  credentials, runner) and each connector's `normalize`/sync/error paths.
- **What's covered:** registry + **extensibility proof** (a dummy connector runs through
  the same path with no core edits); PKCE/state/redirect-URI; token exchange/refresh incl.
  `invalid_grant`; AES-256-GCM round-trip + key-rotation failure; `googleApiFetch` 401 /
  429-backoff-retry / 5xx-retry / quota; Gmail full+incremental sync, search, normalize,
  401→reconnect, empty/malformed; Maps validate/normalize/fetch/quota; runner
  idempotent/resumable, auth-terminal-no-retry, rate-limit-rethrow, skip-non-syncable,
  ownership.
- **E2E (follow-up):** Playwright isn't installed (repo standardizes on Vitest). The
  connect→consent→connected→disconnect browser flow is the planned Playwright follow-up.

### Self-verification checklist

Per connector, confirm:
- [ ] Appears in the catalog (`GET /api/connectors/catalog`) with correct `configured`.
- [ ] **Connects** (OAuth: consent → callback → `connected`; API-key: key validates → `completed`) in ≤ 3 clicks.
- [ ] **Syncs**: items materialize in `connector_items`; `connector_sync_state.cursor` advances; re-running is idempotent.
- [ ] **Refreshes**: an expired access token is refreshed transparently mid-use.
- [ ] **Reconnect**: a revoked token flips the connection to `expired` and the UI shows Reconnect.
- [ ] **Disconnects**: revoke + cascade delete of credentials/sync/items.
- [ ] **Surfaces data**: results return via `/query`, `/dashboard`, and the RAG block.
- [ ] No edits were needed to routing / schema / sync runner / UI shell.
