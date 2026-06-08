# 24 — The Autonomous Engine (Deep)

> Part III · Architecture · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan](../00-MASTER-PLAN.md) (§4 the loop, §8 guardrails, Epics A2/A4/A6) ·
> [Agentic Build Engine](../../04-AGENTIC-ENGINE.md) (the inner PLAN→ACT→RUN→OBSERVE→FIX) ·
> [Agentic Swarm](../../10-AGENTS-SWARM.md) (the code agent) ·
> [Domain Model](./09-domain-model-glossary.md) (Tick/Run/Goal/Checkpoint/Event state machines) ·
> [Cloudflare Topology](../ARCHITECTURE-CLOUDFLARE.md) (DO Alarms · Workflows · Containers)

## 24.1 What this section is, and what it is not

This is the engineering specification of the **brain** of Autopilot: the always-on loop that
takes a Venture from "approved roadmap" to "shipped, observed, and improving" without a human in
the chair, while never spinning forever and never outspending a budget. Everything else in the
product exists to feed, govern, or display this loop.

Two honesty notes frame the whole section:

1. **The loop is mostly orchestration over assets that already exist.** The genuinely hard,
   expensive parts — sandboxed execution (`studio-worker/`), the inner build loop
   (`server/src/ai/studio/buildAgent.ts`), multi-model routing (`autoRouter.ts`), metering
   (`costEstimator.ts` → `billingLedger.ts`), and the swarm code agent
   (`server/src/ai/agents/orchestrator.ts`) — are **built and shipped**. This section's job is the
   *governance + durability + scheduling* wrapper around them (Master Plan §3). The novelty is
   "always-on, crash-safe, budgeted," not "can write code."
2. **The brakes ship before the engine.** Per Master Plan §8 and Epic sequencing (A0 → A2), every
   guard in §24.7 must exist and be tested *before* the first real Tick runs. The engine is "safe
   by construction": there is no code path from ACT to spending money or publishing that does not
   pass through the deterministic DECIDE gate (§24.5) first.

The inner loop — PLAN→ACT→RUN→OBSERVE→FIX from [04-AGENTIC-ENGINE](../../04-AGENTIC-ENGINE.md) —
is **wholly contained inside one phase of this loop** (ACT/VERIFY, §24.6.4–24.6.5). Do not confuse
the two: the *outer* loop in this section decides *which goal to build and whether it is allowed*;
the *inner* loop decides *how to make that one goal's code compile and run*.

---

## 24.2 The OODA-style loop in full

Autopilot's loop is an OODA cycle (Observe-Orient-Decide-Act) extended with the three phases an
autonomous *builder* needs that a pure decision loop lacks: VERIFY (you must prove the work is
sound before it leaves the sandbox), SHIP (the work must reach the world), and REFLECT (the loop
must learn and persist so the next Tick is cheaper and smarter). The canonical seven phases:

```
   ┌──────────────────────────── ONE TICK (resumable · metered · logged) ─────────────────────────────┐
   │                                                                                                    │
   │  SENSE ──► ORIENT ──► DECIDE ──► ACT ──────────► VERIFY ──► SHIP ──────────► REFLECT ──► (sleep)    │
   │   │          │          │         │                │          │                 │                  │
   │  gather    LLM (cheap  pure gate │ inner build    typecheck  deploy via         append events,     │
   │  signals:  model):    no LLM:    │ loop + swarm   build      adapter; managed    update goals,      │
   │  backlog,  assess vs  budget?    │ code agent →   tests,     preview auto;       record cost +      │
   │  health,   roadmap;   checkpoint?│ new studio_    preview     prod = behind a     learnings;        │
   │  errors,   pick next  in scope?  │ version on     health,     CHECKPOINT          set next alarm /   │
   │  analytics highest-   safe?      │ success        safety+      (human gate)        await trigger      │
   │            value goal            │                secret scan                                       │
   │                                                                                                    │
   │  GUARDS (evaluated at DECIDE + continuously): budget caps · checkpoint gates · scope guard ·       │
   │  no-progress detector · max ticks/run · wall-clock per tick · global kill switch · concurrency cap │
   └────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Mapping to classic OODA, so the design intent is explicit:

| OODA | Autopilot phase(s) | Why we split / extend it |
|---|---|---|
| **Observe** | SENSE | Gather raw signals (backlog, deploy health, runtime errors, analytics, feedback). |
| **Orient** | ORIENT | The only "creative" LLM step in the outer loop: turn signals into a *chosen goal* + rationale. |
| **Decide** | DECIDE | Pulled out as a **separate, deterministic, no-LLM gate** so the brakes can't be hallucinated past. |
| **Act** | ACT + VERIFY + SHIP | Building, proving, and publishing are three failure-distinct sub-acts; each is durably checkpointed. |
| *(feedback)* | REFLECT | Persist outcomes, update goals/learnings, meter cost, and schedule the next cycle. |

The two design decisions that make this enterprise-grade rather than a demo:

- **DECIDE is deterministic and LLM-free.** ORIENT may *propose* anything; DECIDE *permits* only
  what budget, scope, checkpoint policy, and safety allow. A confused or adversarial model cannot
  argue its way past the gate, because the gate is pure code reading durable state (§24.5).
- **Every phase boundary is a durable checkpoint.** A crash between any two phases resumes from the
  last persisted phase, never re-charges for completed work, and never double-ships (§24.9).

---

## 24.3 The anatomy of a Tick

A **Tick** is the atomic, resumable, metered, logged unit of autonomy — one full pass SENSE→…→
REFLECT against (usually) one Goal. It is the contract every other part of the system is written
against. Per [§9.3](./09-domain-model-glossary.md), a Tick is **logical**: it owns no table; it is
a correlated span of `venture_events` within a Run. This keeps the model lean and append-only.

### 24.3.1 Inputs, outputs, durable state

```
INPUTS (read at tick start, all owner-scoped by venture_id + user_id)
  ├─ Venture row          status, scope, autonomy_level, primary_project_id
  ├─ Budget row           caps + rolling spend counters (the spend brake)
  ├─ Open Checkpoints     anything blocking the venture or a goal
  ├─ Goals (backlog)      proposed | queued | in_progress | blocked
  ├─ Signals (A6)         deploy health, runtime errors, analytics, feedback
  ├─ Last Run/Tick state  resume cursor: { phase, goal_id, tick_number, inner_state }
  └─ Kill switch          VENTURES_KILL (global) + per-venture pause flag

OUTPUTS (all writes are idempotent + keyed by tick_number)
  ├─ venture_events[]      one per phase: kind ∈ {sense,orient,decide,act,verify,ship,reflect,...}
  ├─ Goal mutation         status transition (§9.4) + result
  ├─ studio_version        on successful ACT (a real code snapshot)
  ├─ studio_deployment     on SHIP (managed preview auto; prod gated)
  ├─ Checkpoint            raised when DECIDE blocks (budget/scope/safety/irreversible)
  ├─ Metering              cost rows tagged venture_id → Budget spend counters updated
  └─ Next schedule         DO Alarm at next tick time, OR await external trigger

DURABLE STATE (the resume cursor — survives worker/DO restart)
  TickCursor { run_id, tick_number, phase, goal_id?, inner_build_state?, started_at }
  Persisted after EACH phase. On restart the scheduler reads it and resumes at `phase`.
```

### 24.3.2 The phase ladder (durable, resumable)

Each phase persists a cursor advance *before* moving on. The ladder is strictly ordered; a phase
may **short-circuit to REFLECT** (e.g. DECIDE blocks → write a checkpoint event → REFLECT → sleep)
without skipping accounting.

```
  start ─► [SENSE] ─► [ORIENT] ─► [DECIDE] ──allow──► [ACT] ─► [VERIFY] ─► [SHIP] ─► [REFLECT] ─► end
                                     │ block                      │ fail              │
                                     └────────────────────────────┴───────────────────┴──► [REFLECT] ─► end
   (every "──►" persists the cursor; a crash resumes at the last persisted phase)
```

### 24.3.3 Metering — every Tick pays its own way

Metering is not an afterthought; it is woven through the Tick because **spend caps are a security
control** ([§9.3 Budget](./09-domain-model-glossary.md)). The rule: *the loop reads the budget
before it spends and updates it after.*

| Phase | What it can cost | Metered via | Tag |
|---|---|---|---|
| SENSE | ~0 (DB reads + signal fetch) | n/a | — |
| ORIENT | 1 cheap-model LLM call | `costEstimator.ts` → `billingLedger.ts` | `venture_id`, `kind:orient` |
| DECIDE | 0 (pure code) | n/a | — |
| ACT | inner build loop tokens + container-minutes | `studio_runs.cost_usd` + token meter | `venture_id`, `kind:act` |
| VERIFY | typecheck/test container-minutes + scan | `studio_runs.cost_usd` | `venture_id`, `kind:verify` |
| SHIP | adapter compute (+ managed hosting) | adapter result → ledger | `venture_id`, `kind:ship` |
| REFLECT | optional cheap summarize call | `billingLedger.ts` | `venture_id`, `kind:reflect` |

Every metered amount lands on a `venture_event` (`cost_usd`, `model`, `prompt_hash`) **and** rolls
into `venture_budgets.spent_usd_today` / `spent_usd_total` in the same transaction as the REFLECT
write, so the audit trail and the brake can never disagree.

---

## 24.4 How the loop maps onto the platform primitives

The loop is **runtime-agnostic by interface** (Master Plan A2 builds the orchestrator behind an
interface). Two concrete realizations exist; both implement the same phase ladder.

```
                        the autonomous loop (this section, interface)
                                       │
        ┌──────────────────────────────┴───────────────────────────────┐
        ▼ realization 1 (now / transition)                              ▼ realization 2 (target, ARCHITECTURE-CLOUDFLARE)
  ┌────────────────────────────┐                            ┌─────────────────────────────────────────┐
  │ Railway + BullMQ + ioredis │                            │ Cloudflare DO + Workflows + Containers   │
  │ (mirrors comicforge/)      │                            │                                          │
  │ scheduler.ts repeatable    │   heartbeat / schedule     │ VentureDO.alarm()  ── tick heartbeat     │
  │ job → tick.ts              │ ◄────── maps to ─────────► │ (one DO per venture, Alarms API)         │
  │ studio-worker/ sandbox     │   durable ACT/VERIFY       │ Workflow per build goal (auto-retry,     │
  │ for code execution         │ ◄────── maps to ─────────► │ state-persisted, resumable) → Container  │
  └────────────────────────────┘   live activity stream     └─────────────────────────────────────────┘
                                  ◄────── maps to ─────────►   DO WebSocket Hibernation (vs SSE/poll)
```

### 24.4.1 VentureDO Alarms — the heartbeat & scheduling

In the target topology ([ARCHITECTURE-CLOUDFLARE §3](../ARCHITECTURE-CLOUDFLARE.md)), there is
**one `VentureDO` per venture**. The DO's **Alarm API** is the tick heartbeat: at the end of
REFLECT the loop calls `state.storage.setAlarm(nextTickAt)`; Cloudflare wakes the DO at that time
and `alarm()` runs the next Tick. This replaces a cron runner entirely — *"always-on" emerges from
the Alarm, not from an idle server.* The DO is single-threaded per object, which gives **per-venture
serialization for free**: two Ticks for the same venture can never interleave, so the resume cursor
is always consistent. The cadence is dynamic, not fixed:

- **Active backlog, healthy** → short interval (e.g. immediately re-arm to keep building).
- **Idle / nothing to do** → long interval (e.g. hourly health poll), so an idle venture costs
  almost nothing.
- **External trigger** (webhook, user message, signal POST, "resume" from the Console) → the
  control plane pokes the DO to fire its alarm early, collapsing latency.
- **Paused** (budget/checkpoint/kill/stuck) → no alarm armed; the venture sleeps until the cause
  clears, then the Console/control plane re-arms it.

In the transition realization, the same heartbeat is a **BullMQ repeatable job** in
`server/src/ventures/scheduler.ts` that enqueues a tick per active, non-paused, in-budget venture
(mirroring `server/src/comicforge/queue.ts`). The *interface* the loop is written against —
`schedule(ventureId, atMs)` and `onTick(ventureId)` — is identical, so swapping BullMQ for DO
Alarms is a backend change, not a loop rewrite.

### 24.4.2 Workflows — durable ACT & VERIFY

ACT and VERIFY are the long, failure-prone, expensive phases — they span minutes to hours and
involve `npm install`, dev servers, and multiple model calls. In the target topology each build
goal becomes a **Cloudflare Workflow**: `step plan → step write → step run(container) → step
observe → step fix → step verify`. Workflows give us **automatic retries + state persistence +
resumability across restarts** for exactly the part of the loop that most needs it. If the worker
dies mid-`npm install`, the Workflow resumes that step; the outer Tick cursor only records "ACT
in-progress, workflow_id=W," and on resume it reattaches to the running Workflow rather than
re-billing from scratch.

In the transition realization, ACT/VERIFY simply call the existing in-process build loop
(`runBuildAgent` from `buildAgent.ts`) which already implements the same plan→run→observe→fix loop
with guards (`buildGuards.ts`); the durability is coarser (re-run the goal on crash, bounded by the
inner iteration cap) but the contract is the same.

### 24.4.3 The existing build loop & the swarm code agent — ACT's muscle

ACT does not contain build logic; it **delegates** to the shipped engine:

- For a normal goal, ACT calls `runBuildAgent(initialFiles, { run, fix }, { maxIterations })`
  ([buildAgent.ts](../../../../server/src/ai/studio/buildAgent.ts)). `run` launches the project in
  the `studio-worker/` sandbox and returns a `RunResult`; `buildObservation`
  ([observation.ts](../../../../server/src/ai/studio/observation.ts)) structures the signals;
  `fix` ([studioFix.ts](../../../../server/src/ai/studio/studioFix.ts)) asks the model for minimal
  diffs; `buildGuards.ts` decides when to stop (clean, `max_iterations`, or `stuck`).
- For a *larger / multi-component* goal, ACT routes through the **swarm's `code` agent**
  ([orchestrator.ts](../../../../server/src/ai/agents/orchestrator.ts), Master Plan A4 +
  [10-AGENTS-SWARM §E](../../10-AGENTS-SWARM.md)) which decomposes the goal before driving the same
  build loop. The swarm already runs planner + agents on a cheap model and merges usage for
  accurate billing — the loop inherits that cost discipline.

Crucially, the inner loop's `stuck` result (`buildGuards.ts` `STUCK_REPEAT_LIMIT`) is **promoted**
to the outer loop's no-progress detector (§24.7): when the inner build gives up, the outer Tick
does not silently retry — it raises a checkpoint and pauses the goal.

---

## 24.5 ORIENT — goal selection (the one creative step)

ORIENT is the only step in the outer loop where a model decides anything, and it runs on a
**cheap, cost-aware model** (the same routing the swarm planner uses,
[autoRouter.ts](../../../../server/src/ai/autoRouter.ts) `pickTextModel`). Its job is narrow:
*given the venture state and signals, choose the single next highest-value Goal and explain why,
or propose a new in-scope goal.* It does **not** build, deploy, or spend; those are downstream and
gated.

### 24.5.1 The selection model

ORIENT scores candidate goals and picks one. The score is a transparent, auditable function — the
LLM supplies the soft judgments (value, effort) inside a deterministic frame:

```
  score(goal) = value(goal) * readiness(goal) / effort(goal)

    value      ∈ 1..5   business/user impact toward success_metrics      (LLM judgment)
    readiness  ∈ {0,1}  dependencies satisfied AND not checkpoint-blocked (deterministic)
    effort     ∈ 1..5   estimated work / token+compute cost              (LLM judgment, capped)

  pick = argmax(score) over { queued goals } ∪ { new in-scope goals proposed from signals }
  tie-break: explicit priority field, then oldest proposed_at (FIFO fairness)
```

`readiness` is computed in code (not trusted to the model) from `dependencies` and open
checkpoints, so a goal with unmet deps can never be selected even if the model "wants" it. New
goals proposed from **signals** (A6: a runtime error → a fix goal; slow page → a perf goal) enter
the same scoring, which is how "never stop *iterating*" works without thrashing.

### 24.5.2 The cheap-model prompt strategy

ORIENT must be cheap (it runs every Tick) and reliable (its output gates real spend). The strategy:

- **Small, structured context.** Feed only: venture name + summary + `scope`, `success_metrics`,
  the top N queued goals (title/kind/priority/deps/last-result), a compact signals digest, and the
  last Tick's outcome. Never the codebase. This keeps the prompt tiny and the model fast/cheap.
- **JSON-only output, validated.** The model returns
  `{ goal_id? , new_goal? , rationale, value, effort, confidence }`, parsed via the existing
  `ai/json.ts` / `jsonCoerce.ts` (the swarm uses `coerceJsonOrNull` the same way). On parse
  failure → one retry, then a **deterministic heuristic fallback** (highest-priority ready queued
  goal), mirroring the swarm's `selectAgentsHeuristic`. ORIENT never blocks the loop on a flaky LLM.
- **Scope guard in the prompt and in code.** The prompt states the approved `scope` and forbids
  proposing outside it; DECIDE then re-checks in code (defense in depth, §24.5.3). If the model
  proposes out-of-scope work it is *not* executed — it becomes a **scope-change checkpoint**.

```
ORIENT prompt (sketch — cheap model, JSON-only)
─────────────────────────────────────────────────────────────────────
SYSTEM: You are the planner for one autonomous product venture. Choose the
        single next highest-value goal. Stay strictly within SCOPE. Prefer
        unblocking shipped value over inventing features. Return ONLY JSON.
VENTURE: {name} — {summary}
SCOPE (hard boundary): {scope}
SUCCESS METRICS: {success_metrics}
QUEUED GOALS: [{id,title,kind,priority,deps,last_result}...]   (top N)
SIGNALS: {compact digest: errors=…, uptime=…, feedback=…}      (A6)
LAST TICK: {goal,outcome,cost}
RETURN: {"goal_id"|"new_goal":{...}, "rationale","value","effort","confidence"}
─────────────────────────────────────────────────────────────────────
```

### 24.5.3 Outputs of ORIENT

ORIENT writes a single `kind:orient` event (rationale, chosen goal, value/effort/confidence,
model, prompt_hash, cost) and updates goal priorities. Its chosen goal + a derived
**proposed action** (`build` | `fix` | `deploy-preview` | `deploy-prod` | `provision` |
`scope-expand`) are handed to DECIDE. ORIENT *proposes*; DECIDE *disposes*.

---

## 24.6 DECIDE and the action phases

### 24.6.1 DECIDE — the deterministic gate

DECIDE is **pure code, no LLM** — this is the single most important safety property of the engine
(Master Plan §8). It evaluates four gates in order against durable state; the **first** failing
gate blocks and short-circuits to REFLECT (writing a `kind:decide` event with the block reason and,
where applicable, raising a checkpoint):

```
function decide(venture, budget, action, goal, scope): Decision {
  // 1) BUDGET — spend brake (a security control, §9.3)
  const est = estimate(action)                          // tokens + container-minutes → USD
  if (budget.spent_usd_today + est > budget.usd_per_day)  return pause('budget:day')
  if (budget.spent_usd_total + est > budget.usd_total)    return pause('budget:total')
  if (overTokenOrMinuteCap(budget, est))                  return pause('budget:resource')

  // 2) CHECKPOINT — human gate on irreversibles (§8: prod deploy, spend money,
  //    destructive op, external publish, scope change, roadmap approval)
  if (requiresCheckpoint(action))                         return checkpoint(checkpointType(action))

  // 3) SCOPE — ORIENT may not pursue work outside the approved venture scope
  if (!withinScope(goal, scope))                          return checkpoint('scope_change')

  // 4) SAFETY — kill switch + venture pause flag (re-checked here, not only at schedule)
  if (killSwitchOn() || venture.paused)                  return pause('kill')

  return allow(action)                                   // → ACT
}
```

DECIDE is exhaustively unit-tested (Epic A0 acceptance): budget breach pauses; each checkpoint type
fires for the right action; out-of-scope work is gated; kill switch honored. Because it reads only
durable rows and pure config, it is *replayable* — given the same state it always decides the same
way, which is what makes the whole loop auditable.

### 24.6.2 The checkpoint taxonomy (when DECIDE stops for a human)

| Checkpoint type | Triggering action | Always required? |
|---|---|---|
| `roadmap_approval` | First activation of a venture (A3) | Yes — before any autonomous work |
| `first_production_deploy` | `deploy-prod` / custom-domain go-live | Yes |
| `spend_money` | Paid provider resource, domain purchase, paid API beyond budget | Yes |
| `destructive_op` | Delete a DB/resource/deployment, drop data | Yes |
| `external_publish` | Anything putting the user's brand in public | Yes |
| `scope_change` | Work materially outside approved `scope` | Yes |

A raised checkpoint sets the goal `blocked` and (if it blocks the run) pauses the venture with
reason `checkpoint`. It lands in the Operator Console approval queue and notifies the owner
(in-app + email). Independent goals may continue if nothing else is blocked.

### 24.6.3 ACT — build the chosen goal

On `allow`, ACT dispatches the goal to the inner engine (§24.4.3) against the venture's
`studio_project`. On a clean build it creates a new `studio_version`; on `stuck`/`max_iterations`
it returns control to the outer loop, which routes to a no-progress checkpoint (§24.7). ACT is the
phase wrapped in a Workflow (target) for durability. It emits a `kind:act` event with the iteration
count, the inner `BuildAgentResult.reason`, and metered cost.

### 24.6.4 VERIFY — prove it before it leaves the sandbox

VERIFY is the gate between "code exists" and "code may ship." It runs, in order, and **all must
pass**:

```
  typecheck/build  → verifyApp.ts + tsc/build in the sandbox
  tests            → project test suite (if present)
  preview health   → GET / returns 2xx (observation.ts http probe)
  code-safety scan → committed-secret detection, dangerous-op patterns (rm -rf, eval,
                     network exfiltration), dependency audit  (A9; basic in A4)
```

A VERIFY failure with FIX budget remaining loops back into ACT's inner FIX (bounded by the
iteration cap); a VERIFY failure past the cap fails the goal (or raises a checkpoint if stuck). The
code-safety scan is a **hard** gate — a detected committed secret blocks SHIP unconditionally,
regardless of autonomy level. VERIFY emits `kind:verify` with the pass/fail of each sub-check.

### 24.6.5 SHIP — publish via an adapter

SHIP deploys the verified build through a provider-agnostic **Adapter** (Master Plan §6, Epic A5):

- **Managed preview** (`managed-preview` adapter wrapping `studio-worker/`) is **automatic** — no
  credentials, no checkpoint — giving the "few clicks → it's live" wow.
- **Production** deploys (BYO Cloudflare/Vercel/Railway via `venture_connections`/Nango) are
  **always behind a `first_production_deploy` checkpoint** — DECIDE already gated this in 24.6.1, so
  by the time SHIP runs for prod, the human has approved.

SHIP records a row in extended `studio_deployments` (`venture_id`, `goal_id`, `is_production`),
updates `ventures.deploy_url`, runs a post-deploy health check, and emits `kind:ship`. Deploy
tokens are per-venture, least-privilege, and never logged.

### 24.6.6 REFLECT — persist, learn, schedule

REFLECT is the close of the cycle and the start of the next:

```
  REFLECT:
    1. append venture_events for the tick's outcome (what/why/result/cost/model/prompt_hash)
    2. transition the Goal (§9.4): shipped | failed | blocked | back-to-queued
    3. update Budget spend counters (same txn as the event write — never disagree)
    4. record learnings (compact, e.g. "stack X needs dep Y"; cheap optional summarize)
    5. update goal priorities / enqueue follow-up goals from signals (within scope)
    6. decide cadence → setAlarm(nextTickAt) OR await external trigger; if a pause cause
       exists, arm NO alarm (venture sleeps until the cause clears)
```

Learnings are the seed of cheaper future Ticks: a recorded "this template always needs
`@types/node`" lets a later ORIENT/ACT avoid the same FIX round. They are stored compactly on the
venture (not as raw transcripts) to keep cost and context small.

---

## 24.7 Guards (the brakes — always on, deterministic)

Per Master Plan §8, guards are **deterministic, no-LLM**, and ship in Epic A0 before the loop in
A2. They are evaluated at DECIDE *and* continuously (the scheduler re-checks them before admitting
any Tick).

| Guard | Where enforced | Trip condition | On trip |
|---|---|---|---|
| **Budget caps** | DECIDE + REFLECT | est. spend would exceed `usd_per_day`/`usd_total`/token/minute cap | Pause venture (`budget`); notify; arm no alarm |
| **Max ticks per run** | scheduler + tick start | `run.ticks_count ≥ max_ticks` | Complete the Run cleanly (`stop_reason:max-ticks`) |
| **Wall-clock per tick** | tick runner (timeout) | a phase exceeds the per-tick deadline | Abort the tick; persist cursor; resume next schedule |
| **No-progress detector** | after ACT/VERIFY | same goal/error signature repeats N× (inner `stuck` promoted) | Block goal; raise a checkpoint; do **not** retry |
| **Global kill switch** | scheduler + DECIDE | `VENTURES_KILL=true` (one flag) | Halt **all** ventures; admin route flips it |
| **Concurrency cap** | scheduler | global concurrent Ticks ≥ cap | Defer admission; re-evaluate next heartbeat |
| **Scope guard** | ORIENT prompt + DECIDE | proposed goal outside approved `scope` | Raise `scope_change` checkpoint; do not execute |

The no-progress detector is the bridge between the inner and outer loops: `buildGuards.ts` already
detects a repeated error signature inside one build (`STUCK_REPEAT_LIMIT = 3`); the outer detector
catches the *cross-Tick* case where the same goal keeps failing across separate Ticks, and escalates
to a human rather than burning budget on a problem the model demonstrably cannot solve. The kill
switch and concurrency cap protect the *platform and the bill* (managed hosting means we carry abuse
risk, Master Plan §11); budget/scope/no-progress protect the *individual venture*.

---

## 24.8 SENSE — the signal sources (Epic A6)

SENSE is "Observe" — it gives the loop eyes so ORIENT chooses *improvements*, not just the next
backlog item. Until A6 lands, SENSE = backlog + last-run result (Master Plan A2). With A6, SENSE
ingests real signals, all owner-scoped and rate-limited:

| Source | How it arrives | Becomes | Honesty note |
|---|---|---|---|
| **Open backlog** | DB read of `venture_goals` | candidate goals for ORIENT | Always available (A2). |
| **Deploy / uptime health** | scheduled check per live deployment (extends `verification/runner.ts`) | health signal; failing → fix goal | Managed first; BYO via adapter status. |
| **Runtime errors** | tiny error-collector injected into deployed apps → `POST /api/ventures/:id/signals` | error signal → fix goal proposal | Rate-limited, owner-scoped; opt-in for BYO. |
| **Basic analytics** | page-view / event hook → signals | usage signal (perf/UX goals) | Lightweight; deeper analytics is later. |
| **User feedback** | feedback widget hook + user messages | feedback signal → goal | Human steer always wins over autonomy. |
| **Last Tick outcome** | the resume cursor / prior events | informs ORIENT scoring | Cheap; always present. |

SENSE writes a compact **signals digest** into the Tick (not raw payloads — those stay in
`venture_events`), so ORIENT's prompt stays small and cheap. A signal that implies *new* work
becomes a *proposed* goal subject to the scope guard: a runtime error → an in-scope `fix` goal flows
straight through; a feature request outside scope → a `scope_change` checkpoint. This is exactly the
visible "it keeps improving itself" behavior (A6 acceptance), kept safe by the same gates as
everything else.

---

## 24.9 Crash-safety & resumption

The loop must survive worker restarts, DO evictions, deploys, and partial failures **without losing
work, double-charging, or double-shipping**. The mechanism is the **durable TickCursor** plus
**idempotent, phase-keyed writes**.

```
  Worker/DO dies mid-tick (say, during ACT)
        │
        ▼
  on next heartbeat / DO re-instantiation:
    cursor = readCursor(run_id)            // { phase:'act', goal_id:G, tick_number:T, inner_state }
    switch (cursor.phase):
      'sense'|'orient'|'decide' → cheap & idempotent: re-run from cursor.phase
      'act'                     → reattach to Workflow (target) OR re-run bounded by inner cap (now);
                                  studio_version write is keyed by (project, content_hash) so a
                                  re-run that produces identical files does NOT create a duplicate
      'verify'                  → re-run verification (pure check, safe to repeat)
      'ship'                    → check deployment status FIRST: if a deploy for (goal,tick) already
                                  reached 'live', skip; else (re)deploy idempotently by deploy key
      'reflect'                 → re-apply outcome (event append is naturally append-only; budget
                                  counter update is keyed by tick so it applies at most once)
```

Crash-safety invariants:

1. **At-most-once spend per phase.** Budget counter updates are keyed by `(run_id, tick_number,
   phase)`; replaying a phase cannot double-count. Metering events are append-only but reconciled by
   key.
2. **At-most-once SHIP.** Deployments carry a deterministic deploy key `(venture, goal, tick)`; SHIP
   checks status before publishing, so a resume never ships twice.
3. **At-most-once version on identical content.** `studio_version` creation is content-addressed, so
   a re-run of ACT that yields the same files is a no-op.
4. **Per-venture serialization.** The VentureDO (single-threaded) — or the BullMQ job lock in the
   transition realization — guarantees no two Ticks for one venture run concurrently, so the cursor
   is never raced.
5. **Append-only audit.** `venture_events` is never updated/deleted; the full Tick history is always
   reconstructable, which is also how the Console rebuilds the live stream after a reconnect.

Because DECIDE is deterministic and reads only durable state, a resumed Tick re-decides identically
— the loop is **replay-safe end to end**.

---

## 24.10 Pseudocode

### 24.10.1 `tick()` — one full pass

```ts
// server/src/ventures/tick.ts  (interface-level; same logic in VentureDO.alarm())
async function tick(ctx: VentureCtx): Promise<TickOutcome> {
  const cur = await readOrInitCursor(ctx);           // resume point
  const t0 = now();                                   // wall-clock guard anchor

  // ---- SENSE -------------------------------------------------------------
  if (cur.phase <= 'sense') {
    const signals = await sense(ctx);                 // backlog + A6 signals (digest)
    await appendEvent(ctx, 'sense', { signals });
    cur.signals = digest(signals); await advance(ctx, cur, 'orient');
  }

  // ---- ORIENT (cheap LLM, JSON-only, heuristic fallback) -----------------
  if (cur.phase <= 'orient') {
    const choice = await orient(ctx, cur.signals);    // pickTextModel; coerceJsonOrNull
    await appendEvent(ctx, 'orient', choice);         // rationale, value, effort, cost, model
    if (!choice.goal && !choice.newGoal) return reflectIdle(ctx, cur); // nothing to do → long sleep
    cur.goal = await resolveOrCreateGoal(ctx, choice); await advance(ctx, cur, 'decide');
  }

  // ---- DECIDE (pure gate; first failing gate wins) -----------------------
  if (cur.phase <= 'decide') {
    const d = decide(ctx.venture, ctx.budget, choice.action, cur.goal, ctx.scope);
    await appendEvent(ctx, 'decide', d);
    if (d.kind === 'pause')      return pauseVenture(ctx, d.reason);     // budget/kill
    if (d.kind === 'checkpoint') return raiseCheckpoint(ctx, cur.goal, d.type); // → blocked
    await advance(ctx, cur, 'act');
  }

  // ---- ACT (inner build loop / swarm code agent; durable Workflow) -------
  if (cur.phase <= 'act') {
    const r = await runBuildGoal(ctx, cur.goal);      // buildAgent.ts / orchestrator code agent
    await meter(ctx, 'act', r.cost);                  // → budget counters
    await appendEvent(ctx, 'act', { reason: r.reason, iterations: r.iterations, cost: r.cost });
    if (r.reason === 'stuck' || r.reason === 'max_iterations')
      return noProgress(ctx, cur.goal);               // raise checkpoint; do NOT retry
    cur.versionId = r.versionId; await advance(ctx, cur, 'verify');
  }

  // ---- VERIFY (all sub-checks must pass; safety scan is hard) ------------
  if (cur.phase <= 'verify') {
    const v = await verify(ctx, cur.versionId);       // typecheck+build+tests+health+safety scan
    await appendEvent(ctx, 'verify', v);
    if (!v.ok) return failOrFix(ctx, cur.goal, v);    // FIX if budget left, else fail/checkpoint
    await advance(ctx, cur, 'ship');
  }

  // ---- SHIP (managed preview auto; prod already checkpoint-approved) -----
  if (cur.phase <= 'ship') {
    const dep = await shipIdempotent(ctx, cur);       // adapter.deploy(); keyed by (venture,goal,tick)
    await appendEvent(ctx, 'ship', dep);
    cur.deployUrl = dep.url; await advance(ctx, cur, 'reflect');
  }

  // ---- REFLECT (persist, learn, schedule next) --------------------------
  return reflect(ctx, cur);                           // goal→shipped; learnings; setAlarm(next)
}
```

### 24.10.2 The scheduler / heartbeat

```ts
// server/src/ventures/scheduler.ts (BullMQ realization) ≈ VentureDO.alarm() (CF realization)
async function heartbeat(): Promise<void> {
  if (killSwitchOn()) return;                         // global brake — halt everything
  const inFlight = await currentTickCount();
  for (const v of await activeVentures()) {           // status=active, not paused, in budget
    if (inFlight >= GLOBAL_CONCURRENCY_CAP) break;    // protect providers + the bill
    if (v.paused || await overBudget(v)) continue;    // per-venture brakes
    const run = await ensureRun(v);                   // start or resume the bounded Run
    if (run.ticks_count >= MAX_TICKS_PER_RUN) {       // no infinite runs
      await completeRun(run, 'max-ticks'); continue;
    }
    enqueueTick(v.id, run.id);                        // BullMQ job (lock per venture) …
    inFlight++;                                        // … or in CF: this IS the DO's own alarm()
  }
  // each Tick runs under a wall-clock timeout; on timeout the cursor persists and resumes next beat
}

// DO realization: at REFLECT we call state.storage.setAlarm(nextTickAt). Cloudflare invokes
// alarm() → tick(). One DO per venture serializes Ticks; idle ventures arm long alarms (cheap);
// triggers (webhook/user/signal) poke the DO to fire its alarm early.
```

---

## 24.11 Failure modes & recovery

| # | Failure mode | Detection | Recovery / mitigation |
|---|---|---|---|
| 1 | **Worker / DO crash mid-Tick** | next heartbeat finds an in-flight cursor | Resume from `cursor.phase`; idempotent writes prevent double spend/ship (§24.9). |
| 2 | **ORIENT LLM returns garbage / non-JSON** | `coerceJsonOrNull` fails | One retry, then deterministic heuristic (highest-priority ready goal); never block the loop. |
| 3 | **Model hallucinates out-of-scope goal** | scope guard (prompt + DECIDE) | Not executed; raised as `scope_change` checkpoint for the human. |
| 4 | **Build can't be fixed (genuinely stuck)** | inner `buildGuards` `stuck`, promoted by no-progress detector | Block goal; raise checkpoint; pause that goal; ask the user; don't burn budget looping. |
| 5 | **Runaway cost / token spike** | DECIDE pre-check + REFLECT post-update vs caps; A9 anomaly detection | Hard pause on cap breach; spend-spike auto-pause + alert; kill switch as last resort. |
| 6 | **Infinite-loop / thrash (same goal every Tick)** | no-progress + max-ticks-per-run | Run completes (`max-ticks`); goal blocked → checkpoint; cadence backs off. |
| 7 | **Deploy fails (adapter / provider error)** | adapter `deploy()`/`status()` returns error | Deployment row `failed`; goal not marked shipped; retried next Tick within budget; prod failures surface to Console. |
| 8 | **Committed secret / dangerous op in generated code** | VERIFY code-safety scan (A9) | Hard block SHIP regardless of autonomy; raise an event; the build does not leave the sandbox. |
| 9 | **Checkpoint never answered** | checkpoint `expires_at` TTL (§9.4) | Checkpoint → `expired`; goal stays blocked; follow-up surfaced; venture remains safely paused. |
| 10 | **Redis / queue outage (transition realization)** | scheduler health check / BullMQ errors | Ticks pause (no work lost — cursor is in Postgres); resume when the queue recovers. DO realization is immune (Alarms are Cloudflare-managed). |
| 11 | **Provider credential revoked mid-run (BYO)** | adapter auth error / Nango status | Connection → `error`; SHIP blocked; raise a checkpoint asking the user to reconnect. |
| 12 | **Cross-tenant access attempt (bug/abuse)** | RLS + service-identity scoping by `venture_id`+`user_id` | Query denied by RLS; logged; A9 tenant-isolation audit proves no leak path. |

The governing principle: **every failure resolves to one of {retry-within-budget, pause+notify,
checkpoint-the-human, fail-the-goal} — never "spin silently" and never "spend without a gate."**

---

## 24.12 Acceptance criteria

The autonomous engine is "done" when all of the following hold (aggregating Master Plan A2/A4/A6
acceptance with this section's contract):

1. **Governed-but-idle (A2).** With `VENTURES_ENABLED` on, a seeded venture's backlog visibly
   advances Tick-by-Tick in `venture_events`/`venture_goals` with a **stub ACT** (no real build),
   proving governance + durability in isolation.
2. **Brakes provably enforced.** Budget breach mid-Run pauses the venture; the kill switch stops the
   scheduler; the no-progress detector raises a checkpoint instead of looping; max-ticks completes a
   Run cleanly; the scope guard blocks out-of-scope goals. Each has a passing test (A0/A2).
3. **Crash-safe.** A worker/DO restart mid-Tick resumes from the durable cursor with **no double
   spend and no double ship** (idempotency tests for ACT version, SHIP deploy, and budget counter).
4. **Real builds (A4).** With the stub replaced by the inner build loop + swarm code agent, an
   approved venture autonomously builds its first backlog goals into a working `studio_project` with
   `studio_version`s + metered cost, pausing if it gets stuck.
5. **DECIDE is deterministic & replayable.** Given identical durable state, DECIDE returns an
   identical decision; no LLM is on the gate path. Unit-tested across all four gates.
6. **VERIFY gates SHIP.** No build reaches SHIP without passing typecheck/build/tests/health and the
   code-safety/secret scan; a detected committed secret hard-blocks regardless of autonomy.
7. **Checkpoints gate irreversibles.** Production deploy, spending money, destructive ops, external
   publish, scope change, and roadmap approval each route through a checkpoint before execution.
8. **Closed iterate loop (A6).** A deployed venture that throws a runtime error gets a fix goal
   created via SENSE→ORIENT and shipped autonomously (within budget/checkpoints) — the visible "it
   keeps improving itself" behavior.
9. **Metering is exact & tagged.** Every Tick's cost is recorded per phase, tagged `venture_id`, and
   reconciles against `venture_budgets` spend counters; the audit trail and the brake never disagree.
10. **Verify suite green.** Client typecheck, server build, and vitest pass (env-only Supabase
    failures excepted, per `CLAUDE.md`).

> **Stance (restated):** the engine never runs without the brakes. The brakes (A0), the durable
> cursor, RLS isolation, and the deterministic DECIDE gate are the difference between an
> always-on enterprise product and a runaway script. This section is the contract the rest of the
> architecture (§25 multi-tenancy, §26 schema, §37 reliability, §40 cost) is built to honor.
