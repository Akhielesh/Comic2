# CHANGELOG — DreamStream Studio

Append-only. Newest first. Every agent/PR records what it did here so the next agent can
pick up cold. Format: date · author · summary · files · follow-ups.

---

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
