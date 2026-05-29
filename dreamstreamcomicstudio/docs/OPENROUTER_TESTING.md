# Testing the OpenRouter API source

This wires the OpenRouter gateway (built in Phase 0-2) into **live, callable routes**
so you can actually generate text and images through the new source. Until now
only the Model Library *catalog* read from OpenRouter; generation still ran on the
legacy Gemini/Pixazo path.

## What's new

| Surface | Route / command | Notes |
|---------|-----------------|-------|
| Text generation | `POST /api/text/generate` | Provider-agnostic passthrough via the gateway. `{ prompt }` or `{ messages }`; `jsonMode: true` for JSON. |
| Image generation | `POST /api/image/openrouter` | Mirrors `/api/image/gemini` — billing, persistence, idempotency reused. |
| Smoke test | `npm run openrouter:smoketest` | Hits OpenRouter directly. No server, no auth, no build step. |

Both routes work **regardless of the `AI_PROVIDER` flag** — they explicitly target
OpenRouter, so you can test the new source while the legacy path keeps serving the
existing pipeline.

## 1. Set your key

```bash
# in dreamstreamcomicstudio/.env  (or export in your shell)
OPENROUTER_API_KEY=sk-or-...
# optional overrides (defaults shown)
OPENROUTER_TEXT_MODEL=google/gemini-2.5-flash
OPENROUTER_IMAGE_MODEL=google/gemini-2.5-flash-image
```

## 2. Fastest check — the smoke test

```bash
npm run openrouter:smoketest            # text round-trip
npm run openrouter:smoketest -- --models  # also list a few free text models
npm run openrouter:smoketest -- --image   # also generate one image
```

A green run confirms your key, network, and chosen models all work.

## 3. Through the running server

Start the app (`npm run dev`), then call the authed routes. Supply a logged-in
user's bearer token; add `X-OpenRouter-Key` to use **your own** key (BYOK — bypasses
platform billing) instead of the server's `OPENROUTER_API_KEY`.

```bash
# Text
curl -sS http://localhost:3000/api/text/generate \
  -H "Authorization: Bearer <USER_JWT>" \
  -H "X-OpenRouter-Key: sk-or-..." \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Write a one-line comic caption about a brave cat.","jsonMode":false}'

# Image (storage:"test" skips persistence so no project is needed)
curl -sS http://localhost:3000/api/image/openrouter \
  -H "Authorization: Bearer <USER_JWT>" \
  -H "X-OpenRouter-Key: sk-or-..." \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A red apple, comic ink style","aspectRatio":"1:1","resolution":"1024x1024","storage":"test"}'
```

Each response includes a `billing` block (estimate + settlement) unless BYOK bypassed it.

## 4. Make OpenRouter the default (optional)

Set `AI_PROVIDER=openrouter` in `.env`. This flips `isOpenRouterEnabled()` / the
gateway's default provider. The dedicated routes above don't require it — it governs
which provider the *default* path resolves to.

## Adding more BYOK providers later

The gateway is a registry (`server/src/ai/gateway.ts`):

```ts
const PROVIDERS: Record<string, AIProvider> = {
  openrouter: openRouterProvider
  // add: e.g. fal: falProvider, replicate: replicateProvider
};
```

To add a provider: implement the `AIProvider` interface (`generateText`,
`generateImage`, `listModels` — see `server/src/ai/providers/openrouter.ts`), add a
BYOK header + `requireXKey` in `server/src/middleware/keys.ts`, register it in
`PROVIDERS`, and extend the billing provider union in `shared/types/billing.ts`. No
route code needs to change — call `getProvider('<id>')`.
