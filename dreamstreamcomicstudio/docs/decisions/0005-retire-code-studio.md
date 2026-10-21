# 0005 — Retire Code Studio

**Status:** Proposed (owner decided to scrap it; removal awaits the go-ahead on the Ventures question below)

**Decision (owner, 2026-10-21):** scrap Code Studio entirely. This plan lists everything
it touches so removal is one clean change, and — just as important — what must NOT go.
Nothing has been deleted yet; "Your studios" already marks it **Retiring** (admins only).

## Why it's safe to do in one pass
Code Studio is admin-only today (`StaticSiteHeader.tsx` nav; `CodeStudioView.tsx` gate,
or everyone when `VITE_STUDIO_LIVE_ENABLED`). Its runtime is the **`dreamstream-studio`**
Worker (`studio-worker/`): a Cloudflare Containers sandbox (`standard-3`, max 3) serving
previews on `*.dreamstreamstudio.ai/*`. It is **not** Comic Studio's and not Stream
Studio's.

## Remove

| Area | What |
|---|---|
| App shell | `App.tsx` codestudio view, routes, restorable-view entry, product mapping, lazy import |
| Components | `components/studio/**` **except `comic/` and `kit/`**; `components/ui/*` (Code-Studio-only); `workspace/**` (Monaco) |
| Legacy page | `studio/`, `studio.html`, its entry + COOP/COEP plugin in `vite.config.ts`, the `/studio.html` block in `public/_headers` |
| Chat integration | `CodeStudioCard.tsx` **with** its `ARTIFACT_RENDERERS` entry and its `GALLERY_DEMOS` entry (together, or `gallery.coverage.test` fails); `CodeStudioPanel.tsx`; the Code Studio parts of `ChatMessageView.tsx`, `AIChatPlatform.tsx`, `chatUtils.ts`; `CodeStudioArtifact` in `apiTypes.ts` |
| Client services | `studioApi`, `studioBuildApi`, `studioDeployApi`, `studioGenerateApi`, `studioPlanApi`, `studioSuggestApi`, `studioAgentsApi`, `studioAgents`, `studioSessions`, `studioChatHistory`, `studioExport`, `studioRecord`, `studioDeployUrl`, `studioMode`, `studioBackend`, `studioFlags`, `studioHandoff`, `studioLauncher`, `studioCoderAllowlist`, `codingRecommendations`; `studioModelSelection` after updating its importers (`AuthContext.tsx`, `cloudSync.ts`, `DomainLeaderboard.tsx`) |
| Nav / marketing | `StaticSiteHeader.tsx` Code Studio entry; `HomePage.tsx` sections |
| Server | `routes/studio.ts`, `routes/studioGithub.ts` + their mounts in `index.ts`; `services/studio{Worker,Sign,Deploy,BuildService,Caps,Files,Repository,Ids,Github}.ts`; `ai/studio/*` **except** `designSystem.ts` (used by `routes/chat.ts`) and `liveTemplate.ts` (used by `liveTemplateTool.ts`); `ai/tools/codeStudio.ts` + its registry/catalog entries; studio config in `config.ts` |
| Worker + CI | `studio-worker/` and `.github/workflows/deploy-studio-worker.yml` (repo root). **Then in Cloudflare:** delete the `dreamstream-studio` Worker and its `*.dreamstreamstudio.ai/*` route (removing code doesn't delete the deployed Worker) |
| Env | `STUDIO_WORKER_URL` (`api-proxy/wrangler.jsonc`), `STUDIO_HMAC_SECRET` (Worker secret + D1 `backend_env` row), `STUDIO_MAX_CONCURRENT_PER_USER`, `STUDIO_DAILY_BUILD_MINUTES`, `STUDIO_REQUEST_TIMEOUT_MS`, `STUDIO_COST_PER_AWAKE_SEC`, `VITE_STUDIO_LIVE_ENABLED`, `VITE_LEGACY_STUDIO_ENABLED`; docs in `.env.example`, `ENV_MATRIX.md` |
| npm | `@webcontainer/api`, `@monaco-editor/react` |
| SQL | keep the tables for history (`studio_projects`, `studio_runs`, `studio_agents`); optionally drop later |
| Docs | `docs/studio/**`, `studio-worker/README`; mentions in `INFRA_MAP.md`, `COST_RUNBOOK.md`, `ENV_MATRIX.md`, `docs/agent-runtime`, `docs/models/coding-models-2026.md` |
| Tests | `components/studio/*.test.*` (not comic/kit), `workspace/*.test.*`, `assets/techLogos.test.tsx`, `services/studio*.test.ts`, `chatUtils.studioArtifact.test.ts`, `studio/scaffold.test.ts`, `CodeStudioCard.test.tsx`, `server/src/services/studio*.test.ts`, `server/src/ai/studio/*.test.ts` (not designSystem/liveTemplate) |

## Keep (shared — do not remove)
- `components/studio/comic/` and `components/studio/kit/` (Comic Studio; `kit/` is also used by `ConnectorsPage.tsx`).
- `@codesandbox/sandpack-react` (chat code blocks/playgrounds), `cva`, `clsx`, `tailwind-merge`, `jszip`, `lib/utils.ts`.
- `ai/studio/designSystem.ts`, `ai/studio/liveTemplate.ts`.
- `live/studio/*` (Stream Studio), `services/studioDeepLink.ts`, `pageStudio.ts` (Comic Studio).
- The product id `stream_studio` everywhere (Stream Studio's `product_access` key — Code Studio's model usage was mislabeled under it; fix the label in `ModelUsageTrends.tsx`, don't purge the id).
- The `studio` **pricing tier** (`STRIPE_PRICE_ID_STUDIO`, plan `studio`) — a plan name, not Code Studio.
- The `code_studio` waitlist interest value (stored data).

## Blocker to resolve first
**Ventures / Operator Console depends on Code Studio** (`ventures/tickRunner.ts`,
`build.ts`, `routes/ventures.ts` `studioStageComplete`, `controlPlane.ts` uses the
studio tables). Options: (a) retire Ventures' build stage with it, or (b) move the
pieces Ventures needs into `ventures/`. **Owner to choose** before the removal PR.

## Savings
The sandbox Worker on `standard-3` costs nothing idle but spikes when builds run
(see the admin Cost centre once merged — it estimates Code Studio sandbox spend from
`studio_runs`). Removing it also drops the `*.dreamstreamstudio.ai` wildcard route and
two heavy npm deps from the main bundle.
