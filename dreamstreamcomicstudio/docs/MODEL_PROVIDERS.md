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
  provider (OpenRouter: `/key`, status code only — the body is never read) (200 = valid,
  401/403 = invalid). Browser-candidate checks and account-only checks both preserve the
  `X-Allowed-Sources` header, including an explicitly empty list when every source is off.
  NVIDIA's `/models` is publicly readable and cannot authenticate a
  key: it reports "not verifiable", and old NVIDIA verification badges are cleared. Discovery
  does not establish inference access. Providers with no public listing — and Pixazo / Ideogram,
  which have no validation endpoint — also report "not verifiable" rather than guessed. Signed-in only
  (mounted after `requireAuth` + `attachAccountKeys`); it checks only the caller's own key
  (the provider header, else the account key) — never the platform env key (no caller key, or
  a source turned off by `X-Allowed-Sources` → `missing`, with no outbound call) — and answers
  `{ provider, status, valid, message }` only (no usage/limit records). Messages are fixed
  text: an unreachable provider is "Could not reach <Provider> right now." (the error itself
  — hosts, IPs, a configured base URL — goes to the server log only), and an unknown provider
  is a 400 "Unknown provider." that never echoes the input. `unavailable` (unreachable, or an
  upstream error that is not 401/403) is **not** a verdict on the key. The Gemini key goes
  upstream in `x-goog-api-key`, not the URL. The client checks a key on add, on Verify, and on
  open when the last verdict is over 24 h old — never on a timer — and stores only verdicts
  from a 200 answer: when the check can't run (our route's 401/429/5xx, offline, or
  `unavailable`) the row says "Couldn't check…" / "Sign in again…" without recording it, so the
  previous verdict stays and the next open re-checks. Older stored non-verdicts ("Validation
  failed (HTTP …)", "Could not validate…", "Could not reach…", "… returned 503.") are treated
  as unchecked.

## The catalog

`GET /api/models/catalog` merges OpenRouter's live public list (the `base`) with every
direct provider's models. A successful authenticated listing supplies the current key's
IDs, with curated metadata for exact matches; a **static seed** is the fallback when no
listing is available. Anthropic discovery follows pagination. A listing proves discovery,
not that a particular generation request or capability will succeed.

Rows distinguish `catalogOrigin` (`live`, `curated`, `cached`) and `catalogCheckedAt`
(last live observation) from `pricingOrigin` (`provider`, `curated`, `unknown`).
`pricingKnown: false` means numeric zeros are placeholders, never a free quote. NVIDIA's
listing does not publish per-call prices. Direct provider seed prices remain curated
even when their model IDs are found live. Z.AI and MiniMax currently have no listing
endpoint configured and therefore remain curated.

The durable index is a union of public metadata discovered through different keys;
one account's smaller listing must not retire another account's models. Cached rows
retain their individual observation dates. The browser's full-catalog snapshot is not
overwritten by studio/source/search subsets, and cached responses are marked stale.

`GET /api/models/speed` reports observed successful Chat turn duration, excluding tool
turns and models with fewer than three samples. It includes `measuredAt`, `windowDays`,
`sampleLimit`, `capped`, and availability status. It pools routes by model ID; this is
end-to-end response time, not throughput, model quality, or an availability guarantee.
Both server and client cache it for two minutes. Missing observations remain missing.

### Resilience (why OpenRouter once "disappeared")

`server/src/services/modelCatalog.ts` `refresh()` deliberately:

- **Treats an empty result as a FAILED refresh** (throws). A transient empty response
  from OpenRouter's `/models` must never be cached as "fresh" or persisted to the durable
  Supabase index — doing so once wiped the catalog for a full TTL and masked the outage
  behind the new providers' seeds. On failure, `getCatalog()` keeps serving the last-good
  in-memory / Supabase snapshot, flagged `degraded`.
- **Fetches public discovery anonymously** — OpenRouter and NVIDIA model lists do not
  establish authentication or inference access. A key's validity must not be inferred from
  those public listings. NVIDIA callability probes are separate from catalog discovery.
- The default provider (`gateway.ts` `defaultProviderId`) can only ever be a unified
  gateway (`openrouter`/`nvidia`); registering a direct provider must not flip the platform
  default off OpenRouter.

Regression coverage: `server/src/services/modelCatalog.test.ts`,
`server/src/middleware/keys.test.ts`, `server/src/ai/providers/*.test.ts`.

## Image generation

The new providers are primarily text. Two also do image generation via the chat
`generate_image` tool (BYOK only, no platform billing): **OpenAI** (`gpt-image-1`) and
**xAI** (`grok-2-image`), wired in `server/src/ai/tools/imageGen.ts` through the provider
gateway. This is purely additive — the Classic image path (Gemini/Flux/Ideogram) and
the billed `/api/image/*` endpoints are untouched. Override the models with
`OPENAI_IMAGE_MODEL` / `XAI_IMAGE_MODEL`.

## Provider and Studio compatibility

This table describes implemented routing, not successful live generation with a user's key.
A model maker and a serving connection are different: Claude or GPT models in Comic Studio
use OpenRouter; an Anthropic or OpenAI key does not substitute for an OpenRouter key.

| Connection | Chat Studio | Comic Studio | Classic Studio | Non-generating key check |
| --- | --- | --- | --- | --- |
| OpenRouter | Text | Text roles and supported locked image models | Text and gateway image route | Authenticated `GET /key` |
| NVIDIA | Text | No direct route | Text; experimental image adapter, not live-verified | Unsupported: public model list |
| Gemini | Text and image tool | Google image models and Google text route | Text, vision and images | Authenticated `GET /v1beta/models` |
| OpenAI | Text and BYOK image tool | Via OpenRouter only | No direct route | Authenticated `GET /models` |
| Anthropic | Text | Via OpenRouter only | No direct route | Authenticated `GET /models` |
| DeepSeek | Text | No direct route | No direct route | Authenticated `GET /models` |
| Z.AI | Text | No direct route | No direct route | Unsupported: no configured read-only endpoint |
| MiniMax | Text | No direct route | No direct route | Unsupported: no configured read-only endpoint |
| Tencent Hunyuan (legacy) | Text with an existing Hunyuan key | No direct route | No direct route | Configured `/models`; live authentication not established in this audit |
| xAI | Text and BYOK image tool | No direct route | No direct route | Authenticated `GET /models` |
| Pixazo / Flux | Image tool | No direct route | Images | Unsupported |
| Ideogram | Image tool | No direct route | Images | Unsupported |
| Sarvam | No route | Explicit single-line translation suggestion | No route | Unsupported |

Stream Studio's local media/ML and relay infrastructure do not use these model-provider keys.
Comic's bulk translation uses its own translator/linguist roles; Sarvam is an optional explicit
line suggestion, saved only after editing/acceptance. Comic roles come from server defaults or
operator overrides, and each comic retains its image model lock. The global text default applies
to new Chat selections and supported Classic requests, not every Studio or existing Chat pin.

The Chat image tool accepts the user's own image keys. For governed users it never substitutes
platform image keys; administrators or deployments with usage metering disabled retain the
existing platform-key behavior. Image capability and text compatibility remain model-specific.

The Tencent connection intentionally preserves the existing Hunyuan endpoint. Tencent's
[Hunyuan migration notice](https://cloud.tencent.com/document/product/1729/111007) says existing
purchases continue there while new services move to TokenHub. [TokenHub's API guide](https://cloud.tencent.com/document/product/1823/130078)
documents different, region-specific endpoints. TokenHub keys are not interchangeable with the
legacy connection, and the application does not silently move a stored key between these services.

### Evidence and remaining live checks (2026-11-13)

- An anonymous read of [NVIDIA's official model list](https://integrate.api.nvidia.com/v1/models)
  returned catalog data. This establishes public discovery only. The app now reports NVIDIA
  validation as unsupported and removes old local "valid" verdicts derived from that list.
- Anonymous OpenRouter `/key`, OpenAI `/models`, and xAI `/models` returned HTTP 401. Those
  endpoints require authentication, but these observations do not verify any configured key.
- Local coverage exercises browser keys, account-only keys, header/account/platform precedence,
  source disablement including all-off, stale-key responses, no platform-key disclosure, and
  Classic source constraints. See `services/keyValidation.test.ts`, `services/apiClient.tabSession.test.ts`,
  `services/apiKeys.clear.test.ts`, `server/src/routes/keys.test.ts`, `server/src/routes/models.verify.test.ts`,
  `server/src/middleware/accountKeys.test.ts`, `server/src/comic/keys.test.ts`, and
  `server/src/routes/text.holdPricing.test.ts`.
- No private provider key or paid generation was exercised in this audit. Live account-only,
  browser-key, and model entitlement checks remain distinct from unit coverage and require the
  signed-in owner's authorized session. Saving a key, public discovery, and a successful
  authentication check each provide different evidence; none alone proves generation capability.

Routing evidence: `server/src/routes/chat.ts`, `server/src/ai/gateway.ts`,
`server/src/ai/tools/imageGen.ts`, `server/src/comic/keys.ts`, `server/src/comic/textModels.ts`,
`server/src/routes/text.ts`, `services/geminiService.ts`, and `server/src/routes/comic.ts`.

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
