# 09 — Roadmap

Build **phase by phase**. Each phase is a shippable increment with its own doc (tasks +
acceptance criteria). Track live status in [`00-STATUS.md`](./00-STATUS.md).

## Sequence & dependencies

```
  ✅ #75 studio bug-fixes (done)
        │
  ⛔ P0 Cloudflare infra (owner action) ──► 🟡 P1 Studio Worker (scaffolded)
        │                                          │
        └───────────────► 📋 P2 Control plane ◄────┘
                                 │
                                 ▼
                          📋 P3 Studio UI shell ──► 📋 P8 Consolidate runtimes
                                 │
                                 ▼
                          📋 P4 Agentic build loop   ← the "magic"
                                 │
                                 ▼
                          📋 P5 Editor + persistence
                                 │
                                 ▼
                          📋 P6 GitHub + deploy
                                 │
                                 ▼
                          📋 P7 Per-project backend, polish, mobile
```

## Phases

| # | Phase | Outcome | Buildable now? | Doc |
|---|---|---|---|---|
| 0 | Cloudflare infra | Workers Paid + wildcard domain ready | ⛔ owner action | [PHASE-0](./phases/PHASE-0-infra.md) |
| 1 | Studio Worker | container → live preview URL | 🟡 scaffolded; deploy needs P0 | [PHASE-1](./phases/PHASE-1-worker.md) |
| 2 | Control plane | `/api/studio/*` auth + meter + caps | ✅ yes (in repo) | [PHASE-2](./phases/PHASE-2-control-plane.md) |
| 3 | Studio UI shell | chat + live preview + "Run live" | ✅ yes | [PHASE-3](./phases/PHASE-3-studio-ui.md) |
| 4 | Agentic build loop | plan→run→observe→fix autonomy | after 1–3 | [PHASE-4](./phases/PHASE-4-agentic-loop.md) |
| 5 | Editor + persistence | Monaco + file tree + saved/versioned projects | after 3 | [PHASE-5](./phases/PHASE-5-editor-persistence.md) |
| 6 | GitHub + deploy | repo sync + one-click public URL | after 5 | [PHASE-6](./phases/PHASE-6-github-deploy.md) |
| 7 | Backend, polish, mobile | per-project DB; mobile; effects | after 6 | [PHASE-7](./phases/PHASE-7-backend-polish-mobile.md) |
| 8 | Consolidate runtimes | one runtime (drop WebContainer/unpkg) | after 3 | [PHASE-8](./phases/PHASE-8-consolidate-runtimes.md) |

## Platform workstreams (parallel to the Studio build)
These improve the whole AI product (chat + swarm + tools), not just the studio. They can
run alongside Phases 1–8.

| # | Workstream | Outcome | Doc / spec |
|---|---|---|---|
| 9 | Agent system upgrade | verifier/critic, one brand voice, richer trace, custom-agent library, retries; wire `code` agent → build loop | [PHASE-9](./phases/PHASE-9-agent-system.md) · [10-AGENTS-SWARM](./10-AGENTS-SWARM.md) |
| 10 | Tools/MCP/sourcing upgrade | tools on all models (JSON fallback), server-side + OAuth + streaming MCP, curated marketplace, **outbound MCP server**, sourcing reliability | [PHASE-10](./phases/PHASE-10-tools-mcp.md) · [11-TOOLS-MCP-SOURCING](./11-TOOLS-MCP-SOURCING.md) |
| 11 | Guardrails & personality | unified persona, output guardrail layer, code/agent safety, trust signals, audit log | [PHASE-11](./phases/PHASE-11-guardrails-personality.md) · [12-GUARDRAILS-PERSONALITY](./12-GUARDRAILS-PERSONALITY.md) |

## Milestones
- **M1 — "It runs" (P0–P3):** a user clicks "Run live" in chat, the app opens in a new
  tab from a real container. *This is the proof the architecture works.*
- **M2 — "It builds itself" (P4):** the agent iterates to a clean build autonomously.
  *This is the Lovable/Emergent feeling.*
- **M3 — "It's a product" (P5–P6):** projects persist + version; edit code; GitHub + deploy.
- **M4 — "It's polished" (P7–P8):** per-project DB, mobile, one runtime, premium UX.

## Effort (rough, for sequencing — not commitments)
P0: hours (owner) · P1: 1–2 days (validate) · P2: 2–3 days · P3: 3–5 days ·
P4: 1–2 weeks (the hard one) · P5: 3–5 days · P6: 3–5 days · P7: 1–2 weeks · P8: 2–3 days.

## How to pick up work
1. Open `00-STATUS.md` → find the first non-done phase that isn't blocked.
2. Open its phase doc → do the tasks → meet the acceptance criteria.
3. Update `00-STATUS.md` + `CHANGELOG.md`. Open or update the PR.
