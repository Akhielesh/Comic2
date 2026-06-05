# Code Studio — Product Plan & Sprint Roadmap

> **The product-first plan.** Prior docs were backend-first; this is the authoritative plan
> for the actual **Code Studio** product. Inspiration: **Google AI Studio** (clean studio UX,
> instant run, model picker) + **Lovable / Emergent** (describe → it builds → live preview →
> iterate by prompt OR by hand → share the running environment).
>
> **Design is a first-class track here** — animation-rich, asset-rich, delightful. If it lands
> in Code Studio, we roll the same design language across the whole app.
>
> **Last updated:** 2026-06-05 · Owner: Akhielesh · Status: APPROVED PLAN (building)

---

## 1. North Star
Anyone describes an app in plain language and **watches it get built and run live** in seconds,
then **refines it** — by prompt or by editing the code by hand — and **shares the running
environment** with others. No setup. "Figma-for-apps" ease of use, with motion and polish that
feels premium.

## 2. Principles
1. **One engine, one path.** No competing previews/buttons.
2. **Real apps, not fakes.** Real Vite/npm in a real container.
3. **Fast feedback.** Perceived build start in seconds; iterate cheaply.
4. **Persistent + shareable** environments.
5. **Admins never gated.** Flags for everyone else; flip to GA when ready.
6. **Guardrails always on** (auth, caps, path/size, iteration/stuck, cost).
7. **Motion with meaning.** Every state change is animated, every action has feedback — never gratuitous, always guiding the eye. Design and animation ship *with* each feature, not after.

## 3. Locked decisions
| # | Decision | Rationale |
|---|---|---|
| D1 | **Runtime = Cloudflare Containers** (the agentic loop). | Real Vite/npm; loop backend built/tested. |
| D2 | **Remove "Build in Studio" (WebContainer).** ✅ done | Opened a dead tab. Pointless. |
| D3 | **Sandpack = phase out** as a product path. | Can't run real apps → the "Hello world" mis-render. Keep only as a transient "instant peek" if needed (Sprint 4). |
| D4 | **Code Studio = a dedicated route/view**, not a chat side-panel. | It's a product. |
| D5 | **Reuse the existing backend.** | Built + tested (~50 tests). |
| D6 | **Chat is a feeder** → "Open in Code Studio" hand-off. | The flow you described. |
| D7 | **Animation stack = Framer Motion (core) + Lottie (set-pieces) + Tailwind/CSS + inline SVG.** | Spring physics, gestures, layout animations; Lottie for premium loaders/celebrations. |
| D8 | **Elevate the design language**: keep the brand's playful energy, add pro-tool polish + a dark "studio" theme for the workspace. Prove it here → roll app-wide. | Cohesive, premium feel. |

## 4. Target architecture — the workspace
```
┌─────────────────────────────────────────────────────────────────────────┐
│  Project ▾   [model ▾ coding/BYOK]            ▶ Run   ■ Stop   Share  ⤓   │
├───────────────┬───────────────────────────────┬───────────────────────────┤
│  PROMPT/CHAT  │  CODE EDITOR (Monaco)         │  LIVE PREVIEW             │
│  + Build      │  ┌ file tree ┐ ┌ tabs ───────┐│  (iframe → container)     │
│  Trace        │  │ /src      │ │ App.tsx     ││  [↻] [device] [share]     │
│  (plan/run/   │  │  App.tsx  │ │ ...code...  ││                           │
│   observe/fix)│  └───────────┘ └─────────────┘│                           │
├───────────────┴───────────────────────────────┴───────────────────────────┤
│  CONSOLE / LOGS  (install · dev-server · runtime)                         │
└───────────────────────────────────────────────────────────────────────────┘
```
**Backend map** (✅ exists): `/api/studio/build` SSE (loop) · `launch`✅ · `:id/stop`✅ ·
`:id/logs`✅ · `projects` CRUD✅ · `share` (new) · `deploy` (new). Engine: observation+guards+
orchestrator+FIX+coding-router+RUN ✅.

---

## 5. Design language & motion (the cross-cutting track)
**Aesthetic:** an elevated take on the brand — keep the bold, friendly identity (heavy borders,
confident type, vivid accents) but add depth (soft layered shadows, subtle glass, gradients),
and a **dark "studio" theme** for the workspace (editor + preview) that makes code + apps pop.

**Motion principles:**
- **Spring, not linear.** Framer Motion springs for everything that moves; no robotic eases.
- **Staggered reveals.** Lists, file trees, panels animate in with a stagger.
- **The build is alive.** The agentic BuildTrace streams as an animated timeline (plan→run→observe→fix), each step springing in with status pulses; the preview "boots" with a reveal.
- **Micro-interactions everywhere.** Hover lift, press depress, focus glow, magnetic buttons, ripple/spark on key actions.
- **Meaningful loaders.** Skeleton shimmers + Lottie for first-build and deploy; never a bare spinner.
- **Celebrate success.** A tasteful confetti/sparkle Lottie when a build goes green or deploys.
- **Reduced-motion respected** (`prefers-reduced-motion` → calm fallbacks).

**Foundations to build first (Sprint 0/1), reused everywhere:**
- **Motion Kit** (`components/studio/kit/`): `Reveal`, `Stagger`, `Lift`, `Shimmer/Skeleton`,
  `Spotlight`, `AnimatedTabs`, `StatusPulse`, `Confetti` — thin wrappers over Framer Motion/Lottie
  matching the house style (extends the existing dependency-free Primitive Kit).
- **Asset pipeline:** Lucide + **Iconify** icons; **Lottie** animations (loaders/celebrations);
  generated illustrations/textures (Hugging Face / unDraw) for empty states + hero moments;
  custom inline SVG. All centralized so the app can adopt them later.

## 6. Design tooling & MCPs
**Already connected — I'll use these now:**
- **Figma** — design-to-code + generate UI from your design system; pull screenshots/specs.
- **Context7** — live docs for Framer Motion, Monaco, Lottie, etc. (so we use current APIs).
- **Hugging Face** — generate illustrations / textures / hero art / empty-state imagery.
- **tldraw** — flow/state diagrams for the build loop + UX flows.

**Free MCPs worth connecting (so I can use them too):**
- **Magic MCP — 21st.dev** *(free tier)* → generates polished, **animated** React + Tailwind
  components from a prompt. Biggest lever for the animation-rich goal.
- **Iconify MCP** → 200k+ free open-source icons (beyond Lucide) for a richer icon set.
- **Lottie / LottieFiles MCP** → free Lottie animations for premium loaders + celebrations.

**Libraries to add (deps, Sprint 0):** `framer-motion`, `lottie-react` (+ `@iconify/react` if we
adopt Iconify). Monaco for the editor (`@monaco-editor/react`).

---

## 7. Sprints — detailed task breakdown
Each story has grouped task checklists (**BE** backend · **UI** front-end · **DM** design/motion ·
**QA** tests). Ship behind the admin/flag gate after each story; full suite green before every push.

### Sprint 0 — Consolidate & unblock (foundation + design system) — ✅ buildable scope done
**Goal:** one clear path; live round-trip works; design/motion foundations exist.
- ✅ **S0.1 Fix `STUDIO_WORKER_URL`** — [BE] `isValidStudioWorkerUrl` + `studioConfigured` reject the placeholder/malformed URL → clean 503, not a parse crash. + tests.
- ✅ **S0.2 Collapse the card to one CTA** — [UI] `CodeStudioCard` is now a single animated **"Open in Code Studio"** CTA (+ quiet `.zip`); "Run live"/"Quick preview"/"Build in Studio" removed. [UI] `/studio.html` (WebContainer) + the Sandpack chat side-panel auto-open are quarantined behind `isLegacyStudioEnabled()` (default off); the page renders a "moved" redirect. [DM] CTA lift + spark via the Motion Kit. [QA] `CodeStudioCard.test.tsx`: one run CTA; hand-off fires.
- ✅ **S0.3 Wire `/api/studio/build` (SSE)** — [BE] route composing `createWorkerRun` + `createStudioFix` + auth-scoped `complete`; auth + caps + run metering; streams BuildEvents. + tests.
- ✅ **S0.4 Code Studio route skeleton** — [UI] `codestudio` view (admin-gated) reachable from nav + the chat hand-off; dark 3-pane shell + logs bar; working Run live. [DM] page fade+rise, pane stagger-in. [QA] `CodeStudioView.test.tsx`: admin shell / non-admin gate / empty state.
- ✅ **S0.5 Motion Kit + design tokens** — [DM] added `framer-motion`/`lottie-react`; built `components/studio/kit/` (`Reveal`, `Stagger`, `Lift`, `Shimmer`, `StatusPulse`) + studio dark-theme tokens; `prefers-reduced-motion` fallback throughout. [QA] `kit.test.tsx` incl. reduced-motion.
- 🟡 **S0.6 Live round-trip validation** — [QA/E2E] owner-side: set a real `STUDIO_WORKER_URL`, then a signed-in admin launches a counter → `studio_runs` row + preview serves + logs stream. The Run live button is the hook.
- **Demo:** admin opens Code Studio (animated shell) → "Run live" works.

### Sprint 1 — Studio shell (the workspace)
**Goal:** a real, beautiful workspace that loads + previews a project.
- **S1.1 Layout** — [UI] resizable 3-pane (prompt | editor | preview) + bottom logs; persist sizes. [DM] spring-resize, pane focus spotlight.
- **S1.2 File tree** — [UI] tree from project files; active-file highlight. [DM] stagger-in, expand/collapse spring, hover lift.
- **S1.3 Code editor** — [UI] Monaco (`@monaco-editor/react`), dark theme, tabs, dirty-state dot. [DM] animated tab switch (layout animation), cursor/save feedback.
- **S1.4 Live preview** — [UI] iframe → container preview URL; device-size toggle; refresh. [DM] "boot" reveal (skeleton shimmer → fade-in), refresh pulse.
- **S1.5 Logs panel** — [UI] stream `/logs` (install/dev/runtime), severity colors, autoscroll. [DM] new-line slide-in, error shake.
- **S1.6 Run/Stop** — [UI] controls + run status chip. [DM] StatusPulse (starting/live/error), magnetic primary button.
- **S1.7 Load saved project** — [BE/UI] projects CRUD list + open. [DM] card grid stagger, open transition.
- **S1.8 Responsive** — [UI] tablet/mobile read+preview layout.
- **QA:** open project → files render → edit (local) → preview shows container → logs stream → Stop ends run + meters. Reduced-motion calm. Lighthouse/interaction smoke.
- **Demo:** open a project, edit code, live preview, all animated.

### Sprint 2 — The agentic build (the Lovable moment)
**Goal:** prompt → built, running app, self-fixes — beautifully visualized.
- **S2.1 Prompt box** — [UI] prompt → `/api/studio/build` SSE. [DM] submit morph (button → progress), typing affordances.
- **S2.2 BuildTrace UI** — [UI] animated timeline of plan→run→observe→fix per iteration; per-step status + error summary. [DM] steps spring/stagger in, live StatusPulse, connector draw-on.
- **S2.3 Model routing surfaced** — [UI] show the coding model used; BYOK hint.
- **S2.4 Iteration/stuck UX** — [UI] cap progress, "stuck → ask you" prompt. [DM] attention nudge on stuck.
- **S2.5 Error/empty states** — [UI/DM] illustrated empty + error states (HF/unDraw art + Lottie).
- **S2.6 Save-on-build** — [BE] write versions; [UI] version created toast.
- **S2.7 Success moment** — [DM] green-build celebration (Lottie confetti/sparkle) + preview reveal.
- **QA:** "build a todo app" empty→running within cap; trace visible; guardrails enforced; missing-dep self-heals; reduced-motion path.
- **Demo:** type a prompt → watch it build + heal → live app + celebration.

### Sprint 3 — Iterate (prompt + manual)
**Goal:** refine by chat or by hand.
- **S3.1 Prompt-to-edit** — [BE/UI] minimal-diff via FIX path on current files. [DM] changed-files highlight + diff reveal.
- **S3.2 Manual edit → re-run** — [UI] edit → save → re-run; dirty indicator. [DM] re-run pulse.
- **S3.3 Versions/diff/revert** — [BE/UI] history list, diff view, revert (`studio_versions`). [DM] timeline scrub, diff line-by-line reveal.
- **S3.4 File ops** — [UI] add/delete/rename. [DM] add/remove spring.
- **QA:** "make the header blue" edits the right file + re-runs; hand-edit persists + re-runs; revert restores.
- **Demo:** iterate one app both ways.

### Sprint 4 — Ease-of-use & speed (Google AI Studio feel)
**Goal:** delightful, fast, approachable.
- **S4.1 Templates + onboarding** — [UI] starter gallery; first-run empty state. [DM] illustrated, animated walkthrough.
- **S4.2 Shortcuts + command palette** — [UI] ⌘K palette. [DM] palette spring + result stagger.
- **S4.3 Model picker + BYOK** — [UI] picker with capability hints.
- **S4.4 Speed** — [BE] warm-container pool and/or transient Sandpack peek while booting (revisit D3). [DM] instant optimistic UI.
- **S4.5 Mobile** — [UI] mobile build+preview.
- **S4.6 Usage/cost meter** — [UI/DM] animated meter.
- **QA:** first app ≤2 actions; perceived build-start < target; mobile works; a11y pass.
- **Demo:** snappy new-user flow.

### Sprint 5 — Share & collaborate
**Goal:** share running environments (your explicit ask).
- **S5.1 Share live link** — [BE] token-scoped, expiring read-only preview link. [UI/DM] share sheet + copy animation.
- **S5.2 Fork project** — [BE/UI] clone files+versions to another user. [DM] fork transition.
- **S5.3 Permissions** — [BE] viewer/editor scopes + revoke.
- **S5.4 (stretch) Realtime presence/collab** — cursors/edits.
- **QA:** share link → 2nd user opens running app; fork → independent copy; revoked → 404.
- **Demo:** send a friend your live app; they fork it.

### Sprint 6 — Deploy & GA
**Goal:** ship apps + open to everyone.
- **S6.1 One-click deploy** — [BE] Phase 6 → real public URL. [DM] deploy progress + success Lottie.
- **S6.2 GitHub export** — [BE/UI] push to repo.
- **S6.3 Remove admin gate (GA flag)** — staged rollout.
- **S6.4 Caps/billing** — [BE] enforce.
- **S6.5 Safety review** — abuse, sandbox egress, secrets.
- **QA:** deploy → public URL; GA flag clean; caps enforced; security review.
- **Demo:** prompt → build → deploy → public link.

### Sprint 7 (follow-on) — Roll the design language app-wide
If Code Studio's look + motion land, port the Motion Kit + elevated theme to Comic, AI Chat,
Models, and marketing — one cohesive premium feel.

---

## 8. Milestones
- **M1 (Sprint 0–1):** a real, animated Studio that loads + previews projects.
- **M2 (Sprint 2–3):** the Lovable loop — prompt → build → iterate.
- **M3 (Sprint 4–5):** ease-of-use + sharing.
- **M4 (Sprint 6):** deploy + GA. **M5 (Sprint 7):** design language app-wide.

## 9. QA / test strategy (every sprint)
Unit (pure logic — strong) · integration (route + mocked worker) · **E2E manual checkpoint**
(signed-in admin runs the sprint demo) · regression (full suite green before each prod ship) ·
**motion QA** (reduced-motion fallback, no jank/CLS, 60fps interactions) · a11y · guardrails.

## 10. Honest state today
- **Done + tested:** control plane, persistence, agentic loop logic, guardrails, coding router,
  worker RUN capability (~50 tests). Infra live. Admins ungated. "Build in Studio" removed.
- **The gap (this plan):** the entire Studio **UI/UX + design/motion**, `/api/studio/build`
  wiring, share, deploy. Three legacy engines collapse to **one**.
