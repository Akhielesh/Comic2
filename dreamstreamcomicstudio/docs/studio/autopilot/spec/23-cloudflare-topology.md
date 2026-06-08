# 23 — Cloudflare Platform Topology (Deep)

> Part III · Architecture · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Architecture (Cloudflare)](../ARCHITECTURE-CLOUDFLARE.md) (this section is its **deep
> expansion**) · [Master Plan](../00-MASTER-PLAN.md) (§4 target architecture, Epics A2/A4/A5) ·
> [System Architecture Overview](./22-system-architecture.md) ·
> [F-Enterprise Foundations](../F-ENTERPRISE-FOUNDATIONS.md) (F3/F4)

## 23.1 Scope, stance & how to read this section

[`ARCHITECTURE-CLOUDFLARE.md`](../ARCHITECTURE-CLOUDFLARE.md) answered the *strategic* question
— "is Cloudflare the right core, and which primitives do we actually need?" — and concluded:
go from **Workers + Containers** (≈40% of the right primitives, what the repo uses today) to the
full **Workers + Durable Objects + Workflows + Containers** stack, with Supabase kept as the
portable system-of-record. This section is the *engineering* answer: the exact object design,
storage schemas, naming/sharding, consistency model, lifecycle, config, and the migration path
off Railway + BullMQ — at the level a team could build from.

**House rules for this section.** Every numeric limit cited is **verified against Cloudflare
documentation as of 2026-06** and tagged `[verified 2026-06]`; anything we are choosing rather
than quoting is tagged `[design]`; anything not yet built is called out as planned, not shipped.
The only Cloudflare code in the repo today is `studio-worker/` (172 lines, `@cloudflare/sandbox`
0.4.18, `standard-3` containers, `max_instances: 50`) — so **everything in §23.2–23.4 is a
target design, not current state.** We say so each time it matters.

```
            ┌──────────────────────────── SHIPPED TODAY ─────────────────────────────┐
            │  studio-worker/ : Worker → Sandbox DO → Container (Sandbox SDK).         │
            │  HMAC control plane from Railway. exposePort → *.dreamstreamstudio.ai.   │
            └─────────────────────────────────────────────────────────────────────────┘
                         │  this section extends this one box into the full topology
                         ▼
            ┌──────────────────────────── TARGET TOPOLOGY (§23) ──────────────────────┐
            │  Workers (edge)  +  Durable Objects (coordinate)  +  Workflows (durable  │
            │  build pipelines)  +  Containers (execute)  +  KV/R2/D1/Queues/Hyperdrive│
            │  +  Supabase (system-of-record)  +  Railway (API, during transition)     │
            └─────────────────────────────────────────────────────────────────────────┘
```

### 23.1.1 The whole topology on one page

```
   Client (React · any device)
      │  HTTPS  +  WebSocket  (cookie/JWT)
      ▼
 ┌───────────────────────────────── WORKERS (edge tier) ──────────────────────────────────┐
 │  api-gateway      auth verify · rate-limit · CORS · route → API / DO RPC                 │
 │  preview-router   *.dreamstreamstudio.ai → proxyToSandbox (managed previews)             │
 │  ws-upgrade       Upgrade: websocket → route to the owning Durable Object                │
 └───────┬───────────────────────────────┬───────────────────────────────┬────────────────┘
         │ RPC                            │ RPC / Alarm                    │ proxy
         ▼                                ▼                                ▼
 ┌─────────────────────┐     ┌──────────────────────────────┐     ┌────────────────────────┐
 │ UserCoordinatorDO   │     │ VentureDO  (one per venture)  │     │ Containers (Sandbox SDK)│
 │ (one per user)      │     │  Alarm-driven tick heartbeat  │     │ per (user,project):     │
 │  device sessions    │     │  per-venture isolation +      │     │  npm i · dev server ·   │
 │  presence           │     │  concurrency control          │     │  exec/logs · exposePort │
 │  instant revocation │     │  activity-stream fan-out (WS) │     │  warm pool for cold-start│
 │  multi-device sync   │◄───┤  starts/monitors Workflows    │     └───────────┬────────────┘
 │  WS Hibernation     │     └───────────────┬──────────────┘                 │ exec
 └─────────┬───────────┘                     │ create/observe                 │
           │ push                            ▼                                 │
           │                  ┌──────────────────────────────┐                │
           │                  │ Workflows (durable execution) │  step.run ─────┘
           │                  │ one instance per build goal:  │
           │                  │ plan→write→run→observe→fix→   │
           │                  │ verify→ship (retry · sleep ·  │
           │                  │ state-persisted · resumable)  │
           │                  └───────────────┬──────────────┘
           ▼                                  │ read/write
 ┌────────────────────────────────────────────▼───────────────────────────────────────────┐
 │ Supabase Postgres (system-of-record + RLS)  ·  Hyperdrive (pooled CF→Supabase)           │
 │ R2 (artifacts/blobs/build logs)  ·  KV (edge cache/flags)  ·  D1 (optional edge mirror)  │
 │ Queues (fan-out: signals, deploys, notifications)                                        │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
```

This diagram is the spine of the section; §23.2–23.6 expand each box, §23.7 is the migration to
reach it, §23.8 is the limits/caveats ledger.

---

## 23.2 Durable Objects — the coordination tier

A Durable Object (DO) is a single, globally-addressable, single-threaded actor with **private,
strongly-consistent, transactional storage co-located with its compute** (SQLite backend, **10
GB per object, GA** `[verified 2026-06]`). It is the only Cloudflare primitive that gives us a
*single point of coordination* per logical entity — which is precisely what "one authoritative
coordinator per user" and "one isolated owner per venture" require. We define exactly two DO
classes. Resisting a third is itself a design rule: more classes means more cross-object
consistency problems, and DOs are deliberately the place where we *avoid* distributed state.

| DO class | One instance per | Owns | Replaces |
|---|---|---|---|
| `UserCoordinatorDO` | user (`auth.uid()`) | device sessions, presence, revocation, multi-device sync | SSE/poll session state (F3/F4) |
| `VentureDO` | venture (`venture_id`) | tick heartbeat (Alarm), isolation, concurrency, activity fan-out | Railway BullMQ scheduler (A2) |

> **Note on `Sandbox`.** `studio-worker/` already exports a third DO class — `Sandbox` from
> `@cloudflare/sandbox`. That is the *container control* DO, owned by the SDK, not an
> application-coordination DO. It lives in its own Worker (§23.4) and is unchanged by this design.

### 23.2.1 `UserCoordinatorDO` — sessions, presence, revocation, multi-device sync

**The problem it fixes.** The owner reported "multiple session IDs / multi-device sign-ins /
no clean revocation" (F3/F4). Today identity lives in Supabase and the client polls / holds an
SSE stream; there is no *authoritative live coordinator* per user, so a sign-out on one device
does not instantly kill another, and two devices can drift. `UserCoordinatorDO` is that
coordinator: **one object per user**, holding the live set of devices over hibernating
WebSockets, so revocation and state changes fan out to every device in one hop.

**Responsibilities (and the deliberate non-responsibilities).**
- **Device session registry** — every active `(device, session)` with its WebSocket, last-seen,
  and a server-issued `session_epoch`.
- **Presence** — which devices are online, what each is viewing (which venture/surface), pushed
  to the Operator Console (§14) for "you're also signed in on iPhone, viewing Acme Booking."
- **Instant revocation** — on sign-out / "sign out everywhere" / suspected compromise, bump the
  user's `session_epoch`, close every socket, and reject reconnects with a stale epoch. This is
  *push*, not poll — sub-second across devices `[design]`.
- **Multi-device sync** — a small last-writer-wins broadcast bus for cross-device UI state
  (active venture, draft intake, theme), so devices converge without a Supabase round-trip.
- **Not** authentication (Supabase issues credentials), **not** authorization (RLS in Postgres),
  **not** durable record-of-truth (Supabase). The DO is a *live cache + coordination point*; the
  durable truth of "is this session revoked?" is mirrored to Supabase so a cold DO rebuilds
  correctly. The DO is authoritative for *liveness*, Postgres for *record*.

**Storage schema** (SQLite-backed; the DO is keyed by `userId`, so no `user_id` column needed):

```sql
-- UserCoordinatorDO private storage (per user)
CREATE TABLE sessions (
  session_id   TEXT PRIMARY KEY,   -- opaque, == Supabase session/JWT jti
  device_id    TEXT NOT NULL,      -- stable per browser/app install
  device_label TEXT,               -- "Chrome · macOS", "iPhone"
  epoch        INTEGER NOT NULL,   -- session_epoch at issue; < current ⇒ revoked
  created_at   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  ip_hash      TEXT,               -- hashed, for anomaly detection (A9)
  ua_hash      TEXT
);
CREATE TABLE presence (
  device_id    TEXT PRIMARY KEY,
  online       INTEGER NOT NULL,   -- 0/1
  viewing      TEXT,               -- venture_id|surface the device is on
  updated_at   INTEGER NOT NULL
);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);  -- e.g. ('session_epoch','7')
-- WebSocket↔session mapping is held in attachments (serializeAttachment), not a table.
```

**WebSocket Hibernation.** Long-lived per-device sockets would normally bill for wall-clock
idle time. The **Hibernation API** lets the DO evict from memory while keeping sockets open, so
**we are not billed during idle** `[verified 2026-06]` — essential when most devices sit idle on
the console for hours. The pattern:

```ts
// UserCoordinatorDO (sketch — TARGET, not in repo today)
export class UserCoordinatorDO extends DurableObject {
  async fetch(req: Request) {
    if (req.headers.get('Upgrade') === 'websocket') {
      const { 0: client, 1: server } = new WebSocketPair();
      // Hibernation: accept on ctx so the runtime can evict us while the socket stays open.
      this.ctx.acceptWebSocket(server, ['user']);
      const { sessionId, deviceId } = await this.authFromQuery(req); // verified upstream by gateway
      server.serializeAttachment({ sessionId, deviceId });
      this.sql.exec('INSERT OR REPLACE INTO presence VALUES (?,1,?,?)', deviceId, null, Date.now());
      return new Response(null, { status: 101, webSocket: client });
    }
    // RPC paths: registerSession / revokeAll / pushState / listDevices
  }
  // Called by the runtime on each frame WITHOUT keeping us resident between frames.
  async webSocketMessage(ws: WebSocket, msg: string) { /* sync bus + heartbeat */ }
  async webSocketClose(ws: WebSocket) {
    const { deviceId } = ws.deserializeAttachment();
    this.sql.exec('UPDATE presence SET online=0, updated_at=? WHERE device_id=?', Date.now(), deviceId);
  }
  async revokeAll() {                       // "sign out everywhere"
    const next = this.bumpEpoch();          // meta.session_epoch++
    await this.persistEpochToSupabase(next);
    for (const ws of this.ctx.getWebSockets()) ws.close(4001, 'revoked');
  }
}
```

**Alarms.** A periodic Alarm (e.g. every 5 min `[design]`) reaps sessions idle past TTL, flushes
`last_seen` to Supabase, and emits a presence heartbeat. Alarms are the DO's built-in scheduler:
no cron runner to operate `[verified 2026-06]`.

### 23.2.2 `VentureDO` — heartbeat, isolation, concurrency, activity fan-out

**The problem it fixes.** Master Plan §4 needs an always-on per-venture loop that is crash-safe,
isolated, and rate-limited — without an always-on server. The Master Plan's *first* sketch (A2)
puts this in a Railway BullMQ scheduler; this section is the **Cloudflare-native target** that
replaces it (the migration in §23.7 is exactly that swap, behind an interface). One `VentureDO`
per venture is the unit of isolation and the heartbeat.

**Responsibilities.**
- **Heartbeat tick scheduler (Alarm-driven).** The DO sets an Alarm for the next tick. On wake it
  asks the *deterministic* DECIDE gate (budget? checkpoint? kill switch? scope?) and, if clear,
  **starts or resumes a Workflow** (§23.3) to do the actual work, then schedules the next Alarm.
  The DO does **no heavy compute** — it is a single-threaded coordinator; the build runs in a
  Workflow that drives Containers. This is the literal embodiment of the canon line *"always-on
  emerges from DO Alarms + Workflows + Containers, not from a box running BullMQ."*
- **Isolation.** Each venture's coordination state, concurrency counters, and live stream are in
  *its own object* — no shared scheduler memory, no cross-venture interference (the in-memory caps
  the repo uses today are global and a single point of contention).
- **Concurrency control.** The single-threaded nature *is* the lock: the DO holds the
  authoritative "is a Workflow already running for this venture?" flag, enforcing **at most one
  active build per venture** `[design]` plus a per-venture max-ticks/run and wall-clock-per-tick
  guard (Master Plan §8 brakes), with no distributed lock service.
- **Activity-stream fan-out.** The DO accepts hibernating WebSockets from every observer of the
  venture (Operator Console, mobile) and fans out `venture_events` (tick start, ORIENT decision,
  build progress, deploy, checkpoint raised) to all of them in real time — the live "watch the
  agent work" surface (§14). Events are also appended to Supabase for durability/audit.

**Storage schema** (keyed by `venture_id`):

```sql
-- VentureDO private storage (per venture)
CREATE TABLE state (
  k TEXT PRIMARY KEY, v TEXT       -- 'status'(active|paused|killed), 'pause_reason',
);                                 -- 'current_run_id', 'current_workflow_id',
                                   -- 'tick_seq', 'last_tick_at', 'scope_hash'
CREATE TABLE run_window (          -- rolling per-run counters for the brakes
  run_id        TEXT PRIMARY KEY,
  ticks         INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  budget_state  TEXT NOT NULL,     -- ok | warn | breached (mirrors venture_budgets)
  noprogress    INTEGER NOT NULL   -- consecutive no-progress ticks → checkpoint
);
CREATE TABLE recent_events (       -- ring buffer for instant replay on (re)connect
  seq        INTEGER PRIMARY KEY,  -- monotonic; durable truth is Supabase venture_events
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,        -- JSON; keep small (see storage budget §23.2.5)
  at         INTEGER NOT NULL
);
```

**Tick lifecycle (Alarm → DECIDE → Workflow):**

```
 alarm() fires
   │
   ├─ load state; if status≠active OR kill switch set ─────────────► return (no reschedule)
   │
   ├─ DECIDE gate (deterministic, no LLM):
   │     budget ok? · checkpoint pending? · within scope? · under max-ticks/run? · concurrency free?
   │        │ blocked → write pause_reason, fan-out event, (no reschedule until unblocked)
   │        ▼ clear
   ├─ if no current_workflow_id: env.BUILD_WORKFLOW.create({ id, venture_id, goal })  ──► §23.3
   │     store current_workflow_id; fan-out "tick:start"
   │
   ├─ else: poll workflow status; fan-out progress; on terminal → REFLECT (update goal, clear id)
   │
   └─ schedule next: this.ctx.storage.setAlarm(now + tickInterval)   // self-perpetuating heartbeat
```

**Lifecycle.** A `VentureDO` is created on first access (when a venture is approved/activated),
runs until paused (budget/kill/checkpoint/stuck) at which point it stops setting Alarms and goes
idle (no cost), and is reactivated by an RPC from the control plane (resume/redirect) which sets
the next Alarm. Killing a venture sets `status='killed'`, closes sockets, and lets the object
hibernate; storage persists for audit until the venture is deleted (then we `deleteAll()`).

### 23.2.3 Naming & sharding

DO ids are derived deterministically with `idFromName(...)`, so any Worker can address the right
object without a lookup. `[design]`

| DO | id derivation | Example | Notes |
|---|---|---|---|
| `UserCoordinatorDO` | `idFromName("user:" + userId)` | `user:8b3f…` | one per Supabase `auth.uid()` |
| `VentureDO` | `idFromName("venture:" + ventureId)` | `venture:0c9a…` | one per `ventures.id` |
| `Sandbox` (SDK) | `getSandbox(env.Sandbox, "u_<userId>_<projectId>")` | `u_8b3f_proj42` | unchanged from `studio-worker/` |

**Sharding stance.** We deliberately **shard by entity, not by hot-key splitting.** A user/venture
is naturally low-throughput (a human, a heartbeat) so a single object per entity never becomes a
hotspot — the classic DO anti-pattern (one global object as a bottleneck) is avoided by
construction. If a *single* venture ever needed parallel builds (it does not in the MVP — one
active build per venture by design), we would shard sub-work into child Workflows, **not** split
the `VentureDO`, keeping coordination authoritative in one place. We pin DO ids by name (not
`newUniqueId`) so reconnects and the control plane always resolve the same object; locality
follows first access (no jurisdiction constraint needed since the system-of-record is Supabase).

### 23.2.4 Consistency model

- **Within one DO:** strong, serializable. Single-threaded execution + transactional SQLite means
  no in-object races; storage writes in a handler commit atomically `[verified 2026-06]`.
- **Across DOs:** there is no cross-object transaction. We never require one. `UserCoordinatorDO`
  and `VentureDO` own disjoint state; the only shared truth is Supabase, reached via idempotent
  writes (see §23.3.3). When the DO and Postgres must agree (revocation epoch, venture status),
  **Postgres is the durable record and the DO is the live mirror**: the DO writes Postgres first
  for irreversible facts (revocation, status changes), then updates itself, so a cold rebuild from
  Postgres is always correct. Live-only state (presence, the event ring buffer) is allowed to be
  lossy on a cold start — it is reconstructed from sockets reconnecting and from `venture_events`.
- **Read-your-writes** holds for any client routed to the same DO (which the naming scheme
  guarantees). Cross-device sync is **eventually consistent** with last-writer-wins on the small
  UI-state bus — acceptable for "active venture / theme," never used for money or auth decisions.

### 23.2.5 Storage limits + mitigation

| Concern | Limit `[verified 2026-06]` | Our mitigation `[design]` |
|---|---|---|
| Per-object storage | **10 GB** SQLite (GA) | Coordination state is KB–MB. Hard ceiling: never store build artifacts/files/logs in a DO — those go to R2/Supabase. |
| Event history growth | grows unbounded if appended forever | `recent_events` is a **ring buffer (≈last 500 events)**; durable history is `venture_events` in Postgres. Alarm trims the ring. |
| Session/device rows | bounded by real devices per user | TTL-reap via Alarm; cap sessions/user (e.g. 50) and evict oldest. |
| Single-thread throughput | one request at a time per object | Keep handlers tiny (no LLM, no `npm i` in a DO); offload all work to Workflows/Containers; batch storage writes. |
| Storage is **billed** (since Jan 2026) | per-GB SQLite storage charged on Paid | Small-by-design footprint keeps DO storage a rounding error vs container/LLM cost. |
| Hibernation in-memory loss | in-memory state cleared on hibernate | Persist anything needed later to SQLite before returning; rebuild caches lazily on wake `[verified 2026-06]`. |

---

## 23.3 Workflows — the durable build pipeline

A **Workflow** is durable execution: a function decomposed into `step.do(...)` units whose
outputs are **persisted**, that **retries failed steps automatically**, can **`sleep`** for
seconds to weeks, and **resumes exactly where it left off after a crash, deploy, or restart**.
This is the reliability layer the current one-shot build loop lacks: today a process restart
loses an in-flight build; a Workflow does not.

### 23.3.1 Modeling the build pipeline as steps

Each **build goal** (Master Plan: a `venture_goal`) becomes **one Workflow instance**. The seven
durable steps map directly onto the existing Phase-4 build loop and the Master Plan tick
(plan→write→run→observe→fix→verify→ship), but now each is checkpointed and independently
retryable:

```
 BuildGoalWorkflow(instanceId = "goal:<ventureId>:<goalId>:<attempt>")
   │
   1 plan     step.do("plan")     → LLM decomposes the goal (reuse studioPlan/orchestrator).      retry:3
   2 write    step.do("write")    → generate/modify files (studioGenerate) → new studio_version.   retry:3
   3 run      step.do("run")      → Container: npm i + dev server (Sandbox SDK, §23.4).            retry:2
   4 observe  step.do("observe")  → read logs/health (verifyApp/observation).                      retry:3
   5 fix      step.do("fix")      → if broken: studioFix, minimal-diff (buildGuards iter cap).     loop≤N
   6 verify   step.do("verify")   → typecheck/build/tests + A9 secret/danger scan. NonRetryable on unsafe.
   7 ship     step.do("ship")     → deploy adapter (A5). PROD ⇒ step.waitForEvent (checkpoint gate).
   │
   └─ on success: emit "goal:done" → VentureDO REFLECT updates the goal + cost.
```

- **`fix` loop with a hard cap.** Steps 4↔5 iterate up to N (reuse `buildGuards.ts`); on exceeding
  N the Workflow throws `NonRetryableError` which the `VentureDO` turns into a *no-progress
  checkpoint* rather than burning budget — the Master Plan "stuck detector," now durable.
- **`ship` waits, durably.** A production deploy step parks on `step.waitForEvent(...)` (or
  `sleep` + re-poll) until the human approves the checkpoint in the console (§14/§16). The Workflow
  **costs nothing while parked** and survives any restart — far better than a BullMQ job holding a
  worker slot for hours.
- **Sub-steps via child Workflows.** A large goal that the swarm decomposes can spawn child
  Workflows per sub-feature; the parent fans-in. We prefer steps over children until a goal truly
  needs parallelism, to keep state simple.

### 23.3.2 Retries, sleep, state persistence

```ts
// Verified default step retry policy [verified 2026-06]:
const defaultConfig = { retries: { limit: 5, delay: 10_000, backoff: 'exponential' }, timeout: '10 minutes' };

// Per-step override example (the long, flaky container step):
const run = await step.do('run',
  { retries: { limit: 2, delay: '30 seconds', backoff: 'linear' }, timeout: '8 minutes' },
  async () => sandboxLaunch(ctx));         // returns previewUrl + process ids

// Durable pause for a human checkpoint on prod ship:
await step.sleep('await prod approval poll', '30 seconds');   // sleep does NOT count to step limit
// or, preferred: const ev = await step.waitForEvent('prod-approval', { type: 'checkpoint' });
```

- **Each `step.do` output is persisted**; on retry/resume, already-completed steps are *not*
  re-run — they replay their stored result. This is why **steps must be idempotent** (§23.3.3).
- **Retry knobs:** per-step `limit` (up to **10,000** retries/step), `delay`, `backoff`
  (`constant|linear|exponential`), and per-attempt `timeout`; `NonRetryableError` short-circuits
  for unrecoverable cases (e.g. a failed safety scan) `[verified 2026-06]`.
- **`sleep`/`sleepUntil`** for relative or absolute waits; **sleep steps don't count toward the
  step limit** and incur no compute while sleeping `[verified 2026-06]`.
- **Persisted state per instance:** **1 GB on Workers Paid** (100 MB Free); each step output is
  capped at **1 MiB** unless returned as a `ReadableStream` (use streams for large build logs →
  R2) `[verified 2026-06]`. We keep step outputs tiny: **return pointers (R2 keys, version ids),
  not blobs.**

### 23.3.3 Idempotency

Because any step can replay, every side-effecting step must be safe to run more than once:

| Step | Idempotency strategy `[design]` |
|---|---|
| write | Write to a deterministic `studio_version` keyed by `(goalId, attempt, stepHash)`; upsert, don't blind-insert. |
| run | `getSandbox(..., "u_<user>_<project>")` is addressable + deterministic; re-launch is a no-op if the dev process already runs (check `listProcesses`). |
| ship | Deploy with an idempotency key = `instanceId + version`; the adapter returns the existing deployment if the key was seen (record in `studio_deployments`). |
| events | `venture_events` rows carry `(instanceId, step)` unique key → upsert; a replayed REFLECT does not double-count cost. |

Cost metering is attached at **REFLECT in the `VentureDO`, keyed by step+instance**, so a Workflow
retry never bills twice.

### 23.3.4 How a VentureDO Alarm starts a Workflow

This is the seam between §23.2 and §23.3 — the literal "always-on without a server":

```
VentureDO.alarm()  ──DECIDE ok──►  env.BUILD_WORKFLOW.create({
                                      id: `goal:${ventureId}:${goalId}:${attempt}`,   // idempotent id
                                      params: { ventureId, goalId, scopeHash, budgetSnapshot }
                                   })
        │  store current_workflow_id; fan-out "tick:start" to observers (WS)
        ▼
   ...later alarms...  poll  env.BUILD_WORKFLOW.get(id).status()  →  fan-out progress
        │
        └─ terminal(complete|errored)  →  REFLECT: update venture_goal, append venture_events,
                                           meter cost, clear current_workflow_id, set next alarm
```

The **DO is the scheduler/observer**; the **Workflow is the durable worker**; the **Container is
the muscle**. None of them is an always-on box, and each layer fails safe: a dead Worker doesn't
stop a Workflow; a restarted Workflow resumes; a paused venture stops setting Alarms and costs
nothing.

---

## 23.4 Containers — the execution muscle

Containers are where generated code actually runs: `npm install`, a dev server, builds, tests,
`exec`/logs, and `exposePort` for previews. This is the **only tier shipped today** —
`studio-worker/` drives it via the `@cloudflare/sandbox` SDK (a Worker → `Sandbox` DO →
Container), HMAC-controlled from Railway, with previews on `*.dreamstreamstudio.ai` via
`proxyToSandbox`. The target design keeps that pattern and adds scale + warm-pool + per-tenant
discipline.

### 23.4.1 Sandbox SDK usage (current pattern, kept)

The control flow is exactly `studio-worker/src/index.ts`: `getSandbox(env.Sandbox, sandboxId)`
→ `writeFile` the project → `exec('npm install')` → `startProcess('npm run dev')` →
`exposePort(port, { hostname })` → return the preview URL. The Workflow `run` step calls this
(over RPC/HTTP to the studio Worker) instead of Railway calling it directly. **No rewrite of the
container layer is required** — it is consumed, not rebuilt.

### 23.4.2 Instance types

Custom sizes are GA (since 2026-01); presets up to `standard-4`. `studio-worker/` uses
`standard-3` today.

| Type | vCPU | Memory | Disk | Our use `[design]` |
|---|---|---|---|---|
| lite (`dev`) | 1/16 | 256 MiB | 2 GB | warm-pool probes / trivial scripts |
| basic | 1/4 | 1 GiB | 4 GB | static/landing builds |
| standard-1 (`standard`) | 1/2 | 4 GiB | 8 GB | small SPA dev server |
| standard-2 | 1 | 6 GiB | 12 GB | **default** for typical SaaS builds |
| standard-3 | 2 | 8 GiB | 16 GB | current `studio-worker/` default; heavy `npm i` |
| standard-4 | 4 | 12 GiB | 20 GB | monorepo / test-heavy goals |
| custom | up to standard-4 ceilings | — | tune mem/CPU/disk per workload |

### 23.4.3 Concurrency ceilings & build-farm math

**Account ceiling raised 15× on 2026-02-25: 6 TiB memory, 1,500 vCPU, 30 TB disk**
`[verified 2026-06]`. That bounds how many simultaneous sandboxes fit:

```
 1,500 vCPU / 1 vCPU  (standard-2)  ≈ 1,500 concurrent standard-2 builds   (memory: 6 TiB/6 GiB ≈ 1,024)
 1,500 vCPU / (1/4)   (basic)       ≈ 6,000 concurrent basic builds
 binding limit today: studio-worker max_instances = 50  →  raise per tenancy plan
```

So the *memory* dimension (≈1,024 `standard-2`) is the tighter bound for our default size — real
multi-tenant build-farm scale, but **finite**, which is why §23.4.4 adds a warm pool and §23.4.5
adds per-tenant ceilings. We will set `max_instances` on the binding well above 50 and gate total
concurrency at the application layer (global concurrency cap, Master Plan §8) so we never wedge
the account.

### 23.4.4 Warm-pool strategy (cold-start mitigation)

Containers **cold-start and sleep when idle** — fine for batch builds, bad for "click → instant
preview." `[verified 2026-06]` Mitigation `[design]`:

- Keep a small pool of **pre-warmed, generic `standard-2` sandboxes** (image pre-pulled, Node
  ready) reserved per region; a new interactive build is *assigned* a warm sandbox, then
  re-personalized with the tenant's files, instead of cold-booting.
- Pool size is demand-driven (e.g. keep N≈ peak-concurrent-interactive × 0.2 warm `[design]`),
  refilled by a `VentureDO`/scheduler Alarm or a Queue consumer.
- **Autonomous (non-interactive) builds skip the pool** — they tolerate cold start, so we don't
  pay to keep them warm. Warm capacity is spent only where a human is waiting.
- Idle warm instances are reaped after a TTL so the pool doesn't burn the concurrency ceiling.

### 23.4.5 Per-tenant naming, isolation & lifecycle

- **Naming (unchanged):** `u_<userId>_<projectId>` — one sandbox per `(user, project)`, exactly as
  `studio-worker/` and Master Plan §5.2 require. This *is* the tenant isolation boundary: generated
  code only ever runs in the per-tenant sandbox, never in a Worker/DO/Workflow process.
- **Concurrency per tenant:** the `VentureDO` enforces one active build per venture; a global cap
  bounds the account. A noisy tenant cannot starve others past its slice.
- **Lifecycle:** launch → run dev server (tracked process id `'dev'`, as today) → expose port →
  serve previews via `proxyToSandbox` → `stop()` on goal completion or idle TTL. Disk/CPU/mem are
  bounded by the instance type; a per-tick wall-clock cap (Master Plan §8) stops runaways.

---

## 23.5 Workers — the edge tier (and the supporting services)

Workers handle requests, not the brain (≤**5 min CPU per request** `[verified 2026-06]`; for
long work Cloudflare itself points to Workflows/Queues — which is exactly our split). We run a
small set of edge roles, each a thin router that delegates to a DO, a Workflow, or Supabase.

| Worker role | Job | Delegates to |
|---|---|---|
| **auth gateway** | verify Supabase JWT/cookie, rate-limit, CORS, attach `userId`/`ventureId`, reject stale `session_epoch` | `UserCoordinatorDO` (revocation check), then API |
| **API routing** | `/api/ventures/*` REST → control plane | Railway API (transition) → DO RPC (target) |
| **preview host routing** | `*.dreamstreamstudio.ai` inbound → the right container | `proxyToSandbox` (as `studio-worker/` does today) |
| **WS upgrade** | `Upgrade: websocket` → route to owning DO | `UserCoordinatorDO` / `VentureDO` |

Edge-role separation matters: the **preview wildcard route stays decoupled** from the control
endpoint (the apex `dreamstreamstudio.ai` stays free for the marketing site), precisely as the
current `wrangler.jsonc` comment documents — we keep that discipline.

### 23.5.1 Supporting services

| Service | Role in Autopilot `[design unless noted]` | Why this and not a DO/Postgres |
|---|---|---|
| **KV** | edge cache for hot, rarely-changing reads: feature flags (`VENTURES_ENABLED`/`VENTURES_KILL`), public preview routing hints, plan entitlements | eventually-consistent, read-heavy, global; not for truth |
| **R2** | build artifacts, bundles, large logs, downloadable exports; the target of streamed Workflow step outputs | object blobs don't belong in DO/Postgres; egress-free to Workers |
| **D1** (optional) | optional edge-local read mirror of low-sensitivity venture metadata for fast global reads | only if Hyperdrive latency to Supabase ever bites; **not** a second system-of-record |
| **Queues** | fan-out / decoupling: inbound signals (A6), deploy jobs, notifications, warm-pool refills | smooths bursts; gives at-least-once delivery into Workflows |
| **Hyperdrive** | connection **pooling + edge caching for Postgres** so Workers/Workflows can talk to **Supabase** without exhausting connections | Workers are massively concurrent; raw PG connections would exhaust Supabase |
| **Supabase** (kept) | **system-of-record**: auth, all `ventures`/`venture_*` + `studio_*` tables, **RLS owner-isolation** | portable, the anti-lock-in anchor; DOs mirror, never replace it |
| **Railway** (transition) | current Express API + BullMQ; retired piece-by-piece as DO/Workflows prove out | de-risks a big-bang migration (§23.7) |

**Hyperdrive is the load-bearing bridge:** DOs and Workflows are the *coordination/durability*
tiers, but the *durable record* stays in Supabase Postgres, and Hyperdrive is how the edge reaches
it at scale without connection exhaustion. This is what lets us adopt Cloudflare's primitives
**without** giving up Supabase as the portable source of truth (the explicit anti-vendor-lock
stance from the canon).

---

## 23.6 `wrangler` configuration sketch & bindings

A target single-service config that adds DOs, Workflows, and supporting bindings to the existing
container Worker. This is illustrative `[design]`; today's shipped `studio-worker/wrangler.jsonc`
contains only the `Sandbox` container + DO + the preview route.

```jsonc
{
  "name": "dreamstream-autopilot",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "compatibility_flags": ["nodejs_compat"],

  // ── Containers (Sandbox SDK) — extends today's studio-worker block ──
  "containers": [
    { "class_name": "Sandbox", "image": "./Dockerfile", "instance_type": "standard-2", "max_instances": 1000 }
  ],

  // ── Durable Objects: the two coordination classes + the SDK's Sandbox ──
  "durable_objects": { "bindings": [
    { "name": "Sandbox",          "class_name": "Sandbox" },                  // container control (SDK)
    { "name": "USER_COORDINATOR", "class_name": "UserCoordinatorDO" },
    { "name": "VENTURE",          "class_name": "VentureDO" }
  ]},
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["Sandbox"] },                       // already shipped
    { "tag": "v2", "new_sqlite_classes": ["UserCoordinatorDO", "VentureDO"] } // adds coordination DOs
  ],

  // ── Workflows: the durable build pipeline ──
  "workflows": [
    { "name": "build-goal", "binding": "BUILD_WORKFLOW", "class_name": "BuildGoalWorkflow",
      "limits": { "steps": 25000 } }                                          // [verified 2026-06] max
  ],

  // ── Supporting bindings ──
  "kv_namespaces": [ { "binding": "CACHE", "id": "<kv-id>" } ],
  "r2_buckets":    [ { "binding": "ARTIFACTS", "bucket_name": "autopilot-artifacts" } ],
  "queues": {
    "producers": [ { "binding": "SIGNALS", "queue": "venture-signals" } ],
    "consumers": [ { "queue": "venture-signals", "max_batch_size": 25 } ]
  },
  "hyperdrive": [ { "binding": "PG", "id": "<hyperdrive-id-to-supabase>" } ],
  // "d1_databases": [ { "binding": "EDGE", "database_id": "<optional-edge-mirror>" } ],

  // ── Vars / routes (preview wildcard stays decoupled from the apex, as today) ──
  "vars":   { "STUDIO_PREVIEW_DOMAIN": "dreamstreamstudio.ai", "VENTURES_ENABLED": "false" },
  "routes": [ { "pattern": "*.dreamstreamstudio.ai/*", "zone_name": "dreamstreamstudio.ai" } ]
  // secrets (wrangler secret put): STUDIO_HMAC_SECRET, SUPABASE_SERVICE_ROLE, model keys.
}
```

**Binding cheat-sheet** (what each handler reaches for):

| Binding | Type | Used by | For |
|---|---|---|---|
| `Sandbox` | Container/DO | Workflow `run` step | launch/exec/expose container |
| `USER_COORDINATOR` | DO | auth gateway, WS upgrade | sessions, presence, revocation |
| `VENTURE` | DO | scheduler, WS upgrade, control plane | heartbeat, isolation, fan-out |
| `BUILD_WORKFLOW` | Workflow | `VentureDO.alarm()` | durable build pipeline |
| `CACHE` | KV | auth gateway, routers | flags, hot reads |
| `ARTIFACTS` | R2 | Workflow `write`/`ship` | bundles, logs |
| `SIGNALS` | Queue | A6 signal ingest | fan-out to Workflows |
| `PG` | Hyperdrive | Workflows, control plane | pooled Supabase Postgres |

---

## 23.7 Migration plan — Railway + BullMQ → DO + Workflows, behind an interface

The Master Plan A2 deliberately first builds the scheduler as **Railway BullMQ** *behind an
interface* — precisely so it can be swapped for the Cloudflare-native design here **without a
rewrite of the loop**. This is a strangler-fig migration, not a big bang. The seam is two
interfaces the rest of the system depends on:

```ts
// server/src/ventures/orchestrator.ts  (the seam — both backends implement this)
export interface VentureScheduler {        // "when does a venture tick?"
  ensureScheduled(ventureId: string): Promise<void>;   // BullMQ repeatable  |  DO alarm
  pause(ventureId: string, reason: string): Promise<void>;
  resume(ventureId: string): Promise<void>;
}
export interface BuildExecutor {           // "run one goal to completion, durably"
  start(ctx: VentureCtx, goal: VentureGoal): Promise<RunHandle>;  // BullMQ job  |  Workflow instance
  status(handle: RunHandle): Promise<RunStatus>;
}
```

**Phased cutover** (each phase shippable, reversible behind `VENTURES_ENABLED` + a backend flag):

```
 Phase 0  (today)         Railway Express API + BullMQ/Redis + SSE; studio-worker containers live.
                          studio-worker is ALREADY the container tier — keep it.

 Phase 1  DO for          Ship UserCoordinatorDO behind the auth gateway. Sessions/presence/
          sessions        revocation move to the DO; SSE/poll retained as fallback. (F4, A-independent)
          (F4)            ── lowest risk, immediate UX/security win, no autonomy involved.

 Phase 2  Scheduler       Implement VentureScheduler over VentureDO Alarms; flip ventures one cohort
          → VentureDO     at a time (flag per venture). BullMQ repeatable kept warm as instant rollback.
                          ── retires the "Railway box running BullMQ" scheduler concept.

 Phase 3  Executor        Implement BuildExecutor over BuildGoalWorkflow. A goal's run becomes a
          → Workflows     Workflow; the ACT/VERIFY/SHIP steps call the SAME build code (A4) +
                          adapters (A5). BullMQ job path retained until Workflow path proves out.

 Phase 4  Edge + data     Move API routing/auth/preview to Workers; add Hyperdrive so Workflows/DOs
          path            reach Supabase pooled; KV/R2/Queues as needed.

 Phase 5  Retire Railway  Once DO+Workflows carry production traffic with parity, decommission the
                          BullMQ worker + Redis; Railway optionally remains only as a BYO deploy target.
```

**Why an interface, not a rewrite.** The build loop (`buildAgent`/`studioGenerate`/`studioFix`/
`verifyApp`), the swarm, the deploy adapters, the metering, and Supabase RLS are all **reused
unchanged** — only *who schedules* and *what executes durably* swaps underneath the interface.
At every phase both backends can coexist, so a regression is a flag flip back, never a redeploy
of the engine. Supabase stays the system-of-record throughout, so even a full Cloudflare cutover
leaves the portable anchor intact.

**Rollback & safety.** Each phase keeps the prior backend runnable; the global kill switch
(`VENTURES_KILL`) halts *both* backends; no phase removes a checkpoint or budget gate (those live
in the deterministic DECIDE path, which is backend-agnostic by design).

---

## 23.8 Caveats, limits & honest verdict

### 23.8.1 Verified limits ledger (all `[verified 2026-06]`)

| Primitive | Limit | Source / date |
|---|---|---|
| Worker CPU / request | 5 minutes | Workers platform (since 2025-03) |
| DO storage (SQLite) | **10 GB per object** (GA) | SQLite-in-DO GA, 2025-04-07 |
| DO storage billing | charged on Paid (since Jan 2026) | DO SQLite storage billing changelog, 2025-12-12 |
| DO concurrency | single-threaded per object | DO concepts |
| DO WebSockets | Hibernation API → no billing while idle | DO best-practices/websockets |
| DO Alarms | self-wake scheduler, no cron runner | DO Alarms API |
| Workflow steps | 10,000 default, up to **25,000** (Paid); sleep excluded | step-limit changelog, 2026-03-03 |
| Workflow persisted state | **1 GB** (Paid) / 100 MB (Free) per instance | Workflows limits, 2026-03-03 |
| Workflow step output | 1 MiB (larger via `ReadableStream`) | Workflows limits |
| Workflow retries | default 5 / 10 s / exponential / 10-min timeout; up to 10,000 retries/step | sleeping-and-retrying |
| Workflow concurrency | **50,000** concurrent instances; 300/s create (account), 100/s (workflow); 2M queued/workflow | Workflows limits raised, 2026-04-15 |
| Container instance types | lite … standard-4 + custom (GA 2026-01) | Containers docs |
| Container account ceiling | **6 TiB mem · 1,500 vCPU · 30 TB disk** (raised 15× on 2026-02-25) | Containers limits |

### 23.8.2 Caveats & mitigations

- **It is a migration, not a flip.** §23.7 sequences it behind interfaces; nothing is big-bang,
  every phase is reversible, Supabase stays the record throughout.
- **Containers cold-start + sleep** → warm pool for interactive builds only (§23.4.4); autonomous
  builds tolerate cold start.
- **DOs are single-threaded + storage-bounded** → coordination only; zero heavy compute in a DO;
  blobs/history live in R2/Supabase, not the DO (§23.2.5).
- **Workflow steps must be idempotent** because they replay on resume (§23.3.3) — the one real
  programming-model tax; we pay it with deterministic ids + upserts + pointer-not-blob outputs.
- **Finite, not infinite, scale** — ~1,024 concurrent `standard-2` builds is large but bounded;
  the global concurrency cap (Master Plan §8) must respect it so we never wedge the account.
- **Vendor concentration** → mitigated by Supabase-as-system-of-record + provider-agnostic deploy
  adapters (Master Plan §6); BYO targets (Vercel/Railway) keep an exit.
- **Billing surface widens** (DO storage + Workflow duration + container time) → small-by-design
  DO footprint + sleep-while-parked Workflows keep coordination cost a rounding error vs LLM +
  container cost; metering tags every tick (Master Plan §7).

### 23.8.3 Verdict

Cloudflare is the right core for a 24/7, multi-tenant, real-time autonomous builder — but only at
the **full four-primitive** stack. `UserCoordinatorDO` + `VentureDO` give per-entity coordination,
presence, instant revocation, and a heartbeat with **no cron runner**; **Workflows** make every
build a durable, retrying, resumable pipeline that costs nothing while parked on a human
checkpoint; **Containers** stay exactly as `studio-worker/` already runs them, with headroom for
real build-farm scale. "Always-on" is an *emergent property* of Alarms + Workflows + Containers,
not a server we pay to idle — and because the durable record stays in Supabase behind Hyperdrive,
adopting all of this does **not** trade away portability. The work is the migration in §23.7; the
destination is the topology in §23.1.1.

## 23.9 Acceptance criteria

- Exactly two application DO classes are specified — `UserCoordinatorDO` (sessions/presence/
  revocation/multi-device sync) and `VentureDO` (Alarm heartbeat/isolation/concurrency/fan-out) —
  each with a storage schema, lifecycle, WebSocket-Hibernation/Alarm usage, naming/sharding, and
  the consistency + storage-limit mitigations called out.
- The build pipeline is modeled as a durable Workflow (plan→write→run→observe→fix→verify→ship)
  with retry policy, sleep/wait-for-event for checkpoints, persisted state, idempotency rules, and
  the explicit `VentureDO`-Alarm → Workflow seam.
- Containers are specified as the unchanged Sandbox-SDK execution tier with instance-type table,
  the verified concurrency ceiling + build-farm math, a warm-pool cold-start strategy, and
  per-tenant naming/isolation/lifecycle.
- Worker edge roles (auth gateway, API routing, preview routing, WS upgrade) and supporting
  services (KV, R2, D1-optional, Queues, Hyperdrive→Supabase) each have a stated role and a
  why-this-not-that.
- A `wrangler` config sketch + binding cheat-sheet shows DOs + Workflows + supporting bindings as
  an extension of the shipped `studio-worker/` config, distinguishing shipped from target.
- A phased, reversible migration from Railway+BullMQ to DO+Workflows behind two interfaces
  (`VentureScheduler`, `BuildExecutor`) is specified, with rollback and Supabase-as-record kept.
- Every numeric limit is tagged `[verified 2026-06]` with its source; a single limits ledger +
  caveats table closes the section honestly.
