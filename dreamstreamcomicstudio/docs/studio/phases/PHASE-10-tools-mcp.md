# Phase 10 — Tools, MCP & sourcing upgrade (parallel workstream)

**Status:** 🟢 **backend shipped** (JSON tool fallback [flag], server-side MCP registry, outbound MCP endpoint; OAuth/streaming MCP + dashboards deferred) · **Parallel to** the Studio build · **Effort:** 1–2 weeks · **Spec:** [11-TOOLS-MCP-SOURCING.md](../11-TOOLS-MCP-SOURCING.md)

> **Shipped (2026-06-05):** `ai/tools/jsonToolProtocol.ts` lets non-OpenRouter models call
> our tools via a JSON convention; wired into `runChat` behind `JSON_TOOL_PROTOCOL_ENABLED`
> (off by default until validated) `+ test`. Server-side MCP registry:
> `server/sql/mcp_servers.sql` (+ RLS + auto-disable), `services/mcpRegistry.ts`, curated
> marketplace `ai/tools/mcpCatalog.ts`, CRUD via `routes/mcp.ts`; saved servers sync + merge
> into chat (cap 6→10). **Outbound MCP server** (`mcpOutboundRouter`, `/api/connect/mcp`,
> Bearer `MCP_OUTBOUND_TOKEN`) publishes our read-only tools as an authenticated MCP
> endpoint. **Deferred:** OAuth + full streaming-SSE MCP client, action/write tools, the
> Tools dashboard UI, and Tavily/Brave sourcing keys.

## Goal
Make the capability surface reachable by every model, make MCP a real managed integration,
and let external agents consume our tools.

## Tasks
1. **Tools for non-OpenRouter models:** a JSON tool-protocol fallback in `runChat` —
   inject specs + "emit tool calls as JSON" for models without native function-calling;
   parse → run → feed back. Unlocks tools on NVIDIA/Gemini/free models.
2. **Server-side MCP registry:** persist user MCP servers in Supabase (`mcp_servers`
   table, RLS), synced across devices; migrate from localStorage; raise the ≤6 cap.
3. **MCP client upgrades** (`mcpClient.ts`): OAuth flow + full SSE streaming (currently
   single-event SSE + header auth); per-server health checks + auto-disable on repeated failure.
4. **Curated MCP marketplace:** a vetted catalog (name, url, scopes, one-click connect)
   surfaced in `ToolsDashboard`.
5. **Outbound MCP server:** publish our tool registry as an authenticated MCP endpoint so
   external agents (Claude/Cursor/etc.) can call our tools; rate-limited via the control plane.
6. **Sourcing reliability:** document + wire optional free keys (Tavily/Brave/Foursquare)
   that raise reliability; surface "set X to improve" in `ToolsDashboard`.
7. **Action/write tools (guarded):** opt-in tools that *do* things (email/webhook/calendar)
   with explicit user confirmation (ties to guardrails Phase 11).
8. **Server-side tool health/latency metrics** (today analytics are local-only).
9. **(Optional) semantic tool routing** beyond keywords.

## Acceptance criteria
- A non-OpenRouter model successfully calls a tool via the JSON fallback (tested).
- MCP servers persist server-side, support OAuth + streaming; a curated catalog connects in one click.
- DreamStream exposes a working authenticated MCP endpoint an external agent can call.
- Tool health observable server-side; sourcing keys documented; new paths metered + tested.

## Files
- new: `server/src/ai/tools/jsonToolProtocol.ts`, `server/sql/mcp_servers.sql`,
  `server/src/routes/mcp.ts` (outbound MCP), marketplace UI
- edit: `mcpClient.ts`, `services/mcpServers.ts` (→ server-backed), `routes/chat.ts`,
  `ToolsDashboard.tsx`, `toolCatalog.ts`
