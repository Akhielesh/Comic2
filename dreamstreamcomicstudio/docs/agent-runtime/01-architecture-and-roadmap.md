# 01 — Architecture & Roadmap

## 1. The vision (decoded from the brief)

The chat agents should be able to **solve arbitrary user tasks**, and when no existing
tool/MCP covers a task, **write their own code, run it in a cloud sandbox, verify the
output, render it as an efficient in-chat component, and refine on feedback.**
Concrete examples from the brief:

- "convert this jpg to png" (deterministic file conversion)
- "convert this data table to a pie chart" (data → visual)
- "turn this raw file into CSV" (data reshape)
- "generate this trend chart" with **live data** the agent fetches and routes in
- "custom-build structures, alignments" — agents compose **bespoke layouts** in chat,
  not just fixed cards.

The agent must **think deeper → reach a solution → verify it → take user feedback →
re-understand re-asks → act accordingly**, while staying **quick** and
**cost-efficient**, at **enterprise scale**.

## 2. What we already have (from the codebase review)

The review (read-only, file-cited) found we are far closer than a greenfield build:

| Capability | Where | State |
|---|---|---|
| Agentic chat loop w/ tool-calling | `server/src/ai/chat.ts` (`runChat`, `MAX_TOOL_ITERATIONS=6`) | Mature. Two tool paths: OpenRouter native `tool_calls` + a JSON-text protocol for non-tool-calling providers (NVIDIA). Concurrent tool exec, SSE streaming. |
| Smart tool routing | `routes/chat.ts` → `selectRelevantTools(...)` in `toolCatalog.ts` | Keyword-scored; caps the model to ≤20 of ~60 tools so it never sees all specs. |
| Tool registry / plugin contract | `server/src/ai/tools/registry.ts`, `types.ts` (`ChatTool { name, description, parameters, execute }`) | Clean. Adding a tool never touches the loop. `ToolExecResult` already carries `artifacts`. |
| **Cloud code sandbox** | `studio-worker/` (`@cloudflare/sandbox`), control plane `server/src/services/studioWorker.ts` (HMAC-signed), autonomous loop `ai/studio/buildAgent.ts` | **Already runs.** Per-user `sandboxId`, allowlisted commands (`sanitizeStudioCommand`), path-guarded writes (`isSafeStudioPath`), `studio_runs` accounting + caps. |
| **Generative-UI pipeline** | `apiTypes.ts` types → `components/chat/artifacts/ChatArtifacts.tsx` (`ARTIFACT_RENDERERS`) → Primitive Kit (`artifacts/kit/`) | ~24 typed artifact cards, dependency-free inline-SVG. Gallery-coverage test enforces demos. |
| In-process SQLite exec | `services/sqlRunner.ts` (sql.js WASM, capped) | Backs `sql_exercise`. Model for cheap in-process execution. |
| MCP client + server | `ai/tools/mcpClient.ts` (SSRF-guarded), `routes/mcp.ts` (outbound) | We can call external MCPs and expose our own tools. |
| Billing / usage / caps | `services/usageEnforcer.ts`, `billingLedger.ts`, `rateLimit.ts` (Redis) | Reserve/settle/release wraps every chat call. |
| Tests | 161 `*.test.ts(x)`, 49 under `server/src/ai/` | Genuinely good for an AI codebase. |

**The real gaps** are narrow and well-defined:

1. **No server-side file/data conversion tool** exposed to the agent (`sharp`/`jszip`
   are deps but unused as tools). This is the "jpg→png / raw→CSV" gap.
2. **No general "write code to solve it" tool** in chat — the sandbox is only driven by
   the Studio build agent, not the conversational agent.
3. **Generative UI is fixed-type** — there's no *composable* artifact that lets the
   agent build a custom layout ("structures, alignments"). This is the first slice.
4. **Enterprise hardening gaps** (see §5).

## 3. Target architecture

```
                          ┌──────────────────────── CHAT AGENT (server/src/ai/chat.ts) ───────────────────────┐
                          │  intent route → pick ≤20 tools → tool loop (≤6) → verify → stream artifacts        │
                          └───────┬───────────────────────────┬───────────────────────────┬──────────────────┘
                                  │ existing tool/MCP?         │ needs custom code?         │ render result
                       ┌──────────▼─────────┐      ┌───────────▼───────────────┐  ┌─────────▼──────────────────┐
                       │ call it (≈60 tools │      │  run_code  TOOL (new)     │  │  GENERATIVE UI (artifacts) │
                       │  + user MCPs)      │      │  tiered execution ↓       │  │  whitelisted {type,data}   │
                       └────────────────────┘      └───────────┬───────────────┘  │  + sandboxed-iframe hatch  │
                                                                │                  └─────────┬──────────────────┘
                       ┌────────────────────────────────────────▼───────────────────────┐  │ ChatArtifacts.tsx
   EXECUTION TIERS     │ T0 Gemini native code-exec  → simple Python (matplotlib/pandas) │  │ → Primitive Kit
   (cheapest→heaviest) │      free compute, ≤30s, charts as images   [Gemini calls only] │  │ → error boundary
                       │ T1 Pyodide Python Worker    → Pillow/NumPy/Pandas, light tasks  │  │ → framer-motion
                       │ T2 Dynamic Worker (Code Mode)→ agent JS, ms cold start,         │  └─────────┬──────────
                       │      globalOutbound egress control                              │            │
                       │ T3 CF Container (@cloudflare/sandbox, existing) → heavy/arbitrary│            │
                       └────────────────────────────────────────┬───────────────────────┘            │
                                  deterministic toolbelt preloaded│ (sharp, vega-lite, papaparse,     │
                                  duckdb-wasm, resvg, arquero…)   │  simple-statistics, sheetjs)      │
                                                                  ▼                                   ▼
                       VERIFY ladder: assert(in-sandbox) → retry-on-trace → reflexion → LLM-judge     │
                                                                  │                                   │
                       persist {code, data snapshot, spec} as addressable artifacts ◄─────────────────┘
                                                                  │
                       USER FEEDBACK → reclassify (param tweak / representation change / new task) → loop
```

### Design principles

- **Deterministic-first.** The LLM decides *what* and emits *specs/code*; the actual
  pixels/bytes are produced by deterministic libraries (sharp, Vega-Lite, DuckDB,
  PapaParse). "As much non-AI as possible."
- **Cheapest tier that can do the job.** ~95% of tasks never touch a paid container.
- **Whitelisted by default, sandboxed by exception.** Safe structured specs for
  everything we can enumerate; a cross-origin sandboxed iframe only for genuinely
  arbitrary generated UI.
- **One extension point each.** A new capability = one `ChatTool` + (optionally) one
  artifact `type` + renderer + gallery demo. The loop, transport, storage never change.
- **Context is the budget.** Filter data in code, return artifact *references* not
  blobs, cache stable prefixes, route to the cheapest capable model.

## 4. The generative-UI first slice (Phase 0, this PR)

A new **`generative_ui`** artifact: a safe, recursive, whitelisted **block tree** the
agent emits as JSON and we render with trusted components from the Primitive Kit. It
delivers "agents custom-build structures, alignments" without any code execution, and
becomes the canonical render target the sandbox later emits into. Full spec in
[`03-generative-ui.md`](./03-generative-ui.md). It also lands two enterprise fixes:
**runtime validation** of `artifact.data` and a **per-artifact error boundary**
(weakness #4 below).

## 5. Enterprise weaknesses to fix (ranked, from the review)

These are folded into the roadmap, not deferred indefinitely:

| # | Weakness | Fix phase |
|---|---|---|
| 1 | Sandbox has no egress allowlist / resource ceilings beyond a time cap | P1 (before `run_code` ships to chat): no-network-default + egress allowlist, mem/CPU/output caps |
| 2 | Container cap check **fails open** (`routes/studio.ts` logs & allows on error) | P1: fail-closed for paid compute |
| 3 | Wide prompt-injection→tool surface; tool outputs flow back as untrusted text with no data/instruction separation | P1: spotlighting wrapper + per-tool output caps |
| 4 | `ChatArtifact.data` is `unknown`, cast without validation; no error boundary | **P0 (this PR)** |
| 5 | No per-request wall-clock / total-cost ceiling on the tool loop | P1 |
| 6 | 33 hand-applied SQL files, no migration runner | P2 |
| 7 | `sqlRunner` synchronous, no hard timeout | P2 |
| 8 | Inconsistent fail-open `catch {}` that hides security-relevant errors | P1–P2 |
| 9 | BYOK secrets traverse many layers; no central log redaction at call sites | P1 |
| 10 | Type safety erodes at boundaries (`req: any`, hand-rolled arg coercion) | P2: shared Zod validation layer for tool args |
| 11 | Two competing code-exec stacks (legacy WebContainer/Sandpack vs cloud sandbox) | P2: retire legacy behind the flag |
| 12 | MCP tool results not size-bounded into the model | P1: uniform truncation + reference pointers |

## 6. Phased roadmap

### Phase 0 — Generative UI foundation *(this PR)*
- `generative_ui` artifact: block spec, recursive renderer on the Primitive Kit,
  runtime validation, error boundary, animation polish, gallery demo, tests.
- `render_ui` server tool + `toolCatalog` entry so the model can emit composed layouts.
- Docs (this folder).

### Phase 1 — `run_code` + sandbox hardening
- Add a one-shot `exec` action to `studio-worker` (run-to-completion, return
  stdout/stderr/produced-files) reusing HMAC + per-user scoping.
- `run_code` `ChatTool` with the **tiered router** (Gemini-native for Gemini calls;
  Worker/Pyodide for light; container for heavy). Preload the deterministic toolbelt.
- Security: egress allowlist, resource caps, output caps, fail-closed cap checks,
  secrets never in sandbox (host-side credential proxy), SSRF defense on fetch.
- Output → existing artifacts (`chart`, `data_table`, `resource_bundle`) or
  `generative_ui` — minimal new client work.

### Phase 2 — Verification + feedback loop
- Verification ladder (deterministic asserts → trace-retry → reflexion → LLM-judge).
- Persist `{code, data snapshot, spec}` as addressable artifacts; diff-edit on re-asks
  ("make it a bar chart", "last 30 days"); per-turn intent reclassification.
- Migration runner; `sqlRunner` timeout; retire legacy code-exec stack; shared Zod
  tool-arg validation.

### Phase 3 — Cost/context + observability at scale
- Code Mode tool orchestration; progressive tool disclosure; prompt caching
  (Gemini implicit + explicit; OpenRouter pass-through); context compaction; model
  routing (Flash-default, escalate on hard reasoning); Langfuse/OpenLLMetry tracing
  with token/cost dashboards.

### Cross-cutting
- Every new visual ships a **Gallery demo** (enforced by `gallery.coverage.test.ts`).
- Every new tool ships a `toolCatalog` entry (routable) + a unit test.
