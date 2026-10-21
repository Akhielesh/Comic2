# Project conventions

## Product ideology — build hungry, ship excellence (READ FIRST)

This is the core operating principle for anyone (human or AI) working on this app. It is
not optional polish — it is how we work.

- **Go beyond the literal ask.** A request is the floor, not the ceiling. Deliver what was
  asked, then ask "what would make this genuinely excellent?" and build that too. A task is
  not done when it works — it's done when it's something to be proud of. Assume your first
  pass is "decent, not good enough" and push it further.
- **Be proactive and smart, especially across connectors.** The whole point of connecting
  so many sources (Calendar, Gmail, Drive, Maps, finance, web…) is for the AI to *notice
  patterns and act*, not to passively answer one literal question. If the user is planning
  an event, the AI offers to add it; if an email implies a task, surface it; if data implies
  a next step, propose it. Find the patterns the user *didn't* spell out. Anticipate.
- **Push, push, push.** Plan ahead, look around the corner, and keep improving. When you
  finish something, look for the adjacent feature/flow/edge case that makes it shine and do
  that without being asked. Hunger for features and quality is part of the product, not a
  favor to the user — they shouldn't have to keep asking for excellence.
- **Always ask: how is this better?** Before calling something done, articulate what makes
  it better than the obvious version — better UX, fewer steps, smarter defaults, more
  honest failure states, one less thing the user has to think about. If you can't name how
  it's better, it isn't finished.
- **Guardrails stay.** Hunger never means cutting safety, honesty, or user consent: writes
  to a user's accounts still confirm; sensitive actions stay gated; we never fabricate. We
  go beyond *within* the honesty contract below, not around it.

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

## Database migrations (Supabase)

Schema lives in `server/sql/*.sql` (idempotent files, applied manually — there is no
auto-migration runner). When a change adds or edits one of these files, **apply it to
the production Supabase project as part of shipping**: project **"Comic"**
(ref `bdjfmxfmhqhzvgrhbbzm`), via the Supabase MCP `apply_migration` tool when
available (use a descriptive snake_case migration name so it's recorded), otherwise
tell the user exactly what to run. Inspect the live table first (`list_tables`,
information_schema) — several tables predate their SQL files, so reconcile rather
than assume a blank slate. Ordering matters for hardening steps: anything that
revokes the CLIENT's direct table access (e.g. the commented revoke in
`server/sql/user_settings.sql`) must only run AFTER the frontend that stops using
direct access is deployed and old tabs have had time to reload.

## Deploy

Production is the **`Dreamstrream-v1`** branch (Cloudflare Pages builds the frontend from
it; GitHub Actions deploy the Workers and the backend container). Publishing = fast-forward/merge the feature branch into
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

## Backend hosting & cost control

> **Authoritative infra docs live in [`docs/infrastructure/`](docs/infrastructure/README.md):**
> `INFRA_MAP.md` (dependency map), `COST_RUNBOOK.md` (full optimization playbook +
> monthly checklist), `ENV_MATRIX.md`, `SECURITY_FINDINGS.md`. This section is the
> quick reference; the runbook is the source of truth.

**Since 2026-10-19 the Express backend runs on Cloudflare, not Railway.** It is the
`Backend` Container class inside the `dreamstream-api` Worker (`api-proxy/`): image
`Dockerfile.cloudflare` (esbuild bundle + only `sharp`/`pyodide`/`sql.js` installed),
`basic` instance, one instance, sleeps 15 min after the last request (billed only while
awake, on the Workers Paid plan the account already has for the studio container). Deployed
by `.github/workflows/deploy-api-proxy.yml` on pushes touching `server/**`, `shared/**`,
`api-proxy/**`, root `package*.json`, etc. The frontend (Pages) and the other Workers
(`-data-egress`, `-live`, `-email`, `-studio`) are unchanged. (The `atlas-studio` worker —
Atlas Studio at `atlas.dreamstreamstudio.ai`, repo `Akhielesh/AtlasD` — plus
`akhieleshpersonalwebsite` and the unused `atlasd` stub on the same Cloudflare account are
*not* DreamStream; DreamStream only links to Atlas Studio, via `services/atlasStudio.ts`.)

- **Backend env:** non-secret config = `vars` in `api-proxy/wrangler.jsonc`; secrets = rows in
  D1 `dreamstream-backend-env` (`backend_env(name, value)`) or Worker secrets (which override
  D1). Every string var/secret except `BACKEND_TARGET`/`BACKEND_ORIGIN` reaches the container.
  **Never put a secret in `wrangler.jsonc` — the repo is public.**
- **Railway is a dormant fallback** (trial expired 2026-10-16; `railway.json` + root
  `Dockerfile` + the `hospitable-enthusiasm`/`Comic2` service and its variables are kept).
  Switch back with `"BACKEND_TARGET": "origin"` — see `INFRA_MAP.md` §3a. Don't delete them.
- **No Redis on the backend.** `REDIS_URL` unset is intentional: rate-limiting falls back
  to in-memory and connector sync runs in-process. (Redis *is* the BullMQ broker for the
  **separate** `ventures:worker` / `connectors:worker` processes — not run by default and
  never folded into the backend.)
- **Memory baseline (1 GiB instance):** Pyodide (`server/src/services/pyodideRunner.ts`)
  loads packages on demand via `loadPackagesFromImports` — never re-add eager preloading
  (WASM memory never shrinks, so it permanently pins ~500MB). Node heap is capped in both
  Dockerfiles (`NODE_OPTIONS=--max-old-space-size=512`).
- **Keep it sleepable:** nothing may call `/api/*` on a timer (an uptime ping every few
  minutes keeps the container awake 24/7). Background timers (`providerUsage` flusher,
  `modelCatalog` refresh) are `.unref()`'d and send no network when idle — keep them that way.
- **New server dependency?** If it ships native binaries or loads files from its package
  directory at runtime, add it to the `--external:` list *and* the generated
  `package.json` in `Dockerfile.cloudflare`; otherwise esbuild bundles it automatically.

The Railway MCP (`.mcp.json`) needs an **Account/Team** token (railway.com/account/tokens)
in `RAILWAY_API_TOKEN` — a Project token (36-char UUID) fails account-level calls.

## Data connectors

Before answering "do we have data/API coverage for topic X?", adding a data
source, or changing provider chains: **read `docs/DATA_CONNECTORS.md`** — the
authoritative topic→API map with license verdicts, budgets, account-wise usage
logging, and the add-a-connector checklist. Keep it updated in the same PR as
any connector change.
