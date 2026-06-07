# Autopilot — STATUS (living tracker)

> **The file to check for the Autopilot workstream.** Authoritative current state of the
> always-on autonomous ventures layer. Every PR that changes Autopilot **must** update this
> file + [`../CHANGELOG.md`](../CHANGELOG.md). If this file and reality disagree, fix this file.

**Last updated:** 2026-06-07 · **Updated by:** Claude · **Branch:** `claude/gracious-albattani-bDL8T`

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

## ➡️ NEXT STEP

**Owner decision:** approve starting **Epic A0 — Brakes first** (admin-only, flag-gated,
zero impact on existing users). Then Claude builds A0→A2 (governed-but-idle loop) before
wiring any real builds. See [`00-MASTER-PLAN.md` §9](./00-MASTER-PLAN.md#9-the-epic--sprint-backlog).

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
