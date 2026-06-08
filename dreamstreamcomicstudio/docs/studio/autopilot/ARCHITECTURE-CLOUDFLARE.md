# Cloudflare as the platform — verified capabilities & the enterprise topology

> **The question:** is Cloudflare Workers + Containers a good virtual cloud environment for
> a 24/7 autonomous builder, given our existing infra and what we actually need?
>
> **The answer:** Yes — Cloudflare is a strong enterprise foundation — **but "Workers +
> Containers" is only 2 of ~5 primitives you need.** The brain of an always-on builder is
> not a Worker (5-min CPU/request) and doesn't need an always-on server; it's
> **Durable Objects (coordination + scheduling) + Workflows (durable build pipelines) +
> Containers (sandboxed execution)**. Today the repo uses ~40% of the right primitives.

**Facts below are verified against Cloudflare docs as of 2026-06.** See
[`F-ENTERPRISE-FOUNDATIONS.md`](./F-ENTERPRISE-FOUNDATIONS.md) for the work items and
[`00-MASTER-PLAN.md`](./00-MASTER-PLAN.md) for how the autonomous loop consumes this.

---

## 1. Verified capabilities (2026-06)

### Containers — the execution muscle (you already use this)
Instance types (custom sizes GA since 2026-01, up to `standard-4` limits):

| Type | vCPU | Memory | Disk |
|---|---|---|---|
| lite (`dev`) | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1 (`standard`) | 1/2 | 4 GiB | 8 GB |
| standard-2 | 1 | 6 GiB | 12 GB |
| standard-3 | 2 | 8 GiB | 16 GB |
| standard-4 | 4 | 12 GiB | 20 GB |

Concurrency ceiling (raised 15× on 2026-02-25): **6 TiB memory, 1,500 vCPU, 30 TB disk** →
~**1,000+ concurrent `standard-2`** (or 6,000 `basic`) container instances. That is real,
multi-tenant build-farm scale. **Caveats:** containers cold-start and sleep when idle (need a
warm-pool for "instant" UX); billed per active time; controlled from a Worker (the Sandbox
SDK pattern `studio-worker/` already uses).

### Workers — the edge tier (good for requests, not for the brain)
Up to **5 minutes of CPU time per request** (since 2025-03). Great for API/routing/preview
serving and auth gateway. For long-running work Cloudflare itself points you to **Workflows +
Queues** — so we don't try to make a Worker the always-on loop.

### Durable Objects — the coordinator (the missing piece, fixes half the concerns)
- **Single global point of coordination** per object id, with **private persistent storage**.
- **Alarms API:** schedule the object to wake itself at a future time — a built-in heartbeat,
  no cron runner to babysit. This is the autonomous **tick scheduler**.
- **WebSocket + Hibernation API:** long-lived real-time connections, **no billing while
  idle** — real-time UI + multi-device sync cheaply.
- **RPC** between Workers and DOs.
- **Caveat:** single-threaded per object + storage limits → perfect for *coordination*, wrong
  for heavy compute (that's Containers/Workflows).

### Workflows — durable execution (the build pipeline brain)
**Automatic retries, state persistence, multi-step operations spanning minutes → hours →
weeks**, step-based, with DAG dependencies. This is the enterprise answer for "never stop
building" *reliability*: each build goal becomes a durable, resumable Workflow that survives
restarts and retries failed steps — replacing today's fragile one-shot loop.

### Supporting: R2 (object storage), KV (edge cache), D1 (edge SQLite), Queues (work
distribution), Hyperdrive (Postgres pooling). Plus our existing **Supabase** (auth + Postgres
+ RLS, the system-of-record) and **Railway** (the current Express API).

---

## 2. Map each need → the right primitive

| What a 24/7 autonomous builder needs | Right primitive | Have it? |
|---|---|---|
| Per-tenant sandboxed code exec, `npm i`, dev servers, builds | **Containers** (Sandbox SDK) | ✅ `studio-worker/` |
| Durable, resumable build pipeline per goal (plan→write→run→fix) | **Workflows** | ❌ |
| Always-on "tick" heartbeat + per-venture coordination | **Durable Objects + Alarms** | ❌ |
| Real-time activity stream, multi-device sync, presence, instant revocation | **Durable Objects + WebSocket Hibernation** | ❌ (SSE/poll today) |
| Per-user / per-project isolation + concurrency control | **One Durable Object per user / per venture** | ❌ (in-memory caps today) |
| Edge API, preview routing, auth gateway | **Workers** | ◐ |
| System-of-record, auth, RLS | **Supabase** (keep) | ✅ |
| Object/blobs, cache, Postgres pooling, work fan-out | **R2 / KV / Hyperdrive / Queues** | ◐ partial |

**The key insight:** you do **not** need an always-on server. "Always-on" *emerges* from
**DO Alarms (heartbeat) + Workflows (durable jobs) + Containers (muscle)** — cheaper and more
isolated than a Railway box running BullMQ.

---

## 3. The enterprise topology

```
  Client (React, any device)
     │  HTTPS + WebSocket
     ▼
  Worker (edge): auth gateway · API routing · preview serving · WS upgrade
     │ RPC                                   │ route to preview
     ▼                                       ▼
  Durable Objects                       Containers (Sandbox SDK)
   ├─ UserCoordinatorDO (per user):      per (user,project) sandbox:
   │   device sessions, presence,         npm install · dev server ·
   │   instant revocation, real-time      exec/logs · exposePort
   │   multi-device sync  ◄── fixes F3/F4
   └─ VentureDO (per venture):
       Alarm-driven tick heartbeat,
       per-venture isolation + concurrency,
       live activity stream (WS hibernation)
                │ starts / monitors
                ▼
        Workflows (durable execution): one per build goal
          step plan → step write → step run(container) → step observe → step fix → step verify → step ship
          (auto-retry, state-persisted, resumable across restarts; spans minutes–hours)
                │ reads/writes
                ▼
        Supabase Postgres (system-of-record + RLS)  ·  R2 (artifacts/blobs)  ·  KV (cache)
```

- **UserCoordinatorDO** → directly fixes the owner's "session ids / multi-device sync /
  multiple simultaneous sign-ins": one authoritative coordinator per user pushes revocation
  and state to every device over a hibernating WebSocket.
- **VentureDO** → directly fixes "multiple simultaneous projects": one object per venture =
  isolation + its own concurrency control + an Alarm heartbeat that drives the autonomous tick
  (Master Plan §4) without any cron runner.
- **Workflows** → make the build loop crash-safe and long-running with built-in retries —
  the reliability layer the current one-shot loop lacks.
- **Containers** → unchanged role (you already have `studio-worker/`); scale headroom is huge.

---

## 4. Honest verdict & trade-offs

**Cloudflare is the right core.** The gap is not the provider — it's that the platform uses
Workers + Containers but **not** Durable Objects or Workflows, which are exactly the primitives
a 24/7, multi-tenant, real-time autonomous system needs. Adopting them is also the cheapest
path: Alarms + hibernating WebSockets + durable Workflows mean you pay for work, not idle
servers.

**Trade-offs / caveats (so this is honest):**
- **It's a migration, not a free switch.** Today: Railway Express + BullMQ/Redis + SSE.
  Plan: keep Railway as the API tier during transition; move *coordination + scheduling* to
  DOs and *build pipelines* to Workflows **behind an interface**, incrementally — not big-bang.
  (Master Plan A2 builds the orchestrator behind an interface for exactly this.)
- **Containers cold-start + sleep** → add a small warm pool for interactive builds.
- **DOs are single-threaded + storage-bounded** → coordination only; compute stays in
  Containers/Workflows.
- **Vendor concentration** → mitigate by keeping Supabase as the portable system-of-record and
  the deploy layer provider-agnostic (Master Plan §6 adapters), so BYO targets (Vercel/Railway)
  still work.

---

## 5. Recommended adoption order (ties to the F-series)

1. **DOs for real-time + sessions** (F4 `UserCoordinatorDO`, supports F3) — immediate UX +
   security win, independent of autonomy.
2. **DOs for the autonomous heartbeat + per-venture isolation** (`VentureDO`, Master Plan A2)
   — replaces the Railway/BullMQ scheduler concept.
3. **Workflows for the build pipeline** (Master Plan A4) — durable, retrying builds.
4. **Containers** stay as-is; add a warm pool + use `standard-2`/custom for real builds.
5. Keep **Supabase** (system-of-record) + **Railway** (API) through the transition; retire
   pieces only once their DO/Workflow replacement is proven.

> Net: keep Cloudflare, but go from "Workers + Containers" to the full
> **Workers + Durable Objects + Workflows + Containers** stack. That is the difference between
> a demo and an enterprise, always-on, multi-tenant platform.
