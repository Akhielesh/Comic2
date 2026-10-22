# 05 — Business Model & Pricing

> Part I · Product & Strategy · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan §7 billing](../00-MASTER-PLAN.md#7-billing-budgets--the-central-portal) ·
> [Foundations](../F-ENTERPRISE-FOUNDATIONS.md)

> **Numbers in this section are illustrative / proposed.** The owner sets final list
> prices, plan limits, and the platform markup. Every figure here is either (a) a value
> already in the code (cited to a file) or (b) a clearly-marked *proposal*. Nothing here is
> a commitment; it is a coherent model to react to.

## 5.1 Revenue model overview

Autopilot earns money from three layers, deliberately separated so the customer always knows
*who they are paying for what*:

| Layer | What it is | Who bears the COGS | Our take |
|---|---|---|---|
| **Platform fee** | A monthly subscription (Free / Pro / Team) for access, entitlements, included credits, concurrency, and support. | Us (fixed infra) | Recurring margin; the base of LTV. |
| **Metered agent compute** | Pay-as-you-go for what the agents actually consume — model tokens + container-minutes — drawn from included credits, then top-up credits, then (Pro/Team only) metered overage. | Us, unless **BYOK** (then ~0) | A markup on real provider cost. |
| **Managed hosting** | Optional convenience: we host previews/production on *our* infra and meter container-minutes + egress. | Us (we front the provider bill) | Markup on managed minutes. |

The strategic wedge, established in [02 §2.7](./02-market-competitive-analysis.md#27-pricing-posture-vs-market):
**a low platform fee + metered compute, where BYOK collapses model COGS to ~0 and BYO hosting
is a pure pass-through (the user pays Cloudflare/Vercel/Supabase/Railway directly).** Bundled
competitors mark up model + compute inside one seat price; we let the cost-sensitive builder
route around our COGS entirely while still paying us for the platform, governance, and
orchestration they cannot get elsewhere.

Two pricing surfaces, two cost flows, one portal:

- **Managed venture** — we front provider + model cost; metering + budgets are *mandatory*
  (the kill switch and `venture_budgets` are how managed hosting can't bankrupt us — see
  [Master Plan §11](../00-MASTER-PLAN.md#11-risks--honest-caveats)).
- **BYO venture** — the user connects their own provider accounts (`venture_connections` via
  Nango) and their own model keys (BYOK); we meter only our orchestration overhead and bill the
  platform fee. Model COGS → ~0; hosting COGS → 0 (theirs).

## 5.2 Metering units and how they map to existing assets

Everything billable reduces to four units. The first two already flow through the live billing
pipeline; the last two are additive extensions tagged by `venture_id` (the A0 task "wire
metering tags," [Master Plan A0](../00-MASTER-PLAN.md#epic-a0--brakes-first-budgets-kill-switch-checkpoints-audit)).

| Unit | Definition | Existing asset it maps to | New for Autopilot |
|---|---|---|---|
| **Agent tokens** | LLM input/output tokens (and image units) per tick. | `costEstimator.ts` `estimateCharge()` → 4-axis pricing from `pricingCatalog.ts`; reserved/settled by `billingLedger.ts` (`reserveUsageTokens` → `settleReservation`); enforced by `usageEnforcer.ts`. | Add `venture_id` to the metering metadata; otherwise reused as-is. |
| **Container-minutes** | Sandbox/build/runtime execution time in the Cloudflare Container. | Studio compute already lands in `studio_runs.cost_usd`. | Roll the per-tick run cost into the venture ledger via the `other_billable` axis in `costEstimator.ts` (units = minutes, unit price = our managed minute rate). |
| **Managed hosting** | Container-minutes + egress for previews/production we host. | Same `studio_deployments` / `studio_runs` plumbing. | Metered as `other_billable` units, tagged `venture_id`; *zero* when the venture is BYO. |
| **Third-party / provider usage** | Paid resources the agent buys on the user's behalf (a domain, a paid API beyond budget). | New; **always a checkpoint** ([Master Plan §8](../00-MASTER-PLAN.md#8-guardrails--checkpoints)). | Recorded as a ledger entry + a `venture_event`; in BYO it is the user's own provider charge, surfaced for transparency, not billed by us. |

Mechanics worth stating precisely, because the code already enforces them:

- **Credits are the unit of account.** Internally everything is denominated in **CT**
  (`CT_USD = 0.0001`, i.e. **10,000 CT = $1.00**, `pricingCatalog.ts:11`). A tick estimates CT
  before it runs (DECIDE gate reads budget), reserves them, runs, then settles to *actual* CT
  using real provider cost when reported (`buildSettleEstimateFromUsage` trusts
  `usage.providerCostUsd`, `costEstimator.ts:227`).
- **Markup is a single knob.** `DEFAULT_MARKUP` = `BILLING_PLATFORM_MARKUP` (default **1.30**,
  i.e. +30% on provider cost, `pricingCatalog.ts:12`). This *is* our gross margin on metered
  managed compute. The owner changes margin by changing one env var.
- **BYOK is genuinely free.** When a BYOK header is present, `reserveUsageTokens` takes the
  `byokBypass` path: it records a `BYOK_TRACKED` ledger entry for visibility but **bills $0 and
  reserves 0 CT** (`billingLedger.ts:839`). Verified-free models (`:free` or all-zero axes)
  short-circuit to a $0 charge regardless of the snapshot (`costEstimator.ts:113`,
  `shared/pricing.ts` `classifyModel`). This is the economic moat made literal in code.

## 5.3 Pricing tiers (proposed)

The live code today exposes `free / creator / pro / studio` plans (`pricingCatalog.ts:25`).
**For Autopilot we propose a three-tier consumer-facing line — Free / Pro / Team — mapped onto
the existing plan + entitlement machinery** (`DEFAULT_BILLING_PLANS`, `DEFAULT_PLAN_ENTITLEMENTS`,
`billing_plans` / `billing_plan_entitlements` DB tables, and `rbac.ts` for role gates). The
internal `pro` tier is already hidden from the public catalog (`getPricingCatalog` filters it,
`pricingCatalog.ts:524`), so the names can be re-skinned without a migration — entitlements are
data, not code.

| | **Free** | **Pro** *(proposed)* | **Team** *(proposed)* |
|---|---|---|---|
| **Price (illustrative)** | $0 | ~$29/mo | ~$99/seat/mo |
| **Included credits/mo** | small grant (e.g. 10,000 CT ≈ $1, today's Free) | meaningful grant (e.g. 240,000 CT ≈ $24 today's Pro) | larger pooled grant |
| **Ventures (active)** | 1 | 3–5 | unlimited (fair-use) |
| **Concurrent builds (ticks)** | 1 | 2–3 | higher per-seat, pooled |
| **Venture budget caps** | low hard cap (managed previews only) | user-set, payment-backed overage | user-set + org-level rollup |
| **Managed minutes/mo** | trial-only (tight quota) | included pool + metered overage | larger pool + metered |
| **BYOK** | yes (the path to ~free) | yes | yes |
| **BYO hosting (Nango connections)** | — | yes | yes (per-venture, per-client) |
| **Production deploy** | — (preview only) | yes (checkpoint-gated) | yes (checkpoint-gated) |
| **Model access** | free-tier models only (`modelAccessPolicy.ts`) | full catalog incl. frontier-via-BYOK | full catalog |
| **Support** | community | email | priority + onboarding |
| **Governance (budgets/kill switch/audit)** | yes | yes | yes + org admin/RBAC |

Design rules behind the table:

- **Entitlements reuse existing primitives.** Active-venture count, concurrent-tick count, and
  managed-minute pool are new per-plan numbers on the entitlement row; model access is gated by
  `modelAccessPolicy.ts` (`toEffectiveTier` already maps `pro`/`studio`/`admin` → full access,
  Free → free models + a daily Nano-Banana cap). Daily guardrail CT
  (`DEFAULT_PLAN_ENTITLEMENTS`) remains the abuse brake on Free.
- **Free is a real product, not a trap.** It must produce a live preview and let a BYOK user
  run near-free, or the wedge claim is dishonest. Free is bounded by *managed cost* (one
  venture, one tick, tight managed quota, preview-only), never by punishing the user's own keys.
- **Pro is the prosumer / Persona "Dev" tier** ([03 §3.3](./03-personas-jtbd.md#33-persona-b--dev-the-solo-developer--indie-hacker)):
  BYOK + BYO hosting + multiple concurrent ventures + full GitHub sync.
- **Team is the agency / Persona "Sam" tier** ([03 §3.4](./03-personas-jtbd.md#34-persona-c--sam-the-small-team-lead--agency)):
  per-client ventures on the client's own clouds, per-venture budgets + invoices, org RBAC,
  and audit (`venture_events`).

## 5.4 Credits and top-up

Credits sit *underneath* the plan: the monthly grant is included CT; beyond it the user buys
top-up packs or (Pro/Team) accrues metered overage against a payment method.

- **Top-up via Stripe Checkout — already shipped.** `createCreditPackCheckoutSession`
  (`stripe.ts:606`) creates a one-off `mode: 'payment'` Checkout session for a credit pack; on
  `checkout.session.completed` the webhook calls `addPurchasedCredits` (`stripe.ts:429`), which
  increments `token_wallets.purchased_ct` and writes a `CREDIT_PURCHASE` ledger entry. Idempotent
  by `checkoutSessionId` (`hasProcessedCreditCheckout`). The existing packs (`CREDIT_PACKS`,
  `pricingCatalog.ts:106`) carry a **volume discount** — $10→100,000 CT (1.0×), $25→260,000 CT
  (1.04×), $100→1,100,000 CT (1.10×) — i.e. bigger packs buy more CT per dollar. Reuse verbatim.
- **Plan subscription** uses `createPlanCheckoutSession` (`stripe.ts:567`, `mode: 'subscription'`),
  synced by `syncSubscriptionFromStripe`; price IDs resolve through `stripePriceConfig.ts`
  (DB-first, env fallback). Re-skinning to Free/Pro/Team = config rows, not code.
- **How budgets draw down credits.** `venture_budgets` (`usd_per_day`, `usd_total`,
  `max_tokens`, `max_container_minutes`, [Master Plan §2](../00-MASTER-PLAN.md#2-glossary)) is the
  *per-venture* sub-ceiling **inside** the account wallet. Order of draw-down per tick:
  1. **DECIDE** estimates the tick's CT and checks `venture_budgets` (pure, no LLM — the A0 brake).
     If the tick would exceed `usd_per_day` / `usd_total` / token / minute caps → **pause +
     checkpoint**, no spend.
  2. If within the venture budget, `reserveUsageTokens` reserves CT from the **account** wallet
     (included → purchased → overage), exactly as today.
  3. **REFLECT** settles actual CT and increments the venture's spent counters; a
     `venture_event` records what/why/cost.
  The venture budget never *adds* funds — it only *limits* how much of the wallet a single
  venture may consume. Account-level brakes (`overage_hard_cap_usd`, `updateSpendCap`,
  `billingLedger.ts:1316`) still apply on top.
- **Auto-reload is off by policy** (`AUTO_RELOAD_POLICY_ENABLED = false`,
  `updateAutoReloadSettings` throws `AUTO_RELOAD_DISABLED`). Top-up is deliberately a conscious
  act — consistent with "never surprise me with a bill" (Persona Maya). The owner may enable it
  later; the plumbing exists (`maybeAutoReloadWallet`).

## 5.5 Managed vs BYO cost flows (who pays whom)

```
MANAGED venture                              BYO venture (+ BYOK)
─────────────                                ────────────────────
User ──$ plan + metered──► Us                User ──$ plan only──► Us
                  │                                     │ (orchestration overhead only)
   Us ──$ model──► Provider (OpenRouter/…)   User ──$ model──► Provider (their key)  [BYOK ⇒ we bill $0]
   Us ──$ host───► Cloudflare/etc.           User ──$ host───► their Cloudflare/Vercel/… (pass-through)

Margin = plan + (metered compute × markup) − our provider/host bill
                                             Margin = plan (≈ pure, COGS ~0)
```

In **managed**, we are a reseller: we front model + hosting, meter at `markup` (1.30×), and the
budget/kill-switch keep COGS bounded. In **BYO+BYOK**, we are a pure SaaS: the customer pays the
providers directly, our model and hosting COGS are ~0, and the plan fee is almost all margin.

### Worked example A — Maya, a managed venture (illustrative)

Non-technical founder, **Pro plan ($29/mo)**, managed hosting, *no* BYOK. One month: intake +
roadmap, then ~120 ticks building/iterating a habit-tracker SaaS, ending with a checkpointed
production deploy.

| Line | Provider cost | Markup | Billed to Maya |
|---|---:|---:|---:|
| Plan fee (Pro) | — | — | $29.00 |
| Agent tokens (~120 ticks, mixed models) | $8.00 | 1.30× | $10.40 |
| Build container-minutes (~300 min) | $1.20 | 1.30× | $1.56 |
| Managed hosting (preview + prod, ~600 min + egress) | $2.50 | 1.30× | $3.25 |
| Domain purchase (checkpoint-approved, pass-through) | $12.00 | 1.00× | $12.00 |
| **Total** | **$23.70** | | **$56.21** |

Included credits cover the first ~$24 of metered compute, so most of the $15.21 metered total is
absorbed by the grant; only the overage + the pass-through domain hit the card. **Our gross
margin** ≈ plan ($29) + metered markup (~$3.51) − our $11.70 compute/host COGS ≈ **$20.81**
before payment fees. The domain is a pass-through (no margin, no risk — Stripe collects, we remit
or the user's own payment method is charged at the checkpoint).

### Worked example B — Dev, a BYOK + BYO venture (illustrative)

Solo developer, **Pro plan ($29/mo)**, **BYOK** (own OpenRouter key) + **BYO hosting** (own
Cloudflare account via Nango). Same scale of work (~120 ticks), production on his Cloudflare.

| Line | Who pays | Our COGS | Billed by us |
|---|---|---:|---:|
| Plan fee (Pro) | Dev → Us | — | $29.00 |
| Agent tokens (BYOK) | Dev → OpenRouter (his key) | $0.00 | $0.00 (tracked, not billed) |
| Build container-minutes (orchestration sandbox) | Us | ~$1.20 | $0.00–$1.56* |
| Production hosting | Dev → Cloudflare (his account) | $0.00 | $0.00 |
| **Total billed by us** | | **~$1.20** | **~$29.00** |

\* Whether we meter the orchestration sandbox even under BYO/BYOK is an **owner decision**: it is
real COGS we bear, but waiving it strengthens the BYOK value story. Either way the line is small.
**Our gross margin** ≈ $29 − ~$1.20 ≈ **$27.80** — near-pure SaaS margin, because BYOK zeroes
model COGS and BYO hosting is the user's bill. This is the structural advantage over any
competitor who bundles (and eats) model spend.

## 5.6 Unit economics / gross-margin sketch (illustrative)

Per-active-venture, per-month, assuming the markup (1.30×) is the only lever on metered compute:

| Tier | Avg revenue / active user | Est. COGS (managed-heavy) | Est. COGS (BYOK/BYO-heavy) | Gross margin band |
|---|---:|---:|---:|---:|
| **Free** | $0 (acq. cost) | $0.20–$1.00 (capped) | ~$0 | negative-to-zero (intentional CAC) |
| **Pro (managed mix)** | ~$40–55 | $12–18 | $1–3 | **~60–75%** |
| **Pro (BYOK/BYO)** | ~$29 | ~$1–2 | ~$1 | **~95%** |
| **Team (per seat)** | ~$99 | $20–35 | $2–6 | **~65–95%** |

The spread is the whole story: **the same plan price yields ~60% margin for a managed user and
~95% for a BYOK/BYO user.** We are economically indifferent to which the customer picks — managed
trades convenience for margin we earn via markup; BYOK trades our margin source from compute to
the flat fee. Both are profitable; neither bundles a model bill we can't control. Bundled
competitors must price in their *worst-case* model spend, so their headline price is structurally
higher for the same value, or their margin is thinner.

Sensitivity: margin on managed compute scales linearly with `BILLING_PLATFORM_MARKUP`. At 1.30×,
gross margin on metered compute is `0.30 / 1.30 ≈ 23%` of the billed line. Raising it to 1.50×
lifts that to ~33% — a one-env-var lever the owner can tune against churn.

## 5.7 COGS drivers and cost controls

**Drivers** (descending impact for managed ventures): model tokens (largest, frontier models
dominate), container-minutes (build + runtime), egress, Stripe fees (~2.9% + $0.30/txn), and idle
warm-pool capacity. BYOK + BYO removes the first three from *our* books.

**Controls — most are already brakes in the plan, not new spend:**

| Control | Mechanism | Where |
|---|---|---|
| **Venture budgets** | Hard `usd_per_day` / `usd_total` / token / minute caps; DECIDE refuses, REFLECT tracks. | `venture_budgets`, A0 budget evaluator |
| **Account spend cap** | `overage_hard_cap_usd`, `OVERAGE_CAP_REACHED`. | `billingLedger.ts:907`, `updateSpendCap` |
| **Daily guardrail** | Per-plan daily CT ceiling on Free/Pro. | `DEFAULT_PLAN_ENTITLEMENTS`, `usageState` |
| **Plan quotas** | Active-venture, concurrent-tick, managed-minute pools. | entitlement rows + `rbac.ts` |
| **Global kill switch** | `VENTURES_KILL` halts every venture. | [Master Plan §8](../00-MASTER-PLAN.md#8-guardrails--checkpoints) |
| **Concurrency cap** | Global max concurrent ticks protects provider + bill. | scheduler ([Master Plan §5](../00-MASTER-PLAN.md#5-security--multi-tenancy)) |
| **No-progress detector** | Same failure N× → pause, not burn. | tick loop |
| **Free routing** | Free-first + `:free` models settle to $0. | `costEstimator.ts:113`, `modelAccessPolicy.ts` |
| **Warm-pool sizing** | Right-size the always-warm container count; scale-to-zero idle ventures (DO Alarms wake them). | [00 §0.3](./00-executive-summary.md#03-the-architecture-in-five-words) (Workers + DO + Containers) |

Warm-pool sizing is the one *new* FinOps decision Autopilot adds: a 24/7 product implies some
hot capacity. The DO-alarm heartbeat lets idle ventures scale to zero between ticks, so warm cost
tracks *active* ventures, not registered ones. (Full FinOps model: [40-cost-finops.md](./40-cost-finops.md).)

## 5.8 Billing edge cases

These are mostly handled by the existing Stripe + ledger machinery; Autopilot adds the
budget-exhausted pause.

| Case | Behavior | Backing |
|---|---|---|
| **Refunds** | Stripe refund / reversal via the Billing Portal (`createBillingPortalSession`, `stripe.ts:643`). Credit-pack refunds should reverse unspent `purchased_ct` (owner policy: refund unconsumed credits only). | `stripe.ts`, ledger reversal entry |
| **Proration** | Plan up/downgrade prorates via Stripe subscription items; `syncSubscriptionFromStripe` re-resolves tier + entitlement and `setUserPlanTier` updates the wallet's included CT mid-cycle. | `stripe.ts:281`, `billingLedger.ts:1437` |
| **Failed payment** | `invoice.payment_failed` webhook → `handleInvoiceLifecycleUpdate` marks `stripe_status`; off-session overage capture that fails simply doesn't capture (`createOffSessionCharge` returns null, no throw). | `stripe.ts:771`, `billingLedger.ts:556` |
| **Budget exhausted** | Venture **pauses** (does not fail) on cap breach; a budget checkpoint + an 80%/100% usage alert notify the user; raising the budget or topping up resumes it. Account-level alerts already dedupe at 80%/100% (`maybeRaiseUsageAlert`). | `venture_budgets`, `billingLedger.ts:1029` |
| **Dunning** | Past-due → Stripe Smart Retries + in-app/email notice; ventures stay paused (not deleted) until resolved. On `customer.subscription.deleted` the user drops to Free (`handleSubscriptionDeleted`) — ventures persist but lose Pro/Team entitlements (e.g. prod deploy, extra concurrency). | `stripe.ts:329`, dunning policy (owner) |
| **Webhook replay / dupes** | Idempotent: `stripe_webhook_events` dedupe + `WEBHOOK_MAX_AGE_SECONDS` reject stale events; credit grants dedupe by `checkoutSessionId`. | `stripe.ts:147`, `:742`, `:101` |
| **Reconciliation** | A daily reconciliation job (extend `dailyBillingReconciliation.ts`, [Master Plan A7](../00-MASTER-PLAN.md#epic-a7--central-billing--budgets-portal)) must include per-venture compute so the ledger matches Stripe + provider invoices. | A7 task |

## 5.9 Open decisions for the owner

1. **Final list prices + included-credit grants** for Free / Pro / Team (table §5.3 is a strawman).
2. **Platform markup** (`BILLING_PLATFORM_MARKUP`, today 1.30×) — the master margin knob.
3. **Managed minute rate** — the per-minute price for managed container-minutes (the
   `other_billable` unit price), and whether to meter the orchestration sandbox under BYO.
4. **Plan limits** — active ventures, concurrent ticks, managed-minute pools per tier.
5. **Refund/dunning policy specifics** — unconsumed-credit refunds, grace period before
   pause-vs-downgrade, auto-reload re-enable (currently off).
6. **Team org model** — per-seat vs pooled credits, org-level budget rollups, RBAC scopes
   (`rbac.ts` roles → org admin).

(Full billing/metering architecture: [41-billing-metering.md](./41-billing-metering.md). Value
proposition that this pricing serves: [04-value-proposition.md](./04-value-proposition.md).)
