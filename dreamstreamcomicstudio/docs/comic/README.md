# Comic Studio — Product & Build Docs (read me first)

This folder is the **single source of truth** for redesigning and building the
**DreamStream Comic Studio** product. It exists so that *any* AI session, in *any*
future chat, can pick up the work cold without re-discovering the codebase.

> If you are an AI agent starting a session on the comic product, **read in this order**:
> 1. [`AGENTS.md`](./AGENTS.md) — the protocol you MUST follow (how to keep docs in sync).
> 2. [`00-STATUS.md`](./00-STATUS.md) — the living tracker. The authoritative "where are we".
> 3. The **active sprint** file in [`sprints/`](./sprints/) (the one marked 🟡 in `00-STATUS.md`).
> 4. Whatever spec doc (03–06) covers the area you're touching.
> 5. [`CHANGELOG.md`](./CHANGELOG.md) — what the last few sessions actually did.

## What this product is (one paragraph)

A **comic-creation studio** where a person gives a rough idea or script, the AI
**aggregates it into a full comic book** (story → script → pages → panels →
lettering), and the user can then **dive as deep as they want** — down to an
Adobe-style **layer canvas** where speech bubbles are drag/resize/restyle objects,
regions of a panel can be **circled and re-generated** (inpaint), and single panels
can be re-rolled with variations. Quick for casual users; deep for power users.
**One** document model underneath both. BYOK (bring-your-own-key) first.

## The four locked decisions (the spine of everything here)

| # | Decision | Value |
|---|---|---|
| D1 | **Scope** | **Comic Studio only.** AI Chat + Code Studio are *frozen legacy* — no investment; eventually extractable. |
| D2 | **Engine** | **Page-first hybrid** on **one canonical "Comic Document" model** with progressive depth (quick-generate → deep-edit). |
| D3 | **Cost model (v1)** | **BYOK / personal-first.** No platform billing in v1; obsess over token-optimization + caching + cost visibility so keys aren't burned. |
| D4 | **Editing v1** | **Layer-based canvas**: drag/resize/restyle bubbles (many designs, layer-on-layer), circle/region-to-edit, single-panel regen + variations, on-canvas dialogue. (Object/pose-swap = fast-follow.) |

Full rationale: [`01-VISION-AND-SCOPE.md`](./01-VISION-AND-SCOPE.md) and [`DECISIONS.md`](./DECISIONS.md).

## Map of this folder

| File | What it is | Update cadence |
|---|---|---|
| `README.md` | This index | rarely |
| `AGENTS.md` | **The session protocol** — how to work + keep docs honest | rarely |
| `00-STATUS.md` | **Living tracker** — current state, sprint board, NEXT STEP | **every session** |
| `CHANGELOG.md` | Append-only log, newest first | **every session** |
| `DECISIONS.md` | Decision log (ADR-style) | when a decision is made |
| `01-VISION-AND-SCOPE.md` | Who it's for, the thesis, non-goals | rarely |
| `02-CURRENT-STATE-AUDIT.md` | Honest map of what exists today (the mess) | when reality changes |
| `03-ARCHITECTURE.md` | Target architecture + the Comic Document model | when architecture shifts |
| `04-CANVAS-EDITOR-SPEC.md` | The Adobe-style editor, in minute detail | when editor evolves |
| `05-MODEL-ORCHESTRATION.md` | Multi-model handling, clusters, consistency | when routing changes |
| `06-COST-AND-CONTEXT.md` | BYOK, token-opt, caching, cost visibility | when cost logic changes |
| `07-ROADMAP.md` | Sprint sequence overview | when re-planning |
| `sprints/SPRINT-NN.md` | **Minute task breakdowns** per sprint | the active one, continuously |
| `sprints/SPRINT-TEMPLATE.md` | Template for the next sprint | copy when planning |

## House facts an agent always needs

- **App root:** `dreamstreamcomicstudio/` (this repo's working dir). Frontend = Vite + React 19 + Tailwind; backend = Express in `server/src`.
- **Prod branch:** `Dreamstrream-v1` (Cloudflare Pages builds frontend; Railway builds backend). See root `CLAUDE.md` for the ship rule.
- **Build/verify:** `npm run typecheck` · `npm run build:server` · `npx vitest run` · `npm run build`.
- **The comic engine entry today:** `App.tsx` routes by `project.state.pipelineMode` → `ComicEditor` (classic) / `PageStudio` / `ComicForgeStudio`. We are collapsing these (see D2).
