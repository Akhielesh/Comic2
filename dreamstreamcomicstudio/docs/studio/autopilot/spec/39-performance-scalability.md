# 39 — Performance & Scalability

> Part IV · Non-functional / Foundations · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Architecture (Cloudflare)](../ARCHITECTURE-CLOUDFLARE.md) (verified limits) ·
> [Cloudflare Topology (deep)](./23-cloudflare-topology.md) ·
> [Data Model & Schema](./26-data-model-schema.md) (query/index strategy) ·
> [Reliability & SRE](./37-reliability-sre.md) · [Observability](./38-observability.md) ·
> [Cost Model & FinOps](./40-cost-finops.md). Maps to **F2** (distributed correctness /
> shared limits), **F5** (load test), **A2** (autonomous loop at scale).

## 39.1 Scope, stance & how to read this

This section is the **performance contract** and the **scalability model** for Code Studio
Autopilot: the budgets we hold ourselves to, the levers that hold them, the verified ceilings of
the platform we run on, and the playbook for what to do when a budget starts to slip. It is the
quantitative companion to the qualitative reliability story in §37 (SLOs/error budgets) and the
cost story in §40 (FinOps) — performance is *what fast feels like*; reliability is *what staying
up feels like*; cost is *what it bills*. They share the same numbers, read three ways.

**House rules.** Every Cloudflare ceiling cited is taken from the verified ledger in §23.8.1 and
tagged `[verified 2026-06]`; numbers we are *choosing* as targets are tagged `[target]`; work
that is already in the repo is marked **shipped** with its file/CHANGELOG anchor; everything else
is **planned**, not shipped. We do not claim numbers we have not measured — where a target is
aspirational pending the §39.8 load test, we say so.

**What is real today.** The only performance work already merged is **frontend bundle
splitting** in [`vite.config.ts`](../../../../vite.config.ts) (manual vendor chunks + lazy
Sandpack/editor). Everything in the *backend* and *scalability* sections is the **target design**
on the Cloudflare topology of §23, much of which is still a migration (§23.7), not current state.
We flag the seam each time it matters.

---

## 39.2 Performance budgets

A budget is a number with consequences: cross it and an alert fires (§38), an error-budget burn
is recorded (§37), and the §39.9 playbook engages. Budgets are split by tier because a 24/7
autonomous builder has three very different latency surfaces — the **operator's UI**, the
**control-plane API**, and the **live agent activity stream** — plus the long-running
**build pipeline**, which is measured in *throughput and start latency*, never in request p95.

| Budget | Target | Tier | Source / status |
|---|---|---|---|
| First Contentful Paint (Console, desktop, cable) | ≤ 1.2 s `[target]` | Frontend | aligns with §19.7 mobile (≤1.8 s on 4G) |
| Largest Contentful Paint (Console) | ≤ 2.0 s `[target]` | Frontend | skeleton-first / boot-reveal |
| **Eager (first-paint) JS, main entry** | **272 kB / 82 kB gzip** | Frontend | **shipped** — was 638 kB; **~64 % eager-JS cut** (§39.3) |
| Route JS, mobile (gzipped) | ≤ ~200 kB `[target]` | Frontend | editor never ships to phone (§19.7) |
| TTFB (edge, cached/static) | ≤ 100 ms `[target]` | Edge | Workers + CDN at PoP |
| TTFB (edge, dynamic API hit) | ≤ 300 ms `[target]` | Edge/API | gateway → DO RPC / Hyperdrive |
| **API p95 (non-build read/write)** | **≤ 2.5 s** | API | inherited from [load-test-plan](../../../production/load-test-plan.md) |
| API p99 (non-build) | ≤ 4.0 s `[target]` | API | tail guard |
| Build **start** latency (interactive, warm pool) | ≤ 3 s `[target]` | Build | warm-pool assign (§39.6); not request p95 |
| Build **start** latency (autonomous, cold OK) | ≤ 60 s `[target]` | Build | tolerates cold start (§23.4.4) |
| Realtime latency (event → all devices) | ≤ 500 ms p95 `[target]` | Realtime | DO WebSocket fan-out (§34) |
| Realtime reconnect after sleep | ≤ 2 s to live `[target]` | Realtime | cursor resume, not full refetch (§19.7/§34) |
| 5xx ratio under sustained load | < 1 % | API | load-test acceptance |

**Why builds are not on the p95 line.** A build is a Workflow that runs minutes to hours and may
*park for hours* on a human checkpoint (`step.waitForEvent`, §23.3.2). Measuring it as request
latency would be a category error. Builds get **start latency** (how fast the agent begins) and
**throughput** (concurrent builds, §39.5) budgets instead; their long-run reliability is §37's
job. This separation is the single most important framing in the section.

**Budget ownership.** Each budget has one owner surface in §38's dashboards and one alert rule;
a budget without an alert is a wish, not a budget.

---

## 39.3 Frontend performance — **shipped**, plus the path forward

The frontend is the one tier where performance work is already merged. The headline:

> **Main entry bundle: 638 kB → 272 kB (gzip 82 kB) — a ~64 % cut in eager, first-paint
> JavaScript.** Heavy libraries now cache independently of app code, and the in-browser
> editor/bundler no longer loads on first paint. (CHANGELOG; build-only, no behaviour change.)

**How it was done (shipped, in [`vite.config.ts`](../../../../vite.config.ts)):**

| Lever | Implementation | Effect |
|---|---|---|
| **Vendor code-splitting** | `rollupOptions.output.manualChunks` splits `framer-motion`, Sandpack/CodeMirror, `react-markdown`, Leaflet, JSZip into own chunks | app-code changes no longer bust vendor caches |
| **React core pinned eager** | regex pins `react`/`react-dom`/`scheduler`/`react-router` to `vendor-react` so Rollup can't fold them into the 982 kB Sandpack chunk | landing page stops downloading ~950 kB just to get React |
| **Lazy editor/bundler** | `vendor-sandpack` (~982 kB) is **lazy-loaded** — only the legacy Sandpack peek pulls it; `chunkSizeWarningLimit` raised past it | the heaviest dependency is off the first-paint path |
| **Preload-helper pinned** | Vite's dynamic-import preload helper pinned to `vendor-react` instead of leaking into Sandpack | entry references it for free, Sandpack stays lazy |
| **Lean studio bundle** | `services/studioApi.ts` and the ErrorBoundary imported directly (not via barrels) to keep the main bundle lean (CHANGELOG) | standalone `/studio` bundle stays small |
| **Two entry points** | `index.html` (app) + `studio.html` (isolated Code Studio with COOP/COEP) as separate Rollup inputs | studio's cross-origin-isolation headers never burden the main app |

**The path forward (planned, builds on the above):**

- **Route-level code-splitting of the Console** so the Operator Console, the build/iterate
  editor, billing, and integrations are separate lazy routes — the editor is the heaviest part of
  the app and the one mobile omits entirely (§19.7). This is the next lever after vendor splitting.
- **CDN delivery** of all static assets via Cloudflare's edge (immutable, content-hashed,
  long-`max-age`); the apex marketing site and app shell served from cache at the PoP, keeping
  static TTFB ≤ 100 ms `[target]`.
- **Skeleton-first / boot-reveal** rendering so LCP is a real skeleton, not a spinner, and content
  streams in (the pattern §19.7 already relies on).
- **No heavy GPU effects on weak hardware** — the §19.10 finding that `backdrop-filter`/animated
  `blur()` can fail to paint at all on weak devices is a perf budget, not just a mobile note.

---

## 39.4 Backend performance

The backend performance model is the Cloudflare topology of §23 read through a latency lens. Three
levers carry it: **edge caching (KV)**, **pooled Postgres (Hyperdrive → Supabase)**, and a
**query/index strategy** that keeps the system-of-record fast under multi-tenant load.

### 39.4.1 Caching via KV

KV is the **edge cache for hot, rarely-changing reads** (§23.5.1): feature flags
(`VENTURES_ENABLED`/`VENTURES_KILL`), plan entitlements, public preview routing hints. It is
eventually consistent and read-heavy — never the system-of-record — which is exactly what makes it
safe to cache aggressively at every PoP.

| Cache class | Lives in | TTL `[target]` | Why |
|---|---|---|---|
| Feature flags / kill switch | KV | seconds–low minutes | read on nearly every request; flips rare |
| Plan entitlements / quotas | KV | minutes | read per build/deploy; changes on billing events only |
| Preview routing hints | KV | minutes | `*.dreamstreamstudio.ai` resolution at the edge |
| Auth/JWKS keys | Worker memory + KV | per JWKS rotation | local JWT verify, no per-request Supabase round-trip (F3) |
| Live coordination state | DO storage (not KV) | n/a | strongly consistent per entity — KV would be wrong here |

The deliberate boundary: **consistency-sensitive state lives in a Durable Object** (read-your-writes
per entity, §23.2.4); **read-heavy global state lives in KV**; **durable truth lives in Supabase**.
Putting a kill switch in KV is fine (eventual is acceptable for "off"); putting a session-revocation
*authority* in KV would not be — that is the DO's job.

### 39.4.2 Hyperdrive — Postgres connection pooling

Workers and Workflows are **massively concurrent**; raw Postgres connections from the edge would
exhaust Supabase in minutes. **Hyperdrive** is the load-bearing bridge (§23.5.1): it pools and
edge-caches connections so the edge can reach Supabase at scale without connection exhaustion. This
is what lets us adopt Cloudflare's primitives **without** giving up Supabase as the portable
system-of-record — the explicit anti-lock-in stance of the canon.

- **Connection multiplexing** — thousands of concurrent Worker invocations share a small pool of
  warm Postgres connections, instead of one-per-invocation.
- **Edge query caching** — read-heavy, cacheable queries can be served from Hyperdrive's cache,
  cutting both latency and Postgres load.
- **Honest caveat:** Hyperdrive adds a hop; if its latency to Supabase ever bites, §23.5.1's
  optional **D1 edge read-mirror** of low-sensitivity venture metadata is the escape hatch — *not*
  a second system-of-record, only a fast global read cache.

### 39.4.3 Query & index strategy (from §26)

The schema in §26 carries the row-level-security and indexing discipline that keeps Postgres fast
under tenant isolation. The performance-relevant rules:

- **Tenant-scoped indexes.** Every hot query is `WHERE owner = auth.uid()` (RLS) plus a venture/goal
  filter; the composite indexes in §26 lead with the owner/venture key so RLS and the access path
  agree — an index that doesn't lead with the tenant key forces a scan under RLS.
- **Append-mostly event tables.** `venture_events` is append-heavy and time-ordered; it is indexed
  for `(venture_id, seq)` range reads (the activity stream) and is the durable mirror behind the
  DO's in-memory ring buffer (§23.2.2) — so the *hot* read path is the DO's RAM, and Postgres is hit
  only on cold reconnect or audit.
- **Idempotency keys are unique indexes.** F2's idempotency keys on build/deploy/billing/intake
  routes are unique constraints — they double as the dedup index, so a replayed request is a fast
  conflict, not a duplicate insert (§23.3.3).
- **Pointer-not-blob.** Build artifacts, bundles, and large logs go to **R2**, never Postgres or a
  DO (§23.2.5 / §23.5.1); Workflow steps return R2 keys, keeping step outputs under the 1 MiB cap
  `[verified 2026-06]` and Postgres rows small.

---

## 39.5 Scalability model

Scalability here means **horizontal by entity**, not bigger boxes. The topology gives each tenant
its own coordinator and each build its own durable instance, so adding load adds *objects*, not
contention — bounded only by the verified account ceilings.

| Layer | Scaling axis | Verified ceiling `[verified 2026-06]` | How we live inside it |
|---|---|---|---|
| **Workers (edge)** | per-request, auto-scaled at every PoP | 5 min CPU / request | thin routers only; brain is DO/Workflow, not the Worker |
| **Durable Objects** | **one object per user / per venture** | 10 GB SQLite per object; single-threaded | coordination only; KB–MB footprint; blobs to R2 |
| **Workflows** | one instance per build goal | **50,000 concurrent**, 300/s create (account), 25,000 steps, 1 GB state | one active build/venture (F2) keeps us far under |
| **Containers** | per (user, project) sandbox | **6 TiB mem · 1,500 vCPU · 30 TB disk** | global concurrency cap respects the memory bound (§39.5.1) |
| **Supabase (Postgres)** | vertical + read scaling, RLS isolation | plan-dependent; connections via Hyperdrive | pooled connections; tenant-scoped indexes (§39.4.3) |
| **Redis (shared limits)** | shared atomic counters (F2) | plan-dependent | rate limiter + studio caps move off in-memory (§39.7) |

### 39.5.1 Container build-farm math (the tightest real bound)

From §23.4.3, the account ceiling translates directly into concurrent-build capacity:

```
 1,500 vCPU / 1 vCPU (standard-2)  ≈ 1,500 concurrent standard-2 builds
   6 TiB  / 6 GiB  (standard-2)    ≈ 1,024 concurrent standard-2 builds   ← MEMORY is the tighter bound
 1,500 vCPU / (1/4) (basic)        ≈ 6,000 concurrent basic builds
```

So **≈1,024 concurrent `standard-2` builds** is the real ceiling at our default size — genuine
multi-tenant build-farm scale, but **finite, not infinite**. This single number drives three design
choices: the **warm pool** (§39.6) so a slice is instant, the **global concurrency cap** (Master
Plan §8) so we never wedge the account, and the **fair-share scheduler** (§39.7) so one tenant
can't consume the whole ceiling. The `studio-worker/` binding cap of `max_instances: 50` is a
*current* throttle, raised per tenancy plan toward this ceiling — not a platform limit.

### 39.5.2 Realtime scaling (DO WebSocket Hibernation)

The activity stream and multi-device sync scale by DO, not by a connection server: each
`UserCoordinatorDO`/`VentureDO` holds its observers' WebSockets and fans out events in one hop
(§23.2). **Hibernation** means idle sockets cost nothing (`[verified 2026-06]`) — essential when
most devices sit idle on the Console for hours. Scaling is linear in *active entities*, and the
per-object single-threaded model is fine because a human + a heartbeat is naturally low-throughput
(§23.2.3 sharding stance).

---

## 39.6 Container warm-pool for build latency

Containers **cold-start and sleep when idle** (`[verified 2026-06]`) — acceptable for batch builds,
unacceptable for "click → instant preview." The mitigation (§23.4.4) is a small **warm pool**:

- Keep a pool of **pre-warmed, generic `standard-2` sandboxes** (image pre-pulled, Node ready)
  reserved per region; an interactive build is *assigned* a warm sandbox and re-personalized with
  the tenant's files instead of cold-booting — turning a multi-second cold start into a ≤3 s
  assign `[target]`.
- **Pool size is demand-driven** — keep N ≈ peak-concurrent-interactive × 0.2 warm `[target]`,
  refilled by a `VentureDO`/scheduler Alarm or a Queue consumer.
- **Autonomous (non-interactive) builds skip the pool** — they tolerate cold start, so we never pay
  to keep them warm; warm capacity is spent **only where a human is waiting**. This is the key
  cost/latency trade and it ties straight to §40.
- **Idle warm instances are reaped after a TTL** so the pool never silently eats the concurrency
  ceiling (§39.5.1).

The honest trade: warm pool is **paid idle capacity**. We size it from measured interactive demand
(§38), not optimism, and reap aggressively; §40 carries the cost line.

---

## 39.7 Concurrency, fair-share & shared limits (F2)

The moment we run more than one instance, **in-memory limits multiply** and concurrent saves can
interleave-corrupt files — exactly the F2 gap. Performance and correctness meet here.

| Concern (F2) | Today (gap) | Target |
|---|---|---|
| Rate limiting | in-memory limiter (`rateLimit.ts`) — multiplies per instance | **Redis** shared atomic counters; one cluster-wide limit |
| Studio concurrency caps | DB-error "allow" fail-open fallback | shared cap with **no fail-open** gap |
| File saves | delete-then-insert (`studioRepository.ts`) — interleave risk | **optimistic concurrency** (`version` column), versioned upsert |
| Mutating routes | replay = duplicate work/cost | **idempotency keys** → safe retry (§23.3.3) |
| Per-venture build concurrency | global in-memory caps (contention) | **one active build per venture** enforced by `VentureDO` single-thread (§23.2.2) |
| Cluster saturation | unbounded | **backpressure**: reject/queue when saturated (ties to queue-depth) |

**Fair-share.** The container ceiling (§39.5.1) is shared across all tenants, so the scheduler
enforces a **per-tenant slice**: a noisy tenant cannot starve others past its allocation. The
`VentureDO` caps each venture at one active build; a global cap bounds the account; between them, a
single tenant's worst case is its own slice, not the whole farm. This is the scalability expression
of the multi-tenancy isolation in §25.

**F2 acceptance (load-relevant):** a load test across ≥2 instances enforces **one shared limit**;
two concurrent saves to one project cannot corrupt; replaying a build request is a **no-op**. These
are §39.8 test cases, not just assertions.

---

## 39.8 The autonomous engine at scale (A2)

The autonomous loop is the load profile no traditional app has: **many ventures × many ticks**,
each tick possibly starting a long Workflow. Its scaling story is the §23 topology under sustained
fan-out.

- **Many ventures, each a `VentureDO`.** N active ventures = N independent Alarm heartbeats, each
  self-perpetuating (`setAlarm`) with **no cron runner** (`[verified 2026-06]`). There is no central
  scheduler to saturate; scaling is linear in active ventures and a *paused* venture stops setting
  Alarms and **costs nothing** (§23.2.2).
- **Ticks are cheap; builds are not.** The Alarm → DECIDE gate is deterministic and tiny (budget?
  checkpoint? kill? scope? concurrency free? — **no LLM**); only a *clear* tick starts a Workflow.
  So the per-tick cost at rest is a DO wake, not a build. This is what makes "thousands of ventures
  ticking" affordable.
- **Scheduler concurrency cap.** The number of *simultaneously building* ventures is gated below the
  container ceiling (§39.5.1) by the global concurrency cap (Master Plan §8) and per-tenant
  fair-share (§39.7). Ventures whose tick is clear but whose build slot is full **wait their turn**
  (Queue/backpressure), they do not cold-boot a container the farm can't hold.
- **Parked builds are free.** A Workflow parked on a prod checkpoint (`step.waitForEvent`) holds no
  worker and **costs nothing while parked** (§23.3.1) — unlike a BullMQ job pinning a worker slot
  for hours. So a backlog of awaiting-approval builds does not consume build capacity.
- **The headline ceiling.** With one active build per venture and the container memory bound,
  **≈1,024 ventures can be mid-build simultaneously** at `standard-2`; far more can be *active*
  (ticking, parked, or queued) at negligible cost. That gap — cheap-to-have-many, bounded-to-build —
  is the whole economic shape of the autonomous engine.

---

## 39.9 Load testing plan (F5) & targets

The load test is **executable (k6)**, derived from
[`docs/production/load-test-plan.md`](../../../production/load-test-plan.md), and is an F5
deliverable (`Executable load test (k6)`) gated in CI as *runnable*. It validates the §39.2 budgets
under realistic and adversarial load.

**User-load tiers:** **100 → 300 → 600 → 1000** concurrent users (from the load-test plan).

| Scenario | Drives | Validates |
|---|---|---|
| **Auth-only** | login + token validation | F3 local JWT verify; TTFB budget |
| **Text generation** | sustained `/api/text/*` | API p95 ≤ 2.5 s; provider failover (§29) |
| **Image generation** | controlled `/api/image/*` | timeout/idempotency; cost-aware concurrency |
| **Mixed** | realistic text/image/vision/system ratio | end-to-end p95/p99; saturation behaviour |
| **Burst** | short spikes | rate-limit + retry; **no crash** under 429 |
| **Multi-instance limit** (F2) | same limit, ≥2 instances | one *shared* limit enforced (§39.7) |
| **Build fan-out** (A2) | many ventures ticking → builds | scheduler cap + fair-share + warm-pool hit rate |

**Measurements (per endpoint class):** p50/p95/p99 latency; 2xx/4xx/5xx ratios; 429 ratio + top
keys/IPs; provider timeout/failure ratios; CPU/memory saturation; (for builds) start latency, warm
hits, concurrent-build count vs the ceiling.

**Acceptance criteria (from the plan, plus build/F2 additions):**

| # | Criterion | Tier |
|---|---|---|
| 1 | **5xx ratio < 1 %** during sustained load | all |
| 2 | **p95 ≤ 2.5 s** for non-image endpoints | all |
| 3 | Controlled 429 under bursts, **no service crash** | burst |
| 4 | **No persistent memory growth** over a 30-min sustained run | all |
| 5 | **One shared limit** enforced across ≥2 instances; concurrent saves don't corrupt; build replay is a no-op | F2 |
| 6 | Warm-pool interactive **build start ≤ 3 s** at expected interactive load | build |
| 7 | Realtime fan-out **≤ 500 ms p95** to all observers; reconnect ≤ 2 s | realtime |

**Execution discipline (from the plan):** run **staging first**, production only in controlled
windows; start with **conservative image concurrency** (provider-cost impact); capture logs +
metrics snapshots **before and after** each run. The §40 cost model consumes the same run data.

---

## 39.10 Bottleneck analysis & scaling playbook

The first bottleneck to bind is almost always one of four: **container concurrency**, **Postgres
connections/queries**, **shared-limit/Redis contention**, or **LLM-provider latency**. The playbook
maps each trigger to a concrete action; the first four triggers are inherited verbatim from
[`scaling-and-cost.md`](../../../production/scaling-and-cost.md), the rest are the topology-specific
additions.

| Bottleneck signal (trigger) | First action | Then, if it persists |
|---|---|---|
| **p95 > 2.5 s for 10 min** (non-build) | scale backend instance size / add one replica | profile the slow endpoint class; check Hyperdrive cache hit |
| **CPU > 70 % for 15 min** | add one API replica | move heavy work off the request path (Workflow/Queue) |
| **429 ratio > 8 %** + complaints | tune per-route limits; add capacity | raise plan limits per tenancy; verify Redis (shared) is the cap, not in-memory |
| **Image endpoint timeout > 10 %** | retry tuning; queue decision | **adopt async image queue** (see threshold below) |
| **Container concurrency near ceiling** (§39.5.1) | raise `max_instances`; enforce fair-share + global cap | shift default size (`standard-2`→`basic` where it fits); regionalize the warm pool |
| **Warm-pool miss rate high** | grow pool toward peak-interactive × 0.2 | regional pools; pre-warm on intake signal |
| **Postgres connections saturating** | confirm Hyperdrive pooling is in the path | add read replica / D1 edge read-mirror for hot reads (§23.5.1) |
| **Slow tenant-scoped query** | confirm index leads with owner/venture key (§39.4.3) | add covering index; move hot reads to KV/DO RAM |
| **Realtime fan-out lag** | check DO is hibernating (not resident-billed) idle sockets | shard sub-work to child Workflows (never split the entity DO, §23.2.3) |
| **Workflow create rate near 300/s** (`[verified 2026-06]`) | smooth via Queue (at-least-once into Workflows) | stagger tick intervals across ventures |

**Async image-queue threshold** (from the cost-scaling doc): adopt the queue when **either**
`/api/image/*` p95 stays **> 30 s** after vertical/horizontal scaling, **or** image work saturates
non-image endpoints. Then: API enqueues → returns a job id (pending) → worker calls the provider and
stores the result → client polls/subscribes for completion (the same pattern §23.5.1 uses Queues
for).

**Cost-aware brakes (cross-link to §40).** Several scaling levers are also cost levers: BYOK for
high-usage users, strict image-route rate limits, idempotency keys to avoid duplicate provider
calls, disabling the legacy image data-URL response in prod, and CDN caching of static assets. They
appear here because *not* applying them shows up first as a performance/availability bottleneck, and
only later on the bill.

---

## 39.11 Acceptance criteria

- A budget table (§39.2) sets first-paint/LCP, eager-JS, TTFB, **API p95 ≤ 2.5 s**, build **start**
  latency (interactive vs autonomous), and realtime latency — with builds explicitly *off* the p95
  line and on a start-latency/throughput line instead.
- Frontend performance is marked **shipped** with the **~64 % eager-JS cut** (638 kB → 272 kB) and
  its concrete `vite.config.ts` levers (vendor splitting, lazy Sandpack, pinned React/preload-helper,
  two entry points), plus the planned route-split / CDN / skeleton-first path.
- Backend performance specifies **KV** caching (with the consistency boundary vs DO vs Supabase),
  **Hyperdrive** Postgres pooling (and the honest hop/escape-hatch caveat), and the **query/index
  strategy from §26** (tenant-leading indexes, append-mostly events, idempotency-as-index,
  pointer-not-blob).
- A scalability model maps every layer to its **verified ceiling** (`[verified 2026-06]`), shows the
  container build-farm math (**≈1,024 concurrent `standard-2`** as the tight memory bound), and
  covers Supabase + Redis scaling.
- The container **warm pool** (interactive-only, demand-sized, reaped) is specified for build start
  latency, with its cost trade stated.
- **Concurrency + fair-share (F2)** is specified — shared Redis limits, optimistic concurrency,
  idempotency, per-venture single active build, backpressure — with the multi-instance load-test
  acceptance.
- The **autonomous engine at scale (A2)** is covered: many ventures × ticks, cheap ticks vs costly
  builds, scheduler concurrency cap, free parked builds, and the ≈1,024-simultaneous-build ceiling.
- An **executable k6 load test (F5)** is specified with the four user-load tiers, all scenarios, the
  measurements, and the acceptance criteria (including the F2/build/realtime additions).
- A **bottleneck → action** playbook maps each trigger (the four from the scaling doc + topology
  additions) to a first action and an escalation, including the async-image-queue threshold and the
  cost-aware brakes cross-linked to §40.
