# 0005 — Retire Code Studio

**Status:** Accepted (2026-10-22)

**Decision (owner, 2026-10-21; carried out 2026-10-22):** scrap Code Studio entirely, and retire
the Ventures (Autopilot) **build stage** with it. Ventures itself stays: roadmaps, goals, budgets,
checkpoints, signals and the Operator Console keep working; nothing is built automatically.

## Context

Code Studio was admin-only (`StaticSiteHeader.tsx` nav; `CodeStudioView.tsx` gate, or everyone
when `VITE_STUDIO_LIVE_ENABLED`) and barely used: 17 `studio_projects` rows (latest 2026-06-12),
3 `studio_runs` (latest 2026-06-06), 0 `studio_deployments`. Its runtime was the
**`dreamstream-studio`** Worker (`studio-worker/`): a Cloudflare Containers sandbox
(`standard-3`, max 3) serving previews on `*.dreamstreamstudio.ai/*` — the one Cloudflare
resource that could spike the bill. It was not Comic Studio's and not Stream Studio's.

**The Ventures question.** Ventures' tick loop (`ventures/tickRunner.ts`) imported Code Studio's
generator (`runGenerate`) and project repository, and its intake route borrowed
`studioStageComplete` from `routes/studio.ts`. Checked against the code and production before
deciding:

- **The build stage never used the sandbox.** Its ACT step only made LLM calls and wrote
  `studio_projects` rows through `studioRepository.saveProject`. It was also silently broken: it
  built project ids as `` `v_${ventureId}` `` while `studio_projects.id` and
  `venture_goals.project_id` are `uuid`, and the write paths never checked errors, so nothing was
  saved while the goal was still marked shipped.
- **Ventures was never used:** every venture table (`ventures`, `venture_goals`,
  `venture_events`, `venture_checkpoints`, `venture_budgets`, `venture_runs`,
  `venture_connections`) had 0 rows, and no `studio_projects` row had a `venture_id`.
- Production nonetheless had `VENTURES_ENABLED=true` and `VENTURES_PILOT_INLINE=true`, so any
  signed-in user could reach `/api/ventures` and the backend polled for active ventures every 60s
  while awake.

So the owner chose option (a): **retire the build stage with Code Studio**, and move the few lines
intake needed into `ventures/`.

## Decision

### Removed

| Area | What |
|---|---|
| App shell | `App.tsx` `codestudio` view, routes, restorable-view entry, product mapping, lazy import, hand-off store; `StaticSiteHeader.tsx` Code nav (admin entry and "coming soon"); `HomePage.tsx` "Code — coming soon" card, footer link and "Code stays parked" copy |
| Components | `components/studio/**` **except `comic/` and `kit/`** (`CodeStudioView`, `StudioBuildFlow`, `StudioStart`, `StudioWelcome`, `StudioSettingsPanel`, `StudioPlanThinking`, `StudioModeBadge`, `assets/**`, `workspace/**` incl. Monaco); `components/ui/*` (Code-Studio-only) |
| Legacy page | `studio/`, `studio.html`, the `studioIsolation` COOP/COEP plugin + `studio` input in `vite.config.ts`, the `/studio.html` block in `public/_headers`, the `studio` Tailwind palette and content globs, `.studio-composer-glow` in `index.css`, `"studio-worker"` in `tsconfig.json` |
| Chat integration | `CodeStudioCard.tsx` **with** its `ARTIFACT_RENDERERS` entry and its `GALLERY_DEMOS` entry (together, so `gallery.coverage.test` passes), `WIDE_IN_GALLERY` and `widgetStudioMeta` entries; `CodeStudioPanel.tsx`; the Code Studio parts of `AIChatPlatform.tsx`, `ChatMessageView.tsx`, `chatUtils.ts`; the whole `CodeStudio*` / `Studio{Clarify,Answer,Suggest,Plan,BuildPlan}*` type block in `apiTypes.ts` |
| Tools | `ai/tools/codeStudio.ts` (`generate_app`) + its registry entry, `toolCatalog` entry and always-on core slot. The Code Engineer agent, the "Ship-Ready Feature" recipe and the client agent list now use `render_react` (+ `run_python`) instead |
| Client services | `studio{Api,BuildApi,DeployApi,GenerateApi,PlanApi,SuggestApi,AgentsApi,Agents,Sessions,ChatHistory,Export,Record,DeployUrl,Mode,Backend,Flags,Handoff,Launcher,CoderAllowlist,ModelSelection}.ts` and their tests; the Code-Studio-only `keyStatus`, `modelBudget` and `designPresets` (client mirror) modules |
| Server | `routes/studio.ts` (+ `routes/studioGithub.ts`, mounted inside it) and the `/api/studio` mount; `services/studio{Worker,Sign,Deploy,BuildService,Caps,Files,Repository,Ids,Github}.ts` and tests; `ai/studio/*` **except** `designSystem.ts` and `liveTemplate.ts`; the `STUDIO_*` block in `config.ts` |
| Ventures build stage | `ventures/build.ts` (+ test), `ventures/platformComplete.ts`, `controlPlane.linkProjectToVenture`, `VENTURES_BUILD_COST_ESTIMATE_USD`. `runVentureTick` now pauses an active venture once (`pause_reason 'build_retired'`, one `venture.paused` event, no spend); approving a roadmap leaves it paused; `PATCH /:id/status {"status":"active"}` answers **410 `VENTURES_BUILD_RETIRED`**. Intake uses `ventures/intakeModel.ts` (`VENTURES_INTAKE_TIMEOUT_MS`, default 120 s). `noCodeStudioImports.test.ts` keeps Ventures free of Code Studio imports |
| Worker + CI | `studio-worker/` and the repo-root `.github/workflows/deploy-studio-worker.yml` |
| Env | `STUDIO_WORKER_URL` (was in `api-proxy/wrangler.jsonc`), `STUDIO_HMAC_SECRET`, `STUDIO_MAX_CONCURRENT_PER_USER`, `STUDIO_DAILY_BUILD_MINUTES`, `STUDIO_REQUEST_TIMEOUT_MS`, `STUDIO_COST_PER_AWAKE_SEC`, `VITE_STUDIO_LIVE_ENABLED`, `VITE_LEGACY_STUDIO_ENABLED`; `.env.example`, `server/.env.example` and `ENV_MATRIX.md` updated. `VENTURES_ENABLED` and `VENTURES_PILOT_INLINE` set to `"false"` in `wrangler.jsonc` (admins still get into Ventures) |
| npm | `@monaco-editor/react`, `@webcontainer/api` (lockfile pruned) |
| Docs | `docs/studio/**` and `studio-worker/README` — after moving out what stays (below) |

### Kept (shared — do not remove)

- `components/studio/comic/` and `components/studio/kit/` (Comic Studio; `kit/` is also used by
  `ConnectorsPage.tsx`). `kit/theme.ts` still carries a `monaco` theme-name field; harmless.
- `@codesandbox/sandpack-react` (chat code blocks/playgrounds), `class-variance-authority`, `clsx`,
  `tailwind-merge`, `jszip`, `bullmq`, `ioredis` (connector sync), `lib/utils.ts`.
- `ai/studio/designSystem.ts` (chat's MCP source lists via `routes/chat.ts`) and
  `ai/studio/liveTemplate.ts` (`liveTemplateTool.ts`), with their tests.
- `services/codingRecommendations.ts` — the Models leaderboard's coding chips (now "use as your
  text model"; the per-row "Studio" pin is gone).
- `services/studioDeepLink.ts` (+ test) and `services/pageStudio.ts` (Comic Studio);
  `services/studioAccessApi.ts` and `server/src/services/studioAccess.ts` (+ test) — account
  access, not Code Studio. The `code_studio` entry in the account-access model
  (`shared/studioAccess.ts` and its renderers) is removed by the accounts work, not here.
- `deploy/studio-tools/` and `.env.studio-tools.example` — the Nango / video-render / design-MCP
  sidecars chat still uses (relabelled, names kept so deployments don't break), with their docs
  moved to `docs/chat/` (`INTEGRATIONS-NANGO.md`, `INTEGRATIONS-VIDEO.md`,
  `CREDITS-OPEN-DESIGN.md` — the Apache-2.0 attribution for the design presets).
- `docs/studio/autopilot/**` → **`docs/ventures/`** (the Ventures spec; target design, with a
  README saying what works today).
- The product id `stream_studio` everywhere (Stream Studio's `product_access` key). Code Studio
  filed its model usage under it, so `ModelUsageTrends.tsx` labels those rows
  "Code Studio (retired)".
- The `studio` **pricing tier** (`STRIPE_PRICE_ID_STUDIO`, plan `studio`) — a plan name.
- Stored values: `code_studio` in the waitlist (`WaitlistForm.tsx`, `waitlist.ts`,
  `emailStore.ts`) and in `TelemetrySource`; `studios.code` in old cloud-sync snapshots (read as an
  ignored legacy field; sign-out still clears the old `dreamstream_studio_model` key).
- **SQL / data:** the Supabase tables stay as history — `studio_projects`, `studio_files`,
  `studio_versions`, `studio_deployments`, `studio_runs` (the admin Cost centre still reads
  `studio_runs`, labelled "Code Studio sandbox (retired)"), and every venture table. There is
  **no `studio_agents` table**: `server/sql/studio_agents.sql` creates **`custom_agents`** (chat's
  saved agents, `services/customAgents.ts`) — keep that file and **never drop `custom_agents`**.

## Consequences

- One less paid-compute surface: no sandbox Containers, no `*.dreamstreamstudio.ai` wildcard route,
  two heavy npm dependencies and a second Vite entry gone. **Workers Paid stays** — the backend
  container needs it.
- "Build me an app" in chat now lands on `render_react` (a sandboxed single-component preview) or
  complete code blocks with the Sandpack playground; there is no multi-file live workspace.
- Ventures is a planning tool only. Reviving automatic building is a new decision (and a new ADR):
  it would need an ACT step that saves real `uuid` project rows and checks write errors.
- Old `?view=codestudio` links fall back to the home page.

### Owner steps after the merge (Cloudflare / Pages; code cannot do these)

1. Delete the `dreamstream-studio` Worker and its `*.dreamstreamstudio.ai/*` route.
2. Remove the `STUDIO_HMAC_SECRET` Worker secret and the D1 `dreamstream-backend-env` row.
3. Remove the Pages variables `VITE_STUDIO_LIVE_ENABLED` / `VITE_LEGACY_STUDIO_ENABLED` if set.
4. Keep Workers Paid. Supabase: no migration needed.
