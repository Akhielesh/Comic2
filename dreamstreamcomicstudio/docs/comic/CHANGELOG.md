# CHANGELOG — Comic Studio redesign

Append-only. Newest first. Every session records what it did so the next one can
pick up cold. Format: `## YYYY-MM-DD · author — summary`, then *what changed*,
*files*, *follow-ups*.

---

## 2026-06-05 · Claude — Establish the comic-product plan + doc system

Discovery + planning session. No product code changed; this is the foundation the
build sprints run against.

- **Audited the real architecture** (read `App.tsx`, `types.ts`, the OpenRouter
  gateway, plus two deep sub-agent audits of the editing ceiling and the
  model/cost machinery). Findings captured in `02-CURRENT-STATE-AUDIT.md`.
- **Locked four strategic decisions** with the product owner (see `DECISIONS.md`
  D1–D4): comic-only; page-first hybrid on one Comic Document model; BYOK /
  personal-first (no platform billing in v1); layer-based canvas editor as the
  centerpiece.
- **Created `docs/comic/`** — the cross-session continuity system, mirroring the
  proven `docs/studio/` pattern (living `00-STATUS.md` + append-only CHANGELOG +
  numbered specs + minute sprint files + an `AGENTS.md` protocol).
- **Wrote the specs:** vision/scope, current-state audit, target architecture +
  Comic Document model, the canvas-editor spec (bubbles/region-edit/layers in
  minute detail), model orchestration (clusters + consistency), cost & context
  (BYOK + token-opt + caching), the roadmap, and detailed Sprints 0–3 plus a
  template.
- Files: everything under `docs/comic/`.
- **Follow-ups / NEXT:** Sprint 0 — repo hygiene, fence non-comic products behind
  `VITE_SHOW_LEGACY_PRODUCTS`, flip BYOK/OpenRouter default + first-run key screen,
  flag the billing UI off. See `sprints/SPRINT-00.md`.
