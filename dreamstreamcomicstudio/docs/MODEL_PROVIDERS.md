# Model providers

How the app talks to AI model **providers** (the upstreams that actually serve model
calls), how user keys (BYOK) flow, and how the catalog stays resilient. A *provider* is
distinct from a *vendor* (the model maker, derived from a model-id slug — see
`services/modelVendors.ts`): the same model (e.g. Claude) can be reached through several
providers, which is the "pick a model, then choose who serves it" experience.

## The registry — one source of truth

`shared/providers.ts` (`PROVIDER_REGISTRY`) is the single, dependency-free definition of
every text provider, consumed by **both** the browser bundle and the Node server. Each
entry carries: display labels, the BYOK request header, the platform key env var, the
base URL (+ override env), the get-key / add-funds / docs deep links, a brand badge +
accent, and flags (`platformServed`, `freeTier`, `keyPrefix`, `api`, `modelsPath`).

Current providers: `openrouter`, `nvidia`, `openai`, `anthropic`, `gemini` (Google),
`deepseek`, `zai` (Z.AI/GLM), `minimax`, `tencent` (Hunyuan), `xai` (Grok).

- **`platformServed`** (openrouter, nvidia, gemini): the platform can serve these on its
  own key / monthly allowance, so a user without a personal key can still use them. The
  rest are **BYOK-only** — without a key their models are greyed out with "Add a key".
- **`api`**: `openai` (OpenAI-compatible `/chat/completions`) or `anthropic` (native
  Messages API).

### Adding a provider

1. Add an entry to `PROVIDER_REGISTRY` in `shared/providers.ts`.
2. Server: register an `AIProvider` in `server/src/ai/gateway.ts`. OpenAI-compatible
   providers use `createOpenAICompatibleProvider({...})`; native protocols get their own
   adapter (see `providers/anthropic.ts`). Add config (base URL/key/timeout) in
   `server/src/config.ts`, and a curated seed in `providers/staticModels.ts`.
3. That's it for the client/server plumbing — keys, validation, the catalog merge, chat
   provider resolution, account storage and the UI all derive from the registry.

## BYOK key flow

```
request header (this device's key)  >  account key (user_api_keys, encrypted)  >  platform env
```

- **Client** (`services/apiKeys.ts`, `services/apiClient.ts`): keys live in localStorage
  (multi-key, one active per provider, optional monthly limit) and attach as
  `X-<Provider>-Key` headers, gated by source governance (`services/sourceGovernance.ts`).
- **Server** (`middleware/keys.ts`): `attachKeys` resolves every provider header → env
  into `req.apiKeys.providerKeys` (generic map) plus named fields for the original
  providers. `middleware/accountKeys.ts` fills in the account-stored key when no header is
  present. `X-Allowed-Sources` governance nulls any disabled provider's key everywhere.
- **Validation**: `POST /api/keys/validate` does a cheap read-only `/models` call per
  provider (200 = valid, 401/403 = invalid). Providers with no public listing are
  reported "not verifiable" rather than guessed.

## The catalog

`GET /api/models/catalog` merges OpenRouter's live public list (the `base`) with every
direct provider's models — a curated **static seed** (so the page is populated even
keyless) plus the live `/models` list when a key is present, de-duplicated.

### Resilience (why OpenRouter once "disappeared")

`server/src/services/modelCatalog.ts` `refresh()` deliberately:

- **Treats an empty result as a FAILED refresh** (throws). A transient empty response
  from OpenRouter's `/models` must never be cached as "fresh" or persisted to the durable
  Supabase index — doing so once wiped the catalog for a full TTL and masked the outage
  behind the new providers' seeds. On failure, `getCatalog()` keeps serving the last-good
  in-memory / Supabase snapshot, flagged `degraded`.
- **Fetches OpenRouter's public list anonymously** — no platform key — so a rate-limited
  or invalid key can't starve the catalog. (NVIDIA's `/models` needs auth, so it keeps the
  platform key.)
- The default provider (`gateway.ts` `defaultProviderId`) can only ever be a unified
  gateway (`openrouter`/`nvidia`); registering a direct provider must not flip the platform
  default off OpenRouter.

Regression coverage: `server/src/services/modelCatalog.test.ts`,
`server/src/middleware/keys.test.ts`, `server/src/ai/providers/*.test.ts`.

## Image generation

The new providers are primarily text. Two also do image generation via the chat
`generate_image` tool (BYOK only, no platform billing): **OpenAI** (`gpt-image-1`) and
**xAI** (`grok-2-image`), wired in `server/src/ai/tools/imageGen.ts` through the provider
gateway. This is purely additive — the comic-studio image path (Gemini/Flux/Ideogram) and
the billed `/api/image/*` endpoints are untouched. Override the models with
`OPENAI_IMAGE_MODEL` / `XAI_IMAGE_MODEL`.

## Where models surface

- **API settings** (`components/ApiConfiguration.tsx`): the provider list — status,
  on/off, key management, get-key/add-funds links, live model counts.
- **Choose a model** (`components/chat/ChatModelPicker.tsx`): provider filter; BYOK-only
  providers without a key are greyed with "Add a key".
- **Model Library** (`components/ModelLibrary.tsx`): per-provider source facets; browses
  every enabled provider.
- **Default models** (`components/ModelSelectionPanel.tsx`): lock/preferred source per
  provider.

Brand marks live in `components/providerLogos.tsx` (`<ProviderLogo>`); the per-source icon
in the Model Library cards routes through `components/models/ProviderIcon.tsx`.
