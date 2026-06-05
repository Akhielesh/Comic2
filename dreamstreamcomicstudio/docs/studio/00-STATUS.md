# 00 — STATUS (living tracker)

> **This is the file to check.** It is the authoritative, always-current state of
> DreamStream Studio. Every agent/PR that changes anything **must** update this file and
> `CHANGELOG.md`. If this file and reality disagree, fix this file.

**Last updated:** 2026-06-05 · **Updated by:** Claude (session 012Drsxr…) · **Branch:** `claude/peaceful-gauss-0Gwni`

> Latest: added deep analysis + redesign docs for the **agent swarm** (10), **tools/MCP/
> sourcing** (11), and **guardrails/personality** (12), with parallel workstream phases 9–11.
>
> 🟠 **Owner to-dos + how to resume in a new session →** [`OWNER-ACTIONS.md`](./OWNER-ACTIONS.md)
> (nothing there blocks further building — it's only for going *live*).

---

## Overall progress

```
Foundation  ██████████░░░░░░░░░░  ~50%   (Phase 2 control plane + Phase 3 core shipped to prod)
Experience  ███░░░░░░░░░░░░░░░░░░  ~15%   (Run-live wiring shipped, flag-gated; rest designed)
```

**Where we are:** planning/architecture done + documented. Shipped to prod: studio
bug-fixes, the docs hub, the Worker scaffold, **Phase 2 control plane**, and **Phase 3
core** (Run-live → new tab, flag-gated). Not yet built: persistence (5), agentic loop (4,
needs the Worker), GitHub/deploy (6), and the parallel upgrades (9–11). The Cloudflare
Worker still needs the owner to deploy it before the live path can be validated.

## Phase board

| Phase | Title | Status | Blocked by |
|---|---|---|---|
| — | Studio bug-fixes (tool fires reliably, universal fallback) | ✅ **shipped** (PR #75, merged) | — |
| 0 | [Cloudflare infra](./phases/PHASE-0-infra.md) | ⛔ **blocked** | needs account owner: Workers Paid + wildcard domain |
| 1 | [Studio Worker](./phases/PHASE-1-worker.md) | 🟡 **scaffolded** (PR #76), not validated | Phase 0 to deploy/test |
| 2 | [Railway control plane](./phases/PHASE-2-control-plane.md) | ✅ **shipped to prod** (#77) — `/api/studio/*`, HMAC, caps, runs | — |
| 3 | [Studio UI shell](./phases/PHASE-3-studio-ui.md) | 🟡 **core shipped** (#77) — "Run live → new tab" (flag-gated); in-app log/status pieces **deferred** until the Worker's logs action | needs infra to validate |
| 4 | [Agentic build loop](./phases/PHASE-4-agentic-loop.md) | 📋 planned | Phases 1–3 |
| 5 | [Editor + persistence](./phases/PHASE-5-editor-persistence.md) | 🟢 **persistence backend shipped** — projects/files/versions + CRUD + save-on-launch + RLS; **editor UI deferred** to the live studio shell | — |
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

Phase 2 + Phase 3 core are **shipped to prod** (#77). Remaining work splits in two:
- **Needs the Worker deployed first** (owner infra — see `OWNER-ACTIONS.md`): Phase 3
  in-app logs/status, **Phase 4** agentic build loop (it must read real container errors).
- **Buildable + shippable NOW (no infra):** **Phase 5** persistence (projects/files/
  versions + CRUD), and parallel workstreams **Phase 9** (swarm verifier) / **10** (tools
  on all models + MCP) / **11** (unified persona + output guardrails).

Recommended next (validated value to prod now): **Phase 5 persistence** or a parallel
workstream. **Workflow:** build a full phase → self-audit → **merge it to production**
(`Dreamstrream-v1`), not a preview branch. Sub-phases stay on the branch until done.

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
