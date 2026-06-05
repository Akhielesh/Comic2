# 00 — STATUS (living tracker)

> **This is the file to check.** It is the authoritative, always-current state of
> DreamStream Studio. Every agent/PR that changes anything **must** update this file and
> `CHANGELOG.md`. If this file and reality disagree, fix this file.

**Last updated:** 2026-06-05 · **Updated by:** Claude (session 012Drsxr…) · **Branch:** `claude/peaceful-gauss-0Gwni`

> Latest: added deep analysis + redesign docs for the **agent swarm** (10), **tools/MCP/
> sourcing** (11), and **guardrails/personality** (12), with parallel workstream phases 9–11.

---

## Overall progress

```
Foundation  ███████░░░░░░░░░░░░░░  ~35%   (planning complete; Phase 1 scaffolded)
Experience  ██░░░░░░░░░░░░░░░░░░░  ~10%   (designed, not built)
```

**Where we are:** all planning/architecture is done and documented. The studio
bug-fixes are shipped to production. The Cloudflare Studio Worker is scaffolded
(deploy-ready, not yet validated on real infra). Nothing of the v2 *experience* (agentic
loop, editor, persistence, GitHub, deploy) is built yet.

## Phase board

| Phase | Title | Status | Blocked by |
|---|---|---|---|
| — | Studio bug-fixes (tool fires reliably, universal fallback) | ✅ **shipped** (PR #75, merged) | — |
| 0 | [Cloudflare infra](./phases/PHASE-0-infra.md) | ⛔ **blocked** | needs account owner: Workers Paid + wildcard domain |
| 1 | [Studio Worker](./phases/PHASE-1-worker.md) | 🟡 **scaffolded** (PR #76), not validated | Phase 0 to deploy/test |
| 2 | [Railway control plane](./phases/PHASE-2-control-plane.md) | 🟢 **built + verified — in review** (`/api/studio/*`, HMAC, caps, runs) | — |
| 3 | [Studio UI shell](./phases/PHASE-3-studio-ui.md) | 📋 planned — **buildable now** | Phase 2 for live wiring |
| 4 | [Agentic build loop](./phases/PHASE-4-agentic-loop.md) | 📋 planned | Phases 1–3 |
| 5 | [Editor + persistence](./phases/PHASE-5-editor-persistence.md) | 📋 planned | Phase 3 |
| 6 | [GitHub + deploy](./phases/PHASE-6-github-deploy.md) | 📋 planned | Phase 5 |
| 7 | [Per-project backend, polish, mobile](./phases/PHASE-7-backend-polish-mobile.md) | 📋 planned | Phase 6 |
| 8 | [Consolidate runtimes](./phases/PHASE-8-consolidate-runtimes.md) | 📋 planned | Phase 3 |

**Platform workstreams (parallel — improve the whole product, not just the studio):**

| # | Title | Status | Spec |
|---|---|---|---|
| 9 | [Agent system upgrade](./phases/PHASE-9-agent-system.md) (verifier, personality, trace, custom-agent library) | 📋 planned | [10-AGENTS-SWARM](./10-AGENTS-SWARM.md) |
| 10 | [Tools/MCP/sourcing upgrade](./phases/PHASE-10-tools-mcp.md) (tools on all models, managed MCP, outbound MCP) | 📋 planned | [11-TOOLS-MCP-SOURCING](./11-TOOLS-MCP-SOURCING.md) |
| 11 | [Guardrails & personality](./phases/PHASE-11-guardrails-personality.md) (unified voice, output guardrails, code safety) | 📋 planned | [12-GUARDRAILS-PERSONALITY](./12-GUARDRAILS-PERSONALITY.md) |

Legend: ✅ done · 🟡 in progress/partial · 📋 planned · ⛔ blocked

## ➡️ NEXT STEP

**Phase 2 is built + verified and awaiting owner review** (see audit in `CHANGELOG.md`).
After approval, the next phase is **Phase 3 — Studio UI shell** (chat + live-preview-in-
new-tab + "Run live"). Workflow: each phase is built → self-audited → owner reviews →
next phase. Do not start Phase 3 until approved.

**To unblock Phase 0/1 deploy:** the account owner must (a) enable **Workers Paid**,
(b) add a **wildcard preview domain** (e.g. `*.studio.<domain>`), (c) confirm the domain
so the worker config + docs can be updated from the `studio.dreamstream.app` placeholder.

## Open decisions (see linked docs)

| Decision | Default / recommendation | Status |
|---|---|---|
| Preview/deploy domain | `studio.dreamstream.app` (placeholder) | ❓ needs owner |
| Sandbox provider | Cloudflare Containers | ✅ decided |
| Egress from sandbox | allowed | ✅ decided |
| Runtimes in image | Node-only to start | ✅ decided |
| Default build model | strong-open default + frontier via BYOK | ❓ open |
| Per-project backend | SQLite-in-container first, Supabase-per-project later | ❓ open |

## Known risks / honest caveats
- Studio Worker SDK calls are **not yet validated** against a live deploy.
- Self-hosting large models is **out of scope** (cost-prohibitive) — models stay BYOK/API.
- WebContainer (current studio) is desktop-only; Cloudflare path replaces it (Phase 8).
