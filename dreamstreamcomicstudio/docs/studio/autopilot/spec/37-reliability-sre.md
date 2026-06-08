# 37 — Reliability & SRE (SLOs, Error Budgets)

> Part IV · Non-functional / Foundations · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [F-ENTERPRISE-FOUNDATIONS](../F-ENTERPRISE-FOUNDATIONS.md) (**F0** observability — the signals
> SLOs measure · **F2** distributed correctness — shared limits & backpressure · F1 provider
> reliability — retries/breakers) · [Master Plan](../00-MASTER-PLAN.md) (Epic A0 brakes, A2 loop,
> A9 GA gates) · [Autonomous Engine](./24-autonomous-engine.md) (§24.7 guards, §24.9 crash-safety,
> §24.11 failure modes) · [Observability](./38-observability.md) (planned — the metrics pipeline
> this section consumes) · [Performance & scalability](./39-performance-scalability.md) (planned) ·
> [Runbooks](./50-runbooks.md) (planned — incident procedures). Grounded in the audited code:
> `server/src/routes/system.ts` (health/ready), `middleware/rateLimit.ts`, `comicforge/queue.ts`,
> `services/modelCatalog.ts`, and the documented (un-fed) thresholds in
> `docs/production/alerting-thresholds.md` + `docs/production/scaling-and-cost.md`.

## 37.1 What this section is, and the honest starting point

This section defines **how we promise the platform behaves, how we measure that promise, and what
we do when we are about to break it.** It turns the documented alert thresholds and the engine's
guards (§24.7) into a coherent SRE contract: Service Level Indicators (SLIs), Service Level
Objectives (SLOs), error budgets, and burn-rate alerting — plus the graceful-degradation,
backpressure, and incident-response practices that keep an always-on autonomous builder inside
those objectives.

Two honesty notes frame everything below, both inherited from the 2026-06-07 code audit
([F-ENTERPRISE-FOUNDATIONS §F0/F8](../F-ENTERPRISE-FOUNDATIONS.md)):

1. **The objectives are real; the measurement is mostly not yet wired.** We have honest
   health/ready endpoints (`system.ts`), a per-request JSON log, and a written threshold table
   (`alerting-thresholds.md`). We do **not** yet have a metrics backend, tracing, error tracking,
   or worker/Redis liveness — so today the thresholds are *aspirational, with nothing emitting the
   numbers*. **F0 is the hard dependency of this entire section**: an SLO you cannot measure is a
   wish. Every SLI below is marked ✅ measurable today, ◐ partially, or ❌ blocked on F0.
2. **The numbers here are illustrative, not contractual.** No customer SLA exists yet (see
   [§05 business model](./05-business-model-pricing.md)). The targets below are *engineering
   objectives* sized from `alerting-thresholds.md` and a single-region Railway + Cloudflare
   topology. They are the starting bar to ratchet, not a published guarantee. When we sign a paid
   SLA, the GA gate (Epic A9) re-derives these against committed capacity.

The governing stance, consistent with §24: **every failure resolves to one of {retry-within-budget,
degrade gracefully, pause+notify, page a human} — never "spin silently" and never "fail the whole
platform when one dependency is down."** SLOs are how we know which of those we are doing.

---

## 37.2 SLIs and SLOs per service (illustrative targets)

We define SLOs per **user-facing journey**, not per process, because users feel journeys. Each SLO
is a *good-events / valid-events* ratio (or a latency percentile) over a rolling **28-day window**.
The window is long enough to absorb a single bad deploy and short enough to drive weekly action.

**Request classification** mirrors the existing operational taxonomy
(`scaling-and-cost.md` weekly review): `text`, `image`, `vision`, `system`, plus the Autopilot-only
classes `tick` and `realtime`. SLIs are computed only over **valid** events — health checks,
synthetic probes, and client-cancelled requests are excluded so the denominator reflects real user
intent.

### 37.2.1 The SLO table

| # | Service / journey | SLI (good ÷ valid) | SLO (illustrative) | Window | Measurable today |
|---|---|---|---|---|---|
| 1 | **API availability** (text/system) | non-5xx responses ÷ all valid responses | **99.9%** | 28d | ◐ (logs only; needs F0 metrics) |
| 2 | **API latency** (text) | requests with **p95 < 2.5s** | **99% of windows under p95 2.5s** | 28d | ◐ (no latency histogram yet → F0) |
| 3 | **Image generation latency** | `/api/image/*` with **p95 < 30s** | **95%** | 28d | ❌ (no per-class p95 → F0) |
| 4 | **Build success rate** (Autopilot ACT/VERIFY) | Ticks reaching a clean VERIFY ÷ Ticks that entered ACT (excl. checkpoint-blocked) | **≥ 90%** | 28d | ❌ (engine + `venture_events` not shipped) |
| 5 | **Deploy success** (SHIP) | deployments reaching `live` ÷ deployments attempted | **≥ 98%** managed preview · **≥ 95%** BYO prod | 28d | ❌ (adapters A5; deploy rows TBD) |
| 6 | **Autonomous-tick success** | Ticks completing SENSE→REFLECT without crash/timeout ÷ Ticks scheduled | **≥ 99.5%** | 28d | ❌ (loop A2 + cursor) |
| 7 | **Realtime delivery** | events delivered to a connected client **< 2s** ÷ events emitted to live subscribers | **99%** | 28d | ❌ (SSE today, no instrumentation; DO target F4) |
| 8 | **Readiness correctness** | `/ready` reflects true dependency state (no false-200) | **100%** (correctness, not availability) | continuous | ✅ (`system.ts:322`) |

Notes that make these honest rather than round numbers:

- **Availability vs. latency are separate SLOs.** A slow image route should burn the *image
  latency* budget (SLO 3), not the *API availability* budget (SLO 1). Conflating them hides the
  real failure. This is why image is its own class with a 30s objective — generation is inherently
  long (`alerting-thresholds.md` already treats `/api/image/*` specially).
- **Build success (SLO 4) deliberately excludes checkpoint blocks.** A Tick that stops at a
  `first_production_deploy` checkpoint (§24.6.2) is the system working *correctly*, not a build
  failure. Only genuine `stuck` / `max_iterations` / crash outcomes count against this SLO. A
  *low* build-success number is a quality signal (model/template regression), distinct from an
  availability problem.
- **Tick success (SLO 6) is about the loop's machinery, not the model's judgment.** A Tick that
  correctly DECIDE-pauses on budget is a *success* for SLO 6 — the loop did its job. Only crashes,
  wall-clock timeouts, and unresumable cursors count as failures. This separates "the engine is
  reliable" from "the build worked," which §24.11 also keeps distinct.
- **Realtime (SLO 7) is the riskiest promise today.** §34 / F4 note there is *no real-time at all*
  yet (SSE/poll only, no presence, no instrumentation). The 99%/2s target is the bar for the
  Cloudflare DO + WebSocket Hibernation target topology; until F4, this SLO is unmeasured and
  should be marked N/A rather than reported green.

### 37.2.2 Why these targets, and what they cost

99.9% over 28 days is **~40 minutes** of allowed unavailability per window. That is achievable on a
single-region Railway backend **only if** dependency failures degrade rather than cascade (§37.4) —
a hard Supabase outage with no degradation would blow the monthly budget in one incident. The
99.5% tick-success target is deliberately *higher* than API availability because tick failures are
cheap to retry (the cursor resumes, §24.9) — we hold the loop to a stricter internal bar than the
user-facing API. We do **not** promise 99.99% ("four nines," ~4 min/month) anywhere: it would
require multi-region active-active, which is out of scope until there is an SLA-bearing customer
([§39 performance](./39-performance-scalability.md), [§42 DR](./42-disaster-recovery.md)).

---

## 37.3 Error budgets & burn-rate alerting

### 37.3.1 The error budget

Each SLO implies an **error budget** = `1 − SLO` over the window. The budget is a *first-class
operational currency*: it is spent by incidents, bad deploys, and dependency failures, and it is
the lever that arbitrates "ship faster" vs. "stabilize."

| SLO | Objective | 28-day error budget | Roughly |
|---|---|---|---|
| API availability | 99.9% | 0.1% of requests | ~40 min of full downtime |
| API latency (p95) | 99% of windows | 1% of windows | ~7 h of "too slow" |
| Build success | 90% | 10% of builds | 1 in 10 may fail (excl. checkpoints) |
| Deploy success (managed) | 98% | 2% of deploys | ~1 in 50 |
| Tick success | 99.5% | 0.5% of ticks | resumable, cheap |
| Realtime delivery | 99% | 1% of events | best-effort tier |

**Budget policy (the lever):**

| Budget state | Posture | Action |
|---|---|---|
| **> 50% remaining** | Ship freely | Normal autonomy + normal deploy cadence. |
| **10–50% remaining** | Caution | Review risky changes; prefer reversible deploys; watch burn. |
| **< 10% remaining** | **Freeze** | Halt non-essential deploys to that service; prioritize reliability work; consider lowering global autonomy cadence (§24.4.1) until budget recovers. |
| **Exhausted** | Incident | Treat as an active SLO breach; declare incident if user-facing (§37.7). |

This is the mechanism that keeps an always-on builder honest: if the autonomous engine's deploys
are eating the deploy-success budget, the policy *automatically slows the engine* (back off the
cadence) rather than letting it keep shipping into a degraded state — a reliability application of
the same brake philosophy as §24.7.

### 37.3.2 Burn-rate alerts (multi-window, multi-burn-rate)

Static threshold alerts ("5xx > 3% for 5 min", `alerting-thresholds.md`) are kept as the **fast
backstop**, but the primary alerting model is **burn rate** — how fast we are consuming the error
budget relative to the window. Burn rate `= observed error ratio ÷ (1 − SLO)`. A burn rate of `1`
exactly exhausts the budget at the window's end; `14.4` exhausts it in 2 days.

We use the standard Google-SRE two-window pairs so a page means *both* "burning fast" **and** "still
burning right now" (kills flapping):

| Severity | Burn rate | Long window | Short window | Budget consumed before firing | Maps to existing threshold |
|---|---|---|---|---|---|
| **Page (critical)** | **14.4×** | 1 h | 5 min | ~2% of 28-day budget | `5xx > 3% / 5m` (alerting-thresholds #1) |
| **Page (critical)** | **6×** | 6 h | 30 min | ~5% | p95 `> 5s / 5m` |
| **Ticket (warning)** | **3×** | 24 h | 2 h | ~10% | `5xx > 1% / 10m`, p95 `> 2.5s / 10m` |
| **Ticket (warning)** | **1×** | 72 h | 6 h | slow leak | rate-limit `429 > 5% / 10m` |

The existing static thresholds (`alerting-thresholds.md` §API/Latency/Capacity/RateLimit/Cost) map
cleanly onto these and are **retained verbatim** as the deterministic backstop; the burn-rate layer
adds budget-aware context so we don't page for a blip that the budget can absorb. **All of this is
F0-blocked**: none of these alerts has a signal until the metrics exporter and the 5xx / p95 / 429 /
queue-depth / provider-error counters from [F0](../F-ENTERPRISE-FOUNDATIONS.md) exist
(`/metrics`, `prom-client`). This section *specifies the consumer*; F0 ships the producer.

---

## 37.4 Health, readiness & liveness — shipped vs. gaps

### 37.4.1 What exists (shipped, `server/src/routes/system.ts`)

| Endpoint | What it checks | Verdict |
|---|---|---|
| `GET /api/health` (liveness) | process is up and serving | ✅ shipped; used by the platform health check |
| `GET /api/system/ready` | required env vars present **and** Supabase reachable (with latency); returns **503** when not ready (`system.ts:322`) | ✅ shipped — honest readiness, not a fake 200 |
| `GET /api/system/status` | Supabase capability flags | ✅ shipped |
| `GET /api/system/version` | app version, git SHA, build timestamp, contract version | ✅ shipped (release tagging for incident correlation) |
| `GET /api/system/dashboard` (admin) | capabilities + live tool-API health + dependency limits + rate-limit summary | ✅ shipped (`systemDashboard.ts`) |

The readiness endpoint is genuinely good: it does a real Supabase round-trip, reports `latencyMs`,
and **fails closed (503)** on missing env or an unreachable DB — exactly what a load balancer needs
to pull an unhealthy instance, and exactly what `alerting-thresholds.md` #4 watches.

### 37.4.2 The gaps (needed for the SLOs above)

| Gap | Impact on SLOs | Owed by |
|---|---|---|
| **No worker / Redis liveness** | The BullMQ worker + Redis (`comicforge/queue.ts`) can be dead while `/ready` is green — image/async jobs silently stall, but readiness lies. SLO 3 (image) and SLO 6 (tick) are unprotected. | **F0** (worker liveness: depth, stalled jobs, surfaced in dashboard) |
| **No metrics feed the alerts** | `/ready` is a point-in-time check, not a time-series. The 5xx-rate, p95, 429-ratio, queue-depth signals the burn-rate alerts need (§37.3) do not exist. | **F0** (`/metrics` + counters) |
| **No deep dependency probe** | `/ready` checks Supabase only — not Redis, not the AI gateway, not R2/storage. A provider-key outage shows green. | **F0** + **F1** (provider health) |
| **`/ready` not consumed by SLO computation** | Readiness drives the LB but isn't aggregated into an availability SLI. | **F0** + this section's SLI definitions |

**Recommended readiness extension (F0):** `/ready` should additionally probe Redis (`PING`),
report worker heartbeat age and queue depth, and check AI-gateway provider availability (booleans,
not values — same privacy stance as `system.ts:/diagnostics`). Keep it **fail-closed** so a missing
dependency pulls the instance rather than serving degraded.

---

## 37.5 Graceful degradation — what exists vs. needed

The reliability win is not "never fail" — it is "fail *narrow*." A single dependency outage must
degrade one capability, not take down the platform. The table below grades the existing patterns
honestly.

| Pattern | What it does | Status | Gap / needed |
|---|---|---|---|
| **Free-model fallback** | A flaky free model → retry once on a same-provider `fallbackModel`; under `free-only`, surface the error rather than silently charge a paid model (`openrouter.ts:344`, §29.4) | ✅ shipped (single-call) | **Cross-provider** failover (OpenRouter→NVIDIA) and a **circuit breaker** so a dead upstream fails fast — **F1**, cross-ref §29.6 |
| **Catalog stale-while-revalidate** | Model Library serves fresh→stale memory→durable Supabase mirror→live, revalidating in background; `degraded:true` when serving stale (`modelCatalog.ts:54`) | ✅ shipped (audit strength) | None for catalog; **generalize the pattern** to other read paths (venture lists, dashboards) |
| **Queue 503 handling** | When `REDIS_URL` is unset/unreachable, queue calls throw a typed **503** `COMICFORGE_QUEUE_UNAVAILABLE` instead of crashing (`comicforge/queue.ts:20`) | ✅ shipped (honest 503) | **Liveness signal + backpressure**: 503 should be a *measured* degradation that trips an alert and a queue-full reject, not a silent per-request error — F0/F2 |
| **Supabase reachability gate** | `/ready` reports DB latency + fails closed; per-call code surfaces typed `MISSING_*` 503s (`system.ts:396`) | ◐ partial | **Read-path degradation**: a slow/unreachable Supabase should serve cached data where safe (extend the catalog pattern) rather than hard-fail every read |
| **Tick degradation** | ORIENT LLM garbage → heuristic fallback; DECIDE pauses on budget; no-progress → checkpoint not retry (§24.5.2, §24.7, §24.11) | ◐ designed, A2-blocked | The engine's degradation is *specified and crash-safe by design* but ships with A2; until then it's paper |
| **Image hard-throw** | Image-gen failures currently throw rather than degrade (`openrouter.ts:489`) | ❌ gap | **F1** image-gen retry parity + graceful degradation (return a typed error/placeholder, not a 500) |

**Degradation ladder (the target contract).** For any dependency D, the response to "D is
unhealthy" is, in order: **(1) serve cached/stale** (catalog pattern) → **(2) fail over** to an
alternate (cross-provider, F1) → **(3) shed load** (backpressure, §37.6) → **(4) typed 503 +
`Retry-After`** (queue pattern) → **(5) degrade the feature, not the page** (the app stays up with
one capability disabled). We hard-fail (5xx the whole request) only when none of 1–4 is possible.

---

## 37.6 Rate limiting & backpressure

### 37.6.1 Current state (in-memory — correct only at one instance)

`middleware/rateLimit.ts` is a clean per-`(scope, user|ip)` token bucket: it sets standard
`X-RateLimit-*` + `RateLimit-Policy` headers, returns a typed **429** with `Retry-After` and a
`requestId`, and self-cleans expired buckets. As a *single-instance* limiter it is good.

**The reliability defect is distributed:** the buckets live in a per-process `Map`
(`rateLimit.ts:14`), so with N backend instances the effective limit is **N×** the intended cap
(audit concern #3, [F2](../F-ENTERPRISE-FOUNDATIONS.md)). The same is true of the studio
concurrency caps. The moment we scale past Stage A (1 instance, `scaling-and-cost.md`), limits stop
holding — which directly undermines the abuse/cost protection the kill switch and budget guards
(§24.7) depend on.

### 37.6.2 What F2 fixes, and the backpressure model

| Control | Today | Needed (F2) |
|---|---|---|
| Rate limiter | in-memory `Map` (per-process) | **Redis-backed atomic** counters → one shared limit across all instances |
| Studio concurrency caps | in-memory, with a **fail-open-on-DB-error** gap (`studio.ts:516`) | Redis-backed; **fail-closed** where it's a real cost cap |
| Backpressure | none (a saturated cluster keeps accepting work) | **Reject/queue when saturated**, tied to F0 queue depth + CPU |
| Worker placement | can run in-process with the API (`index.ts:187`) | Worker as its **own Railway service** so build load can't starve the API |

**Backpressure contract.** When the cluster is saturated — queue depth over a high-water mark, CPU
over the `scaling-and-cost.md` trigger (CPU > 70% for 15 min), or Redis unavailable — the API
should **shed load deterministically**: return **429** (`Retry-After`) for rate-classed traffic and
**503** for queue-backed traffic (reusing the existing `COMICFORGE_QUEUE_UNAVAILABLE` shape), and
**defer autonomous-tick admission** (the scheduler's `GLOBAL_CONCURRENCY_CAP`, §24.10.2, already
does exactly this for the loop). Backpressure on the engine is *free* — Ticks are resumable, so a
deferred Tick simply fires next heartbeat. Shedding *cheap, retryable* load to protect *expensive,
user-facing* latency is the whole point: it keeps SLO 1/2 inside budget under spike.

---

## 37.7 Retries, idempotency & circuit breakers (cross-ref F1)

Reliability primitives, graded against the audit. These are specified in depth in
[§29 model gateway](./29-model-gateway.md) (F1) and [§27 REST](./27-api-rest.md) (idempotency); the
SRE view is *which ones the SLOs depend on*.

| Primitive | Status | Detail | SLO it protects |
|---|---|---|---|
| **Exponential backoff retry** | ✅ shipped | `withRetry(op, 3, 1500ms)`, narrow retriable set (`utils.ts`, §29.4) | API availability, build/tick |
| **BullMQ job retries** | ✅ shipped | `attempts: 3`, exponential `1500ms` backoff (`comicforge/queue.ts:5`) | Image latency, tick |
| **Crash-safe resume** | ◐ designed (A2) | durable TickCursor + idempotent phase-keyed writes; at-most-once spend/ship/version (§24.9) | Tick success, deploy success |
| **Idempotency keys** | ❌ gap → **F2** | needed on build/deploy/billing/intake so a retry is a no-op | Deploy success, cost correctness |
| **Circuit breaker** | ❌ gap → **F1** | per-`(provider,model)`; open on sustained failure, fail fast (today `withRetry` always eats the full ~10.5s ladder on a dead upstream, §29.6) | API/build latency, availability |
| **Cross-provider failover** | ❌ gap → **F1** | OpenRouter↔NVIDIA, not just model-on-same-provider | Build success, availability |
| **Per-call timeout budgets** | ◐ partial → **F1** | bound the slowest stage; optional hedging | Latency SLOs |

The reliability point: **retries without a circuit breaker are a liability** — under a sustained
upstream outage, retrying 3× with backoff *amplifies* load on a dead dependency and *burns* the
latency budget (SLO 2/3) on requests that will fail anyway. The breaker (F1) is the missing piece
that converts "fail slow and expensive" into "fail fast and cheap," which is what lets the
degradation ladder (§37.5) reach steps 2–4 quickly instead of timing out.

---

## 37.8 The autonomous engine's reliability (cross-ref §24)

The always-on loop is the highest-stakes reliability surface: it runs unattended, spends money, and
deploys to the public internet. Its SRE properties are fully specified in §24 and summarized here as
the contract this section holds it to.

| Property | Mechanism (§24) | SRE guarantee |
|---|---|---|
| **Crash-safe ticks** | durable `TickCursor` persisted after each phase; resume at `cursor.phase` (§24.9) | A worker/DO restart loses no work and **never double-spends or double-ships** (idempotent, content-/key-addressed writes) |
| **No-progress detection** | inner `buildGuards` `STUCK_REPEAT_LIMIT=3` promoted to the outer cross-Tick detector (§24.7) | A genuinely stuck goal raises a checkpoint and **stops** — it does not burn budget looping forever |
| **Bounded runs** | `MAX_TICKS_PER_RUN` + per-tick wall-clock timeout (§24.7) | No infinite run; a hung phase aborts, persists the cursor, and resumes next beat |
| **Kill switch** | one global flag `VENTURES_KILL` checked at scheduler + DECIDE (§24.7) | An operator can **halt all autonomy** instantly — the ultimate reliability backstop |
| **Concurrency cap** | `GLOBAL_CONCURRENCY_CAP` admission gate (§24.10.2) | The loop can't stampede providers or the bill; excess Ticks defer (backpressure, §37.6) |
| **Per-venture serialization** | one VentureDO (single-threaded) / BullMQ job lock per venture (§24.9) | Two Ticks for one venture never interleave → the cursor is never raced |
| **Queue/Redis outage tolerance** | cursor lives in Postgres; Ticks pause, resume when Redis recovers; DO realization is immune (§24.11 #10) | A Redis outage **pauses progress without losing work** — it does not corrupt state |
| **Replay-safe gate** | DECIDE is deterministic, LLM-free, reads only durable state (§24.6.1) | A resumed Tick re-decides identically → the loop is auditable and replayable end-to-end |

The kill switch and the budget/no-progress guards are the engine's analogue of the error-budget
freeze policy (§37.3.1): when autonomy is consuming the *deploy-success* or *cost* budget faster
than the window allows, the response is to **slow or stop the engine**, deterministically, before a
human is even paged. The engine is "reliable by construction" only **once A0 (brakes) + A2 (loop) +
F0 (so we can see it)** have shipped — until then, this row of the table is design, not running
code, and the loop must not wire real autonomous builds (the hard rule in §24.1 / F-series
sequencing: **F0 → F1 → F2 before A2**).

---

## 37.9 Incident response, on-call & runbooks (cross-ref §50)

SLOs only matter if a breach triggers a *response*. The lightweight incident model below scales
from a solo owner today to an on-call rotation later; the step-by-step procedures live in
[§50 runbooks](./50-runbooks.md).

### 37.9.1 Severity ladder

| Sev | Definition | Examples | Response target |
|---|---|---|---|
| **SEV-1** | Platform-wide outage or data risk | API down (`/health` failing, alerting-thresholds #3), Supabase outage, cross-tenant leak suspected, runaway spend | **Page now**; declare incident; kill switch if autonomy-related |
| **SEV-2** | Major degradation, budget burning fast | 14.4× burn on availability/latency, worker/Redis down (images stalled), provider all-down | **Page**; mitigate within the hour |
| **SEV-3** | Partial / single-feature degradation | one provider down with failover, elevated 429s, one venture stuck | **Ticket**; handle in business hours |
| **SEV-4** | Cosmetic / slow leak | 1× burn, non-blocking errors | **Backlog** |

### 37.9.2 On-call & the incident loop

- **Owner-as-on-call today** (per [§48 team/RACI](./48-team-raci.md), planned). Pages route via
  Sentry alerts (F0) → email/SMS; the burn-rate `Page` rows (§37.3.2) are the only things that wake
  a human. Everything else is a ticket. **This requires F0** — there is no paging path until error
  tracking + alerting exist.
- **Incident loop:** Detect (alert/burn-rate) → **Declare** (sev + a single incident channel) →
  **Mitigate first** (degrade/failover/kill-switch/rollback — *stop the bleeding before
  diagnosing*) → **Diagnose** (logs by `requestId`, traces, the audit log — all F0) → **Resolve** →
  **Blameless postmortem** for SEV-1/2 with an error-budget impact note and concrete follow-ups.
- **Mitigation levers, in order of reach-for:** (1) **kill switch** for any autonomy-driven
  incident (§24.7); (2) **roll back** the last deploy (git SHA from `/version` correlates the
  release, `system.ts:31`); (3) **lower autonomy cadence** / freeze deploys per budget policy;
  (4) **scale** per the `scaling-and-cost.md` triggers; (5) **shed load** via backpressure (§37.6).

### 37.9.3 Runbooks (the must-have set — owned by §50)

Each runbook is a deterministic checklist a half-asleep operator can follow. The reliability-
critical set: **API down**, **Supabase unreachable**, **Redis/worker down (images stalled)**,
**provider outage / all-models-down**, **runaway spend / cost spike**, **autonomous engine
misbehaving (invoke kill switch)**, **cross-tenant access suspected**, **bad deploy rollback**.
Each names the alert that fires it, the SLO it protects, the mitigation lever, and the verification
step. Cross-referenced from [§50](./50-runbooks.md); the engine-specific recovery paths are already
enumerated in [§24.11](./24-autonomous-engine.md) (12 failure modes → recovery).

---

## 37.10 Capacity & headroom

Reliability is partly a capacity question: an SLO breach is often just "we ran out of room." Two
horizons, honestly distinct.

### 37.10.1 Today — single-region Railway (transition realization)

Per [`scaling-and-cost.md`](../../production/scaling-and-cost.md), the current backend scales in
manual stages, with documented triggers:

| Stage | Active users | Backend | Headroom action |
|---|---|---|---|
| A | up to 100 | 1 instance | baseline |
| B | 100–500 | 2 instances | **requires F2** (shared limits) to stay correct |
| C | 500–1000 | 2–3 API instances | evaluate async image queue (already built: `comicforge/`) |

Scaling triggers (kept as-is): p95 > 2.5s/10m → scale; CPU > 70%/15m → +1 replica; 429 > 8% +
complaints → tune limits + capacity; image timeout > 10% → queue/worker decision. **Critical
coupling:** moving from Stage A to B is *blocked on F2* — adding a second instance without the
shared Redis limiter multiplies every rate/concurrency cap by 2 and breaks the abuse/cost
guarantees the SLOs assume. Capacity growth and distributed-correctness ship together, not
separately.

### 37.10.2 Target — Cloudflare (ARCHITECTURE-CLOUDFLARE)

The target topology has **abundant** headroom, which changes the capacity story from "babysit
replicas" to "pay for work, not idle":

| Tier | Cloudflare headroom (per ARCHITECTURE-CLOUDFLARE) | Reliability implication |
|---|---|---|
| **Containers** (build farm / muscle) | concurrency ceiling raised 15× (2026-02-25): **6 TiB mem, 1,500 vCPU, 30 TB disk → ~1,000+ concurrent `standard-2`** (or 6,000 `basic`) | Real multi-tenant build-farm scale; SLO 4/5 capacity is not the bottleneck — **warm-pool** for cold-start UX is the open item |
| **Workers** (edge tier) | up to **5 min CPU/request**; global edge; auto-scaled | API/preview availability (SLO 1) scales without replica management |
| **Durable Objects** (coordinator + tick heartbeat) | one DO per venture/user; **Alarms** drive ticks; **WebSocket Hibernation** = no billing while idle | Tick success (SLO 6) + realtime (SLO 7) get serialization + cheap always-on for free |

The Cloudflare move turns "always-on" into an *Alarm*, not an idle server (§24.4.1), so an idle
venture costs almost nothing and a 1,000-venture spike has headroom by construction. Headroom is no
longer the reliability risk in the target topology; **observability of it (F0) is**, because you
can have all the capacity in the world and still breach an SLO you can't see.

---

## 37.11 Mapping to foundations & autonomy

| This section needs | Provided by | Status |
|---|---|---|
| Metrics, error tracking, tracing, worker/Redis liveness, alert signals | **F0** observability | 📋 planned — **hard dependency** of every SLI here |
| Circuit breaker, cross-provider failover, image retry parity, provider metrics | **F1** provider reliability | 📋 planned (cross-ref §29.6) |
| Shared (Redis) rate/concurrency limits, idempotency keys, backpressure, worker-as-service | **F2** distributed correctness | 📋 planned — gates Stage A→B scaling |
| Crash-safe ticks, no-progress, kill switch, bounded runs, concurrency cap | **A0** brakes + **A2** loop | 📋 planned (spec'd §24.7/§24.9) |
| Independent reliability/tenant-isolation audit before GA | **A9** GA gates | 📋 planned |
| Incident procedures / runbooks | **§50** runbooks | 📋 planned |

## 37.12 Acceptance criteria

Reliability & SRE is "done" (for the foundation tier) when:

1. **SLOs are measured, not aspirational.** Each SLI in §37.2 has a live signal from F0; the 28-day
   ratios are computed and visible on a dashboard. (Blocked on F0.)
2. **Burn-rate alerts fire.** The multi-window pairs in §37.3.2 page on fast burn and ticket on slow
   burn, with the static `alerting-thresholds.md` rules retained as backstop. (Blocked on F0.)
3. **Readiness is deep and fail-closed.** `/ready` probes Supabase **and** Redis/worker **and**
   provider availability; a dead worker turns it 503 (no false-green). (Extends `system.ts`, F0.)
4. **Limits hold across instances.** A load test across 2 instances enforces *one* shared rate/
   concurrency limit; backpressure sheds load deterministically under saturation. (F2.)
5. **Degradation is narrow.** A killed provider key fails over (not down); a Supabase blip serves
   cached reads; a Redis outage returns typed 503 + pauses ticks without losing work. (F1/F2/§24.)
6. **The engine respects the budget.** Budget/no-progress/kill-switch guards demonstrably stop or
   slow autonomy before a human is paged; a resumed Tick neither double-spends nor double-ships.
   (A0/A2, §24 acceptance.)
7. **Incidents have a path.** A SEV-1 pages, has a runbook (§50), and produces a blameless
   postmortem with an error-budget impact note.

> **Stance (restated):** SLOs are a promise you can only keep if you can see it, fail narrow, and
> stop the bleeding faster than the budget drains. Today we have honest health/ready endpoints and a
> written threshold table with nothing feeding it — so the first reliability deliverable is **F0**,
> not a higher number. The engine's brakes (§24.7) and the degradation ladder (§37.5) are what let
> an always-on autonomous builder live inside these objectives instead of becoming the incident.
