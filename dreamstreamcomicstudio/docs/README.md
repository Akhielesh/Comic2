# DreamStream Comic Studio — Documentation

This folder is the source of truth for how the system is built, why decisions
were made, and how problems were solved. It exists so a human **or a future AI
agent** can get oriented quickly and avoid re-deriving context.

## How docs are organized

| Path | What lives here | When to add/update |
|------|-----------------|--------------------|
| `VISION.md` | Long-term product vision, Connector Standard (3 lanes), Google-services phased plan + costs, prioritized roadmap. | When long-term product direction or priorities change. |
| `launch/JUNE_25_STREAM_STUDIO_MVP.md` | **Active June 25 launch source of truth:** Stream Studio wedge, ICP, cuts, blockers, smoke checklist, approval guardrails. | Every launch-scope/product-positioning change until the beta is proven. |
| `launch/STREAM_STUDIO_SYSTEM_MAP.md` | Stream Studio system/infra/data-flow map: app routes, worker API, Durable Object/R2, Supabase sync, route blockers, smoke path. | When changing Stream Studio routes, worker config, account sync, or launch smoke checks. |
| `launch/STREAM_STUDIO_READINESS_REPORT.md` | Current granular launch-readiness report: status, blockers, risks, approvals, and prioritized remediation roadmap. | When briefing the council/user or changing launch go/no-go status. |
| `ARCHITECTURE.md` | System overview: frontend, backend, data, AI gateway, billing, deploy. | When a major module or data flow changes. |
| `decisions/` | **ADRs** (Architecture Decision Records) — one file per significant decision, numbered. | Whenever you make a non-obvious, hard-to-reverse, or cross-cutting choice. |
| `SOLUTION_LOG.md` | Chronological **problem → root cause → fix** log, with files + commit. | Every time you fix a real bug or land a feature worth explaining later. |
| `features/` | One doc per feature: what it does, key files, flows, gotchas. | When you ship or materially change a feature. |
| `email/` | Transactional + newsletter email (Cloudflare Email Sending): cost/limits, setup, security, design previews. | When email templates, routes, or the worker change. |
| `production/` | Runbooks, go-live checklist, alerting, scaling (pre-existing). | Ops changes. |
| `OVERHAUL_PLAN.md` | The original product/tech overhaul strategy (historical context). | Read-only history. |
| `ai_flow_documentation.md` | Deep dive on the AI generation pipeline. | When the pipeline changes. |
| `RAILWAY_DEPLOY.md` / `OPENROUTER_TESTING.md` | Backend deploy + OpenRouter testing guides. | When deploy/testing steps change. |

### Feature docs (`features/`)

| Doc | What it covers |
|-----|----------------|
| `features/component-library.md` | The chat widget system end to end: artifact pipeline, calm-studio design language, Primitive Kit API, dual density, resize, theming, full artifact-type table, add-a-widget checklist. |
| `features/live-widgets.md` | Live data in widgets: origin stamping, `REFRESHABLE_TOOLS`, the `/api/chat/tool-refresh` contract, `useLiveData()`, and the NewsDigest topic-chip refresh pattern. |
| `features/voice-dictation.md` | On-device voice dictation: recorder → 16 kHz PCM → transformers.js Whisper (WebGPU/WASM), engines + fallback, 4 s live partials, model self-hosting, UI states, failure modes. |
| `features/guided-learning.md` | Guided learning: the `create_learning_path` tool, `LearningPathArtifact`, the progress-tracked course card, `/learn` skill + recipe, composition with quiz/flashcards/exercises, study-mode auto-detection. |
| `features/travel-planner.md` | Travel planner: the `plan_trip` tool (coercion, Nominatim + Open-Meteo enrichment), `ItineraryArtifact`, the day-tabbed itinerary card, `/trip` skill + recipe, related tools and travel MCPs. |
| `features/mcp-directory.md` | MCP support: per-user registry + SSRF guards, `/api/mcp` routes, tool proxying into the agentic loop, the 13-entry curated catalog, marketplace UI, and the outbound `/api/connect/mcp` endpoint. |
| `features/comic-studio.md` | The finalized comic creation flow: Story/Cast/Pages stages, Phase 0 auto style anchor + reference sheets, soft gates, models, sharing. (ADR 0004 removed ComicForge + Test Lab.) |

## Conventions

- **ADRs** are immutable once `Accepted`. To change a decision, add a new ADR
  that supersedes the old one (note it in both). See `decisions/README.md`.
- **SOLUTION_LOG** entries are append-only and dated. Newest at the top.
- Keep docs **close to the truth in code** — link to `file:line` where useful and
  prefer updating a doc in the same change that alters the behavior.
- Top-level `CHANGELOG.md` (in the app root) tracks user-facing changes per release.

## Quick orientation for a new agent

1. Read `ARCHITECTURE.md` for the lay of the land.
2. Skim `decisions/` newest-first to learn *why* things are the way they are.
3. Check `SOLUTION_LOG.md` for recent fixes and known sharp edges.
4. For a specific feature, open its file under `features/`.
