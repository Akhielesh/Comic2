# AGENTS — working rules for AI agents on DreamStream Studio

You are an AI agent picking up work on **DreamStream Studio**. Read this fully before
touching anything. These docs are written so you can start cold and continue correctly.

## 1. Orient yourself (in this order)
1. [`00-STATUS.md`](./00-STATUS.md) — what's done, the current phase, the next step, blockers.
2. [`CHANGELOG.md`](./CHANGELOG.md) — what previous agents did (newest first).
3. [`01-VISION.md`](./01-VISION.md) + [`02-CURRENT-STATE.md`](./02-CURRENT-STATE.md) — the goal and the honest gap.
4. The **current phase doc** in [`phases/`](./phases/) — your task list + acceptance criteria.

## 2. The repo (where things live)
- App root: `dreamstreamcomicstudio/` (the git repo root is its parent, `Comic2/`).
- Frontend: `components/`, `services/`, `App.tsx` (React 19 + Vite + Tailwind).
- Backend (Railway): `server/src/` (Express + TS). Routes in `server/src/routes/`, AI in `server/src/ai/`.
- The chat platform: `components/chat/`, server `server/src/ai/chat.ts` + `server/src/routes/chat.ts`.
- Tool registry (what the AI can call): `server/src/ai/tools/registry.ts` + `toolCatalog.ts`.
- Current code studio: `studio/` (WebContainer — being replaced) + `components/chat/CodeStudioPanel.tsx` (Sandpack).
- **Studio Worker (v2 sandbox):** `studio-worker/` (separate Cloudflare Worker; isolated from app build).
- Shared types: `apiTypes.ts`, `types.ts`. Conventions: `CLAUDE.md`.

## 3. MANDATORY after any change
1. **Update [`00-STATUS.md`](./00-STATUS.md)** — phase status, next step, blockers, "last updated".
2. **Append to [`CHANGELOG.md`](./CHANGELOG.md)** — date, what you did, files touched, follow-ups.
3. If you changed a design, update the relevant phase/spec doc so docs never drift from code.

> The whole point of this system is that the owner only has to check `00-STATUS.md`.
> If you leave it stale, you've broken the system.

## 4. Verify before you commit (from `dreamstreamcomicstudio/`)
```
npm run typecheck        # client TS
npm run build:server     # server TS
npx vitest run           # 265 tests should pass (run from this dir; jsdom needs it)
npm run build            # production build (also bundles studio.html)
```
The `studio-worker/` is **excluded** from the app's `tsconfig` and CI — verify it
separately with `cd studio-worker && npm run typecheck` (needs its own `npm install`).

## 5. Conventions that matter
- New rich chat output? Follow `CLAUDE.md`: declare type in `apiTypes.ts`, register in
  `components/chat/artifacts/ChatArtifacts.tsx`, **add a Gallery demo** (a test enforces it).
- House visual style: `border-2 border-black`, `shadow-comic`, `font-display`/`font-comic`,
  `animate-fade-in`; charts are inline SVG (no chart libs). See `05-UIUX.md`.
- Models are **BYOK / free-first**. Never assume a paid key. Tools are OpenRouter-only
  (NVIDIA can't tool-call) — keep the Markdown→Studio fallback working for all models.
- Git: work on the designated feature branch; commit with clear messages; open a draft PR.

## 6. Scope discipline
- Build **phase by phase** (see `09-ROADMAP.md`). Don't skip ahead and leave half-wired features.
- If a task is ambiguous or architectural, write the question into `00-STATUS.md` "Open
  decisions" and ask the owner rather than guessing.
- Self-hosting GPUs / large models is **out of scope** — models are API/BYOK.
