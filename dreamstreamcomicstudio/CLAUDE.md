# Project conventions

## Rich-output components (chat artifacts) — MUST READ before adding one

The chat renders typed "artifact" cards (weather, stock, news, charts, maps, …).
The pipeline is: a server tool returns `{ type, data }` → `apiTypes.ts` declares the
type → `components/chat/artifacts/ChatArtifacts.tsx` maps the type to a component →
the component renders it.

### RULE: every new component / asset / visual MUST appear in the Gallery view

Whenever you add (or significantly change) a rich-output component, asset, or visual,
it **must** show up in the live Gallery (Settings → Gallery tab, rendered by
`components/chat/ComponentGallery.tsx`).

Concretely, to add a new artifact component:

1. Declare its data type in `apiTypes.ts`.
2. Register the renderer in `components/chat/artifacts/ChatArtifacts.tsx`
   (`ARTIFACT_RENDERERS`).
3. **Add a demo entry to `GALLERY_DEMOS` in `components/chat/ComponentGallery.tsx`,
   with its `type`,** using realistic sample data.
4. (If a model should emit it) add a tool in `server/src/ai/tools/registry.ts` and a
   catalog entry in `toolCatalog.ts`.

This is enforced by `components/chat/gallery.coverage.test.ts`: every artifact type in
`ARTIFACT_TYPES` must have a matching entry in `GALLERY_DEMO_TYPES`. If you add a
renderer without a gallery demo, that test fails. **Do not skip the gallery demo.**

### Shared visual kit

Build new visuals from the dependency-free Primitive Kit in
`components/chat/artifacts/kit/` (Surface, SurfaceTitle/Subtitle, Chart, Sparkline,
gauges, RangeTabs, TrendPill, theme/palette, formatters, density). Charts are inline
SVG — no charting libraries.

**House style for widgets is the macOS "calm studio" glass language** (same family
as `components/chat/studioDesign.ts`): `Surface` shell (rounded-2xl, hairline,
frosted glass, soft ambient shadow), `tabular-nums` for columnar numbers. **Never**
use the legacy comic styles inside chat widgets: no `border-2 border-black`, no
`shadow-comic`, no `font-display`/`font-comic`.

**Colors MUST come from the theme tokens** (light + Claude-style dark themes, set
as `--ds-*` CSS vars in `index.css`, toggled by a `dark` class via
`services/theme.ts`): `text-[var(--ds-ink)]`, `text-[var(--ds-muted)]`,
`bg-[var(--ds-canvas|sidebar|surface|surface-soft|surface-strong|raised|well)]`,
`border-[var(--ds-hairline)]`/`[var(--ds-hairline-soft)]`,
`hover:bg-[var(--ds-hover)]`, accent `bg-[var(--ds-accent)]`
`hover:bg-[var(--ds-accent-hover)]`. Never hardcode the paper/ink hexes; never put
a Tailwind slash-opacity on a `var()` color (invalid CSS) — accent tints use the
literal `bg-[#D97757]/10` form since the accent is theme-invariant.

### Two versions per widget (density)

Every artifact is wrapped by `components/chat/artifacts/WidgetFrame.tsx`, which
provides resize (drag handle, persisted per type) and a compact ⇄ detailed density
toggle. Cards read the mode with `useCompact()`/`useDensity()` from the kit and
should render a real glance layout when compact. When a card gains a bespoke
compact layout, add its type to `DENSITY_AWARE_TYPES` in `ChatArtifacts.tsx`
(unlisted cards get an automatic clamped preview instead). The AI can pre-pick a
mode by emitting `density: 'compact' | 'detailed'` in the artifact data.

## Build / verify

- Client typecheck: `npm run typecheck`
- Server typecheck: `npm run build:server`
- Tests: `npx vitest run`  (the SessionStart hook writes placeholder Supabase env vars,
  so the full suite runs out of the box on Claude Code on the web. Running elsewhere
  without those vars set, a few suites fail at import on `supabaseUrl is required` —
  environmental, not a regression; set dummy `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.)
- Frontend build: `npm run build`

## Deploy

Production is the **`Dreamstrream-v1`** branch (Cloudflare Pages builds frontend from it;
Railway builds the backend). Publishing = fast-forward/merge the feature branch into
`Dreamstrream-v1` and push. It often diverges between sessions, so fetch and merge first.

**STANDING RULE — always ship to production.** The user wants every completed change
pushed straight to production (`Dreamstrream-v1`), NOT left on a preview/review branch.
So after committing + verifying (typecheck, tests, build), automatically:
1. push the feature branch, then
2. fetch `Dreamstrream-v1`; if it diverged, merge it in and resolve conflicts faithfully
   (keep both sides' features; honor the user's explicit intent on semantic conflicts);
3. fast-forward/merge the work into `Dreamstrream-v1` and push it.
Do this without waiting to be asked. Never force-push production; if the merge is
genuinely ambiguous or risky, pause and ask. (The auto-mode classifier may still prompt
for the production push — that's fine, proceed once allowed.)

## Data connectors

Before answering "do we have data/API coverage for topic X?", adding a data
source, or changing provider chains: **read `docs/DATA_CONNECTORS.md`** — the
authoritative topic→API map with license verdicts, budgets, account-wise usage
logging, and the add-a-connector checklist. Keep it updated in the same PR as
any connector change.
