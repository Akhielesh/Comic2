# OWNER ACTIONS & RESUME LOG

> **Starting a new session? Read this first.** It lists (a) how to resume, (b) everything
> waiting on **you** (the owner), and (c) everything built-but-not-yet-validated — so the
> thread is never lost. This file is updated on every build.

**Last updated:** 2026-06-05 · by Claude — **infra is LIVE.** Worker deployed, wildcard DNS
up, CORS fixed (verified), all 4 studio migrations applied. Remaining owner items are small.

---

## 🔎 Verified live state (audit + deploy 2026-06-05)
Checked the real deployment end-to-end and brought the infra up:

| Piece | State |
|---|---|
| Zone `dreamstreamstudio.ai` on Cloudflare | ✅ live — resolves to Cloudflare, Universal SSL/HTTPS works |
| Frontend at apex `dreamstreamstudio.ai` | ✅ live — serves the Comic Studio app (Cloudflare Pages/Assets) |
| Backend API (`comic2-production.up.railway.app`) | ✅ healthy — `/api/health` → `{"status":"ok"}` |
| **Frontend → backend CORS** | ✅ **FIXED + verified** — backend now always trusts `*.dreamstreamstudio.ai`/`.com` over HTTPS (code fallback in `server/src/config.ts` `isAllowedOrigin()`). `https://dreamstreamstudio.ai` now gets `access-control-allow-origin` (was 403). |
| Studio Worker (`dreamstream-studio`) | ✅ **deployed** to Cloudflare (container image built + pushed) |
| Wildcard preview DNS (`*.dreamstreamstudio.ai`) | ✅ **resolves to Cloudflare** (proxied `A * → 192.0.2.0`); preview hosts route to the worker |
| HMAC secret (worker + Railway) | ✅ set on both (owner) |
| Studio DB tables | ✅ **applied** — `studio_runs`, `studio_projects`, `studio_files`, `studio_versions`, `studio_deployments`, `custom_agents`, `mcp_servers` (all RLS-enabled; advisors clean) |
| `www.dreamstreamstudio.ai` | ⚠️ optional — not set up yet |
| `dreamstreamstudio.com` → `.ai` redirect | ⚠️ optional — not set up yet |
| `VITE_STUDIO_LIVE_ENABLED` (Pages) | ❓ owner to confirm — reveals the "Run live" button |
| Live launch round-trip | ⏳ not yet exercised — needs a signed-in user to trigger `/api/studio/launch` |

> **Architecture reminder:** this is a *hybrid* — frontend on **Cloudflare**, API on **Railway**,
> DB/auth on **Supabase**. Not literally "all on Cloudflare," and that's by design.

---

## ▶️ Resume in a new session (read order)
1. [`AGENTS.md`](./AGENTS.md) — working rules for AI agents.
2. [`00-STATUS.md`](./00-STATUS.md) — phase board + next step.
3. **This file** — what's pending on the owner + deferred validations.
4. [`CHANGELOG.md`](./CHANGELOG.md) — full history of what was done (incl. self-audits).
5. The current phase doc in [`phases/`](./phases/).

- **Branch:** `claude/modest-cerf-x3uXx` · **Production:** `Dreamstrream-v1`
- **Supabase project:** `Comic` (`bdjfmxfmhqhzvgrhbbzm`)
- To continue: "read docs/studio/OWNER-ACTIONS.md and 00-STATUS.md, then continue the Studio build."

---

## ⏳ Action needed from YOU (owner) — nothing blocks further building
These only matter when you want the **live container path** actually running. We're
building everything else first and will validate together once these are done.

| # | Action | Why | How | Status |
|---|---|---|---|---|
| OC | **Set Railway `CORS_ORIGIN`** (optional now) | The live app's API calls were 403'd by CORS | Railway → Variables. | ✅ **resolved in code** — `isAllowedOrigin()` always trusts the brand domains; verified live. Setting the env var is now optional. |
| O1 | Enable **Cloudflare Workers Paid** ($5/mo) | Containers aren't on Free | Cloudflare dashboard | ✅ **done** (worker deployed = paid plan active) |
| O2 | **Add `dreamstreamstudio.ai` to Cloudflare as a zone** | Preview URLs need a real domain's wildcard. | Zone + Universal SSL. | ✅ **done** (verified live — zone active, SSL + frontend serving) |
| O2a | **Add a `www.dreamstreamstudio.ai` DNS record** (optional) | `www` doesn't resolve | Cloudflare Pages → Custom domains → add `www…` (auto-creates DNS), **or** a redirect rule www → apex | ⚠️ optional, pending |
| O2b | **Redirect `dreamstreamstudio.com` → `.ai`** (optional) | Use both domains | Add `.com` as a zone → Redirect Rules → 301 to `concat("https://dreamstreamstudio.ai", http.request.uri.path)` | ⚠️ optional, pending |
| O3 | **Deploy the Worker** | Runs the AI-built apps | `wrangler deploy` (Docker + Workers Paid) | ✅ **done** — `dreamstream-studio` live on the account (image built + pushed) |
| O3a | **Wildcard preview DNS** `A * → 192.0.2.0` (proxied) | Without it `*.dreamstreamstudio.ai` is NXDOMAIN and previews can't route | Cloudflare → DNS | ✅ **done** — preview hosts resolve to Cloudflare |
| O4 | Set Railway env: `STUDIO_WORKER_URL` (= the `.workers.dev` control URL), `STUDIO_HMAC_SECRET` | Control plane → Worker hop | Railway → Variables → redeploy | ✅ `STUDIO_HMAC_SECRET` set; confirm `STUDIO_WORKER_URL` is set too |
| O5 | Apply DB migrations (`studio_runs`, `studio_projects`, `studio_agents`/`custom_agents`, `mcp_servers`) | run metering, project persistence, custom-agent library, MCP registry | Applied via Supabase access | ✅ **done** — 7 tables live, RLS on, advisors clean |
| O6 | ~~Review/approve Phase 2 PR #77~~ | control plane shipped | merged to prod 2026-06-05 | ✅ done |
| O7 | (Later, Phase 10) optional keys: `TAVILY_API_KEY`/`BRAVE_API_KEY`, `FOURSQUARE_API_KEY` | Raise tool sourcing reliability | Railway env | 🔮 future |
| O8 | Set `VITE_STUDIO_LIVE_ENABLED=true` (Cloudflare Pages env) | Reveals the "Run live" button in chat | Cloudflare Pages → env → rebuild | ❓ owner to confirm |

> Note: `SUPABASE_SERVICE_ROLE_KEY` is **already set in prod** (the image pipeline uses it) — nothing to do.

---

## 🧪 Built but NOT yet live-validated (validate after O1–O4)
| Item | What to validate | From |
|---|---|---|
| Phase 1 Worker | **Now typechecks against the real SDK (0.4.18)** — fixed the non-existent `tunnels.get` → `exposePort`, added the `logs` action, pinned the Docker image. Still validate the live container round-trip on first `wrangler deploy` | [PHASE-1](./phases/PHASE-1-worker.md) |
| Phase 2 control plane | end-to-end launch → preview URL → stop; HMAC cross-process; `studio_runs` writes | [PHASE-2](./phases/PHASE-2-control-plane.md) |
| Phase 3a Run-live UI | "Run live" button (flag-gated) → `/api/studio/launch` → preview opens in a new tab (needs O8 flag + infra) | `components/chat/artifacts/CodeStudioCard.tsx` |
| Phase 5 persistence | save-on-launch writes project+files+version; `/api/studio/projects` list/get/delete (needs `studio_projects.sql` applied + a build to fire) | `services/studioRepository.ts` |

When infra is up: trigger a build in the app → `/api/studio/launch` should return a preview URL that opens the running app.

---

## ❓ Open decisions (need your call sometime)
- **Brand + domain** — ✅ **DECIDED + bought:** `dreamstreamstudio.ai` (primary) +
  `dreamstreamstudio.com` (→ 301 to `.ai`). Studio previews live on
  `*.dreamstreamstudio.ai`; the worker leaves the apex/www free for the real site. All wired
  in `wrangler.jsonc`. Remaining = the Cloudflare dashboard steps O2/O2b/O3.
- **Default build/coding model** — recommend strong-open default + frontier via BYOK.
- **Per-project backend** — recommend SQLite-in-container first, Supabase-per-project later.

## ✅ Decided (locked)
- Sandbox = **Cloudflare Containers** · egress **allowed** · runtimes **Node-only to start**
- Models **BYOK / free-first** · **audit-after-each-phase + owner-review-before-next** workflow

---

## 📌 PRs & branches
- ✅ #75 merged (studio bug-fixes) · ✅ #76 merged (docs hub + Worker scaffold)
- ✅ #77 merged — **Phase 2 control plane + Phase 3a** Run-live wiring
- Active branch: `claude/peaceful-gauss-0Gwni`
- **Workflow:** completed phases now merge straight to **production** (`Dreamstrream-v1`);
  sub-phases stay on the branch. Everything ships safe-by-default (flag-gated / no-op
  until configured).

---

_Maintained alongside `00-STATUS.md` + `CHANGELOG.md`. Agents: add any new owner action or
deferred validation here the moment it appears._
