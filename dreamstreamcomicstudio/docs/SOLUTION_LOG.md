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

## 2026-05-29 — Richer model selection, reader fit, capability gating, cost analysis

- **Richer selection:** ModelSelectionPanel (in API Configuration) — Default / Free /
  Specific for image+text from the live catalog, with capability badges; reflected via
  modelSelection. Kills the "default only" feel.
- **Capability gating (v1):** selection panel warns when the chosen image model is weak
  at character consistency (uses modelCapabilities.featureSupport). Deeper editor control
  gating (disable reference upload, premium image-edit UI) is the next increment.
- **Reader:** flip-mode pages now fit the viewport (max-h-[78vh] object-contain, wrapper
  sized to the image so dialogue overlays stay aligned) — fixes portrait/flip overflow.
- **Cost optimization:** ReviewExport now surfaces the per-stage and per-model cost
  breakdown from the (already-captured) ledger data — the analysis input. Documented the
  optimization levers (batch panels, trim context, right-size models) in
  docs/features/cost-optimization.md; the pipeline flow changes are a separate tested
  increment (not rushed to prod).
- **Files:** components/ModelSelectionPanel.tsx, ApiConfiguration.tsx, ComicReader.tsx,
  steps/ReviewExport.tsx, docs/features/cost-optimization.md.

## 2026-05-29 — Model capability index + usage-hover/header fixes

- **Problem:** (1) Usage pill hover showed appSettings defaults, not the chosen model;
  (2) the studio stacked 3 headers (~30% of the screen); (3) no capability model to
  drive per-model feature enable/disable.
- **Solution:**
  - Pill hover now reads `modelSelection` (getSelected*Model) + refreshes on
    MODEL_SELECTION_CHANGED → "Use this model" reflects everywhere.
  - Hid the global StaticSiteHeader on editor/comicforge (they have their own back/title
    bars); StepIndicator → top-0, editor title bar → top-24. 3 headers → 2.
  - New `services/modelCapabilities.ts`: derives a capability profile per model
    (imageOutput/imageInput/multiImageRefs/imageEditing/structuredJson/toolUse/
    longContext/free/premium) from the live catalog + curated overrides, with
    `featureSupport()` (supported + reason) for gating. Surfaced as a "Studio features"
    ✓/✗ list in the Model Library detail.
- **Files:** `components/TokenAvailabilityPill.tsx`, `App.tsx`,
  `components/StepIndicator.tsx`, `components/ComicEditor.tsx`,
  `services/modelCapabilities.ts`, `components/ModelLibrary.tsx`.
- **Next in this cluster:** wire feature gating into the editor controls (reference
  images, image edit) using `featureSupport`; richer Default/Free/Specific selection;
  cost telemetry/optimization; reader portrait/flip.

## 2026-05-29 — Onboarding readiness checklist

- **Problem:** The app looked "ready" but users hit blockers mid-flow (no key, no model)
  with no guided way to resolve them.
- **Solution:** `components/ReadinessChecklist.tsx` checks account, active API key (warns
  if over limit), and image-model readiness, each with a one-click fix. Shown on the
  dashboard; hides when all green; dismissible; re-checks on window focus.
- **Files:** `components/ReadinessChecklist.tsx`, `components/ProjectDashboard.tsx`,
  `docs/features/onboarding-readiness.md`.
- **Verify:** frontend typecheck clean.

## 2026-05-29 — Free public comics (read without login; interactions gated)

- **Problem:** Reading a comic forced login; owner wants comics free to read, with only
  comment/like/follow requiring an account.
- **Root cause:** `navigateToReader` redirected signed-out users to `auth`, and `reader`
  was in `isProtectedViewStrict`. The public-read path (`getPublicProject`) already existed
  behind that gate.
- **Solution:** Removed the login gate in `navigateToReader` (signed-out users load the
  public copy; private comics still return "not found/private") and removed `reader` from
  the protected views. Interactions were already gated: `CommentSection` shows "log in to
  comment" and disables the box for signed-out users; `PublicGallery` likes require login.
- **Files:** `App.tsx` (interactions unchanged — already correct in `CommentSection.tsx` /
  `PublicGallery.tsx`).
- **Verify:** frontend typecheck clean.

## 2026-05-29 — Universal Assistant → free OpenRouter model + accuracy guardrail

- **Problem:** Assistant ran on Gemini (cost/keys); owner wants it truly free, fast, and
  accurate (no fabricated data).
- **Solution:** `ai/assistant.ts` now generates via the gateway on a free model
  (`OPENROUTER_FREE_TEXT_MODEL`, a `:free` id → $0). Route key = user BYOK or platform
  OpenRouter key; billing provider switched to `openrouter`. Added an explicit
  anti-hallucination rule to the system prompt; kept existing off-topic blocking +
  context sanitization + policy.
- **Files:** `server/src/ai/assistant.ts`, `server/src/routes/assistant.ts`,
  `docs/features/universal-assistant.md`.
- **Verify:** server typecheck clean; 9 assistant policy tests pass.

## 2026-05-29 — Model Library upgrades + compact API config + key-driven selection

- **Problem:** API config panel too chunky; model options didn't react to keys; no way
  to compare models or pick one; users couldn't see/choose live (incl. newly-free) models.
- **Solution:** API Configuration is now a compact accordion (collapse per provider).
  Model Library: live catalog, "Use this model" with quick confirm, and compare up to 5
  (side-by-side table). New `services/modelSelection.ts` stores the chosen image/text
  model; `geminiService` sends the selected image model to `/api/image/openrouter`. A
  current-selection banner shows the active Image/Text models.
- **Files:** `components/ApiConfiguration.tsx`, `components/ModelLibrary.tsx`,
  `services/modelSelection.ts`, `services/geminiService.ts`,
  `docs/features/models-and-api-configuration.md`.
- **Commit/Decision:** ADR 0003.
- **Pending in this cluster:** show/choose Default/Free/Specific directly in API config
  (currently via the library + Free filter); text-model selection reaching the Gemini
  pipeline (ADR 0001 follow-up).

## 2026-05-29 — Usage pill swap, billing tab removal, notifications redesign

- **Problem:** Header showed CT credits; Settings had a billing tab; notifications
  were off-brand and duplicated on the dashboard.
- **Solution:** `TokenAvailabilityPill` now shows the active key's usage with a hover
  card (provider, spend/limit %, models) instead of CT. Billing tab removed from
  `AccountSettings` (nav + render); its handlers/`renderBilling` remain dormant.
  `AccountSettings` "API Configuration" tab and `SettingsModal` both render the new
  `ApiConfiguration`. `NotificationBell` restyled on-brand; duplicate dashboard bell
  removed (global header provides it).
- **Files:** `components/TokenAvailabilityPill.tsx`, `components/AccountSettings.tsx`,
  `components/NotificationBell.tsx`, `components/ProjectDashboard.tsx`.
- **Commit/Decision:** ADR 0002 (billing dormant), ADR 0003 (per-key usage).

## 2026-05-29 — API Configuration: multiple keys per provider + per-key limits

- **Problem:** One key per provider, a user-wide spend cap, and no per-key tracking.
  Owner wants multiple keys per provider, each with its own OpenRouter-style usage limit.
- **Root cause:** `user_api_keys` was unique on `(user_id, provider)`; `apiClient` sent
  a single key per provider; usage was aggregated at the wallet level.
- **Solution:** New client-side multi-key store `services/apiKeys.ts` (list per provider,
  one active key, per-key monthly limit + usage with monthly reset, legacy single-key
  import). New `components/ApiConfiguration.tsx` (add / label / limit / activate / delete
  with usage meters), wired into Settings (replaces the old single-key inputs).
  `apiClient` now sends the **active** key per provider. The live image path blocks an
  over-limit key and records the real provider cost against the active key.
- **Files:** `services/apiKeys.ts`, `components/ApiConfiguration.tsx`,
  `services/apiClient.ts`, `services/geminiService.ts`, `components/SettingsModal.tsx`.
- **Commit/Decision:** ADR 0003 (block-at-limit; one active key/provider; CT UI hidden /
  backend dormant).
- **Pending (next increments):** replace the CT pill with a per-key usage view; remove
  the billing tab from Account; notifications redesign + fix the duplicate Studio bell;
  a server-authoritative per-key usage ledger (currently client-side).

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
