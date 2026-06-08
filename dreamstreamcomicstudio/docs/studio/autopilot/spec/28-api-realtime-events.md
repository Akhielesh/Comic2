# 28 — API Surface: Realtime & Events

> Part III · Architecture · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [ARCHITECTURE-CLOUDFLARE.md](../ARCHITECTURE-CLOUDFLARE.md) (DO + WebSocket Hibernation) ·
> [Master Plan](../00-MASTER-PLAN.md) (§4 loop/events, A8 console) ·
> [Operator Console](./14-ux-operator-console.md) (§14.11 real-time) ·
> [System Architecture](./22-system-architecture.md) · [Realtime & Sync](./34-realtime-sync.md).
> Companion to the synchronous [REST surface](./27-api-rest.md): this section owns everything
> **push** — streams, events, channels, presence, reconnection. Maps to **F4** (real-time DO +
> multi-device sync) and **A8** (the live Operator Console).

## 28.1 Scope & the honest two-tier story

This section specifies how a client *learns about change without asking* — the push half of the
API. Autopilot has two realtime transports, deliberately, and we are honest about which is shipped
and which is target:

| Tier | Transport | Use | Status |
|---|---|---|---|
| **Shipped today** | **SSE** (`text/event-stream`) | One-directional streams: the chat/swarm token stream, the studio build stream, and A8's first-cut `venture_events` stream. | ✅ `services/sse.ts` (client parser) + `server/src/routes/chat.ts` (`/stream`, `/swarm`). |
| **Target (F4/F5)** | **WebSocket via Durable Objects with Hibernation** | Bidirectional, multi-device, presence, instant convergence, cheap idle. The Operator Console's real watch surface and cross-device session/revocation. | 📋 `UserCoordinatorDO`, `VentureDO` (ARCHITECTURE-CLOUDFLARE §1, §3). |

**The design rule (so the migration is a transport swap, not a rewrite):** the client subscribes
through one **event-source abstraction** ([§14.11](./14-ux-operator-console.md)); the **message
schema is identical** over SSE and WebSocket. SSE carries the same `venture_event` JSON, framed as
SSE blocks; the WebSocket carries the same JSON, framed as WS text messages, **plus** the things SSE
structurally cannot do (client→server messages: subscribe, ack, presence, cursor). Everything in
[§28.4](#284-the-event-taxonomy-venture_events) (the taxonomy) is transport-agnostic; the
transport-specific contracts are [§28.5](#285-sse-the-shipped-stream) (SSE) and
[§28.6](#286-websocket-via-durable-objects-target) (WS/DO).

We do **not** retire SSE. SSE stays where it is simpler and one-directional is sufficient — the
build/token streams — exactly as shipped. We add WebSocket where bidirectional, multi-device, and
hibernating-idle actually matter: the console.

## 28.2 Why this transport split (the verified rationale)

A 24/7 watch surface is the worst case for a naive socket server: thousands of consoles can sit
open all night with **no events flowing**. An always-on WebSocket server (or a Railway box holding
sockets) bills for that idle time. Cloudflare's **WebSocket Hibernation API**
([ARCHITECTURE-CLOUDFLARE §1](../ARCHITECTURE-CLOUDFLARE.md)) lets a Durable Object keep the
connection's TCP/WebSocket alive while **evicting the DO from memory between messages** — you pay
for work, not for open-but-idle sockets. That is what makes "watch your agents 24/7" economically
viable, and it is the verified reason WebSocket lives on DOs here rather than on the Express tier.

SSE, by contrast, is one HTTP response held open. It is trivial (no upgrade handshake, works through
every proxy, already shipped) and perfect for "stream tokens of one build until done, then close."
It cannot do client→server messages, presence, or multi-device fan-out — so the console outgrows it
the moment a second device or a redirect/approve action enters the picture.

```
                          ┌──────────────────────────────────────────────┐
   Build / token stream → │  SSE  (one HTTP response, server→client only) │  simple, shipped
   (chat, swarm, studio)  │  event: delta / final / error · 15s keep-alive│
                          └──────────────────────────────────────────────┘

                          ┌──────────────────────────────────────────────┐
   Operator Console     → │  WebSocket via Durable Object (Hibernation)   │  bidirectional,
   (live + control)       │  client→ subscribe/ack/cursor/presence        │  multi-device,
                          │  server→ same venture_event JSON + presence   │  idle-cheap
                          └──────────────────────────────────────────────┘
```

## 28.3 The two Durable Objects (who owns which channel)

The realtime topology has exactly two object kinds (ARCHITECTURE-CLOUDFLARE §3). Each is the
**single global coordination point** for its id, and each is the fan-out anchor for one channel
family.

| DO | Id | Owns | Channels it fans out |
|---|---|---|---|
| **`VentureDO`** | `venture:<ventureId>` | The Tick heartbeat (Alarms), per-venture concurrency, and the live projection of that venture's state. | `venture:<id>:events` (the activity stream), `…:goals` (board), `…:deploys`, `…:status`. |
| **`UserCoordinatorDO`** | `user:<userId>` | Authoritative device sessions, presence, **instant revocation**, and cross-venture roll-ups. The auth/session anchor (F3/F4). | `user:<id>:inbox` (dashboard badge counts, approval/budget alerts across all ventures), `…:session` (revocation, device list). |

A console viewing one venture connects to **both**: `VentureDO` for that venture's firehose,
`UserCoordinatorDO` for cross-venture badges and session/revocation. The dashboard
([§14.10](./14-ux-operator-console.md)) connects to `UserCoordinatorDO` only. The Worker edge tier
([ARCHITECTURE-CLOUDFLARE §3](../ARCHITECTURE-CLOUDFLARE.md)) terminates the WS upgrade, authenticates
it ([§28.7](#287-authentication--authorization-on-the-channel)), then `stub.fetch(request)` hands the
socket to the right DO via RPC.

## 28.4 The event taxonomy (`venture_events`)

Every realtime message that is *about what the agent did* is a row of the append-only
`venture_events` log ([Master Plan §2](../00-MASTER-PLAN.md), [§9.3](./09-domain-model-glossary.md)).
The log is the **source of truth**; realtime is just its live tail. This is what makes reconnection
exact ([§28.8](#288-reconnection-replay--cursors)): a client that missed messages re-reads the log
from a cursor. **Push and replay are the same data.**

### 28.4.1 The envelope

Every event — over SSE or WebSocket — is one JSON object with a stable envelope:

| Field | Type | Notes |
|---|---|---|
| `id` | string (ULID) | Monotonic, sortable. Doubles as the **replay cursor** ([§28.8](#288-reconnection-replay--cursors)). |
| `seq` | integer | Per-venture monotonic sequence (gap detection). |
| `venture_id` | uuid | Tenant scope; every event is venture-scoped. |
| `run_id` | uuid \| null | The Run this belongs to (null for venture-level events). |
| `tick` | integer \| null | The Tick number ([§14.3](./14-ux-operator-console.md) groups by this). |
| `kind` | enum | The event type — the taxonomy below. |
| `phase` | enum \| null | `sense\|orient\|decide\|act\|verify\|ship\|reflect` when `kind` is a loop phase. |
| `ts` | string (ISO 8601) | Server time the event was appended. |
| `actor` | enum | `agent\|system\|user` — who caused it (a user `pause` is `user`). |
| `severity` | enum | `info\|success\|warn\|error` — drives the SwarmTrace banding ([§14.2](./14-ux-operator-console.md)). |
| `summary` | string | One-line, plain-English ([§21](./21-content-voice.md)) — the row a human reads. |
| `data` | object | Kind-specific payload (schemas below). **Secrets never appear here** ([Master Plan §5](../00-MASTER-PLAN.md)). |

> **Naming.** `kind` values are dotted `noun.verb` (`tick.started`, `file.written`,
> `deploy.shipped`). The verb is past tense for facts (it happened) and present-progressive only for
> spans that stay open (`tick.started` opens, `tick.completed` closes). This mirrors the loop's
> SENSE→…→REFLECT phases ([Master Plan §4.1](../00-MASTER-PLAN.md)) while staying greppable.

### 28.4.2 The kinds

Grouped by the loop phase or governance concern they report. The console's glyph/row mapping is in
[§14.3](./14-ux-operator-console.md).

| `kind` | Phase | `severity` | Meaning (the `summary`) | `data` shape (key fields) |
|---|---|---|---|---|
| `tick.started` | — | info | A new loop pass opened. | `{ tick, run_id, scheduled_by: "alarm"\|"trigger"\|"manual" }` |
| `tick.completed` | — | info | The pass closed. | `{ tick, outcome: "advanced"\|"idle"\|"paused", duration_ms, cost_usd }` |
| `sense.observed` | sense | info | Signals gathered. | `{ open_goals, last_deploy_health, new_errors, feedback_count }` |
| `goal.selected` | orient | info | The LLM picked the next goal. | `{ goal_id, title, rationale, model, cost_usd }` |
| `decide.gated` | decide | info | The deterministic gate's verdict. | `{ allow: bool, in_budget: bool, in_scope: bool, checkpoint_required: bool, reason }` |
| `file.written` | act | info | The build wrote/changed code. | `{ goal_id, version_id, files: [{ path, added, removed }], total: { added, removed } }` |
| `build.observed` | verify | success\|warn | Build/test/safety result. | `{ goal_id, build_ms, tests: { passed, failed }, typecheck: bool, safety: { secrets, dangerous_ops } }` |
| `deploy.shipped` | ship | success | A deploy went out. | `{ deployment_id, env: "preview"\|"production", provider, url, version_id, managed: bool }` |
| `reflect.recorded` | reflect | info | Learnings + goal updates. | `{ goal_id, status, learnings, goals_updated }` |
| `goal.updated` | — | info | A goal changed status/priority (board move). | `{ goal_id, from, to, priority }` |
| `checkpoint.raised` | — | warn | The loop paused for a human. | `{ checkpoint_id, type, title, blocks_goal_id, expires_at, context }` |
| `checkpoint.resolved` | — | info | A human (any device) decided. | `{ checkpoint_id, decision: "approved"\|"denied", by_user, note }` |
| `budget.alert` | — | warn | Spend crossed a threshold. | `{ pct, spent_usd, cap_usd, period: "day"\|"total", threshold: 80\|100 }` |
| `status.changed` | — | info\|warn | Venture lifecycle moved. | `{ from, to, reason?: "budget"\|"checkpoint"\|"kill"\|"stuck" }` |
| `error` | — | error | Something failed. | `{ where, message, no_progress_count, goal_id? }` |

> **Honest constraint:** `data` payloads are **bounded** and **redacted at the writer**
> ([Master Plan A0 `events.ts`](../00-MASTER-PLAN.md)) — no model prompts, no tokens, no BYO
> credentials. The unredacted audit view ([§14.8](./14-ux-operator-console.md)) reads
> `venture_events` directly server-side; it is never pushed over a channel.

### 28.4.3 Example messages

A `file.written` event (the ACT phase wrote code):

```json
{
  "id": "01J9Z6Q2K8M3W7VE5R0T9A4B7C",
  "seq": 4821,
  "venture_id": "b3f1c8a0-9e2d-4f77-a1c5-2d6e8f9a0b1c",
  "run_id": "7a2e0c11-4d9b-4a3e-8c0f-1b2a3c4d5e6f",
  "tick": 31,
  "kind": "file.written",
  "phase": "act",
  "ts": "2026-06-07T14:19:02.441Z",
  "actor": "agent",
  "severity": "info",
  "summary": "Wrote 6 files for \"email auth\" (+182 −9).",
  "data": {
    "goal_id": "f1a2b3c4-...", "version_id": "v_018e...",
    "files": [
      { "path": "src/auth/email.ts", "added": 74, "removed": 0 },
      { "path": "src/routes/login.tsx", "added": 61, "removed": 9 }
    ],
    "total": { "added": 182, "removed": 9 }
  }
}
```

A `checkpoint.raised` event (the loop paused for production approval):

```json
{
  "id": "01J9Z6QF1N0X4Y8Z2C5V7B9M3D",
  "seq": 4830,
  "venture_id": "b3f1c8a0-9e2d-4f77-a1c5-2d6e8f9a0b1c",
  "run_id": "7a2e0c11-...", "tick": 31,
  "kind": "checkpoint.raised",
  "phase": "ship",
  "ts": "2026-06-07T14:22:10.002Z",
  "actor": "system", "severity": "warn",
  "summary": "Approval needed: deploy \"email auth\" to PRODUCTION.",
  "data": {
    "checkpoint_id": "c_9f8e...", "type": "first_production_deploy",
    "title": "Deploy to PRODUCTION", "blocks_goal_id": "f1a2b3c4-...",
    "expires_at": "2026-06-08T14:22:10Z",
    "context": { "target": "acme-booking.com", "provider": "cloudflare-pages",
                 "changes": { "files": 6, "added": 182, "removed": 9 },
                 "safety": { "secrets": 0, "tests_passed": 42 }, "est_cost_usd": 0 }
  }
}
```

A `budget.alert` event (80% of the daily cap):

```json
{
  "id": "01J9Z6R0...", "seq": 4833, "venture_id": "b3f1c8a0-...",
  "run_id": null, "tick": null,
  "kind": "budget.alert", "phase": null,
  "ts": "2026-06-07T14:25:00Z", "actor": "system", "severity": "warn",
  "summary": "Spend hit 80% of today's budget ($20.00 of $25.00).",
  "data": { "pct": 80, "spent_usd": 20.0, "cap_usd": 25.0, "period": "day", "threshold": 80 }
}
```

## 28.5 SSE — the shipped stream

The first cut of A8 ([Master Plan A8](../00-MASTER-PLAN.md)) and all build/token streams use SSE,
matching the **exact framing already shipped** in `server/src/routes/chat.ts` and parsed by
`services/sse.ts`. We do not invent a new SSE dialect.

### 28.5.1 Endpoint

```
GET /api/ventures/:id/stream?since=<cursorId>     Accept: text/event-stream
```

- **Auth:** the standard bearer/session middleware (`server/src/middleware/auth.ts`) + RLS
  owner-isolation; a user can only open the stream for a venture they own ([§28.7](#287-authentication--authorization-on-the-channel)).
- **`since`** (optional): a `venture_events.id` cursor — the server first **replays** all events
  after it ([§28.8](#288-reconnection-replay--cursors)), then tails live. Omitted = live tail only.

### 28.5.2 Framing (identical to chat.ts as shipped)

Response headers and event framing match `chat.ts` verbatim — this is the contract the existing
`services/sse.ts` parser already speaks:

```
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

| SSE `event:` | `data:` | Meaning |
|---|---|---|
| `meta` | `{ venture_id, cursor, replaying: bool }` | Sent first; tells the client where the cursor starts. |
| `event` | a full `venture_event` ([§28.4.1](#2841-the-envelope)) | One taxonomy event. The default channel. |
| `ping` | `{ ts }` | Optional structured heartbeat (in addition to the comment keep-alive). |
| `error` | `{ message }` | Terminal stream error; the client falls back to polling. |
| *(comment)* | `: keep-alive` | The **15-second comment heartbeat** from `chat.ts:595` — keeps the connection hot through Railway/Cloudflare/mobile-carrier idle proxies. Ignored by `parseSSEBlock` (it skips lines starting with `:`). |

A wire sample (note the literal `: keep-alive` comment line, exactly as `chat.ts` emits and
`services/sse.ts` skips):

```
event: meta
data: {"venture_id":"b3f1c8a0-...","cursor":"01J9Z6Q2...","replaying":true}

: keep-alive

event: event
data: {"id":"01J9Z6Q2K8M3W7VE5R0T9A4B7C","kind":"file.written","seq":4821,...}

event: event
data: {"id":"01J9Z6QF1N0X4Y8Z2C5V7B9M3D","kind":"checkpoint.raised","seq":4830,...}
```

The 15s comment heartbeat is load-bearing and non-negotiable for the same reason it exists in
`chat.ts`: a watch stream can be silent for minutes between ticks, and an idle proxy drops a quiet
streaming connection (~30s), surfacing as a bare "network error." The comment line keeps it alive
without polluting the event stream.

### 28.5.3 SSE limits (why it is not the final transport)

SSE is server→client only. The console's **writes** — approve a checkpoint, pause, reprioritize a
goal — go over the synchronous [REST API](./27-api-rest.md) (`POST /api/ventures/:id/checkpoints/:cid/resolve`,
`…/pause`, `…/goals/reorder`), and the resulting state change flows *back* as a `checkpoint.resolved`
/ `status.changed` / `goal.updated` event on the stream. That round-trip is acceptable for one
device; it does **not** give multi-device convergence or presence — which is precisely the F4 gap the
WebSocket path closes.

## 28.6 WebSocket via Durable Objects (target)

The F4/F5 upgrade. Same JSON, bidirectional, multi-device, hibernating-idle.

### 28.6.1 Handshake

```
GET /api/ventures/:id/ws         Upgrade: websocket        (+ auth — §28.7)
GET /api/user/ws                 Upgrade: websocket        (UserCoordinatorDO)
```

The Worker edge authenticates the upgrade, derives the venture/user scope, then RPC-hands the socket
to `VentureDO` / `UserCoordinatorDO` via `stub.fetch(request)`. The DO accepts it with the
**Hibernation** API (`state.acceptWebSocket(ws)`), so the connection survives the DO being evicted
from memory between events — the cost property from [§28.2](#282-why-this-transport-split-the-verified-rationale).

### 28.6.2 Message schema (both directions)

Every WS frame is a JSON object with a `t` (type) discriminator. **Server→client `event` frames wrap
the identical `venture_event` envelope from [§28.4.1](#2841-the-envelope)** — the SSE-to-WS swap is
purely the outer frame.

Client → server:

| `t` | Payload | Purpose |
|---|---|---|
| `subscribe` | `{ topics: ["venture:<id>:events", "…:goals", ...], since?: cursorId }` | Join topics ([§28.9](#289-subscription--topic-model)); optional replay cursor. |
| `unsubscribe` | `{ topics: [...] }` | Leave topics (e.g. switch tabs). |
| `ack` | `{ upto: seq }` | Acknowledge delivery up to a seq — drives backpressure ([§28.10](#2810-backpressure)). |
| `presence` | `{ state: "active"\|"idle", view?: "activity"\|"board"\|... }` | Update this device's presence ([§28.11](#2811-presence)). |
| `ping` | `{ ts }` | App-level liveness (in addition to WS protocol pings). |

Server → client:

| `t` | Payload | Purpose |
|---|---|---|
| `ready` | `{ topics, cursor, replaying: bool, presence: [...] }` | Subscription confirmed; the join snapshot. |
| `event` | a `venture_event` + `{ topic }` | One taxonomy event (the firehose). |
| `presence` | `{ topic, members: [{ device_id, user_id, state, view }] }` | Presence roster changed. |
| `revoked` | `{ reason }` | **Instant revocation** — `UserCoordinatorDO` kills this device's session ([§28.7](#287-authentication--authorization-on-the-channel)). |
| `lag` | `{ dropped: n, resume_cursor: id }` | Backpressure shed messages; client must replay from the cursor ([§28.10](#2810-backpressure)). |
| `pong` | `{ ts }` | Liveness reply. |

A client subscribe and a server event:

```json
// client → server
{ "t": "subscribe",
  "topics": ["venture:b3f1c8a0-...:events", "venture:b3f1c8a0-...:goals"],
  "since": "01J9Z6Q2K8M3W7VE5R0T9A4B7C" }

// server → client
{ "t": "event",
  "topic": "venture:b3f1c8a0-...:events",
  "event": { "id": "01J9Z6QF...", "kind": "checkpoint.raised", "seq": 4830, "...": "..." } }
```

### 28.6.3 Multi-device convergence

The `UserCoordinatorDO` is the single point that makes "approve on laptop → phone updates in place"
true ([§14.5](./14-ux-operator-console.md)). When any device resolves a checkpoint via REST, the
control plane writes `checkpoint.resolved` to `venture_events` **and** notifies the user's DO, which
fans the resolution to every connected device on `user:<id>:inbox`. No device polls; none can show a
stale "needs approval" card. Optimistic UI writes reconcile against this authoritative broadcast
([§14.11](./14-ux-operator-console.md)).

## 28.7 Authentication & authorization on the channel

Realtime auth is **not** an afterthought bolted onto an open socket — it is checked at the edge
*before* the DO ever sees the connection, and re-anchored continuously by the `UserCoordinatorDO`.

1. **Open-time auth (both transports).** The Worker/Express edge validates the Supabase session
   bearer token (`server/src/middleware/auth.ts`) on the SSE request / WS upgrade. No token, no
   stream. The token is **never** passed in the URL query (it would leak into logs) — it rides the
   `Authorization` header, or for the browser-WS case a short-lived **ticket**: the client first
   `POST /api/realtime/ticket` (authenticated) to get a 60s single-use token, then opens
   `…/ws?ticket=<t>`. The ticket is redeemed once at the DO and discarded.
2. **Tenant scoping (RLS parity).** The derived `user_id` must own `:ventureId` (the same
   `auth.uid() = user_id` rule as `projects_rls_owner_isolation.sql`, [Master Plan §5](../00-MASTER-PLAN.md)).
   Cross-tenant subscribe is rejected with `4403` (see codes below); a `VentureDO` only ever fans
   out to sockets whose user owns it.
3. **Topic authorization.** Each `subscribe` is re-checked against the connection's scope — a socket
   authed for venture A cannot subscribe to venture B's topics even on the same DO mesh.
4. **Continuous revocation (the F4 win).** Sessions are anchored in `UserCoordinatorDO`. "Sign out
   everywhere" / a revoked device pushes a `revoked` frame and **closes every live socket for that
   user instantly** — no waiting for a token to expire. This is the multi-device security guarantee
   F4 exists to deliver.

WebSocket close codes:

| Code | Meaning |
|---|---|
| `1000` | Normal close (client navigated away). |
| `4401` | Unauthenticated (missing/invalid token or expired ticket). |
| `4403` | Forbidden (not the venture owner / topic not authorized). |
| `4408` | Idle timeout with no app-level ping (rare; hibernation usually avoids this). |
| `4429` | Too many connections for this user/venture (connection cap). |
| `4500` | Server/DO error — client should reconnect with backoff. |

## 28.8 Reconnection, replay & cursors

Because `venture_events` is an **append-only log** ([§9.3](./09-domain-model-glossary.md)) keyed by a
monotonic ULID `id` (and a per-venture `seq`), realtime is exactly resumable — this is the single
biggest payoff of "push and replay are the same data."

- **The cursor is the last `id` the client has applied.** The client persists it (the event-source
  abstraction owns this) across reconnects.
- **On reconnect** (SSE `?since=` / WS `subscribe.since`), the server replays every event with
  `id > cursor` in order, marks `replaying: true` in the join frame, then switches to live tail. The
  client applies replayed events **idempotently** (dedupe by `id`), so an overlap window is harmless.
- **Gap detection** uses `seq`: a jump in `seq` without intervening events means the client missed
  some (e.g. it was offline past the replay retention) → it does a one-shot REST page of
  `GET /api/ventures/:id/events?after=<cursor>` ([§27](./27-api-rest.md)) to backfill, then resumes
  the live tail. The log is the safety net the live stream leans on.
- **Retention.** The DO keeps a bounded hot ring (recent N events) for instant replay; anything
  older is replayed from Postgres `venture_events`. Either way the cursor contract is identical — the
  client never knows or cares which tier served the replay.
- **Backoff.** Reconnects use exponential backoff with jitter (1s → 30s cap). While disconnected the
  console shows the **amber `● reconnecting`** state and falls back to REST polling, keeping the
  last-known render — never blank ([§14.11](./14-ux-operator-console.md)).

## 28.9 Subscription / topic model

Channels are **topics** a connection joins; one socket can hold many. Topics are namespaced by the
two scopes ([§28.3](#283-the-two-durable-objects-who-owns-which-channel)):

| Topic | Owner DO | Carries | Typical subscriber |
|---|---|---|---|
| `venture:<id>:events` | `VentureDO` | The full taxonomy firehose ([§28.4](#284-the-event-taxonomy-venture_events)). | Console Activity tab. |
| `venture:<id>:goals` | `VentureDO` | `goal.selected` / `goal.updated` only (board moves). | Console Roadmap board. |
| `venture:<id>:deploys` | `VentureDO` | `deploy.shipped` + deploy status. | Console Deployments panel. |
| `venture:<id>:status` | `VentureDO` | `status.changed`, `budget.alert`, `checkpoint.*`. | Console right rail (always on). |
| `user:<id>:inbox` | `UserCoordinatorDO` | Cross-venture roll-ups: approval counts, budget alerts, latest-activity. | Dashboard + every console (badges). |
| `user:<id>:session` | `UserCoordinatorDO` | `revoked`, device-list/presence changes. | Every authenticated client. |

A console viewing one venture typically holds `venture:<id>:events` + `:status` (+ `:goals`/`:deploys`
when those tabs are visible) **and** `user:<id>:inbox` + `:session`. Over **SSE** the topic set is
fixed by the endpoint (`/ventures/:id/stream` ≈ `:events`), so the console opens **one SSE per scope**
it needs; over **WebSocket** a single socket multiplexes all topics via `subscribe` — another reason
the WS path is the better long-run console transport.

> **Fan-out scope = tenant boundary.** `VentureDO` is the *only* fan-out point for a venture; it
> physically cannot deliver to a socket outside the tenant because no cross-tenant socket is ever
> attached to it ([§28.7](#287-authentication--authorization-on-the-channel)). The topic model is
> the same isolation guarantee as RLS, expressed in the realtime tier.

## 28.10 Backpressure

A burst (a tick that writes many `file.written`/`build.observed` events, or a slow mobile client)
must not let one socket's slowness stall the DO or balloon memory.

- **Per-socket bounded buffer.** Each attached socket has a small outbound queue. The DO tracks
  delivery via client `ack { upto: seq }`.
- **Coalescing over flooding.** High-frequency, low-value updates are **collapsed**: rapid
  `goal.updated` for the same goal coalesce to the latest; per-character build logs are batched per
  ~250ms frame. The taxonomy events ([§28.4](#284-the-event-taxonomy-venture_events)) are already
  coarse (one per phase, not per token), which keeps the firehose human-paced by design.
- **Shed + resume, never silently drop.** If a socket's buffer overflows (client too slow / stalled),
  the DO drops the oldest *non-critical* (`info`) events and sends a `lag { dropped, resume_cursor }`
  frame. The client then **replays from `resume_cursor`** ([§28.8](#288-reconnection-replay--cursors)) —
  so even shed messages are recoverable from the log. `warn`/`error` events
  (`checkpoint.raised`, `budget.alert`, `error`, `status.changed`) are **never shed** — a missed
  approval is a trust failure.
- **DO-side protection.** A misbehaving/zombie socket (no `ack`, no `ping`) is closed (`4408`); its
  buffer is freed. Hibernation means an idle-but-healthy socket costs nothing, so backpressure only
  ever concerns *active bursts*, not idle fleets.

## 28.11 Presence

Presence answers "who else is watching/steering this venture, and on what?" — it matters for
multi-device and (later) multi-operator ventures (Sam's team, [§3.4](./03-personas-jtbd.md)).

- **Source of truth: the DO.** Each connected socket reports `presence { state, view }`; the DO holds
  the live roster and fans `presence` frames to the topic's members. Hibernation-safe: the roster is
  reconstructed from the attached-socket set on wake, so it survives eviction.
- **What the UI shows.** "You're viewing this on 2 devices," and (multi-operator) "Sam is on the
  Approvals tab" — so two people don't both approve the same checkpoint blind. Presence is also how
  the dashboard shows a venture as actively-watched.
- **Disconnect = departure.** A closed socket removes its presence entry immediately (or after a
  short grace for flaky mobile, to avoid flap). No heartbeat-zombie presence.
- **SSE has no presence** — it is one of the things ([§28.5.3](#2853-sse-limits-why-it-is-not-the-final-transport))
  that the WS/DO path adds. Until F4 ships, the console simply omits presence rather than faking it.

## 28.12 ASCII sequence — "console subscribes → live tick stream"

The end-to-end path: a console opens, authenticates, replays from its cursor, then receives a live
tick as the `VentureDO` Alarm fires and the loop writes events. Shown for the **WebSocket/DO target**
(the SSE path is the same minus the bidirectional `subscribe`/`ack`/presence frames).

```
 Browser           Worker (edge)        UserCoordinatorDO     VentureDO            Loop (Workflow)        Postgres
 console            auth gateway         user:<id>             venture:<id>         tick.ts                venture_events
   │                    │                    │                    │                    │                     │
   │ POST /realtime/ticket (auth)            │                    │                    │                     │
   ├───────────────────►│  validate session  │                    │                    │                     │
   │◄───────────────────┤  ticket (60s)      │                    │                    │                     │
   │                    │                    │                    │                    │                     │
   │ WS upgrade /ventures/:id/ws?ticket=…     │                    │                    │                     │
   ├───────────────────►│ redeem ticket · check owner(:id)        │                    │                     │
   │                    │ RPC stub.fetch ─────┼───────────────────►│ acceptWebSocket()  │                     │
   │                    │ (also attaches to user DO for inbox)     │ (Hibernation)      │                     │
   │                    │                    │◄── attach inbox ───┤                    │                     │
   │ {t:subscribe, topics:[events,status], since:<cursor>}         │                    │                     │
   ├──────────────────────────────────────────────────────────►  │ authorize topics   │                     │
   │                    │                    │                    │ replay id>cursor ──┼────────────────────►│ SELECT … > cursor
   │◄── {t:ready, cursor, replaying:true, presence:[…]} ──────────┤                    │◄── rows ────────────┤
   │◄── {t:event, …}  (replayed: file.written, build.observed) ───┤                    │                     │
   │                    │                    │                    │  …live tail begins…│                     │
   │                    │                    │                    │                    │                     │
   │                    │                    │           ⏰ Alarm fires (heartbeat)    │                     │
   │                    │                    │                    ├── start tick 32 ──►│ SENSE→ORIENT→DECIDE  │
   │                    │                    │                    │◄── append events ──┼── tick.started ────►│ INSERT
   │◄── {t:event, kind:"tick.started", seq, …} ──────────────────┤  (write-through    │── goal.selected ───►│ INSERT
   │◄── {t:event, kind:"goal.selected", …} ──────────────────────┤   fan-out)         │── file.written ────►│ INSERT
   │◄── {t:event, kind:"build.observed", severity:"success"} ─────┤                    │── deploy.shipped ──►│ INSERT
   │                    │                    │                    │  ship→prod gate    │── checkpoint.raised►│ INSERT
   │◄── {t:event, kind:"checkpoint.raised", severity:"warn"} ─────┤                    │                     │
   │   (right rail badge +1; aria-live assertive)                 │── notify user DO ─►│ (cross-device)      │
   │◄═══════════════ {t:event} on user:<id>:inbox (badge) ════════┤ fan to ALL devices │                     │
   │                    │                    │                    │                    │                     │
   │ {t:ack, upto:seq}  (backpressure window advances)            │                    │                     │
   ├──────────────────────────────────────────────────────────►  │                    │                     │
   │                    │  …no events… → socket HIBERNATES (DO evicted, $0, WS alive)  │                     │
   │   user approves on phone → REST resolve → checkpoint.resolved fans to THIS device too (converges)        │
```

Key properties the diagram makes concrete: auth happens at the edge before the DO; replay-from-cursor
precedes the live tail (no gap, no dupes after idempotent apply); the **same event** is written to
Postgres *and* fanned to every device (push and replay are one dataset); critical events drive the
right-rail badge and `aria-live` ([§14.13](./14-ux-operator-console.md)); and between ticks the socket
**hibernates at zero cost** while staying open.

## 28.13 Mapping to F4 + A8

| Concern | Where it lands | Status |
|---|---|---|
| SSE `venture_events` stream (`/ventures/:id/stream`), build/token streams | **A8** (console first cut) over the shipped `chat.ts`/`services/sse.ts` pattern | ✅ pattern shipped; ✍️ venture endpoint with A8 |
| `UserCoordinatorDO` (WS Hibernation): sessions, presence, instant revocation, cross-venture inbox | **F4** | 📋 |
| `VentureDO` (WS Hibernation): per-venture firehose, Alarm heartbeat, fan-out | **F4** (real-time) + **A2** (heartbeat) — shared DO+Workflows work ([F-FOUNDATIONS §map](../F-ENTERPRISE-FOUNDATIONS.md)) | 📋 |
| Topic/subscription model, backpressure, presence, reconnection/replay | **F4** | 📋 |
| Channel auth, ticket flow, revocation, close codes | **F3** (identity) + **F4** (revocation) + **F8** (security) | 📋 |
| Console UI bound to the event-source abstraction (SSE→WS swap) | **A8** | ✍️ (§14.11) |

The throughline: **A8 ships the console on SSE now; F4 upgrades the transport to WebSocket-over-DO
without changing the message schema.** The event taxonomy ([§28.4](#284-the-event-taxonomy-venture_events))
is the stable contract both tiers, the REST [event log](./27-api-rest.md), and the audit view
([§14.8](./14-ux-operator-console.md)) all share — push, replay, and audit are the same `venture_events`
data, viewed three ways.

## 28.14 Acceptance criteria

- A client can open the SSE stream `GET /api/ventures/:id/stream` with the **exact framing shipped in
  `chat.ts`** (`event:`/`data:` blocks, 15s `: keep-alive` comment heartbeat, `X-Accel-Buffering: no`),
  parsed by the existing `services/sse.ts`, and receive `venture_events` live.
- Every realtime message conforms to the [§28.4.1](#2841-the-envelope) envelope; every `kind` in
  [§28.4.2](#2842-the-kinds) has a defined `data` schema; secrets never appear in any payload.
- Reconnection with a `since` cursor replays missed events in order, idempotently (dedupe by `id`),
  with `seq` gap-detection falling back to a REST backfill page — no missed or duplicated events.
- The WebSocket/DO path carries the **identical** event JSON, adds bidirectional
  `subscribe`/`ack`/`presence`/`cursor` frames, and multiplexes topics on one socket.
- Channel auth rejects unauthenticated (`4401`) and cross-tenant (`4403`) connections at the edge;
  tokens never ride the URL; "sign out everywhere" closes every live socket instantly via
  `UserCoordinatorDO`.
- Multi-device convergence holds: resolving a checkpoint on one device updates every other device in
  place ([§14.5](./14-ux-operator-console.md)) via the `user:<id>` fan-out.
- Backpressure sheds only `info` events and only with a `lag`+`resume_cursor` so they remain
  recoverable; `warn`/`error` events are never shed; idle sockets hibernate at zero cost.
- The console UI is written against one event-source abstraction so SSE→WebSocket is a transport swap,
  not a rewrite.
