# Credit: Open Design (nexu-io/open-design)

The Code Studio's brand-grade **design-system presets** (`DESIGN_PRESETS` in
`server/src/ai/studio/designSystem.ts`) are onboarded from the open-source
[nexu-io/open-design](https://github.com/nexu-io/open-design) project, licensed under
**Apache-2.0**. Open Design publishes design systems as portable `DESIGN.md` files that are
injected into a coding agent's system prompt — the same pattern this studio uses for its design
directive — so its approach (and several of its systems, e.g. the warm "Claude" literary-salon
system that inspired our `warm-editorial` preset) maps directly onto ours.

## How we onboarded it (and why not the whole repo)

Open Design is a full local-first **desktop app** (Next.js 16 + Electron + Express + SQLite). We do
**not** vendor that application — it's irrelevant to our backend and a maintenance trap. Instead we
onboarded the part that makes our agents design better:

1. **Curated preset library (baked in):** a set of concrete, pickable design languages in the
   `DESIGN.md` spirit, attributed here. The agent picks the best fit per the user's ask
   (`pickDesignPreset`) and applies it, grounded in proven systems instead of inventing one.
2. **Optional MCP (local OD instance):** Open Design ships a real **stdio MCP server**
   (`od mcp install <agent>`) that exposes a *running, local* Open Design instance to an agent via
   `od search-files` / `od get-file` / `od get-artifact` / `od plugin run` (loopback by default).
   It's designed to let a coding agent read **your own local OD projects** — it is NOT a hosted
   catalog of the 142 systems. So for the studio it's a niche/power-user path (front the stdio
   server with an HTTP bridge and set `STUDIO_OPENDESIGN_MCP_URL`); the **design systems themselves
   come from the baked-in `DESIGN_PRESETS`** above, sourced from the repo's Apache-2.0 `DESIGN.md`
   files — that's the real onboarding, not the MCP.

## License

Apache-2.0 © the Open Design contributors. See https://github.com/nexu-io/open-design for the
full license and NOTICE. Our adaptation is design prose/guidance, not a copy of their source.
