# OWNER ACTIONS & RESUME LOG

> **Starting a new session? Read this first.** It lists (a) how to resume, (b) everything
> waiting on **you** (the owner), and (c) everything built-but-not-yet-validated — so the
> thread is never lost. This file is updated on every build.

**Last updated:** 2026-06-05 · by Claude (session 012Drsxr…)

---

## ▶️ Resume in a new session (read order)
1. [`AGENTS.md`](./AGENTS.md) — working rules for AI agents.
2. [`00-STATUS.md`](./00-STATUS.md) — phase board + next step.
3. **This file** — what's pending on the owner + deferred validations.
4. [`CHANGELOG.md`](./CHANGELOG.md) — full history of what was done (incl. self-audits).
5. The current phase doc in [`phases/`](./phases/).

- **Branch:** `claude/peaceful-gauss-0Gwni` · **Production:** `Dreamstrream-v1`
- **Supabase project:** `Comic` (`bdjfmxfmhqhzvgrhbbzm`)
- To continue: "read docs/studio/OWNER-ACTIONS.md and 00-STATUS.md, then continue the Studio build."

---

## ⏳ Action needed from YOU (owner) — nothing blocks further building
These only matter when you want the **live container path** actually running. We're
building everything else first and will validate together once these are done.

| # | Action | Why | How | Status |
|---|---|---|---|---|
| O1 | Enable **Cloudflare Workers Paid** ($5/mo) | Containers aren't on Free | Cloudflare dashboard | ⏳ pending |
| O2 | Confirm a **preview domain** (placeholder: `studio.dreamstream.app`) + add proxied wildcard DNS `*.studio.<domain>` | Preview URLs need a wildcard zone (`*.workers.dev` won't work) | Cloudflare DNS | ⏳ pending |
| O3 | **Deploy the Worker** | Runs the AI-built apps | `cd studio-worker` → set `wrangler.jsonc` route → `wrangler secret put STUDIO_HMAC_SECRET` → `wrangler deploy` (Docker running). Full steps: [PHASE-0](./phases/PHASE-0-infra.md) | ⏳ pending |
| O4 | Set Railway env: `STUDIO_WORKER_URL`, `STUDIO_HMAC_SECRET` | Control plane → Worker hop | Railway → API service → Variables → redeploy | ⏳ pending |
| O5 | Apply DB migration `server/sql/studio_runs.sql` | Phase 2 run metering | **I can apply it via Supabase access — just say so**, or run it in the Supabase SQL editor | ⏳ pending (offered) |
| O6 | Review/approve **Phase 2 PR #77** → merge to prod | Ship the control plane | GitHub | ⏳ pending |
| O7 | (Later, Phase 10) optional keys: `TAVILY_API_KEY`/`BRAVE_API_KEY` (search), `FOURSQUARE_API_KEY` (places) | Raise tool sourcing reliability | Railway env | 🔮 future |
| O8 | Set `VITE_STUDIO_LIVE_ENABLED=true` (Cloudflare Pages env) **after** the Worker deploys | Reveals the "Run live" button in chat (hidden by default so prod is unaffected) | Cloudflare Pages → env → rebuild | ⏳ pending |

> Note: `SUPABASE_SERVICE_ROLE_KEY` is **already set in prod** (the image pipeline uses it) — nothing to do.

---

## 🧪 Built but NOT yet live-validated (validate after O1–O4)
| Item | What to validate | From |
|---|---|---|
| Phase 1 Worker | Sandbox SDK calls (writeFile/exec/startProcess/exposePort/stop) on first `wrangler deploy` | [PHASE-1](./phases/PHASE-1-worker.md) |
| Phase 2 control plane | end-to-end launch → preview URL → stop; HMAC cross-process; `studio_runs` writes | [PHASE-2](./phases/PHASE-2-control-plane.md) |
| Phase 3a Run-live UI | "Run live" button (flag-gated) → `/api/studio/launch` → preview opens in a new tab (needs O8 flag + infra) | `components/chat/artifacts/CodeStudioCard.tsx` |

When infra is up: trigger a build in the app → `/api/studio/launch` should return a preview URL that opens the running app.

---

## ❓ Open decisions (need your call sometime)
- **Preview/deploy domain** (O2).
- **Default build/coding model** — recommend strong-open default + frontier via BYOK.
- **Per-project backend** — recommend SQLite-in-container first, Supabase-per-project later.

## ✅ Decided (locked)
- Sandbox = **Cloudflare Containers** · egress **allowed** · runtimes **Node-only to start**
- Models **BYOK / free-first** · **audit-after-each-phase + owner-review-before-next** workflow

---

## 📌 PRs & branches
- ✅ #75 merged (studio bug-fixes) · ✅ #76 merged (docs hub + Worker scaffold)
- 🟢 #77 open/draft — **Phase 2 control plane**, awaiting review (O6)
- Active branch: `claude/peaceful-gauss-0Gwni`

---

_Maintained alongside `00-STATUS.md` + `CHANGELOG.md`. Agents: add any new owner action or
deferred validation here the moment it appears._
