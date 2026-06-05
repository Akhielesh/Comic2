# 05 — UI / UX Specification

AI-centric by default; the editor and code are one click away. House style stays
consistent with the existing app: `border-2 border-black`, `shadow-comic`,
`font-display`/`font-comic`, `animate-fade-in`, lime/brand accents, lucide-react icons.

## Desktop layout (3-pane, resizable)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ TOPBAR  ◳ finance-dashboard   [● Live]        [↺][⤢ Open][GitHub][Deploy ▾][⋯] │
├───────────────┬─────────────────────────────────┬──────────────────────────────┤
│ CHAT (380px)  │ EDITOR  (collapsible, hidden by  │ LIVE PREVIEW                  │
│               │         default)                 │                               │
│ ░ plan…       │ ┌ files ┬ Monaco ──────────────┐ │ ┌──────────────────────────┐ │
│ ✓ App.tsx     │ │ /src  │ App.tsx               │ │ │  (running app in iframe) │ │
│ ✓ npm i       │ │  App  │ 1  import …           │ │ │                          │ │
│ ● running…    │ │  api  │ 2  export default …   │ │ │                          │ │
│               │ └───────┴───────────────────────┘ │ └──────────────────────────┘ │
│ [ Ask / build ]│ [ Code │ Terminal │ Logs ]       │  ● Live  ↻  ⤢ open in new tab │
├───────────────┴─────────────────────────────────┴──────────────────────────────┤
│ STATUSBAR  ● Live · 3 files · sleeps in 2:00 · this run ~$0.01 · model: kimi-k2.6 │
└──────────────────────────────────────────────────────────────────────────────┘
```
- **Chat** is primary and always visible. **Editor** is collapsed by default (toggle
  `</> Code`), expands as the middle pane. **Preview** always visible on the right.
- Panes are resizable (reuse `components/ResizablePanel.tsx` / `DraggablePanel.tsx`).

## Mobile layout (work-from-anywhere)
Single column with a bottom tab bar: **Chat ⇄ Preview ⇄ Code**. "Open app" launches the
preview URL full-screen in a new tab (works on any device — that's the whole point of
server-side execution). Editor is read-mostly with AI-edit ("ask to change this file").

## Component inventory (new)

| Component | Purpose | Notes / reuse |
|---|---|---|
| `StudioShell` | 3-pane layout + topbar + statusbar | new; orchestrates the below |
| `StudioChat` | the build conversation | extend `components/chat/ChatConversation.tsx` |
| `BuildTrace` | live plan → write → run → fix checklist | Lovable-style "thinking"; reuse `SwarmTraceCard` styling |
| `FileTree` | project files, active highlight, badges (modified) | new |
| `CodeEditor` | Monaco wrapper (syntax, diff, inline AI-edit) | replaces the `<textarea>` in `studio/StudioApp.tsx` |
| `LivePreview` | iframe of the container preview URL + refresh + open-tab | new |
| `Terminal` / `LogPanel` | streamed install/dev logs (SSE) | new |
| `StatusBar` | live/sleep, file count, idle countdown, run cost, model | new |
| `DeployMenu` | deploy target + status + public URL | Phase 6 |
| `GitHubMenu` | connect repo, commit, PR | Phase 6 |
| `RunCostPill` | shows live ~$ for the session | reuse `TokenAvailabilityPill` patterns |

## Key states (design each)
`empty` → `planning` → `writing (streamed)` → `installing` → `starting` → **`live`** →
`error` → `fixing` → `live` · plus `sleeping` (idle), `waking`, `unsupported` (fallback).

Each state has: a clear status chip (color-coded, like `studio/StudioApp.tsx`
`STATUS_COLOR`), a one-line message, and the right primary action.

## Animations & effects (make it feel premium, not gimmicky)
- **Streaming file writes:** files appear in the tree with a soft `animate-fade-in`; the
  active file's new lines highlight briefly (typing feel).
- **Build trace:** each step ticks from spinner → ✓ with a subtle scale/opacity pop.
- **Status chip:** pulsing dot while busy (`animate-pulse`), spring to green ✓ on Live.
- **Preview reveal:** preview fades/scales in when the server is ready (`server-ready`).
- **Sleep/wake:** preview dims with a "💤 sleeping — click to wake" overlay; wake shows a
  short shimmer while the container resumes.
- **Cost pill:** number counts up smoothly so the user *sees* it's cheap (cents).
- **Error → fix:** the failing file shakes once; the agent's fix diff highlights green/red.
- Respect `prefers-reduced-motion`; keep transitions ≤ 200ms; 60fps; no layout thrash.

## Interaction principles
- **One primary action per state** (e.g., `live` → "Open in new tab"; `error` → "Let AI fix").
- **AI-first, code-optional:** never force the editor; surface it when the user wants control.
- **Always show cost + state** so trust is built in (we're cheap — show it).
- **Non-blocking iteration:** edits hot-reload; the user keeps chatting while it rebuilds.

## Accessibility
- Keyboard: focus order chat → editor → preview; `⌘/Ctrl+Enter` sends; `Esc` cancels.
- ARIA live region for build status; color is never the only signal (icons + text).
- Editor and logs are screen-reader navigable; preview iframe has a title.

## Reference: existing pieces to build on
`components/chat/CodeStudioPanel.tsx` (Sandpack inline), `studio/StudioApp.tsx`
(WebContainer studio — the v1 to evolve/replace), `components/ResizablePanel.tsx`,
`components/chat/artifacts/CodeStudioCard.tsx` (the chat CTA card).
