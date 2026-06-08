# 15 — UX Spec: Build, Iterate & Preview

> Part II · Product Definition · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Information Architecture](./12-information-architecture.md) (§12.1 the integration
> constraint) · [Agentic Engine](../../04-AGENTIC-ENGINE.md) ·
> [Master Plan](../00-MASTER-PLAN.md) (Epics A4, A8)

## 15.1 Scope & the honest starting point

This section specs the **Code Studio surface** — the builder/editor/preview where code is
written, run, and reviewed. The honest starting point: **the Code Studio largely ships today.**
`components/studio/CodeStudioView.tsx` is a themeable, resizable **three-pane workspace**
(Prompt·Build / Code / Live preview) over a streaming logs console, with a real Monaco editor
(`MonacoEditor.tsx`), tabs (`EditorTabs.tsx`), a file tree (`FileTree.tsx`), diffs
(`DiffView.tsx`), version history with restore (`HistoryPanel.tsx`), a `BuildTrace`
(`BuildTrace.tsx`) animating **plan → run → observe → fix → done**, a **Code · Split · Preview**
focus toggle (`kit/FocusToggle.tsx` + `focusStore.ts`), and an honest **non-web "run it locally
/ cloud-run"** panel driven by `projectKind.ts` (`runHint`).

So Autopilot does **not** rebuild this surface. The job of A4/A8 is to make the *same surface*
do two new things:

1. **Read-along (autonomous):** when the venture loop is driving the build, the Code Studio
   becomes a **live window into what the agents are doing** — the same panes, but the human is
   watching, not typing.
2. **Manual takeover:** the human can grab the wheel **at any time** — edit a file, run a
   build, redirect the loop mid-flight — without leaving the surface or stopping the venture.

The product principle (from [§0.4](./00-executive-summary.md)): *"code optional, never
code-locked."* The Code Studio is the same place whether a person or an agent is at the
keyboard; only the **driver indicator** changes.

| Surface element | Status today | What A4/A8 adds |
|---|---|---|
| 3-pane shell (Prompt·Build / Code / Preview) | **shipped** (`CodeStudioView.tsx`) | a driver mode banner + venture context |
| Monaco editor · tabs · file tree | **shipped** (`MonacoEditor`/`EditorTabs`/`FileTree`) | read-along cursor-follow; takeover toggle |
| BuildTrace (plan→run→observe→fix) | **shipped** (`BuildTrace.tsx`) | streams from the venture tick, not just a one-shot build |
| Diffs · version history · restore | **shipped** (`DiffView`/`HistoryPanel`) | versions tagged by goal + driver (agent/you) |
| Code·Split·Preview focus toggle | **shipped** (`FocusToggle`) | unchanged — reused as-is |
| Non-web run panel (`runHint`/cloud-run) | **shipped** (`projectKind.ts`) | wired to the A5 cloud-run adapter |
| Live preview (in-browser + cloud worker) | **shipped** (`PreviewFrame`/`CodeStudioPanel`) | preview reflects the *deployed* venture build |
| GitHub two-way sync UI | **not built** (server `studioGithub.ts` exists) | new sync panel (A8) over existing API |
| Redirect-mid-loop control | **partial** (prompt iterate exists) | a first-class "Redirect" affordance (A8) |

## 15.2 The 3-pane shell (the reused frame)

The shell is a vertical split (workspace over logs) whose top half is a focus-aware horizontal
split. In **Split** focus all three panes show; **Code** or **Preview** focus collapses to two
(Prompt·Build stays pinned because it carries the driver state and the iterate composer). Pane
sizes persist per focus (`ResizableSplit` `storageKey`s). On narrow screens the panes **stack**
rather than squeeze.

```
┌─ Acme Booking ▸ Code Studio ──────────────── 🤖 Agent building · goal "Add auth" ─┐
│  [Projects]   habit-tracker   coding·auto·free   ● 2 unsaved   [Code|Split|Preview]│
├──────────────────┬───────────────────────────────┬───────────────────────────────┤
│ PROMPT · BUILD   │  CODE                           │  LIVE PREVIEW         [⛶][●REC]│
│                  │  ┌─ src/App.tsx ×│routes.ts ×┐  │ ┌───────────────────────────┐ │
│ ┌ BuildTrace ──┐ │  │ 1  import React…          │  │ │                           │ │
│ │ ✓ Plan       │ │  │ 2  export default …       │  │ │   [ running app iframe ]  │ │
│ │ ✓ Run        │ │  │ 3  …                      │  │ │                           │ │
│ │ ● Observe ●  │ │  │ ▸ writing src/auth.ts…    │  │ │                           │ │
│ │   Fix        │ │  └───────────────────────────┘  │ └───────────────────────────┘ │
│ └──────────────┘ │  ┌─ Files ──────────────────┐   │  preview · in-browser / cloud │
│ Activity (live)  │  │ ▸ src/                    │   │                               │
│  · wrote App.tsx │  │   App.tsx        +24 −3   │   │                               │
│  · npm install   │  │   auth.ts        ＋new    │   │                               │
│ ┌ Iterate ─────┐ │  │ ▸ public/                 │   │                               │
│ │ Redirect /   │ │  └───────────────────────────┘  │                               │
│ │ prompt…   [↵]│ │  Changes · History · Services   │                               │
│ └──────────────┘ │                                 │                               │
├──────────────────┴───────────────────────────────┴───────────────────────────────┤
│ CONSOLE / LOGS   $ npm install … ✓   [plan] picking next file …   [observe] 200 OK  │
└────────────────────────────────────────────────────────────────────────────────────┘
```

- **Left (Prompt · Build):** the build conversation (`ConversationThread`), the live
  `ActivityFeed` (files appearing as they're written, each row click-to-open in the editor),
  `BuildTrace`, `ChangesPanel`, `HistoryPanel`, `ServicesPanel` (env vars the code expects),
  and the **iterate composer** (`PromptComposer`). In autonomous mode the composer becomes the
  **Redirect** input (§15.6).
- **Centre (Code):** Monaco + closable tabs + the file tree. Diff stats (`+24 −3`, `＋new`)
  decorate changed files from the working baseline.
- **Right (Live preview):** the running app — instant **in-browser** preview for web projects
  (Sandpack), superseded by a real **cloud-container** URL when a Build runs; the honest
  **non-web run panel** otherwise (§15.8). Fullscreen and screen-record affordances ship.
- **Bottom (Console/Logs):** the streamed install/dev/build/observe log (`LogsConsole`).

## 15.3 Two modes on one surface: read-along vs manual takeover

The defining new behavior. The **driver indicator** in the top bar is the single source of
truth for who is in control.

| | Read-along (agent driving) | Manual takeover (you driving) |
|---|---|---|
| Trigger | venture loop dispatches a goal to ACT (A4) | you edit a file, press Build, or click **Take over** |
| Top-bar state | `🤖 Agent building · goal "…"` (animated) | `✋ You're editing` |
| Editor | live-streams the agent's writes; **read-only by default**, cursor follows the active file | fully editable; your keystrokes win |
| BuildTrace | streams the loop's plan→run→observe→fix in real time | streams *your* manual Build's loop |
| Iterate composer | shows **Redirect** (steer the agent, §15.6) | shows the normal refine prompt |
| Versions | snapshots tagged `agent` + goal | snapshots tagged `you` |
| Controls present | Pause · Redirect · Take over | Hand back · Build · Stop |

**Read-along is the default for an active venture.** The editor opens read-only with a thin
"agent is writing — *Take over to edit*" hint, mirroring the shipped non-admin read-only path
(`CodeWorkspace readOnly`). The cursor **follows the agent**: as files stream in (the existing
`ActivityFeed.onOpenFile` plumbing, `openFileInEditor`), the active tab switches to whatever the
agent just touched, so watching feels like pair-programming.

**Manual takeover is one click (or one keystroke).** Typing in the editor, pressing Build
(⌘B / ⌘↵), or hitting **Take over** flips the surface to manual: the editor unlocks, the loop
**pauses on the current goal** (it does not fight your edits), the top bar shows
`✋ You're editing`. **Hand back** resumes autonomy from your new working state — the agent
re-senses the changed files and continues. Takeover is *cooperative*, never a fork: one working
copy, one version history, one venture.

> **Safety invariant.** Takeover never bypasses governance. A manual Build still meters spend
> against `venture_budgets`, still respects the kill switch, and a manual *production* deploy is
> still a checkpoint ([Master Plan §8](../00-MASTER-PLAN.md)). The human can drive faster; they
> cannot drive past the brakes.

## 15.4 BuildTrace — visualizing plan → write → run → observe → fix

`BuildTrace` is the heart of "it feels alive." Each streamed stage springs in as a row; the
active stage pulses (`StatusPulse`); a footer summarizes the result. Today it visualizes a
single one-shot studio Build; for autonomy it visualizes **one tick's ACT/VERIFY** and chains
across ticks within a goal.

| Stage | Icon (shipped) | What the row shows | Source |
|---|---|---|---|
| **Plan** | `ListChecks` | the file list + chosen template/commands | ORIENT/PLAN |
| **Write** (Act) | streamed file rows in `ActivityFeed` | each file `＋new` / `+a −b` as it's written | ACT |
| **Run** | `Play` | `npm install` → dev server → preview URL | RUN (studio-worker) |
| **Observe** | `ScanLine` | build/console errors, HTTP status, the structured observation summary (amber) | OBSERVE |
| **Fix** | `Wrench` | the minimal diff applied; `iter N` badge | FIX |
| **Done** | `CheckCircle2` | `Built & running after N fixes 🎉` | VERIFY pass |
| **Stopped** | `OctagonAlert` / `Hand` | the friendly **"over to you"** reason (§15.7) | guard hit |

The trace already renders an `iter N` badge per fix cycle and an amber observation line — the
exact "the agent saw the real error and fixed it" affordance the [Agentic Engine](../../04-AGENTIC-ENGINE.md)
calls the new capability. For autonomy, each tick's trace carries the **goal** it served, so a
venture's day reads as a stack of goal-scoped traces in the activity stream, deep-linkable from
the Operator Console.

## 15.5 File tree · tabs · diffs · version history & restore

All shipped; reused unchanged, with venture-aware metadata added.

- **File tree** (`FileTree.tsx`): collapsible, decorated with per-file diff stats vs the working
  baseline (`isPathDirty`, `diffStat`). Clicking a row opens it in a tab.
- **Tabs** (`EditorTabs.tsx`): closable, non-destructive; the active tab follows the agent in
  read-along.
- **Diffs** (`DiffView.tsx` + `ChangesPanel.tsx`): an LCS line diff with +/− gutters; the
  Changes panel lists every dirty file with revert. **Revert all changes (N)** is a command
  (⌘K) and a single button.
- **Version history** (`HistoryPanel.tsx` over `studio_versions`): each Build snapshots a
  version, attributed **`user` vs `agent`** (the icons already exist). **Restore** loads that
  version's files as the new working baseline — **non-destructive** (building again snapshots a
  fresh version, so restore is always reversible). For ventures, the version label carries the
  **goal id**, so history reads "v12 · agent · *Add auth* · 2h ago" and restore is the
  human's undo for an autonomous change they don't like.

The honest restore contract, surfaced inline: *"Restoring loads this version into the editor as
your working copy. Nothing is deleted — the next Build saves a new version."*

## 15.6 Code · Split · Preview focus toggle + redirect-mid-loop

**Focus toggle** (shipped, reused as-is): a segmented `Code | Split | Preview` control
(`FocusToggle`), keyboard- and command-palette-driven, persisted in `focusStore`. *Split* is
the default 3-pane; *Code* maximizes the editor for review; *Preview* maximizes the running app.
This is exactly the right control for read-along: a non-technical owner lives in **Preview**
(watch the product take shape), a developer lives in **Code** (watch the diffs).

**Redirect mid-loop** is the new steering affordance. The [Agentic Engine](../../04-AGENTIC-ENGINE.md)
already promises "the user can chat mid-loop to redirect," and the shipped `PromptComposer`
iterate path is the seed. For autonomy we make it first-class:

- While the agent is building, the iterate composer reads **"Redirect — tell the agent what to
  change"**. Submitting does **not** abort the run; it **injects guidance into the current
  goal's context** so the next plan/fix cycle incorporates it (e.g. *"use Tailwind, not inline
  styles"*).
- A **Pause** affordance freezes the loop after the current tick; **Redirect → Resume** is the
  "steer then go" flow.
- Redirects are recorded as `venture_events` (audit: *who said what, when*) and shown inline in
  the activity stream so the steering is visible, not silent.

The distinction the UI must make obvious: **Redirect** = nudge the agent (stay autonomous);
**Take over** = grab the keyboard (go manual). They are different buttons with different colors.

## 15.7 Empty, loading, error & stuck ("over to you") states

| State | What the user sees | Forward action |
|---|---|---|
| **Empty** (no project) | `StudioStart` / build flow: *"Describe an app and the team will build it."* | start a build, or open from the venture roadmap |
| **Loading** (booting) | `StatusPulse` + skeletons in Code; preview shows *"Booting sandbox…"* with a spinner | none — informative |
| **Streaming** (writing) | files spring into the tree/activity feed; calm progress, no flashing | watch, or **Take over** |
| **Autofixing** | a **calm violet bar** *"Auto-fixing errors so it runs cleanly…"* (replaces the old flashing red banner) | wait; budget is capped (`MAX_AUTOFIX`) |
| **Persistent error** | a **single clickable** error with **Fix with AI** once autofix is exhausted | one click to retry, or edit + Build |
| **Stuck → "over to you"** | `BuildTrace` footer: ✋ *"The agent got stuck — over to you,"* with a hint (*edit & Build again, or refine by prompt*) | take over, or redirect |
| **Cloud sandbox unavailable** | log line *"Cloud sandbox not configured — showing the in-browser preview instead"*; the app still previews | none — graceful degrade |

The **stuck state is the load-bearing one for autonomy.** The shipped `friendlyReason()` already
turns guard reasons (stuck / iteration cap / max) into honest, blame-free "over to you"
messages. In a venture, hitting the no-progress detector ([Master Plan §8](../00-MASTER-PLAN.md))
does three things at once: pauses the goal, **raises a checkpoint** in the Operator Console, and
shows the "over to you" footer in the Code Studio — the same human is reached on whichever
surface they're looking at. We never silently spin; "stuck" always becomes a visible ask.

## 15.8 Non-web projects (runHint / cloud-run panel)

The browser cannot run a Python/Go/Rust/Java service, so the preview pane must be **honest, not
broken**. The shipped `projectKind.ts` classifies the file set (`detectProjectKind`,
distinguishing a Node *backend* from a browser app by content), and `isWebProject` gates the
pane:

- **Web project:** the in-browser Sandpack preview, superseded by a cloud-container URL on Build.
- **Non-web project:** a clean panel — *"This isn't a browser app, so there's no in-page
  preview"* — with the language label, a copy-pasteable **`runHint`** (`go run .`,
  `cargo run`, `pip install -r requirements.txt && python main.py`, …), a **Download .zip**, and
  (A5) a **Run in cloud** button that boots the service in a container and streams its logs to
  the Console pane. This is where the hybrid-hosting cloud-run path surfaces in the builder.

For autonomy, the loop's VERIFY uses the *cloud-run* path for non-web ventures (build/test in a
container, health-check the listening port) since there is no browser preview to inspect — the
same `runHint`/cloud-run distinction the UI shows is what the engine acts on.

## 15.9 GitHub sync UI

GitHub two-way sync is **not yet a UI feature** (per [02-CURRENT-STATE](../../02-CURRENT-STATE.md):
*"GitHub two-way sync — not built"*), though server scaffolding exists
(`server/src/services/studioGithub.ts`, `routes/studioGithub.ts`; Phase 6 / Master Plan reuse
inventory). A8 adds the **sync panel** in the Prompt·Build column (collapsible, like History):

```
┌ GitHub ───────────────────────────────────┐
│ ⎇ acme/booking · main        Connected ✓   │
│ ▸ 2 ahead · clean working tree             │
│ [ Commit & push "Add auth (goal #14)" ]    │
│ [ Open Pull Request ]   [ Pull latest ]    │
└────────────────────────────────────────────┘
```

- **Connect** uses the existing connector flow (Nango / PAT) → a `venture_connection`;
  least-privilege scopes; the token is **never logged or shown** ([Master Plan §5](../00-MASTER-PLAN.md)).
- **Autonomous commits** are agent-attributed with the goal in the message (`Add auth (goal #14)`);
  **pushing to a protected branch / production** is gated by the same checkpoint policy as a deploy.
- **Pull latest** lets a human edit on GitHub and have the venture pick it up on the next SENSE —
  closing the two-way loop.

## 15.10 Mobile & accessibility

**Mobile** (full treatment: [§12.6](./12-information-architecture.md) and section 19). The
position is deliberate and honest: **editing is a desktop job.** On phones the Code Studio is
**read-only** — the BuildTrace, the live activity stream, diffs, and a preview link are visible
(so an owner can *watch and approve* from a phone), but the Monaco editor and Build controls are
**not** rendered. The shell already stacks panes on narrow screens; mobile drops Code-edit and
keeps Preview + Activity. Redirect-by-text and approve/pause remain available because they need
no keyboard precision.

**Accessibility** (full treatment: section 20).

- The focus toggle is a proper `radiogroup` with `aria-checked` (shipped); the driver indicator
  is announced via an `aria-live="polite"` region so a screen-reader user hears *"Agent building"*
  ↔ *"You're editing"* transitions.
- BuildTrace stage changes and the "over to you" state are announced via `aria-live`; the trace
  is not color-only (every stage has an icon + label).
- Full keyboard path: ⌘K command palette (build, focus, revert, agents, settings), ⌘B / ⌘↵
  Build, Esc cancels generation — all shipped and reused.
- Diffs use +/− glyphs **and** color (not color alone); status pills pair text with color;
  motion respects `prefers-reduced-motion` via the kit's `motion.ts`.

## 15.11 Which epic delivers each

| Capability | Epic | Status |
|---|---|---|
| 3-pane shell, focus toggle, Monaco/tabs/tree, diffs, history/restore, BuildTrace, in-browser preview, non-web run panel | (Phases 3–8) | **shipped** — reused |
| BuildTrace streaming from the venture tick; driver indicator; read-along read-only mode | **A4** + **A8** | new |
| Manual takeover / hand-back; redirect-mid-loop; Pause from the builder | **A8** | new |
| Cloud-run for non-web VERIFY; preview reflects the deployed build | **A5** | new |
| Version labels tagged by goal + driver | **A4** | new |
| GitHub sync panel (commit/push/PR/pull) over existing server API | **A8** | new |
| Checkpoint-gated production deploy / protected-branch push from the builder | **A5** + **A8** | new |
| Mobile read-only Code Studio; a11y live regions | **A8** | new |

## 15.12 Acceptance criteria

- The Code Studio renders the shipped 3-pane shell with Code · Split · Preview focus, Monaco +
  tabs + file tree, diffs, and version history with non-destructive restore.
- An active venture opens the builder in **read-along**: editor read-only, cursor following the
  agent's writes, BuildTrace streaming plan→write→run→observe→fix from the live tick.
- **Take over** unlocks the editor and pauses the loop on the current goal without losing the
  working copy; **Hand back** resumes autonomy from the human's state.
- **Redirect** injects guidance into the running goal without aborting it; it is recorded as an
  audited `venture_event` and visible in the activity stream. Redirect and Take over are visibly
  distinct controls.
- A stuck loop shows the "over to you" footer in the builder **and** raises a checkpoint;
  the user is reachable from whichever surface they're on.
- Manual Builds and deploys respect budgets, the kill switch, and the production checkpoint —
  takeover never bypasses governance.
- Non-web projects show the honest run panel with a copy-pasteable `runHint` and a cloud-run
  path instead of a broken preview.
- The GitHub panel connects via a least-privilege connection (token never logged), commits with
  goal-attributed messages, and gates protected-branch/production pushes behind a checkpoint.
- Mobile exposes a read-only builder (trace, activity, diffs, preview link, approve/redirect) and
  no editor; driver-mode and BuildTrace transitions are announced to assistive tech.
