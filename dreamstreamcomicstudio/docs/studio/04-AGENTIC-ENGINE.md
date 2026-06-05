# 04 — The Agentic Build Engine

This is **the feature that makes it feel like Lovable/Emergent** instead of a code
dumper. Today building is one-shot and blind. The target is an autonomous loop where the
agent **runs the code, sees the real errors, and fixes them itself** until it works.

## The loop

```
                ┌───────────────────────────────────────────────────────────┐
   user intent ─►          PLAN  ───►  ACT (write files) ───►  RUN           │
   ("build a     │          ▲            (stream to container)   (npm i+dev)  │
    finance      │          │                                       │         │
    dashboard")  │         FIX ◄──────────── OBSERVE ◄─────────────┘         │
                 │          │     (build errors, dev-server logs,             │
                 │          │      runtime console, HTTP status, screenshot)  │
                 │          └──── repeat until: build clean & app responds    │
                 │          guards: max iters · budget · "stuck" → ask user   │
                 └───────────────────────────────────────────────────────────┘
```

## Stages in detail

### 1. PLAN
- Input: user request (+ existing project files if iterating) + conversation context.
- Output: a short build plan + the file list to create/modify + chosen template
  (`react-ts`, `node-api`, `static`, …) + the run/install commands.
- Model: route to a **capable coding model** (strong-open default; frontier via BYOK).
  Reuse the existing **agent swarm** (`server/src/ai/agents/`) as the planner/executor.
- Emit plan to the UI as a checklist the user can watch (Lovable-style "thinking").

### 2. ACT (write files)
- Stream each file straight into the **live container** (`writeFile`) so Vite HMR shows
  progress as it's written. No "wait for the whole thing then preview."
- Use the existing `generate_app` artifact shape (`apiTypes.ts CodeStudioArtifact`).

### 3. RUN
- `npm install` (run-to-completion) → start dev server (background) → `exposePort` →
  preview URL. This is the Cloudflare Worker (`studio-worker/`, Phases 1–2).

### 4. OBSERVE  ← **the new capability**
The agent must *see* what's wrong. Capture:
- **Build/install errors** (stderr from `npm install` / the dev server).
- **Dev-server logs** (compile errors, Vite overlay messages) — stream via `execStream`.
- **Runtime console errors** (inject a tiny error-collector script into the preview, or
  read the dev server's error overlay; postMessage from the iframe).
- **HTTP status** of the preview URL (does `/` return 200?).
- **(Optional) a screenshot** of the preview for visual/UX feedback (Phase 7+).
Bundle these into a structured "observation" passed back to the model.

### 5. FIX
- Feed the observation + current files to the model; ask for **minimal diffs** (only the
  broken files), not a full rewrite.
- Apply the diffs to the container (`writeFile`) → re-run → re-observe.
- This replaces today's blind one-shot `studio/aiFix.ts` (which parses JSON from prose
  and truncates at 24k chars) with a real, grounded loop.

### Guards (so it never burns money or spins forever)
- **Max iterations** per build (e.g. 4–6), then stop and report.
- **Budget guard** via `usageEnforcer` (tokens + container minutes).
- **"Stuck" detector:** if the same error repeats N times, stop and **ask the user**
  instead of looping (write the question to chat).
- **User interjection:** the user can chat mid-loop to redirect.

## How it reuses what exists
| Need | Reuse |
|---|---|
| Multi-step planner/executor | `server/src/ai/agents/` (swarm) |
| File artifact shape | `apiTypes.ts` `CodeStudioArtifact`, `services/chatUtils.buildStudioArtifact` |
| One-shot fix → FIX stage | evolve `studio/aiFix.ts` |
| Run + logs | `studio-worker/` (Sandbox SDK `exec`/`execStream`/`startProcess`) |
| Model routing | `server/src/ai/autoRouter.ts` (add a "coding" preference) |

## Model strategy for building
- **Default:** a strong **open** coding model (good multi-file quality, cheap per-token).
- **Frontier (Claude/GPT-class):** offered via **BYOK** or credits for hard builds.
- **Never** a weak free model for the PLAN/FIX stages — that's what produced broken
  multi-file apps. (Free models are fine for plain chat.)

## Acceptance criteria (when Phase 4 is "done")
- A "build me X" request reliably reaches a **running** preview without the user
  hand-fixing errors, for common stacks (React/Vite, static, simple Node API).
- The agent recovers from at least: a missing dependency, a syntax/type error, a wrong
  import path, and a dev-server crash — autonomously, within the iteration cap.
- Every iteration is metered; the loop respects budget + stuck guards.
- The whole run is visible to the user as a live plan/observe/fix trace.
