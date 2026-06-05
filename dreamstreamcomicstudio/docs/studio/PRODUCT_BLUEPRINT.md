# DreamStream Studio — Product Blueprint (Lovable / Emergent-class)

**Goal:** turn the existing AI chat + comic platform into a professional, AI-centric
**app builder** — describe an app in chat, an agent builds it, it runs live in a
Cloudflare container, and the user can preview it, dive into the code, sync to GitHub,
and deploy — all from any device.

This blueprint covers the **experience layer** (vision, UX, the agentic engine, data
model, integrations, roadmap). The **execution/compute/cost layer** is fully specified
in [`CLOUDFLARE_STUDIO_PLAN.md`](./CLOUDFLARE_STUDIO_PLAN.md) and is referenced, not
repeated.

---

## 1. Positioning — and our honest edge

| | Lovable | Emergent | **DreamStream Studio** |
|---|---|---|---|
| Core | chat → full-stack React+Supabase | autonomous multi-agent full-stack | chat → full-stack, **AI-centric, code optional** |
| Models | hosted (their cost) | GPT/Claude/Gemini (their cost) | **BYOK + free + any OpenRouter/NVIDIA model** ← edge |
| Execution | hosted sandbox | hosted | **Cloudflare containers** (cheap, universal) |
| Multi-agent | Agent Mode | multi-agent orchestration | **agent swarm (already built)** |
| Backend | Supabase | full-stack + DB | Supabase (already wired) |

**Our differentiators (real, not marketing):**
1. **BYOK / free-model first** — users can run it on their own key or free models, so we
   can be dramatically cheaper than Lovable/Emergent (compute is ~cents/session, tokens
   are the user's). Already 96% BYOK in our data.
2. **Cost transparency + metering** — we already have a billing/usage control plane most
   competitors bolt on late.
3. **Multi-model routing + agent swarm** already exist.

**Our positioning sentence:** *"Build and run real apps by chatting with AI — on any
model you want, from any device, for pennies."*

---

## 2. The product in one flow

```
 ┌────────────────────────────────────────────────────────────────────┐
 │  IDEA            BUILD             RUN              SHIP             │
 │  "build me a   → agent plans,    → live preview   → GitHub sync    │
 │   finance        writes files,     in a new tab     + 1-click       │
 │   dashboard"     installs, runs,    (Cloudflare      deploy         │
 │                  reads errors,      container)       (CF Pages)     │
 │                  self-fixes ↺                                        │
 └────────────────────────────────────────────────────────────────────┘
        ▲ chat-centric          ▲ "dive into code" optional at any point
```

---

## 3. Studio UI/UX

**Default view is AI-centric** (chat drives everything); the editor is one click away
for users who want to dive in.

### Desktop layout
```
┌──────────────────────────────────────────────────────────────────────┐
│  ◳ DreamStream Studio   project: finance-dashboard      [GitHub][Deploy]│
├───────────────┬──────────────────────────────┬─────────────────────────┤
│  CHAT (AI)    │  EDITOR (optional)            │  LIVE PREVIEW           │
│               │  ┌─files─┬──Monaco──────────┐ │  ┌────────────────────┐ │
│ user: build…  │  │/src   │ App.tsx          │ │  │  (the running app  │ │
│ ai: planning… │  │ App   │ ...code...       │ │  │   in an iframe от   │ │
│ ai: writing   │  │ api   │                  │ │  │   the container)   │ │
│   App.tsx ✓   │  └───────┴──────────────────┘ │  └────────────────────┘ │
│ ai: npm i ✓   │  [ Code | Terminal | Logs ]   │  ● Live   ↻  ⤢ open tab │
│ ai: running ✓ │                               │                         │
│ ▸ ask / edit  │                               │                         │
├───────────────┴──────────────────────────────┴─────────────────────────┤
│  build status: ● Live   ·   3 files   ·   sleeps in 2:00   ·   ~$0.01   │
└──────────────────────────────────────────────────────────────────────┘
```
- **Left — Chat:** the primary surface. Plan, build, iterate, fix, all by chatting.
- **Middle — Editor (collapsible):** Monaco editor + file tree + terminal + logs. Hidden
  by default (AI-centric); expands when the user wants to "dive into the code."
- **Right — Live preview:** the running app (container preview URL in an iframe), with
  "open in new tab," refresh, and a live/sleeping indicator + running cost.
- **Top bar:** GitHub sync + Deploy.
- **Status bar:** live/sleep state, file count, idle-sleep countdown, running cost.

### Mobile layout (work-from-anywhere)
Tabbed single-column: **Chat ⇄ Preview ⇄ Code**. Preview opens full-screen in a new tab
(the container preview URL works on any device — that's the whole point of server-side
execution).

### Key states to design
`empty → planning → writing files (streamed) → installing → running → live → error →
fixing → live` · plus `sleeping` (idle) and `waking`.

---

## 4. The agentic build engine (the core that makes it feel like Lovable)

Today: one-shot (model emits files once). Target: an **autonomous loop** with the
container in the loop.

```
        ┌──────────────────────────────────────────────────┐
        │                  BUILD AGENT LOOP                  │
        │                                                    │
   user ─►  PLAN ──► WRITE FILES ──► RUN (container) ──┐     │
   intent   │         (stream)        npm i + dev       │     │
        ▲   │                                           ▼     │
        │   └────────── FIX ◄──── OBSERVE (build/runtime errors,
        │                          console, HTTP status, screenshot)
        │                                                    │
        └──────── stop when: app runs clean OR user interjects
        └──────── max N iterations / budget guard
        └──────────────────────────────────────────────────┘
```

**Mechanics:**
- **PLAN:** model produces a short build plan + file list (reuse strong-model routing;
  default a capable coding model, BYOK for frontier).
- **WRITE:** stream files straight into the live container (`writeFile`) → HMR.
- **RUN:** `npm install` + dev server in the container (the Cloudflare plan).
- **OBSERVE:** capture build errors, dev-server logs, runtime console errors, HTTP
  status of the preview, optionally a screenshot. **This is the new capability** — the
  agent *sees* what's broken (today's "Debug with AI" is a blind one-shot).
- **FIX:** feed the errors back; model edits only the broken files; re-run.
- **GUARDS:** max iterations, token/compute budget, and a "stuck" detector that asks the
  user instead of looping.

**Reuse what exists:** the agent **swarm** (`server/src/ai/agents/`) becomes the
multi-step planner/executor; `studio/aiFix.ts` evolves from one-shot into the FIX step
of this loop.

---

## 5. Data model (persistence + versioning)

New Supabase tables (RLS owner-isolated, like existing `projects`):

| Table | Purpose | Key columns |
|---|---|---|
| `studio_projects` | one AI-built app | id, user_id, name, template, github_repo, deploy_url, created_at |
| `studio_files` | current file tree | project_id, path, content, updated_at |
| `studio_versions` | snapshots / history | project_id, label, files (jsonb or storage ref), created_at |
| `studio_runs` | each container session (metering) | project_id, sandbox_id, started_at, ended_at, awake_seconds, cost_usd |
| `studio_deployments` | deploy history | project_id, target, url, status, created_at |

- Files persist to Supabase (small) or R2 (large) so a sleeping/evicted container never
  loses work — the container is disposable, the project is durable.
- Versioning = snapshot files on each successful build (and on demand), so users can
  diff / restore (Lovable parity).

---

## 6. Integrations

- **GitHub two-way sync:** OAuth → create/select repo → commit the file tree → optional
  PR. Pull changes back into the project. (We already use the GitHub API elsewhere.)
- **One-click deploy:** the built app → **Cloudflare Pages/Workers** (we're already on
  Cloudflare) via the Worker, returning a public URL. Later: Vercel/Netlify targets.
- **Per-project backend:** start with SQLite-in-container for app data; offer a
  Supabase-per-project (or shared with RLS) for apps that need real auth/DB — Lovable's
  signature feature.
- **Billing/credits:** extend `usageEnforcer` with `studio.run` (compute) + existing
  token metering; BYOK bypasses token cost.

---

## 7. Roadmap (phased, shippable increments)

| Phase | Deliverable | Depends on |
|---|---|---|
| **0** | Cloudflare infra: Workers Paid, `*.studio.<domain>` wildcard DNS | account owner |
| **1** | **Studio Worker** — container launch/logs/stop + preview URL (scaffolded in this PR) | 0 |
| **2** | Railway `/api/studio/*` control plane (auth + metering + caps) | 1 |
| **3** | Studio UI shell — chat + live preview in a new tab; "Run live" CTA | 2 |
| **4** | **Agentic build loop** (plan→write→run→observe→fix) | 3 |
| **5** | Editor (Monaco) + file tree + persistence/versioning (data model) | 3 |
| **6** | GitHub sync + one-click deploy | 5 |
| **7** | Per-project backend/DB; polish; mobile | 6 |
| **8** | Retire WebContainer + unpkg paths → consolidated runtimes | 3 |

Phases 1–3 are the foundation (well-specified). Phase 4 is the magic. 5–7 reach
Lovable/Emergent parity.

---

## 8. Open inputs needed
1. **Preview/deploy domain** (e.g. `studio.dreamstream.app`) — confirm the zone.
2. Default **coding model** for the build agent (strong-open default + frontier via BYOK?).
3. Per-project backend: **SQLite-in-container first**, Supabase-per-project later? (recommended)
