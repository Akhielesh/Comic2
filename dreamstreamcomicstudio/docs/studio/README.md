# DreamStream Studio — Documentation Hub

> **Single source of truth** for building DreamStream Studio: an AI-centric app builder
> (chat → an agent builds a real app → it runs live in a cloud container → preview,
> edit, GitHub, deploy) — targeting **Lovable / Emergent-class** quality.
>
> If you only open one file, open **[`00-STATUS.md`](./00-STATUS.md)** — it always shows
> what's done and what the next step is.

---

## How to use these docs

**Humans:** check `00-STATUS.md` for where we are, read `01-VISION.md` for the "why",
then jump to the current phase doc in `phases/`.

**AI agents:** read **[`AGENTS.md`](./AGENTS.md) first** — it tells you the working
rules, where code lives, how to verify, and the **mandatory** rule to update
`00-STATUS.md` + `CHANGELOG.md` after every change. These docs are designed so any agent
can pick up the work cold.

## Map of the docs

| File | What it is |
|---|---|
| **[00-STATUS.md](./00-STATUS.md)** | 🔴 LIVING status tracker — progress, current phase, blockers. Check this first. |
| **[OWNER-ACTIONS.md](./OWNER-ACTIONS.md)** | 🟠 LIVING — what's waiting on YOU + built-but-not-validated + how to resume in a new session |
| [01-VISION.md](./01-VISION.md) | What we're building and why; positioning vs Lovable/Emergent; goals & non-goals |
| [02-CURRENT-STATE.md](./02-CURRENT-STATE.md) | **Brutally honest** audit of what exists today vs the enterprise/Emergent bar |
| [03-ARCHITECTURE.md](./03-ARCHITECTURE.md) | System architecture, components, end-to-end data flows |
| [04-AGENTIC-ENGINE.md](./04-AGENTIC-ENGINE.md) | The build-loop engine (plan→write→run→observe→fix) in depth |
| [05-UIUX.md](./05-UIUX.md) | UI/UX spec: layouts, components, states, animations, effects, mobile |
| [06-DATA-MODEL.md](./06-DATA-MODEL.md) | Persistence & versioning: tables, RLS, storage |
| [07-INTEGRATIONS.md](./07-INTEGRATIONS.md) | GitHub sync, one-click deploy, per-project backend, billing |
| [10-AGENTS-SWARM.md](./10-AGENTS-SWARM.md) | Multi-agent swarm — analysis + redesign (guardrails, personality, legitimacy, usability) |
| [11-TOOLS-MCP-SOURCING.md](./11-TOOLS-MCP-SOURCING.md) | Tools, MCP & sourcing — analysis + redesign (access for all models/agents) |
| [12-GUARDRAILS-PERSONALITY.md](./12-GUARDRAILS-PERSONALITY.md) | Safety + one coherent brand voice across every surface |
| [agent-constitution/](./agent-constitution/00_README_AND_WIRING.md) | The **studio build agents' constitution** (17 files): scope, grounding, completeness, security, verification, recovery. Implemented in `server/src/ai/studio/constitution.ts`. |
| [CLOUDFLARE_STUDIO_PLAN.md](./CLOUDFLARE_STUDIO_PLAN.md) | Compute/cost/sandbox design — verified Cloudflare pricing |
| [PRODUCT_BLUEPRINT.md](./PRODUCT_BLUEPRINT.md) | Condensed product blueprint (superseded in detail by 01–07) |
| [09-ROADMAP.md](./09-ROADMAP.md) | Phase-by-phase plan + links to each phase doc |
| [phases/](./phases/) | One detailed doc per phase (0–8): tasks, flows, acceptance criteria |
| [AGENTS.md](./AGENTS.md) | Working rules for AI agents in this repo |
| [CHANGELOG.md](./CHANGELOG.md) | Append-only log of everything done (for agents to pick up) |

## The one-paragraph version

Users describe an app in chat. An **agentic loop** plans it, writes the files, runs them
in a **Cloudflare container** (real `npm install` + dev server), **reads the build/runtime
errors and fixes them itself**, and hands back a **live preview URL** the user opens from
any device. They can dive into a real editor, sync to GitHub, and deploy in one click.
Models are **BYOK / free-first**, so it runs for pennies — our edge over Lovable/Emergent.

## Status at a glance

- ✅ **Phase 1 foundation scaffolded** (Studio Worker) + studio bug-fixes shipped (#75).
- 📋 Phases 0, 2–8 planned in detail.
- ⛔ Blocked on: Cloudflare infra greenlight (Workers Paid + preview domain).

See [`00-STATUS.md`](./00-STATUS.md) for the authoritative, current state.
