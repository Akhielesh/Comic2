# Code Studio — Product Plan & Sprint Roadmap

> **The product-first plan.** Prior docs were backend-first; this is the authoritative plan
> for the actual **Code Studio** product. Inspiration: **Google AI Studio** (clean studio UX,
> instant run, model picker) + **Lovable / Emergent** (describe → it builds → live preview →
> iterate by prompt OR by hand → share the running environment).
>
> **Last updated:** 2026-06-05 · Owner: Akhielesh · Status: APPROVED PLAN (building)

---

## 1. North Star
Anyone describes an app in plain language and **watches it get built and run live** in seconds,
then **refines it** — by prompt or by editing the code by hand — and **shares the running
environment** with others. No setup, no local tooling. "Figma-for-apps" ease of use.

## 2. Principles
1. **One engine, one path.** No competing previews/buttons.
2. **Real apps, not fakes.** Real Vite/npm in a real container — never an in-browser approximation that lies about what the app does.
3. **Fast feedback.** Perceived build start in seconds; iterate cheaply.
4. **Persistent + shareable** environments.
5. **Admins are never gated.** Ship behind flags for everyone else; flip to GA when ready.
6. **Guardrails always on** (auth, per-user caps, path/size limits, iteration/stuck caps, cost metering).

## 3. Locked decisions
| # | Decision | Rationale |
|---|---|---|
| D1 | **Runtime = Cloudflare Containers** (the agentic build loop). | Real Vite/npm, scalable, already deployed + the loop backend is built/tested. |
| D2 | **Remove "Build in Studio" (WebContainer / `/studio.html`).** | It opens a dead tab (basically just a zip). Pointless. **Scrapped.** |
| D3 | **Sandpack / CodeSandbox = phase out as a product path.** | It can't run Vite/multi-file/npm — it's the source of the "Hello world" mis-render and the confusion. Keep at most as a *transient* "instant peek while the container boots" (revisit in Sprint 4 as a perf nicety), never as a competing button. |
| D4 | **Code Studio is a dedicated route/view**, not a chat side-panel. | It's a product, not a card. |
| D5 | **Reuse the existing backend** (control plane, persistence, logs, agentic loop, guardrails). | Already built + tested (~50 tests). |
| D6 | **Chat is a feeder**: when a build gets substantial, chat offers "Open in Code Studio". | The hand-off you described. |

## 4. Target architecture — the workspace
```
┌─────────────────────────────────────────────────────────────────────────┐
│  Project ▾   [model ▾ coding/BYOK]            ▶ Run   ■ Stop   Share  ⤓   │
├───────────────┬───────────────────────────────┬───────────────────────────┤
│  PROMPT/CHAT  │  CODE EDITOR (Monaco)         │  LIVE PREVIEW             │
│  + Build      │  ┌ file tree ┐ ┌ tabs ───────┐│  (iframe → container      │
│  Trace        │  │ /src      │ │ App.tsx     ││   preview URL)            │
│  (plan/run/   │  │  App.tsx  │ │ ...code...  ││  [↻] [device]             │
│   observe/fix)│  └───────────┘ └─────────────┘│                           │
├───────────────┴───────────────────────────────┴───────────────────────────┤
│  CONSOLE / LOGS  (install · dev-server · runtime errors)                   │
└───────────────────────────────────────────────────────────────────────────┘
```
**Backend map** (✅ = exists): `/api/studio/build` SSE (loop) · `/api/studio/launch`✅ ·
`/:id/stop`✅ · `/:id/logs`✅ · `/api/studio/projects` CRUD✅ · `/api/studio/share` (new) ·
`/api/studio/deploy` (new). Engine: observation+guards+orchestrator+FIX+coding-router+RUN ✅.

---

## 5. Sprints
Each sprint = **Goal · Stories · Test checkpoints · Demo**. Ship to prod behind the admin/flag
gate after each story; full test suite green before every prod push.

### Sprint 0 — Consolidate & unblock (foundation)
**Goal:** one clear path; the live round-trip actually works.
- **S0.1** Fix `STUDIO_WORKER_URL` (real `…workers.dev`, not the `<account>` placeholder).
- **S0.2** Remove "Build in Studio" + (sequence) "Quick preview"; collapse the card to a single **"Open in Code Studio"** CTA. Quarantine `/studio.html` + `studio/` (WebContainer) + the Sandpack panel.
- **S0.3** Wire **`/api/studio/build`** (SSE) — compose `createWorkerRun` + `createStudioFix` + an auth-scoped `complete` (`runChat` + `pickCodingModel`); auth + caps + run metering.
- **S0.4** Dedicated **Code Studio route/view** skeleton (admin-gated), reachable from nav + chat.
- **S0.5** **Validate** the live round-trip end-to-end.
- **Tests:** build route streams SSE for a signed-in admin; counter app launches (studio_runs row + preview serves); card has exactly one run CTA; zero dead tabs.
- **Demo:** admin opens Code Studio → "Run live" works on a generated app.

### Sprint 1 — Studio shell (the workspace)
**Goal:** a real workspace that loads + previews a project.
- **S1.1** Studio layout (prompt | editor | preview | logs). **S1.2** File tree. **S1.3** Monaco editor + tabs. **S1.4** Live preview iframe (container URL). **S1.5** Logs panel (stream `/logs`). **S1.6** Run/Stop. **S1.7** Load a saved project (projects CRUD). **S1.8** Responsive.
- **Tests:** open a saved project → files render → edit a file (local) → preview shows the container → logs stream → Stop ends the run + meters cost.
- **Demo:** open a project, see/edit code, live preview side-by-side.

### Sprint 2 — The agentic build (the Lovable moment)
**Goal:** prompt → built, running app, no hand-fixing.
- **S2.1** Prompt box → `/api/studio/build` SSE. **S2.2** **BuildTrace** UI (plan/run/observe/fix, per-iteration). **S2.3** Coding-model routing surfaced. **S2.4** Iteration-cap / "stuck → ask" UX. **S2.5** Error/empty states. **S2.6** Save-on-build (versions).
- **Tests:** "build a todo app" from empty → running preview within the iteration cap; trace visible; guardrails enforced (no unsafe writes); a deliberately-missing dependency **self-heals**.
- **Demo:** type a prompt → watch it build + self-fix → live app.

### Sprint 3 — Iterate (prompt + manual)
**Goal:** refine by chat or by hand.
- **S3.1** Prompt-to-edit (minimal-diff via the FIX path on current files). **S3.2** Manual edit → re-run. **S3.3** Version history + diff + revert (`studio_versions`). **S3.4** File add/delete/rename.
- **Tests:** "make the header blue" edits the right file + re-runs; hand-edit persists + re-runs; revert restores a prior version.
- **Demo:** iterate one app both ways.

### Sprint 4 — Ease-of-use & speed (Google AI Studio feel)
**Goal:** delightful, fast, approachable.
- **S4.1** Starter templates + empty-state onboarding. **S4.2** Keyboard shortcuts. **S4.3** Model picker + BYOK. **S4.4** Faster first paint (warm-container pool and/or transient Sandpack peek while booting — revisit D3). **S4.5** Mobile-friendly read/preview. **S4.6** Usage/cost meter.
- **Tests:** first app in ≤ 2 actions; perceived build-start < target; mobile preview works.
- **Demo:** snappy new-user flow.

### Sprint 5 — Share & collaborate
**Goal:** share running environments (your explicit ask).
- **S5.1** Shareable **live-preview link** (read-only, token-scoped, expiring). **S5.2** Share/**fork** a project (clone files + versions). **S5.3** Permissions. **S5.4** (stretch) realtime presence/collab.
- **Tests:** share link → a second user opens the running app; fork → an independent copy; revoked link 404s.
- **Demo:** send a friend your live app and let them fork it.

### Sprint 6 — Deploy & GA
**Goal:** ship apps + open to everyone.
- **S6.1** One-click **deploy** (Phase 6 → real public URL). **S6.2** GitHub export. **S6.3** Remove the admin gate (GA flag). **S6.4** Caps/billing. **S6.5** Abuse/safety review.
- **Tests:** deploy → public URL serves; GA flag flips cleanly; caps enforced; security review passes.
- **Demo:** prompt → build → deploy → public link.

---

## 6. Milestones
- **M1 (Sprint 0–1):** a real Studio that loads + previews projects.
- **M2 (Sprint 2–3):** the Lovable loop — prompt → build → iterate.
- **M3 (Sprint 4–5):** ease-of-use + sharing.
- **M4 (Sprint 6):** deploy + GA.

## 7. QA / test strategy (every sprint)
Unit (pure logic — already strong) · integration (route + mocked worker) · **E2E manual
checkpoint** (signed-in admin runs the sprint demo) · regression (full suite green before each
prod ship) · guardrails verified (auth, caps, path/size, iteration/stuck, cost).

## 8. Honest state today (so the plan stands on truth)
- **Done + tested:** control plane, persistence, agentic loop *logic* (observation/guards/
  orchestrator/FIX), guardrails, coding router, worker RUN capability (~50 tests). Infra live
  (worker deployed, wildcard DNS, migrations, CORS fixed). Admins ungated.
- **The gap (this plan):** the **entire Studio UI/UX**, the `/api/studio/build` wiring,
  share, deploy. Three legacy engines (Sandpack/WebContainer/container) collapse to **one**.
