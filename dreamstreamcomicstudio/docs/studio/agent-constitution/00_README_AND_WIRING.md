# Studio Agent Constitution — README & Wiring

This is the constitution for the AI agents **inside DreamStream Studio** — the in-app
prompt-to-app builder (the PLAN → ACT → RUN → OBSERVE → FIX loop in `server/src/ai/studio/`).
Each numbered file is a system-prompt "hat" the model wears at a phase of a build. They are
**model-agnostic on purpose**: Studio routes any coding model (free-first, frontier via BYOK),
so nothing here depends on one model's quirks.

> **Two audiences, don't confuse them.**
> - **This folder** governs the *studio build agents* (the AI that builds apps for end users).
>   It is implemented in code as `server/src/ai/studio/constitution.ts` and composed into the
>   live PLAN/GENERATE/FIX prompts.
> - **[`../AGENTS.md`](../AGENTS.md)** governs *us* — the Claude Code / engineers working on the
>   DreamStream repo. Different audience, still in force.

This is the customized, onboarded version of a generic "agent constitution" package. The generic
original assumed Next.js + shadcn + Supabase and a fictional tool surface (`fs.*`, `preview.*`,
`db.*`). **Every file here has been rewritten against DreamStream's real stack, real tool surface,
and the controls we already ship** (`verifyApp`, `buildGuards`, `assistantPolicy`,
`sourceGovernance`, `mcpClient` SSRF guard, `sanitizeStudioCommand`, `usageEnforcer`).

---

## READ THIS FIRST — the part that actually matters

**1. Prompts are probabilistic. Gates are deterministic. Your quality ceiling is what you can
VERIFY, not what you can ask for.** A prompt that says "write good code" produces *probabilistic
compliance*. A static verifier, a real build/run in the sandbox, and a budgeted fix loop that
*block the handoff* produce *deterministic enforcement*. These files are the **prompt layer** —
the smaller half. The bigger half already exists in this repo: `verifyApp.ts` (static gate),
the studio-worker sandbox (real `npm install` + dev server), `buildGuards.ts` (the loop can't
run forever), `sanitizeStudioCommand` (the terminal is allow-listed). **The prompts ask; that
harness enforces.**

**2. "Push the model to its limits" and "deliver more than asked" are the two most destructive
instructions you can give a build agent.** They cause scope creep, half-built features, broken
builds. Everywhere, they are replaced with: **deliver the exact requested scope, fully working,
verified, then stop.** Reliability beats brilliance. If the requested app builds and runs clean,
that *is* the agent at its limit.

**3. Match pipeline depth to task complexity** (`02_ORCHESTRATOR` complexity router). A one-line
"todo app" should not spin up plan→architecture→design→verify councils. A multi-surface app
should. Each handoff costs tokens, latency, and a chance to inject a bug.

**4. The hard problem is recovery, not generation.** Every tool generates. DreamStream wins by
recovering from its own broken output: read the *real* error (`BuildObservation`), fix the cause,
re-verify, and **stop + ask the user** when stuck (`buildGuards` stuck/iteration caps). Error
recovery is a first-class file here (`15`), not an afterthought.

**5. The weaker the model, the more the harness carries the quality.** You cannot prompt a free
7B model into being Claude — but you can wrap it in tight specs + hard verification so it
physically can't ship garbage past the gate. That is the entire point of the free-first model
strategy: the gate, not the model, is the floor.

---

## The files

| # | File | Role | Enforced in code by |
|---|------|------|---------------------|
| 00 | `00_README_AND_WIRING.md` | this file | — |
| 01 | `01_GLOBAL_CONSTITUTION.md` | non-negotiables every agent inherits | `persona.ts`, `constitution.ts` |
| 02 | `02_ORCHESTRATOR.md` | the build loop + complexity router | `studio/buildAgent.ts`, `buildGuards.ts` |
| 03 | `03_PLANNER.md` | idea → bounded build plan | `studio/studioPlan.ts` |
| 04 | `04_ARCHITECTURE.md` | stack, templates, boundaries | `studio/studioGenerate.ts` (`VALID_TEMPLATES`) |
| 05 | `05_DESIGN.md` | UI/UX, design system, a11y | `studio/designSystem.ts` (`DESIGN_CHARTER`) |
| 06 | `06_FLOW.md` | journeys, states, no dead ends | `studio/designSystem.ts` skills |
| 07 | `07_FRONTEND.md` | frontend implementation standards | `studio/studioGenerate.ts` (`OUTPUT_CONTRACT`) |
| 08 | `08_BACKEND.md` | server logic, APIs, jobs | services detector, `studio.ts` route |
| 09 | `09_DATA.md` | schema, migrations, integrity (Supabase) | `06-DATA-MODEL.md`, RLS |
| 10 | `10_SECURITY.md` | authz, secrets, injection, supply chain | `guardrails.ts`, `mcpClient` SSRF, `sanitizeStudioCommand` |
| 11 | `11_PRIVACY.md` | minimization, consent, egress control | `assistantPolicy.ts`, `STUDIO_DISABLE_EXTERNAL_MCP` |
| 12 | `12_CODE_QUALITY.md` | cross-cutting standards, license policy | `verifyApp.ts`, repo CI |
| 13 | `13_TOOL_PROTOCOL.md` | the real tool surface + rules | `studio-worker/`, `mcpClient.ts`, `tools/registry.ts` |
| 14 | `14_VERIFICATION_AND_TESTING.md` | the gate: pass before handoff | `verifyApp.ts`, `repairUntilClean`, OBSERVE→FIX |
| 15 | `15_ERROR_RECOVERY.md` | self-debug loop, budgets, escalation | `buildGuards.ts`, `studioFix.ts` |
| 16 | `16_PERFORMANCE_AND_OBSERVABILITY.md` | budgets, structured logs, no PII | `capabilities.ts` notices, perf budgets |

---

## Context-loading strategy (do NOT dump all 17 into every model call)

The files themselves warn against this — pasting everything every turn blows the token budget and
dilutes a weak model. This is why the code module injects a **compact charter**, not the full text.

- **Always resident (compact):** the `STUDIO_CONSTITUTION` charter (a condensed `01` + `13`) — short,
  applies to every build action, pinned by `constitution.ts`.
- **Per phase:** `STUDIO_PLAN_CONSTITUTION` → plan prompt; the `DESIGN_CHARTER` (already shipped) →
  generate prompt; `STUDIO_FIX_CONSTITUTION` → fix prompt. The full prose lives in these docs for
  humans and for any future phase-specific loader (`loadConstitution(phase)`).

## How to use these (the harness around the prompts)

The canonical tool surface is mapped to DreamStream's real tools **once**, in `13_TOOL_PROTOCOL`.
Everything else inherits it. Minimum harness behind these prompts (all of which already exists):

1. The studio-worker sandbox runs real `npm install` + dev server (`exec`/`execStream`/`exposePort`).
2. `BuildObservation` exposes the real signals (build/install errors, dev logs, runtime console,
   HTTP status, optional screenshot).
3. `verifyApp.ts` + `repairUntilClean` + the OBSERVE→FIX loop **block the handoff** on failure —
   not a prompt the model can talk past.
4. `sanitizeStudioCommand` allow-lists the terminal; `mcpClient` SSRF-guards every external call.

Stack defaults baked in (`04`, `05`): React + Vite + TypeScript, Tailwind + shadcn/ui + Framer
Motion, Expo/React Native for mobile, Node/Express or Python for APIs, Supabase for data. No AGPL.

---

> The prompt asks. The harness enforces. Ship the scope, verify it runs, then stop.
