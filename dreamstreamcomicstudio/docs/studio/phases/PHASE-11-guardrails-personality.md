# Phase 11 — Guardrails & personality (parallel workstream)

**Status:** 📋 planned · **Parallel to** the Studio build · **Effort:** 1 week · **Spec:** [12-GUARDRAILS-PERSONALITY.md](../12-GUARDRAILS-PERSONALITY.md)

## Goal
One coherent brand voice everywhere, and real safety beyond prompt instructions.

## Tasks
1. **Unified persona module** (`server/src/ai/persona.ts`): identity, tone, formatting,
   do/don'ts, refusal style. Compose into: `CHAT_SYSTEM_PROMPT`, swarm synthesizer, every
   agent (`registry.ts`), the Universal Assistant, and the Studio build agent.
2. **Output guardrail layer** (`server/src/ai/guardrails.ts`): post-generation checks —
   fabrication (numeric/price/fact without a tool call → label unverified), secret/PII leak
   (regex + allowlist), citation presence for sourced answers. Surface flags to the UI.
3. **Critic/verifier** in the swarm (shared with Phase 9 `verify.ts`).
4. **Studio code/agent safety:** treat ingested web/tool content as untrusted
   (prompt-injection defense; reuse the `<untrusted-data>` framing); secret-scan generated
   code before deploy/commit; content policy + safe default templates.
5. **Trust signals (UI):** confidence chips, "verified vs from memory" labels, expandable
   sources across chat + swarm.
6. **Audit logging:** structured guardrail events (extend `capabilities.ts` notices) for review.

## Acceptance criteria
- A single persona drives every surface; voice consistent on spot-checks across chat,
  swarm, assistant, studio.
- Guardrail layer catches fabricated numbers, leaked secrets, and missing citations in
  unit tests; flags appear in the UI.
- Build agent treats web/tool content as untrusted; pre-deploy secret scan runs.
- Confidence/verification signals visible; guardrail events logged; server typecheck + tests.

## Files
- new: `server/src/ai/persona.ts`, `server/src/ai/guardrails.ts` (+ tests)
- edit: `chat.ts`, `agents/orchestrator.ts`, `agents/registry.ts`, `assistant.ts`,
  studio build agent, chat UI (trust chips)
