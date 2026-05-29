# 0003. Multi-key API configuration + per-key usage limits

- **Status:** Accepted
- **Date:** 2026-05-29

## Context

Previously the app stored **one key per provider** (`user_api_keys` unique on
`(user_id, provider)`), tracked usage user-wide via the CT credit system, and BYOK
was a boolean. The owner wants: multiple keys per provider (e.g. several OpenRouter
keys), each with its own usage limit "like OpenRouter's dashboard" (limit, %, cost,
models), and the CT credit display replaced by a per-key usage view.

Constraint: the app **cannot** enforce a limit on the provider's side (OpenRouter/
Gemini manage their own key limits). BYOK keys are user secrets that live client-side.

## Decision (confirmed with owner)

1. **Multiple keys per provider**, each with `{ id, label, key, active, limitUsd,
   usedUsd, periodStart }`. Managed in a redesigned **Settings → API Configuration**.
2. **One active key per provider** (owner picks). The active key is the one sent on
   requests (`X-OpenRouter-Key` / `X-Gemini-Key` / `X-Pixazo-Key`).
3. **Per-key limit = block at limit.** The app tracks each key's spend itself
   (from the `providerCostUsd` returned on each generation) and **blocks** generation
   on a key once its tracked spend reaches the user-set monthly limit, until reset or
   raised. Closest to OpenRouter's dashboard behavior we can do without provider-side
   enforcement.
4. **CT credit system:** hidden from the UI (CT pill replaced by a per-key usage
   view; billing tab removed from Settings) but the **backend is kept dormant**
   (ledger, wallet, reservation/settlement, tables remain) so monetization can return.
   See ADR 0002.

## Architecture

- **Store:** client-side is the source of truth (`services/apiKeys.ts`,
  localStorage `dreamstream_api_keys_v2`), because BYOK keys are client secrets and
  usage is attributed client-side from each response's `providerCostUsd`. Legacy
  single keys are migrated in on first load. Best-effort encrypted sync to Supabase
  is a future enhancement (see Consequences).
- **Usage tracking:** monthly rolling window per key; `recordKeyUsage(provider, usd)`
  is called after each generation using that response's real provider cost.
- **Enforcement:** `getActiveKeyForUse(provider)` returns the active key only if it's
  under its limit; the generation path checks this before sending and surfaces a clear
  "key limit reached — switch or raise the limit" message.

## Consequences

- Client-side tracking can be reset by clearing browser storage; this is acceptable
  for a self-imposed budget on the user's own key. A **server-authoritative** per-key
  ledger (new `user_provider_keys` table + per-key usage attribution in
  `billingLedger`) is the future hardening step; a migration stub is noted in the repo.
- The CT pill and billing tab are removed; `TokenAvailabilityPill` is replaced by a
  per-key usage indicator with hover detail (%, cost, models).
- `apiClient` sends the **active** key per provider instead of the single legacy key.
