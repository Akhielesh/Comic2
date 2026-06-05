# 11 — Tools, MCP & Sourcing: analysis & redesign

Honest analysis of the tool layer, MCP integration, and data sourcing — and whether
it's "enough" for our models and external agents to access.

## Current design

- **Tool registry** (`server/src/ai/tools/registry.ts` + `toolCatalog.ts`): 45+ tools in
  14 categories (search, news, weather, finance, places, knowledge, words, geo, space,
  food, entertainment, dev, dataviz, codegen, agents). Uniform `ChatTool` interface
  (`tools/types.ts`) so models, swarm agents, and MCP tools all flow through one loop.
- **Smart routing:** `selectRelevantTools` hands the model ≤20 of the relevant tools per
  turn (keyword score + always-on core + web_search backstop). Avoids spec overload.
- **Auth posture:** mostly **keyless/free** (`auth: none|optional|required`); optional env
  keys raise limits (Foursquare, GitHub, NASA, SearXNG/Tavily/Brave).
- **Sourcing chains:** e.g. web_search = SearXNG → DuckDuckGo → Bing → Wikipedia (free,
  keyless) with honest empty-vs-error signaling; finance = Yahoo → Stooq; places = OSM →
  Foursquare; news = Google News RSS; etc.
- **MCP client** (`server/src/ai/tools/mcpClient.ts`): JSON-RPC over Streamable HTTP,
  SSRF-guarded (https-only, blocks private hosts), namespaced tool ids, 5-min tools cache,
  best-effort (a broken server is skipped). Configs stored **client-side** in localStorage
  (`services/mcpServers.ts`), sent per request (≤6 servers).
- **Transparency:** `components/chat/ToolsDashboard.tsx` — full catalog, auth/limit badges,
  per-tool local usage analytics, connected MCP servers.
- **Source governance** (`services/sourceGovernance.ts`): user enables/disables AI
  *providers* (OpenRouter/NVIDIA/Gemini/Pixazo); enforced client + server (`X-Allowed-Sources`).

## Honest assessment

| Strength | | Weakness / gap |
|---|---|---|
| Broad, free-first tool coverage (45+) | | **Tools are OpenRouter-only** — NVIDIA & others can't tool-call → no tools on those models |
| One uniform interface for all tools | | Free scraper sourcing (search) can be **flaky**; no premium keys configured (env unset) |
| Smart routing avoids overload | | Routing is **keyword-based** — misses intent the words don't name |
| Real MCP client (HTTP JSON-RPC) | | MCP is **client-stored** (not synced across devices, not shared, ≤6, no OAuth, no full SSE streaming) |
| SSRF-guarded, namespaced, cached | | **No curated MCP catalog/marketplace** — users must hand-enter URLs |
| Per-tool analytics + dashboard | | Almost all tools are **read-only** — few action/write tools |
| Provider governance | | **We don't expose our own tools AS an MCP server** for external agents to use |

## "Is it enough for our models and other agents to access?"
- **For grounding/read access: yes, broadly.** The uniform registry means our chat models,
  the swarm's agents, and user MCP tools all reach the same capability surface.
- **Three real limits:**
  1. **Provider coverage** — only OpenRouter models actually get tools today; NVIDIA/Gemini
     chats are tool-blind. (The Markdown→Studio fallback patches *code*, not other tools.)
  2. **MCP is shallow** — fine for a power user wiring one server, not a managed, synced,
     OAuth'd, browsable integration story.
  3. **No outbound exposure** — other AI agents/products can't consume *our* tools because
     we don't publish an MCP endpoint.

## Redesign plan (→ PHASE-10)

### A. Tool access for all models (not just OpenRouter)
- Add a **JSON tool-protocol fallback** for non-tool-calling models: inject tool specs +
  a strict "emit a tool call as JSON" instruction, parse it, run the tool, feed results
  back. Lets NVIDIA/Gemini/free models use tools too. (Mirrors the Markdown→Studio idea
  but generalized to all tools.)

### B. Make MCP a real integration story
- **Server-side MCP registry:** persist user MCP servers in Supabase (synced across
  devices), not just localStorage; raise the ≤6 cap sensibly.
- **OAuth + full SSE streaming** in `mcpClient` (currently single-event SSE + header auth).
- **Curated MCP marketplace:** a vetted catalog of popular MCP servers (one-click connect)
  surfaced in `ToolsDashboard`.
- **Health checks:** ping connected servers; show status; auto-disable persistently broken ones.

### C. Expose DreamStream's tools AS an MCP server (outbound)
- Publish our tool registry as an MCP endpoint so **external agents (Claude, Cursor, other
  apps)** can call our weather/finance/news/etc. tools. Turns the platform into a provider,
  not just a consumer. (Auth + rate-limit via the existing control plane.)

### D. Sourcing reliability & depth
- Wire free/cheap keys where they materially help (Tavily/Brave for search, Foursquare for
  places) behind env — documented in `ToolsDashboard` as "set X to improve".
- Add **action/write tools** (guarded, opt-in): e.g. send-email, create-calendar-event,
  webhook — with explicit user confirmation (ties to guardrails).
- Per-tool **server-side** health/latency metrics (today analytics are local-only).

### E. Discoverability & routing
- Add a light **semantic/embedding router** option for tool selection (beyond keywords)
  so intent without exact words still routes correctly.

## Acceptance criteria (PHASE-10 done)
- Tools work on at least one non-OpenRouter provider via the JSON fallback (tested).
- MCP servers persist server-side, support OAuth, and a curated catalog offers one-click connect.
- DreamStream exposes a working, authenticated MCP endpoint other agents can call.
- Tool health is observable server-side; sourcing docs list the keys that raise reliability.
- All new tools/paths are metered + governed + tested.
