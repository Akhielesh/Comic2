# Code Studio × LibreChat — product plan, sprints & task breakdown

> **Why this doc.** We are leveling Code Studio up to a full, hostable, agentic app-builder
> product, using [LibreChat](https://github.com/danny-avila/LibreChat) as the reference bar
> for premium chat/agent features — and customizing those patterns to our stack
> (React 19 + Vite client, Express/Railway control plane, Supabase, OpenRouter BYOK,
> Cloudflare Studio Worker). This is the running plan; live status lives in
> [`00-STATUS.md`](./00-STATUS.md), and it sequences feature-by-feature so each loop
> iteration ships one shippable slice.

## Direction (decided with the owner, 2026-06-06)

**Enhance our own stack** (React 19 + Express + Supabase + OpenRouter) to LibreChat's feature/UX
bar — do **not** fork LibreChat (a MongoDB/Node monorepo; a literal fork would regress our working
auth/billing/image pipeline). Use LibreChat as the reference, build the capabilities natively.
**Top priority from the owner: polyglot — the studio must generate, understand and support as many
coding languages as possible, not just web apps.** (S3 below delivers the first cut.)

## North-star experience

A user describes an app in plain language and **watches the AI build it synchronously** —
a live, collapsible activity feed ("planning → writing `/App.tsx` → installing deps →
running → fixing"), a code ⇄ preview toggle to maximize real estate, the AI **auto-wiring
the services it needs** (Supabase/DB/storage, GitHub, deploy targets) against the user's
own connected accounts, all hostable by us.

## What LibreChat does well (the bar) → how we map it

| LibreChat capability | How they do it | Our home / plan |
|---|---|---|
| **Agents** (instructions + tools + files + model preset, reusable) | `api/server/services/Endpoints/agents`, agent builder UI | `server/src/ai/agents/*` + `custom_agents` table + `/api/agents`. Add a builder UI + studio "build agent". |
| **MCP servers** (connect external tools) | `librechat.yaml` `mcpServers`, SSE/stdio/streamable transports, per-user OAuth | `server/src/routes/mcp.ts` + `server/sql/mcp_servers.sql` + marketplace. Add OAuth + streamable transport + per-user creds. |
| **Code interpreter / live run** | Code Interpreter API (sandboxed exec) | Cloudflare **Studio Worker** (`studio-worker/`) + agentic `/api/studio/build`. |
| **Artifacts** (React/HTML/Mermaid live) | client artifact renderer + sandbox | `components/chat/artifacts/*` + Code Studio (Sandpack/WebContainer/Worker). |
| **Streaming everything** (tokens, tool steps) | SSE end-to-end | `runChat({onDelta})` + SSE routes. **Generation must stream too (Sprint 1).** |
| **RAG / file search** | RAG API (vector store) over uploads | _planned_ — Supabase `pgvector` + a `files` ingest. |
| **Presets & prompt library** | saved presets, prompt templates w/ variables | _planned_ — `studio_templates` + prompt library. |
| **Memory** | persistent user memory injected into context | _planned_ — `user_memory` table + recall. |
| **Multi-model + balance/usage** | endpoints config, token balance | `autoRouter.ts` + billing/usage ledger (we already have this — an edge). |
| **Conversation forking / edit / regenerate** | message tree | partial in chat; bring to studio thread. |
| **Sharing** | shared links | `routes/sharing.ts` + studio share-link. |

## Sprints (each = one shippable loop iteration)

> Convention: **S<n>** ships to a draft PR, updates `00-STATUS.md` + `CHANGELOG.md`,
> typecheck + tests + build green.

- **S1 — Live agentic activity stream (generation).** ✅ **shipped.**
  Stream `/api/studio/generate` token-by-token; incrementally parse `files[]` so the UI shows
  each file appear live ("✎ writing → ✓ written"), grouped + collapsible into a summary. Kills
  the "AI isn't working synchronously / I can't see what it's doing" complaint. Graceful fallback
  to the blocking route. _(server: `streamParse.ts` + `/generate/stream` SSE; client:
  `streamGenerateStudioApp` + `activityStore` + `ActivityFeed`.)_

- **S2 — Code ⇄ Preview focus toggle + real-estate controls.** ✅ **shipped.** A segmented
  "Code · Split · Preview" toggle (persisted, + ⌘K palette) so the user can dedicate the screen to
  reviewing code or the running app; each focus keeps its own resize state.
  _(`kit/focusStore.ts` + `kit/FocusToggle.tsx`, wired in `CodeStudioView`.)_

- **S3 — Polyglot studio (multi-language).** ✅ **shipped.** Generation picks the right language/stack
  for the idea (web/Node/Python/Go/CLI/script…) and emits the right manifest + README; the Monaco editor
  highlights ~30 languages; the preview shows an honest "run locally / cloud-run / download" panel for
  non-web projects instead of a broken browser preview. _(server: `studioGenerate` prompt/contract;
  client: `MonacoEditor` lang map, `projectKind.ts`, `CodeStudioView` preview fallback.)_
  **Next polyglot increments:** real per-language execution in the cloud worker (Python/Go images),
  language-specific templates on the start screen, and per-language run/format commands.

- **S3b — Diff-centric live edits.** When refining, stream a per-file **diff** (added/removed
  lines) into the activity feed and the Changes panel as the model rewrites files, so edits read
  like a reviewable changelog, not a black box.

- **S4 — Agentic tool/service auto-wiring (planner surface).** Let the build agent declare the
  services an app needs (DB, auth, storage, payments) and surface a one-click "connect" plan that
  uses the user's connected accounts (S5/S6) — generating the client code + env wiring.

- **S5 — Connected accounts: Supabase / DB / storage.** OAuth/PAT connect for Supabase (+ generic
  Postgres URL); the agent provisions a project/schema/storage and injects the keys into the
  generated app's env — "bring your backend" by default. (Uses the Supabase MCP we already have.)

- **S6 — Connected accounts: GitHub + deploy (Railway/Vercel/CF).** GitHub two-way sync already
  exists (`/api/studio/github/*`); add connect-account UI, repo create/push from the studio, and
  one-click deploy to Railway/Vercel/Cloudflare via their MCPs/APIs.

- **S7 — Agent builder + MCP OAuth.** UI to compose custom agents (instructions/tools/model) and
  connect MCP servers with per-user OAuth + streamable transport.

- **S8 — RAG/file search, memory, prompt library.** pgvector ingest, persistent memory, saved
  prompt templates with variables.

## Design / UX system

Build new studio UI on the existing **studio kit** (`components/studio/kit/*`: Reveal, Lift,
Stagger, Shimmer, StatusPulse, Confetti, theme) and `components/ui/*` (shadcn/21st.dev
foundation, `cn`). Use the **21st.dev Magic** + **shadcn** MCPs for net-new components and
motion; match the Linear/AI-studio dark aesthetic (near-black, frosted glass, violet accent).

## Tracking

Each sprint updates the phase board in `00-STATUS.md`. This doc is the "why/what next";
`00-STATUS.md` is the "where we are right now."
