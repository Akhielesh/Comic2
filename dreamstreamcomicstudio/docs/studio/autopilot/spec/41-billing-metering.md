# 41 — Billing & Metering Architecture

> Part IV · Non-functional / Foundations · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan §7 billing/budgets](../00-MASTER-PLAN.md#7-billing-budgets--the-central-portal) ·
> [Master Plan A0/A7](../00-MASTER-PLAN.md#epic-a0--brakes-first-budgets-kill-switch-checkpoints-audit) ·
> [F-ENTERPRISE-FOUNDATIONS §F2 distributed correctness/idempotency](../F-ENTERPRISE-FOUNDATIONS.md) ·
> [05 Business model & pricing](./05-business-model-pricing.md) ·
> [06 Data model](../06-DATA-MODEL.md). Grounded in audited code:
> `server/src/services/costEstimator.ts`, `billingLedger.ts`, `usageEnforcer.ts`,
> `stripe.ts`, `stripePriceConfig.ts`, `pricingCatalog.ts`,
> `server/src/jobs/dailyBillingReconciliation.ts`, `server/src/routes/webhook.ts`,
> `shared/types/billing.ts`.

> **Numbers in this section are illustrative.** Every unit price, markup, cap, and worked
> figure is either (a) a value already in code, cited to its file, or (b) a clearly-marked
> *proposal* the owner sets. Nothing here is a price commitment; it is the architecture
> that *carries* whatever prices the owner chooses.

## 41.1 What this section is, and the honesty frame

This is the *engineering* companion to [05 Business model & pricing](./05-business-model-pricing.md)
(the *what we charge*) and the upstream of [40 Cost model & FinOps](./40-cost-finops.md) (the *what
it costs us*). It specifies the **metering pipeline** — how a unit of agent work becomes a reserved,
settled, capped, and reconciled dollar — and how Autopilot extends that pipeline from a single
interactive build to a per-venture, always-on ledger without rewriting the parts that already work.

The honesty frame is the one used across this spec. Two thirds of the billing surface is **shipped
and battle-tested** by the existing comic/studio product; Autopilot's job is *additive tagging and
one new gate*, not a new billing system. We mark every claim:

- **✅ SHIPPED** — exists in this repo today, cited to a file/line. Reused verbatim.
- **◐ PARTIAL** — exists but needs a small additive change (a `venture_id` tag, one new axis).
- **📋 PLANNED** — specced here, built by Epic A0 / A7; nothing yet.

The single design rule: **credits (CT) are the unit of account, and the existing ledger is the
source of truth.** A venture is a *tagged consumer* of the same wallet, and a venture budget is a
*sub-ceiling inside* that wallet — never a second wallet, never a parallel ledger.

```
CT_USD = 0.0001   →   10,000 CT = $1.00            (pricingCatalog.ts:11)   ✅
DEFAULT_MARKUP = BILLING_PLATFORM_MARKUP = 1.30×    (pricingCatalog.ts:12)   ✅  ← the one margin knob
```

---

## 41.2 The metering pipeline, end-to-end

Every billable thing an agent does — a model call, a build minute, a managed-hosting minute, a
domain purchase — passes through the **same four-stage pipeline**. The stages map cleanly onto the
loop tick's DECIDE → ACT → REFLECT phases ([Master Plan §4.1](../00-MASTER-PLAN.md#4-target-architecture)).

| Stage | Function (file) | Status | What happens | Loop phase |
|---|---|---|---|---|
| **1. Estimate** | `estimateCharge()` (`costEstimator.ts:101`) | ✅ | 4-axis pricing → provider cost × markup → CT. `:free` / all-zero axes short-circuit to $0 (`:113`). | DECIDE (pre-spend) |
| **2. Reserve** | `reserveUsageTokens()` (`billingLedger.ts:824`) | ✅ | Holds CT against the account wallet; checks daily guardrail, included → purchased → overage; BYOK takes the `$0 BYOK_TRACKED` bypass (`:839`). | DECIDE → ACT |
| **3. Settle** | `settleReservation()` (`billingLedger.ts:1071`) | ✅ | Re-estimates from *real* usage (trusts `usage.providerCostUsd`, `costEstimator.ts:227`); writes the `SETTLE` ledger entry; updates daily rollup; runs overage capture + usage alert. | REFLECT |
| **4. Release** | `releaseReservation()` (`billingLedger.ts:984`) | ✅ | On failure/abort, returns the held CT; writes `RELEASE`. | ACT (error path) |

The Express orchestration that wraps these four for an HTTP operation is **already shipped** in
`usageEnforcer.ts`: `reserveForOperation()` (`:49`) → run → `settleReservedOperation()` (`:159`) /
`releaseReservedOperation()` (`:207`). Autopilot's tick calls the **same enforcer functions** from
the ventures worker; it just passes a `venture_id` in `metadata` and reads `venture_budgets` first.

### 41.2.1 End-to-end flow (one model call, today, ✅ shipped)

```
 caller (tick / route)        costEstimator           billingLedger              Stripe / wallet
 ──────────────────────       ─────────────           ────────────              ───────────────
        │                          │                       │                          │
   build seed ───────────────────► estimateCharge()        │                          │
        │                     4-axis × markup → CT          │                          │
        │ ◄──────────────── TokenEstimateResponse           │                          │
        │                          │                        │                          │
   reserveUsageTokens(estimate) ───────────────────────────► RESERVE                   │
        │                          │             daily-guardrail? included?            │
        │                          │             purchased? overage<cap?               │
        │ ◄────────── allowed:true (reservationId)  │  else LimitExceededDetails       │
        │                          │                        │                          │
   ── run the model / build ──      │                        │                          │
        │                          │                        │                          │
   settleReservation(actual) ──────────────────────────────► SETTLE (ct_delta=-actual) │
        │                     trust providerCostUsd     daily rollup ++                 │
        │                          │                  maybeCapturePendingOverage ───────► off-session charge
        │                          │                  maybeAutoReloadWallet (off)        │
        │                          │                  maybeRaiseUsageAlert (80/100%)     │
        │ ◄──────── { actualCt, billableUsd, providerCostUsd }                          │
```

Two invariants the code already guarantees, which Autopilot inherits free:

1. **Estimate-then-settle prevents bill shock.** Reserve uses the *estimate* (so we never spend CT
   we cannot hold); settle corrects to the provider's *actual* cost when reported
   (`buildSettleEstimateFromUsage`, `costEstimator.ts:201`). The DECIDE gate can therefore be a
   *pure* function of the estimate (no LLM, no I/O surprises).
2. **BYOK is genuinely $0.** When a BYOK key is present, reserve writes `BYOK_TRACKED` and settle
   writes `BYOK_SETTLED` — both `ctDelta:0, usdDelta:0` (`billingLedger.ts:846`, `:1087`). The
   line is *visible* in usage history but *not billed*. This is the wedge from [05 §5.2](./05-business-model-pricing.md#52-metering-units-and-how-they-map-to-existing-assets)
   made literal.

---

## 41.3 The metered units

Everything billable reduces to **four axes** on `TokenBreakdownLine`
(`shared/types/billing.ts:53`): `input_tokens`, `output_tokens`, `image_units`, `other_billable`.
Autopilot adds *no new axis* — container-minutes and managed hosting ride the `other_billable` axis
with `units = minutes` and a `unitPrice = our managed minute rate`.

| Unit | Axis | Definition | Mapping | Status |
|---|---|---|---|---|
| **Agent tokens** | `input_tokens` / `output_tokens` (+ `image_units`) | LLM in/out tokens per tick (ORIENT/ACT). | `estimateCharge` 4-axis from `pricingCatalog`; reserved/settled by the ledger. | ✅ reused as-is; just tag `venture_id`. |
| **Container-minutes** | `other_billable` | Sandbox build/runtime time in the Cloudflare Container. | Already lands in `studio_runs.cost_usd` (`awake_seconds` → cost, [06 Data model](../06-DATA-MODEL.md)). Roll the per-tick minutes into the ledger via `otherBillableUnits` + `otherBillableUnitPriceUsd`. | ◐ plumbing exists; add the ledger roll-up. |
| **Managed hosting** | `other_billable` | Container-minutes + egress for previews/production *we* host. | Same `studio_deployments` / `studio_runs` plumbing, metered as `other_billable`, tagged `venture_id`. **Zero when the venture is BYO.** | ◐ |
| **Third-party / provider** | n/a (pass-through) | Paid resources the agent buys for the user (a domain, a paid API). | **Always a checkpoint** ([Master Plan §8](../00-MASTER-PLAN.md#8-guardrails--checkpoints)). Recorded as a ledger entry + a `venture_event`. In BYO it is the user's own charge, surfaced for transparency, not billed by us. | 📋 (A5/A7) |

**Why `other_billable` and not a new column.** The axis already exists end-to-end —
`buildEstimateFromRequestBody` accepts `otherBillableUnits` / `otherBillableUnitPriceUsd`
(`costEstimator.ts:91`), `addLine('other_billable', …)` prices it (`:165`), and it settles like any
other line. Container-minutes are *just another priced unit*. This keeps one estimate object, one
reserve, one settle — minutes and tokens land in the **same** `SETTLE` entry for a tick, so a
tick's cost is a single atomic ledger fact. The **managed minute rate** is the owner-set
`other_billable` unit price (an open decision, [05 §5.9](./05-business-model-pricing.md#59-open-decisions-for-the-owner)).

### 41.3.1 The `venture_id` tag (◐ the A0 task)

The only schema-level change metering needs is a tag. It is purely **additive** — it changes no
existing behavior (the A0 acceptance bar: "with `VENTURES_ENABLED=false` nothing changes").

- The ledger already carries an open `metadata jsonb` on every entry; `venture_id` lives there, and
  `tick_id` / `run_id` alongside it for drill-down.
- `studio_runs` gets a `venture_id` column (A1), and `studio_runs.cost_usd` stays the
  authoritative compute cost per run.
- Every enforcer call from the tick threads `metadata: { venture_id, run_id, tick_id }` so the
  ledger, `generation_cost_events`, and the daily rollup are all sliceable by venture without a
  parallel table.

Per-venture spend is therefore a **query, not a new ledger**:
`sum(usd_delta) from token_ledger_entries where metadata->>'venture_id' = $1`.

---

## 41.4 Venture budgets — the DECIDE/REFLECT gate (📋 A0)

A **`venture_budgets`** row is the per-venture sub-ceiling inside the account wallet. It carries
four hard caps from the [glossary](../00-MASTER-PLAN.md#2-glossary): `usd_per_day`, `usd_total`,
`max_tokens`, `max_container_minutes`, plus running `spent_*` counters.

> **The budget never *adds* funds.** It only *limits* how much of the account wallet a single
> venture may consume. Account-level brakes (`overage_hard_cap_usd`, `updateSpendCap`,
> `billingLedger.ts:1316`) still apply on top. A venture cannot spend money the account doesn't
> have; an account with credit still cannot let one venture exceed its budget.

The gate is a **pure, deterministic function — no LLM, no network** — so it is fast, testable, and
cannot itself fail open. It is read **before** spend (DECIDE) and the counters are updated **after**
spend (REFLECT):

```ts
// server/src/ventures/budget.ts  (📋 A0; unit-tested per A0 acceptance)
type BudgetDecision = { allow: true } | { allow: false; reason: BudgetBreach };

function evaluateBudget(b: VentureBudget, est: TokenEstimateResponse, minutes: number): BudgetDecision {
  const usd = est.estimatedBillableUsd;                            // from costEstimator (DECIDE input)
  if (b.spent_usd_today + usd     > b.usd_per_day)          return deny('usd_per_day');
  if (b.spent_usd_total + usd     > b.usd_total)            return deny('usd_total');
  if (b.spent_tokens + est.tokens > b.max_tokens)           return deny('max_tokens');
  if (b.spent_minutes + minutes   > b.max_container_minutes) return deny('max_container_minutes');
  return { allow: true };
}
```

**DECIDE** calls `evaluateBudget` on the tick's *estimate*. If any cap would be breached → the tick
**does not spend**; it raises a **budget checkpoint** and **pauses** the venture (it does *not*
fail — paused work resumes when the budget is raised or credits are topped up). **REFLECT** then
increments `spent_usd_today / spent_usd_total / spent_tokens / spent_minutes` from the *settled*
actuals and writes a `venture_event` (`{what, why, cost, result}`).

```
breach path:   DECIDE evaluateBudget → deny  →  create checkpoint (BUDGET)  →  venture.status = paused
                                                  + usage alert 80/100%  (maybeRaiseUsageAlert reuse)
resume path:   owner raises usd_per_day / usd_total  OR  tops up credits  →  scheduler re-includes venture
```

Two breach surfaces, one behavior — **pause, never silently overspend**:

| Breach | Where caught | Result |
|---|---|---|
| Venture cap (`usd_per_day` etc.) | `evaluateBudget` at DECIDE | Pause + budget checkpoint + alert |
| Account cap (`overage_hard_cap_usd`) | `reserveUsageTokens` → `OVERAGE_CAP_REACHED` (`billingLedger.ts:907`) | Reserve refused → tick pauses |
| Daily guardrail (per plan) | `reserveUsageTokens` → `DAILY_LIMIT_EXCEEDED` (`:872`) | Reserve refused → tick pauses till daily reset |
| Global kill switch (`VENTURES_KILL`) | scheduler, every tick | All ventures halt |

The four account/plan brakes are **✅ shipped**; the venture cap is the one **📋 new** brake, and
it sits *in front* of the shipped ones. This is the "brakes before the engine" stance from
[Master Plan §8](../00-MASTER-PLAN.md#8-guardrails--checkpoints): A0 ships the gate before A2 wires
the loop.

---

## 41.5 Stripe integration (✅ shipped, reused)

Money in/out is **Stripe**, and the integration is shipped for the existing product. Autopilot
re-skins plan/credit config rows and reuses the rest verbatim.

| Capability | Function (file) | Status | Notes |
|---|---|---|---|
| **Plan subscription** | `createPlanCheckoutSession` (`stripe.ts:567`, `mode:'subscription'`) | ✅ | Synced by `syncSubscriptionFromStripe`. |
| **Credit top-up (Checkout)** | `createCreditPackCheckoutSession` (`stripe.ts:606`, `mode:'payment'`) | ✅ | One-off pack purchase. |
| **Customer portal** | `createBillingPortalSession` (`stripe.ts:643`) | ✅ | Self-serve PM update, cancel, invoices, refunds. |
| **Webhook ingress** | `POST /api/webhook/stripe` (`routes/webhook.ts:7`) → `handleStripeWebhook` (`stripe.ts:729`) | ✅ | `express.raw()` body; `stripe-signature` verified via `constructEvent` (`:737`). |
| **Price resolution** | `stripePriceConfig.ts` | ✅ | **DB-first, env fallback** (`getEnvPlanPriceId` `:63`, `getEnvCreditPackPriceId` `:79`), 30 s cache. Re-skin Free/Pro/Team = config rows, not code. |
| **Coupons / entitlements** | coupon definitions + assignments + `CouponEntitlementPolicy` (`shared/types/billing.ts:34`) | ✅ | CT bonuses, plan/guardrail overrides; surfaced as `activeCouponEntitlement` on the billing summary. |

### 41.5.1 Webhook handling (✅) — the events Autopilot relies on

```
Stripe ──► POST /api/webhook/stripe ──► constructEvent (verify sig)
                                            │
                                  WEBHOOK_MAX_AGE_SECONDS guard (reject stale, stripe.ts:743)
                                            │
                                  upsertWebhookProcessingState(event.id)   ← dedupe (stripe.ts:747)
                                            │  alreadyProcessed? → { replayed:true }, no-op
              ┌─────────────────────────────┼─────────────────────────────────┐
   checkout.session.completed     customer.subscription.*        invoice.payment_failed / .paid
   → handleCheckoutCompleted      → syncSubscriptionFromStripe   → handleInvoiceLifecycleUpdate
     → addPurchasedCredits          (created/updated)              (marks stripe_status)
       (purchased_ct ++,          .deleted → handleSubscriptionDeleted (drop to Free)
        CREDIT_PURCHASE entry)
                                            │
                            markWebhookProcessed(event.id)  /  markWebhookFailed on throw
```

Webhooks are the boundary where money becomes ledger truth, so they are **idempotent on three
levels** (the F2 requirement, [§41.8](#418-idempotency-the-f2-requirement)).

---

## 41.6 Credits / wallet model & draw-down (✅ shipped + 📋 the venture sub-ceiling)

Credits sit *underneath* the plan. The wallet (`WalletBalance`, `shared/types/billing.ts:100`) has
three CT pools that draw down in a fixed order:

```
available CT = includedMonthlyCt (plan grant)  →  purchasedCt (top-ups)  →  overageCt (metered, Pro/Team)
                                                   │
            credit top-up: createCreditPackCheckoutSession → addPurchasedCredits (purchased_ct ++)
            plan grant: setUserPlanTier sets includedMonthlyCt mid-cycle (billingLedger.ts:1437)
```

**Per-tick draw-down order (the precise sequence):**

1. **DECIDE — venture budget first (📋).** `evaluateBudget(venture_budgets, estimate, minutes)`. If
   it would breach → pause + checkpoint, **no spend, no reserve**.
2. **DECIDE — account reserve (✅).** `reserveUsageTokens` holds CT from the **account** wallet
   (included → purchased → overage), honoring the daily guardrail and the overage hard cap. If the
   account can't cover it → `LimitExceededDetails` → tick pauses with a recommended action
   (upgrade / add credits / wait for reset).
3. **REFLECT — settle (✅) + venture counters (📋).** `settleReservation` corrects to actual CT and
   writes `SETTLE`; the tick then increments the venture's `spent_*` and writes a `venture_event`.

`addPurchasedCredits` (`billingLedger.ts:1191`) increments `purchased_ct` and writes a
`CREDIT_PURCHASE` entry; volume-discounted packs ($10→100k, $25→260k, $100→1.1M CT) are reused
verbatim. **Auto-reload is off by policy** (`AUTO_RELOAD_POLICY_ENABLED = false`); top-up is a
conscious act — the "never surprise me with a bill" stance. The plumbing
(`maybeAutoReloadWallet`, `billingLedger.ts:1175`) exists if the owner enables it later.

---

## 41.7 Plan entitlements via RBAC / model-access policy (✅ shipped, ◐ extended)

What a plan *unlocks* is **data, not code** — entitlement rows + two policy modules.

| Entitlement | Mechanism | Status |
|---|---|---|
| **Monthly included CT + daily guardrail** | `BillingPlanDefinition` (`billing.ts:7`); `setUserPlanTier` resyncs mid-cycle. | ✅ |
| **Model access** | `modelAccessPolicy.ts` — `toEffectiveTier` maps pro/studio/admin → full catalog; Free → free models + a daily image cap. | ✅ |
| **Role gates (org/admin)** | `rbac.ts` roles. | ✅ |
| **Active-venture count, concurrent-tick count, managed-minute pool** | *New* per-plan numbers on the entitlement row, read by the scheduler + DECIDE. | 📋 (A7) |
| **Production deploy, BYO connections** | Plan-gated capability, checkpoint-enforced. | 📋 (A5/A7) |

Because the internal `pro` tier is already filtered out of the public catalog
(`getPricingCatalog`, `pricingCatalog.ts:524`), the proposed **Free / Pro / Team** line re-skins
onto the existing `creator/studio` machinery as **config rows, no migration**
([05 §5.3](./05-business-model-pricing.md#53-pricing-tiers-proposed)). Autopilot's three new limits
(ventures, ticks, minutes) are *new entitlement fields*, evaluated by the same gate that already
reads model access.

---

## 41.8 Idempotency — the F2 requirement

Billing events must be **exactly-once in effect** the moment >1 worker instance runs
([F2](../F-ENTERPRISE-FOUNDATIONS.md)). The shipped Stripe path already enforces this; the venture
worker must hold the same bar.

| Surface | Mechanism | Status |
|---|---|---|
| **Stripe webhooks** | `upsertWebhookProcessingState(event.id)` dedupe + `WEBHOOK_MAX_AGE_SECONDS` stale reject (`stripe.ts:747`, `:743`); `markWebhookProcessed` / `markWebhookFailed`. | ✅ |
| **Credit grants** | Dedupe by `checkoutSessionId` (`hasProcessedCreditCheckout`) — a replayed `checkout.session.completed` grants credits **once**. | ✅ |
| **Reserve/settle** | Each reservation has a `reservationId` (uuid, `billingLedger.ts:915`); settle/release are keyed to it; the `generation_cost_events` row transitions `RESERVED → SETTLED/RELEASED` once. | ✅ |
| **Per-tick metering (📋)** | A tick must reserve/settle **once** even if the worker crashes and the BullMQ job retries. Key the tick's billing on a deterministic `(run_id, tick_id)` idempotency key; a re-run finds the existing `RESERVE`/`SETTLE` for that tick and is a no-op. (F2: move shared caps to Redis so concurrency caps hold across instances; remove fail-open-on-DB-error gaps.) | 📋 (A0/A2 + F2) |

> **The F2 hard rule applies to billing too:** an always-on builder you can't bill correctly
> across instances is not production-ready. The tick idempotency key + Redis-shared concurrency
> caps are a *gate*, not a nicety — they ship with A2, before real autonomous builds.

---

## 41.9 Daily reconciliation (✅ shipped, ◐ extended for venture compute)

`runDailyBillingReconciliation` (`jobs/dailyBillingReconciliation.ts:52`) is **shipped**. It walks a
rolling window (`BILLING_RECON_WINDOW_HOURS`, default 24) and proves the ledger agrees with Stripe:

```
token_ledger_entries (CREDIT_PURCHASE, OVERAGE_CAPTURE)   Stripe paymentIntents (kind∈{credit_pack,
   indexed by metadata.paymentIntentId          ◄────►       auto_reload, overage_capture})
                          │                                          │
              missingInStripe[]  (ledger says paid, Stripe doesn't)  │
              missingInLedger[]  (Stripe charged, ledger missing)    │
              + failed stripe_webhook_events in window               │
                          │
              --strict  →  throw if any drift  (CI / alerting gate)
```

**Autopilot extension (◐, the A7 task):** add a *third* leg — per-venture compute. The job should
cross-check, per `venture_id`:

1. **Ledger ↔ runs:** `sum(SETTLE usd_delta where venture_id)` must equal
   `sum(studio_runs.cost_usd where venture_id)` for venture compute (managed minutes shouldn't
   exist in one place and not the other).
2. **Ledger ↔ provider invoices:** for managed ventures, our metered provider-cost lines must
   reconcile against the actual Cloudflare/model provider invoice (within tolerance), so markup is
   computed on real COGS.
3. **Budget counters ↔ ledger:** each `venture_budgets.spent_*` must equal the summed ledger for
   that venture (counter drift = a paused-too-early/late bug).

Same `--strict` semantics: in CI/alerting, any drift throws. This closes the loop between *what we
metered*, *what we billed*, and *what we were charged*.

---

## 41.10 Invoicing, refunds, proration, dunning, failed payment (✅ shipped)

Mostly handled by the shipped Stripe + ledger machinery; Autopilot adds only the **budget-exhausted
pause** behavior on top.

| Case | Behavior | Backing | Status |
|---|---|---|---|
| **Invoicing** | Stripe invoices subscriptions + metered overage; self-serve via the portal. | `createBillingPortalSession` (`stripe.ts:643`) | ✅ |
| **Refunds** | Refund/reversal via the Billing Portal; credit-pack refunds reverse *unspent* `purchased_ct` only (owner policy) with a ledger reversal entry. | `stripe.ts`, ledger reversal | ✅ (policy: owner) |
| **Proration** | Plan up/downgrade prorates via Stripe subscription items; `syncSubscriptionFromStripe` re-resolves tier + entitlement; `setUserPlanTier` updates included CT mid-cycle. | `stripe.ts:281`, `billingLedger.ts:1437` | ✅ |
| **Failed payment** | `invoice.payment_failed` → `handleInvoiceLifecycleUpdate` marks `stripe_status`; off-session overage capture that fails simply doesn't capture (`createOffSessionCharge` returns null, no throw). | `stripe.ts:771` | ✅ |
| **Dunning** | Past-due → Stripe Smart Retries + in-app/email notice; **ventures stay paused (not deleted)** until resolved. On `customer.subscription.deleted` → drop to Free (`handleSubscriptionDeleted`, `stripe.ts:768`); ventures persist but lose Pro/Team entitlements (prod deploy, extra concurrency). | `stripe.ts:768`, dunning policy (owner) | ✅ + 📋 venture pause |
| **Budget exhausted** | Venture **pauses** (does not fail) on cap breach; budget checkpoint + 80%/100% usage alert; raising the budget or topping up resumes it. Account alerts already dedupe at 80%/100% (`maybeRaiseUsageAlert`). | `venture_budgets`, `billingLedger.ts:1177` | 📋 (A0/A7) |

---

## 41.11 Managed markup vs BYO pass-through accounting

Two cost flows, one ledger. The *accounting difference* is entirely in **who bears the COGS** and
therefore **what we book as revenue vs. pass-through** — the ledger entries differ only by which
lines are non-zero.

| | **Managed venture** | **BYO + BYOK venture** |
|---|---|---|
| Model tokens | We front it → metered at `markup` (1.30×). | BYOK → `BYOK_TRACKED`/`BYOK_SETTLED`, **billed $0** (`billingLedger.ts:846`). |
| Container-minutes | `other_billable` × managed rate × markup. | Orchestration sandbox only; metering it under BYO is an *owner decision* ([05 §5.5](./05-business-model-pricing.md#55-managed-vs-byo-cost-flows-who-pays-whom)). |
| Hosting | `other_billable` × markup (we front the provider bill). | **$0 to us** — user's own Cloudflare/Vercel/etc. via `venture_connections`. |
| Third-party (domain, paid API) | **Pass-through** — `markup 1.00×`, no margin, checkpoint-gated; Stripe collects, we remit. | The user's own provider charge — surfaced for transparency, **not billed by us**. |
| Our gross margin | plan + (metered × `0.30/1.30 ≈ 23%` of billed) − provider/host COGS. | ≈ plan (COGS ~0). |

```
MANAGED                                       BYO + BYOK
───────                                       ──────────
User ─$plan + metered─► Us                     User ─$plan only─► Us  (orchestration overhead)
                │                                       │
   Us ─$model─► Provider  (markup 1.30×)        User ─$model─► Provider (their key)  ⇒ we bill $0
   Us ─$host──► Cloudflare (markup 1.30×)        User ─$host──► their Cloudflare (pass-through)
   Us ─$3p────► (domain)  (markup 1.00×, remit)  User ─$3p────► (their card; we only surface)
```

The **pass-through line** is the one accounting subtlety: a domain purchase is `markup = 1.00×` so
the billed line equals provider cost — **no margin, no risk**. It is still a `SETTLE`-class ledger
entry tagged `venture_id` (so per-venture spend is complete) plus a `venture_event` (so the audit
trail explains the dollar), but it is excluded from gross-margin math because it carries no markup.

---

## 41.12 Worked example — one metered build tick (illustrative)

ASCII flow of a single ACT tick that does an ORIENT model call (~$0.06 provider) and a 2.5-minute
container build, on a managed Pro venture with a $5/day budget. Figures illustrative.

```
 ┌──────────────────────────── ONE BUILD TICK (managed, Pro, usd_per_day=$5.00) ───────────────────────────┐
 │                                                                                                          │
 │  SENSE/ORIENT ─► estimateCharge:  tokens ~$0.06 ×1.30 = $0.078  +  2.5 min × $0.004 ×1.30 = $0.013       │
 │                                   estimate ≈ $0.091  ≈ 910 CT                                            │
 │                          │                                                                                │
 │  DECIDE ─► evaluateBudget(venture_budgets, est, minutes=2.5):                                            │
 │            spent_today $1.20 + $0.091 = $1.29  ≤ $5.00  ✔   tokens ✔   minutes ✔   →  ALLOW              │
 │            reserveUsageTokens(910 CT):  included? purchased? overage<cap?  →  RESERVE (reservationId)    │
 │                          │                                                                                │
 │  ACT  ─► build runs in the Cloudflare sandbox  →  studio_version created  (studio_runs row, awake=150s)  │
 │                          │                                                                                │
 │  VERIFY ─► typecheck/build/tests + code-safety scan  (no billing effect)                                 │
 │                          │                                                                                │
 │  REFLECT ─► settleReservation(actual):  provider reports $0.058 + minutes $0.010  →  $0.088 ×1.30        │
 │             SETTLE  ct_delta = −884 CT,  usd_delta = −$0.0884   metadata:{ venture_id, run_id, tick_id } │
 │             venture_budgets.spent_usd_today += $0.0884  →  $1.288                                        │
 │             studio_runs.cost_usd = $0.088 ;  venture_event { what:'built landing hero', cost:$0.088 }    │
 │             maybeRaiseUsageAlert: 25% of $5/day  →  no alert                                             │
 │                          │                                                                                │
 │            ◄── released held CT difference (reserve 910 → settle 884 = 26 CT returned)                   │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────┘

 NEXT TICK would breach:  spent_today $4.97 + est $0.09 = $5.06 > $5.00
   →  DECIDE deny('usd_per_day')  →  no reserve, no spend  →  checkpoint(BUDGET) + alert(100%)  →  venture PAUSED
   →  owner raises usd_per_day to $10 (or tops up)  →  scheduler re-includes venture  →  resumes
```

The tick produces **one** `SETTLE` entry (tokens + minutes together), **one** `studio_runs.cost_usd`,
**one** `venture_event`, and an updated budget counter — all tagged `venture_id`. That single atomic
fact is what every downstream surface reads: the portal's per-venture meter, the daily
reconciliation's three-way check, and the budget gate's next decision.

---

## 41.13 Mapping to the backlog

| Epic | What this section requires of it | Acceptance touchpoint |
|---|---|---|
| **A0 — Brakes first** | `venture_budgets` table + RLS; pure `budget.ts` evaluator (§41.4); wire the `venture_id` metering tag (additive, `costEstimator`/`billingLedger`); kill switch; per-tick idempotency key (F2). | "set a budget, breach → pause, read audit; with flag off nothing changes." |
| **A7 — Central billing portal** | Surface per-venture spend (the `venture_id` query); budget sliders → `venture_budgets`; credits top-up (reuse `stripe.ts`); 80/100% alerts; **extend `dailyBillingReconciliation` for venture compute** (§41.9). | "owner sees per-venture cost, sets a hard budget, tops up, is alerted before overspend; reconciliation matches." |
| **F2 — Distributed correctness** | Redis-shared caps; exactly-once tick billing on crash/retry; remove fail-open-on-DB-error gaps. | "limits hold across instances; a retried tick bills once." |

Cross-refs: the pricing this architecture carries is in
[05 Business model & pricing](./05-business-model-pricing.md); the COGS drivers and warm-pool
FinOps it feeds are in [40 Cost model & FinOps](./40-cost-finops.md); the tables and RLS are in
[26 Data model & schema](./26-data-model-schema.md).
