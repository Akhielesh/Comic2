# 10 — Agentic Swarm: analysis & redesign

Deep, honest analysis of the **current** multi-agent swarm and a concrete plan to bring
it to enterprise / Emergent-class (guardrails, personality, legitimacy, usability).

## Current design (what's actually there)

Files: `server/src/ai/agents/orchestrator.ts`, `registry.ts`, `swarmTool.ts`;
route `server/src/routes/chat.ts` (`/swarm`); UX `components/chat/artifacts/SwarmTraceCard.tsx`.

**Pipeline:** `PLAN → DISPATCH (parallel) → SYNTHESIZE`.
1. **PLAN** — a planner model decomposes the goal into 1–4 subtasks, each assigned to an
   agent. Falls back to a keyword heuristic (`selectAgentsHeuristic`) if the planner fails.
2. **DISPATCH** — each agent runs concurrently as a focused `runChat` with its own persona
   + a tool subset; emits live status (`pending→running→done/error`) via `onProgress`.
3. **SYNTHESIZE** — the user's chosen model merges all findings (with each agent's real
   gathered sources) into one streamed answer.

**Agent library (8 built-ins):** news, finance (rich terminal), weather, tech, research,
local, general, code. Plus **user-defined custom agents** (`sanitizeCustomAgents` — id
namespacing, tool allowlist, length caps, no recursive swarm).

**Good design decisions already in place:**
- Context-aware: prior messages + the user's memory/persona are passed to planner, agents,
  and synthesizer (fixes "context-blind on follow-ups").
- Cost-aware: planner + agents on a **free** model; only synthesis uses the chosen model;
  usage is merged across all calls for accurate billing.
- Citation fidelity: agents' real source URLs are handed to the synthesizer (no "telephone
  game" of losing links).
- Exposed two ways: explicit **Swarm mode** (`/api/chat/swarm`) **and** as a tool
  (`run_agent_swarm`) any model can call mid-conversation.

## Honest assessment

| Strength | | Weakness / gap |
|---|---|---|
| Real parallel multi-agent | | **No verification/critic** stage — nothing checks agents for hallucination/quality |
| Context + memory passed through | | Planner runs on a **weak free model** → sometimes poor decomposition |
| Citations preserved to synthesis | | Agents are **single-pass** `runChat` (tool loop capped at 4); no deep iteration |
| Billing merged across calls | | **No inter-agent communication** (pure fan-out/fan-in; can't build on each other) |
| Custom agents (sanitized) | | **No agent memory/learning**; custom agents aren't persisted server-side |
| Live status trace | | Trace shows status only — **no live streaming of each agent's work** |
| Heuristic fallback | | Heuristic is coarse (regex); no retry on agent failure |
| `code` agent exists | | Not yet wired to the **studio build loop** (Phase 4) |
| — | | **Personality is fragmented** (each agent ad-hoc; no unified brand voice) |
| — | | No **confidence/uncertainty signaling** surfaced to the user |

## Redesign plan (→ PHASE-9)

### A. Guardrails (correctness & safety)
- **Critic/verifier stage:** after dispatch, a lightweight verifier checks findings for
  unsupported claims, missing citations, and contradictions before synthesis; flags low-
  confidence items. (New optional `verify` step; cheap free model.)
- **Citation enforcement:** factual claims in the synthesis must trace to a gathered
  source; otherwise marked "from model knowledge, unverified" (extends the existing
  anti-fabrication prompt rules).
- **Budget & loop guards:** explicit max agents (4, done), per-agent token cap, total
  swarm budget via `usageEnforcer`, and a wall-clock timeout.
- **Tool-permission integrity:** already allowlisted; add per-agent audit logging.

### B. Personality (one coherent voice)
- Define a **brand persona** (tone, formatting, do/don'ts) in one place and compose it
  into the chat persona, the synthesizer, and every agent — so the product has a
  consistent voice instead of 8 ad-hoc prompts. (See `12-GUARDRAILS-PERSONALITY.md`.)
- Per-agent **expertise voice** layered on top of the shared persona (analyst vs reporter)
  without contradicting the brand voice.

### C. Legitimacy (trust)
- **"Show your work":** richer trace — the plan, each agent's tools used, sources, and a
  confidence chip. Let users expand any agent to see its raw finding + sources.
- **Uncertainty signaling:** surface when the swarm is inferring vs citing.
- **Reproducibility:** store the plan + per-agent results with the message (data model).

### D. Usability
- **Editable plan:** optionally show the plan before dispatch so the user can tweak which
  agents run (power-user toggle; default auto).
- **Live agent streaming:** stream each agent's partial output into its trace card, not
  just status.
- **Custom-agent management:** persist user agents server-side (table), name/save/share;
  an **agent library/marketplace** UI (reuse `ComponentGallery` patterns).
- **Re-run / refine:** re-run a single failed agent; "go deeper" on one finding.
- **Recovery:** retry an agent once on transient failure before marking error.

### E. Integration with the Studio
- Wire the `code` agent into the **agentic build loop** (Phase 4): for build goals the
  swarm's code agent drives plan→write→run→observe→fix instead of one-shot `generate_app`.

## Acceptance criteria (PHASE-9 done)
- A verifier stage runs and visibly raises confidence/flags before synthesis.
- One shared brand persona drives chat + synth + agents (no contradictory voices).
- Trace shows plan + per-agent sources + confidence; an agent can be expanded/re-run.
- Custom agents persist + are manageable in a library UI.
- All swarm calls metered; budget/timeout guards enforced; tests for plan/verify/guards.
