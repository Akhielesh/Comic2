# 30 — Integrations Framework (Nango + MCP + Webhooks)

> Part III · Architecture · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Foundations](../F-ENTERPRISE-FOUNDATIONS.md) (**F10** integrations unification) ·
> [Master Plan](../00-MASTER-PLAN.md) (§5 security, §6 hosting/adapters, **A5** deploy
> adapters, **A6** sense layer) · [UX: Integrations & Connections](./18-ux-integrations.md)
> (the screens) · [Deploy Adapters](./31-deploy-adapters.md) (the consumers) ·
> [Realtime & Events](./28-api-realtime-events.md) (the event bus webhooks feed) ·
> [INTEGRATIONS-NANGO.md](../../INTEGRATIONS-NANGO.md) (operator runbook).
> This section owns the **framework**: how Autopilot connects to, authenticates with, calls,
> and *listens to* the outside world. [§18](./18-ux-integrations.md) specs the UX over it;
> [§31](./31-deploy-adapters.md) specs the deploy adapters that consume it.

## 30.1 Scope and the honest two-mechanism reality

Autopilot reaches the outside world through **two mechanisms that exist today and do not know
about each other**, plus a third (inbound webhooks) that barely exists at all. We will not
pretend a unified framework is shipped. It is not. This section first describes the real,
audited present, then specifies the **target unified Integration Framework** that F10 builds.

| Mechanism | Direction | What it is today | Status |
|---|---|---|---|
| **Nango connectors** | Outbound | 3 agent meta-tools over a self-hosted Nango (OAuth + token refresh + proxy for 800+ providers) | ✅ shipped (`server/src/ai/tools/nango.ts`) |
| **MCP client + registry** | Outbound | SSRF-guarded JSON-RPC client; per-user server registry with health + auto-disable | ✅ shipped (`ai/tools/mcpClient.ts`, `services/mcpRegistry.ts`, `routes/mcp.ts`) |
| **Outbound MCP endpoint** | Inbound (tool calls) | Our own read-only tools published as an MCP server for external agents | ✅ shipped (`routes/mcp.ts` `mcpOutboundRouter`) |
| **Inbound webhooks** | Inbound (events) | **Only Stripe** — signature-verified billing events | 🟡 partial (`routes/webhook.ts`) |
| **Unified Connection model + catalog** | — | One model spanning Nango + MCP with state/scopes/expiry/health/owner/scope | 📋 planned (**F10**) |
| **Connection-state / expiry / scope tracking** | — | Generalized health + token-expiry observability beyond MCP | 📋 planned (**F10**) |
| **Inbound webhooks beyond Stripe** | Inbound | Nango sync events, MCP push → SENSE signals | 📋 planned (**F10 + A6**) |
| **MCP call retries** | — | No retry on transient MCP failures (one attempt, then skip) | 📋 planned (**F10**) |

The F10 verdict from the audit ([Foundations](../F-ENTERPRISE-FOUNDATIONS.md) concern #7) is
exact and we hold to it: *"Nango + MCP are two parallel mechanisms; no unified catalog, no
inbound webhooks, no connection-state/expiry tracking."* This section is the design that closes
that gap **without regressing the genuinely good parts** — the SSRF guard, the
auto-disable-after-3-fails health loop, the secrets-only-in-Nango stance, and the 3-meta-tool
discipline that keeps the model's tool budget sane.

## 30.2 The current state, honestly (audited, file-referenced)

### 30.2.1 Nango — outbound, OAuth-managed, secret-side

Nango is run as a **self-hosted sidecar** (`postgres` + `redis` + `nangohq/nango-server`,
ports 3003/3009), not vendored into the tree — operators *operate* it, they do not own 800+
connectors' source ([INTEGRATIONS-NANGO.md](../../INTEGRATIONS-NANGO.md)). The app talks to it
over REST with the operator's **secret key**, which **never leaves the server**. Agents get
exactly **three** meta-tools (`server/src/ai/tools/nango.ts`), not 800 raw tools — a deliberate
choice to protect tool selection:

| Tool | Nango endpoint | What it does |
|---|---|---|
| `nango_search_integrations` | `GET /integrations` | Discover which providers are configured (`unique_key` = `provider_config_key`) |
| `nango_connect_integration` | `POST /connect/sessions` | Mint a 30-min connect-session token for an end user to authorize a provider |
| `nango_call_api` | `GET\|POST\|… /proxy/{path}` | Proxy an authenticated call; Nango injects creds + refreshes tokens |

Hardening already present: a 20s timeout with outer-signal propagation (`withTimeout`), an
allowed-method allow-list (`ALLOWED_METHODS`), an 8 KB cap on proxied response bodies fed back
to the model (`MAX_BODY_CHARS`), and an honest **"not configured"** notice when
`NANGO_SECRET_KEY` is unset (`notConfigured()`) rather than a silent failure.

```
  Agent ──nango_call_api──► [our server: secret key] ──Bearer──► Nango sidecar ──injects creds──► Provider API
                                  │                                   │
                          never to client                    OAuth tokens stored + refreshed here
```

**What Nango does NOT give us today:** any record *in our system* of which connections exist,
their granted scopes, their owner, or their expiry. That state lives entirely inside Nango.
There is no `venture_connections` table yet (it is planned in **A1**), so from Autopilot's point
of view a connection is a string (`connectionId` / `provider_config_key`) passed per call — not
a first-class, observable object.

### 30.2.2 MCP — outbound client + a real health loop

The MCP client (`ai/tools/mcpClient.ts`) speaks **JSON-RPC over Streamable HTTP**
(`PROTOCOL_VERSION = '2025-06-18'`), parsing both plain-JSON and single-event SSE responses
(`parseRpcBody`). Its strengths, which we preserve verbatim:

- **SSRF guard (`isSafeMcpUrl`).** User-supplied URLs **must** be `https` and **must not** be
  loopback/private (`PRIVATE_HOST_RE` blocks `localhost`, `127.`, `10.`, `169.254.`, `192.168.`,
  `172.16–31.`, `::1`, ULA `fc/fd`, and `*.local`). Only **operator-configured "trusted"**
  servers (e.g. a self-hosted sidecar) may relax to `http`/internal via `allowInternal` — the
  strict path is never weakened for anything a user can set.
- **Bounded + cancellable.** 15s timeout (`MCP_TIMEOUT_MS`), outer `AbortSignal` propagation,
  5-min tools cache (`TOOLS_CACHE_TTL_MS`).
- **Namespaced tools.** `mcp_<serverId>_<tool>` so MCP tools never collide with built-ins.
- **Fail-soft.** A broken server is skipped in `buildMcpTools`, never breaking the chat loop.

The registry (`services/mcpRegistry.ts`) persists a user's custom servers in `mcp_servers`
(syncs across devices, replacing per-device localStorage), SSRF-guards on write, and runs the
**health loop that is the model for everything F10 generalizes**:

```
checkMcpServer():  list tools  ─ ok ──► health='ok', fail_count=0
                              └ err ──► fail_count += 1 ; enabled = fail_count < 3
                                        (AUTO_DISABLE_AFTER = 3)  → dead endpoint stops
                                                                    adding latency to chats
```

Stored auth headers are **never echoed back** (`redactServer` returns only `hasAuth`). The
inbound `mcpOutboundRouter` publishes a **read-only subset** of our own tools (no
`generate_app`, no swarm) behind a **constant-time bearer check** (`crypto.timingSafeEqual`).

### 30.2.3 Inbound — only Stripe

The single inbound webhook is `POST /api/webhook/stripe` (`routes/webhook.ts`): it requires the
`stripe-signature` header, verifies it against the raw body (`express.raw()` upstream), and
hands off to `handleStripeWebhook`. This is correct and we keep it — but it is **the only
inbound event path in the entire system**. Nango sync events, MCP server-side pushes, provider
deploy callbacks, and runtime-error beacons (A6) all have **nowhere to land**.

### 30.2.4 The four concrete gaps

1. **No unified model.** Nango and MCP are siblings that never meet. There is no single
   `Connection` abstraction, no catalog, no shared health/scope/expiry view. UX
   ([§18.1](./18-ux-integrations.md)) has to hand-stitch them.
2. **No inbound webhooks beyond Stripe.** No generic, signature-verified intake; nothing feeds
   the **SENSE** layer ([Master Plan §4.1](../00-MASTER-PLAN.md), **A6**).
3. **No connection-state / expiry / scope tracking.** MCP has `health`/`fail_count`; **Nango
   connections have nothing in our DB.** We cannot say *"your Slack connection expired"* because
   we never recorded that it existed, what scopes it has, or when it expires.
4. **No MCP retries.** A single transient failure counts as a hard failure, drives `fail_count`
   up, and can prematurely auto-disable a healthy-but-flaky server. Nango's proxy supports
   `Retries`/`Retry-On` headers we do not yet use.

## 30.3 The target: one unified Integration Framework (F10)

The framework introduces **one `Connection` model** and **one catalog** that span every
mechanism, plus a **generalized health/expiry loop**, an **inbound event ingress**, and **MCP
retries** — all additive, flag-safe, and built **on top of** the shipped pieces, not replacing
them. The Nango meta-tools and the MCP client/registry remain the *transports*; the framework is
the *model + observability + ingress* layered over them.

```
            ┌──────────────────────── Integration Framework (F10) ─────────────────────────┐
            │                                                                               │
            │   Connection model + Catalog  (one surface: state · scopes · expiry · health) │
            │            │                          │                         │             │
            │   ┌────────▼────────┐      ┌──────────▼─────────┐    ┌──────────▼──────────┐  │
            │   │ Nango transport │      │  MCP transport     │    │ Inbound webhook      │  │
            │   │ (3 meta-tools)  │      │ (client+registry)  │    │ ingress (verified)   │  │
            │   └────────┬────────┘      └──────────┬─────────┘    └──────────┬──────────┘  │
            └────────────┼──────────────────────────┼─────────────────────────┼────────────┘
                         │ OAuth+proxy               │ JSON-RPC (SSRF-guarded)  │ events
                         ▼                           ▼                          ▼
                 Nango sidecar / 800+        user/operator MCP servers   Stripe · Nango sync ·
                 providers                                               MCP push → SENSE (A6)
```

### 30.3.1 The `Connection` model

A single normalized record across mechanisms. It stores **references and metadata only — never
a secret** ([§30.7](#307-security)). Mirrors the `venture_connections` reference shape from
[Master Plan §5.3](../00-MASTER-PLAN.md) and [UX §18.2](./18-ux-integrations.md), generalized to
cover MCP and account-scope.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `user_id` | uuid | RLS owner key (`auth.uid() = user_id`) |
| `kind` | enum | `nango_oauth` \| `nango_pat` \| `mcp` |
| `provider_config_key` | text? | Nango `unique_key` (Nango kinds only) |
| `nango_connection_id` | text? | Reference into Nango (OAuth/PAT kinds); **no token** |
| `mcp_server_id` | uuid? | FK → `mcp_servers.id` (MCP kind only) |
| `display_name` | text | "Cloudflare (acme-team)" |
| `category` | enum | `deploy` \| `source` \| `data` \| `comms` \| `mcp` (the UX job grouping) |
| `scope` | enum | `account` \| `venture` ([§18.2](./18-ux-integrations.md)) |
| `venture_id` | uuid? | set when `scope = venture`; RLS-scoped |
| `granted_scopes` | text[] | from the OAuth grant / PAT probe — what the user handed over |
| `health` | enum | `ok` \| `degraded` \| `error` \| `unknown` (superset of the MCP states) |
| `last_checked_at` | timestamptz? | generalizes the MCP field |
| `fail_count` | int | drives auto-disable, reusing the MCP `AUTO_DISABLE_AFTER = 3` policy |
| `expires_at` | timestamptz? | **null for Nango OAuth** (auto-refreshed); real for PATs |
| `enabled` | bool | auto-disable flips this, exactly like MCP today |
| `created_at` / `created_by` | — | for the audit line ("connected by you, 2026-05-21") |

**Design notes.** MCP rows are a *view* over the existing `mcp_servers` registry — we do **not**
duplicate the source of truth; the framework reads MCP health from `mcpRegistry.ts` and presents
it in the same shape. Nango rows are **new** (the missing connection-state). `health: 'degraded'`
is the new state OAuth/expiry needs that the MCP three-state model lacked.

### 30.3.2 The catalog API

One read surface unifies both mechanisms for the UX in [§18.3](./18-ux-integrations.md). All
routes are owner-isolated (RLS) and behind the F10 flag.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/connections` | The unified catalog: all Connections grouped by `category`, each with health/scopes/expiry. Merges Nango rows + the MCP registry. |
| `GET` | `/api/connections/:id` | One connection's detail card (the [§18.5](./18-ux-integrations.md) view): scopes, health history, "used by N ventures". |
| `POST` | `/api/connections/:id/check` | Re-run the health probe now (generalizes `POST /api/mcp/:id/check`). |
| `POST` | `/api/connections/:id/reauthorize` | Re-mint a Nango connect-session for scope upgrade / re-auth. |
| `DELETE` | `/api/connections/:id` | Disconnect: revoke in Nango / discard PAT / remove MCP row; write a `venture_event`. |
| `GET` | `/api/integrations/providers` | Browse all Nango-configured providers (wraps `nango_search_integrations`) for the "Browse all" UX. |

The existing `/api/mcp` CRUD routes (`routes/mcp.ts`) stay; `/api/connections` is the
**superset** the unified catalog calls, delegating MCP operations to the proven registry rather
than reimplementing them.

### 30.3.3 OAuth lifecycle observability

The F10 line is "OAuth lifecycle observability (token expiry tracked, not just
delegated/forgotten)." Nango *handles* the lifecycle (refresh, storage); F10 makes it
**observable** without us ever touching the secret. We read state from Nango's connection
endpoints (`GET /connections/{id}?provider_config_key=…`) on a schedule and reflect it into the
`Connection` row:

```
 connect   ──►  Nango mints + stores tokens   ──►  we record a Connection row (reference + scopes)
 refresh   ──►  Nango refreshes silently      ──►  health probe confirms 'ok'; expires_at stays null (OAuth)
 expire    ──►  refresh fails / token revoked  ──► probe → health='degraded'/'error' → notice + Reconnect CTA
 revoke    ──►  user disconnects               ──►  ask Nango to delete tokens; row → removed; audit event
```

| Lifecycle event | Observed via | Surfaced as |
|---|---|---|
| **connect** | catalog write after `openConnectUI` succeeds | row appears `● Healthy` + audit event |
| **refresh** | periodic probe returns `ok` | silent; `last_checked_at` advances |
| **expire / revoke (OAuth)** | probe / proxy returns 401/refresh-failure | `health='degraded'` → in-app + email notice, Reconnect CTA on every surface ([§18.5](./18-ux-integrations.md)) |
| **PAT expiry** | `expires_at` countdown (real for PATs) | `⚠ Expiring` inside a 7-day window |

This is honest about the split UX [§18.5](./18-ux-integrations.md) already specced: **OAuth via
Nango shows "auto-refreshed — no action needed"** (no misleading countdown), **PATs show a real
expiry/countdown.** The probe is a cheap authenticated read per provider, reusing the *same
loop shape* as `checkMcpServer` — one health mechanism, two transports.

### 30.3.4 MCP call retries (keep the SSRF guard)

We add bounded retries to the MCP `rpc()` path — and **only** there; the SSRF guard, https/
public-host enforcement, trusted-relaxation, timeout, and namespacing are untouched.

- **Retry policy:** up to **2 retries** (3 total attempts) on *transient* failures only —
  network error, timeout/abort (not user-cancel), and `5xx` / `429`. **Never** retry `4xx`
  (other than 429), `tools/call` `isError` results, or anything past the per-call deadline.
- **Backoff:** exponential with jitter (e.g. 250 ms → 750 ms), capped by the existing 15s
  budget so retries never blow the timeout.
- **Health interaction:** a call that succeeds *after* retry counts as **healthy** —
  `fail_count` is incremented only when **all** attempts fail. This directly fixes the gap where
  one transient blip could march a good server toward the 3-fail auto-disable.
- **Nango parity:** for the Nango proxy, set the documented `Retries` + `Retry-On` headers
  ([INTEGRATIONS-NANGO.md](../../INTEGRATIONS-NANGO.md)) so both transports retry consistently.

> **Invariant (do not regress):** retries run **after** `isSafeMcpUrl` passes, against the
> already-validated URL. We never re-resolve or relax the host between attempts. SSRF protection
> is upstream of, and untouched by, retry logic.

## 30.4 Inbound webhooks → the SENSE layer (A6)

Today only Stripe arrives. F10 adds a **generic, signature-verified webhook ingress** that
normalizes external events into the system's event model and feeds Autopilot's **SENSE** step
([Master Plan §4.1](../00-MASTER-PLAN.md), **A6**). This is what turns "the agent builds" into
"the agent *notices and iterates*."

```
  External source ──► /api/webhooks/:source ──► [verify signature] ──► normalize ──► venture_signal
                                                       │                                  │
                                                 reject if bad sig                  SENSE reads it next tick
                                                                                    (Master Plan §4.1 / A6)
```

| Source | Endpoint | Verification | Becomes |
|---|---|---|---|
| **Stripe** (shipped) | `/api/webhook/stripe` | `stripe-signature` (HMAC) | billing event (unchanged) |
| **Nango sync events** | `/api/webhooks/nango` | Nango webhook signature / shared secret | connection-health + data-sync signals → SENSE |
| **MCP push** (notifications) | `/api/webhooks/mcp/:serverId` *(opt-in)* | per-server shared secret + owner scope | tool/resource-change signals → SENSE |
| **Deploy provider callbacks** | `/api/webhooks/:provider` | per-provider HMAC | deploy-status signals (A5/A6) |
| **Runtime-error beacon** (A6) | `POST /api/ventures/:id/signals` | owner-scoped, rate-limited | runtime-error signals (already A6-specced) |

**Contract:** every inbound endpoint (a) verifies a signature/secret **before** parsing
(matching the Stripe `express.raw()` pattern so the raw body is intact for HMAC), (b) is
**idempotent** by provider event id (replays are no-ops — ties into **F2** idempotency keys),
(c) writes an append-only `venture_event` / `venture_signal`, and (d) **never** trusts payload
contents as authorization — only the verified signature. Unverifiable or unknown sources are
rejected `400`, never silently accepted.

**Feeding SENSE.** A6's `tick.ts` SENSE step reads accumulated signals; F10's ingress is the
*producer* side. Until A6 lands, signals can accrue harmlessly (no consumer) — the ingress is
useful and shippable on its own, satisfying the F10 acceptance *"a webhook event is consumed
end-to-end"* (consumed by the event store now; by ORIENT once A6 is wired). This is the seam the
two epics share, called out in [Foundations §F10](../F-ENTERPRISE-FOUNDATIONS.md) ("feeds
Autopilot's SENSE layer, A6").

## 30.5 The connector catalog data + API (summary)

The catalog has two layers, and the distinction is load-bearing:

| Layer | What | Source | Surface |
|---|---|---|---|
| **Providers** (what's *connectable*) | The 800+ Nango integrations configured in the sidecar + the curated MCP marketplace | `GET /integrations` (Nango) + `MCP_CATALOG` (`ai/tools/mcpCatalog.ts`) | "Browse all providers" ([§18.3](./18-ux-integrations.md)) |
| **Connections** (what's *connected*) | This user's live `Connection` rows + their MCP registry | `Connection` model + `mcp_servers` | The unified catalog ([§18.3](./18-ux-integrations.md)) |

The providers layer is **discovery** (read-through to Nango/the MCP catalog, cached); the
connections layer is **state** (owner-isolated rows with health/scopes/expiry). [§30.3.2](#3032-the-catalog-api)
lists the connections API; the providers API is the single `GET /api/integrations/providers`
read that wraps the shipped `nango_search_integrations` discovery.

## 30.6 How this maps to F10 / A5 / A6

| Framework piece | Epic | Status | Acceptance tie-in |
|---|---|---|---|
| Unified `Connection` model + catalog (Nango + MCP) | **F10** | 📋 | "one catalog shows every connection's health/expiry" |
| Connection-state / scope / expiry tracking | **F10** | 📋 | "an expired connection is surfaced to the user" |
| OAuth lifecycle observability (connect/refresh/expire/revoke) | **F10** | 📋 | token expiry tracked, not delegated/forgotten |
| MCP call retries (SSRF guard kept) | **F10** | 📋 | retries on MCP calls; SSRF guard preserved |
| Inbound webhook ingress (Nango sync, MCP push, deploy callbacks) | **F10** → **A6** | 📋 | "a webhook event is consumed end-to-end" → SENSE |
| Per-venture connections + deploy-target binding | **A5** (data in **A1**) | 📋 | adapters select a Connection; tokens never logged |
| Signals → SENSE → ORIENT (new fix/improve goals) | **A6** | 📋 | runtime error → fix goal shipped autonomously |
| Nango meta-tools (discover/connect/proxy) | (existing studio) | ✅ | preserved as the transport |
| MCP client + registry + auto-disable + outbound endpoint | (existing, Phase 10) | ✅ | preserved as the transport + health loop |

**Sequencing** ([Foundations](../F-ENTERPRISE-FOUNDATIONS.md) revised plan): F10's webhook
ingress shares the A6 sense-layer work — *"A6 sense(+F10 webhooks)"* — so the producer (ingress)
and consumer (SENSE) land together. The `Connection` model depends on **A1**'s
`venture_connections` migration for the per-venture rows, and **A5** is the first real consumer
(deploy adapters resolving a Connection to ship to a user's cloud).

## 30.7 Security

The framework holds the keys to users' clouds; the [Master Plan §5](../00-MASTER-PLAN.md) rules
are hard constraints, not guidance.

- **Secrets only in Nango — never in our DB, never in the client.** A `Connection` row stores a
  *reference* (`nango_connection_id` / `provider_config_key`) + metadata + granted scopes. The
  Nango secret key is **server-only** (`nango.ts`), MCP auth headers are **never echoed**
  (`redactServer`), and a PAT is **write-only** from the user's side once entered
  ([§18.9](./18-ux-integrations.md)). The UI never displays a token — not masked, not on hover.
- **SSRF guard stays strict (preserve).** `isSafeMcpUrl` keeps enforcing https + public-host for
  every user-supplied URL; only operator-configured `trusted` servers relax it. Retries
  ([§30.3.4](#3034-mcp-call-retries-keep-the-ssrf-guard)) run downstream of the guard, never
  around it. Inbound webhook endpoints verify a signature **before** parsing the body.
- **Least privilege.** Each adapter requests the **minimum** scopes ([Master Plan §5.9](../00-MASTER-PLAN.md));
  `granted_scopes` makes over-broad grants *visible and correctable* ([§18.5](./18-ux-integrations.md)).
  A missing scope triggers a targeted "grant additional access" re-auth, not an opaque
  deploy-time failure.
- **Tokens never logged.** No credential value enters logs, traces, or `venture_events` — only
  references and outcomes (Master Plan §5.9; A5 acceptance "tokens never logged").
- **Owner isolation.** Every `Connection` row is RLS owner-isolated (`auth.uid() = user_id`,
  mirroring `projects_rls_owner_isolation.sql`); the framework's service identity always scopes
  by `user_id` (+ `venture_id` when venture-scoped). No cross-tenant read of a connection ever.
- **Inbound trust.** Webhook payload contents are **never** authorization — only the verified
  HMAC/secret is. Endpoints are idempotent (replay-safe), reject unknown/unsigned sources, and
  write an append-only audit record.
- **Auto-disable as a safety control.** The MCP `AUTO_DISABLE_AFTER = 3` policy (generalized to
  all kinds) stops a dead or compromised endpoint from quietly adding latency or being retried
  forever; the user re-enables explicitly.

## 30.8 Acceptance criteria

- One catalog (`GET /api/connections`) returns **every** connection — Nango OAuth/PAT and MCP —
  grouped by job, each with `kind`, `category`, `health`, `granted_scopes`, and `expires_at`
  (real for PATs; null/"auto-refreshed" for Nango OAuth).
- An expired or revoked OAuth connection is detected by the health probe, flips to
  `degraded`/`error`, and raises an in-app + email notice with a Reconnect CTA on every surface
  that lists it ("your Slack connection expired").
- The MCP client retries transient failures (network/timeout/5xx/429) up to 2× with backoff
  inside the 15s budget; a success-after-retry does **not** increment `fail_count`; the SSRF
  guard, https/public-host enforcement, and trusted-relaxation are unchanged (regression test).
- A generic inbound webhook (e.g. Nango sync) is signature-verified before parsing, deduped by
  event id, normalized into a `venture_signal`/`venture_event`, and is consumable by SENSE (A6)
  — proving the end-to-end path while remaining safe if A6 is not yet wired.
- No secret is ever stored in our DB, displayed, or logged; `Connection` rows hold only
  references + metadata + scopes; rows are RLS owner-isolated.
- The Nango 3-meta-tool transport and the MCP client/registry (incl. auto-disable-after-3-fails
  and the outbound read-only MCP endpoint) are preserved unchanged as the underlying transports.

---

> **Honest caveat.** This section specifies the *framework*; nothing here is shipped except the
> transports it builds on (Nango meta-tools, the MCP client/registry, the Stripe webhook). The
> unified model, catalog, generalized health/expiry, MCP retries, and the webhook ingress are
> **F10 + A6** deliverables, sequenced under autonomy per
> [Foundations](../F-ENTERPRISE-FOUNDATIONS.md). The design's whole discipline is to **add a
> model and observability over proven transports**, not to rebuild the connectors — exactly the
> "operate, don't absorb" stance Nango is run under.
