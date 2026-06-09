# CHANGELOG — DreamStream Studio

Append-only. Newest first. Every agent/PR records what it did here so the next agent can
pick up cold. Format: date · author · summary · files · follow-ups.

---

## 2026-06-08 · Claude — FEAT: studio agent constitution (onboarded, customized + wired into build prompts)
Owner uploaded a 17-file "agent constitution" (a generic prompt-to-app-builder rule set) and asked to
assess it, onboard it, customize it, and implement it into the app. Assessment: genuinely strong
(prompts-are-probabilistic / gates-are-deterministic, anti-over-engineering, recovery-first,
model-agnostic) but **generic** — it assumed Next.js/shadcn/Supabase and a fictional tool surface
(`fs.*`/`preview.*`/`db.*`). The work was customization + wiring, not a rewrite.
- **Docs:** new `docs/studio/agent-constitution/` (00–16) — every file rewritten against DreamStream's
  real stack (React/Vite/TS, Express, Supabase, studio-worker sandbox), real tool surface, and the
  controls we already ship (`verifyApp`, `buildGuards`, `assistantPolicy`, `sourceGovernance`,
  `mcpClient` SSRF, `sanitizeStudioCommand`, `usageEnforcer`). Each file ends with a "Wired into" footer
  naming the enforcing module. Indexed in `README.md` + `AGENTS.md`.
- **Code:** new pure, tested `server/src/ai/studio/constitution.ts` — a COMPACT always-resident charter
  (`STUDIO_CONSTITUTION`) + phase notes (`STUDIO_PLAN_CONSTITUTION`, `STUDIO_FIX_CONSTITUTION`) +
  `studioConstitutionFor(phase)` + `composeStudioSystemPrompt` (built on `persona.composePersona`).
  Kept tight on purpose (load-by-phase) so it adds discipline without bloating tokens / diluting
  free-first models.
- **Wiring (additive, same pattern as `designSystem.ts`):** charter injected into
  `studioPlan.buildPlanPrompt` (plan note), all three `studioGenerate.buildGeneratePrompt` branches
  (charter), and `studioFix.buildFixPrompt` (recovery note, next to `DESIGN_FIX_NOTE`).
Files: `server/src/ai/studio/constitution.ts` (+`.test.ts`, 8 tests), `studio/studioPlan.ts`,
`studio/studioGenerate.ts`, `studio/studioFix.ts`, `docs/studio/agent-constitution/*` (17),
`docs/studio/README.md`, `docs/studio/AGENTS.md`. Server + client typecheck green; **843 tests pass**;
frontend build green. (3 suites fail only because Supabase env is unset — environmental, pre-existing.)

> Follow-ups (deliberately out of scope): compose the constitution into the chat/swarm/assistant system
> prompts too (currently studio-build-only); add an output-level guardrail pass (PHASE-11 §B).

---

## 2026-06-06 · Claude — FEAT: stronger generation quality bar (production-grade code prompt)
Owner: "the code is not even good." Raised the generation contract with explicit senior-engineer
standards baked into `buildGeneratePrompt`/`OUTPUT_CONTRACT`: every relative import must resolve to an
emitted file; polished/responsive/accessible UI with empty/loading/error states by default; real wired
behavior + realistic seed data (not a stub); robust error handling and precise TS types. Pairs with the
verifier agent (which enforces the import/placeholder rules statically + auto-repairs). File:
`server/src/ai/studio/studioGenerate.ts`. Server build green; 525 tests pass.

---

## 2026-06-06 · Claude — FEAT: auto-verify + self-repair pass for generation (verifier agent)
Owner asked the AI to verify its own output and fix issues automatically (not make the user click
"Fix with AI"). Added the first agent of the build pipeline:
- New pure, tested `server/src/ai/studio/verifyApp.ts` (`verifyGeneratedApp`) statically checks a
  generated project for the failure modes that actually break studio apps: **empty files**, **placeholder
  /“rest of code” truncation markers**, a **React entry with no default export**, **invalid JSON
  manifests**, and **unresolved relative imports** (best-effort module resolution incl. index +
  extensionless). Conservative to avoid false positives.
- Wired into `POST /api/studio/generate/stream`: after generation, if issues are found the route emits a
  **“Verifying — fixing N issues…”** phase and does **one automatic repair pass** (feeding the issues
  back to the coding model) before handing the app to the user, then a **“Verified ✓”** phase. Best-effort
  — never fails the generation. Generation already routes to a coding-specific model (`pickCodingModel`).
Files: `server/src/ai/studio/verifyApp.ts` (+test), `server/src/routes/studio.ts`. Server build + client
typecheck + frontend build green; **525 tests pass** (8 new).

> Next in the pipeline: distinct design/architecture/backend agent roles + a multi-pass plan→build→verify
> loop, and a terminal for non-web/SQL projects. Tracked in `CODE-STUDIO-LIBRECHAT-PLAN.md`.

---

## 2026-06-06 · Claude — FIX: studio UX bugs + app-wide refresh routing (from owner review)
Direct fixes for the owner's reported issues:
- **Back went to the app home, not the studio.** Back is now contextual: with a project open it returns
  to the studio's **project list** (so you can pick another project); only from the list does it leave
  Code Studio. (`CodeStudioView` Back → `newProject` when `hasFiles`; label switches to "Projects".)
- **Choosing a language was forced.** Added an **Auto** chip (now the default) so the AI picks the best
  stack from the prompt — you can build immediately without choosing. Explicit chips remain optional.
  (`PromptComposer` `FRAMEWORKS` + `template`/`onTemplateChange` accept `undefined`; studio defaults to Auto.)
- **Redundant top "Build" button removed.** Building happens through the prompt/chat; a live cloud run
  (when enabled) stays available via ⌘K → "Build & run". **Stop** appears only while a live run is active.
- **Left prompt/chat panel was too small.** Widened its default share in all focus layouts (new
  `*.v2` split keys so existing users get the wider default) and made the inline composer taller (2 rows,
  up to 200px) so it reads like a proper chat panel.
- **Preview "error" flashing.** Preview errors are now **debounced ~1.2s** (and suppressed entirely while
  a generation is streaming), so transient compile/HMR blips no longer flash the red banner.
- **App-wide: refresh always bounced to home.** `currentView` was React state with no URL. Now the
  active view is persisted to the URL (`?view=`) and **restored on refresh** for the main sections
  (dashboard/chat/codestudio/gallery/learn/test/how-it-works/privacy/terms/settings). Path/param routes
  (reader/shared/auth-callback/models) keep their own URLs.
Files: `components/studio/{CodeStudioView,StudioStart}.tsx`, `components/studio/workspace/PromptComposer.tsx`,
`components/studio/CodeStudioView.test.tsx`, `App.tsx`. Typecheck + server build + frontend build green;
**517 tests pass** (full CI-equivalent suite).

> Still on the roadmap (larger efforts, not faked): a real multi-agent build (design/backend/architecture
> agents) with auto-verification + coding-specific models, and a terminal for non-web/SQL projects. Tracked
> in `CODE-STUDIO-LIBRECHAT-PLAN.md`; next iterations.

---

## 2026-06-06 · Claude — FEAT: "New project" action (start over) + verified full CI suite
- Added a **New project** command (⌘K palette, when a project is loaded) that aborts any in-flight
  run and clears the workspace + conversation thread + activity back to the projects/start screen.
- Verified the work against the **full** CI suite (`npm test -- --run` with placeholder Supabase env,
  matching `.github/workflows/ci.yml`): **517 tests pass**, typecheck + server build + frontend build green.
File: `components/studio/CodeStudioView.tsx`.

---

## 2026-06-06 · Claude — FEAT: generation resilience & control (retry, Esc-cancel, autoscroll, polyglot hints)
Enterprise-grade resilience + control polish on the generation flow:
- **Retry.** A failed or cancelled run now shows a **Retry** button in the activity-feed header that
  re-runs the last prompt (`lastGenRef`). Wired in both the workspace and the start screen. (Refactored
  the feed header from a single button to a div so the Retry button doesn't nest inside the toggle.)
- **Esc to cancel.** While generating, **Esc** aborts the in-flight run (effect listens only while busy).
- **Auto-scroll.** The activity detail auto-scrolls to the newest item while streaming.
- **Polyglot prompts.** The composer's example suggestions now include non-web ideas (FastAPI service,
  Go CLI, Node/Express API) so the multi-language capability is discoverable.
Files: `components/studio/workspace/{ActivityFeed,PromptComposer}.tsx` (+activityFeed test),
`components/studio/{CodeStudioView,StudioStart}.tsx`. Typecheck + frontend build green; 113 studio
component tests pass.

---

## 2026-06-06 · Claude — FEAT(S4.1): "Services & connections" detector + .env scaffold
First half of the agentic auto-wiring vision ("the AI knows what services/connections it needs"):
- New pure, tested `serviceDetect.ts` (`detectServices`) reads the generated code and infers the
  backends it expects — **Supabase, Postgres, Prisma, MongoDB, Firebase, Stripe, object storage,
  OpenAI, Anthropic, Redis** — plus the **env vars** it references (`process.env`/`import.meta.env`,
  filtering build noise like NODE_ENV/PORT).
- New `ServicesPanel` (in the prompt pane under the build trace) shows the detected services as chips,
  lists the expected env vars, and offers a **real, working action now**: **Add /.env.example** (built
  via `buildEnvExample`, written into the project, opened in the editor) — plus a **Connect your
  accounts →** affordance routing to Settings (the OAuth/token wiring is the prioritized owner-action
  list). Renders nothing when a project needs no services/env.
This advances S4 visibly without needing the owner's credentials; the connect handshake lands with the
P1 owner actions. Files: `components/studio/workspace/{serviceDetect,ServicesPanel}.tsx` (+serviceDetect
test), `workspace/index.ts`, `CodeStudioView.tsx`. Typecheck + frontend build green; 110 studio
component tests pass.

---

## 2026-06-06 · Claude — FEAT: deeper agentic edit flow — node detection, clickable activity, diff/timing markers
Senior-pass polish that connects the flows and adds professional markers:
- **Content-aware project detection.** `detectProjectKind` now takes file *content* and distinguishes a
  **Node backend** (Express/Fastify dep, or a server with `.listen`) from a browser app — fixing the
  bare-`.js` ambiguity. Added a `node` kind + `runHint(kind)` (copy-pasteable run command per language).
  Re-enabled the **Node API** starter (now correctly classified, not a broken web preview).
- **Connected flow.** Activity-feed file rows are now **clickable** — clicking one opens that file in the
  editor (and reveals the Code pane if you were in Preview-only). `ActivityFeed` gained `onOpenFile`.
- **Helpful markers.** The activity header now shows the **file count**, an **aggregate +added/−removed**
  diff, and the **elapsed time** of the run (`activityStore` records `startedAt`/`endedAt`; `diffTotals`
  helper). The non-web preview panel shows a `$ <run command>` hint.
- **Owner actions.** `OWNER-ACTIONS.md` now leads with a single prioritized "what YOU need to do" list
  (P0 light-up live runs; P1 connected-accounts OAuth/tokens for GitHub/Supabase/Railway/Vercel/CF; P2
  optional keys) so nothing about the connected-accounts work is ambiguous when you're ready.
Files: `components/studio/workspace/{projectKind,activityStore,ActivityFeed}.tsx` (+tests),
`components/studio/CodeStudioView.tsx`, `components/studio/assets/templates.ts`, `docs/studio/OWNER-ACTIONS.md`.
Typecheck + frontend build green; 105 studio component tests pass.

---

## 2026-06-06 · Claude — FEAT: polyglot starter templates (Python API, Go CLI)
Showcases the polyglot studio (S3) on the start screen: added **Python API** (FastAPI + requirements
+ README) and **Go CLI** (main.go + go.mod + README) starters to `STARTER_TEMPLATES`. Both are
unambiguously non-web, so they exercise multi-language editor highlighting and the new "run locally"
preview panel end-to-end. (Skipped a bare-`.js` Node-API starter for now — a `.js`-only project is
ambiguous with web and `detectProjectKind` leans web; a node-backend heuristic is a future increment.)
File: `components/studio/assets/templates.ts`. Typecheck + frontend build green; 101 studio component
tests pass.

---

## 2026-06-06 · Claude — FEAT(S4.0): studio error boundary (enterprise hardening)
A render-time crash anywhere in the studio used to take down the whole app (white screen). Added a
reusable, themed `StudioErrorBoundary` (`components/studio/kit/ErrorBoundary.tsx`) that catches it and
shows a recoverable panel — **Try again** (re-mounts the subtree), **Reload** (hard refresh), **Back**
(exits the studio) — with a collapsible error detail, and logs the error + component stack. Wired
around the Code Studio mount in `App.tsx` (imported directly, not via the kit barrel, to keep the main
bundle lean). Files: `components/studio/kit/{ErrorBoundary.tsx,index.ts}` (+errorBoundary test),
`App.tsx`. Typecheck + frontend build green; 101 studio component tests pass (boundary suite added).

---

## 2026-06-06 · Claude — FEAT(S3b): diff-centric live edits + cancellable generation
Two pro/enterprise-grade UX upgrades on top of the live activity stream:
- **Diff-centric edits.** When refining an existing app, the activity feed now marks each file
  **new** vs **modified** and, when the edit resolves, annotates modified files with a **+added /
  −removed** line diff (computed client-side via the existing `diffLines`/`diffStat` LCS engine,
  diffing the streamed result against a pre-edit snapshot). Edits read like a reviewable changelog,
  not a black box. Brand-new apps stay clean (no badges).
- **Cancellable generation.** Generation now runs under an `AbortController`; the composer's submit
  button turns into a **Stop** button while busy (`PromptComposer.onCancel`, hero + inline, threaded
  through `StudioStart`). Cancelling resolves the thread/feed as "Generation stopped." (no red error
  banner) and does **not** fall back to the blocking route. The SSE clients already accept a signal.
Files: `components/studio/workspace/{activityStore,ActivityFeed,PromptComposer}.tsx` (+activityStore
test), `components/studio/{CodeStudioView,StudioStart}.tsx`. Typecheck + frontend build green; 148
studio tests pass.

---

## 2026-06-06 · Claude — FEAT(S3): polyglot studio — generate/understand/support many languages
Per the owner's steer ("enhance our ability — code in multiple languages, understand/support relevant
code"). The studio was web-only (React/TS); now it's polyglot:
- **Generation** is language-agnostic: `buildGeneratePrompt`/`OUTPUT_CONTRACT` now tell the model to pick
  the right language/stack for the idea (web UI, Node/Python API, CLI, script, Go, …), emit the right
  manifest (`package.json`/`requirements.txt`/`go.mod`) + a README with run steps, and set `template` to
  the closest web template ("static" for non-web). `server/src/ai/studio/studioGenerate.ts`.
- **Editor** highlights ~30 languages: `MonacoEditor` `langFromPath` replaced with a broad ext→Monaco map
  (python/go/rust/java/kotlin/c/cpp/csharp/php/ruby/shell/sql/graphql/dockerfile/…), not just web files.
- **Preview** is honest for non-web projects: new pure, unit-tested `projectKind.ts` (`detectProjectKind`)
  classifies the file set (web wins when present, else the dominant language); the preview pane renders the
  in-browser preview for web projects and a clean "{Language} project — run locally / cloud-run / download"
  panel for non-web ones instead of a broken browser preview.
Files: `server/src/ai/studio/studioGenerate.ts`, `components/studio/workspace/{MonacoEditor,projectKind}.tsx`
(+projectKind test), `workspace/index.ts`, `CodeStudioView.tsx`. Typecheck + server build + frontend build
green; 147 studio tests pass.

---

## 2026-06-06 · Claude — FEAT(S2): Code ⇄ Preview focus toggle (maximize real estate)
The studio's wide layout was a fixed 3-pane split, so reviewing code or the running app meant
squinting at a third of the screen. Added a **Code · Split · Preview** segmented toggle
(`components/studio/kit/FocusToggle.tsx`) in the top bar, backed by a persisted `focusStore`
(localStorage, like the theme). "Code" gives prompt + editor, "Preview" gives prompt + running app,
"Split" is the default 3-pane — each focus keeps its own resize state via a distinct
`ResizableSplit` storageKey, so widths don't clobber each other. The stacked (narrow) layout hides
the non-focused pane too. Also added ⌘K command-palette entries (Focus: Code/Split/Preview). The
toggle uses `aria-label` (not an sr-only text node) so it doesn't collide with the "Code" pane
title in tests. Files: `components/studio/kit/{focusStore,FocusToggle}.tsx` (+focusStore test),
`components/studio/kit/index.ts`, `components/studio/CodeStudioView.tsx`. Typecheck + build green;
139 studio tests pass.

---

## 2026-06-06 · Claude — FEAT(S1): live agentic activity stream for app generation
The #1 complaint — "the AI isn't working synchronously, I can't see what it's doing" — was real:
`/api/studio/generate` was fully blocking, so generation showed a single "Generating your app…"
spinner for the entire 20–60s with zero feedback (the streaming `BuildTrace` only existed for the
gated cloud `/build`). Now generation streams:
- **Server:** new SSE route `POST /api/studio/generate/stream` token-streams the model via
  `runChat({onDelta})` and emits `start` / `phase` / `file` (writing→written, with byte counts) /
  `result` events. New pure, unit-tested incremental JSON parser `server/src/ai/studio/streamParse.ts`
  (`scanStreamedFiles`) discovers each file as soon as its path appears and marks it complete when its
  object closes — tolerant of escapes, `\uXXXX`, and chunk-split boundaries. Keeps a stricter
  non-streamed retry, mirroring `runGenerate`. The blocking `/generate` stays for back-compat/tests.
- **Client:** `streamGenerateStudioApp()` (mirrors `studioBuildApi`); a new `activityStore` +
  `ActivityFeed` component render the live feed — phases as steps, files spinning then ✓ with size,
  auto-collapsing to a one-line summary ("✓ Built … 6 files") that re-opens. Wired into
  `CodeStudioView.handleGenerate` (and surfaced on `StudioStart` for the first build) with a graceful
  fallback to the blocking generate if SSE is unavailable.
- Plan: new `docs/studio/CODE-STUDIO-LIBRECHAT-PLAN.md` maps LibreChat's premium features → our
  sprints (S1 here; S2 code/preview toggle; S3 diff edits; S4–S6 service/account auto-wiring).
Files: `server/src/ai/studio/streamParse.ts` (+test), `server/src/routes/studio.ts`,
`services/studioGenerateApi.ts`, `services/sse.ts` (reused), `components/studio/workspace/{activityStore,
ActivityFeed}.tsx` (+activityStore test), `components/studio/{CodeStudioView,StudioStart}.tsx`,
`components/studio/workspace/index.ts`. Client typecheck + server build green; 136 studio tests pass; frontend build green.

---

## 2026-06-06 · Claude — FIX: header nav vanished < 1024px; studio panes collapsed in the wide layout
Two responsive bugs, both browser-verified (headless Chromium screenshots at 800/1280px):
- **Header had no nav under 1024px.** The product nav is `hidden lg:flex` with no fallback, so below
  the `lg` breakpoint there was no navigation at all. Added a hamburger + mobile menu in
  `StaticSiteHeader` listing every product group (Comic / AI Chat / Code / Models) + Sign In. Verified:
  the hamburger appears < 1024px and opens the full menu; the desktop nav is unchanged ≥ 1024px.
- **Studio wide layout could collapse.** `ResizableSplit`'s root had no height (`flex flex-col min-h-0`
  with no `h-full`), so in the ≥1024px 3-pane layout the panes could size to 0 until a resize forced a
  reflow (opening DevTools) — compounding the earlier blank-render report. Added `h-full w-full` so the
  split fills its parent. Verified: panes now measure ~620px and the studio renders fully.
Typecheck + build green; 82 studio tests pass.

---

## 2026-06-06 · Claude — FIX: studio + header rendered blank until a forced repaint (backdrop-filter glitch)
The redesign regressed rendering: opening a built project (e.g. the Counter template) showed a BLANK
studio until a repaint was forced (e.g. opening DevTools). Cause: the new aurora used animated
`filter: blur(120px)` blobs with `will-change: transform`, and the glass panels were ~97.5%
transparent with `backdrop-blur-xl` — a GPU compositing combo that fails to paint until a repaint
(and since the panels were near-transparent, the failure showed as nothing at all). Fixes:
- Studio panels are now SOLID (`#101016` / `#16161d`), no `backdrop-blur`.
- `StudioAurora` is filter-free STATIC radial-gradients — no `blur()`, no `will-change`, no animation.
- Removed `backdrop-blur` from the composer box and the Button `secondary` variant.
- Main app header (`StaticSiteHeader`): dropped `backdrop-blur-md` (and `bg-white/95` → `bg-white`) —
  the same backdrop-filter created a stacking context that could hide the header behind an open
  right panel (the "can't see the header when a panel is open" report).
Typecheck + build green; 82 studio tests pass.

---

## 2026-06-06 · Claude — Code Studio: more reliable generation (stricter retry)
Generation now retries ONCE with a stricter "output ONLY JSON" reminder when the model's first
answer can't be parsed (truncation/prose/fence noise), cutting "the model did not return a valid
app" failures. New tested runGenerate(complete, input) helper (injected model call) drives it; the
/api/studio/generate route uses it. Server typecheck green; 11 generate tests pass.

---

## 2026-06-06 · Claude — Code Studio: conversational build thread
The studio now keeps a live conversation (your prompts + the agent's outcomes) above the iterate
composer — generate/refine/quick-action/autofix all post to it with pending→done/error status, so
building feels like a conversation (Lovable/Bolt). New conversationStore (4 tests) + ConversationThread;
cleared on studio entry and when a brand-new app starts. Typecheck + build green; 82 studio tests pass.

---

## 2026-06-06 · Claude — Code Studio: one-click quick-refine actions
Lovable-style "what next" chips under the iterate composer (✨ Polish UI · 🌙 Dark mode · 📱
Responsive · 🎬 Animations · 🧪 Sample data). Each fires a refine via the existing in-studio
generate path, so iterating an app is one click. Typecheck + build green; 78 studio tests pass.

## 2026-06-06 · Claude — Code Studio: in-preview autodebug ("Fix with AI" loop)
The "autodebug" ask, closed in-browser (no worker needed). `CodeStudioPanel` moved to Sandpack's
composed API (`SandpackProvider` + `SandpackLayout` + an `ErrorWatcher` using `useSandpack`), so the
preview's runtime/compile errors are observable. When the instant preview errors, the studio shows a
**⚠ Error · Fix with AI** bar; one click feeds the exact error back to the model as a refine, which
returns corrected files → the preview re-runs. The studio preview is now **preview-only** (the
Monaco Code pane is the editor); chat still gets the full editor+preview. Typecheck + build green;
464 tests pass (3 unrelated Supabase-env suites aside).

## 2026-06-06 · Claude — FIX: previews crashed + builds 429'd permanently (the "nothing works" report)
Real bugs behind "the builds don't even work" + a console full of errors:
- **Preview crash** (`Cannot set properties of null (setting 'innerHTML')` in Sandpack): generated/
  starter apps are real **Vite** projects (`/index.html` → `/src/main.tsx` → `/src/App.tsx`), but
  Sandpack's react template expects `/App.tsx` + its own entry + `/public/index.html` with
  `#root`. No `#root` → the mount threw. New **`components/studio/workspace/sandpackProject.ts`**
  normalizes ANY app into Sandpack's canonical shape (detects the root component, injects a
  guaranteed `#root` html + an entry that mounts it and imports all CSS, strips the app's own
  entry/html). `CodeStudioPanel` now uses it. **5 unit tests.**
- **Build 429 (Too Many Requests) — permanent:** `/api/studio/build` inserted a `studio_runs` row
  with `ended_at = null` and **never set `ended_at` on completion**, so every build counted as an
  "active run" forever; after `STUDIO_MAX_CONCURRENT_PER_USER` (=2) builds, every build 429'd.
  Fixed: builds that don't end with a live preview now set `ended_at`; the concurrency count is
  **time-bounded** (only runs started in the last 30 min count), so abandoned/stale runs can't lock
  a user out.
- **429 cascade from generate:** generate **no longer auto-fires** the live cloud build (it hit the
  cap on every prompt). Generate → instant in-browser preview; **Build** is an explicit action.
- Generate prompt now requires the React root to be the **default export** of `/App.tsx` so the
  preview entry can always mount it.
**Verify:** client + server typecheck, production build green; **86 studio tests** (incl. 5 new
sandpack-normalizer) pass.

## 2026-06-06 · Claude — Code Studio: in-place prompt→build + Linear/AI-studio dark redesign
**Why:** the studio still bounced users to chat to start an app (the "Prompt · Build" pane was a
dead `(Sprint 2)` placeholder; every CTA did `onNavigate('chat')`), and the themes felt flat. This
makes Code Studio an actual app builder — type an idea, it builds **right here** — and gives it a
premium, AI-centric look.

**New — type your idea → app builds in the studio (no chat hand-off):**
- **`server/src/ai/studio/studioGenerate.ts`** (+ test, 8 cases) — pure prompt builder + tolerant
  JSON parser (handles fences/prose; prefers the outermost object). Generate **and** refine modes.
- **`POST /api/studio/generate`** in `server/src/routes/studio.ts` — reuses the build route's
  coding-model plumbing (`resolveProviderContext` → `pickCodingModel`/`TEXT_FALLBACK` → `runChat`).
  **Not** gated by the Cloudflare worker — generation is pure LLM, so it works as soon as a coding
  key is set; the live cloud run (`/build`) remains the upgrade.
- **`services/studioGenerateApi.ts`** + **`components/studio/workspace/PromptComposer.tsx`** — a
  real composer (hero + inline/iterate modes, aurora glow, auto-grow, ⏎ to generate, suggestion
  chips, framework pills). Wired into `CodeStudioView` (`handleGenerate`: generate → load →
  auto-build when live-enabled) and `StudioStart` (leads with the hero composer; chat-redirect CTAs
  removed). Preview now defaults to the **instant in-browser** Sandpack for everyone (works without
  the worker), not just non-admins.

**New — Linear / AI-studio dark redesign (Code-Studio-scoped):**
- shadcn/21st.dev foundation: `lib/utils.ts` (`cn`), `components/ui/{button,textarea,badge}.tsx`
  (cva + cn), deps `clsx` + `tailwind-merge` + `class-variance-authority`. The `magic` (21st.dev)
  MCP is wired for pulling further components.
- Premium dark theme: `kit/theme.ts` `black` → near-black `#0B0B0F` base, frosted-glass panels
  (`backdrop-blur`), electric violet accent (was flat OLED + sky). `kit/StudioAurora.tsx` + aurora
  keyframes in `index.css` (reduced-motion safe). Monaco `studio-black` bg retuned to match.

**Verify:** client + server typecheck green; production build green; **73 studio tests + 8 new
generate tests pass; 459 total** (3 unrelated suites fail only on unset Supabase env).
**Owner note:** live cloud Build/Run still needs `STUDIO_WORKER_URL` + `VITE_STUDIO_LIVE_ENABLED`;
in-studio generation needs a coding key (OpenRouter BYOK or platform `OPENROUTER_API_KEY`).

## 2026-06-06 · Claude — FIX: Code Studio rendered blank (entrance animations gated visibility)
**Bug:** opening Code Studio showed a blank page (content present in the DOM, visible only after
opening DevTools forced a repaint). Cause: the Motion Kit's `Reveal`/`Stagger`/`StaggerItem` and
the two modals used Framer Motion with `initial` opacity:0 → `animate` opacity:1. When the JS enter
animation didn't run (e.g. RAF throttled while the tab wasn't focused on load), content stayed at
opacity:0. The studio is the only surface using Framer, which is why only it went blank.
**Fix:** reveals are now **CSS-driven and visible-by-default** (`.studio-reveal` / `.studio-stagger`
/ `.studio-pop` in index.css, `animation-fill-mode: both` → end-state opacity:1) — matching the
rest of the app's proven CSS-animation pattern. Animation is now a pure enhancement, never a
visibility gate; reduced-motion still respected. Framer remains only for non-gating decoration
(Lift hover, StatusPulse ring, Confetti). 73 studio tests; typecheck + build green.

## 2026-06-05 · Claude — Sprint 4: first-run onboarding welcome (S4.1)
- **`components/studio/StudioWelcome.tsx`** — a dismissible, **persisted** (localStorage)
  first-run card atop the Code Studio home: a 3-step orientation (template/chat → Build runs &
  self-heals → iterate + share). Themed + animated. Test: shows once, persists dismissal.
  73 studio tests; typecheck + build green.

## 2026-06-05 · Claude — build: split heavy vendors into cacheable chunks
- `vite.config.ts` `manualChunks` splits framer-motion, sandpack/CodeMirror, react-markdown,
  leaflet and jszip into their own vendor chunks. **Main entry: 638 kB → 272 kB** (gzip 82 kB);
  heavy libs now cache independently of app code. `vendor-sandpack` (~982 kB) is lazy-loaded, so
  the size-warning limit is set above it — build is now warning-free. (Build-only; no app behaviour
  change.)

## 2026-06-05 · Claude — a11y: modal Escape + focus restore
- **`kit/useDialogA11y.ts`** — while a portaled modal is open, **Escape closes it from anywhere**
  and focus is **restored** to the previously-focused element on close. Applied to the
  CommandPalette + ShortcutsHelp (+ `aria-modal`, the help dialog now takes focus on open).
- Test: help closes on Escape. 72 studio tests; typecheck + build green.

## 2026-06-05 · Claude — Sprint 4: model-tier / BYOK surface (S4.3)
- The top-bar **coding** chip is now honest about the build model tier: **coding · free** (strong
  open model, free-first) vs **coding · your key** when an OpenRouter key is set (BYOK → frontier
  models). Clicking it opens **Settings** (the BYOK upsell). Reflects the route's existing routing
  (no behaviour change). 71 studio tests; typecheck + build green.

## 2026-06-05 · Claude — docs: bring 00-STATUS current (Sprints 0–5 shipped)
Refreshed the authoritative tracker — Experience ~85%, "Latest" + "Where we are" now reflect the
~19 increments shipped (Sprints 0–5) and the honest "needs the owner" list (live Build validation,
prompt→generate, deploy/GitHub export, GA gating, app-wide design rollout).

## 2026-06-05 · Claude — Sprint 5: duplicate project (S5.2-lite)
- **`StudioStart`** project cards get a **Duplicate** action — loads the project's files as a
  fresh untitled "Copy of …" (no project id), so the next Build saves it as a new project.
  Non-destructive to the original; client-only (no backend). Test added. 71 studio tests; green.

## 2026-06-05 · Claude — Sprint 3: version history + restore (S3.3, full)
Additive, read-only backend + UI (no change to existing behaviour):
- **Backend** — `studioRepository.listVersions` / `getVersionFiles` (ownership-scoped) + routes
  **`GET /api/studio/projects/:id/versions`** and **`.../versions/:vid`**. Server typechecks.
- **Build now persists to a stable project** — the client sends the workspace `projectId` and
  adopts the one the route returns (`onStart`), so rebuilds update the same project and
  accumulate versions (instead of spawning a new project each time).
- **Workspace store** — `projectId` (+ `setProjectId`), and `replaceFiles` (restore a version as
  a fresh clean baseline; non-destructive — building snapshots a new version).
- **`workspace/HistoryPanel.tsx`** — a collapsible **History** list in the Prompt/Build pane:
  per-version label, author (agent/user), relative time, and **Restore**.
- Client `listStudioVersions` / `getStudioVersionFiles`. Tests: store (projectId/replaceFiles) +
  `historyPanel.test.tsx` (list + restore). 70 studio tests; client + server typecheck + build green.
- ⚠️ The new routes are DB-bound (unit tests cover the pure store/UI, not the Supabase calls);
  wants a signed-in validation against the live DB.

## 2026-06-05 · Claude — Sprint 4: keyboard-shortcuts help overlay (S4.2)
- **`kit/ShortcutsHelp.tsx`** — a themed, portaled modal listing the studio shortcuts (⌘K, ⌘B,
  ⌘↵, ⌘S, Esc). Opened from a top-bar **?** button + a **Keyboard shortcuts** palette command.
- Test: `shortcutsHelp.test.tsx` (open/close + content). 65 studio tests; typecheck + build green.

## 2026-06-05 · Claude — Sprint 4/5: share live link + build shortcuts (S5.1-lite / S4.2)
- **Share** — the top-bar Share button now **copies the live preview URL** (with a "Copied!"
  state) while the container is alive — a real share-the-running-app MVP, no backend. Disabled
  until the app is running.
- **Shortcuts** — global **⌘B / ⌘↵** trigger Build (guarded), **⌘K** the palette, **⌘S** is a
  no-op (Code Studio saves on Build). Build now guards against re-entrancy + gating.
- 63 studio tests; typecheck + build green. (Token-scoped expiring share links — full S5.1 — need
  a backend endpoint and are deferred.)

## 2026-06-05 · Claude — Sprint 4: starter templates gallery (S4.1)
- **`assets/templates.ts`** — `STARTER_TEMPLATES`: Counter + Todo (Vite React+TS scaffolds) and a
  static Landing page — minimal but valid/runnable projects (real package.json/vite config).
- **`StudioStart`** — a **"Start from a template"** grid (logo + name + description); clicking
  hydrates the template into the workspace → one Build away from running (zero→app in ≤2 clicks).
- Test: template-loads-into-workspace. 63 studio tests; typecheck + build green.

## 2026-06-05 · Claude — Sprint 4 (start): ⌘K command palette (S4.2)
- **`kit/CommandPalette.tsx`** — a ⌘K palette (fuzzy filter, arrow-key nav, Enter to run, Esc to
  close; spring-animated, portaled, themed). Generic `Command[]` API.
- **`CodeStudioView`** — global ⌘K/Ctrl-K listener + a top-bar ⌘K hint; commands wired:
  Build & run, Stop, Revert all, Download .zip, Theme (Black/White/DreamStream), Build from chat,
  Back — each shown only when relevant.
- Tests: `commandPalette.test.tsx` (filter / click-run / Esc / Enter). 62 studio tests; typecheck
  + build green.

## 2026-06-05 · Claude — Sprint 3: Changes view — diff + revert (S3.1/S3.3)
- **`workspace/diff.ts`** — a pure LCS line diff (`diffLines` + `diffStat`), unit-tested.
- **`workspace/DiffView.tsx`** — themed +/- diff rendering. **`workspace/ChangesPanel.tsx`** —
  the "what changed since you opened this" view: dirty files (working copy vs. loaded baseline),
  each with a +/- stat, an expandable diff, **per-file Revert** + **Revert all**. Wired into the
  Prompt/Build pane above the BuildTrace.
- Self-contained (no backend); changes persist on the next Build. Full cross-build version
  history/restore (`studio_versions`) is deferred (wants a versions list/restore endpoint).
- Tests: `diff.test.ts` (LCS), `changesPanel.test.tsx` (list + revert). 58 studio tests; typecheck
  + build green.

## 2026-06-05 · Claude — Sprint 3 (start): file ops — add / delete / rename (S3.4)
- **Workspace store** gains `addFile` / `deleteFile` / `renameFile` with a safe
  `normalizeStudioPath` (rejects traversal/empty) + `renameInDir` (keeps the directory). Rename
  preserves content, dirty state and open tabs; delete refocuses a neighbour; add focuses the
  new file. All persist on the next Build (save-on-build).
- **FileTree** rows get hover **Rename** (inline input) + **Delete** actions; **CodeWorkspace**
  Explorer header gets a **New file** affordance (inline path input). All gated off in read-only
  (non-admin) mode.
- Tests: path helpers + add/delete/rename/no-overwrite lifecycle (53 studio tests). Typecheck +
  build green.
- (Manual edit → re-run / S3.2 already worked: edit the working copy → Build re-runs it.)

## 2026-06-05 · Claude — Sprint 2: illustrated empty states (S2.5) + stuck-loop UX (S2.4)
- **`kit/EmptyState.tsx`** + **`assets/illustrations.tsx`** (`EmptyProjectsArt`, `BuildErrorArt`,
  on-brand inline SVG using currentColor) — `StudioStart`'s empty state is now illustrated.
- **`BuildTrace`** — a failed/stuck build now shows a friendly **"over to you"** nudge with an
  actionable hint (edit + Build again / refine by prompt) instead of a raw guard reason; pure
  `friendlyReason()` helper, unit-tested.
- Tests: `emptyState.test.tsx`, `friendlyReason` + stuck-footer render. 46 studio tests; typecheck
  + build green.
- **Sprint 2 is substantially complete** (agentic build, BuildTrace, celebration, stuck UX,
  illustrated states). Deferred: prompt→generate (S2.1) + model-routing surface (S2.3) — both want
  a small backend endpoint, best landed with a signed-in validation.

## 2026-06-05 · Claude — Sprint 2: success celebration (S2.7) + tech logos via 21st.dev MCP
- **`kit/Confetti.tsx`** — a one-shot framer-motion celebration burst (reduced-motion safe,
  self-removing). Fires over the workspace on a **green build** (`result.ok`).
- **`assets/techLogos.tsx`** — React / TypeScript / JavaScript / HTML5 marks (TS/JS/HTML5
  sourced via the **21st.dev Magic MCP `logo_search`**) + a `TemplateLogo` dispatcher; now
  shown on the `StudioStart` project cards.
- Tests: `confetti.test.tsx` (particles + reduced-motion), `techLogos.test.tsx`. Studio suite
  green; typecheck + production build green.

## 2026-06-05 · Claude — Sprint 2 (start): agentic build + BuildTrace (S2.2/S2.6/S2.7)
The "Lovable moment" — the primary action is now an **agentic Build** that streams the loop.
- **`services/sse.ts`** — a dependency-free SSE reader (`parseSSEBlock` + `readSSEStream`),
  pure + unit-tested. **`services/studioBuildApi.ts`** — `streamStudioBuild()` POSTs to
  `/api/studio/build` and dispatches typed `BuildEvent`s (start/plan/run/observe/fix/done/result/
  error), mirroring the server contract. Added a `del` helper earlier; reused `postStream`.
- **`workspace/buildStore.ts`** (zustand) — the live trace state. **`workspace/BuildTrace.tsx`** —
  an **animated timeline** (each stage springs in, the active stage pulses, observation summaries
  surface, a success/stopped footer with a flourish). Replaces the static placeholder.
- **`CodeStudioView`** — the hero button is now **Build** (`Wand2`): streams plan→run→observe→fix→
  done, feeding BuildTrace + the logs console + run status; the final preview URL boots the live
  pane. Save-on-build (S2.6) is handled by the route. Success flourish (S2.7) in the footer.
- Tests: `sse.test.ts` (parser + chunked stream), `buildTrace.test.tsx` (store lifecycle +
  trace render). 45 studio/sse tests. Typecheck + build green.
- Remaining Sprint 2: prompt→generate (S2.1), model routing surfaced (S2.3), stuck UX (S2.4),
  illustrated error/empty states (S2.5), fuller celebration (S2.7 Lottie).

## 2026-06-05 · Claude — Sprint 1 COMPLETE: load saved projects (S1.7) + start screen
- **`services/studioApi.ts`** — `listStudioProjects` / `getStudioProject` / `deleteStudioProject`
  (Phase 5 `/api/studio/projects*`); added a `del` helper to `apiClient`.
- **`components/studio/StudioStart.tsx`** — the Code Studio home: a gallery of saved projects
  (open / delete, relative times, template chips, animated cards) shown when nothing is loaded.
  Opening hydrates the project's files into the workspace store → the 3-pane workspace takes over.
- **Workspace store** now keeps `title` + `template` and a `workspaceCurrentArtifact()` builder,
  so **Run live / .zip work for projects opened from the start screen** (not just chat hand-offs).
  `CodeStudioView` reads the runnable app from the store throughout.
- Tests: `StudioStart.test.tsx` (list / open-into-workspace / empty) + view test updated. Studio
  suite green; typecheck + build green.
- **Sprint 1 is complete** — workspace shell, Monaco editor, file tree, tabs, dirty tracking,
  resizable panes, streaming logs, live-preview device frames, load saved projects, responsive,
  plus the three-theme design system. Shipping to production.

## 2026-06-05 · Claude — Sprint 1 (cont.): live-preview device frames + boot reveal (S1.4)
- **`workspace/PreviewFrame.tsx`** — the live-preview surface: a device-size toggle
  (desktop/tablet/mobile with a device frame), **refresh**, **open-in-new-tab**, the preview
  URL, and a **boot reveal** (shimmer skeleton → iframe fades in on load). Themed.
- Wired into `CodeStudioView` (replaces the raw preview iframe). `+ previewFrame.test.tsx`
  (toolbar + device toggle). 34 studio tests. Typecheck + build green.
- **Workflow:** per owner — every PR now fast-forwards to production once CI is green (no
  parked previews). Remaining Sprint 1: load saved projects (S1.7).

## 2026-06-05 · Claude — Sprint 1 (cont.): resizable panes (S1.1) + logs console (S1.5)
- **`kit/ResizableSplit.tsx`** — a flex N-pane splitter with draggable gutters + sizes persisted
  to localStorage (flex-grow weights, fluid across window resizes). Pure `applyGutterDelta`
  clamp helper (unit-tested). **`kit/useMediaQuery.ts`** (`useIsWide`) for responsive layout.
- **`workspace/logsStore.ts` + `LogsConsole.tsx`** — a capped (500) console buffer + a
  severity-coloured, monospace, auto-scrolling console with clear + autoscroll toggle. Run live
  now streams lifecycle lines (launching / preview-ready / stopped / errors) into it.
- **`CodeStudioView`** rebuilt: on wide screens a **resizable** vertical split (3-column
  horizontal workspace over the logs console); on small screens a stacked, scrollable layout
  (S1.8). 21st.dev Magic MCP component builder was attempted for the console but **timed out**,
  so it was hand-built to match the kit/theme (will retry Magic for lighter pieces).
- Tests: `ResizableSplit.test.ts` (clamp math) + `logsConsole.test.tsx` (store cap/clear +
  console render/clear). 32 studio tests total. Client typecheck + production build green.
- Remaining Sprint 1: live-preview device frames + boot reveal (S1.4), load saved projects (S1.7).

## 2026-06-05 · Claude — Code Studio theming: Black / White / DreamStream (Code-Studio-only)
Per owner request — three switchable workspace themes, scoped to Code Studio (the main app
is untouched):
- **`kit/theme.ts`** — a token registry (`STUDIO_THEMES`): `black` (absolute-black OLED),
  `light` (clean white), `brand` (DreamStream comic look — black borders, brand yellow CTA,
  brand-blue accents). Same token shape per theme (bg/panel/edge/hover/text/accent/…).
- **`kit/themeStore.ts`** — persisted zustand store + `useStudioTheme()` hook every surface
  reads; choice saved to localStorage (`studio.theme`).
- **`kit/ThemeSwitcher.tsx`** — segmented Black/White/DreamStream control in the workspace
  top bar.
- Threaded the hook through `CodeStudioView`, `CodeWorkspace`, `FileTree`, `EditorTabs`,
  `StatusPulse` (theme-aware status text) and **Monaco** (defines `studio-black` +
  `studio-light`, follows the active theme). Replaced all dark-only literals (`hover:bg-white/5`,
  `text-white`, hard hexes) with tokens so light/brand render correctly.
- Tests: `theme.test.tsx` (registry completeness, store persistence, switcher). +5 studio tests
  (23 total). Client typecheck + production build green.

## 2026-06-05 · Claude — Sprint 0 SHIPPED TO PROD + Sprint 1 (editor): Monaco workspace
- **Sprint 0 merged to production** (`Dreamstrream-v1`, PR #83, CI green). Code Studio route,
  Motion Kit, one-CTA hand-off + legacy quarantine are live.
- **Sprint 1 (S1.2/S1.3 — editor core):** new `components/studio/workspace/` — a real editor:
  - `workspaceStore.ts` (zustand) — single source of truth: working copy per file, open tabs,
    active tab, **dirty tracking vs. baseline**, open/close/edit/revert + pure helpers
    (`isPathDirty`, `dirtyPaths`, `workspaceToArtifact`, `buildTree`).
  - `MonacoEditor.tsx` — `@monaco-editor/react` with a custom **studio-dark** theme, per-file
    models, language inferred from path, JSX-tolerant TS. (Monaco loads lazily from CDN.)
  - `FileTree.tsx` — real **nested folder tree** (expand/collapse, dirty dots, Stagger-in).
  - `EditorTabs.tsx` — closable tabs with dirty dot + active underline.
  - `CodeWorkspace.tsx` — composes tree + tabs + Monaco; dropped into the Code pane.
  - `CodeStudioView` now loads the hand-off into the workspace, shows an **unsaved** counter,
    and **Run live runs the working copy** (edits boot). Non-admins get a read-only editor.
  - Tests: `workspaceStore.test.ts` (tree/dirty/lifecycle/working-copy) + view test updated
    (Monaco stubbed). Client typecheck + production build green; +6 studio tests.
- Remaining Sprint 1: resizable panes (S1.1), live preview device frames + boot reveal (S1.4),
  streaming logs (S1.5), Run/Stop status polish (S1.6), load saved projects (S1.7), responsive (S1.8).

## 2026-06-05 · Claude — Sprint 0 (front-end + design system): Motion Kit, Code Studio route, one CTA
Built the buildable front-end half of Sprint 0 (the backend — S0.1 worker-URL guard + S0.3
`/api/studio/build` SSE — shipped previously). All additive + gated; admins ungated.
- **S0.5 — Motion Kit + studio theme.** New `components/studio/kit/` — house-styled wrappers
  over Framer Motion that respect `prefers-reduced-motion`: `Reveal`, `Stagger`/`StaggerItem`,
  `Lift`, `Shimmer`/`Skeleton`, `StatusPulse` + motion tokens (springs) and a `usePrefersReducedMotion`
  hook (matchMedia-safe, no test mock needed). Dark "studio" theme tokens in `kit/theme.ts` +
  `colors.studio.*` in tailwind + a reduced-motion-guarded `.studio-shimmer` keyframe in index.css.
  Added deps `framer-motion@12` + `lottie-react@2`. `+ kit.test.tsx` (9 cases, incl. reduced-motion).
- **S0.4 — Code Studio route skeleton.** New `components/studio/CodeStudioView.tsx` — a dark,
  animated 3-pane shell (Prompt/Build · Code · Live preview) over a Console/Logs bar, wired into
  App as the `codestudio` view (full-screen; shared header/FAB/assistant hidden). Admin-gated:
  admins (or the live flag) get the shell with a working **Run live** (drives the existing launch
  backend; surfaces the honest "not configured" error = the S0.6 hook); non-admins get a clean
  private-preview gate with an instant in-browser peek of any handed-off app (decision D3) so the
  CTA never dead-ends. `+ CodeStudioView.test.tsx` (3 cases: admin shell / non-admin gate / empty).
- **S0.2 — Collapse the card to one CTA + quarantine legacy engines.** `CodeStudioCard` now shows a
  single animated **"Open in Code Studio"** run CTA (+ a quiet `.zip`) that hands the app off via a
  new `services/studioHandoff.ts` zustand store → App routes to the studio view. Retired the
  "Run live" + Sandpack "Quick preview" buttons from the card. New `services/studioFlags.ts`
  (`isLiveStudioEnabled` re-exported here + `isLegacyStudioEnabled`, default off): the chat's
  Sandpack side-panel auto-open and the standalone `/studio.html` WebContainer page are now
  quarantined behind that dead flag (the page renders a "moved to Code Studio" redirect). Header's
  admin "Open Code Studio" now routes to `codestudio` (was `chat`). `+ CodeStudioCard.test.tsx`.
- **S0.6 — live round-trip:** still owner-side (needs a real `STUDIO_WORKER_URL` + a signed-in admin
  launch). The Run live button is the validation hook.
- Verified: client + server typecheck, **385 tests** (+14; the 3 failing suites are the pre-existing
  Supabase-env-unset ones), production build — all pass.

## 2026-06-05 · Claude — Sprint 0 (backend): /api/studio/build route + worker-URL guard
- **S0.1** `services/studioWorker.ts` — `isValidStudioWorkerUrl` + `studioConfigured` now reject
  the docs placeholder / malformed `STUDIO_WORKER_URL`, so a bad value returns a clean
  "not configured" 503 instead of a `fetch()` "Failed to parse URL" crash. + tests.
- **S0.3** `routes/studio.ts` — **`POST /api/studio/build`** (SSE): composes the tested Phase 4
  engine (`runBuildAgent`) with the live worker `run` (`createWorkerRun`) + a guard-railed
  coding-model `fix` (`createStudioFix` + `runChat`/`pickCodingModel`, user key or platform
  fallback). Streams BuildEvents (plan/run/observe/fix/done) + a final `result`; auth + caps +
  run metering; persists run + project. Additive + gated (nothing calls it until the UI lands).
- Server typechecks; studio service tests green. Remaining Sprint 0: Motion Kit, Code Studio
  route/view, collapse the card to one CTA, live round-trip validation (needs real worker URL).

## 2026-06-05 · Claude — Admins are never feature-gated (Code Studio + Run live)
Fix: admins couldn't see Code Studio or the live "Run live" button — both were gated by a
build flag / a hardcoded "Soon", with no admin bypass.
- `hooks/useIsAdmin.ts` — cached client admin signal (backed by `/api/admin/me`).
- `CodeStudioCard.tsx` — "Run live" now shows when `isLiveStudioEnabled() || isAdmin`.
- `StaticSiteHeader.tsx` — admins get a real **Open Code Studio** nav entry (→ chat) instead
  of the "Soon" coming-soon capture; `App.tsx` passes `isAdmin`.
- Confirmed the owner account has role `admin` (configured via the `ADMIN_EMAILS` env var, not
  hardcoded), so this unblocks the owner to exercise the live container path. Server still needs
  `STUDIO_WORKER_URL` set for a launch to succeed (else a clear "not configured" error).
- Findings logged: the in-chat preview is **Sandpack** (in-browser, no Vite) which mis-renders
  Vite-style projects as "Hello world"; the Cloudflare container ("Run live") is the correct
  engine. Making it the canonical Code Studio preview + improving generate_app model routing
  are the next product steps.

## 2026-06-05 · Claude — Phase 4: guard-railed FIX dep (createStudioFix)
- `services/studioBuildService.ts` — `createStudioFix(complete, opts)` composes
  `requestStudioFix` (observation-driven minimal-diff model call) with `sanitizeFixFiles`
  (the guardrails) into the `fix(files, observation)` dep `runBuildAgent` expects. The
  injected `complete` is the request-scoped model call (runChat + pickCodingModel).
- Tests: drops unsafe paths from model output; passes the observation prompt through.
- **Phase 4 backend is now complete + fully tested.** The only remaining piece is the
  `/api/studio/build` SSE route (compose createWorkerRun + createStudioFix + an auth-scoped
  `complete`, stream the trace) — best landed alongside a signed-in live validation — and
  the `BuildTrace` client.

## 2026-06-05 · Claude — Phase 4 guardrails: FIX-output safety + path-traversal hardening
Safety rails for the autonomous build loop (and a security win for the existing launch path):
- `services/studioFiles.ts` — `isSafeStudioPath` (rejects `..` traversal, NUL/backslash,
  `~`, over-long) + `canonicalStudioPath` + `MAX_STUDIO_FILE_BYTES` (1 MiB/file).
- Hardened `sanitizeFiles` (launch path) to drop traversal/oversized entries.
- `sanitizeFixFiles(record, opts)` — guards each FIX iteration: rejects unsafe paths,
  caps per-file + total bytes + file count (default 40), canonicalizes keys so merges
  overwrite (fixes a latent duplicate-key bug between `studioFix` and `sanitizeFiles`), and
  reports what it dropped (for the trace).
- Tests: traversal/oversize/cap/canonicalization. Suite 372 green.

## 2026-06-05 · Claude — Phase 4: live RUN capability (worker launch→logs→probe)
- `server/src/services/studioBuildService.ts` — `createWorkerRun` builds the `run(files)`
  dep for `runBuildAgent`: (re)launch the container, fetch dev logs, probe the preview's
  HTTP status, normalize via `toRunResult`. Worker call + HTTP probe are injectable.
  Plus `filesRecordToArray` (orchestrator map → worker file array) and `probePreview`.
- Tests: `studioBuildService.test.ts` incl. an end-to-end `runBuildAgent` drive (missing
  dep → injected fix → clean) using a mocked worker. Suite 368 green.
- Remaining for the live loop: the `/api/studio/build` SSE route composing `createWorkerRun`
  (run) + a request-scoped AI `complete` (fix, via runChat + pickCodingModel), then `BuildTrace`.

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
