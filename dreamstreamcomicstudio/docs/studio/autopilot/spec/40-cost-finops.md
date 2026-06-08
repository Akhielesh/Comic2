# 40 — Cost Model & FinOps

> Part IV · Non-functional / Foundations · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan §7 billing](../00-MASTER-PLAN.md#7-billing-budgets--the-central-portal) +
> [Epic A7](../00-MASTER-PLAN.md#epic-a7--central-billing--budgets-portal) ·
> [F-Enterprise Foundations](../F-ENTERPRISE-FOUNDATIONS.md) (**F0** — observability / cost
> meters) · [ARCHITECTURE-CLOUDFLARE.md](../ARCHITECTURE-CLOUDFLARE.md) (Workers + DO +
> Workflows + Containers) · [scaling-and-cost.md](../../../production/scaling-and-cost.md).
>
> **What this section owns.** [05 — Business Model & Pricing](./05-business-model-pricing.md)
> set *list prices, markup, and who-pays-whom*. This section owns the **other side of the
> ledger**: what each active venture actually *costs us* to run (COGS), how we keep that cost
> bounded and attributable, and the FinOps discipline that protects margin once the platform
> is always-on and multi-tenant. [41 — Billing & Metering](./41-billing-metering.md) owns the
> *charge* pipeline in depth; this section consumes its outputs for cost attribution.
>
> **Numbers are illustrative unless cited to a file or a verified provider rate.** Provider
> rates are tagged **[verified, CF 2026-06]** where checked against Cloudflare docs; internal
> constants are cited to source (`file.ts:line`). Per-venture cost estimates are *modelled
> scenarios* the owner should re-run against real telemetry once F0 cost meters are live —
> they are a coherent model to react to, not a commitment.

---

## 40.1 The shape of the cost problem

A 24/7 autonomous studio inverts the usual SaaS cost profile. In a normal app, infra cost
tracks human sessions; here it tracks **agent ticks**, which can run while the human sleeps.
That is the whole product — and the whole risk. Three properties govern the cost model:

1. **COGS is dominated by variable, agent-driven spend** (model inference + container active
   time), not fixed servers. This is good — it scales down to near-zero for idle ventures —
   but only if the architecture genuinely scales to zero (it does: DO Alarms + Container
   sleep, [ARCHITECTURE-CLOUDFLARE.md §1](../ARCHITECTURE-CLOUDFLARE.md), §40.5).
2. **The single largest line — model inference — collapses to ~0 under BYOK.** The customer
   pays the provider directly with their own key; we bill $0 and reserve 0 CT
   (`billingLedger.ts:841`, the `BYOK_TRACKED` bypass). This is the structural moat from
   [05 §5.1](./05-business-model-pricing.md#51-revenue-model-overview), restated here as a
   *cost* fact: under BYOK, our marginal COGS for a venture is a thin slice of orchestration
   and storage.
3. **Cost is bounded by code, not by hope.** `venture_budgets` hard caps, the account spend
   cap, the daily guardrail, and the global kill switch are pre-flight brakes (the DECIDE
   gate refuses before it spends), so a runaway loop cannot bankrupt us. This is the A0
   "brakes first" mandate ([Master Plan A0](../00-MASTER-PLAN.md#epic-a0--brakes-first-budgets-kill-switch-checkpoints-audit)),
   and it is what makes managed hosting financially safe to offer.

The job of this section is to make those three properties measurable, attributable per
tenant, and defensible at the margin.

---

## 40.2 Platform COGS breakdown

The components below are everything on *our* books for a managed venture. The **BYOK / BYO**
column shows what survives when the customer brings their own keys and hosting — the cost
that is irreducibly ours regardless of how the customer routes.

| COGS component | What drives it | Provider / rate basis | On our books (managed) | Under BYOK + BYO hosting |
|---|---|---|---|---|
| **Model inference** | Agent tokens + image units per tick | OpenRouter / Gemini / Pixazo, metered in `costEstimator.ts` | **Largest line.** Provider cost × `markup` is billed; provider cost is our COGS. | **~$0** — `BYOK_TRACKED` bypass bills $0, reserves 0 CT (`billingLedger.ts:841`). |
| **Container active-time** | Build + runtime exec (the Sandbox SDK) | Cloudflare Containers: CPU **$0.000020/vCPU-s** *active*, memory **$0.0000025/GiB-s** *provisioned*, disk **$0.00000007/GB-s** *provisioned* **[verified, CF 2026-06]** | Per-tick run cost (lands in `studio_runs.cost_usd`); rolled into the venture ledger as `other_billable`. | Small: only the **orchestration sandbox** (owner decision whether to meter it, [05 §5.5](./05-business-model-pricing.md#55-managed-vs-byo-cost-flows-who-pays-whom)). Customer's *own* prod runtime is on their account. |
| **Workers / DO / Workflows requests** | Edge API, preview routing, the tick heartbeat, durable build pipelines | Workers Paid: DO **$0.15/M requests** (1M incl), DO duration **$12.50/M GB-s** (400k GB-s incl) **[verified, CF 2026-06]** | Small but always-on; scales with active ventures (one `VentureDO` Alarm per active venture). | Same — orchestration is ours in both modes. This is the irreducible "platform tax." |
| **R2 / KV storage + ops** | Artifacts, build outputs, blobs (R2); catalog + hot-path cache (KV) | R2 **zero egress** + storage/Class A/B ops; KV reads/writes/storage **[verified, CF 2026-06: R2 egress $0]** | Modest; grows with retained artifacts per venture. | Same; can be smaller if the customer's prod artifacts live on their R2/bucket. |
| **Supabase** | System-of-record (Postgres + auth + RLS), `venture_*` tables, ledger | Supabase plan (fixed tier + usage) | Fixed-ish base + per-row/storage growth; amortized across all tenants. | Same — system-of-record is always ours. |
| **Railway** | Current Express API tier (during the DO/Workflows transition) | Railway instance(s), per [scaling-and-cost.md](../../../production/scaling-and-cost.md) Stage A–C | Fixed per-instance; 1 instance ≤100 active users, 2–3 by 1k. Retires as coordination moves to DOs. | Same; transitional. |
| **Nango** | OAuth/connection broker for BYO accounts + BYOK key custody | Nango plan (per connection / tier) | Per active BYO connection. | **Higher relative share** under BYO (more connections) — but tiny in absolute terms and the enabler of the ~$0 model/host lines. |
| **Stripe fees** | Payment processing on plan + top-ups + overage capture | **~2.9% + $0.30/txn** (illustrative; confirm contract) | Per transaction; concentrated on plan renewals + credit-pack purchases. | Same — but on a *smaller* metered total, so fees are dominated by the flat plan fee. |
| **Egress** | Bytes served from previews / managed hosting | Cloudflare egress: **R2 $0**; Container egress **$0.025/GB** NA/EU **[verified, CF 2026-06]** | Real for managed previews/prod. | **$0 to us** — served from the customer's account. |

Reading the table: **the two biggest swing lines (model inference, hosting/egress) are
exactly the two BYOK + BYO zeroes.** Everything left — DO/Workflows requests, Supabase,
Railway, Nango, the orchestration sandbox, Stripe on the flat fee — is small and roughly
fixed per active venture. That residual is the true marginal cost of a BYOK venture, and it
is what makes the ~95% gross-margin band in [05 §5.6](./05-business-model-pricing.md#56-unit-economics--gross-margin-sketch-illustrative)
honest rather than aspirational.

---

## 40.3 Worked cost-per-active-venture estimate (illustrative)

This grounds the container-minute math against the **verified** Cloudflare rates above. We
model one active venture for one month doing ~120 ticks (intake + roadmap, then iterative
build, ending in a checkpointed deploy) — the same workload as the [05 §5.5](./05-business-model-pricing.md#55-managed-vs-byo-cost-flows-who-pays-whom)
worked examples, so the two sections reconcile.

### 40.3.1 Container active-time math (the load-bearing arithmetic)

We size builds on **`standard-2`** (1 vCPU, 6 GiB, 12 GB disk — the recommended build size,
[23 §23.4](./23-cloudflare-topology.md)). The 2025-11 CPU pricing change means **CPU is
billed on *active* usage, not provisioned** (a `standard-2` averaging 20% CPU over an hour
costs $0.0144 of CPU, not $0.072 — Cloudflare's own worked example, **[verified, CF
2026-06]**); memory and disk remain billed on *provisioned* resources.

For one `standard-2` container-**minute** at an illustrative **30% average CPU utilization**:

| Resource | Rate **[verified, CF 2026-06]** | Per container-minute |
|---|---|---:|
| CPU (1 vCPU × 60 s × 30% active) | $0.000020 / vCPU-s | $0.00036 |
| Memory (6 GiB × 60 s, provisioned) | $0.0000025 / GiB-s | $0.00090 |
| Disk (12 GB × 60 s, provisioned) | $0.00000007 / GB-s | $0.0000504 |
| **Total / `standard-2` minute** | | **≈ $0.0014** |

So a venture's **~300 build container-minutes** ≈ **$0.42** of raw container COGS; **~600
managed-hosting minutes** (preview + light prod) ≈ **$0.84** before egress. (The [05 §5.5](./05-business-model-pricing.md#55-managed-vs-byo-cost-flows-who-pays-whom)
example used round $1.20 / $2.50 placeholders; this math shows those are conservative — real
container COGS at this size and utilization is *lower*, which only improves margin. Memory is
the dominant term, which is why right-sizing the instance type, §40.5, matters more than
shaving CPU.) Workers Paid **included allowances** (375 vCPU-min, 25 GiB-hr, 200 GB-hr,
1M DO requests, 400k DO GB-s, all **[verified, CF 2026-06]**) absorb the first venture or two
entirely, so early-venture marginal infra cost is effectively zero.

### 40.3.2 Full per-venture COGS, two modes

| COGS line | Managed venture (no BYOK) | BYOK + BYO hosting |
|---|---:|---:|
| Model inference (~120 ticks) | ~$8.00 (provider) | **$0.00** (their key) |
| Build container-minutes (~300 @ §40.3.1) | ~$0.42 | ~$0.42* |
| Managed hosting minutes (~600) + egress | ~$1.10 | **$0.00** (their account) |
| DO/Workflows requests + duration | ~$0.05 | ~$0.05 |
| R2 + KV storage/ops (retained artifacts) | ~$0.10 | ~$0.05 |
| Supabase + Railway (amortized share) | ~$0.40 | ~$0.40 |
| Nango (per active connection, amortized) | ~$0.00 | ~$0.20 |
| Stripe fees (on plan + any overage) | ~$1.15 | ~$1.14 (plan only) |
| **Total marginal COGS / venture / mo** | **≈ $11.22** | **≈ $2.26** |

\* Whether we meter/charge the orchestration sandbox under BYO is the open owner decision
from [05 §5.9](./05-business-model-pricing.md#59-open-decisions-for-the-owner); the COGS is
ours either way but is the only material non-zero line in BYO mode. **The 5× COGS spread
($11 → $2) is the BYOK advantage expressed as cost**, and it maps directly to the ~60% vs
~95% margin bands in [05 §5.6](./05-business-model-pricing.md#56-unit-economics--gross-margin-sketch-illustrative).

---

## 40.4 The BYOK + BYO-hosting cost-shifting advantage

This is worth stating plainly as a cost-engineering principle, not just a pricing tactic.

- **BYOK shifts the single largest COGS line off our books to ~0.** It is enforced in code,
  not policy: a present BYOK header takes the `byokBypass` path — record a `BYOK_TRACKED`
  ledger entry for visibility, **bill $0, reserve 0 CT** (`billingLedger.ts:841`).
  Verified-free models (`:free` suffix, or all-zero pricing axes) short-circuit to $0
  regardless of the snapshot table, so a stale catalog can never charge for an advertised-free
  model (`costEstimator.ts:113`–`116`). The cost moat is therefore *self-defending*.
- **BYO hosting is a pure pass-through.** Production runtime + egress land on the customer's
  Cloudflare/Vercel/Railway/Supabase account via Nango connections; our hosting and egress
  COGS for that venture go to **$0**. We carry only the orchestration sandbox and the
  always-on platform tax (DO/Workflows/Supabase).
- **Why this is a durable advantage, not a giveaway.** A bundled competitor must price in its
  *worst-case* model + compute spend inside one seat price, so either its headline price is
  structurally higher or its margin is thinner ([02 §2.7](./02-market-competitive-analysis.md#27-pricing-posture-vs-market)).
  We are **economically indifferent** to the customer's choice: managed earns margin via the
  1.30× markup; BYOK/BYO earns margin via a near-pure flat fee. Both are profitable; neither
  exposes us to a model bill we cannot control. The cost model *is* the wedge.

---

## 40.5 Cost controls

Most controls are **brakes already in the plan**, not new spend — the A0 guardrails doing
double duty as FinOps. They are layered so a single failure (a bad budget, a stuck loop, a
provider price spike) cannot translate into runaway COGS.

| Control | Mechanism | Backing | Status |
|---|---|---|---|
| **Venture budgets (hard caps)** | `usd_per_day` / `usd_total` / `max_tokens` / `max_container_minutes` per venture; DECIDE gate refuses *before* spend, REFLECT tracks actuals, breach → pause + checkpoint. | `venture_budgets`, A0 budget evaluator ([Master Plan §7](../00-MASTER-PLAN.md#7-billing-budgets--the-central-portal)) | **A0 — to build** |
| **Account spend cap** | `overage_hard_cap_usd`; reservation refused with `OVERAGE_CAP_REACHED`. | `billingLedger.ts:910`, `updateSpendCap` (`:1315`) | **shipped** |
| **Daily guardrail** | Per-plan daily CT ceiling (Free `dailyGuardrailCt: 800`; Pro `16_000`). | `DEFAULT_PLAN_ENTITLEMENTS` (`pricingCatalog.ts:91`), `usageState` | **shipped** |
| **Plan quotas** | Active-venture, concurrent-tick, managed-minute pools cap *aggregate* burn per tenant. | entitlement rows + `rbac.ts` | **partial / extend** |
| **Container warm-pool sizing** | Right-size the always-warm instance count; idle ventures scale to zero between ticks (DO Alarms wake them), so warm cost tracks *active* ventures, not registered ones. | [23 §23.4.4](./23-cloudflare-topology.md), [05 §5.7](./05-business-model-pricing.md#57-cogs-drivers-and-cost-controls) | **A2/A4 — to build** |
| **Free-model-first routing** | Route to `:free` / zero-cost models first; verified-free settles to $0 regardless of snapshot. | `costEstimator.ts:113`, `modelAccessPolicy.ts` | **shipped** |
| **Catalog caching** | Cache the pricing/model catalog (KV / hot path) so resolution doesn't hit Supabase per tick; daily sync refreshes it. | `pricingCatalog.ts` + `dailyPricingSync.ts` | **shipped** |
| **Right-size instance type** | Build on `standard-2`; reserve `standard-3/4` for heavy builds; use `lite` for warm-pool probes. Memory is provisioned-billed, so instance choice is the biggest container lever (§40.3.1). | [23 §23.4](./23-cloudflare-topology.md) instance table | **A4 — to build** |
| **Global kill switch** | `VENTURES_KILL` halts every venture instantly — the last-resort COGS circuit breaker. | [Master Plan §8](../00-MASTER-PLAN.md#8-guardrails--checkpoints) | **A0 — to build** |
| **Concurrency cap** | Global max concurrent ticks protects the provider bill *and* warm-pool size. | scheduler ([Master Plan §5](../00-MASTER-PLAN.md#5-security--multi-tenancy)) | **A2 — to build** |
| **No-progress detector** | Same failure N× → pause, not burn — stops a loop from paying to fail repeatedly. | tick loop | **A2 — to build** |
| **Image rate limits + idempotency** | Strict image-route limits + idempotency keys avoid duplicate paid provider calls. | [scaling-and-cost.md §Cost Controls](../../../production/scaling-and-cost.md) | **shipped** |

**Warm-pool sizing is the one genuinely new FinOps decision Autopilot adds.** A 24/7 product
implies *some* hot capacity for interactive builds, but the DO-alarm heartbeat means idle
ventures cost nothing between ticks. The lever: keep a small warm pool (sized to expected
concurrent interactive builds, not registered ventures) and let everything else cold-start.
This keeps warm COGS proportional to *active* demand — the difference between paying for work
and paying for an idle fleet ([ARCHITECTURE-CLOUDFLARE.md §4](../ARCHITECTURE-CLOUDFLARE.md)).

---

## 40.6 The metering → cost pipeline

The path from "an agent did work" to "we know what it cost and who owes what" reuses the live
billing machinery; Autopilot only adds the `venture_id` tag and the per-venture rollup.

```
TICK (DECIDE → ACT → REFLECT)
   │  estimate CT, check venture_budget + spend cap (pre-flight, no LLM)   [A0 brake]
   ▼
costEstimator.estimateCharge()  ──4-axis pricing──►  pricingCatalog.resolveModelPricing()
   │  reserve CT (included → purchased → overage)        markup = BILLING_PLATFORM_MARKUP (1.30×)
   ▼                                                      CT_USD = 0.0001  (10,000 CT = $1)
billingLedger.reserveUsageTokens()  ── BYOK? ──►  BYOK_TRACKED, $0, 0 CT      [shipped]
   │  run tick; settle on real provider cost (usage.providerCostUsd)
   ▼  buildSettleEstimateFromUsage() trusts real cost over estimate          [shipped]
billingLedger.settleReservation()  → token_ledger_entries (tagged venture_id) [A0 tag]
   │
   ├─► studio_runs.cost_usd  (container active-time → other_billable axis)    [A7 rollup]
   ├─► maybeRaiseUsageAlert() → 80% / 100% spend alerts (deduped)            [shipped]
   ▼
DAILY JOBS
   ├─ dailyPricingSync.ts            refresh model pricing snapshots,         [shipped]
   │                                 flag major deltas (>35%) for review
   └─ dailyBillingReconciliation.ts  ledger ⇄ Stripe PaymentIntents,         [shipped]
                                     failed-webhook sweep, --strict CI gate
                                     → extend to include per-venture compute  [A7 task]
```

**Shipped today** (cited): the 4-axis estimator and free-model short-circuit
(`costEstimator.ts`), CT denomination + markup knob (`pricingCatalog.ts:11`–`12`),
reserve/settle/BYOK-bypass and spend-cap enforcement (`billingLedger.ts`), the 80%/100% alert
dedup (`billingLedger.ts:1029` `maybeRaiseUsageAlert`), the daily pricing sync
(`dailyPricingSync.ts`), and the daily ledger ⇄ Stripe reconciliation with a `--strict` CI
mode (`dailyBillingReconciliation.ts`).

**To build for Autopilot (A0 / A7):** stamp `venture_id` on the metering metadata; roll
`studio_runs.cost_usd` (container active-time) into the venture ledger via the `other_billable`
axis; and **extend `dailyBillingReconciliation.ts` to include per-venture compute** so the
three-way tie-out (our ledger ⇄ Stripe ⇄ provider invoices) closes at the venture grain
([Master Plan A7](../00-MASTER-PLAN.md#epic-a7--central-billing--budgets-portal)).

---

## 40.7 FinOps practices

FinOps for Autopilot is the operational discipline that keeps the §40.2 COGS visible,
attributable, and bounded. Every practice depends on the **F0 cost meters** being live — the
honest caveat is that `alerting-thresholds.md` is aspirational until F0 emits the metrics
([F0](../F-ENTERPRISE-FOUNDATIONS.md), §"metrics exporter … cost meters").

| Practice | What it is | Wired to |
|---|---|---|
| **Cost dashboards (F0)** | A live view of COGS by component (model, container, DO/Workflows, R2/KV, egress) and by tenant — the spend signals `prom-client` + `/metrics` expose, surfaced in the admin dashboard and the A7 portal. | **F0** metrics exporter; `systemDashboard.ts`; A7 portal |
| **Per-tenant cost attribution** | Every ledger entry + `studio_run` carries `venture_id`; rollups give exact cost per venture and per account — the basis for unit economics and for the "owner sees exactly what each venture costs" A7 acceptance. | `venture_id` tag (A0); `billingLedger`/`studio_runs`; A7 |
| **Anomaly / spend-spike detection** | Detect a venture's hourly burn jumping above its trailing baseline, a stuck loop, or suspicious egress → **auto-pause + alert** (not just a dashboard line). This is the A9 abuse/anomaly item doing FinOps duty. | [Master Plan A9](../00-MASTER-PLAN.md#epic-a9--multi-tenant-security-hardening--ga); 80/100% alerts (`billingLedger.ts:1029`) |
| **Unit-economics monitoring** | Track gross margin per active venture and per tier against the [05 §5.6](./05-business-model-pricing.md#56-unit-economics--gross-margin-sketch-illustrative) bands; watch the managed-vs-BYOK mix, since margin swings ~60%→~95% with it. | F0 cost dashboards × revenue (Stripe) |
| **Weekly cost review** | Infra + provider spend deltas WoW, by endpoint class; Supabase request/storage growth; provider failure/timeout rates. | [scaling-and-cost.md §Weekly Review](../../../production/scaling-and-cost.md) |
| **Pricing-drift watch** | `dailyPricingSync.ts` flags provider price moves >35% (`PRICING_MAJOR_DELTA_THRESHOLD`) as `REVIEW_REQUIRED` so a provider hike doesn't silently erode managed margin. | `dailyPricingSync.ts` |

---

## 40.8 Margin protection

The threats to margin, and the specific defense for each — every defense is a mechanism named
above, so margin protection is a *property of the system*, not a quarterly promise.

| Margin threat | Defense | Lever |
|---|---|---|
| **Provider price increase** (managed model COGS rises) | Daily sync flags >35% deltas for review; margin on metered compute scales linearly with the markup, so the owner can re-tune. | `BILLING_PLATFORM_MARKUP` (one env var; `pricingCatalog.ts:12`); `dailyPricingSync.ts` |
| **Runaway / looping venture** | Pre-flight budget refusal + no-progress detector + spend cap + kill switch — spend is *prevented*, not refunded. | `venture_budgets`, `OVERAGE_CAP_REACHED`, `VENTURES_KILL` |
| **Free-tier abuse** | Free is bounded by *managed cost* (1 venture, 1 tick, tight managed quota, preview-only, free-models-only) and the daily guardrail; BYOK users on Free cost ~$0. | entitlements + `modelAccessPolicy.ts` + `dailyGuardrailCt` |
| **Idle-fleet drift** (paying for registered, not active, ventures) | Scale-to-zero between ticks; warm pool sized to concurrent interactive demand. | DO Alarms + warm-pool sizing (§40.5) |
| **Thin metered margin** | Markup `0.30/1.30 ≈ 23%` of the billed line at 1.30×; raising to 1.50× lifts it to ~33% — a single dial against churn. | `BILLING_PLATFORM_MARKUP` |
| **Reconciliation gaps** (revenue/cost leak) | Daily ledger ⇄ Stripe tie-out with a `--strict` CI gate; extended to per-venture compute. | `dailyBillingReconciliation.ts` (A7) |
| **Pass-through risk** (domains, paid APIs) | Always a checkpoint; billed at 1.00× (no markup, no margin, no risk) or charged to the user's own method. | [Master Plan §8](../00-MASTER-PLAN.md#8-guardrails--checkpoints) |

**The bottom line.** Under BYOK + BYO, marginal COGS is ~$2/venture/month (§40.3.2) against a
~$29 flat fee — margin is structural and barely touched by usage. Under managed, COGS is
~$11/venture but every dollar of it is gated by a pre-flight brake and earns a 1.30× markup,
so margin is *bounded below* by the budget caps and the kill switch. In neither mode can a
venture spend money we did not first decide, in code, to let it spend. That is the FinOps
guarantee A0 buys and A7 makes visible.

---

> **Mapped to:** [Master Plan §7](../00-MASTER-PLAN.md#7-billing-budgets--the-central-portal) ·
> [Epic A0](../00-MASTER-PLAN.md#epic-a0--brakes-first-budgets-kill-switch-checkpoints-audit)
> (brakes / budgets) · [Epic A7](../00-MASTER-PLAN.md#epic-a7--central-billing--budgets-portal)
> (portal / reconciliation) · [Epic A9](../00-MASTER-PLAN.md#epic-a9--multi-tenant-security-hardening--ga)
> (anomaly detection) · **F0** (cost meters / observability). Companion sections:
> [05 — Business Model & Pricing](./05-business-model-pricing.md),
> [41 — Billing & Metering](./41-billing-metering.md),
> [39 — Performance & Scalability](./39-performance-scalability.md).
