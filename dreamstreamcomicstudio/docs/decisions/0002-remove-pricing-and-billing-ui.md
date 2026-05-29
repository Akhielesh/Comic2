# 0002. Remove pricing/billing UI; keep billing backend dormant

- **Status:** Accepted
- **Date:** 2026-05

## Context

The product is moving to a BYOK-first model where users run generation on their own
provider keys. The subscription **pricing** section on the home page and the
**billing** tab in Settings (plans, credit packs, Stripe checkout, coupons, spend
cap) are not in use right now. The owner may revisit monetization later, so we want
to remove the surfaces **without** destroying the machinery.

## Decision

- **Remove from the UI:** the home-page pricing/plans section, and the billing tab
  in `components/AccountSettings.tsx` (plans, credits, payment method, coupons).
- **Keep intact (dormant):** the billing backend — `services/billingLedger.ts`,
  `usageEnforcer.ts`, `costEstimator.ts`, `routes/billing.ts`, and the Supabase
  tables (`token_wallets`, `token_ledger_entries`, `generation_cost_events`).
  Reservation/settlement still runs server-side so usage is still recorded; we just
  don't surface the CT/credit purchase UX.
- The platform "Comic Token (CT)" usage display is replaced by a **per-API-key usage
  view** (see ADR 0003).

## Consequences

- Monetization can be re-enabled later by restoring the UI (the backend, types, and
  routes remain).
- Some billing service imports/types become unused in the frontend after the tab is
  removed — clean those without deleting the backing services.
- The home page no longer fetches the pricing catalog.
