# 00 — STATUS (living tracker)

> **This is the file to check.** It is the authoritative, always-current state of
> DreamStream Studio. Every agent/PR that changes anything **must** update this file and
> `CHANGELOG.md`. If this file and reality disagree, fix this file.

**Last updated:** 2026-06-05 · **Updated by:** Claude · **Branch:** `claude/modest-cerf-x3uXx` → prod

> Latest: shipped the backend cores of **four** more phases — **11** (unified persona +
> output guardrails), **9** (swarm verifier + custom-agent library + retry), **10** (JSON
> tool fallback + server-side MCP registry + outbound MCP endpoint), and **6** (GitHub
> two-way sync). Behavior-changing paths are flag-gated; deploy half of 6 still needs the Worker.
>
> 🟠 **Owner to-dos + how to resume in a new session →** [`OWNER-ACTIONS.md`](./OWNER-ACTIONS.md)
> (nothing there blocks further building — it's only for going *live*).

---

## Overall progress

```
Foundation  █████████████░░░░░░░  ~65%   (control plane + persistence + GitHub sync shipped)
Experience  ████░░░░░░░░░░░░░░░░░  ~20%   (Run-live flag-gated; platform AI upgrades 9/10/11 backends shipped)
```

**Where we are:** planning/architecture done. Shipped to prod: studio bug-fixes, the docs
hub, the Worker scaffold, **Phase 2** control plane, **Phase 3 core** (Run-live, flag-
gated), **Phase 5** persistence backend, the platform workstreams **9/10/11** (backends),
and **Phase 6** GitHub sync. Still infra-blocked on the owner deploying the Cloudflare
Worker: **Phase 4** (agentic loop), Phase 3 in-app logs, and Phase 6 **one-click deploy**.

## Phase board

| Phase | Title | Status | Blocked by |
|---|---|---|---|
| — | Studio bug-fixes (tool fires reliably, universal fallback) | ✅ **shipped** (PR #75, merged) | — |
| 0 | [Cloudflare infra](./phases/PHASE-0-infra.md) | ⛔ **blocked** | owner: Workers Paid + **a custom domain (now confirmed REQUIRED)** |
| 1 | [Studio Worker](./phases/PHASE-1-worker.md) | 🟡 **scaffolded + typechecks vs real SDK 0.4.18** (fixed `exposePort`, added `logs`), not live-validated | Phase 0 (domain + deploy) |
| 2 | [Railway control plane](./phases/PHASE-2-control-plane.md) | ✅ **shipped to prod** (#77) — `/api/studio/*`, HMAC, caps, runs | — |
| 3 | [Studio UI shell](./phases/PHASE-3-studio-ui.md) | 🟡 **core shipped** (#77) — "Run live → new tab" (flag-gated); in-app log/status pieces **deferred** until the Worker's logs action | needs infra to validate |
| 4 | [Agentic build loop](./phases/PHASE-4-agentic-loop.md) | 📋 planned | Phases 1–3 |
| 5 | [Editor + persistence](./phases/PHASE-5-editor-persistence.md) | 🟢 **persistence backend shipped** — projects/files/versions + CRUD + save-on-launch + RLS; **editor UI deferred** to the live studio shell | — |
| 6 | [GitHub + deploy](./phases/PHASE-6-github-deploy.md) | 🟢 **GitHub sync shipped** — `/api/studio/github/{repos,push,pull}` (atomic two-way, transient token); **one-click deploy deferred** (needs the Worker — honest 501) | deploy needs Worker |
| 7 | [Per-project backend, polish, mobile](./phases/PHASE-7-backend-polish-mobile.md) | 📋 planned | Phase 6 |
| 8 | [Consolidate runtimes](./phases/PHASE-8-consolidate-runtimes.md) | 📋 planned | Phase 3 |

**Platform workstreams (parallel — improve the whole product, not just the studio):**

| # | Title | Status | Spec |
|---|---|---|---|
| 9 | [Agent system upgrade](./phases/PHASE-9-agent-system.md) (verifier, personality, trace, custom-agent library) | 🟢 **backend + trace UI shipped** — verifier (confidence+flags, now shown on the SwarmTraceCard), retry, persona routing, `custom_agents` library + `/api/agents`; **live SSE / re-run / library UI deferred** | — |
| 10 | [Tools/MCP/sourcing upgrade](./phases/PHASE-10-tools-mcp.md) (tools on all models, managed MCP, outbound MCP) | 🟢 **backend + marketplace UI shipped** — JSON tool fallback (flag-gated), server-side MCP registry, **curated marketplace (one-click connect in ToolsDashboard)**, outbound MCP endpoint; **OAuth/streaming MCP + localStorage→server migration deferred** | — |
| 11 | [Guardrails & personality](./phases/PHASE-11-guardrails-personality.md) (unified voice, output guardrails, code safety) | 🟢 **shipped** — unified `persona.ts` everywhere + output `guardrails.ts` (leak/fabrication/citation) wired + audit log; **studio code-safety + trust-chip UI deferred** | — |

Legend: ✅ done · 🟡 in progress/partial · 📋 planned · ⛔ blocked

## ➡️ NEXT STEP

The studio **backend is substantially complete** and the platform AI upgrades (9/10/11)
+ GitHub sync (6) are shipped. What's left splits in two:

- **Needs the Worker deployed first** (owner infra — see `OWNER-ACTIONS.md`): **Phase 4**
  agentic build loop (the "magic" — must read real container errors), Phase 3 in-app
  logs/status, and Phase 6 **one-click deploy**.
- **Buildable now without infra (mostly client UI + opt-in flips):**
  - **Client surfaces** for the new backends: the swarm trace card (show confidence/flags
    + re-run an agent), the agent-library UI (`/api/agents`), the MCP dashboard
    (`/api/mcp` registry + curated catalog), GitHub/Deploy menus (`/api/studio/github/*`).
  - **Flip on / harden the opt-in features:** validate the JSON tool protocol on a free
    model then set `JSON_TOOL_PROTOCOL_ENABLED=true`; set `MCP_OUTBOUND_TOKEN` to enable
    the outbound MCP endpoint. Add the model-based critic + live per-agent SSE.

**Workflow:** build a full phase → self-audit → **merge it to production** (`Dreamstrream-v1`),
not a preview branch. Sub-phases stay on the branch until done.

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
