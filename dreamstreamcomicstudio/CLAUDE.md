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
`components/chat/artifacts/kit/` (Surface, Chart, Sparkline, gauges, RangeTabs,
TrendPill, theme/palette, formatters). Match the house style: `border-2 border-black`,
`shadow-comic`, `font-display`/`font-comic`, `animate-fade-in`. Charts are inline SVG —
no charting libraries.

## Build / verify

- Client typecheck: `npm run typecheck`
- Server typecheck: `npm run build:server`
- Tests: `npx vitest run`  (a few suites fail locally only because Supabase env vars
  are unset — that's environmental, not a regression.)
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
