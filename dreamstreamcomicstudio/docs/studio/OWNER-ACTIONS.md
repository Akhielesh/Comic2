# OWNER ACTIONS & RESUME LOG

> **Starting a new session? Read this first.** It lists (a) how to resume, (b) everything
> waiting on **you** (the owner), and (c) everything built-but-not-yet-validated — so the
> thread is never lost. This file is updated on every build.

**Last updated:** 2026-06-05 · by Claude — added a verified live-state audit (below) + a
built-in CORS fallback for the brand domains.

---

## 🔎 Verified live state (audit 2026-06-05)
Checked the real Cloudflare deployment end-to-end:

| Piece | State |
|---|---|
| Zone `dreamstreamstudio.ai` on Cloudflare | ✅ live — resolves to Cloudflare, Universal SSL/HTTPS works |
| Frontend at apex `dreamstreamstudio.ai` | ✅ live — serves the Comic Studio app (Cloudflare Pages/Assets) |
| Backend API (`comic2-production.up.railway.app`) | ✅ healthy — `/api/health` → `{"status":"ok"}` |
| **Frontend → backend CORS** | 🔴 **was BROKEN** — Railway rejected `https://dreamstreamstudio.ai` (`CORS blocked`). The app loaded but every API call 403'd. Now mitigated by a code fallback (always trusts `*.dreamstreamstudio.ai`/`.com`); still set Railway `CORS_ORIGIN` too — see **OC** below. |
| `www.dreamstreamstudio.ai` | ❌ no DNS record |
| `dreamstreamstudio.com` → `.ai` redirect | ❌ not set up — `.com` doesn't resolve |
| Studio Worker (`dreamstream-studio`) | ❌ not deployed — only an unrelated `atlasd` "hello world" worker exists; `*.dreamstreamstudio.ai` previews don't resolve |

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
| OC | **Set Railway `CORS_ORIGIN`** to include `https://dreamstreamstudio.ai` (comma-sep, e.g. `https://dreamstreamstudio.ai,https://www.dreamstreamstudio.ai`) | The live app's API calls were 403'd by CORS | Railway → API service → Variables → redeploy. *(A code fallback now also always trusts the brand domains, so this is belt-and-suspenders — but still set it so the allowlist is explicit.)* | 🔴 **do this to unblock the live site** |
| O1 | Enable **Cloudflare Workers Paid** ($5/mo) | Containers aren't on Free | Cloudflare dashboard | ⏳ pending (only needed for live previews) |
| O2 | **Add `dreamstreamstudio.ai` to Cloudflare as a zone** (domains bought ✅) | Preview URLs need a real domain's wildcard (`exposePort` rejects `*.workers.dev`). Config is already wired in `wrangler.jsonc` (route `*.dreamstreamstudio.ai/*` + `STUDIO_PREVIEW_DOMAIN`). | Point `dreamstreamstudio.ai` nameservers at Cloudflare; Universal SSL auto-covers `*.dreamstreamstudio.ai`. The worker leaves the bare apex/www free for your real site. | ✅ **done** (verified live 2026-06-05 — zone active, SSL + frontend serving) |
| O2a | **Add a `www.dreamstreamstudio.ai` DNS record** (optional) | `www` currently doesn't resolve | Cloudflare → DNS → add a proxied CNAME `www` → apex (or to the Pages project) | ⏳ pending |
| O2b | **Redirect `dreamstreamstudio.com` → `.ai`** | Use both domains, .com is the catch-all | Add `dreamstreamstudio.com` as a zone → Rules → Redirect Rules → 301 to `concat("https://dreamstreamstudio.ai", http.request.uri.path)` (see worker README) | ⏳ pending (`.com` doesn't resolve yet) |
| O3 | **Deploy the Worker** | Runs the AI-built apps | `cd studio-worker` → `npm install` → `npm run typecheck` → `wrangler login` → `wrangler secret put STUDIO_HMAC_SECRET` → `wrangler deploy` (Docker running). Routes already configured. | ⏳ pending (`dreamstream-studio` not on the account yet) |
| O4 | Set Railway env: `STUDIO_WORKER_URL` (= the **`.workers.dev` control URL** printed by deploy), `STUDIO_HMAC_SECRET` | Control plane → Worker hop (control POSTs don't use the domain) | Railway → API service → Variables → redeploy | ⏳ pending |
| O5 | Apply DB migrations `studio_runs.sql` + `studio_projects.sql` **+ `studio_agents.sql` + `mcp_servers.sql`** | run metering, project persistence, custom-agent library, server-side MCP registry | **I can apply all via Supabase access — just say so**, or run them in the Supabase SQL editor | ⏳ pending (offered) |
| O6 | ~~Review/approve Phase 2 PR #77~~ | control plane shipped | merged to prod 2026-06-05 | ✅ done |
| O7 | (Later, Phase 10) optional keys: `TAVILY_API_KEY`/`BRAVE_API_KEY` (search), `FOURSQUARE_API_KEY` (places) | Raise tool sourcing reliability | Railway env | 🔮 future |
| O8 | Set `VITE_STUDIO_LIVE_ENABLED=true` (Cloudflare Pages env) **after** the Worker deploys | Reveals the "Run live" button in chat (hidden by default so prod is unaffected) | Cloudflare Pages → env → rebuild | ⏳ pending |

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
