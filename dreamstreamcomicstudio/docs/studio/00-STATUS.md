# 00 — STATUS (living tracker)

> **This is the file to check.** It is the authoritative, always-current state of
> DreamStream Studio. Every agent/PR that changes anything **must** update this file and
> `CHANGELOG.md`. If this file and reality disagree, fix this file.

**Last updated:** 2026-06-05 · **Updated by:** Claude · **Branch:** `claude/wizardly-allen-k6OdD` → prod

> Latest: **INFRA IS LIVE.** The Cloudflare Studio Worker (`dreamstream-studio`) is deployed,
> the wildcard preview DNS resolves, the **CORS break that made the live site non-functional is
> fixed + verified**, and all **4 studio DB migrations are applied** (7 tables, RLS on). The main
> comic app at `dreamstreamstudio.ai` works end-to-end again. Phase 0 (infra) is **done**; the
> studio control path is wired and ready for a live launch round-trip.
>
> 🟢 **Owner to-dos (now small) + how to resume →** [`OWNER-ACTIONS.md`](./OWNER-ACTIONS.md).

---

## Overall progress

```
Foundation  ██████████████████░░  ~90%   (infra LIVE: worker + DNS + DB migrations + CORS fix; control plane + persistence + GitHub sync shipped)
Experience  █████░░░░░░░░░░░░░░░░  ~25%   (Run-live wired end-to-end; platform AI 9/10/11 backends shipped, client UIs partial)
```

**Where we are:** infra is **live** (Cloudflare Worker deployed, wildcard preview DNS up,
studio tables migrated, CORS fixed + verified). Shipped to prod: studio bug-fixes, the docs
hub, the Worker, **Phase 2** control plane, **Phase 3 core** (Run-live, flag-gated),
**Phase 5** persistence backend, platform workstreams **9/10/11** (backends), and
**Phase 6** GitHub sync. **No longer infra-blocked** — the next builds (Phase 4 agentic loop,
Phase 3 in-app logs, Phase 6 one-click deploy) can now run against the live worker. Remaining
to fully *exercise*: a signed-in launch round-trip + the `VITE_STUDIO_LIVE_ENABLED` flag.

## Phase board

| Phase | Title | Status | Blocked by |
|---|---|---|---|
| — | Studio bug-fixes (tool fires reliably, universal fallback) | ✅ **shipped** (PR #75, merged) | — |
| 0 | [Cloudflare infra](./phases/PHASE-0-infra.md) | ✅ **done** — Workers Paid, `dreamstreamstudio.ai` zone + SSL, worker deployed, wildcard preview DNS, DB migrations applied, CORS fixed | — |
| 1 | [Studio Worker](./phases/PHASE-1-worker.md) | ✅ **deployed** (`dreamstream-studio` live) — control plane + preview routing wired; live launch round-trip not yet exercised | needs a signed-in launch to validate |
| 2 | [Railway control plane](./phases/PHASE-2-control-plane.md) | ✅ **shipped to prod** (#77) — `/api/studio/*`, HMAC, caps, runs | — |
| 3 | [Studio UI shell](./phases/PHASE-3-studio-ui.md) | 🟡 **core shipped** (#77) — "Run live → new tab" (flag-gated); in-app log/status pieces **deferred** until the Worker's logs action | needs infra to validate |
| 4 | [Agentic build loop](./phases/PHASE-4-agentic-loop.md) | 🟢 **backend complete** — observation parser + guards + orchestrator + FIX stage + coding router + worker RUN capability + FIX-output guardrails + guard-railed fix dep (~50 tests). Only the `/api/studio/build` SSE route (compose the deps + auth-scoped `complete`) + `BuildTrace` client remain | route + UI want a signed-in validation |
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

Infra is live, so the previously-blocked phases are now buildable. Priority order:

1. **Phase 4 — agentic build loop** (the "magic"): on launch, read the container's real
   install/dev errors (the worker's `logs` action) and let the model self-correct across a
   bounded retry loop. This is the core differentiator and was the main thing infra blocked.
2. **Phase 3 — in-app logs/status**: stream the worker's `logs` into the studio panel +
   live run status (starting/live/error), now that the worker exposes them.
3. **Phase 6 — one-click deploy**: the `/api/studio/github/*` two-way sync is shipped; wire
   the deploy target (was an honest 501) now that the worker can build/push.
4. **Client surfaces** for shipped backends: swarm-trace re-run, custom-agent library UI
   (`/api/agents`), MCP dashboard (`/api/mcp`), GitHub/Deploy menus.

**Also to fully exercise the live path:** confirm `VITE_STUDIO_LIVE_ENABLED=true` on Pages,
then run a signed-in launch → preview round-trip to validate Phase 1 end-to-end.

**Workflow:** build a full phase → self-audit → **merge it to production** (`Dreamstrream-v1`),
not a preview branch. Sub-phases stay on the branch until done.

## Open decisions (see linked docs)

| Decision | Default / recommendation | Status |
|---|---|---|
| Preview/deploy domain | `*.dreamstreamstudio.ai` (live) | ✅ decided + deployed |
| Sandbox provider | Cloudflare Containers | ✅ decided |
| Egress from sandbox | allowed | ✅ decided |
| Runtimes in image | Node-only to start | ✅ decided |
| Default build model | strong-open default + frontier via BYOK | ❓ open |
| Per-project backend | SQLite-in-container first, Supabase-per-project later | ❓ open |

## Known risks / honest caveats
- Studio Worker is **deployed** and typechecks against SDK 0.4.18, but the full live
  **launch → preview → stop** round-trip hasn't been exercised by a signed-in user yet.
- Self-hosting large models is **out of scope** (cost-prohibitive) — models stay BYOK/API.
- WebContainer (current studio) is desktop-only; Cloudflare path replaces it (Phase 8).
