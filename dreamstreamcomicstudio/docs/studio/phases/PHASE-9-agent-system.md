# Phase 9 — Agent system upgrade (parallel workstream)

**Status:** 📋 planned · **Parallel to** the Studio build · **Effort:** 1–2 weeks · **Spec:** [10-AGENTS-SWARM.md](../10-AGENTS-SWARM.md)

## Goal
Bring the multi-agent swarm to enterprise/Emergent-class: verified, on-brand, legible,
and easy to use.

## Tasks
1. **Verifier/critic stage** (`server/src/ai/agents/verify.ts`): after dispatch, check
   findings for unsupported claims / missing citations / contradictions; attach a
   confidence + flags object; run before synthesis (cheap free model). Optional + capped.
2. **Citation enforcement** in synthesis (extend prompts + a post-check): factual claims
   trace to a gathered source or are labeled "unverified".
3. **Personality:** route all agent prompts through the shared `PERSONA` (Phase 11) +
   an expertise layer; remove ad-hoc tone drift.
4. **Trace upgrade** (`SwarmTraceCard.tsx`): show the plan, per-agent tools used, sources,
   confidence chip; expandable raw finding; **re-run a single agent**.
5. **Live agent streaming:** stream each agent's partial output into its card (SSE), not
   just status transitions.
6. **Custom-agent persistence:** Supabase table `studio_agents` (or `custom_agents`);
   CRUD + an **agent library** UI (name/save/share); seed with the 8 built-ins read-only.
7. **Resilience:** retry an agent once on transient failure; better heuristic fallback.
8. **Studio integration:** wire the `code` agent to the Phase 4 build loop for build goals.
9. **Guards:** per-agent token cap + total swarm budget via `usageEnforcer` + wall-clock timeout.

## Acceptance criteria
- Verifier visibly raises/flags confidence before synthesis; tests for the checker.
- One brand voice across planner/agents/synth; trace shows sources + confidence; an agent
  can be expanded + re-run; agents stream live.
- Custom agents persist + manage in a library; built-ins protected.
- All swarm calls metered; budget/timeout/retry guards enforced; server typecheck + tests.

## Files
- new: `server/src/ai/agents/verify.ts` (+ tests), `server/sql/studio_agents.sql`,
  agent-library UI components
- edit: `orchestrator.ts`, `registry.ts`, `routes/chat.ts` (/swarm), `SwarmTraceCard.tsx`
