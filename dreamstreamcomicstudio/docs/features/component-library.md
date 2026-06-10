# Chat widget system (component library)

The chat renders typed "artifact" cards — weather, markets, maps, courses, itineraries —
instead of walls of text. This doc covers the full pipeline (server tool → renderer),
the design language, the Primitive Kit, dual density, resize, theming, the complete
artifact type table, and the checklist for adding a new widget.

## Pipeline: tool → artifact → renderer → frame

1. **A server tool returns artifacts.** Every tool implements `ChatTool.execute()` and
   may return `artifacts: ChatArtifact[]` on its `ToolExecResult`
   (`server/src/ai/tools/types.ts:21-39`). An artifact is just `{ type, data }`.
2. **The chat loop stamps origin.** `runChat` in `server/src/ai/chat.ts` collects
   artifacts from tool calls and stamps each with the call that produced it:
   `{ ...a, origin: { tool, args } }` — native function-calling loop at
   `server/src/ai/chat.ts:630`, JSON tool-protocol loop at `server/src/ai/chat.ts:545`.
   The `origin` powers live refresh (see `docs/features/live-widgets.md`).
3. **The contract type.** `ChatArtifact = { type: string; data: unknown; origin? }`
   (`apiTypes.ts:813-821`). `type` keys the client renderer; the loop and storage never
   change when a new artifact type is added.
4. **The renderer registry.** `ARTIFACT_RENDERERS` in
   `components/chat/artifacts/ChatArtifacts.tsx:42-69` maps each `type` string to a
   React component. `ARTIFACT_TYPES` (`ChatArtifacts.tsx:72`) is its key list, used by
   the gallery coverage test.
5. **Boundary + frame.** Every artifact renders inside `ArtifactBoundary` (a malformed
   `data` degrades to a small notice, never a blank message —
   `ChatArtifacts.tsx:146-155`), then inside `LiveArtifact` (live-data state,
   `ChatArtifacts.tsx:101-144`) which wraps the card in `WidgetFrame`.
6. **Layout.** A single artifact renders alone; multiple artifacts pack into a
   responsive grid where compact cards (quotes, charts, KPI boards, news) go two-up and
   types in `FULL_WIDTH` span both columns (`ChatArtifacts.tsx:161-175`).

## Design language: macOS "calm studio" glass

House style lives in two files:

- `components/chat/studioDesign.ts` — the token sheet for the whole chat shell:
  `CANVAS_BG` warm paper `#FAF9F5`, `GLASS`/`GLASS_STRONG` frosted surfaces,
  `HAIRLINE` (`border border-black/10` — the *only* border weight), `SHADOW_SOFT`
  ambient shadow, ink `#1a1915` / muted `#6e6a60` text, terracotta accent `#D97757`,
  radii (`rounded-2xl` panels, `rounded-xl` controls), and composites (`PANEL`,
  `PRIMARY_BTN`, `MENU`, …).
- `components/chat/artifacts/kit/Surface.tsx` — the card shell every widget sits in:
  `rounded-2xl border border-black/10 bg-white/85 backdrop-blur-md` with a soft
  ambient shadow (`Surface.tsx:26-45`), optional accent gradient strip, optional
  header/right/footer slots.

**Do**
- Compose from `Surface` + kit primitives; hairline dividers `divide-black/5`;
  recessed wells `bg-black/[0.03]`; `tabular-nums` for columnar numbers;
  `transition-all duration-200` motion.
- Use `SurfaceTitle` / `SurfaceSubtitle` for headers (`Surface.tsx:49-55`).

**Don't** (enforced by convention, called out in `Surface.tsx:9-11` and `CLAUDE.md`)
- No legacy comic styles inside chat widgets: no `border-2 border-black`, no
  `shadow-comic`, no `font-display` / `font-comic`, no hard offset shadows, no
  brand-yellow.
- No charting libraries — all charts are dependency-free inline SVG.

## Primitive Kit API

Everything exported from `components/chat/artifacts/kit/index.ts`:

| Export | What it is |
|---|---|
| `Surface` | The macOS-glass card shell (header / right / accent strip / footer slots). |
| `SurfaceTitle`, `SurfaceSubtitle` | Standard quiet header text (semibold ink title, small muted subtitle). |
| `Expandable` | Shared "More / Less detail" disclosure footer so every card expands identically. |
| `DensityProvider`, `useDensity`, `useCompact` | Widget density context (`'compact' \| 'detailed'`); `useCompact()` is the common branch (`kit/density.tsx:13-25`). |
| `WidgetDensity` (type) | `'compact' \| 'detailed'`. |
| `LiveDataContext`, `useLiveData`, `LiveDataApi` (type) | Live-refresh context — `{ canRefresh, refreshing, asOf, refresh(argsPatch?) }` (`kit/liveData.ts:12-31`). |
| `Chart` (+ `ChartPoint`, `Candle`, `ChartVariant`) | Interactive SVG chart with crosshair + tooltip; line / area / candlestick over the same data. |
| `Sparkline` | Mini line+area chart, no axes/hover — for KPI tiles and table cells. |
| `RadialGauge`, `LinearGauge`, `Compass`, `SunArc` | SVG gauges (UV/AQI/humidity/pressure, wind compass, sunrise arc); themeable, reduced-motion aware. |
| `RangeTabs` | macOS segmented control — the 1D/1W/1M timeline selector. |
| `TrendPill`, `Badge`, `Chip` | Status atoms: signed-change pill with arrow, generic colored badge, selectable chip. |
| `resolveTheme`, `withAlpha`, `PALETTES`, `BULL`, `BEAR`, `NEUTRAL` (+ `PaletteName`, `Palette`, `ThemeInput`, `ResolvedTheme` types) | Shared color system (see Theming below). |
| `compactNumber`, `formatPrice`, `formatPriceCompact`, `formatPercent`, `formatSigned`, `relativeTime`, `shortDate` | Shared formatters so number/date rendering is consistent across cards (`kit/format.ts`). |

## Dual density: two versions per widget

Every artifact is wrapped by `components/chat/artifacts/WidgetFrame.tsx`, which owns a
`compact` ⇄ `detailed` toggle (floating pill, top-right, `WidgetFrame.tsx:150-157`):

- **Density-aware cards** implement a real glance layout by branching on
  `useCompact()` / `useDensity()`. They are listed in `DENSITY_AWARE_TYPES`
  (`ChatArtifacts.tsx:77-95`).
- **Everything else** still gets a working compact mode: the frame clamps the card to
  `CLAMP_HEIGHT = 210px` with a fade + "Show more" scrim (`WidgetFrame.tsx:57`,
  `130-178`). So every widget has two sizes even before a bespoke compact design.
- **AI hint:** the model can pre-pick a mode by emitting `density: 'compact' |
  'detailed'` inside the artifact `data`. `LiveArtifact` reads it
  (`ChatArtifacts.tsx:132`) and passes it as `densityHint`; the user's saved choice
  per type wins over the hint (`WidgetFrame.tsx:62-66`).
- **Persistence:** the chosen density is saved per artifact *type* in localStorage key
  `ds.widget.density.v1` (`WidgetFrame.tsx:22`).
- The gallery's global compact/detailed switch uses the `forcedDensity` prop, which
  hides the per-card toggle (`WidgetFrame.tsx:52`, `150`).

## Resize behavior

Detailed mode only (compact is fixed-small by design, `WidgetFrame.tsx:182`):

- Bottom drag handle adjusts widget **height** (width is owned by the grid). Clamped
  to 140–1400 px (`WidgetFrame.tsx:58-59`).
- Double-click the handle resets to natural/auto height (`WidgetFrame.tsx:112-115`).
- `Escape` cancels an in-flight drag, macOS-style (`WidgetFrame.tsx:118-128`).
- Heights persist per artifact type in localStorage key `ds.widget.height.v1`
  (`WidgetFrame.tsx:23`); toggling density resets any manual height so the new layout
  sizes naturally (`WidgetFrame.tsx:78-85`).

## Theming / AI customization

`components/chat/artifacts/kit/theme.ts` is the one color system:

- 7 named palettes (`brand`, `bull`, `bear`, `ocean`, `sunset`, `violet`, `mono`) each
  resolving to an `accent` + multi-series chart ramp (`theme.ts:27-35`).
- `resolveTheme({ palette?, accent?, trend? })` (`theme.ts:55-64`): an explicit
  `accent` hex overrides the palette; a numeric `trend` auto-picks bull/bear/neutral
  (finance). Unknown palette names **fall back to brand instead of throwing** — the
  model supplies `palette` as a free string (`theme.ts:56-58`).
- The AI recolors a card by emitting `palette` (and/or `accent`) in the artifact data;
  cards pass it through `resolveTheme` and feed `Surface`'s `accent` strip.
- `withAlpha(hex, alpha)` makes translucent fills for chart areas (`theme.ts:67-75`).

## All artifact types

From `ARTIFACT_RENDERERS` (`ChatArtifacts.tsx:42-69`). Density-aware =
`DENSITY_AWARE_TYPES` (`:77-95`); full-width = `FULL_WIDTH` (`:161`).

| Type | Component (components/chat/artifacts/) | What it renders | Density-aware | Full-width |
|---|---|---|---|---|
| `weather` | `WeatherStation.tsx` | Flagship weather station: animated sky, gauge grid, hourly chart, 7-day, AQ/pollen, sun arc, map. | yes | yes |
| `video_results` | `VideoResults.tsx` | Video grid; YouTube/Vimeo play inline in the side panel. | yes | yes |
| `map` | `MapArtifactCard.tsx` | Interactive inline map with markers (expandable to side panel). | yes | yes |
| `news_results` | `NewsDigest.tsx` | News digest: lead story + divided rows, sentiment, live topic chips. | yes | no |
| `places_results` | `PlacesResults.tsx` | Local-pack place list (photos, hours, distance) + map. | yes | yes |
| `stock_quote` | `MarketCard.tsx` | Market quote: price, trend pill, interactive chart, fundamentals drawer. | yes | no |
| `swarm_trace` | `SwarmTraceCard.tsx` | Agent-swarm run trace: agents, findings, verifier confidence. | yes | yes |
| `chart` | `ChartCard.tsx` | Universal schema-driven viz: line/area/bar/pie/donut/scatter. | yes | no |
| `metric_board` | `MetricBoard.tsx` | KPI tiles with big compact numbers + sparklines. | yes | no |
| `data_table` | `DataTableCard.tsx` | macOS list-view table: sortable, typed cells (currency/percent/sparkline/badge). | yes | no |
| `market_heatmap` | `HeatmapCard.tsx` | Green→red tile grid, optional cap-weighted treemap sizing. | yes | no |
| `finance_terminal` | `FinanceTerminal.tsx` | Flagship composite terminal: focus quote, indices, watchlist, heatmap, news rail. | yes | no |
| `code_studio` | `CodeStudioCard.tsx` | Generated-app handoff card with one "Open in Code Studio" CTA. | no | yes |
| `recipe_card` | `RecipeCard.tsx` | A reusable parameterized agent workflow (goose-style recipe) summary. | no | yes |
| `recipe_run` | `RecipeRunCard.tsx` | Record of a recipe run: params, mode, outcome, structured JSON. | no | yes |
| `research_report` | `ResearchReport.tsx` | Deep-research header: depth, sub-questions, sources gathered/read. | yes | yes |
| `quiz` | `Quiz.tsx` | Self-grading interactive quiz (single/multi/short/true-false). | no | yes |
| `document` | `DocumentCard.tsx` | AI-authored document rendered inline with download/print (.md/.html/PDF). | yes | yes |
| `flashcards` | `Flashcards.tsx` | Flip-card deck with known/review marking, shuffle, persisted progress, CSV export. | yes | yes |
| `sql_exercise` | `SqlPlayground.tsx` | Runnable SQL editor against a sandboxed server-side sql.js database. | no | yes |
| `resource_bundle` | `ResourceBundle.tsx` | Multi-file kit with per-file and .zip download. | no | yes |
| `code_exercise` | `CodePlayground.tsx` | JS/Python playground in a sandboxed Web Worker (Python via Pyodide). | no | yes |
| `generative_ui` | `GenerativeUICard.tsx` | Agent-composed layout from a whitelisted block tree of kit elements. | no | yes |
| `dashboard` | `DashboardCard.tsx` | Customizable glass widget board with live widgets over an aurora gradient. | no | yes |
| `learning_path` | `LearningPathCard.tsx` | Progress-tracked guided course (see `guided-learning.md`). | yes | yes |
| `itinerary` | `ItineraryCard.tsx` | Day-tabbed trip plan with map + budget (see `travel-planner.md`). | yes | yes |
| `ticker_tape` | `TickerTape.tsx` | Live scrolling market strip (marquee + readable rows); pauses on hover, static under reduced motion. | yes | yes |
| `market_sentiment` | `MarketSentiment.tsx` | Fear & Greed gauges (stocks: CNN + components, crypto: alternative.me) with history. | yes | no |
| `yield_curve` | `YieldCurveCard.tsx` | US Treasury par yield curve morphing today ↔ 1M ↔ 1Y ago; 2s10s spread + inversion badge. | yes | no |
| `portfolio` | `PortfolioCard.tsx` | Live-priced holdings: totals + day/total P&L, allocation donut, holdings table. | yes | yes |
| `whats_changed` | `WhatsChangedCard.tsx` | Agent changelog "since you last looked": weighted rows, kind icons, delta pills. | yes | no |
| `boarding_pass` | `BoardingPass.tsx` | Wallet-style flight pass: 3D flip to details, status edge glow, QR. | yes | no |
| `currency_converter` | `CurrencyConverter.tsx` | Live ECB converter: editable amount, ⇄ swap, 30-day trend + verdict. | yes | no |
| `world_clocks` | `WorldClocks.tsx` | Ticking analog+digital clocks per zone, sleep shading, "good time to call" window. | yes | no |
| `packing_list` | `PackingListCard.tsx` | Interactive packing checklist; check-offs persist locally (`ds.packing.v1`). | yes | no |
| `trip_countdown` | `TripCountdown.tsx` | Live D/H/M/S countdown hero with destination weather strip + prep list. | yes | no |
| `goal_tracker` | `GoalTracker.tsx` | /goal tracker: milestone timeline with persisted check-offs (`ds.goal.v1`), metric, next actions. | yes | yes |
| `code_review` | `CodeReviewCard.tsx` | /code-review verdict card: severity-grouped findings, file:line chips, suggested fixes. | yes | yes |
| `live_monitor` | `LiveMonitorCard.tsx` | /loop wrapper: re-runs one refreshable tool on an interval; embedded card inherits density. | yes | yes |

## How to add a new widget — checklist

1. **Declare the data type** in `apiTypes.ts` (an `XxxArtifact` interface; include
   optional `palette?` and `density?: 'compact' | 'detailed'` if the AI should style it).
2. **Build the renderer** under `components/chat/artifacts/`, composed from the kit
   (`import { Surface, useCompact, resolveTheme, ... } from './kit'`). Calm-studio
   style only — see the do/don't list above.
3. **Register it** in `ARTIFACT_RENDERERS` (`ChatArtifacts.tsx:42`). If it has a real
   compact layout, add the type to `DENSITY_AWARE_TYPES` (`:77`); if it's large or
   interactive, add it to `FULL_WIDTH` (`:161`).
4. **Add a gallery demo** to `GALLERY_DEMOS` in
   `components/chat/ComponentGallery.tsx:576` with the `type` field and realistic
   sample data. This is mandatory.
5. **Coverage test:** `components/chat/gallery.coverage.test.ts:9-18` fails CI if any
   `ARTIFACT_TYPES` entry lacks a matching `GALLERY_DEMO_TYPES` entry (or vice versa).
   Run `npx vitest run components/chat/gallery.coverage.test.ts`.
6. **(If a model should emit it)** add the producing tool in
   `server/src/ai/tools/registry.ts` (returning `artifacts: [{ type, data }]`) and a
   catalog entry in `toolCatalog.ts` so smart-routing and the Tools dashboard know it.
7. **(If it's a pure live-data snapshot)** consider the refresh allowlist — see
   `docs/features/live-widgets.md`.

## Gotchas

- `artifact.data` is `unknown` end-to-end; renderers must tolerate partial payloads.
  `ArtifactBoundary` catches render crashes, but prefer defensive coercion.
- Density defaults to `'detailed'` outside a `WidgetFrame` (gallery panels, tests) —
  `kit/density.tsx:21-22`.
- localStorage writes are wrapped in try/catch everywhere (private-mode Safari):
  preferences silently don't persist, nothing throws.
- `FULL_WIDTH` only matters when a message carries ≥2 artifacts; a single artifact
  always renders full width (`ChatArtifacts.tsx:163-175`).
