# Account / settings / API-key sync audit — June 2026

Full-system audit of how accounts, settings, AI model preferences, API keys and chat
personalization sync between the main app (DreamStream), the Chat Studio, the Code
Studio and the Stream (live) Studio. Every issue found is listed — fixed ones with
the fix, deferred ones with a recommendation — so this file doubles as the running
issue log for the account-sync area.

## Target architecture (after this audit's fixes)

**One account, one key set, namespaced settings.**

- **Identity** is a single Supabase session (`dreamstream_auth_token`) shared by every
  studio on the origin. (This was already correct.)
- **API keys are account-level.** The server resolves provider keys per request as
  `request header (this device) > account store (user_api_keys, server-encrypted) >
  platform env` — `server/src/middleware/accountKeys.ts`. A key added in any studio on
  any device is used by all of them.
- **The settings snapshot is account-level but internally namespaced** (snapshot v2 in
  `services/cloudSync.ts`): account-wide sections (keys, model preferences, chat
  memory + custom agents) vs. per-studio sections (`studios.code` for the Code
  Studio's pinned model/knobs; Stream Studio keeps its own `stream_studio_settings`
  table by design). Accounts stay the same everywhere; each studio keeps its own
  settings without overwriting another's.
- **Snapshot storage is server-encrypted** via `GET/PUT /api/account/settings`
  (AES-256-GCM under a server-only key), replacing in-browser encryption with a
  hardcoded secret. Legacy rows are decrypted once on read and re-encrypted on the
  next push.
- **Memory is portable**: chat memory follows the account, and users can import
  memories from ChatGPT / Claude / Gemini (Settings → Memory → "Import from another
  AI"), with client-side extraction (`services/memoryImport.ts`) and server-side
  distillation (`POST /api/chat/memory/import`).

## Issues fixed in this audit

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | **Critical** | BYOK keys + settings cloud-synced via `user_settings` encrypted **in the browser with a hardcoded secret shipped in the public bundle** (`services/crypto.ts`) — every stored secret was decryptable by anyone with the bundle or a DB dump. The hardened server path (`user_api_keys`) existed but was **write-only, never read**. | Snapshot moved server-side: `GET/PUT /api/account/settings` encrypts with the server-only secret (`server/src/lib/secureStore.ts`); legacy blobs are migrated on read (`decryptLegacyClientBlob`). `services/crypto.ts` is no longer used for sync. |
| 2 | **Critical** | Keys were **not actually account-level**: the server only used keys sent as request headers, so a key entered on one device/studio was invisible to others; `user_api_keys` was never consulted. | New `attachAccountKeys` middleware (mounted after `requireAuth` in `server/src/index.ts`) fills any provider key the request didn't carry from the user's encrypted account store, with a 60s per-user cache. Precedence: header > account > platform env. |
| 3 | **High** | **Cross-account settings bleed on shared devices**: preferences (`dreamstream_settings`, model keys, image model/provider, model selection, studio model) were not cleared on sign-out, and `syncOnLogin`'s merge **uploaded the previous user's leftovers into the next user's cloud account**. | Sign-out now clears all account-scoped preference keys: `clearUserScopedSettings()` (`services/appSettings.ts`), `clearModelSelection()`, `clearStudioModelSelection()` — wired in `contexts/AuthContext.tsx`. |
| 4 | **High** | **Code Studio model settings, chat/comics model selection, chat memory and custom agents never cloud-synced** — keys followed the account but these silently stayed per-device (the core "settings are a mess across studios" complaint). | Snapshot v2 syncs all of them, namespaced: `modelSelection` + `chat.memory` + `chat.agents` (account-level) and `studios.code` (studio-level). Change listeners registered in `AuthContext` (window events for the two selection stores; `setChatDataChangeListener` for memory/agents). |
| 5 | **High** | **Code Studio couldn't see keys added through the modern Settings UI**: `CodeStudioView.tsx` gated BYOK on the legacy `dreamstream_openrouter_key` slot only, while Settings wrote to the managed multi-key store. | `hasByok` now checks the managed store and the account ("key on file" metadata) plus the legacy slot: `hasUsableKey('openrouter')` (`services/apiKeys.ts`). |
| 6 | **Medium** | **Deleting a key locally never removed the server mirror** (`removeByokKeyFromServer` had zero callers) — the account kept (and after fix #2, kept *using*) a key the user deleted. Switching the active key also never updated the mirror. | `reconcileProviderMirror()` (`services/byokSync.ts`) syncs the current active key or removes the mirror; wired to delete + set-active in `components/ApiConfiguration.tsx`. |
| 7 | **Medium** | **Provider alias drift**: `FluxKeyInput` mirrored keys under provider `'flux'` while the key store calls it `'pixazo'` — two rows for one provider, with whichever was stale winning depending on path. | Server canonicalizes `flux → pixazo` on write/delete/read (`server/src/routes/account.ts`), retires alias rows on write, and the account-key fallback reads both. |
| 8 | **Medium** | **BYOK billing misclassification (latent)**: `hasByokForProvider` checked raw request headers, so account-resolved keys (fix #2) would have been billed as *platform* usage. Also gemini/pixazo had no BYOK origin flags at all. | All five providers get `*Byok` flags in `attachKeys`; `usageEnforcer.hasByokForProvider` now reads the resolved flags. |
| 9 | **Medium** | **Memory was localStorage-only**: the "AI remembers you" feature didn't follow the account across devices (and a wiped browser lost it all). | Memory rides snapshot v2; login merges by bullet-item union (dedupe, local first), steady-state pushes propagate edits/deletes. |
| 10 | **Medium** | **No way to bring memories from other AI tools.** | New import pipeline: Settings → Memory → "Import from another AI" (ChatGPT / Claude / Gemini / other). Client-side extraction strips assistant turns + metadata from export JSON (`services/memoryImport.ts`, tested); server distills with the same conservative rules as auto-memory (`POST /api/chat/memory/import`); user reviews the merged preview before saving. |
| 11 | **Low** | `user_settings` table was **not defined in any migration** — fresh environments had silently-failing sync. | `server/sql/user_settings.sql` documents/creates it (idempotent), with RLS and a post-deploy hardening note to revoke direct client access. |
| 12 | **Low** | `syncOnLogin` only seeded the cloud when local keys existed, so a first login with only *preferences* never created the account snapshot. | Seeding now always pushes the full local snapshot. |

## Known issues deferred (logged, not yet fixed)

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| D1 | Medium | **ComicForge stages are hardcoded to OpenRouter defaults** (`server/src/comicforge/textStages.ts`, `generation.ts`) — a user routed to NVIDIA for chat/code still pays OpenRouter for comics. | Thread the resolved provider/source preference through ComicForge stage resolution. |
| D2 | Medium | **Per-key monthly spend limits are client-side only** (`services/apiKeys.ts` `limitUsd`); the server never enforces them, so any non-UI client bypasses the cap. | Enforce per-key caps in `usageEnforcer` (send limit alongside the key, or store it in `user_api_keys`). |
| D3 | Medium | **Stream Studio prefs use newer-wins whole-blob conflict resolution with client clocks** (`live/sync.ts`) — parallel edits on two devices silently drop one side; clock skew can resurrect stale prefs. | Field-level merge like the main snapshot, or server timestamps. |
| D4 | Low | **Login-time union merges resurrect deletions** (keys, memory items, agents deleted on an offline device reappear after it syncs). Inherent to union-without-tombstones; steady-state pushes do propagate deletes. | Add per-item `updatedAt`/tombstones if this bites in practice. |
| D5 | Low | **`TEXT_FALLBACK` is a paid model** (`server/src/ai/autoRouter.ts`) — free-tier users can be routed to a paid model when the catalog is empty/unavailable (cost is platform-side unless BYOK). | Respect `costPref: 'free-only'` in the terminal fallback. |
| D6 | Low | **`/api/models/verify` calls OpenRouter live per request** with no per-user rate limit — refresh-mashing can trip provider 429s. | Short server-side cache or per-user limiter. |
| D7 | Low | **Storage key naming is inconsistent** (`dreamstream_*`, `ds.*`, `ds-*`) making audits harder. | Converge new keys on one prefix; don't churn existing ones. |
| D8 | Low | **Stream Studio doesn't pull prefs on focus** — a device left open misses changes made elsewhere until reload. | `visibilitychange` listener → `pullPrefsFromCloud()`. |
| D9 | Low | **Email preferences (`profile_private`) have no in-app UI** — set at signup, not editable after. | Add toggles to Settings → Profile. |
| D10 | Info | **BYOK keys remain plaintext in localStorage on the device that entered them** (XSS exfiltration risk; account store is encrypted). Any client-side encryption would be obfuscation only. | Long-term: stop holding secrets client-side at all — the account fallback (fix #2) already makes that possible; the UI could keep only suffixes. |
| D11 | Info | `dreamstream_settings.defaultImageModel` and `dreamstream_image_model_id` are **two slots for one concept** and can diverge. | Fold `imageModelId` into the settings object. |

False positive from a prior sweep, for the record: the client model-catalog cache *does*
check its TTL (`services/modelCatalog.ts:74`).

## How sync works now (quick reference)

```
login ──► GET /api/account/byok  ──► provider "key on file" metadata (suffixes only)
      └─► GET /api/account/settings ──► snapshot v2 (server-decrypted)
            merge with local (keys: union by secret · settings: cloud wins ·
            memory: item union · agents: id union · studios.code: cloud wins)
            apply locally (listeners suspended) ──► PUT back (server-encrypted)

any local change (keys / settings / model selection / studio model / memory / agents)
      └─► debounced 1.5s ──► PUT /api/account/settings

any API request ──► attachKeys (header > env) ──► requireAuth
      └─► attachAccountKeys: fill missing keys from user_api_keys (60s cache)
```
