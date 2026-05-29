# Architecture Overview

DreamStream Comic Studio turns scripts into comics with an AI pipeline. This is a
high-level map; see `features/` and `decisions/` for detail.

## Topology

```
  Browser (Vite/React SPA)               Cloudflare Pages (static hosting)
        │  fetch /api/*  (X-*-Key headers, Supabase JWT)
        ▼
  Express/TypeScript API  ──────────────  Railway (Dockerfile, /api/health)
        ├── routes/      HTTP surface (text, image, billing, models, …)
        ├── ai/          provider gateway + legacy Gemini/Pixazo
        ├── services/    billing ledger, usage enforcer, storage, catalogs
        └── middleware/   auth, API-key resolution, rate limits
        │
        ├── Supabase (Postgres + Auth + Storage)   data, RLS, images
        └── AI providers
              ├── OpenRouter gateway  (unified text+image, BYOK)   ← preferred
              └── legacy Gemini (@google/genai) + Pixazo/Flux       ← fallback
```

- **Frontend:** Vite + React 19 + Tailwind. Entry `index.tsx` → `App.tsx`
  (hand-rolled view state). Services in `services/` wrap all API calls
  (`services/apiClient.ts` attaches keys + auth). House design system:
  `border-2 border-black`, `shadow-comic`, `font-display` (Bangers),
  brand colors `brand-yellow/blue/red` (see `tailwind.config.cjs`).
- **Backend:** Express in `server/src`. Mounted routers in `server/src/index.ts`.
  Auth via Supabase JWT (`middleware`), API keys resolved in
  `middleware/keys.ts` (`attachKeys`).
- **AI gateway:** `server/src/ai/gateway.ts` is a provider registry. Routes call
  `getProvider(id).generateText/generateImage/listModels`. OpenRouter is the
  first provider (`ai/providers/openrouter.ts`). The `AI_PROVIDER` flag selects
  the default provider; dedicated `/api/*/openrouter` paths are always available.
  See `decisions/0001-openrouter-gateway-and-byok.md`.
- **Billing/usage:** `services/billingLedger.ts` (wallet, reservations,
  settlement, ledger entries), `services/usageEnforcer.ts` (reserve/settle around
  each operation), `services/costEstimator.ts` (token/cost math). Persisted in
  Supabase `token_wallets`, `token_ledger_entries`, `generation_cost_events`.
  > Status: the platform "Comic Token (CT)" credit model is being de-emphasized in
  > the UI in favor of per-API-key limits. See `decisions/` for the latest.

## Key data tables (Supabase)

- `projects`, `scripts`, `asset_cards`, `pages`, `panels` — comic content.
- `user_api_keys` — per-user provider keys (encrypted).
- `token_wallets`, `token_ledger_entries`, `generation_cost_events` — billing/usage.
- `notifications` — in-app notifications (`follow|comment|like|generation|system`).

## Request lifecycle (generation)

1. Client calls e.g. `POST /api/image/openrouter` with the user's JWT and
   `X-OpenRouter-Key` (BYOK) if set.
2. Route reserves budget (`reserveForOperation`), calls the provider via the
   gateway, persists the image, then settles actual cost (`settleReservedOperation`).
3. Response includes a `billing` block (estimate + settlement).

## Where to look next

- AI pipeline detail: `ai_flow_documentation.md`
- Deploy: `RAILWAY_DEPLOY.md` (backend), Cloudflare Pages (frontend, root dir
  `dreamstreamcomicstudio`, build `npm run build`, output `dist`).
- Decisions: `decisions/`
