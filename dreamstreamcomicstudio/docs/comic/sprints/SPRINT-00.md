# SPRINT-00 — Foundation & fences

**Status:** 📋 next
**Goal:** The app opens as **one comic product** on a **BYOK/OpenRouter** default with
billing UI hidden, the repo is clean, and feature flags are in place — so every later
sprint builds on a focused, honest base.
**Depends on:** —
**Flags introduced:** `VITE_SHOW_LEGACY_PRODUCTS` (default `false`),
`VITE_BILLING_UI_ENABLED` (default `false`), server `AI_PROVIDER=openrouter` (default).

## Why
Before building the document model and editor, remove the noise: the three non-comic
products, the billing complexity not needed for BYOK, and the repo cruft. Make the
cost-controlled OpenRouter path the *default*, not an opt-in.

## Tasks

### 00.1 — Repo hygiene
- **Do:** Remove committed cruft; ensure `.gitignore` covers them.
- **Files:** delete `dreamstream-comic-studio (1).zip` (repo root has one too), `.DS_Store`,
  `dreamstreamcomicstudio/analyze_comic.ts` (scratch); add `*.zip`, `.DS_Store`,
  `analyze_*.ts`, `*_analysis.json` to `.gitignore`.
- **Accept:** `git status` clean after; `npm run build` still works.
- [ ] done

### 00.2 — Fence the non-comic products behind a flag
- **Do:** Make **Comic** the default landing. Hide AI Chat, Code Studio, and Models from
  the primary nav unless `VITE_SHOW_LEGACY_PRODUCTS==='true'`. Guard their routes/views
  the same way (don't delete the code).
- **Files:** `components/Header.tsx` / `components/layout/StaticSiteHeader.tsx` (the
  4-product dropdown), `App.tsx` (the `chat`/`models`/comicforge-as-code views;
  `GlobalChatFAB`, the chat FAB), a new `services/featureFlags.ts` reading
  `import.meta.env.VITE_SHOW_LEGACY_PRODUCTS`.
- **Accept:** With the flag unset, the header/nav shows only Comic (+ Reader/Library/
  Settings); AI Chat/Code/Models are unreachable from the UI; with it set, they reappear.
- [ ] done

### 00.3 — BYOK + OpenRouter as the personal default
- **Do:** Default `AI_PROVIDER=openrouter` (`server/src/config.ts`); ensure the BYOK
  OpenRouter key path is the primary one client-side (`services/apiClient.ts` injects
  `X-OpenRouter-Key`). Keep legacy provider routes reachable but not default.
- **Files:** `server/src/config.ts`, `services/apiClient.ts`, `.env.example`
  (document the new default), `services/appSettings.ts`.
- **Accept:** With only an OpenRouter key set, a text + an image call both route through
  the OpenRouter provider (verify via a smoke call or the existing
  `scripts/openrouter-smoketest.mjs`); no Gemini-SDK path is hit.
- [ ] done

### 00.4 — First-run BYOK key screen
- **Do:** A one-screen "Connect your key" gate shown when no provider key is present,
  before Create. OpenRouter primary; link to a short "get a key (incl. free models)"
  guide; store via existing key flow. Skippable only into read-only.
- **Files:** new `components/onboarding/ConnectKey.tsx`; wire into `App.tsx` create gate;
  reuse `components/OpenRouterKeyInput.tsx` / `services/apiKeys.ts`.
- **Accept:** Fresh browser (no key) → Create is gated by ConnectKey; after saving a key,
  Create proceeds; key persists across reload.
- [ ] done

### 00.5 — Hide billing/credit UI (keep code)
- **Do:** Gate CT credit/wallet/Stripe/usage-meter UI behind `VITE_BILLING_UI_ENABLED`
  (default false). Server billing code untouched (dormant for BYOK).
- **Files:** `components/TokenAvailabilityPill.tsx`, `components/AccountSettings.tsx`
  (billing tab), any cost/credit chips; `services/featureFlags.ts`.
- **Accept:** No credit/wallet UI visible by default; BYOK spend chip (00.6) is the only
  cost surface; flag on restores billing UI.
- [ ] done

### 00.6 — BYOK spend visibility (minimal)
- **Do:** Surface a running "spent on this comic / today" chip from existing per-key
  usage tracking (`recordKeyUsage`).
- **Files:** small `components/CostChip.tsx`; read `services/billing.ts` /
  per-key usage store.
- **Accept:** After an image call on the user's key, the chip shows a non-zero $ that
  matches the settled `usage.cost` (±estimate).
- [ ] done

### 00.7 — Seed the doc system into CI awareness (optional, light)
- **Do:** Add a one-line pointer in root `CLAUDE.md` / `dreamstreamcomicstudio/CLAUDE.md`
  to `docs/comic/00-STATUS.md` as the comic product's source of truth.
- **Files:** `CLAUDE.md`.
- **Accept:** A new session reading `CLAUDE.md` is pointed at `docs/comic/`.
- [ ] done

## Out of scope
- The `ComicDoc` model itself → Sprint 1.
- Deleting/extracting the frozen products → later (fence only now).
- Any editor/canvas work → Sprint 3.

## Definition of done (sprint)
- [ ] Tasks 00.1–00.7 checked
- [ ] `npm run typecheck` + `npm run build:server` clean; `npm run build` ok
- [ ] App opens to a comic-only experience on a BYOK/OpenRouter default
- [ ] Four docs updated (`AGENTS.md` §2); branch pushed; draft PR
