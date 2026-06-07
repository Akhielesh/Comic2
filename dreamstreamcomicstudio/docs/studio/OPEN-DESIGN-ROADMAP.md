# Learning from Open Design — feature survey + onboarding roadmap

A running backlog of everything in [nexu-io/open-design](https://github.com/nexu-io/open-design)
(Apache-2.0) worth adapting into our Code Studio, implemented one at a time. **Security rule for all
of it:** prefer **vendored, local** assets (zero network egress) over external services; anything
that sends user prompt/code off-box must be operator-gated (see `STUDIO_DISABLE_EXTERNAL_MCP`).

## What Open Design has
- **Design systems** — 142+ portable `DESIGN.md` files injected into the agent's system prompt.
- **Skills** — 100+ atomic design capabilities (one `SKILL.md` + assets/references each).
- **Plugins** — 261 specialized workflows.
- **Artifact types** — web/desktop/mobile prototypes, dashboards, **slide decks**, images, video, and
  **HyperFrames** motion graphics.
- **Sandboxed preview** + **export** to HTML / PDF / PPTX / MP4 / ZIP / Markdown.
- **Multi-agent routing** — auto-detects 16–21 local coding-agent CLIs.
- **MCP server** — `od mcp install`; stdio, loopback; exposes a *local* OD instance
  (`od search-files/get-file/get-artifact/plugin run`). Niche for us (reads local projects, not a catalog).

## Onboarded ✅
- **Design-system library** → `DESIGN_PRESETS` in `designSystem.ts` (vendored, local, 26 brand-grade
  systems across the categories OD covers; the agent auto-picks the best fit per request). No egress.
- **Design SKILLS axis** → `DESIGN_SKILLS` (15 reusable techniques incl. motion: bento hero,
  scroll-reveal, command palette, glass cards, sticky data-table, gradient hero, marquee, animated
  stats, skeletons, empty states, theme toggle, micro-interactions, page transitions, responsive
  nav, toasts). Auto-recommended per prompt + injected as recipes. Vendored, no egress.
- **Design-system picker** → users can PIN any of the 26 systems in Studio settings
  (`designPreset`), threaded client → server → directive; default "Auto" keeps per-prompt picking.
- **Slide-deck artifact** → the generate contract now builds presentations/decks as a first-class
  app type.
- **MCP catalog entry** for OD (env-gated `STUDIO_OPENDESIGN_MCP_URL`) for power users who self-host it.
- **Privacy gate** `STUDIO_DISABLE_EXTERNAL_MCP` so third-party reference MCPs can be turned off.

## Backlog — implement one by one (highest value first)
1. **Design "skills" axis** — adapt OD's `SKILL.md` concept as reusable *techniques* the agent can
   apply on top of a design system (e.g. "bento hero", "scroll-reveal", "command palette", "glass
   cards", "data-table with sticky header"). Vendored text, like presets. (Pairs with a UI picker.)
2. **More artifact kinds** — slide-deck and dashboard generators as first-class studio outputs
   (we already emit web/RN; add a `deck` template + export).
3. **Richer export** — beyond `.zip`: HTML bundle, PDF, and (decks) PPTX. Client-side where possible
   (no server round-trip = no egress).
4. **Design-system picker UI** — a dropdown in the studio that pins a `DESIGN_PRESET` (ties into the
   pending layout work).
5. **Bring more real `DESIGN.md` systems** — vendor additional Apache-2.0 systems from OD's
   `design-systems/` directly for users who want a specific brand clone.
6. **Motion-graphics ("HyperFrames")** — a motion/animation skill set (Framer Motion / Reanimated
   recipes) the agent can apply for richer, tasteful animation.

## Security posture (why this is safe to onboard)
- Vendored `DESIGN_PRESETS` are **static text** compiled into our bundle — they make **no network
  calls** and carry no executable code from the third-party repo.
- We did **not** vendor OD's app (Electron/Next.js/Express/SQLite) — no third-party runtime, no new
  attack surface, no supply-chain pull of their dependencies.
- External reference MCPs (Context7/DeepWiki) are the only off-box data flow; they are now
  operator-gated and the user's own/self-hosted MCPs stay behind the existing SSRF guard.
