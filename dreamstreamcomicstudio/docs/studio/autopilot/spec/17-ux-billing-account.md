# 17 — UX Spec: Billing & Account

> Part II · Product Definition · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan §7 billing](../00-MASTER-PLAN.md#7-billing-budgets--the-central-portal) ·
> [05 — Business Model & Pricing](./05-business-model-pricing.md) ·
> [12 — Information Architecture](./12-information-architecture.md)

> **Numbers in every wireframe and table below are illustrative.** Real figures come from the
> live ledger; final list prices, grants, and the markup are owner-set (see
> [05 §5.9](./05-business-model-pricing.md#59-open-decisions-for-the-owner)). The credit unit is
> **CT** (`CT_PER_USD = 10,000`, `services/pricingConfig.ts:5`); USD displayed = CT ÷ 10,000.

## 17.1 Scope, what ships when, and what is reused

This section specs the **central billing portal** — the "one payment portal that is our Code
Studio" ([Master Plan §7](../00-MASTER-PLAN.md#7-billing-budgets--the-central-portal)). It is a
single, account-level surface (`?view=billing` → `/billing`,
[12 §12.3](./12-information-architecture.md#123-route--url-scheme)) that answers four questions
without making the user hunt: *what am I spending, on which venture, against what cap, and how do I
pay?*

**Honest delivery split.** Most of this is delivered by **Epic A7 (Central billing & budgets
portal)**, but it stands on **Epic A0 (Brakes first)**, which already shipped the budget
evaluator, the metering tags, and the pause-on-breach behavior. A7 is the *UI over A0's plumbing*;
nothing here invents a new billing engine.

| UX area | Delivered by | Foundation reused |
|---|---|---|
| Portal shell, per-venture spend breakdown | **A7** | `services/billing.ts` (`getBillingSummary`, `getUsageHistory`); `billingLedger.ts` tagged by `venture_id` |
| Budget sliders + spend-vs-cap meters | **A7** UI · **A0** evaluator | `venture_budgets`; A0 budget evaluator |
| Credits / top-up (Stripe Checkout) | **shipped** | `services/billing.ts` `createCreditPackCheckout` → `stripe.ts` `createCreditPackCheckoutSession` |
| Plan / tier management + entitlements | **shipped + re-skin** | `createSubscriptionCheckout`, `cancelSubscription`, `reactivateSubscription`; `rbac.ts`, `modelAccessPolicy.ts` |
| Invoices / receipts / history | **shipped** (Stripe portal) | `createBillingPortal` → `stripe.ts` `createBillingPortalSession`; `getUsageHistory` |
| Spend alerts (80% / 100%) + pause UX | **A0 alerts · A7 surface** | `maybeRaiseUsageAlert` (`billingLedger.ts`); `venture_budgets` breach |
| Account / profile / security entry points | **shipped** | Settings tabs; Devices/Sessions → [33 — Sessions & identity](./33-sessions-identity.md) |
| BYOK key management | **shipped** | existing Settings → model keys; BYOK bypass (`billingLedger.ts` `byokBypass`) |

We do **not** rebuild the Stripe surface. Invoices, receipts, payment-method edits, and refunds
live in the **Stripe Customer Portal** (`createBillingPortal`); we deep-link to it rather than
re-implement PCI-scoped UI. The portal we *do* build is the spend/budget/credits dashboard Stripe
cannot give us, because it is keyed on *ventures*, not subscriptions.

## 17.2 Billing dashboard wireframe (desktop)

`Code Studio → Billing` (global nav rail, [12 §12.4](./12-information-architecture.md#124-navigation-model)):

```
┌─ Ventures · Chat · Billing* · Integrations · Settings ───────────────────────────────┐
│                                                                                       │
│  Billing & Budgets                                          Plan: Pro   [Manage plan] │
│  ───────────────────────────────────────────────────────────────────────────────────│
│                                                                                       │
│  ┌─ This cycle (Jun 1 – Jun 30) ──────────────┐  ┌─ Credits ───────────────────────┐ │
│  │  Included grant   240,000 CT ($24.00)       │  │  Balance   118,400 CT  ($11.84)  │ │
│  │  Used this cycle  ▓▓▓▓▓▓▓▒░░  $18.20 / $24   │  │  Included left   58,000 CT       │ │
│  │  Overage (metered) $0.00     Cap $50.00      │  │  Purchased       60,400 CT       │ │
│  │  Est. month-end    ~$22.40  (illustrative)   │  │  [Add credits ▸]  Auto-reload OFF│ │
│  └──────────────────────────────────────────────┘  └──────────────────────────────────┘│
│                                                                                       │
│  Spend by venture                                                  [Export CSV] [↻]   │
│  ─────────────────────────────────────────────────────────────────────────────────  │
│  Venture           Tokens     Compute   Mgd host   Total    Budget        Status      │
│  ───────────────   ────────   ───────   ────────   ──────   ───────────   ──────────  │
│  Acme Booking      $9.40      $1.56     $3.25      $14.21   ▓▓▓▓▓░ 57%/$25  Active     │
│  Habit Tracker     $3.10      $0.40     $0.00¹     $3.50    ▓▓░░░░ 14%/$25  Active     │
│  Recipe API (BYO)  $0.00²     $0.00     —          $0.00    ░░░░░░  0%/$10  Paused     │
│  ───────────────   ────────   ───────   ────────   ──────                              │
│  Total                                            $17.71                               │
│  ¹ BYO hosting → $0 to us (user's provider bill).   ² BYOK → tracked, not billed.     │
│                                                                                       │
│  ⚠  Habit Tracker reached 80% of its daily cap at 14:02 — review budget.   [Review ▸] │
│                                                                                       │
│  History                                                              [Open invoices] │
│  Jun 6  Credit purchase  +100,000 CT   $10.00   paid   [receipt ▸]                     │
│  Jun 1  Subscription Pro  $29.00       paid           [receipt ▸]                       │
│  May…   …                                              [View all in Stripe portal ▸]    │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

The dashboard is **read-mostly**: the only actions are *Add credits*, *Manage plan*, *Export*,
*Review* (a flagged venture), and *Open invoices* (Stripe portal). Editing a *cap* happens on the
per-venture budget surface (§17.4), never inline in the summary table, so a misclick can never
silently change a venture's spending ceiling.

## 17.3 Per-venture spend breakdown (tokens / compute / managed-hosting)

Every venture row decomposes into the four metering units from
[05 §5.2](./05-business-model-pricing.md#52-metering-units-and-how-they-map-to-existing-assets).
Clicking a row (or visiting `?view=budget&v=:id`) expands the detail:

| Line | Source | Billed in managed | Billed in BYO/BYOK |
|---|---|---|---|
| **Agent tokens** | `billingLedger` settled CT, tagged `venture_id` | yes (× markup) | **$0** — `BYOK_TRACKED`, shown for visibility |
| **Container-minutes** | per-tick `studio_runs.cost_usd` rolled to the ledger | yes (× markup) | owner decision; small, may be waived |
| **Managed hosting** | preview + prod minutes + egress | yes (× markup) | **—** (the user's own provider bill) |
| **Third-party / provider** | domain, paid API — always a checkpoint | pass-through (1.0×) | user's own charge, surfaced not billed |

The breakdown is **honest about who pays whom**: BYOK token lines render `$0.00 (tracked)` and BYO
hosting renders `— (your provider)` with a tooltip, so the wedge claim
([05 §5.5](./05-business-model-pricing.md#55-managed-vs-byo-cost-flows-who-pays-whom)) is visible,
not buried. A per-row sparkline (Primitive Kit, `components/chat/artifacts/kit/`, per `CLAUDE.md`)
shows the last 14 days of daily spend so a runaway venture is obvious at a glance.

## 17.4 Budget sliders & live spend-vs-cap meters

Budgets are the **user-facing face of A0's safety brakes**. The four caps map 1:1 to
`venture_budgets` ([Master Plan §2](../00-MASTER-PLAN.md#2-glossary)): `usd_per_day`, `usd_total`,
`max_tokens`, `max_container_minutes`. The DECIDE gate reads them *before* a tick spends; REFLECT
updates the meter after.

```
┌─ Acme Booking · Budget ───────────────────────────────────────────────────────────┐
│                                                                                     │
│  Daily cap        $ [────●────────]  $25 / day      spent today  ▓▓▓▓▓░░ $14.21     │
│  Total cap        $ [──────●──────]  $250 total      spent total  ▓▓░░░░░ $62.40     │
│  Token cap          [───●─────────]  2,000,000 tok   used        ▓▓▓░░░░ 740,000     │
│  Compute cap        [──●──────────]  600 min         used        ▓░░░░░░  92 min     │
│                                                                                     │
│  On breach:  ⦿ Pause venture + notify   ○ Pause + raise checkpoint                   │
│              [Save budget]   [Reset to plan default]                                 │
│                                                                                     │
│  ⓘ Caps limit how much of your account wallet THIS venture may use. They never add   │
│     funds. Account spend cap ($50 overage) still applies on top.                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

Slider rules:
- **Snap + type.** Each slider has a numeric field; dragging snaps to sensible steps ($1/day,
  10k tokens, 10 min) and a power user can type an exact value. Min is 0 (effectively "disabled");
  max is gated by the plan entitlement (`rbac.ts`, [05 §5.3](./05-business-model-pricing.md#53-pricing-tiers-proposed))
  — Free is capped low (managed previews only); Pro/Team allow payment-backed overage.
- **Meter colors are thresholds, not decoration.** `< 80%` neutral, `80–99%` amber, `100%` red.
  The amber/red thresholds are the *same* numbers that trip the alerts (§17.6), so the meter and
  the alert never disagree.
- **Saving is explicit.** No live-write on drag — a user dragging past a value must not
  accidentally lower a cap below current spend and pause the venture. Save is one confirmed action;
  if the new cap is *below* current spend, we warn ("This will pause Acme Booking now") before
  saving.
- **The cap never lies about scope.** Copy states plainly that a venture cap is a *sub-ceiling*
  inside the wallet, not added funds ([05 §5.4](./05-business-model-pricing.md#54-credits-and-top-up)).

## 17.5 Credits / top-up (Stripe Checkout) & plan management

**Top-up** reuses the shipped path verbatim: *Add credits* opens a pack picker → `createCreditPackCheckout(packId)`
(`services/billing.ts:64`) → Stripe Checkout (`mode: 'payment'`) → on return, `confirmCheckoutSession`
fires and `emitBillingSummaryRefresh()` updates the balance live. Packs carry the existing volume
discount (illustrative: $10→100k CT, $25→260k CT, $100→1.1M CT,
[05 §5.4](./05-business-model-pricing.md#54-credits-and-top-up)).

```
┌─ Add credits ──────────────────────────────┐
│  ○ $10   → 100,000 CT   (1.00×)             │
│  ⦿ $25   → 260,000 CT   (1.04×)  best value │
│  ○ $100  → 1,100,000 CT (1.10×)             │
│                                             │
│  Auto-reload   [ OFF ]  (disabled by policy)│
│            [Cancel]   [Continue to Stripe ▸]│
└─────────────────────────────────────────────┘
```

Auto-reload is shown but **OFF and inert** by policy (`AUTO_RELOAD_POLICY_ENABLED = false`,
[05 §5.4](./05-business-model-pricing.md#54-credits-and-top-up)) — top-up stays a conscious act
("never surprise me with a bill"). The toggle is visible (so the capability is discoverable) with
a tooltip explaining it is owner-gated.

**Plan management.** *Manage plan* opens a tier comparison (Free / Pro / Team,
[05 §5.3](./05-business-model-pricing.md#53-pricing-tiers-proposed)) showing **entitlements as
they actually gate behavior** — active ventures, concurrent ticks, managed-minute pool, BYO
hosting, production deploy, model access — not just price. Upgrading calls
`createSubscriptionCheckout(tier, interval)`; downgrade/cancel calls `cancelSubscription`
(with `reactivateSubscription` to undo before period end). Proration and payment-method edits are
Stripe's job; we link out. Entitlement changes flow back through `syncSubscriptionFromStripe` and
re-resolve `modelAccessPolicy` access, so a downgrade that removes "production deploy" is reflected
the next time the user views a deploy checkpoint (it shows "requires Pro").

## 17.6 Spend alerts (80% / 100%) & the budget-exhausted-pause UX

Alerts dedupe at **80%** and **100%** of a cap, reusing the account-level alert mechanism
(`maybeRaiseUsageAlert`, `billingLedger.ts`) extended per-venture. They fire across **in-app +
email** ([Master Plan §8](../00-MASTER-PLAN.md#8-guardrails--checkpoints)).

| Threshold | What happens | Surfaces |
|---|---|---|
| **80% of any cap** | Amber banner on the dashboard + the venture; one email; meter goes amber. Venture **keeps running**. | dashboard, venture, email |
| **100% (breach)** | Venture **pauses** (does not fail). A `budget-threshold` notification + a **budget checkpoint** (if that option is set). Meter goes red; status pill → **Paused (budget)**. | dashboard, Console approvals, email, push |
| **Resume** | Raising the cap *or* topping up credits clears the breach; the user explicitly resumes. We never auto-resume. | venture controls |

**Budget-exhausted pause UX (the trust moment).** This is the most important state in the whole
section — getting it wrong means a surprise bill or a silently dead venture. The behavior:

```
┌─ Acme Booking ─────────────────────────── ● Paused (budget) ─┐
│                                                              │
│  Daily cap reached — autopilot paused at 14:02 today.        │
│  Spent today  ▓▓▓▓▓▓▓ $25.00 / $25.00  (illustrative)        │
│  No spend has occurred since. Nothing was lost.              │
│                                                              │
│  To continue, choose one:                                    │
│    [Raise daily cap ▸]   [Add credits ▸]   [Keep paused]     │
│                                                              │
│  ⓘ A pause is safe and reversible. Caps protect you;         │
│     they never delete work or charge you to resume.          │
└──────────────────────────────────────────────────────────────┘
```

The copy is honest and calm: a pause is *safe*, *reversible*, *not a failure*, and *not a charge*,
mirroring the [05 §5.8](./05-business-model-pricing.md#58-billing-edge-cases) rule — "venture
pauses (does not fail) on cap breach." Dunning (failed payment) is the same shape: ventures
**stay paused, not deleted** until resolved, and `customer.subscription.deleted` drops the user to
Free with entitlements lost but ventures intact.

## 17.7 Account, profile & security settings entry points

Billing is one tab of the broader **Settings** surface
([12 §12.2](./12-information-architecture.md#122-site-map--navigation-tree)). The portal links
*out* to the rest; it does not absorb them:

| Entry point | From the portal | Lands at |
|---|---|---|
| **Profile / preferences** | footer link "Account settings" | `?view=settings` (Profile) |
| **Security** | "Security & sessions" | `?view=settings&tab=security` |
| **Devices & sessions** | same | Settings → Devices (live, revocable), specced in [33 — Sessions & identity](./33-sessions-identity.md) (`UserCoordinatorDO`) |
| **Payment method / invoices** | "Manage payment & invoices" | Stripe Customer Portal (`createBillingPortal`) |
| **BYOK model keys** | "Model keys (BYOK)" | existing Settings → model keys (§17.8) |
| **Per-venture connections** | per row "Connections" | `?view=connections&v=:id`, specced in [18 — Integrations](./18-ux-integrations.md) |

Settings → Billing is itself a **deep-link target back to this portal**
([12 §12.2](./12-information-architecture.md#122-site-map--navigation-tree)), so the two are a
loop, not a duplication. We keep one source of truth for spend (this portal) and one for identity
(Settings/Devices) and cross-link rather than fork.

## 17.8 BYOK key management (reuse existing Settings)

BYOK is **not re-built here** — it reuses the shipped Settings → model-keys flow. The billing
relevance is that a present BYOK key takes the `byokBypass` path: tokens are recorded as
`BYOK_TRACKED` for visibility but **bill $0 and reserve 0 CT**
([05 §5.2](./05-business-model-pricing.md#52-metering-units-and-how-they-map-to-existing-assets)).
The portal's only BYOK responsibility is **honesty**:

- A **"BYOK active"** badge on any venture using a user key, and `$0.00 (tracked)` token lines so
  the user can see usage *and* see they aren't being charged for it.
- A link to manage keys; never the key value itself (keys are write-only in the UI, stored per the
  existing secret-handling rules — never in our DB plaintext, never in the client bundle,
  [Master Plan §5](../00-MASTER-PLAN.md#5-security--multi-tenancy)).

## 17.9 Empty, loading & error states

| State | Trigger | What we show | Action |
|---|---|---|---|
| **No ventures yet** | first login | "Nothing spent yet — start a venture to see costs here." | → Ventures dashboard intake ([12 §12.7](./12-information-architecture.md#127-empty-states--first-run-entry-points)) |
| **No budget set** | venture exists, no cap | soft block before first paid action; "Set a cap (platform default offered)" | Set a budget cap |
| **No credits / Free** | balance only included grant | grant meter + "Add credits" CTA; no scary zero | Add credits |
| **Loading** | summary fetch in flight | skeleton rows + meter shimmer (no layout shift); never a spinner over stale numbers | — |
| **Stale / refresh** | `BILLING_SUMMARY_REFRESH_EVENT` | quiet re-fetch on the event; "Updated just now" timestamp | [↻] manual |
| **Summary error** | `getBillingSummary` fails | inline error card, *last known* totals dimmed with "may be out of date", retry | Retry |
| **Checkout return error** | `confirmCheckoutSession` fails | "Payment may have completed — we'll reconcile" + link to Stripe portal; **never double-charge** (idempotent by `checkoutSessionId`) | Open Stripe portal |
| **Stripe portal unreachable** | `createBillingPortal` fails | "Open billing in a new tab failed" + retry; spend data still renders | Retry |

Principle: **a billing error never hides money already spent.** We degrade to last-known totals
clearly marked stale rather than showing zeros or a blank — a blank spend screen is a trust
failure for Maya.

## 17.10 Mobile & accessibility

**Mobile.** Billing is a *monitoring + paying* surface on phones, not an operating one
([12 §12.6](./12-information-architecture.md#126-mobile-navigation-model-monitoring-first)). It
collapses into the Settings/overflow group (rarely needed live). The mobile layout stacks: account
meter → credits/Add-credits (thumb-zone CTA) → per-venture cards (one card per venture, tap to
expand the breakdown) → recent history. Budget sliders become large stepper controls (drag is
imprecise on a touch cap that can pause a venture); Stripe Checkout/Portal open in the system
browser. Spend alerts deep-link straight to the relevant venture
([12 §12.8](./12-information-architecture.md#128-deep-link-resolution-checkpoints--notifications)).

**Accessibility** (full bar in [20 — Accessibility](./20-accessibility.md)):
- Meters are `role="meter"` (or `progressbar`) with `aria-valuenow/min/max` and a text equivalent
  ("$14.21 of $25, 57%") — color (amber/red) is **never the only signal**; an icon + label carry
  it for color-blind users.
- Sliders are real `<input type="range">` with keyboard step support, labelled, with a paired
  numeric field for exact entry (avoids fine-motor drag traps).
- The spend table is a real `<table>` with scope headers, sortable via keyboard, and a per-row
  expand that is a `<button aria-expanded>`.
- Currency is announced as money ("fourteen dollars and twenty-one cents"), not digit-by-digit.
- The budget-exhausted pause uses `role="status"` (polite live region) so a screen-reader user is
  told the venture paused without it being an alarm; the *resume* actions are the focus target.
- Focus management: opening Add-credits/Manage-plan traps focus in the dialog and returns it on
  close; deep-linking to a flagged venture moves focus to its Review action.

## 17.11 Acceptance criteria

- Billing portal renders cross-venture spend split into tokens / compute / managed-hosting, with
  BYOK lines shown as `$0 (tracked)` and BYO hosting as `— (your provider)`.
- Four budget sliders (`usd_per_day`, `usd_total`, `max_tokens`, `max_container_minutes`) write
  `venture_budgets`; saving is explicit; lowering a cap below current spend warns before pausing.
- Live spend-vs-cap meters share thresholds (80% amber / 100% red) with the alert system; numbers
  never disagree.
- Add-credits runs the shipped Stripe Checkout pack flow and refreshes the balance on return;
  auto-reload is visibly off and inert.
- Plan management shows entitlements (not just price), upgrades/downgrades via Stripe, and reflects
  entitlement loss after a downgrade.
- Invoices/receipts/history link to the Stripe Customer Portal; in-portal history shows recent
  charges with receipt links.
- 80% / 100% alerts fire in-app + email; breach pauses (not fails) the venture; resume requires an
  explicit cap raise or top-up; never auto-resume; never double-charge on a failed checkout return.
- Account/profile/security/devices and BYOK/connections entry points link out (Devices →
  [33](./33-sessions-identity.md); connections → [18](./18-ux-integrations.md)); no duplication.
- Every empty/loading/error state degrades to last-known totals (marked stale), never to a blank or
  a misleading zero.
- Mobile exposes monitor + add-credits + per-venture breakdown; meters/sliders/table meet the
  a11y criteria above.

(Billing/metering architecture behind this UI: [41-billing-metering.md](./41-billing-metering.md).
Cost model: [40-cost-finops.md](./40-cost-finops.md). Pricing it serves:
[05-business-model-pricing.md](./05-business-model-pricing.md).)
