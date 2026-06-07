# Autopilot — STATUS (living tracker)

> **The file to check for the Autopilot workstream.** Authoritative current state of the
> always-on autonomous ventures layer. Every PR that changes Autopilot **must** update this
> file + [`../CHANGELOG.md`](../CHANGELOG.md). If this file and reality disagree, fix this file.

**Last updated:** 2026-06-07 · **Updated by:** Claude · **Branch:** `claude/gracious-albattani-bDL8T`

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
| A0 | Brakes first (budgets, kill-switch, checkpoints, audit) | 📋 planned — **next** | owner go-ahead to start building |
| A1 | Venture control plane (data + API) | 📋 planned | A0; migration apply (owner) |
| A2 | Autonomous loop engine (bounded, crash-safe; stub ACT) | 📋 planned | A1; `REDIS_URL` + worker service (owner) |
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
