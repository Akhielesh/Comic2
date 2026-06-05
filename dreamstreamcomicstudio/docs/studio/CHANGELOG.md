# CHANGELOG — DreamStream Studio

Append-only. Newest first. Every agent/PR records what it did here so the next agent can
pick up cold. Format: date · author · summary · files · follow-ups.

---

## 2026-06-05 · Claude — Phase 4: shared Studio Worker client + run-result bridge
- `server/src/services/studioWorker.ts` — single signed worker client (`callStudioWorker`,
  `studioConfigured`) + a pure `toRunResult` mapping the worker's launch/logs/preview-probe
  signals into the `RunResult` the observation parser consumes.
- Refactored `routes/studio.ts` to use it — removed the duplicated `callWorker`/`notConfigured`
  (DRY; one place owns HMAC signing + timeout).
- Tests: `studioWorker.test.ts` (mapping + end-to-end into `buildObservation`). Suite 361 green.
- Next: the `/api/studio/build` SSE route composing `runBuildAgent` with `callStudioWorker`
  (run) + the platform AI client (fix), then the `BuildTrace` client.

## 2026-06-05 · Claude — Phase 4 agentic build loop: deterministic core + coding router
Built the logic-heavy half of the agentic build loop, fully unit-tested ahead of the live
route (so it ships safely with zero behavior change — nothing calls it yet):
- `server/src/ai/studio/observation.ts` — raw container signals (install stderr, Vite/TS
  compile output, runtime console errors, preview HTTP status) → structured
  `BuildObservation` (classified errors, unresolved module + `file:line:col`, stable
  signature). Priority install → dev → runtime → http.
- `buildGuards.ts` — loop termination: clean / iteration-cap / **stuck → ask the user**.
- `buildAgent.ts` — `runBuildAgent` PLAN→RUN→OBSERVE→FIX orchestrator (DI'd run+fix, stage
  event trace for the live panel).
- `studioFix.ts` — server-side FIX: observation-driven minimal-diff prompt + tolerant JSON
  parse (injected model call).
- `autoRouter.ts` — `pickCodingModel` + `prefersCodingModel` route the FIX stage to strong
  coding models (free-first; `quality` for BYOK).
- Tests: observation/guards/buildAgent/studioFix/coding-router — **39 new cases, all green.**
- **Next (live slice):** a `/api/studio/build` SSE route supplying real `run` (worker) +
  `complete` (AI client), validated with a signed-in launch against the deployed worker.

## 2026-06-05 · Claude — INFRA LIVE: deploy worker, fix CORS, apply DB migrations
Brought the Cloudflare/Studio infra up end-to-end and unblocked the live site.
- **Diagnosed the live site being broken:** the frontend served at `dreamstreamstudio.ai`
  but every API call 403'd — the Railway backend's `CORS_ORIGIN` didn't include the new
  domain. **Fix:** added `isAllowedOrigin()` in `server/src/config.ts` that always trusts
  the brand domains + their subdomains over HTTPS (apex, www, `*.dreamstreamstudio.ai`
  preview hosts), with look-alike/HTTP rejection + unit tests (`config.cors.test.ts`).
  Wired into the CORS middleware (`server/src/index.ts`). **Merged to prod (PR #79) and
  verified live** — `https://dreamstreamstudio.ai` now gets `access-control-allow-origin`.
- **Studio Worker deployed:** `dreamstream-studio` is live on Cloudflare (owner ran
  `wrangler deploy`; container image built + pushed after a Docker CLI update). Wildcard
  preview DNS (`A * → 192.0.2.0`, proxied) added — `*.dreamstreamstudio.ai` now resolves
  and routes to the worker. HMAC secret set on the worker + Railway.
- **DB migrations applied** to the `Comic` project (`bdjfmxfmhqhzvgrhbbzm`): `studio_runs`,
  `studio_projects` (+ files/versions/deployments), `custom_agents`, `mcp_servers` — 7
  tables, all RLS-enabled; security advisors clean (only the standard GraphQL-visibility
  WARNs shared by every table).
- **Docs:** `00-STATUS.md` (Phase 0 ✅, Phase 1 deployed, new NEXT STEP), `OWNER-ACTIONS.md`
  (live-state table + statuses) updated.
- **Follow-ups:** confirm `VITE_STUDIO_LIVE_ENABLED=true` (Pages) + `STUDIO_WORKER_URL`
  (Railway); run a signed-in launch round-trip to validate Phase 1 live; then Phase 4.

## 2026-06-05 · Claude — Wire the real domains (dreamstreamstudio.ai primary, .com → .ai)
Owner bought `dreamstreamstudio.ai` + `dreamstreamstudio.com`. Wired them in:
- Worker preview domain is now **configurable** (`STUDIO_PREVIEW_DOMAIN`) and **decoupled
  from the control endpoint** — the worker claims only `*.dreamstreamstudio.ai/*` for
  previews, leaving the bare apex + www free for the real site. Control POSTs stay on the
  worker's `*.workers.dev` URL (they never needed the domain). Stray subdomains on the route
  302-redirect home instead of 405.
- `wrangler.jsonc`: route `*.dreamstreamstudio.ai/*` + `vars.STUDIO_PREVIEW_DOMAIN`.
- README + OWNER-ACTIONS: exact dashboard steps — add `.ai` as a zone, deploy, set Railway
  `STUDIO_WORKER_URL` to the `.workers.dev` control URL, and a **`.com` → `.ai` 301 Redirect
  Rule**. Worker typechecks clean.

## 2026-06-05 · Claude — Worker validated against the REAL SDK + custom-domain truth (Phase 1)
Set out to "finish the Cloudflare setup"; validating the Worker against the installed SDK
surfaced two prior mistakes and corrected them.
- **Installed `@cloudflare/sandbox` and typechecked the Worker** (was excluded from CI).
  Found: `sandbox.tunnels.get(...)` **does not exist**; the `Sandbox` DO binding was
  untyped. Fixed `studio-worker/src/index.ts` → real `exposePort(port, { hostname })`
  (preview URL from the incoming host), typed `DurableObjectNamespace<Sandbox>`, robust
  `exec`/`startProcess` via `cwd`/`env`, and a deterministic dev `processId`. **Worker now
  typechecks clean against SDK 0.4.18.** Pinned the npm dep + Dockerfile base image to 0.4.18.
- **Added the `logs` action** (dev stdout/stderr) and wired the control-plane `/api/studio/:id/logs`
  to it (was a 501 stub) — the signal Phase 4 reads to self-correct + the in-app log panel.
- **Corrected a false "no domain needed" claim.** Cloudflare's `exposePort` THROWS
  `CustomDomainRequiredError` on `*.workers.dev`; live preview URLs **require a custom
  domain** with a wildcard route. Owner **decided to get a cheap domain**. Updated
  `wrangler.jsonc` (apex first-level-wildcard route template + Universal-SSL note), the
  Worker README (accurate step-by-step), `OWNER-ACTIONS.md` (O2 rewritten), and PHASE-1.
- Verified: server typecheck + worker typecheck pass.

## 2026-06-05 · Claude — Client surfaces for the new backends (Phase 9 trace UI + Phase 10 marketplace)
Made the just-shipped backends visible/usable (they were dormant in the UI):
- **SwarmTraceCard** now shows the verifier's per-agent **confidence chip** (green/amber/red)
  + **flag badges** (no_sources / unverified_figures / hedged …) and an **overall
  confidence** chip in the header. Gallery demo updated to match (`ComponentGallery.tsx`).
- **ToolsDashboard** gains a curated **MCP marketplace** — vetted keyless servers with
  one-click Connect (mirrors `mcpCatalog.ts`), wired to the existing local MCP store.
- Verified: client typecheck + production build pass.
- Still deferred (deeper): live per-agent SSE + "re-run a single agent" (needs a re-run
  endpoint), and migrating the MCP store from localStorage to the server-side registry UI.

## 2026-06-05 · Claude — PHASES 11 + 9 + 10 + 6 (four phases, backend cores) + SELF-AUDIT
Built the buildable-now backbone of the next four phases — the three parallel platform
workstreams plus GitHub sync — additively and (where it changes prod AI behavior)
flag-gated, so production is unchanged until the owner opts in. All shipped to prod.

**Phase 11 — Guardrails & personality (foundation):**
- New `server/src/ai/persona.ts` — the single brand voice (identity/tone/honesty/refusal/
  formatting) + `composePersona()` / `withAgentPersona()`. Composed into the chat prompt
  (`CHAT_SYSTEM_PROMPT`), every swarm agent, the synthesizer, and the Universal Assistant.
- New `server/src/ai/guardrails.ts` — post-generation scan: secret/credential leak
  (redacted), figures stated with no tool call, missing citations, email/PII. Findings →
  `CapabilityNotice`s (existing UI channel) + capability **audit log**. Wired into the chat
  + swarm response paths. `+ guardrails.test.ts`, `persona.test.ts`.

**Phase 9 — Agent system upgrade:**
- New `server/src/ai/agents/verify.ts` — deterministic, always-on verifier/critic: scores
  each finding's confidence + flags (no_sources / unverified_figures / hedged / errored)
  before synthesis; injects the assessment into the synthesizer and onto the trace
  (`SwarmAgentRun.confidence/flags`). `+ verify.test.ts`.
- Resilience: agents retry once on a transient failure. Persona routing (above).
- Custom-agent library: `server/sql/studio_agents.sql` (`custom_agents` + RLS),
  `services/customAgents.ts` (CRUD, re-sanitized), `routes/agents.ts` (`/api/agents`
  built-ins + CRUD). Saved agents auto-join a user's swarm runs.

**Phase 10 — Tools / MCP / sourcing:**
- New `server/src/ai/tools/jsonToolProtocol.ts` — JSON tool-protocol fallback so
  non-OpenRouter models (NVIDIA / free) can call our tools; wired into `runChat` as a
  self-contained loop, behind `JSON_TOOL_PROTOCOL_ENABLED` (off by default). `+ test`.
- Server-side MCP registry: `server/sql/mcp_servers.sql` (+ RLS, auto-disable),
  `services/mcpRegistry.ts`, curated marketplace `ai/tools/mcpCatalog.ts`. Saved servers
  now sync server-side and merge into chat (cap 6→10).
- **Outbound MCP server** `routes/mcp.ts` `mcpOutboundRouter` — DreamStream's read-only
  tools as an authenticated JSON-RPC MCP endpoint (`/api/connect/mcp`, Bearer
  `MCP_OUTBOUND_TOKEN`, disabled when unset) external agents can call.

**Phase 6 — GitHub sync (deploy half needs the Worker):**
- New `services/studioGithub.ts` (Git Data API: atomic multi-file push, recursive pull;
  pure `buildTreeEntries`/`parseRepoFullName` tested) + `routes/studioGithub.ts`
  (`/api/studio/github/{repos,push,pull}`). Token is **transient via `x-github-token`**
  header — never stored (matches the BYOK posture; the repo has no encryption infra). Only
  the repo name is persisted. `/api/studio/deploy` is an honest 501 until the Worker ships.

- Verified: client + server typecheck, **311 tests** (+33; the 4 failing suites are the
  pre-existing Supabase-env-unset ones), production build — all pass.
- **SELF-AUDIT:** ✅ one persona drives chat/swarm/agents/assistant · ✅ guardrail layer
  catches leaked secrets, fabricated figures, missing citations (unit-tested) + flags via
  notices + audit log · ✅ verifier raises/flags confidence before synthesis (tested) ·
  ✅ custom agents persist + manage; built-ins protected · ✅ JSON tool fallback parses +
  runs (tested), gated off for prod safety · ✅ MCP servers persist server-side; outbound
  authenticated endpoint works · ✅ GitHub push/pull two-way · 🔀 **deferred (need infra or
  are client UI):** the model-based critic layer, live per-agent SSE streaming + agent-
  library UI, OAuth MCP + full streaming SSE, action/write tools, and Phase 6 **one-click
  deploy** (needs the Worker — honest 501) + the GitHub/agent/MCP **dashboards** (client) ·
  ⚠️ DB-bound services unit-test the pure helpers, not the Supabase calls; behavior-changing
  paths (JSON tools, outbound MCP) are off until their env flag/token is set.

## 2026-06-05 · Claude (session 012Drsxr…) — PHASE 5 (persistence backend) + SELF-AUDIT
Built the durable project model so AI-built apps survive sleep/reload (container
disposable, project durable). Domain logged as **deferred (not a blocker — tunnels)**.
- New: `server/sql/studio_projects.sql` (projects/files/versions/deployments + RLS),
  `services/studioFiles.ts` (pure helpers + tests), `services/studioRepository.ts`
  (ownership-guarded CRUD), `/api/studio/projects` (list/get/delete) routes, and
  **save-on-launch** (every build upserts the project + replaces files + snapshots a version).
  Client `studioApi.launchLiveStudio` now sends title+template for the project name.
- Verified: client + server typecheck, **278 tests (+4)**, production build — all pass.
- **SELF-AUDIT:** ✅ persistence backend complete (schema, RLS, repository, CRUD,
  save-on-launch, ownership guard against projectId hijack), pure helpers unit-tested ·
  🔀 **re-scoped:** the Monaco **editor UI / version-restore / diff** are deferred to the
  live studio shell (editing a not-yet-runnable project is low-value; pairs with the
  deployed worker) · ⚠️ not live-validated (needs the new migration applied + worker
  deployed; dormant + safe until then — endpoints unused, save-on-launch behind the 503) ·
  🛡️ RLS + per-user query scoping + ownership guard; repository is DB-bound so unit tests
  cover the pure helpers, not the DB calls.

## 2026-06-05 · Claude (session 012Drsxr…) — Phase 2 + 3-core SHIPPED TO PROD + workflow change
- Merged **#77 to production** (`Dreamstrream-v1`): Phase 2 control plane + Phase 3a
  Run-live wiring. CI green; flag-gated so prod behavior is unchanged until O8.
- **Workflow change (owner directive):** completed *phases* now merge straight to
  **production**, not a preview branch (sub-phases stay on the branch). Recorded in
  `AGENTS.md §7`. Everything ships safe-by-default (flag-gated / no-op until configured).
- Phase 3: "Run live → new tab" is the core deliverable and is shipped; the in-app
  log/status pieces are deferred until the Worker's logs action (needs infra).
- **Next buildable-now:** Phase 5 persistence, or parallel workstreams 9/10/11. Phase 4
  (agentic loop) needs the Worker deployed first.

## 2026-06-05 · Claude (session 012Drsxr…) — PHASE 3a + continuity log
**Continuity:** added `OWNER-ACTIONS.md` (living resume + owner to-do + deferred-validation
log); wired into AGENTS/README/00-STATUS (agents must keep it updated).
**Phase 3a — client "Run live" wiring (flag-gated):**
- New `services/studioApi.ts` — `launchLiveStudio()` / `stopLiveStudio()` / `isLiveStudioEnabled()`
  (kept out of studioLauncher so the standalone /studio bundle stays lean).
- `CodeStudioCard.tsx` — adds a "Run live" button (loading + graceful error) shown ONLY
  when `VITE_STUDIO_LIVE_ENABLED=true`, so production is unchanged by default.
- Verified: client typecheck, 274 tests, production build — all pass.
- SELF-AUDIT: ✅ additive + flag-gated (no prod change until O8) · ✅ degrades gracefully
  on 503/error · ⚠️ end-to-end needs the Worker + flag (deferred validation logged) ·
  🔭 3b (shell/editor/preview/logs) still to build; mid-phase, no checkin gate yet.

## 2026-06-05 · Claude (session 012Drsxr…) — PHASE 2 built + SELF-AUDIT
**Phase 2 — Railway control plane (`/api/studio/*`).** Shipped #75/#76 to production first.
- New: `server/src/routes/studio.ts` (launch/stop/logs), `services/studioSign.ts` (HMAC,
  matches the Worker's verify), `services/studioCaps.ts` (pure per-user caps),
  `server/sql/studio_runs.sql` (metering table + RLS), `studioSign.test.ts` +
  `studioCaps.test.ts`. Edited `config.ts` (STUDIO_* env), `index.ts` (mount under
  requireAuth + text rate limit), `server/.env.example`.
- Verified: client + server typecheck, **274 tests** (+9), production build — all pass.

**SELF-AUDIT (vs PHASE-2 acceptance criteria):**
- ✅ Auth: `/api/studio/*` is behind global `requireAuth` → unauth = 401.
- ✅ Caps: over-cap → 429 with clear code/message; unit-tested (concurrency + daily).
- ✅ HMAC: sign scheme matches the Worker's verify exactly; round-trip unit-tested.
- ✅ Runs: launch inserts a `studio_runs` row; stop closes it with awake_seconds + cost_usd.
- ✅ Typecheck + signer/caps unit tests.
- ⚠️ **Not live-validated end-to-end** — happy path needs the Worker deployed (Phase 0/1)
  + Supabase service key; correct-by-construction but not run against real infra. Without
  config, `/api/studio` returns 503 STUDIO_NOT_CONFIGURED (honest).
- 🔀 **Deviation (justified):** did NOT route through token-based `usageEnforcer` (that's
  for model tokens); studio compute uses dedicated caps + `studio_runs` metering. Billing
  integration (awake_seconds→credits) deferred to Phase 7.
- 🔭 **Scope:** migration creates only `studio_runs` (Phase 5 adds projects/files/versions);
  `project_id` is text until linked in Phase 5. `/logs` is a 501 stub until the Worker's
  logs action lands. No mocked route-level test yet (signer+caps covered).
- 🛡️ **Follow-ups/risks:** caps currently fail-OPEN if the DB is unavailable (consider
  fail-closed in prod for cost safety); concurrency cap has a minor TOCTOU race (DB
  constraint/lock would harden it).
- **Status:** built + verified, **awaiting owner review before Phase 3.**

## 2026-06-05 · Claude (session 012Drsxr…)
**Deep analysis of the agent/tool/guardrail systems + parallel workstream phases.**
- Read the real swarm (`orchestrator/registry/swarmTool`), MCP client + client registry,
  tool registry/catalog, source governance, and `assistantPolicy` (guardrails).
- Wrote `10-AGENTS-SWARM.md` (swarm analysis + redesign: verifier, personality,
  legitimacy, usability), `11-TOOLS-MCP-SOURCING.md` (tools on all models, managed +
  outbound MCP, sourcing), `12-GUARDRAILS-PERSONALITY.md` (unified voice + output guardrails).
- Added parallel-workstream phases `PHASE-9` (agents), `PHASE-10` (tools/MCP), `PHASE-11`
  (guardrails/personality); updated README map, `00-STATUS` board, `09-ROADMAP`.
- Key findings: swarm is real (plan→dispatch→synth, 8 agents, context-aware, billing-
  merged) but lacks a verifier, unified persona, and persisted custom agents; tools are
  broad+free-first but **OpenRouter-only** and MCP is client-stored/shallow with no
  outbound endpoint; guardrails exist (anti-fabrication, sanitization, SSRF, governance)
  but personality is fragmented and there's no post-generation guardrail layer.

## 2026-06-05 · Claude (session 012Drsxr…)
**Built the documentation system + Studio Worker scaffold.**
- Created `docs/studio/` hub: `README`, `00-STATUS` (living tracker), `AGENTS`, this
  `CHANGELOG`, `01-VISION`, `02-CURRENT-STATE` (honest audit vs Emergent/enterprise),
  `03-ARCHITECTURE`, `04-AGENTIC-ENGINE`, `05-UIUX`, `06-DATA-MODEL`, `07-INTEGRATIONS`,
  `09-ROADMAP`, and `phases/PHASE-0…8`.
- Moved `CLOUDFLARE_STUDIO_PLAN.md` + `PRODUCT_BLUEPRINT.md` into `docs/studio/`.
- Track A: scaffolded `studio-worker/` — standalone Cloudflare Worker (Sandbox SDK) that
  runs AI-built apps in per-user containers and returns a live preview URL. Isolated from
  the app build (`tsconfig` exclude). Deploy-ready, **not yet validated** on real infra.
- Files: `docs/studio/**`, `studio-worker/**`, `tsconfig.json` (exclude).
- Follow-ups: confirm preview domain; build Phase 2 (Railway control plane) next.

## 2026-06-04 · Claude (session 012Drsxr…)
**Shipped studio bug-fixes (PR #75, merged to `Dreamstrream-v1`).**
- `generate_app` added to `CORE_ALWAYS_TOOLS` so the model is always offered the app
  builder (was keyword-gated → studio fired in only ~15% of code chats per usage data).
- Auto-mode now prefers a **tool-capable** model (`pickTextModel` `prefer` on `tools`).
- **Universal fallback:** `buildStudioArtifact()` turns Markdown code blocks into a
  runnable CodeStudio project so the studio is reachable on every model (incl. NVIDIA /
  free non-tool-callers). Wired into `ChatMessageView`. Unit tests added.
- Sandpack inline preview now installs deps from `package.json` (`customSetup`).
- Files: `toolCatalog.ts`, `server/src/routes/chat.ts`, `services/chatUtils.ts`(+test),
  `components/chat/ChatMessageView.tsx`, `components/chat/CodeStudioPanel.tsx`.
- Verified: client+server typecheck, 265 tests, production build.

## 2026-06-04 · Claude (session 012Drsxr…)
**Research + costing (informs all docs).**
- Verified Cloudflare Containers pricing verbatim vs live pages.
- Pulled real usage from the `Comic` Supabase: 2 users, 1,438 ops/4mo, 99.3% BYOK,
  ~99% of spend is image gen; chat is cheap (~$0.0006/op). Studio tool historically
  fired in only 2 of ~13 code chats — quantified the bug fixed in #75.
- Compared Cloudflare vs Fly/Vercel/AWS/Railway + Kimi K2.6 per-token vs self-host GPUs.
  Conclusion: per-session compute ~1.5¢; tokens dwarf compute; BYOK neutralizes tokens.
