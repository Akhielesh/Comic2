# 03 — Architecture

## System overview

```
 ┌──────────────────────── CLIENT (React/Vite, any device) ───────────────────────┐
 │  Studio UI:  Chat  │  Editor (Monaco, optional)  │  Live Preview (iframe)        │
 └───────┬───────────────────────────┬───────────────────────────┬─────────────────┘
         │ /api/chat (SSE)            │ /api/studio/* (control)    │ preview URL (direct)
         ▼                            ▼                            │
 ┌───────────────── BACKEND (Express on Railway) ──────────────┐  │
 │  chat + agentic build loop      studio control plane         │  │
 │  · runChat / swarm              · /studio/launch|stop|logs   │  │
 │  · tools (generate_app …)       · auth + usageEnforcer       │  │
 │  · model routing (BYOK/free)    · concurrency/idle caps      │  │
 │                                 · HMAC-signs → Worker        │  │
 └───────┬─────────────────────────────────┬───────────────────┘  │
         │ models (BYOK/free)               │ HMAC                  │
         ▼                                  ▼                       │
 ┌───────────────┐            ┌──────── STUDIO WORKER (Cloudflare) ─────────┐      │
 │ OpenRouter /  │            │ Durable Object ⇄ Container (Sandbox SDK)     │      │
 │ NVIDIA / etc. │            │ writeFile → npm install → dev server         │──────┘
 │ (per-token)   │            │ exposePort → tokenized preview URL           │
 └───────────────┘            └─────────────────────────────────────────────┘
         ▲                                  │
         │                                  ▼ persist files (durable)
 ┌───────────────────────── DATA ──────────────────────────────────────────┐
 │ Supabase: auth, Postgres (projects/files/versions/runs), Storage/R2      │
 │ Redis (BullMQ) for the comic pipeline queues                              │
 └──────────────────────────────────────────────────────────────────────────┘
```

## Components & responsibilities

| Component | Tech | Responsibility |
|---|---|---|
| **Studio UI** | React 19, Vite, Tailwind | chat, editor, live preview, deploy/GitHub controls |
| **Chat + build agent** | Express, TS, OpenRouter/NVIDIA | run the agentic loop; call tools; route models |
| **Studio control plane** | Express route `/api/studio/*` | authenticate, meter, rate-limit, HMAC-sign to Worker |
| **Studio Worker** | Cloudflare Worker + Durable Object + Container | run AI-built apps; return preview URL; logs; stop |
| **Data** | Supabase (Postgres + Storage), R2, Redis | projects/files/versions/runs/deploys; outputs; queues |
| **Models** | OpenRouter / NVIDIA / Gemini | inference (BYOK / free-first) |

## Two control planes, one data plane (key design)
- **Control plane (low-frequency, must be metered):** browser → Railway → Worker. Every
  launch/stop/iteration is authenticated + metered via `usageEnforcer`, then HMAC-signed
  to the Worker. The Worker trusts only Railway.
- **Data plane (high-frequency, no metering):** the browser talks **directly** to the
  container's tokenized preview URL. Railway is never in the app-traffic path.

Why: keeps cost control + auth on the cheap path, and keeps app traffic fast/direct.

## Request flows

### A. "Build me an app" (happy path)
```
1. user → /api/chat (SSE)            2. build agent: PLAN → WRITE files
3. agent → /api/studio/launch        4. Railway: auth + reserve usage → HMAC → Worker
5. Worker: writeFile → npm install → dev → exposePort → previewUrl
6. previewUrl streamed back to UI → live preview iframe + "open in new tab"
7. agent OBSERVES errors (logs/console/HTTP) → FIX → re-run (loop)  [Phase 4]
8. on idle: container auto-sleeps (billing stops); files persisted to Supabase/R2
```

### B. Iterate on an existing app
```
user edits via chat or editor → write changed files into the SAME awake container
→ Vite HMR updates the preview instantly → no new boot, no new install (unless deps change)
```

### C. Deploy
```
user clicks Deploy → Railway → Worker builds → publish to Cloudflare Pages/Workers
→ public URL saved to studio_deployments → shown in UI            [Phase 6]
```

## Security model
- Worker accepts **only** HMAC-signed requests from Railway (`STUDIO_HMAC_SECRET`).
- Sandbox IDs are **scoped per user** (`u_<userId>_<projectId>`) — no cross-user access.
- Preview URLs carry an unguessable token; optional app-level auth on top.
- Containers are isolated (microVM-class); **egress allowed** but **our secrets are never
  injected** into the container.
- Resource/abuse caps: instance size, `max_instances`, idle-sleep, max session, per-user
  concurrency, daily build-minute cap (in the control plane).

## Environments / deploy targets
- **Frontend:** Cloudflare Pages (from `Dreamstrream-v1`).
- **Backend:** Railway (Express).
- **Studio Worker:** Cloudflare (`wrangler deploy` from `studio-worker/`) — **separate** deploy.
- **DB/Storage:** Supabase (project `Comic` = `bdjfmxfmhqhzvgrhbbzm`) + optional R2 for outputs.

## Tech decisions (and why)
| Decision | Choice | Rationale |
|---|---|---|
| Sandbox | Cloudflare Containers (Sandbox SDK) | cheapest at scale; already on Cloudflare; purpose-built |
| Models | BYOK / free-first | cost edge; users own token spend |
| Image outputs | WebP in Supabase Storage → migrate to R2 | R2 has free egress (image-heavy) |
| Editor | Monaco | industry standard; rich features |
| Persistence | Supabase tables + storage | reuse existing backbone + RLS |
| Runtime consolidation | drop WebContainer + unpkg (Phase 8) | one coherent runtime, universal devices |
