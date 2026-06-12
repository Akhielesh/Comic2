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

## 2026-06-12 — Multi-page flow cut to 3 clicks; build-never-starts bug; real covers; 504 fixes

- **Problem:** owner (after producing on prod): multi-page flow "terrible" — remove
  the Story-Scenes/planning stage entirely; planning should only ask page count;
  panel plan must be automatic ("don't ask the user"); covers had "literally no
  styling"; the hardcoded "Flux Schnell (Pixazo Free)" still appeared though the
  image model is chosen in Settings/Models; the "Premium Model Comparison" pricing
  table was noise; after the preview stage images were never generated; console
  spammed [METRICS]; /api/text/analyze-script + /story-tool returned bare 504s and
  "suggest theme" timed out at 60s.
- **Root cause / context:** (1) `ComicGenerator` auto-started only when
  `panels.length === 0` — pre-planned (imageless) panels skipped the start AND a
  3s effect auto-advanced to Review, so a planned project silently never rendered.
  (2) Covers could never carry a title: the global NO_TEXT_IN_IMAGE blocker applied
  to stage 'cover' too, and the default masthead text was the STYLE CATEGORY, not
  the comic's name. (3) `DEFAULT_IMAGE_PROVIDER='flux'` + a Flux entry in
  IMAGE_MODELS leaked the legacy fallback into pickers/pricing. (4) Railway's edge
  kills non-streaming requests at ~60s while the server waited 90s — clients saw
  naked 504s; `pickTextModel` (single-model routes) didn't skip 200B+ free models
  the way `pickTextModelChain` does. (5) [METRICS] logs were unconditional.
- **Solution:** STORY_PLANNING + COMBINED_PREVIEW removed from the flow (files
  deleted; enum values reserved; load-time migration + runtime remap route legacy
  saves; the old v4 "planning gate" retired). Layout stage now asks page count and
  its button is the single spend gesture ("Generate my comic") → straight into the
  build; generation Phase 1 plans `pages × panels-per-page` across scenes
  (clamped 1–8/scene). ComicGenerator starts when nothing has rendered (not when
  panels are merely planned), never auto-restarts failed runs (explicit Retry
  button), and both auto-advance paths require ≥1 rendered image. Covers: stage
  'cover' exempt from the text blocker (prompt + negativePrompt), cover prompt
  renders the real title masthead/tagline, templates gained typography directions
  + new Cinematic Montage / Painted Epic / Retro Pulp archetypes, default title =
  project name. Flux entry removed from IMAGE_MODELS (default = Nano Banana,
  user selection always wins). TEXT_REQUEST_TIMEOUT_MS 50s (clamped ≤55s) so
  structured timeout errors beat the edge 504; pickTextModel skips down/
  timeout-prone free models; story-tool client got the analyze-script retry
  posture. [METRICS] logs are dev-only.
- **Files:** `components/{ComicEditor,ComicGenerator,StepIndicator}.tsx`,
  `components/steps/{LayoutSelector,CoverDesigner}.tsx` (+ deleted
  `StoryPlanning.tsx`, `CombinedPreview.tsx`), `services/{pipelineReset,generationManager,imageModels,imageService,imagePrompt,coverTemplates,geminiService,db}.ts`,
  `hooks/useProjectManager.ts`, `types.ts`,
  `server/src/{config.ts,ai/autoRouter.ts}`.
- **Commit/Decision:** owner feedback session 2026-06-12;
  `docs/features/comic-studio.md` updated.

---

## 2026-06-12 — Invite flow completed end-to-end; header pill + source-gating sync

- **Problem:** owner: invite emails' links did nothing (no account-setup flow);
  an already-invited person clicking register got a generic waitlist response
  instead of "you already have access — follow the email instructions" (+ resend);
  no admin view of sent→joined per invite; inviters couldn't see whether their
  referrals were accepted. Separately: the header usage pill always showed a raw
  mono "Auto" in Chat Studio (the chat's real model lives per-conversation) and
  used the legacy comic styling; the Auto "Lock source" row in the chat picker
  hardcoded OpenRouter/NVIDIA regardless of Settings toggles; the Code Studio
  model picker ignored source governance entirely.
- **Root cause / context:** `?invite=` was generated in emails but never processed
  by App.tsx; signups were globally disabled with no invite-holder exception; no
  table linked invite codes to recipient emails (email_log doesn't store codes),
  so "is this email invited?" was unanswerable; the pill predates the per-studio
  model split and source governance; `StudioSettingsPanel` predates
  `useModelSourceScope`.
- **Solution:** New `access_invite_sends` table (per invite × recipient: kind,
  send_count, first/last sent; service-role only) recorded by the admin email
  invite, referral sends, and resends. `captureInviteCodeFromUrl` + auto-redeem
  on first signed-in load + auth-page invite banner; an invite in hand unlocks
  the real Sign Up tab. `/api/newsletter/subscribe` (access) now answers
  `already-invited` and re-sends the invite (10-min cooldown) behind the existing
  Turnstile gate. `listInvites` returns `recipients`/`redeemedBy` (admin
  timeline); `GET /api/invites/referral` returns `invited[]`/`joinedViaLink`
  (inviter stats — accepted-or-not only). Pill: governance-filtered providers,
  theme-token glass styling, friendly model labels, and a new
  `activeModelBeacon` that Chat Studio publishes its real per-conversation
  model to. Chat picker lock-source row + Code Studio coder list/source chips
  now derive from governance/source scope.
- **Files:** `server/sql/access_invite_sends.sql`, `server/src/services/invites.ts`,
  `server/src/routes/{invites,adminEmail,newsletter}.ts`, `services/{invites,waitlist,modelCatalog,activeModelBeacon}.ts`,
  `App.tsx`, `components/{AuthPage,WaitlistForm,InviteFriends,TokenAvailabilityPill}.tsx`,
  `components/admin/InviteManager.tsx`, `components/chat/{AIChatPlatform,ChatModelPicker}.tsx`,
  `components/studio/StudioSettingsPanel.tsx`.
- **Commit/Decision:** `docs/features/invite-system.md`,
  `docs/features/comic-studio-v2-direction.md` (v2 assessment + layered plan).

---

## 2026-06-12 — Live production generation test (post-consolidation)

- **Problem:** prove the consolidated comic engine + Phase 0 self-healing
  actually produce a coherent comic in production, under a $3 budget.
- **Result:** full 3-scene / 5-panel comic generated end-to-end on production
  for **$0.45** (project `873f751d…`, public). Single-character consistency and
  style are strong (reference-sheet injection works); the kitchen set stays
  consistent across scenes. **Gaps:** (1) multi-character panels bleed identity
  (Arjun rendered as a second Maya) — labeled/focal-weighted refs needed; (2)
  OpenAI image models (`gpt-5-image`, `gpt-5.4-image-2`) exceed the 60s image
  timeout and can't be used yet; `openai/gpt-image-1` in `imageModelRanking.ts`
  is an invalid OpenRouter id. Nano Banana $0.039/img, Pro $0.138/img.
- **Files / details:** `docs/COMIC_PRODUCTION_TEST_2026-06-12.md`.

---

## 2026-06-12 — Comic Studio consolidation: comics reliably generate

- **Problem:** owner "struggling with not being able to consistently produce
  comics — the stages/flows are super messy"; wants to share Comic Studio with
  real users.
- **Root cause / context:** (1) Two engines: the live classic engine plus the
  half-wired, disabled-by-default ComicForge (stubbed workers, retired model
  ids, no queue consumer) confusing every audit and change. (2) The classic
  engine's strict pre-run gates hard-failed builds when the style lock was
  unresolved or characters had no reference images — and building references
  was a manual, skippable step most users never did, so reference packs were
  empty (no character consistency) or runs were blocked outright. (3) Nine
  flat wizard steps read as "super messy".
- **Solution:** ADR 0004 — classic engine is THE engine; ComicForge + admin
  Test Lab deleted. New Phase 0 in `startBackgroundGeneration`: auto style
  anchor (stage `style`) + auto character/world reference sheets
  (`collectAutoReferenceTasks`, `character_sheet`/`world` stages, capped 10,
  concurrency 3, `CHARACTER_SHEET_MODEL`), continuity bible rebuilt after.
  Pre-run hard stops replaced with honest soft-continue logs; per-panel strict
  checks still flag individual panels for retry. StepIndicator regrouped into
  Story / Cast / Pages over the unchanged step machine.
- **Files:** `services/autoReferences.ts` (+ tests), `services/generationManager.ts`,
  `components/StepIndicator.tsx`, removals across `components/comicforge/`,
  `server/src/comicforge/`, `components/TestLab.tsx` et al.
- **Commit/Decision:** ADR 0004; `docs/features/comic-studio.md`.

---

## 2026-06-08 — Transactional + newsletter email via Cloudflare Email Sending

- **Problem:** no mailing service. Needed newsletter request confirmation, signup/auth
  confirmations, and essential transactional emails — branded to the app UI/UX — and an
  answer on whether Cloudflare could do it, at what cost/limits.
- **Root cause / context:** auth emails were Supabase-default; marketing capture was a
  client-only insert into `waitlist_signups` with no confirmation email and no log.
- **Solution:** Cloudflare **Email Sending** (public beta, `env.EMAIL.send`, $5/mo Workers
  Paid + 3,000/mo free, then $0.35/1k). Built a dedicated **email-worker** (`/send` HMAC,
  `/auth-hook` Supabase Send Email Hook, `/health`) that renders a shared, dependency-free,
  email-safe **comic-branded** template library (`shared/email/`). Backend **mailer**
  (`server/src/services/mailer.ts`) is dormant-until-configured and adds: marketing
  suppression, a **hard cost cap** (defaults under the free tier, with `[email][COST]`
  alerts), per-attempt logging to `email_log`, working one-click **unsubscribe**
  (signed token + `List-Unsubscribe` header), and a read-receipt **open pixel**. Essential
  vs marketing classification (`TEMPLATE_KIND`) gates unsubscribe/suppression. Newsletter
  goes **double opt-in** via a new public `/api/newsletter` route; `WaitlistForm` routes
  through it with a graceful fallback to the old direct insert.
- **Files:** `shared/email/{theme,layout,templates,index,templates.test}.ts`,
  `email-worker/{src/index.ts,wrangler.jsonc,package.json,tsconfig.json,README.md}`,
  `server/src/services/{mailer,emailStore}.ts`, `server/src/routes/{newsletter,email}.ts`,
  `server/sql/email_system.sql`, `server/src/config.ts`, `server/src/index.ts`,
  `services/waitlist.ts`, `scripts/email-preview.ts`, `docs/email/*`, `.env.example`.
- **Verify:** client + server typecheck clean; email-worker typecheck clean against
  `@cloudflare/workers-types`; 11 template tests pass (incl. escaping, URL sanitization,
  essential-never-unsubscribable, pixel-only-when-supplied); 12 previews render.
- **Owner actions:** see `docs/email/SETUP.md` (Workers Paid + domain DNS, deploy worker +
  secrets, Railway env, optional Supabase hook).

## 2026-05-29 — Text pipeline migrated to OpenRouter (analyze-script 400 fix)

- **Problem:** analyze-script (and every text stage) returned 400 `API_KEY_INVALID` from
  generativelanguage.googleapis.com — they still called **Gemini**, but users now run on an
  **OpenRouter** key. (The console TF.js spam was an unrelated browser extension.)
- **Root cause:** the ADR 0001 text-migration follow-up was never done; `ai/text.ts` used the
  Gemini SDK and `routes/text.ts` required a Gemini key.
- **Solution:** provider-aware `createClient` — given an OpenRouter key (`sk-or-`) it returns a
  shim whose `models.generateContent` maps to the gateway, converting the Gemini
  `responseSchema` → JSON Schema (`ai/schemaConvert.ts`). So analyze / world / panel /
  continuity / story / testlab run on OpenRouter **unchanged** — the segmentation +
  `normalizeScenes` grounding (which keeps scenes anchored to the script and avoids
  invented detail) is untouched. `routes/text.ts` `resolveTextProvider` picks OpenRouter
  (BYOK or platform) else Gemini; billing provider follows. Client sends `X-Text-Model` so the
  selected text model is honored. Default OpenRouter text model is `google/gemini-2.5-flash`
  (same model, via OpenRouter), so analysis quality is equivalent.
- **Files:** `ai/schemaConvert.ts` (new), `ai/client.ts`, `routes/text.ts`, `services/apiClient.ts`.
- **Verify:** server + frontend typecheck clean; 35 AI tests pass (parsing/grounding intact).

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

## 2026-05-29 — Auto-router replaces hardcoded model defaults (assistant 404 + analyze 429)

- **Problem:** assistant 500→404 (`google/gemini-2.0-flash-exp:free` retired → "No endpoints
  found"); analyze-script 500→429 (a free text model rate-limited upstream). Hardcoded model
  defaults are fragile.
- **Solution:** `ai/autoRouter.ts` picks the best **currently-available** model from the live
  catalog (free-first, under budget) — `pickTextModel` / `pickImageModel` — so retired models
  are never chosen. Added `fallbackModel` to the OpenRouter provider: on 404/429 it retries on a
  reliable fallback (`openai/gpt-4o-mini` for text). Wired into the assistant, text routes (+ the
  createClient shim), and image route, replacing OPENROUTER_TEXT_MODEL / OPENROUTER_IMAGE_MODEL /
  OPENROUTER_FREE_TEXT_MODEL. UI: model "Default" → "Auto".
- **Files:** `ai/autoRouter.ts` (new), `ai/providers/{openrouter,types}.ts`, `ai/client.ts`,
  `ai/assistant.ts`, `routes/{assistant,text,image}.ts`, `ModelSelectionPanel`/
  `TokenAvailabilityPill`/`ModelLibrary`.
- **Verify:** server + frontend typecheck clean; 35 AI tests pass.

## 2026-05-29 — Remove leftover Gemini "default model" UI (Auto only)

- **Problem:** Gemini still appeared as the default model option despite the auto-router.
- **Root cause:** two legacy hardcoded Gemini/Flux surfaces remained — SettingsModal's
  "Image Models" + "Model Routing" sections, and AccountSettings' "Default Image/Text Model"
  selects (fed by services/imageModels.ts + modelPolicy.ts).
- **Solution:** removed all three. Model choice is now exclusively the Auto-based
  ModelSelectionPanel (live catalog, free-first) in API Configuration.
- **Files:** components/SettingsModal.tsx, components/AccountSettings.tsx.
- **Verify:** frontend typecheck clean.
