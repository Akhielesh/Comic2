# Chat studio: production-vs-dev gap + this session's fixes

_Written 2026-06-15 to answer "why do I keep seeing the wrong model / no search / no
source / slow answers in the live app?"_

## TL;DR

Most of the chat-studio complaints are **already fixed in the dev branch but not deployed**.
At the time of writing, the working branch was **184 commits ahead of and 117 commits behind
`Dreamstrream-v1` (production)**. The production app at `comic2-production.up.railway.app` is
running much older code, so several things that read as bugs are really "prod is stale".

The genuinely-remaining problem was **latency on basic questions**, plus the fact that
production is answering on **free / rate-limited models with keyless web search** (no
`OPENROUTER_API_KEY` budget, no `TAVILY_API_KEY` / `BRAVE_API_KEY` / `SEARXNG_URL`). That's the
5-minute spinners, the timeouts, and the "no web results" notices — not a code bug.

## Complaint → status map

| Complaint (from the report) | Status in this branch | Evidence | Action |
| --- | --- | --- | --- |
| Switching chats shows the **previous chat's model** | Per-chat model is wired correctly: the picker is fed `activeSession.modelId`, the header beacon reads the active session, and send-time resolution reads the per-chat model. **Hardened this session** so a globally-locked model can never override a chat's own pinned model. | `AIChatPlatform.tsx` (picker `selectedModelId={activeSession.modelId}`; `resolveRequest`), new `services/chatModelResolve.ts` | Deploy. Bug was almost certainly stale prod. |
| Can't **search models** in the chat studio | Search exists in the chat picker (name/id/capability), plus provider filters, facet chips, typo-tolerant ranked search. | `components/chat/ChatModelPicker.tsx` (search input + `searchModels`), `services/modelSearch.ts` | Deploy. |
| Can't see the **source** of the chosen model | Source/provider logo + label shown on every model row and on the header model pill. **Now also on the composer chip** (this session). | `ChatModelPicker.tsx` (`sourceShortLabel`, `ProviderLogo`), new `components/chat/ChatModelChip.tsx` | Deploy. |
| No **"no API key available"** indicator | Picker greys out + labels models whose provider has no usable key ("Add a … key"). Header pill shows "No API key" / "Sources off". **Now also surfaced on the composer chip.** | `ChatModelPicker.tsx` (`keyGate`), `components/TokenAvailabilityPill.tsx`, `ChatModelChip.tsx` | Deploy. |
| No **usage-limit bar** for the chosen provider | Per-key monthly usage meter (spend vs limit, colour-coded 80/100%) in the header pill and API Configuration. **Compact usage % now on the composer chip.** | `TokenAvailabilityPill.tsx`, `components/ApiConfiguration.tsx` (`UsageMeter`), `ChatModelChip.tsx` | Deploy. |
| **Basic questions take 15s+ / 5 min / time out** | Was partly **by design** (every non-greeting led with a strong model + always-on web search) and made worse by free/rate-limited prod models. **Fixed this session** with a "fast lane". | `server/src/routes/chat.ts`, `server/src/ai/chat.ts` (`isFastLaneChat`) | Deploy + set prod keys (below). |
| Errors: _"X unavailable… answered by Y"_ | That line is **OpenRouter's own automatic fallback**, not an app error. It means the answer still succeeded via a backup model. **Reframed this session** from an alarming amber warning to a calm, muted note. | `components/chat/ChatMessageView.tsx` | Deploy. |
| Errors: _"Couldn't read <site>" / "web search returned no results"_ | Keyless web mode. Free/keyless search is unreliable. | Notice text references `SEARXNG_URL` / `TAVILY_API_KEY` / `BRAVE_API_KEY` | **Config**, not code — set a search key (below). |

## What changed in this session (code)

1. **Fast lane for basic questions** — `server/src/ai/chat.ts` adds `isFastLaneChat()`; the chat
   route (`server/src/routes/chat.ts`) routes a focused, general-knowledge question (no live
   data, no web/connector action, no attachment, no artifact build) to the **fast model with no
   reflexive web search** — the `web_search` tool stays available so the model can still ground
   itself on demand. Targets the "<1s for basic questions" goal without gutting depth on real
   research turns. Conservative by design (current-events / markets / weather / "latest" / a
   recent year / connectors / builds all stay on the strong path). Covered by tests in
   `server/src/ai/chat.attachments.test.ts`.
2. **Per-chat model hardening** — `services/chatModelResolve.ts` (`applyLockedChatModel`) makes the
   priority explicit: a one-off override > the chat's own pinned model > a global Settings lock >
   Auto. A global lock can never silently replace a model pinned on a specific chat. Covered by
   `services/chatModelResolve.test.ts`.
3. **Composer model chip** — `components/chat/ChatModelChip.tsx` shows source logo + short label,
   an explicit "no key" state, and the active key's usage % right on the chat header button.
4. **Calmer fallback UX** — the model-reroute note in `ChatMessageView.tsx` is now muted/info, not
   a red/amber alarm, because a successful auto-reroute is routine resilience.

Verified: client `npm run typecheck`, server `npm run build:server`, `npx vitest run`
(268 files / 1646 tests pass), and `npm run build`.

## What's still operational (set these in production)

These are the dominant cause of the slow/empty answers and are **environment config, not code**:

- **A funded `OPENROUTER_API_KEY`** (and/or `OPENROUTER_SMART_TEXT_MODEL` pinned to a fast paid
  model). Free models (`…:free`) queue and 429 — that's the 5-minute waits and the
  `nex-agi/nex-n2-pro:free` 5m06s answer in the report.
- **A web-search key**: `TAVILY_API_KEY` or `BRAVE_API_KEY`, or self-hosted `SEARXNG_URL`. Without
  one, web search runs keyless and returns nothing ("no results" notices).

## Recommended deploy order

1. Ship this branch's chat-studio fixes (model UX, per-chat hardening, fast lane, calmer UX).
2. Set the two production keys above.
3. Re-test the report's queries — basic questions should drop from 15s+ to ~1–2s, and the red
   "errors" that were actually successful fallbacks/keyless-search should disappear.
