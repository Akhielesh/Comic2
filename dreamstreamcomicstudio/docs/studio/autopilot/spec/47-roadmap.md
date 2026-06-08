# 47 — Roadmap, Milestones & Sequencing

> Part V · Delivery · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan](../00-MASTER-PLAN.md) (§9 the A0–A9 backlog, §10 milestones M-A1..M-A5) ·
> [Enterprise Foundations](../F-ENTERPRISE-FOUNDATIONS.md) (F0–F10 + the **revised sequencing**:
> F0→F1→F2 before A2) · [Foundations backlog](./45-foundations-backlog.md) (planned — F-series
> detail) · [Autonomy backlog](./46-autonomy-backlog.md) (planned — A-series detail) ·
> [CI/CD & release](./44-cicd-release.md) (the pipeline these milestones ride on, flag-gated
> ship pattern) · [Reliability/SRE](./37-reliability-sre.md) (the SLO gates) ·
> [Autonomous engine](./24-autonomous-engine.md) (what A2 builds) · [STATUS](../STATUS.md)
> (the live tracker this roadmap projects). Grounded in the actual repo state: nothing in the
> A/F series is built yet; the existing studio/swarm/billing/Nango assets it consumes are real.

## 47.1 What this section is, and the honest frame

This is the **sequencing contract**: the order in which the foundation epics (F0–F10) and the
autonomy epics (A0–A9) ship, how they interleave, what depends on what, what milestone each
roll-up earns, and what ships behind a flag vs at GA. It is the projection of the
[STATUS.md](../STATUS.md) epic boards onto a timeline.

Three honesty notes frame everything below.

1. **Nothing in the A or F series is built yet.** The repo today has the *substrate* Autopilot
   consumes (the agentic build loop, the swarm, the studio-worker sandbox, billing/ledger,
   Nango, RLS) — see [Master Plan §3](../00-MASTER-PLAN.md#3-what-we-build-on). The roadmap
   below is from a standing start.
2. **The effort numbers are illustrative, not commitments.** They size *relative* difficulty
   and sequencing, sourced from [Master Plan §10](../00-MASTER-PLAN.md#10-milestones--sequencing).
   They assume a small focused team and the continuous-build operating model. They are not an
   SLA, not a contract, and not a delivery date. Calendar phases below are **ordinal** (Phase 0,
   1, 2…), deliberately not dated.
3. **The order changed after the audit.** The original plan jumped straight to A0 (brakes). The
   2026-06-07 code audit added the hard rule that **F0 → F1 → F2 ship before A2 wires real
   autonomous builds** ([F-ENTERPRISE-FOUNDATIONS, "Revised sequencing"](../F-ENTERPRISE-FOUNDATIONS.md#revised-sequencing--foundations-under-autonomy)).
   You cannot run an always-on builder you cannot observe (F0), on providers that fail silently
   (F1), with limits that do not hold across instances (F2). This section encodes that rule.

The governing principle, unchanged from the Master Plan: **build the brakes before the engine,
and the foundations before the brakes have anything to govern.**

---

## 47.2 The interleaved F + A dependency graph

The two backlogs are not sequential silos; the F-series runs *under and alongside* the
A-series. The dependency graph below shows the hard edges (a → b means b cannot start until a
is meaningfully done). Foundations that are **hard prerequisites** are drawn inline; the rest
run as parallel workstreams (§47.6).

```
  PHASE 0 — FOUNDATIONS FIRST (the "production-ready" gate)
  ┌─────────────┐   ┌──────────────────────┐   ┌──────────────────────────┐
  │ F0          │   │ F1                    │   │ F2                       │
  │ observability│──►│ provider reliability  │──►│ distributed correctness  │
  │ (see+audit) │   │ (key pool/breaker/    │   │ (shared limits/optimistic │
  │             │   │  cross-provider F/O)  │   │  concurrency/idempotency)│
  └──────┬──────┘   └──────────┬───────────┘   └────────────┬─────────────┘
         │ metrics + audit log     │ trusted models             │ limits hold
         │ (seeds venture_events)  │                            │ across instances
         └─────────────┬──────────┴────────────────────────────┘
                       ▼  HARD RULE: F0→F1→F2 before A2 wires real builds
  ┌────────────────────────────────────────────────────────────────────────┐
  │ A0 brakes ──────► A1 control plane ──────► A2 loop engine (stub ACT)     │
  │ budgets/kill/     ventures/goals/runs/      BullMQ scheduler + tick;     │
  │ checkpoints/audit connections CRUD + RLS    governed, crash-safe, bounded │
  └───────┬───────────────────┬──────────────────────────┬──────────────────┘
          │ needs F6 (the      │ needs F6 migrations,      │ needs F0 signals,
          │ ventures_* migr.)  │ F3 sessions (re-auth on   │ F2 shared limits
          ▼                    │ deploy/billing)           ▼
  ┌──────────────┐             ▼                  ┌──────────────────┐
  │ F6 migrations│      ┌──────────────┐          │ A3 intake/roadmap │
  │ F3 sessions  │      │ F5 testing    │          │ idea→approved     │
  │ F8 security  │      │ F7 API docs   │          │ backlog (gate:    │
  │ (run alongside)     │ (run alongside)          │ roadmap checkpoint)│
  └──────────────┘      └──────────────┘          └─────────┬─────────┘
                                                            ▼
                                              ┌──────────────────────────┐
                                              │ A4 wire ACT/VERIFY to the │
                                              │ real build engine + swarm │
                                              └─────────────┬────────────┘
                                                            ▼
                                              ┌──────────────────────────┐
                                              │ A5 deploy adapters        │
                                              │ managed preview + BYO     │──┐
                                              │ (Nango); prod=checkpoint  │  │ F4 real-time DO
                                              └─────────────┬────────────┘  │ shares CF DO+
                                                            ▼               │ Workflows work
                                              ┌──────────────────────────┐  │ with A2/A8
                                              │ A6 sense layer            │◄─┘
                                              │ signals → iterate loop    │◄── F10 webhooks
                                              └─────────────┬────────────┘    (feeds SENSE)
                                                            ▼
                                ┌────────────────┐   ┌──────────────────┐
                                │ A7 billing      │──►│ A8 operator      │
                                │ portal (Stripe) │   │ console (24/7 UI)│◄── F9 design
                                │ (needs A1 only) │   │                  │    system + a11y
                                └────────────────┘   └─────────┬────────┘
                                                               ▼
                                              ┌──────────────────────────┐
                                              │ A9 hardening & GA         │
                                              │ + F8 security gates       │
                                              │ + F9 a11y gates           │
                                              │ flip VENTURES_ENABLED     │
                                              └──────────────────────────┘
```

**Reading the graph.** The three P0 foundations gate A2. A0 and A1 can begin in parallel with
F0/F1/F2 (they are admin-only, flag-gated data/governance work that does not *run* anything),
but A2 — the moment a real loop turns on — must wait for the F0→F1→F2 line. From A2 forward the
A-series is a mostly-linear value chain (A3→A4→A5→A6→A8→A9) with **A7 (billing) branching off
A1 early** because it only needs the control-plane data, not the loop. F3–F10 attach where
their hard edges land (F6 under A0/A1; F3 under A4/A5 for re-auth on deploy/billing; F4 sharing
the Cloudflare DO/Workflows work with A2/A8; F10 feeding A6's SENSE; F8/F9 as A9 gates) and
otherwise run continuously in the background.

---

## 47.3 The phased timeline (Gantt)

Phases are **ordinal, not dated.** Each phase ends at a milestone gate (§47.4). `█` = primary
focus, `▒` = parallel/continuing workstream, `·` = not yet started.

```
 EPIC  │ Ph0   │ Ph1   │ Ph2   │ Ph3   │ Ph4   │ Ph5   │  earns
       │ found. │ idle  │ build │ self  │ prod  │ GA    │
───────┼───────┼───────┼───────┼───────┼───────┼───────┼──────────────
 F0    │ █████ │ ▒▒▒▒▒ │ ▒▒▒▒▒ │ ▒▒▒▒▒ │ ▒▒▒▒▒ │ ▒▒▒▒▒ │ (gate for A2)
 F1    │ █████ │ ▒▒▒▒▒ │ ▒▒▒▒▒ │ ▒▒▒▒▒ │ ▒▒▒▒▒ │ ▒▒▒▒▒ │ (gate for A2)
 F2    │ ████· │ ▒▒▒▒▒ │ ▒▒▒▒▒ │ ▒▒▒▒▒ │ ▒▒▒▒▒ │ ▒▒▒▒▒ │ (gate for A2)
 A0    │ ··███ │ █████ │ ····· │ ····· │ ····· │ ····· │ ┐
 A1    │ ····· │ █████ │ ▒▒▒▒· │ ····· │ ····· │ ····· │ ├ M-A1
 A2    │ ····· │ ··███ │ ▒▒▒▒· │ ····· │ ····· │ ····· │ ┘ governed-idle
 F6    │ ····· │ ▒▒▒██ │ ▒▒▒▒▒ │ ····· │ ····· │ ····· │ (under A0/A1)
 A3    │ ····· │ ····· │ █████ │ ····· │ ····· │ ····· │ ┐
 A4    │ ····· │ ····· │ ··███ │ ▒▒▒▒· │ ····· │ ····· │ ├ M-A2
 A5    │ ····· │ ····· │ ···██ │ █▒▒▒· │ ····· │ ····· │ ┘ idea→deploy
 F3    │ ····· │ ····· │ ▒▒▒██ │ ▒▒▒▒▒ │ ····· │ ····· │ (re-auth gate)
 F5    │ ····· │ ▒▒▒▒▒ │ ▒▒▒▒▒ │ ▒▒▒██ │ ▒▒▒▒▒ │ ▒▒▒▒▒ │ (CI gates)
 A6    │ ····· │ ····· │ ····· │ █████ │ ▒▒▒▒· │ ····· │ M-A3 self-improve
 F10   │ ····· │ ····· │ ····· │ ▒▒▒██ │ ▒▒▒▒· │ ····· │ (SENSE webhooks)
 F4    │ ····· │ ····· │ ····· │ ▒▒▒▒▒ │ ▒▒▒██ │ ▒▒▒▒· │ (DO real-time)
 A7    │ ····· │ ····· │ ····· │ ····· │ █████ │ ▒▒▒▒· │ ┐
 A8    │ ····· │ ····· │ ····· │ ····· │ ··███ │ ▒▒▒▒· │ ┘ M-A4 a product
 F9    │ ····· │ ····· │ ····· │ ····· │ ▒▒▒██ │ ▒▒▒▒▒ │ (a11y/design gate)
 F7    │ ····· │ ····· │ ▒▒▒▒▒ │ ▒▒▒▒▒ │ ▒▒▒██ │ ▒▒▒▒▒ │ (OpenAPI)
 F8    │ ····· │ ▒▒▒▒▒ │ ▒▒▒▒▒ │ ▒▒▒▒▒ │ ▒▒▒██ │ █████ │ (security gate)
 A9    │ ····· │ ····· │ ····· │ ····· │ ····· │ █████ │ M-A5 secure+GA
```

**Phase summary.**

| Phase | Name | Primary epics | Foundations landing | Gate (milestone) |
|---|---|---|---|---|
| **0** | Foundations first | F0, F1, F2 | — | platform observable, providers reliable, limits shared |
| **1** | Governed but idle | A0, A1, A2 (stub ACT) | F6 (ventures_* migrations) | **M-A1** |
| **2** | Idea → build → deploy | A3, A4, A5 | F3 (re-auth), F7 start | **M-A2** |
| **3** | Self-improving | A6 | F5 (CI gates), F10 (webhooks) | **M-A3** |
| **4** | A product | A7, A8 | F4 (real-time DO), F9 (design/a11y) | **M-A4** |
| **5** | Secure + GA | A9 | F8 (security gates), F9/F7 finish | **M-A5** |

Phase 0 is the deliberate, non-negotiable prelude: it is the only phase whose deliverable is
*not* an Autopilot feature, and it is the phase the audit inserted. Skipping it is the single
most expensive mistake available on this roadmap.

---

## 47.4 Milestones M-A1..M-A5 (entry / exit criteria)

The five milestones from [Master Plan §10](../00-MASTER-PLAN.md#10-milestones--sequencing),
made gate-able. Each has an **entry** (what must be true to start), an **exit** (the
acceptance bar to claim it), and a **demo** (the one thing you can show).

### M-A1 — "Governed but idle"  (epics A0, A1, A2-stub)

- **Entry:** F0 + F1 + F2 shipped and verified (the hard rule, §47.1). `VENTURES_ENABLED`
  exists and defaults false; admin gating in place.
- **Exit:** with the flag on (admin), you can create a venture, set a budget, raise/resolve a
  checkpoint, read the append-only audit trail; a seeded backlog **visibly advances tick-by-tick**
  in `venture_events`/`venture_goals` with a **stub ACT** (no real code built yet); the loop
  **stops** on budget breach, kill switch, or the no-progress detector, and **survives a worker
  restart**. Typecheck + server build + vitest green.
- **Demo:** seed a venture, watch the backlog advance, hit a budget cap → it pauses + notifies;
  flip the kill switch → everything halts; restart the worker → it resumes cleanly. The brakes
  work before the engine builds anything.

### M-A2 — "It builds itself, end to end"  (epics A3, A4, A5)

- **Entry:** M-A1 met. The existing studio sandbox is live (`VITE_STUDIO_LIVE_ENABLED` +
  `STUDIO_WORKER_URL`). F6 migration runner available for the `ventures_*` set; F3 re-auth
  available for the deploy checkpoint.
- **Exit:** "Build me a habit-tracker SaaS with email reminders" → a reviewable roadmap →
  (roadmap checkpoint approved) → the loop autonomously builds the first backlog goals into a
  working `studio_project` with `studio_versions` + metered cost → ships to a **managed preview
  URL automatically** → after the owner approves the **production checkpoint**, deploys to a
  connected Cloudflare/Vercel/Railway account. Tokens never logged; stuck goals raise a
  checkpoint instead of looping. Verify green.
- **Demo:** end-to-end from a sentence of intent to a live preview to a checkpointed production
  deploy on a BYO account.

### M-A3 — "It keeps improving"  (epic A6)

- **Entry:** M-A2 met; at least one venture has a live deployment to observe. F10 inbound
  webhooks available to feed signals.
- **Exit:** a deployed venture that throws a **runtime error** gets a fix goal created from a
  real signal (error/uptime/analytics/feedback), and ships the fix autonomously — within budget
  and scope, raising a scope checkpoint if it would drift. The iterate loop is closed: SENSE
  produces *new* goals, not just the next backlog item. Verify green.
- **Demo:** inject an error into a deployed venture → a fix goal appears → the loop ships the
  fix without a human filing it. The visible "it improves itself" behavior.

### M-A4 — "A product"  (epics A7, A8)

- **Entry:** M-A3 met. Stripe credit/plan price config confirmed. F4 (real-time DO) available
  for the live stream; F9 design system available for the console UI.
- **Exit:** from **one screen** the user creates a venture, approves its roadmap, watches it
  build **live** (SSE over `venture_events`), approves the prod deploy, sees **per-venture
  spend vs budget**, tops up credits, gets an 80%/100% spend alert, and can pause/resume/kill —
  on desktop and mobile. Reconciliation matches. Verify green.
- **Demo:** the full Operator Console + central billing portal driving a real venture, on a
  phone and a laptop.

### M-A5 — "Secure & GA"  (epic A9)

- **Entry:** M-A4 met. F8 CI security gates and F9 a11y gates live; load-test plan executable
  (F5).
- **Exit:** an external security pass finds **no cross-tenant leak, no secret exposure, no
  uncapped spend path**; the full code-safety scan runs before every ship; RLS coverage is
  complete across `venture_*` + `studio_*`; the kill-switch drill passes; the incident runbook
  exists; GA gating flips `VENTURES_ENABLED` from admin-only → plan-gated. Verify green +
  `/security-review` clean.
- **Demo:** the security report, the kill-switch drill, and a plan-gated user creating a venture
  in production.

---

## 47.5 Release-train view

Autopilot rides the existing **flag-gated, always-ship-to-`Dreamstrream-v1`** pipeline
([§44 CI/CD](./44-cicd-release.md), [CLAUDE.md](../../../../CLAUDE.md)). Epics do **not** wait
for a milestone to merge — they merge continuously, *dark*, and a milestone is reached when its
flag-gated surface is exposed. The "release train" is therefore a sequence of **flag flips**,
not a sequence of big-bang merges.

```
 TRAIN     CARGO (merged dark, additive, reversible)         FLIP THAT EXPOSES IT
 ───────   ─────────────────────────────────────────────    ───────────────────────────
 T0  ──►   F0/F1/F2 code (metrics, key pool, Redis limits)   admin /metrics; pool auto-on
 T1  ──►   A0/A1 tables + API + governance primitives        VENTURES_ENABLED=on (admin only)
 T2  ──►   A2 scheduler + tick (stub ACT)                    ventures worker service started
 T3  ──►   A3 intake + A4 real ACT/VERIFY                    VITE_STUDIO_LIVE_ENABLED (build)
 T4  ──►   A5 deploy adapters (managed + BYO)                per-venture connections (owner)
 T5  ──►   A6 sense + F10 webhooks                            signals endpoint on
 T6  ──►   A7 billing + A8 console + F4/F9                    console route exposed (admin)
 T7  ──►   A9 hardening + F8/F9 gates                         VENTURES_ENABLED → plan-gated (GA)
```

Each car is **safe to merge before the one ahead of it ships** because every infra-dependent
feature is a no-op until configured ([§44.2.4](./44-cicd-release.md)). A bad surface is killed
by flipping its flag *off* — instant, no redeploy, no rollback needed. This is the same brake
the build loop itself runs on, and it is why "always ship to prod" is survivable through every
phase: **prod behavior is unchanged until a flag/config is set.**

| Train | Milestone reached | What's live in prod after the flip |
|---|---|---|
| T0 | (Phase 0 gate) | observability + provider reliability for the *existing* product |
| T1–T2 | **M-A1** | governed-but-idle ventures (admin) |
| T3–T4 | **M-A2** | idea → build → managed preview → checkpointed prod deploy (admin) |
| T5 | **M-A3** | self-improving iterate loop (admin) |
| T6 | **M-A4** | Operator Console + billing portal (admin) |
| T7 | **M-A5** | GA: plan-gated to real users |

---

## 47.6 Critical path & parallelizable workstreams

### The critical path (longest dependency chain to GA)

```
 F0 ─► F1 ─► F2 ─► A0 ─► A1 ─► A2 ─► A3 ─► A4 ─► A5 ─► A6 ─► A8 ─► A9
 └──────── Phase 0 ───────┘  └───────────── the autonomy value chain ──────────────┘
```

This is the chain that determines the floor on time-to-GA; shortening *anything off* this path
buys nothing. The two longest single epics on it are **A2** (durability/governance is the care)
and the A4/A5 pair (real-build wiring + per-provider deploy edge cases). A7 (billing) is
deliberately **off** the critical path — it branches from A1 and rejoins at M-A4 — so it can be
built whenever a second pair of hands is free without blocking the loop.

### Parallelizable workstreams (run alongside the critical path)

| Workstream | Epics | Can run in parallel because… | Joins at |
|---|---|---|---|
| **Foundations-under-autonomy** | F3, F5, F6, F7, F8, F9, F10 | additive + flag-safe; only F6 has a hard edge (A0/A1), F3 a soft one (A4/A5 re-auth) | their gate milestone |
| **Billing portal** | A7 | needs only A1 control-plane data, not the loop | M-A4 |
| **Cloudflare DO/Workflows** | F4 + A2 + A8 share this | the real-time DO work (F4) is the same substrate A2's heartbeat + A8's live stream use | M-A4 |
| **Design system + a11y** | F9 | UI-layer; feeds A8 console and the A9 a11y gate | M-A4 / M-A5 |
| **Provider contract tests** | F1 + F5 | recorded fixtures; independent of the loop | M-A5 (CI gate) |

The practical implication: with one builder, the timeline is roughly the critical path. With a
second, A7 + the F-series parallel workstreams collapse into the gaps, and the binding
constraint becomes A2→A4→A5 quality, not headcount.

---

## 47.7 Rough effort roll-up (illustrative, not commitments)

Relative sizes from [Master Plan §10](../00-MASTER-PLAN.md#10-milestones--sequencing), with the
F-series sized from [F-ENTERPRISE-FOUNDATIONS](../F-ENTERPRISE-FOUNDATIONS.md). **These are
ordinal difficulty estimates for sequencing, not delivery dates or staffing commitments.**

| Epic | Rough size | On critical path? | Note |
|---|---|---|---|
| F0 observability | ~1 wk | **yes (gate)** | Sentry + pino + prom-client + audit log |
| F1 provider reliability | ~1 wk | **yes (gate)** | key pool + breaker + cross-provider failover |
| F2 distributed correctness | ~4–5 d | **yes (gate)** | Redis limits + optimistic concurrency + idempotency |
| A0 brakes | ~2–3 d | **yes** | governance primitives, all flag-gated |
| A1 control plane | ~2–3 d | **yes** | CRUD + RLS, no loop |
| A2 loop engine | ~1 wk | **yes** | the durability/governance is the care |
| A3 intake → roadmap | ~3–4 d | **yes** | idea → approved backlog |
| A4 real build (ACT/VERIFY) | ~1 wk | **yes** | wiring + edge cases |
| A5 deploy adapters | ~1 wk | **yes** | per-provider |
| A6 sense layer | ~4–5 d | **yes** | signals → iterate loop |
| A7 billing portal | ~4–5 d | no (parallel) | branches off A1 |
| A8 operator console | ~1 wk | **yes** | the 24/7 UI |
| A9 hardening & GA | ~1 wk | **yes** | audit + gates + GA flip |
| F3 / F5 / F6 / F7 / F8 / F9 / F10 | ~3 d–1 wk each | mostly parallel | F6 has the only hard edge |

**Critical-path roll-up (illustrative):** roughly F0+F1+F2 ≈ 2.5–3 wk of foundation, then
A0→A2 ≈ 2 wk to M-A1, then A3→A5 ≈ 2.5–3 wk to M-A2, A6 ≈ 1 wk to M-A3, A8 ≈ 1 wk to M-A4, A9
≈ 1 wk to M-A5 — **weeks of phased work, not a weekend**, as the Master Plan says plainly. The
parallel F-series + A7 absorb additional capacity rather than extend the floor. Treat every
number as a planning aid that the [STATUS.md](../STATUS.md) tracker supersedes the moment real
work starts.

---

## 47.8 Risk-adjusted sequencing

The order is chosen to **front-load the irreversible risks and defer the reversible ones.** The
table maps each sequencing choice to the risk it buys down (risks from
[Master Plan §11](../00-MASTER-PLAN.md#11-risks--honest-caveats) and the audit).

| Sequencing choice | Risk it addresses | Why this order |
|---|---|---|
| **F0 → F1 → F2 before A2** | running blind / silent provider failure / limits multiplying across instances | you cannot safely turn on an always-on builder you cannot see, trust, or bound |
| **A0 (brakes) before A2 (engine)** | runaway cost, infinite loops, ungoverned autonomy | the budget/kill/checkpoint/no-progress brakes must exist before any loop runs |
| **A2 with a stub ACT before A4 real builds** | the engine's durability is the hardest, riskiest part | prove governance + crash-safety in isolation, *before* adding the cost + complexity of real builds |
| **Managed preview (A5) before BYO emphasis** | multi-tenant secret handling is the sharpest edge | managed needs no creds; BYO via Nango is phased in after the loop is trusted |
| **Prod deploy always a checkpoint** | irreversible public/brand/money actions | regardless of autonomy level, irreversibles stay human-gated through GA |
| **A9 hardening as a real gate, not a formality** | cross-tenant leak / secret exposure / uncapped spend | GA is blocked on an external security pass; F8/F9 gates land here |
| **A7 billing off the critical path** | over-sequencing low-risk work | it only needs A1 data; building it early or late changes nothing risky |

The deliberate **non-goal** stays a non-goal: truly ungoverned "never stop" autonomy is not
built. If you ever want *more* autonomous, it is a budget/checkpoint-policy change, not a
re-sequencing — the brakes are designed to be loosened, not removed.

---

## 47.9 What ships behind a flag vs at GA

The invariant: **everything ships behind a flag, dark, additive, and reversible; GA is the
single flag flip from admin-only to plan-gated.** Nothing autonomous touches a real user before
M-A5.

| Surface | Default state pre-GA | Exposed at | Flag / gate |
|---|---|---|---|
| F0 metrics endpoint | admin/network-guarded | Phase 0 | `/metrics` admin guard |
| F1 key pool / breaker | on (transparent, additive) | Phase 0 | no flag — pure reliability win for the existing product |
| All venture data + API | admin-only | M-A1 | `VENTURES_ENABLED` (default false) |
| The loop (stub then real) | admin-only | M-A1 / M-A2 | `VENTURES_ENABLED` + worker service running |
| Real sandboxed builds | admin-only | M-A2 | `VITE_STUDIO_LIVE_ENABLED` + `STUDIO_WORKER_URL` |
| Managed preview deploys | admin-only | M-A2 | per the deploy adapter; auto for previews |
| Production deploys | **always a checkpoint** | M-A2 | human gate, never auto, at any autonomy level |
| BYO provider deploys | admin-only, per-venture connection | M-A2 | `venture_connections` (Nango); none until connected |
| Sense / iterate loop | admin-only | M-A3 | signals endpoint, owner-scoped + rate-limited |
| Billing portal + console | admin-only | M-A4 | console route admin-gated |
| **GA to real users** | — | **M-A5** | `VENTURES_ENABLED` → **plan-gated** (the GA flip) |

**The GA gate (Epic A9) is the only place the audience changes.** Until then, every epic is
live in prod *as code* but inert *as behavior* — the same property ([§44.2.4](./44-cicd-release.md))
that makes "always ship to `Dreamstrream-v1`" safe through the entire roadmap. After the flip,
the brakes (budgets, checkpoints, kill switch, scope guard, no-progress detector) are the
standing controls that keep plan-gated autonomy inside its lane.

---

## 47.10 Summary

The roadmap is **foundations first, brakes before engine, value chain after.** Phase 0 (F0→F1→F2)
earns the right to run anything always-on; Phases 1–5 build the autonomy in safety-first order,
each ending at a gate-able milestone (M-A1 governed-but-idle → M-A2 idea-to-deploy → M-A3
self-improving → M-A4 a product → M-A5 secure + GA). Everything merges continuously, dark, and
flag-gated, so the release train is a sequence of *flag flips*, and GA is a single flip from
admin-only to plan-gated. The critical path runs F0→…→A9; A7 and the F-series parallel
workstreams absorb extra capacity without extending the floor. The effort figures are
illustrative sequencing aids, superseded by [STATUS.md](../STATUS.md) the moment real work
begins — and the standing, audited rule that governs all of it is: **F0 → F1 → F2 ship before
A2 wires real autonomous builds.**
