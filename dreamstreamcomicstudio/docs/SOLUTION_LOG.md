# Solution Log

Append-only log of real problems and how they were solved, so future work (human or
AI) can see *what happened and why* without re-investigating. Newest first.

Entry format:
- **Date — Title**
- **Problem:** what was wrong / asked for.
- **Root cause / context:** why it was that way.
- **Solution:** what we changed.
- **Files:** key files touched.
- **Commit/Decision:** ref(s).

---

## 2026-05-29 — Documentation architecture + remove home-page pricing

- **Problem:** No documentation architecture (no ARCHITECTURE/ADR/changelog/issue
  log). Subscription pricing on the home page should be removed (may return later).
- **Root cause:** Docs were scattered (`OVERHAUL_PLAN.md`, `production/`) with no
  index, decision records, or solution history. Pricing was a self-contained section
  in `HomePage.tsx` fed by the billing pricing catalog.
- **Solution:** Added `docs/README.md`, `docs/ARCHITECTURE.md`, `docs/decisions/`
  (ADR system + 0001/0002), this log, and `CHANGELOG.md`. Removed the home-page
  pricing section and its pricing-only imports/state/effects (kept `onOpenUpgrade`
  in the prop type for future use).
- **Files:** `docs/*`, `CHANGELOG.md`, `components/HomePage.tsx`.
- **Commit/Decision:** ADR 0002.

## 2026-05 — Per-comic cost accuracy + provider spend visibility

- **Problem:** Comic cost shown could read $0 for BYOK and used token *estimates*
  instead of OpenRouter's real cost.
- **Root cause:** `buildSettleEstimateFromUsage` derived cost from tokens; the UI
  only showed platform `billableUsd` (0 for BYOK).
- **Solution:** Pass the provider's real `usage.cost` into settlement (overrides the
  token estimate); `ReviewExport` now shows "Actual API cost (provider)".
- **Files:** `server/src/services/costEstimator.ts`, `routes/text.ts`, `routes/image.ts`,
  `components/steps/ReviewExport.tsx`.

## 2026-05 — User spend cap + usage-threshold alerts

- **Problem:** No user-settable spend limit; no alerts as usage approached limits.
- **Root cause:** `overage_hard_cap_usd` existed on the wallet and was enforced in
  `reserveUsageTokens`, but wasn't user-editable; no alerting.
- **Solution:** `updateSpendCap` + `POST /api/billing/spend-cap` + a spend-cap card
  in Account; `maybeRaiseUsageAlert` raises deduped `system` notifications at
  thresholds, rendered legibly in `NotificationBell`.
- **Files:** `server/src/services/billingLedger.ts`, `routes/billing.ts`,
  `services/billing.ts`, `components/AccountSettings.tsx`, `components/NotificationBell.tsx`.

## 2026-05 — OpenRouter cutover (routes + BYOK key entry)

- **Problem:** OpenRouter gateway existed but nothing generated through it (only the
  model catalog read from it); users had no way to enter an OpenRouter key.
- **Root cause:** The gateway/provider were built (Phase 0-2) but live routes still
  called Gemini/Pixazo, and the frontend never sent `X-OpenRouter-Key`.
- **Solution:** Added `POST /api/text/generate` and `POST /api/image/openrouter`;
  turned the gateway into a provider registry; added a BYOK key field
  (`OpenRouterKeyInput`) + `apiClient` now sends `X-OpenRouter-Key`; live image
  generation routes through OpenRouter when a BYOK key is set.
- **Files:** `server/src/ai/gateway.ts`, `routes/text.ts`, `routes/image.ts`,
  `services/appSettings.ts`, `services/apiClient.ts`, `components/OpenRouterKeyInput.tsx`,
  `components/SettingsModal.tsx`, `services/geminiService.ts`.
- **Commit/Decision:** ADR 0001. Known follow-up: migrate the text-planning pipeline
  (Gemini `Type.*` schemas) onto the gateway.

## 2026-05 — Deploy wiring clarified (Railway = backend, Cloudflare = frontend)

- **Problem:** Confusion over where changes deploy.
- **Root cause:** Backend auto-deploys from `Dreamstrream-v1` on Railway; the
  frontend is a separate Cloudflare Pages project (root dir `dreamstreamcomicstudio`,
  build `npm run build`, output `dist`). The Cloudflare production branch is a
  dashboard setting, not a repo file.
- **Solution:** Documented in `RAILWAY_DEPLOY.md` / `ARCHITECTURE.md`. Set Cloudflare
  Pages production branch to `Dreamstrream-v1`; SPA needs `public/_redirects`
  (`/* /index.html 200`) to avoid deep-link 404s.
