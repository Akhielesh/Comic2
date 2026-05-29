# Universal Assistant

A free, safe, in-app help chatbot for DreamStream.

## Model

- Runs on a **free OpenRouter model** through the gateway — `OPENROUTER_FREE_TEXT_MODEL`
  (default `google/gemini-2.0-flash-exp:free`). Because it's a `:free` model, it costs
  nothing whether it uses the user's BYOK key or the platform `OPENROUTER_API_KEY`.
- Change the model via the `OPENROUTER_FREE_TEXT_MODEL` env var (keep it a `:free` id).
- Implementation: `server/src/ai/assistant.ts` → `getProvider('openrouter').generateText`.

## Guardrails (why it's safe + accurate)

- **Off-topic blocking:** `routes/assistant.ts` runs `isPlatformScopedMessage`; non-platform
  questions get a canned `buildOffTopicResponse()` and never hit the model.
- **Context sanitization:** `sanitizeAssistantHistory` / `sanitizeAssistantContext` allowlist
  what the model sees; account summary is reduced to safe fields.
- **System prompt** (`ai/assistant.ts`): platform-only scope, never reveal/request secrets,
  no private data, and an explicit **anti-hallucination rule** — if the answer isn't in the
  platform knowledge or safe context, say so instead of guessing (no fabricated
  features/prices/limits/steps).
- **Policy module:** `ai/assistantPolicy.ts` (+ `assistantPolicy.test.ts`, 9 tests) defines the
  scope and off-topic handling.

## Key resolution

`req.apiKeys.openRouterKey` = the user's `X-OpenRouter-Key` header **or** the platform
`OPENROUTER_API_KEY`. If neither is set, the route returns a clear "add an OpenRouter key"
message. Billing is metered as provider `openrouter`; on a `:free` model the cost is ~$0.
