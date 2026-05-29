# 0001. OpenRouter gateway + BYOK as the AI control plane

- **Status:** Accepted
- **Date:** 2026-05

## Context

The app originally hardcoded two providers (Gemini via `@google/genai`, Pixazo/Flux
via raw fetch) across ~30 call sites. Adding/swapping models meant touching many
files, and there was no clean place to meter cost or let users supply their own
keys. We wanted a single control plane and a BYOK (bring-your-own-key) free tier.

## Decision

- Introduce a provider-agnostic **gateway** (`server/src/ai/gateway.ts`) with a
  `PROVIDERS` registry. Routes call `getProvider(id).generateText/generateImage/listModels`
  instead of a vendor SDK.
- **OpenRouter** is the first provider (`ai/providers/openrouter.ts`), covering text
  and image via the OpenAI-compatible `/chat/completions` surface.
- **BYOK:** users can send `X-OpenRouter-Key`; when present it funds the call on the
  user's own account and bypasses platform billing (`resolveProviderContext`).
- The `AI_PROVIDER` env flag selects the default provider; dedicated
  `/api/text/generate` and `/api/image/openrouter` routes are always available so the
  new source is testable regardless of the flag.
- Live **image** generation routes through OpenRouter when a BYOK key is set; the
  **text-planning** pipeline still uses Gemini because its `@google/genai` `Type.*`
  response schemas are not directly portable to OpenRouter JSON Schema (see follow-up).

## Consequences

- Adding a provider later is a one-line registry change + an `AIProvider` impl.
- Cost can be metered in one place; OpenRouter's real `usage.cost` feeds settlement.
- Follow-up (not yet done): migrate the 8 Gemini-schema text functions in
  `server/src/ai/text.ts` onto the gateway (needs per-function schema translation).
