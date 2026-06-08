# Autopilot — STATUS (living tracker)

> **The file to check for the Autopilot workstream.** Authoritative current state of the
> always-on autonomous ventures layer. Every PR that changes Autopilot **must** update this
> file + [`../CHANGELOG.md`](../CHANGELOG.md). If this file and reality disagree, fix this file.

**Last updated:** 2026-06-07 · **Updated by:** Claude · **Branch:** `claude/gracious-albattani-bDL8T`

> Latest (2026-06-08): **A2 ENGINE BACKEND COMPLETE (governed loop, stub ACT).** Shipped the
> governed `tick` (`ventures/tick.ts`, dependency-injected + 9 unit tests proving it advances a
> backlog and stops on kill/budget/checkpoint/stuck), the real-persistence adapter
> (`tickRunner.ts`), and the BullMQ scheduler/worker (`queue.ts`/`scheduler.ts`/`worker.ts`) +
> `npm run ventures:worker`. The loop is **governed-but-idle**: ACT is a safe stub (A4 wires the
> real build engine), so a venture's backlog visibly advances tick-by-tick without building
> anything yet — proving the brakes + durability before any real autonomy. 70 ventures tests
> pass; server + client typecheck green. **Owner (to actually run it): provide `REDIS_URL` + add
> a `ventures:worker` Railway service + set `VENTURES_ENABLED=true`.** Still all flag-gated/off.

> Latest (2026-06-08): **A1 CONTROL PLANE SHIPPED + MIGRATIONS APPLIED TO SUPABASE.** Applied
> `ventures_foundation.sql` + `ventures_control_plane.sql` to the **Comic** project
> (`bdjfmxfmhqhzvgrhbbzm`) — 7 new tables (`ventures`, `venture_budgets`, `venture_checkpoints`,
> `venture_events`, `venture_goals`, `venture_runs`, `venture_connections`), all RLS
> owner-isolated; added nullable `venture_id` to `studio_projects`/`studio_deployments`.
> **Strictly additive — no data deleted; all existing rows intact.** Shipped the persistence
> (`repository.ts` + `controlPlane.ts`), pure input validators, and the `/api/ventures/*` router
> (CRUD + budgets + checkpoints + events + connections + admin kill switch), mounted after global
> `requireAuth`, **flag-gated + admin-only until GA**. 61 unit tests pass; server + client
> typecheck + frontend build all green. (No Railway tool in this env — Railway env/worker steps
> remain owner to-dos.)

> Latest (2026-06-08): **BUILD STARTED — Epic A0 (brakes) core shipped (code, flag-gated).**
> First real integration code, all under `VENTURES_ENABLED=false` so the live product is
> untouched: `server/src/ventures/{budget,checkpoints,events,killSwitch}.ts` (pure governance
> logic), the `server/sql/ventures_foundation.sql` migration (ventures + venture_budgets +
> venture_checkpoints + venture_events, RLS owner-isolated), and config flags in `config.ts`.
> **35 new unit tests pass; server + client typecheck green.** Remaining A0: venture_id metering
> tags + the DB persistence/repo + admin kill route (these land with the A1 control plane).
> **Owner action queued (not blocking):** apply `ventures_foundation.sql` when you want A1+ live.

> Latest (2026-06-08): **MASTER SPEC COMPLETE — 55 / 55 SECTIONS (~200 pages).** All five parts
> are written in full depth and pushed: I Strategy (00–07), II Product Definition (08–21), III
> Architecture (22–34), IV Foundations/NFRs (35–44), V Delivery (45–54) — including the detailed
> F0–F10 + A0–A9 backlogs, roadmap, owner-actions checklist, runbooks, launch/GTM, and the
> config/decision/data-dictionary appendices. Index: [`SPEC-INDEX.md`](./SPEC-INDEX.md). Built via
> parallel writer-agents, every section committed to draft PR #116. **Next decision is the
> owner's: start BUILDING (recommended first step F1 provider-reliability + F0 observability, or
> A0 brakes), or refine the spec.**

> Latest (2026-06-08): **MASTER SPEC — PARTS I–IV COMPLETE (45 / 55).** Part IV
> (Foundations/NFRs, 35–44) written in depth: security & threat model, privacy/compliance,
> reliability/SRE, observability (F0), performance/scalability, cost/FinOps, billing/metering,
> disaster recovery, testing strategy (F5), CI/CD — all grounded in code + verified Cloudflare
> rates. **Only Part V — Delivery (45–54) remains** (backlogs, roadmap, team/RACI, owner
> actions, runbooks, launch/GTM, appendices). **45 / 55 complete.**

> Latest (2026-06-08): **MASTER SPEC — PARTS I–III COMPLETE (35 / 55).** Part III Architecture
> (22–34) is fully written in depth: system architecture, the flagship deep Cloudflare
> DO/Workflows/Containers topology, the autonomous engine, multi-tenancy/isolation, the full
> data model + RLS (all tables), REST + realtime/events APIs, model gateway (F1 design),
> integrations framework (F10), deploy adapters, storage, sessions/identity (F3), and
> realtime/sync (F4) — all grounded in the actual codebase. **Part IV (Foundations/NFRs, 35–44)
> next, then Part V (Delivery, 45–54).** Built via parallel writer-agents, committing as each
> lands. **35 / 55 complete.**

> Latest (2026-06-07): **MASTER SPEC — PARTS I + II COMPLETE (22 / 55).** Scaffolded
> [`SPEC-INDEX.md`](./SPEC-INDEX.md) (55 sections, 5 parts) under [`spec/`](./spec/). Part I
> Strategy (00–07) and Part II Product Definition (08–21) are written in full depth: exec
> summary, vision, market/competitive, personas, value prop, business model, metrics, risks,
> principles, domain model, feature catalog (~110 features), user journeys, IA, all UX specs
> (intake, Operator Console, build/iterate, approvals, billing, integrations, mobile, a11y,
> content/voice). **Part III — Architecture (22–34) in progress.** Built via parallel
> writer-agents (the `/loop` cron/wakeup scheduler isn't available in this environment, so the
> spec is built within-session, committing each section as it lands). **22 / 55 complete.**

> Latest (2026-06-07): **ENTERPRISE FOUNDATIONS AUDITED + PLANNED + CLOUDFLARE ANSWERED.** Ran
> a code-level audit of all 10 cross-cutting concerns (sessions, sync, concurrency, model
> reliability, testing, design, integrations, observability, docs, security) →
> [`F-ENTERPRISE-FOUNDATIONS.md`](./F-ENTERPRISE-FOUNDATIONS.md) (F0–F10, file-referenced,
> ranked). Verified Cloudflare capabilities (2026-06) and defined the enterprise topology
> (Workers + **Durable Objects** + **Workflows** + Containers) →
> [`ARCHITECTURE-CLOUDFLARE.md`](./ARCHITECTURE-CLOUDFLARE.md). **Revised sequencing:** F0
> (observability) → F1 (provider reliability) → F2 (distributed correctness) ship **before**
> A2 wires real autonomy. Still nothing built — awaiting owner go-ahead.

> Latest (2026-06-07): **PLAN LANDED.** Defined the Autopilot workstream — the autonomous,
> 24/7 "describe an idea → agents build & ship it continuously" layer on top of the existing
> studio. Master plan + operating model + this tracker created; wired into `../00-STATUS.md`
> and `../09-ROADMAP.md`. **Nothing built yet** — A0 (brakes) is next, on owner go-ahead.

---

## Overall progress

```
Plan        ████████████████████  100%  (master plan, architecture, security, hosting, billing, backlog, operating model)
Build       ░░░░░░░░░░░░░░░░░░░░    0%  (no epics shipped yet — A0 is next)
```

## Epic board

| Epic | Title | Status | Blocked by |
|---|---|---|---|
| A0 | Brakes first (budgets, kill-switch, checkpoints, audit) | 🟢 **core shipped** (pure logic + SQL + flags + 35 tests); repo/route/metering land with A1 | — |
| A1 | Venture control plane (data + API) | 🟢 **shipped** — migrations applied to Supabase, repo + controlPlane + `/api/ventures` routes (incl. admin kill) mounted, flag/admin-gated; client API + apiTypes land with A8 | — |
| A2 | Autonomous loop engine (bounded, crash-safe; stub ACT) | 🟢 **backend complete** — DECIDE gate + governed `tick` (DI, 9 tests) + `tickRunner` (real persistence) + BullMQ `queue`/`scheduler`/`worker` + `npm run ventures:worker`. ACT is a stub (A4 wires real builds). | `REDIS_URL` + worker service (owner) |
| A3 | Intake → roadmap (idea → approved backlog) | 📋 planned | A2 |
| A4 | Wire ACT/VERIFY to the real build engine | 📋 planned | A3; studio live flags (owner) |
| A5 | Deploy adapters (managed + BYO via Nango) | 📋 planned | A4; per-venture connections (owner) |
| A6 | Sense layer (signals → iterate loop) | 📋 planned | A5 |
| A7 | Central billing & budgets portal | 📋 planned | A1; Stripe price config |
| A8 | Operator console (24/7 workspace UI) | 📋 planned | A1–A7 |
| A9 | Multi-tenant security hardening & GA | 📋 planned | A1–A8; security review + owner GA approval |

Legend: ✅ done · 🟢 backend/partial · 🟡 in progress · 📋 planned · ⛔ blocked

## Foundations board (F-series — runs under the A-series)

Full detail + file refs: [`F-ENTERPRISE-FOUNDATIONS.md`](./F-ENTERPRISE-FOUNDATIONS.md).
Current state is audited (🟡 partial across the board); these epics close the gap.

| Epic | Title | Priority | Status |
|---|---|---|---|
| F0 | Observability (Sentry, metrics, tracing, audit log) | **P0** — ship before A2 | 📋 planned |
| F1 | AI provider reliability (key pool, circuit breaker, cross-provider failover) | **P0** — the owner's #1 pain | 📋 planned |
| F2 | Distributed correctness (shared limits, optimistic concurrency, idempotency) | **P0** — ship before A2 | 📋 planned |
| F3 | Session & identity hardening (first-party sessions, JWKS, device revocation) | P1 | 📋 planned |
| F4 | Real-time & multi-device sync (Durable Objects) | P1 | 📋 planned |
| F5 | Testing & quality gates (integration, E2E, contract, coverage gate) | P1 | 📋 planned |
| F6 | Schema & migration management (runner + RLS-coverage CI) | P1 | 📋 planned |
| F7 | API contract & docs (OpenAPI, unified docs) | P2 | 📋 planned |
| F8 | Input validation & supply-chain security (zod, helmet, CI scans) | P1 | 📋 planned |
| F9 | Design-system unification & a11y | P2 | 📋 planned |
| F10 | Integrations framework unification (catalog, webhooks, connection state) | P2 | 📋 planned |

## ➡️ NEXT STEP

**Revised, enterprise-correct order:** ship **F0 → F1 → F2** (so the platform is observable,
its providers are reliable, and limits hold across instances), then **A0 brakes → A1 control
plane → A2 loop engine**, with F3–F10 running alongside A3–A9.

**Owner decision:** approve starting **F1 (AI provider reliability)** and **F0 (observability)**
— these directly fix the "model connection & source issues" you flagged and are independent,
additive, and safe to ship now. (Or start **A0** if you'd rather stand up the autonomy
governance first.) See [`F-ENTERPRISE-FOUNDATIONS.md`](./F-ENTERPRISE-FOUNDATIONS.md) +
[`00-MASTER-PLAN.md` §9](./00-MASTER-PLAN.md#9-the-epic--sprint-backlog).

## Open decisions

| Decision | Recommendation | Status |
|---|---|---|
| Product naming | "Code Studio Autopilot" / unit = "Venture" | ❓ owner to confirm/rename |
| Start building A0 now (this branch) vs wait | Start A0 (safe, flag-gated, reversible) | ❓ owner go-ahead |
| Managed vs BYO emphasis at launch | Managed previews first; BYO for production | ✅ hybrid (locked) |
| Autonomy level | Continuous + checkpoints + budgets | ✅ locked |

## Honest caveats
- Nothing autonomous runs until A9 GA gating; `VENTURES_ENABLED` defaults off.
- "Never stop" = continuous **with** budgets + checkpoints (by design, for cost/safety).
- This reuses the existing studio/swarm/billing/Nango — it is orchestration + governance,
  not a rebuild — but it is still weeks of phased work.
