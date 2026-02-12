# API Keys and Token Billing

DreamStream uses **Comic Tokens (CT)** for platform usage metering.
- `1 CT = $0.0001 USD`
- `10,000 CT = $1.00`

Each generation action shows:
1. **Estimated CT** before execution.
2. **Actual CT + cost** after completion.

If an action exceeds your available limit, DreamStream will prompt you to:
- Upgrade plan
- Add credits
- Wait for next reset window

## 1. Google Gemini (Text + Image)
Used for: script analysis, panel planning, assistant tasks, and Gemini image generation.

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey).
2. Click **Create API Key**.
3. Copy the key string (starts with `AIza...`).
4. Paste it into DreamStream Settings -> **Gemini API Key**.

## 2. Pixazo / Flux (Image Generation)
Used for: Flux-based panel generation.

1. Go to [Pixazo.ai](https://pixazo.ai) (or your Flux provider).
2. Sign in.
3. Open API settings/dashboard.
4. Generate a new API key.
5. Paste it into DreamStream Settings -> **Pixazo/Flux Key**.

## Billing and Credits
- Free + paid plans include monthly CT pools and daily guardrails.
- Users can buy direct CT credit packs.
- To continue usage beyond available credits, a payment method must be on file.
- Payment methods are stored as Stripe tokenized references.

## BYOK Policy
If you bring your own provider key:
- Usage is still tracked for reporting.
- Platform CT is not deducted for that operation.

## Security
- Keys are transmitted for provider calls only.
- DreamStream does not expose your raw keys in assistant outputs.
