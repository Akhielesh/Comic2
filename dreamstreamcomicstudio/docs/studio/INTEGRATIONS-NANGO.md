# Nango integration — 800+ API connectors for Code Studio agents

Gives the studio agents managed **OAuth + token refresh + proxy** for **800+ third-party APIs**
(Slack, Google, Notion, Stripe, GitHub, HubSpot, …) via a **self-hosted** [Nango](https://github.com/NangoHQ/nango).

## TL;DR

1. Run the sidecar: `cd deploy/studio-tools && cp ../../.env.studio-tools.example .env` → set `NANGO_ENCRYPTION_KEY` → `docker compose up -d`.
2. Open the Nango dashboard (`http://localhost:3009`), add the integrations you want, copy your **secret key**.
3. On the app server set `NANGO_HOST` + `NANGO_SECRET_KEY`. The three connector tools light up automatically.

## Why this design (and what we deliberately did NOT do)

- **Self-host as a sidecar; don't vendor the repo.** We run Nango's published stack (`docker-compose`)
  and call it over its REST API. We do **not** git-subtree/fork 800+ connectors into our tree —
  that would mean owning their upgrades and security forever. To "take control" of the connectors
  you *operate* Nango (choose which providers/actions are enabled), you don't absorb its source.
- **3 meta-tools, not 800 raw tools.** Exposing 800 tools would blow the model's tool budget and
  wreck tool selection. Agents get exactly three (below) and curate per task.
- **Per-user OAuth, never hard-coded creds.** Each end user authorizes their own account; Nango
  stores + refreshes the tokens. Generated apps proxy through Nango — secrets never touch client code.
- **License:** Nango is **Elastic License v2**. Self-hosting/embedding it to power *our* product is
  allowed; offering *Nango itself* as a hosted service to third parties is not.

## The three agent tools

Registered in `server/src/ai/tools/nango.ts`, given to the studio **Data & Live APIs** agent (and
resolvable anywhere by name). Each returns a clear "not configured" notice until `NANGO_SECRET_KEY` is set.

| Tool | Does | Key params |
|---|---|---|
| `nango_search_integrations` | Lists the integrations configured in your Nango (discover what's connectable) | `query?` |
| `nango_connect_integration` | Mints a short-lived **connect session** for an end user to authorize a provider | `integration`, `endUserId`, `endUserEmail?` |
| `nango_call_api` | **Proxies** an authenticated request to a connected provider (Nango injects creds + refreshes tokens) | `integration`, `connectionId?`, `method?`, `path`, `query?`, `body?`, `baseUrlOverride?` |

### How a generated app uses it at runtime (the pattern agents follow)
1. **Backend** mints a session: `POST {NANGO_HOST}/connect/sessions` with the secret key → `{ data: { token } }`.
2. **Frontend** opens Connect UI: `import Nango from '@nangohq/frontend'; new Nango().openConnectUI({ sessionToken })`.
3. **Backend** makes calls via the proxy with the resulting `connectionId` (never expose the secret client-side).

## Configuration

| Env var | Where | Purpose |
|---|---|---|
| `NANGO_HOST` | app | Nango base URL (default `http://localhost:3003`) |
| `NANGO_SECRET_KEY` | app | Server secret key (from the Nango dashboard) — enables the tools |
| `NANGO_DEFAULT_CONNECTION_ID` | app | Optional test connection so agents can verify response shapes at build time |
| `NANGO_ENCRYPTION_KEY` | compose | **Mandatory**, `openssl rand -base64 32`, never rotate |

## Verified REST reference (self-hosted; base = `NANGO_HOST`, auth = `Authorization: Bearer <secret>`)

- **List integrations:** `GET /integrations` → `{ data: [{ unique_key, display_name, provider }] }`. `unique_key` is the `provider_config_key`.
- **List/get connections:** `GET /connections`; `GET /connections/{id}?provider_config_key=...` (`force_refresh`, `refresh_token` optional).
- **Proxy:** `GET|POST|PUT|PATCH|DELETE {HOST}/proxy/{path}` with headers `Connection-Id`, `Provider-Config-Key` (+ optional `Base-Url-Override`, `Retries`, `Retry-On`). Path/query/body are forwarded verbatim; Nango injects provider auth.
- **Connect session:** `POST /connect/sessions` body `{ end_user: { id, email? }, allowed_integrations: [id] }` → `{ data: { token, expires_at, connect_link } }` (token lives 30 min). `end_user` is accepted today; the spec is migrating to a `tags` object.
- **MCP (optional):** `{HOST}/mcp` (Streamable HTTP) with headers `Authorization`, `connection-id`, `provider-config-key` — it is **connection-scoped per request**, which is why we prefer the REST meta-tools (per-call `connectionId`) for general agent use. Wire a scoped one via `STUDIO_NANGO_MCP_URL` + `STUDIO_NANGO_MCP_URL_HEADERS`.

## Self-host footprint (minimal)

`postgres:16-alpine` + `redis:7.2.4` + `nangohq/nango-server:hosted` (bundles server+jobs+persist;
ports 3003 API / 3009 Connect UI). Elasticsearch is opt-in (logs UI only). See
`deploy/studio-tools/docker-compose.yml`.
