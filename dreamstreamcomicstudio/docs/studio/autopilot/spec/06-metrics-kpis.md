# 06 — Success Metrics, KPIs & North Star

> Part I · Product & Strategy · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> Instrumentation grounds out in [Foundations F0](../F-ENTERPRISE-FOUNDATIONS.md) and
> [alerting-thresholds.md](../../../production/alerting-thresholds.md).

## 6.1 What this section commits to (and what it doesn't)

This is the measurement contract for Autopilot: the one metric that defines whether the
product is working, the full tree beneath it, the funnel we optimize, the guardrails we
refuse to regress, and exactly how each number is produced. **Targets here are illustrative**
— we have not run Autopilot at scale, so committing to specific conversion rates would be
dishonest. The *definitions, instrumentation, and guardrail thresholds* are the real
contract; the numeric targets are starting hypotheses to be ratcheted against real data
(mirroring the F5 "start realistic, ratchet" stance on coverage gates).

Every metric below names its **source** (where the number comes from) so it is auditable, not
vibes. The canonical source for autonomy behaviour is the append-only `venture_events` table
(A1, seeded by the F0 audit log); platform health comes from the F0 metrics exporter
(`/metrics`) and Sentry; money comes from the metering/billing tables (A7, Stripe).

## 6.2 The North Star

> **North Star: weekly shipped, healthy venture-improvements per active user (WSHI/AU).**

A *venture-improvement* is one **goal** that the autonomous loop drove from `in_progress`
to `shipped` — a real, deployed change to a Venture (feature, fix, or chore that reached a
live environment). "Healthy" and "shipped" are not soft words; both are computed:

| Term | Definition (computable) | Source |
|---|---|---|
| **Shipped** | a `venture_goals` row reached `status = shipped` **and** its change reached a live deploy (managed or BYO) in the window | `venture_goals`, `venture_deploys` |
| **Healthy** | the deploy survived a post-deploy watch window with **no rollback, no new prod error spike attributable to it, and no SLO breach** within 24h | `venture_events` (post-deploy verify), Sentry release health |
| **Active user** | an account with ≥1 Venture whose loop ran ≥1 tick in the trailing 7 days | `venture_events` (tick), `ventures` |
| **Weekly** | rolling 7-day window, reported per ISO week | aggregation job |

**WSHI/AU = (count of healthy shipped goals in the week) ÷ (active users in the week).**

**Why this metric.** It is the only number that is simultaneously true to the vision, hard to
game, and leading on revenue:

- **True to the vision.** §1.10 and §0.8 define success as *active users accumulating Ventures
  that keep shipping healthy improvements week over week.* WSHI/AU is that sentence as
  arithmetic. A demo that builds once and stalls scores zero on the second week — exactly the
  failure mode (§3.2: "AI builders produce a demo then stall") we exist to beat.
- **Hard to game.** It cannot be inflated by token burn, idle ticks, or shipping broken code:
  unhealthy deploys are excluded, and a deploy that rolls back subtracts. Raising it requires
  the loop to actually do useful, durable work.
- **Leading on retention/revenue.** A user whose Ventures keep improving has a teammate they
  keep (retention) and a reason to raise budgets and connect BYO accounts (revenue). It is the
  upstream cause of both lagging outcomes.

**Why not the obvious alternatives.** *Ventures created* rewards intake spam, not value.
*Goals shipped (absolute)* rewards big spenders and hides per-user health. *Deploys* counts
activity, not outcomes. *Revenue* is lagging and conflates pricing with product quality. Each
of these lives in the tree below as an input — but none is the North Star.

## 6.3 The metric tree

Read top-down: the North Star sits above the standard AARRR funnel **plus** three
platform-specific groups that exist because we are an autonomous, multi-tenant, cost-exposed
platform — concerns a generic SaaS metric tree omits.

### 6.3.1 AARRR

| Stage | Metric | Definition | Source |
|---|---|---|---|
| **Acquisition** | Visits | unique sessions on the marketing/intake surface | web analytics |
| | Signups | new accounts | `auth` / `users` |
| | Signup→intake-start rate | % of signups that begin an intake | `venture_events` (intake.started) |
| **Activation** | Intake→approved-roadmap rate | % of intakes that reach an approved roadmap (first checkpoint) | `venture_checkpoints` |
| | Roadmap→first-build rate | % approved roadmaps that produce a first successful build | `venture_events` (build.green) |
| | Build→first-deploy rate | % builds that reach a first live deploy | `venture_deploys` |
| | **Time-to-first-deploy (TTFD)** | median minutes from intake start to first live URL | `venture_events` timestamps |
| **Engagement** | Active Ventures / user | Ventures with ≥1 tick in 7d | `venture_events` |
| | Loop ticks/week | autonomous passes executed | `venture_events` (tick) |
| | Approval response time | median time a checkpoint waits for a human | `venture_checkpoints` |
| | Operator Console DAU/WAU | distinct console users | web analytics |
| **Retention** | W1/W4 Venture retention | % Ventures still shipping healthy goals after 1/4 weeks | `venture_goals` |
| | Account retention (W4/M3) | % accounts active after 4w / 3mo | `venture_events` |
| | Loop survival rate | % loops that resume correctly after a restart | `venture_events` (resume) |
| **Revenue** | Paid conversion | % active accounts on a paid plan | billing |
| | ARPA / expansion | avg revenue per account; budget-raise & BYO-connect events | billing, `connections` |
| | Net revenue retention | cohort revenue retained + expanded | billing |

### 6.3.2 Autonomy Quality (platform-specific)

This group answers "is the autonomous engine actually good?" — independent of how many users
we have.

| Metric | Definition | Target sense | Source |
|---|---|---|---|
| **Goals shipped per run** | healthy shipped goals ÷ runs | higher | `venture_goals`, `venture_events` |
| **Median iterations to green** | median build/verify ticks for a goal to pass | lower | `venture_events` (tick→green) |
| **Stuck-rate** | % goals that hit the no-progress detector (A0) and halt for human help | lower | `venture_events` (stuck) |
| **Autonomous-fix success** | % sense-layer-raised fix goals (A6) that ship healthy without human edits | higher | `venture_goals` (origin=sense) |
| **Human-intervention rate** | % runs requiring a manual takeover/redirect | lower | `venture_events` (takeover) |
| **Rework rate** | % shipped goals that produced a follow-up fix goal within 48h | lower | `venture_goals` |

### 6.3.3 Trust & Safety (platform-specific)

These are mostly **count-to-zero** metrics. They are not optimized like growth metrics; they
are *defended*. A non-zero value is an incident, not a KPI miss.

| Metric | Target | Source |
|---|---|---|
| **Budget-overrun count** | **0** (hard cap enforced by A0 brakes) | metering vs `venture_budgets` |
| **Cross-tenant incidents** | **0** (RLS + per-tenant DO/container isolation) | audit log, Sentry |
| **% prod deploys checkpoint-gated** | **100%** | `venture_deploys` × `venture_checkpoints` |
| **Kill-switch drill success** | **100%** of scheduled drills halt the fleet within SLA | runbook log, `venture_events` |
| **Unauthorized-action attempts blocked** | trended (expect >0, all blocked) | audit log |
| **Secret/PII leak events** (guardrails) | **0** reaching output | guardrails notices (F0) |

### 6.3.4 Cost & Efficiency (platform-specific)

The business only works if autonomy is cheaper to run than we charge. These tie directly to
the §0.6 economics edge and the F0 cost meters / `alerting-thresholds.md` cost alerts.

| Metric | Definition | Source |
|---|---|---|
| **Compute $/active venture** | total agent+container+host spend ÷ active Ventures | F0 cost meters, container metrics |
| **Cost per healthy shipped goal** | total platform cost ÷ healthy shipped goals | cost meters ÷ `venture_goals` |
| **Gross margin per plan** | (revenue − attributable cost) ÷ revenue, by plan | billing, metering |
| **Container utilization** | active container-seconds ÷ provisioned | container/Workers metrics |
| **BYOK ratio** | % of model spend on user-supplied keys (margin-positive by design) | per-provider counters (F1/F0) |
| **Idle-tick ratio** | % ticks that did no useful work (pure overhead) | `venture_events` |

## 6.4 The activation funnel

The path from stranger to a self-improving Venture. Each step is a measured transition; the
rates are **illustrative starting hypotheses**, to be replaced by real cohort data.

| Step | Transition | Source event | Illustrative target |
|---|---|---|---|
| 1 | **Visit → Intake started** | `intake.started` | 25% |
| 2 | **Intake → Approved roadmap** | `checkpoint.roadmap.approved` | 60% |
| 3 | **Approved roadmap → First build green** | `build.green` (first) | 85% |
| 4 | **First build → First live deploy** | `deploy.live` (first) | 75% |
| 5 | **First deploy → First autonomous improvement** | first healthy `sense`/loop-originated shipped goal | 50% |

**End-to-end illustrative activation** (visit → first autonomous improvement) ≈
0.25 × 0.60 × 0.85 × 0.75 × 0.50 ≈ **4.8%**. Low end-to-end conversion is expected — the funnel
exists to show *where* we leak, not to hit a vanity number. Step 5 is make-or-break and the
truest read on the core promise ("it keeps improving"); steps 2 and 4 are the human-trust gates
(approve a plan; trust it to deploy). We instrument drop-off reasons at each step (intake
abandoned, roadmap rejected, budget too low to deploy) so the funnel diagnoses *why*.

## 6.5 Guardrail metrics (must-not-regress)

Guardrails are metrics we watch *while* moving the North Star, to ensure we don't win the
growth game by breaking the trust or economics that make the product viable. A guardrail
breach blocks a launch/rollout regardless of how good the headline number looks.

| Guardrail | Threshold (must not cross) | Why it bounds the North Star |
|---|---|---|
| Budget overruns | **0** | a single overrun violates the core safety promise (§1.5) |
| Cross-tenant incidents | **0** | one leak is existential for a multi-tenant platform |
| Prod deploys not checkpoint-gated | **0** | ungoverned prod access is out of scope by design (§0.10) |
| Gross margin per plan | **≥ 0** (target band per plan) | shipping more goals must not be loss-making |
| p95 API latency | ≤ 2.5s (warn), ≤ 5s (crit) — per `alerting-thresholds.md` | a slow console erodes the operator experience |
| 5xx error rate | ≤ 1% (warn), ≤ 3% (crit) | reliability is table stakes for "always-on" |
| Provider error rate (F1) | breaker-open events trended; no silent failure | the audit's #1 finding; degraded models = bad ships |
| Rework rate | not increasing as throughput rises | shipping *faster* must not mean shipping *worse* |

## 6.6 Leading vs lagging indicators

Optimizing lagging metrics directly is slow and blind; we steer with leading indicators that
*cause* them.

| Lagging (outcome) | Leading (early, steerable) we actually move |
|---|---|
| WSHI/AU (North Star) | iterations-to-green ↓, stuck-rate ↓, autonomous-fix success ↑ |
| Account retention | TTFD ↓, first-autonomous-improvement rate ↑, approval response time ↓ |
| Net revenue retention | budget-raise events ↑, BYO-account connects ↑, Active Ventures/user ↑ |
| Gross margin | idle-tick ratio ↓, container utilization ↑, BYOK ratio ↑ |
| Trust (qualitative) | checkpoint-gated % = 100, budget-overruns = 0, honest-status coverage |

## 6.7 Instrumentation plan

The hard rule from F0: *you cannot run 24/7 what you cannot see.* Every metric above must have
an emitter before the corresponding feature is considered done. Three planes, three sources.

**1. Autonomy & funnel events → `venture_events` (the audit/event source of truth).**
The append-only `venture_events` table (A1; seeded by the F0 security/admin audit log) is the
canonical record of *what the agents did*. Every loop emits a typed event with `venture_id`,
`run_id`, `tick`, `user_id`, `event_type`, `payload`, and `created_at`. The metric tree's
autonomy, funnel, retention, and most safety numbers are aggregations over this table. Because
it is append-only and per-tenant RLS-isolated, it doubles as the audit trail and the analytics
substrate — one write, two uses. Event types we standardize: `intake.started`,
`checkpoint.roadmap.approved`, `build.green`, `deploy.live`, `goal.shipped`,
`goal.stuck`, `tick`, `takeover`, `resume`, `kill.triggered`.

**2. Platform health → F0 metrics exporter + Sentry.**
The F0 `prom-client` exporter at `/metrics` (admin/network-guarded) emits the exact signals
`alerting-thresholds.md` already lists but nothing yet feeds: 5xx rate, p95/p99 latency, 429
ratio, queue depth, CPU/memory, and **per-provider error/latency/429 counters** (F1). Sentry
captures exceptions tagged with `requestId` + release + `user`, and provides release-health
data (crash-free sessions) used by the North Star's "healthy" computation. `requestId`
propagates as trace context through the AI gateway, BullMQ jobs, and the studio worker (F0), so
a slow or failed ship is traceable end-to-end.

**3. Cost & revenue → metering tables + per-provider counters + Stripe.**
Compute, model, container, and host spend are metered per Venture (A7) and reconciled against
`venture_budgets` (the source for budget-overrun=0) and Stripe (the source for revenue/margin).
Per-provider cost counters (F0/F1) split BYOK vs platform-key spend for the BYOK-ratio and
margin metrics.

**Instrumentation acceptance (per F0 style):** a metric is "instrumented" only when (a) its
event/counter is emitted at the point of action, (b) it appears on the relevant dashboard, and
(c) if it is a guardrail, it is wired to a real alert (Sentry alert or cron check), not just
charted.

### 6.7.1 Dashboards

| Dashboard | Audience | Primary panels | Backing source |
|---|---|---|---|
| **Operator** | Ops/Owner (§3.6), per-tenant operator | live activity stream, run/tick health, queue depth + stalled jobs, stuck Ventures, kill-switch state, provider breaker status | `venture_events`, F0 exporter, BullMQ liveness |
| **Business** | Owner / GTM | North Star (WSHI/AU), activation funnel with drop-off reasons, AARRR, cohort retention, ARPA/NRR | `venture_events` aggregations, billing |
| **Reliability** | Ops/SRE | 5xx & latency vs `alerting-thresholds.md`, per-provider error/latency/429, error-budget burn, cost-vs-budget, Sentry release health | F0 exporter, Sentry, cost meters |

The Operator dashboard extends today's admin dashboard (`systemDashboard.ts`); the Reliability
dashboard makes the documented thresholds *live* (their first real data source); the Business
dashboard is the new aggregation layer over `venture_events` + billing.

## 6.8 Targets by stage (illustrative)

Targets ratchet with maturity. Alpha proves the loop is *real*; Beta proves it is *trustworthy
and economic*; GA proves it is *a product people keep*. Safety guardrails are **already at their
final value (0 / 100%) from Alpha** — they are never relaxed for an early stage.

| Metric | Alpha | Beta | GA |
|---|---|---|---|
| **North Star — WSHI/AU** | ≥ 1 (it ships at all) | ≥ 3 | ≥ 5 |
| Visit→approved-roadmap | — (invite-only) | 12% | 15% |
| First-deploy→first-autonomous-improvement | 30% | 45% | 55% |
| Time-to-first-deploy (median) | < 60 min | < 30 min | < 15 min |
| Median iterations to green | ≤ 6 | ≤ 4 | ≤ 3 |
| Stuck-rate | ≤ 30% | ≤ 15% | ≤ 8% |
| Autonomous-fix success | ≥ 40% | ≥ 60% | ≥ 70% |
| Budget overruns | **0** | **0** | **0** |
| Cross-tenant incidents | **0** | **0** | **0** |
| % prod deploys checkpoint-gated | **100%** | **100%** | **100%** |
| Compute $/active venture | measured (no cap) | trending down | within margin band |
| Gross margin per plan | n/a (no charging) | ≥ 0 | within target band |
| W4 account retention | measured | ≥ 35% | ≥ 50% |

These numbers are hypotheses, deliberately spaced so each stage has a clear, falsifiable bar.
The discipline is: **define the metric and its source now, instrument it before the feature
ships, and let real cohorts overwrite the illustrative targets** — never the other way around.

## 6.9 Open questions

- **"Healthy" watch window.** Is 24h post-deploy the right horizon, or should it scale with
  Venture traffic (low-traffic Ventures need longer to surface regressions)? Resolve with A6.
- **Attribution for shared cost.** How to fairly split platform overhead (idle ticks, control
  plane) across Ventures for the per-venture cost metric. Resolve with A7 metering.
- **Active-user denominator gaming.** A user could keep one Venture barely ticking to stay
  "active." Monitor the distribution (not just the mean) and consider a minimum-useful-work
  threshold for the denominator.

---

*Next: [07 — Assumptions, constraints & risks](./07-assumptions-risks.md). Upstream:
[00 §0.8](./00-executive-summary.md), [01 §1.10](./01-vision-positioning.md). Instrumentation
canon: [F0](../F-ENTERPRISE-FOUNDATIONS.md) · [alerting-thresholds](../../../production/alerting-thresholds.md).*
