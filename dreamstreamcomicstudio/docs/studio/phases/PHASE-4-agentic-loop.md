# Phase 4 — Agentic build loop (the magic)

**Status:** 📋 planned · **Depends on:** Phases 1–3 · **Effort:** 1–2 weeks · **See:** [04-AGENTIC-ENGINE.md](../04-AGENTIC-ENGINE.md)

## Goal
The agent builds an app, **runs it, reads the real errors, and fixes them itself**,
iterating to a clean build — instead of one-shot code generation.

## Tasks
1. **Build orchestrator** (server) — a loop: PLAN → ACT(write) → RUN(launch via control
   plane) → OBSERVE → FIX → repeat. Reuse `server/src/ai/agents/` (swarm) as planner/executor.
2. **OBSERVE capture** (the new capability):
   - install/build stderr (from the Worker),
   - dev-server compile errors / Vite overlay (stream via `/logs`),
   - runtime console errors (inject a collector into the preview; `postMessage` from iframe),
   - HTTP status of `/` on the preview URL.
   Normalize into a structured observation object.
3. **FIX stage** — evolve `studio/aiFix.ts`: feed observation + files, request minimal
   diffs (changed files only), apply to the container, re-run. Strong coding model.
4. **Streaming UX** — emit the live PLAN/RUN/OBSERVE/FIX trace to `BuildTrace` (SSE).
5. **Guards** — max iterations (4–6), `usageEnforcer` budget, "stuck" detector (same
   error N× → stop + ask the user), user interjection mid-loop.
6. **Model routing** — add a "coding" preference to `autoRouter` (strong-open default;
   frontier via BYOK/credits).

## Acceptance criteria
- "Build me X" reliably reaches a **running** app without the user hand-fixing, for
  React/Vite, static, and a simple Node API.
- The agent autonomously recovers from: missing dependency, syntax/type error, wrong
  import path, dev-server crash — within the iteration cap.
- Every iteration is metered; budget + stuck guards work; the trace is visible live.
- Server typechecks; unit tests for the observation parser + guard logic.

## Files
- new: `server/src/ai/studio/buildAgent.ts`, `observation.ts` (+ tests)
- edit: `studio/aiFix.ts` → FIX stage, `server/src/ai/autoRouter.ts`, `routes/chat.ts` (build mode), `BuildTrace.tsx`

## Why this is the hard/important one
This is the difference between "an AI that writes code" and "an AI that builds working
apps." It's what makes Lovable/Emergent feel magic. Budget real time here.
