# Phase 3 — Studio UI shell

**Status:** 🟡 **in progress** — 3a (client "Run live" wiring, flag-gated) done 2026-06-05; 3b (shell/editor/preview/logs) next · **Depends on:** Phase 2 for live wiring · **Effort:** 3–5 days

## Goal
The studio interface: chat that builds, a live preview, and a "Run live" path that opens
the running app in a new tab. AI-centric; editor introduced in Phase 5.

## Tasks
1. `components/chat/studio/StudioShell.tsx` — 3-pane resizable layout + topbar + statusbar
   (reuse `ResizablePanel`). Render inside the chat product.
2. Wire the `code_studio` artifact → "Run live (new tab)" CTA in `CodeStudioCard.tsx` to
   call `services/studioLauncher.launchLiveStudio()` → `/api/studio/launch` → `window.open(previewUrl)`.
3. `LivePreview.tsx` — iframe of the preview URL + refresh + open-in-new-tab + live/sleep chip.
4. `BuildTrace.tsx` — render the plan/build steps (spinner → ✓) with house-style animation.
5. `LogPanel.tsx` — stream `/api/studio/:id/logs` (SSE) for install/dev logs.
6. `StatusBar.tsx` + `RunCostPill.tsx` — live state, idle countdown, this-run cost, model.
7. States: empty/planning/writing/installing/starting/live/error/sleeping (see `05-UIUX.md`).
8. Mobile: tabbed Chat ⇄ Preview ⇄ Code; preview opens full-screen new tab.

## Acceptance criteria
- From a chat that produced an app, "Run live" opens the running app in a new tab (real
  container once Phase 1–2 are deployed; mock until then).
- Build status + logs + run cost are visible and update live.
- House style + animations per `05-UIUX.md`; responsive; reduced-motion respected.
- Client typecheck + build pass; no regressions to existing chat.

## Files
- new: `components/chat/studio/{StudioShell,LivePreview,BuildTrace,LogPanel,StatusBar,RunCostPill}.tsx`
- edit: `services/studioLauncher.ts` (add `launchLiveStudio`), `components/chat/artifacts/CodeStudioCard.tsx`, `components/chat/AIChatPlatform.tsx`

## Notes
- Keep the existing Sandpack "Quick preview" for small front-end apps (universal, free);
  "Run live" is the full container path. Consolidation happens in Phase 8.
