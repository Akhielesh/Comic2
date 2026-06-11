# Live widgets (in-place data refresh)

Live-data widgets (weather, news, quotes, places, maps, videos) can re-fetch their own
data **without a model round-trip**: the server remembers which tool call produced an
artifact, and the client can re-execute exactly that call. This doc covers the origin
contract, the server allowlist + endpoint, the client flow, the NewsDigest reference
implementation, and how to make another widget refreshable.

## Origin stamping

Every `ChatArtifact` may carry the tool call that produced it:

```ts
// apiTypes.ts:813-821
export type ChatArtifact = {
  type: string;
  data: unknown;
  origin?: { tool: string; args: Record<string, unknown> };
};
```

The server's agentic loop stamps `origin` when collecting tool outputs:

- native function-calling loop: `server/src/ai/chat.ts:630`
  (`{ ...a, origin: { tool: r.call.name, args: r.args ?? {} } }`)
- JSON tool-protocol loop (non-OpenRouter providers): `server/src/ai/chat.ts:545`

The artifact (origin included) is persisted with the message, so refresh keeps working
on old conversations, not just the live turn.

## The allowlist: `REFRESHABLE_TOOLS`

Only tools whose artifacts are **pure live-data snapshots** — keyless, side-effect-free,
safe to re-run on demand — may be refreshed. The list is declared once in
`apiTypes.ts` (search `REFRESHABLE_TOOLS`) and shared by client and server:

```ts
export const REFRESHABLE_TOOLS = [
  'get_weather', 'get_news', 'get_stock', 'find_places',
  'crypto_price', 'exchange_rate', 'show_map', 'video_search',
  // live widget-platform tools
  'get_ticker_tape', 'get_market_sentiment', 'get_yield_curve',
  'build_portfolio', 'convert_currency',
  // key-optional live tools (read-only; live when the env key is set,
  // model-supplied otherwise — see docs/features/data-connectors.md)
  'get_national_debt', 'show_macro_tiles', 'get_econ_calendar',
  'get_earnings_calendar', 'get_flight_status',
  // keyless market intelligence (render through data_table)
  'get_predictions', 'get_funding_rates', 'get_stablecoins', 'get_cot_positioning'
] as const;
```

The original rule was "keyless only"; it is now **keyless or key-optional,
read-only, idempotent** — a key-optional tool refreshed without its key simply
re-returns the model-supplied snapshot, which is safe.

(Historical note: the list once said `get_crypto_price` / `get_forex_pair`, which never
matched the real tool names `crypto_price` / `exchange_rate` — crypto cards silently had
no refresh button. Fixed when the widget-platform tools landed.)

The `create_monitor` tool (`/loop` skill) builds on this allowlist: it wraps ONE
refreshable call into a `live_monitor` artifact, and the card re-runs the call through
this same endpoint on an interval (30s–1h, clamped server-side) while it's on screen —
see `components/chat/artifacts/LiveMonitorCard.tsx`.

It is enforced server-side (the endpoint 400s for anything else) and mirrored
client-side to decide when to show the refresh button
(`components/chat/artifacts/ChatArtifacts.tsx:106`).

Deliberately excluded: composition tools (`create_learning_path`, `plan_trip`,
`render_chart`, …) whose artifacts are model-composed, and anything with cost or
side effects.

## Server endpoint: `POST /api/chat/tool-refresh`

Handler: `server/src/routes/chat.ts:751-788`. Mounted under
`app.use('/api/chat', textRateLimit, chatRouter)` (`server/src/index.ts:183`), which
sits **behind the global `requireAuth`** (`server/src/index.ts:175`) — so a valid app
session is required, plus the text-tier rate limit. No billing reservation and no
model call are involved (`server/src/routes/chat.ts:747-749`).

**Request**

```jsonc
{
  "tool": "get_news",                  // must be in REFRESHABLE_TOOLS
  "args": { "topic": "business" },     // the origin args (possibly patched)
  "clientContext": { /* optional: timezone, locale, units, location */ }
}
```

Behavior (`routes/chat.ts:752-780`):
- Non-allowlisted tool → `400 { error: { message: 'This widget cannot be refreshed.' } }`.
- `clientContext` is sanitized; if it has no location, the server best-effort
  geo-resolves the client IP so "near me" tools keep working (`:761-770`).
- The single tool is resolved via `resolveTools([tool], ctx)` with that context and
  executed with a **20-second timeout** (`AbortSignal.timeout(20_000)`, `:779`).

**Response (200)**

```jsonc
{
  "artifacts": [ { "type": "news_results", "data": { ... }, "origin": { "tool": "get_news", "args": { ... } } } ],
  "asOf": "2026-06-10T12:34:56.000Z"   // server timestamp of this refresh
}
```

Fresh artifacts are re-stamped with the (patched) origin (`:782`), so subsequent
refreshes reuse the *new* args — a news widget switched to "business" stays on
business.

**Errors**: tool unavailable → `400 { error: { message: 'Tool unavailable.' } }`;
execution failure/timeout → `502 { error: { message: <reason> } }` (`:785-787`).

## Client flow

1. **API helper** — `refreshArtifact(tool, args)` in `services/chatApi.ts:69-79`
   gathers fresh `clientContext` and POSTs to `/api/chat/tool-refresh`.
2. **State** — `LiveArtifact` (`components/chat/artifacts/ChatArtifacts.tsx:101-144`)
   holds the freshest version of one artifact:
   - `canRefresh` = artifact has an `origin` *and* `origin.tool` is allowlisted (`:106`);
   - `refresh(argsPatch?)` calls `refreshArtifact(origin.tool, { ...origin.args, ...argsPatch })`,
     picks the returned artifact matching the current `type` (falling back to the
     first), and swaps it into state with the new `asOf` (`:108-127`);
   - failures keep showing the last good snapshot (`:120-121`).
3. **Context** — those four values are provided via `LiveDataContext`
   (`components/chat/artifacts/kit/liveData.ts:12-31`); any card reads them with
   `useLiveData()`. Outside a chat message (gallery, panels) a no-op context applies,
   so cards never special-case.
4. **Frame button** — `WidgetFrame` renders a refresh button (spinning `RefreshCw`,
   tooltip shows the `asOf` time) whenever `live.canRefresh` is true
   (`components/chat/artifacts/WidgetFrame.tsx:137-147`). Cards get a refresh control
   for free; consuming `useLiveData()` directly is only needed for richer UX.

## Reference implementation: NewsDigest topic chips

`components/chat/artifacts/NewsDigest.tsx` is the pattern for **arg-patching**
refresh — re-querying the producing call with different arguments:

- A static chip row mirrors the server `get_news` topic enum
  (`NewsDigest.tsx:91-101`).
- The row renders only when `live.canRefresh` (`:167`), i.e. only inside a chat
  message with a refreshable origin — the same component in the gallery shows no chips.
- Clicking a chip runs `live.refresh({ topic: t.id, query: undefined })` (`:175`):
  patch the topic, clear the free-text query so the feed becomes topical.
- The active chip derives from the *data* (`data.topic` when there's no `query`,
  `:112`), so it stays correct after the swap; the card body gets a pulse/dim shimmer
  while `live.refreshing` (`:191`); "Updated 2m ago" renders from `live.asOf` (`:110-116`).

## How to make another widget refreshable

1. **Check the producing tool is safe**: keyless, read-only, no cost, idempotent —
   re-running it on a button press must be harmless.
2. **Add it to `REFRESHABLE_TOOLS`** in `apiTypes.ts:828`. That single edit lights up
   both the server gate (`routes/chat.ts:750`) and the client button
   (`ChatArtifacts.tsx:106`) — the refresh button appears on every widget that tool
   produces, with zero card changes.
3. **(Optional) consume `useLiveData()`** in the card for bespoke controls:
   `live.refresh()` for same-args refresh, `live.refresh({ ...patch })` to re-query
   with different arguments (NewsDigest pattern), `live.asOf` for an "updated" stamp,
   `live.refreshing` for in-flight styling.

## Gotchas

- `refresh()` replaces the artifact **in component state only** — the stored chat
  message keeps the original snapshot. Reloading the conversation shows the original
  data until the user refreshes again. This is intentional (history stays honest).
- The endpoint executes exactly **one** tool per request; a multi-artifact tool result
  is filtered to the matching `type` client-side (`ChatArtifacts.tsx:115`).
- Args patches persist across subsequent refreshes only because the server re-stamps
  `origin` with the patched args (`routes/chat.ts:782`) and `LiveArtifact` prefers
  `current.origin` over the original prop (`ChatArtifacts.tsx:105`).
- Adding a tool to the allowlist that needs an API key or has per-call cost would let
  any signed-in user hammer it from a button — keep the list to keyless data tools.
