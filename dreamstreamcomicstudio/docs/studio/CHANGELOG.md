# CHANGELOG — DreamStream Studio

Append-only. Newest first. Every agent/PR records what it did here so the next agent can
pick up cold. Format: date · author · summary · files · follow-ups.

---

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
