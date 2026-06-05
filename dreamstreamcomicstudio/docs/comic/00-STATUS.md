# 00 — STATUS (living tracker for the Comic Studio)

> **This is the file to check.** Authoritative, always-current state of the comic
> product redesign. Every session that changes anything **must** update this file
> and `CHANGELOG.md`. If this file disagrees with reality, fix this file.

**Last updated:** 2026-06-05 · **Updated by:** Claude · **Branch:** `claude/practical-planck-aug7s`

> Latest: **Plan established.** The four strategic decisions are locked (comic-only,
> page-first hybrid, BYOK-personal-first, layer-canvas editor). This `docs/comic/`
> system is the new home for the comic product. **No product code has changed yet** —
> Sprint 0 is the first build sprint and has not started.

---

## Overall progress

```
Planning     ████████████████████  100%  (decisions locked, architecture + roadmap written)
Foundation   ░░░░░░░░░░░░░░░░░░░░    0%   (Sprint 0–1: fences, repo hygiene, Comic Document model)
Quick engine ░░░░░░░░░░░░░░░░░░░░    0%   (Sprint 2: idea → comic book, page-first)
Canvas/edit  ░░░░░░░░░░░░░░░░░░░░    0%   (Sprint 3–6: layers, bubbles, region-edit, regen)
Publish      ░░░░░░░░░░░░░░░░░░░░    0%   (Sprint 8)
```

**Where we are:** end of the *discovery + planning* phase. The existing code has
three competing comic engines (Classic = live, ComicForge = dormant stub,
PageStudio = newest/partial), a unified OpenRouter gateway that **isn't the default**,
and **no** region/layer/inpaint editing at all. We are now consolidating onto one
**Comic Document** model and building the page-first quick engine + the layer canvas.

## Sprint board

| Sprint | Title | Status | Notes |
|---|---|---|---|
| 0 | [Foundation & fences](./sprints/SPRINT-00.md) | 📋 **next** | Fence non-comic products, repo hygiene, BYOK default + key screen, flag billing UI off |
| 1 | [Comic Document model + migration](./sprints/SPRINT-01.md) | 📋 planned | The "solid base template": one schema, migrator from 3 legacy shapes, persistence |
| 2 | [Quick-generate engine (page-first)](./sprints/SPRINT-02.md) | 📋 planned | idea/script → aggregate → Style Bible + cast → page render → book → reader |
| 3 | [Canvas editor shell + layers](./sprints/SPRINT-03.md) | 📋 planned | Artboard, layer list, move/resize/rotate, undo/redo, autosave, export flatten |
| 4 | Bubble system (drag/resize/designs) | 📋 planned | Parametric bubble library, on-canvas editing, layer-on-layer — the headline feature |
| 5 | Region / circle-to-edit (inpaint) | 📋 planned | Mask capture → inpaint model → non-destructive composite + variations |
| 6 | Single-panel regen + variations + seeds | 📋 planned | Seed support on unified path, variation tray, page→panel explode |
| 7 | Consistency hardening | 📋 planned | Scene-scoped reference packs, character sheets, QC vision, pre-flight audit |
| 8 | Publish + polish | 📋 planned | Cover, export presets, share/publish, onboarding, mobile |

**Fast-follows (post-v1, not scheduled):** object/pose-swap editing; LoRA/IP-adapter
provider cluster; collaborative editing; re-activate platform billing for multi-tenant.

Legend: ✅ done · 🟡 in progress · 📋 planned · ⛔ blocked

## ➡️ NEXT STEP

**Start Sprint 0.** Concretely, the first three tasks (see
[`sprints/SPRINT-00.md`](./sprints/SPRINT-00.md)):
1. Repo hygiene — remove `dreamstream-comic-studio (1).zip`, `.DS_Store`, root scratch
   files (`analyze_comic.ts`); confirm `.gitignore` covers them.
2. Fence the non-comic products — make `Comic` the default landing and hide/guard the
   AI Chat + Code Studio + Models nav behind a `VITE_SHOW_LEGACY_PRODUCTS` flag
   (default off). Don't delete; just stop surfacing them.
3. Flip the personal default: `AI_PROVIDER=openrouter`, ship a one-screen **BYOK key
   setup** as the first-run gate, and flag the CT credit/billing UI off
   (`VITE_BILLING_UI_ENABLED=false`).

## Open decisions (tracked in DECISIONS.md)

| Decision | Recommendation | Status |
|---|---|---|
| Canvas tech for the layer editor | `react-konva` for raster+vector layers (eval `tldraw` as alt) | ❓ open — decide in Sprint 3 |
| Inpaint/region-edit model + API | OpenRouter image-edit model w/ mask part; add `mask` to image route | ❓ open — decide in Sprint 5 |
| Page-composite vs panel-assemble default | Page-composite default; explode-to-panels on demand | ✅ decided (D2) |
| Where the Comic Document lives | Supabase `projects.state` (one JSON doc) + IndexedDB cache, migrator-gated | ✅ decided (Sprint 1) |
| Keep ComicForge async worker? | Reuse its BullMQ/worker + normalized schema for batch renders later; not v1 | ❓ open — revisit Sprint 6 |

## Known risks / honest caveats

- The Adobe-style layer editor is **net-new** (no canvas/mask/inpaint exists today).
  It's the biggest single build; Sprints 3–5 are the riskiest. Keep slices vertical.
- Image consistency across panels is genuinely hard and model-dependent. The plan
  leans on generate-once reference sheets + seeds + scoped reference packs, but
  expect iteration. Don't promise pixel-perfect identity.
- The unified OpenRouter image path has **no seed** and **no result cache** today —
  both are cost/consistency must-fixes (Sprints 2 and 6).
- BYOK means *your own* keys are spent. Every sprint must respect the cost rules in
  [`06-COST-AND-CONTEXT.md`](./06-COST-AND-CONTEXT.md).
