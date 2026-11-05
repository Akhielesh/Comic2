# MCP support (directory, registry & outbound endpoint)

DreamStream speaks MCP (Model Context Protocol) in both directions: users plug
external MCP servers into the chat agent (per-user registry + curated marketplace),
and DreamStream publishes its own tools as an authenticated MCP endpoint for external
agents (Claude/Cursor/…).

## Per-user server registry (server side)

`server/src/services/mcpRegistry.ts` persists a user's custom MCP servers in Supabase
(`mcp_servers` table) so they sync across devices instead of living in per-device
localStorage (`mcpRegistry.ts:1-4`).

- `listMcpServers(userId)` — newest-first, max 50 (`:33-42`). Rows carry
  `enabled`, `health: ok|error|unknown`, `lastCheckedAt`, `failCount` (`:14-19`).
- `saveMcpServer(userId, {name,url,headers,enabled})` — **SSRF-guards the URL on
  write** via `isSafeMcpUrl` (`:56-58`), upserts on `(user_id, url)` (`:67-84`).
- `enabledMcpConfigs(userId)` — enabled + still-safe servers as plain configs for the
  chat loop (`:45-50`).
- `checkMcpServer` — health check by listing the server's tools; after
  `AUTO_DISABLE_AFTER = 3` consecutive failures the server is auto-disabled so a dead
  endpoint stops adding latency to every chat (`:10-12`, `:94-125`). Re-enabling is a
  user action.

### SSRF guarding (`server/src/ai/tools/mcpClient.ts`)

User-supplied URLs go through four layers:

1. **String guard** — `isSafeMcpUrl`: https only; hostname must not match
   localhost/loopback/RFC1918/link-local/ULA patterns or `.local`. Only operator-configured
   servers may pass `allowInternal` (self-hosted sidecars): `buildMcpTools` grants it when the
   server carries `trusted: true` **and** its URL is one `envDesignMcpServers()` lists
   (`mayUseInternalHosts`). The flag alone never counts — it travels on objects a request body
   can shape (SEC-DS web-surface-1, 2026-11-05). Such a server is then sent exactly as the
   operator configured it: the env URL and its env `*_HEADERS`, never headers a request attached
   to a copy of that URL.
2. **DNS resolution guard** — `assertResolvedHostSafe`: resolves the host and rejects if
   **any** resolved IP is private/loopback/link-local/CGNAT/metadata/ULA (`isPrivateAddress`
   in `safeNet.ts`, which also decodes IPv4-mapped, NAT64 and 6to4 forms). Re-checked on
   every `tools/call`, not just at save.
3. **Pinned connection** — every untrusted request (MCP JSON-RPC and `fetchPublicUrl`)
   connects through `pinnedFetch` (`safeNet.ts`): node:http(s) with a `lookup` hook that
   resolves once, refuses any private answer and hands the socket only the addresses it
   checked, so a DNS-rebinding answer between layer 2 and the connect is refused too
   (SEC-DS N8). IP-literal hosts are checked up front (no lookup runs for them).
4. **No redirects** — MCP requests use `redirect: 'manual'` and treat a 3xx as an error;
   `fetchPublicUrl` follows at most 3 redirects and re-runs layers 1-3 on every hop.

Every JSON-RPC response is read with a byte cap (`MCP_MAX_RESPONSE_BYTES`, 8 MB after
decompression; an error body 16 KB, `cappedBody.ts`): a larger body — or a small gzip/brotli
body that inflates past it — fails the call as "too large" and its stream is cancelled.

`assertSafePublicUrl` packages 1+2, and `fetchPublicUrl` 1-4, for any other outbound fetch
of a user/model-supplied URL (reader mode, link unfurl, deep-research reads — all through
`fetchTextCapped({ publicOnly: true })` in `http.ts`).

### Routes — `/api/mcp` (`server/src/routes/mcp.ts`)

Mounted at `app.use('/api/mcp', systemRateLimit, mcpRouter)`
(`server/src/index.ts:192`), **behind the global `requireAuth`** (`index.ts:175`).

| Route | Behavior |
|---|---|
| `GET /api/mcp` | The user's saved servers (redacted) + the curated catalog (`mcp.ts:38-45`). |
| `POST /api/mcp` | Add/update a server; SSRF rejection → `400 MCP_URL_REJECTED` (`:48-64`). |
| `POST /api/mcp/:id/check` | Health-check (lists tools), returns `{health, toolCount, enabled}` (`:67-75`). |
| `DELETE /api/mcp/:id` | Remove (`:78-86`). |

Saved auth headers are **never echoed back** — responses expose only `hasAuth`
(`mcp.ts:24-35`).

## Client storage (legacy/local path)

`services/mcpServers.ts` keeps a localStorage registry
(key `dreamstream_mcp_servers`, `mcpServers.ts:8`) with add/update/remove and a
`dreamstream:mcp-servers-changed` window event for reactive UIs (`:9`, `:70-75`).
Auth is stored as an `Authorization` header on the config (`:40-51`). Enabled local
servers travel **in the chat request body**; the server-side registry (above) is the
synced successor — both sources are merged per request.

## How enabled servers reach the agentic loop

`prepareChat` in `server/src/routes/chat.ts:455-480` (OpenRouter provider only):

1. Collect request-body servers (localStorage clients) + the user's server-side
   registry (`enabledMcpConfigs`), merge + dedupe by URL, cap at **10 servers**
   (`:461-478`). When the user is already using tools, curated always-on reference
   MCPs (Context7, DeepWiki) and operator self-hosted design MCPs join the set —
   operator servers are `trusted` (may be http/internal), user servers stay strict;
   `buildMcpTools` re-checks the operator list itself, so a `trusted` flag on a
   request-body server is ignored.
2. `buildMcpTools(servers)` (`mcpClient.ts:301-333`) discovers all servers **in
   parallel** (`Promise.allSettled` — a broken server is skipped, never fails the
   chat), doing the MCP handshake (`initialize` → `notifications/initialized`,
   protocol `2025-06-18`, `:186-206`) and `tools/list` (cached 5 min per
   url+headers — keyed on headers so two users with different auth never share a
   tool list, `:208-234`).
3. Each remote tool is wrapped as a regular `ChatTool` named
   `mcp_<serverId>_<toolName>` (collision-proof namespacing, `:290`), description
   prefixed `[Server Name]`, max **40 tools per server** (`:297-299`). Execution
   proxies `tools/call` and maps the full MCP content array — text, images,
   resource links, `structuredContent` as fenced JSON (`:236-287`). Errors become a
   tool result + capability notice, not an exception.
4. The wrapped tools are appended to the turn's tool list
   (`routes/chat.ts:483`) and flow through the same agentic loop as built-ins
   (`server/src/ai/chat.ts:580-647`). Per-call timeout: 15 s (`mcpClient.ts:15`).

## Curated catalog — all 13 entries

Source of truth: `server/src/ai/tools/mcpCatalog.ts:22-140` (static, no network; all
https, keyless — `requiresAuth: false` across the board). Served to the client by
`GET /api/mcp`; mirrored in the Tools dashboard UI list
(`components/chat/ToolsDashboard.tsx:30-44` — keep the two in sync, `:18-19`).

| Id | Name | Category | URL | What it does |
|---|---|---|---|---|
| `deepwiki` | DeepWiki | docs | `https://mcp.deepwiki.com/mcp` | Q&A over any public GitHub repo — docs, architecture, code. |
| `context7` | Context7 | docs | `https://mcp.context7.com/mcp` | Up-to-date docs + code examples for thousands of libraries. |
| `huggingface` | Hugging Face | data | `https://huggingface.co/mcp` | Search models, datasets and Spaces on the HF Hub. |
| `microsoft-learn` | Microsoft Learn | docs | `https://learn.microsoft.com/api/mcp` | Q&A over official Microsoft/Azure documentation. |
| `cloudflare-docs` | Cloudflare Docs | docs | `https://docs.mcp.cloudflare.com/sse` | Cloudflare platform docs (Workers, R2, DNS, …). |
| `astro-docs` | Astro Docs | docs | `https://mcp.docs.astro.build/mcp` | Official Astro framework documentation. |
| `aws-knowledge` | AWS Knowledge | docs | `https://knowledge-mcp.global.api.aws` | AWS docs, API references, architectural guidance. |
| `gitmcp` | GitMCP | dev | `https://gitmcp.io/docs` | Explore any public GitHub repo's docs and code. |
| `semgrep` | Semgrep | dev | `https://mcp.semgrep.ai/sse` | Static analysis — scan submitted code for bugs/security issues. |
| `manifold-markets` | Manifold Markets | data | `https://api.manifold.markets/v0/mcp` | Prediction-market search + live forecast probabilities. |
| `livescore` | LiveScore | data | `https://livescoremcp.com/sse` | Live sports scores, fixtures, league standings. |
| `ferryhopper` | Ferryhopper | travel | `https://mcp.ferryhopper.com/mcp` | Ferry routes, schedules and booking information. |
| `subwayinfo-nyc` | SubwayInfo NYC | travel | `https://subwayinfo.nyc/mcp` | NYC subway/transit status — lines, delays, alerts. |

## ToolsDashboard marketplace UI

`components/chat/ToolsDashboard.tsx` (Settings → Tools) shows the built-in tool
catalog with local usage analytics, then the **MCP marketplace** card
(`:326-370`): entries grouped Docs & reference / Developer / Data / Travel & transit
(`:45-51`), each with an MCP badge, KEYLESS badge, blurb and URL. **Connect** calls
`addMcpServer({ name, url })` from `services/mcpServers.ts` (`:354`) — one click adds
it to the local store, which already flows into the agent's tool loop; the button
flips to "Connected" when a saved server matches the URL (`:339`). A "Custom MCP
servers" section below lists user-added endpoints (`:372-379`).

## Vetting & adding a new catalog entry

1. **Vet**: https-only public endpoint (the registry SSRF guard re-checks on save);
   prefer keyless read-only servers; confirm it speaks MCP Streamable HTTP
   (JSON-RPC POST, JSON or single-event SSE responses — the client doesn't do
   full streaming SSE or OAuth yet, `mcpClient.ts:7-9`); check its `tools/list` is
   sane (≤40 tools survive the cap) and that its data handling is acceptable
   (whatever the model sends as tool args goes to that third party).
2. Add the entry to `MCP_CATALOG` in `server/src/ai/tools/mcpCatalog.ts` with honest
   `scopes` (shown to the user before connecting) and `requiresAuth`.
3. Mirror it in `MCP_MARKETPLACE` in `components/chat/ToolsDashboard.tsx:30` (same
   id/url; the two lists are kept in sync by convention, `:18-19`). New categories
   need `MCP_CATEGORY_ORDER`/`MCP_CATEGORY_LABELS` updates (`:45-51`).
4. Server-side `category` currently allows
   `search | dev | productivity | data | docs | travel` (`mcpCatalog.ts:18`).

## Outbound endpoint — `POST /api/connect/mcp`

DreamStream's own tools published **as** an MCP server
(`server/src/routes/mcp.ts:88-170`), so external agents can call the registry over
JSON-RPC. Mounted at `app.use('/api/connect', systemRateLimit, mcpOutboundRouter)`
**before** the global `requireAuth` (`server/src/index.ts:169-172`) because it uses
its own auth: a static bearer token (`MCP_OUTBOUND_TOKEN` env), checked in constant
time (`crypto.timingSafeEqual`, `mcp.ts:106-112`). Unset token → `503
MCP_OUTBOUND_DISABLED`; bad token → `401 MCP_UNAUTHORIZED` (`:118-124`).

Published tools are the **read-only, side-effect-free subset only**
(`OUTBOUND_TOOL_NAMES`, `mcp.ts:95-104`): `web_search`, `get_news`, `get_weather`,
`get_stock`, `find_places`, `show_map`, `image_search`, `video_search` — never
the swarm or the `render_*` tools (`mcp.ts:92-94`).

Supported JSON-RPC methods (`:129-169`): `initialize` (protocol `2025-06-18`),
`notifications/*` (→ `202` with no body, as the Streamable HTTP spec requires —
strict clients like Claude/Cursor break otherwise, `:138-142`), `ping`,
`tools/list` (built-in specs converted via `toToolSpec`), and `tools/call`
(result as `{ content: [{type:'text',…}], isError }`). Anything else → `-32601`.

## Gotchas

- MCP tools are wired **only on the OpenRouter provider** (`routes/chat.ts:460`) —
  other providers' JSON tool protocol doesn't carry them.
- Two registries coexist: localStorage (`services/mcpServers.ts`, what the
  marketplace Connect button writes) and the server-side synced one (`/api/mcp`).
  Both are merged per request; dedupe is by URL (`routes/chat.ts:468-478`).
- The 5-minute tools/list cache (`mcpClient.ts:16`) means a server's new tools can
  take up to 5 minutes to appear mid-session.
- Artifacts/citations don't flow back from MCP tools — only text + images (+
  structured JSON as text). Rich widgets are built-ins only.
- Auto-disable after 3 failed health checks applies to the *server-side* registry
  only (`mcpRegistry.ts:10-12`); localStorage servers are skipped per-turn on failure
  but never disabled.
