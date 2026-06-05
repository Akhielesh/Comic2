# Phase 7 — Per-project backend, polish, mobile

**Status:** 📋 planned · **Depends on:** Phase 6 · **Effort:** 1–2 weeks

## Goal
Reach full parity + polish: apps can have a real backend/DB, the UX is premium, and the
whole thing works great on mobile.

## Tasks — per-project backend/DB
1. **SQLite-in-container** first: a default local DB the built app can use during dev
   (zero infra). Wire a helper/template so generated apps get persistence out of the box.
2. **Supabase-per-project** (opt-in): provision via the Supabase Management API (or a
   shared Supabase with strict per-project RLS/schema); inject connection env into the
   container (never platform secrets). Gives apps real auth + DB + storage (Lovable parity).

## Tasks — polish & effects
1. Implement the full animation/effects spec (`05-UIUX.md`): streamed file writes, build
   trace transitions, status-chip spring, preview reveal, sleep/wake shimmer, cost count-up,
   error-shake + fix-diff highlight. 60fps; `prefers-reduced-motion`.
2. Empty states, onboarding, keyboard shortcuts, command palette.
3. Performance: lazy-load editor/preview; code-split; cold-start mitigation (pre-warmed image).

## Tasks — mobile
1. Tabbed Chat ⇄ Preview ⇄ Code; full-screen preview in a new tab.
2. Touch-friendly controls; responsive panes; test on iOS/Android browsers (works because
   execution is server-side — the device only opens a URL).

## Acceptance criteria
- A generated app can persist data (SQLite) without extra setup; opt-in Supabase works.
- The studio feels premium (animations, states) and is fully usable on a phone.
- No perf regressions; reduced-motion honored; a11y checks pass.

## Files
- new: `server/src/services/studioBackend.ts` (provisioning), animation utilities,
  mobile layout components
- edit: studio components, templates, Dockerfile (pre-warm)
