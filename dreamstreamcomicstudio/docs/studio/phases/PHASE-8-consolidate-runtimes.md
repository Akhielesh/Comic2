# Phase 8 — Consolidate runtimes

**Status:** 📋 planned · **Depends on:** Phase 3 (live container path working) · **Effort:** 2–3 days

## Goal
Collapse the **three** current code-execution paths into **two coherent tiers**, removing
the desktop-only and hacky ones. Less code, consistent behavior, universal devices.

## Today (the mess)
1. **Sandpack inline** (`components/chat/CodeStudioPanel.tsx`) — in-browser bundler, universal but front-end-only.
2. **WebContainer** (`studio/`, `studio.html`, `studio/StudioApp.tsx`) — **desktop-only**, needs cross-origin isolation.
3. **unpkg blob** (`AIChatPlatform.handleOpenNewTab`) — CDN+Babel hack, fragile.

## Target (two tiers)
- **Quick preview = Sandpack** — universal, free, instant; for small front-end apps.
- **Run live = Cloudflare container** — full stack, real npm/dev, any device; the main path.

## Tasks
1. Once the container path (P1–P3) is solid, make "Run live" the default for anything
   non-trivial; keep Sandpack as the lightweight quick-preview.
2. **Remove** the WebContainer studio (`studio/`, `studio.html`, the `studio` rollup input
   in `vite.config.ts`, the COOP/COEP `studioIsolation` plugin + `public/_headers` rule)
   and the unpkg blob path (`handleOpenNewTab`).
3. Update `services/studioLauncher.ts` (`openInStudio` → `launchLiveStudio`).
4. Update docs + `00-STATUS.md`.

## Acceptance criteria
- Only two runtimes remain (Sandpack + Cloudflare); WebContainer + unpkg paths deleted.
- No dead code/config (vite input, headers, plugin) left behind; build still passes.
- Behavior is consistent across desktop and mobile.

## Risk / sequencing
Do this **after** the container path is proven (don't remove the old path before the new
one works). Keep a feature flag during the transition.
