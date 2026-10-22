# 06 — Cost & Context (BYOK-first: don't burn the keys)

v1 is **BYOK / personal-first** (D3): the user spends their *own* provider key, and the
platform funds nothing. So the design obsession is **spend the fewest, smartest tokens
and image calls, never repeat work, and always show the cost before committing.** This
doc is the rulebook every sprint must respect.

## 1. BYOK model (v1)
- **One first-run gate:** a "Connect your key" screen (OpenRouter primary; optional
  NVIDIA, Gemini). Stored client-side (existing `dreamstream_openrouter_key` +
  `X-OpenRouter-Key` header path) and bypasses all platform billing
  (`gateway.ts:47-51`, `billingLedger.ts:839`). Include a 30-second "how to get an
  OpenRouter key (with free models)" guide.
- **Billing UI off:** flag `VITE_BILLING_UI_ENABLED=false`; the CT credit/wallet/Stripe
  surfaces are hidden but the ledger code stays for multi-tenant later. **Do not delete.**
- **Per-key spend is tracked + shown** (reuse `recordKeyUsage`): a running "spent on this
  comic / today" number, so the owner always sees real burn.

## 2. The cost hierarchy (where money actually goes)
1. **Text (brain): ~free.** Story/script/breakdown/continuity run on free `:free` text
   models. Optimize for *correctness* (JSON), not cost. This is most of the "thinking."
2. **Image (art): the cost.** A comic is N pages × (renders + edits). **Every image call
   is the budget.** All the levers below target image calls.

## 3. The seven cost levers (apply relentlessly)

### L1 — Page-composite by default (D2)
Default render = **one image per page** (composite), not one per panel. A 6-page comic
≈ 6 renders + 1 Style Bible + ~3 cast sheets ≈ **~10 image calls** for a whole book.
Panel-assemble (more calls) is opt-in for precision. This alone is a multiple-× saving
vs. today's per-panel loop.

### L2 — Generate-once anchors
Style Bible (1) and each character reference sheet (1/asset) are generated **once** and
reused as references forever. Never re-render an anchor unless the user changes it.

### L3 — Result cache (content-hash) — *the big one*
A durable cache keyed by `hash(promptCanonical + refsHash + seed + model + size)` →
image id (T4). Before any image call, check cache; identical request = **$0, instant**.
Covers: re-opening a doc, idempotent retries, "I changed a bubble, not the art" (art
unchanged → no re-render), undo/redo. Start as a Supabase table; add KV/Redis if a
worker returns. **This is the difference between a usable BYOK tool and a money pit.**

### L4 — Scoped context (kill the "all entities" waste)
Today every panel prompt includes **all** characters/items/locations
(`generationManager.ts:213-215`) and the full untruncated script. Replace with:
- **Scene-scoped entity context** — only the cast bound to this panel/scene.
- **Per-scene script slices**, not the whole script, into breakdown calls.
- **Bounded context window** (already 2 panels) + a compact continuity summary.
- A `buildPrompt` that measures and caps approximate tokens before sending.
Lower tokens = lower text cost *and* sharper prompts (less dilution = better art).

### L5 — Draft → upscale on approve
Render pages at a **draft resolution** first (cheaper/faster); **upscale only the pages
the user keeps**. Don't pay for 4K on a page they'll re-roll. (Upscaler is a later role;
until then, render at a sensible mid-res and offer a one-click "render final" per page.)

### L6 — Seeds for cheap, deterministic retries
With `seed` on the unified path (Sprint 2/6), a re-roll with the *same* seed + a tweaked
prompt is a controlled nudge, not a fresh expensive gamble. Variations use *explicit* N
seeds only when the user asks — never auto-generate spare candidates.

### L7 — Batch + coalesce
- Request N variations in **one** provider call where supported (vs N calls).
- Keep + **persist** the idempotency cache (today it's in-memory, single-instance,
  15-min — make it durable) so a double-click or retry never double-charges.
- Debounce editor actions so a drag doesn't trigger a render; only explicit AI ops cost.

## 4. Cost preview (always-on honesty)
Before any spend, show an estimate (reuse + extend `services/costProjection.ts`):
- **Create flow:** "This book ≈ X image calls ≈ $Y on your key (Z free)." Confirm to run.
- **Editor ops:** region edit / panel re-roll / variations each show "≈ $0.0n" (or
  "cached → free") on the button. The variation tray shows total before committing.
- **Running total:** per-doc + per-day spend chip, from `recordKeyUsage`.
Estimates use the live, daily-synced pricing snapshot; settle on real `usage.cost`
(OpenRouter reports it) so the displayed number converges to truth.

## 5. Context/token rules for text stages
- **JSON validate-and-repair** on every structured call (one corrective retry) — protects
  the whole planning pipeline against model JSON variance (the OVERHAUL_PLAN risk).
- **Dedup identical text calls** by content hash (analyze/world rarely change between
  re-opens) — same result-cache idea, applied to text.
- **Summarize, don't resend.** Carry a compact rolling continuity summary (≤120 words,
  exists) instead of re-sending full history.
- **Cap prompt size** with a measured budget; trim lowest-priority context first
  (old panels → distant entities → verbose descriptions).

## 6. Known cost bugs to fix when billing returns (note now, don't lose)
- Image settles are **fire-and-forget** and the "daily reconciliation repairs failed
  settles" claim is false (`dailyBillingReconciliation.ts` only does Stripe↔ledger) →
  **reserved credits leak**. Moot under BYOK v1; **must fix before re-enabling credits**.
- Pre-flight token estimate is a crude word-count heuristic; fine for a preview, but
  don't treat it as billing truth — settle on provider-reported cost.
- Idempotency + catalog caches are in-memory per instance → weaken on multi-instance.

## 7. Cost acceptance for v1
- A 6–12 page book from idea → reader costs a **previewed, confirmed** amount on the
  owner's key, dominated by ~1 image/page + one-time anchors.
- Re-opening a finished doc, undo/redo, and bubble/layout edits cost **$0** (cache /
  no model call).
- No editor interaction silently spends; every AI op states its cost (or "cached") first.
