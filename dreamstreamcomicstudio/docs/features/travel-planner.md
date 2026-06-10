# Travel planner (interactive itineraries)

"Plan 3 days in Tokyo" produces a day-tabbed trip widget with a stop timeline, an
inline map with a route, budget lines, packing list and **live** destination weather.
The model composes the plan; the `plan_trip` tool coerces it and enriches it with
real data (geocoding + weather), both best-effort.

## The tool: `plan_trip`

`server/src/ai/tools/travel.ts`. Registered at
`server/src/ai/tools/registry.ts:888`; catalog entry (category `places`, provider
"DreamStream (plan) + OpenStreetMap geocoding + Open-Meteo weather", keyless) at
`toolCatalog.ts:538-543`.

**Schema** (`travel.ts:145-196`): only `days` is required; each day needs `stops`;
each stop needs `name`. Stop `kind` enum:
`flight | transit | hotel | food | sight | activity | shopping | other`
(`travel.ts:12`). The description instructs the model to compose realistic days
(3–6 stops, logical geography/timing), include lat/lng only when confident (the rest
is geocoded), and to call `find_places`/`get_weather` first for ground truth
(`travel.ts:139-144`).

**Coercion** — `coerceItinerary` (`travel.ts:54-89`):

- Caps: ≤21 days, ≤16 stops/day, ≤12 budget lines, ≤10 tips, ≤20 packing items.
- Strings trimmed + capped (title 200, destination 120, notes 600, address 240…);
  numbers must be finite (`num()`, `:17`); stop `url` must be `https://` (`:34`).
- A stop without a `name`, or a day without any valid stop, is dropped (`:22-23`,
  `:45`). Missing day labels become `Day {n}` (`:47`).
- Title falls back to `Trip to {destination}` (`:55`); no title and no destination →
  the whole plan is rejected and the model gets a corrective text result (`:199-201`).
- Budget lines must have both `label` and numeric `amount` (`:72-81`).

### Enrichment 1 — Nominatim geocoding (`enrichCoords`, `travel.ts:92-112`)

Stops missing `lat`/`lng` are geocoded so the map renders:

- Queries are `"{stop.name}, {destination}"` — the destination suffix disambiguates
  ("Senso-ji" → "Senso-ji, Tokyo, Japan") (`:95-97`).
- Only the **first 8** missing stops are geocoded — `geocodePlaces` caps at 8
  sequential lookups (`server/src/ai/tools/maps.ts:43-50`) to respect Nominatim's
  fair-use policy (descriptive User-Agent, light usage, `maps.ts:1-10`). Each lookup
  has a 10 s timeout (`maps.ts:14`).
- **Label-matching gotcha**: `geocodePlaces` silently *drops* failed lookups, so
  results can't be zipped back by index. Each returned marker carries its query
  string as `label` (`maps.ts:32`), and `enrichCoords` realigns via a
  `Map(label → marker)` against the exact query it built (`travel.ts:100-108`). If
  you change how queries are constructed, change the lookup key identically or every
  match silently misses.

### Enrichment 2 — Open-Meteo weather (`enrichWeather`, `travel.ts:115-135`)

When the plan has a `destination`, `getWeather(destination)`
(`server/src/ai/tools/weather.ts:168` — Open-Meteo, free/keyless, `weather.ts:1-4`)
attaches a snapshot: current description/tempC/tempF plus up to 7 daily entries
(min/max °C, description, precipitation probability).

### Best-effort failure policy

Both enrichments run in parallel (`Promise.all`, `travel.ts:202`) and **never sink
the plan**: a geocoding failure just renders fewer pins (`:109-111`); a weather
failure ships the plan without the weather strip (`:132-134`). The tool's text result
reports what happened — days, stops, how many were mapped, and live weather if
present (`:205-209`).

## Artifact contract

`ItineraryArtifact` (`apiTypes.ts:876-913`):

```ts
interface ItineraryStop { name; kind?; time?; durationMin?; lat?; lng?;
                          address?; notes?; cost?; url? }
interface ItineraryDay  { label?; date?; summary?; stops: ItineraryStop[] }
interface ItineraryArtifact {
  title: string;
  destination?; startDate?; endDate?; travelers?; currency?;
  budget?: { total?: number; lines?: { label: string; amount: number }[] };
  days: ItineraryDay[];
  tips?: string[]; packing?: string[];
  weather?: { description?; tempC?; tempF?;
              daily?: { date; minC?; maxC?; description?; precipProb? }[] }; // server-attached
  palette?: string;                       // kit palette, card defaults to 'ocean'
  density?: 'compact' | 'detailed';
}
```

## Card UX — `components/chat/artifacts/ItineraryCard.tsx`

Registered as type `itinerary` (`ChatArtifacts.tsx:68`), density-aware, full-width.

**Detailed** (`ItineraryCard.tsx:314-362`):
- Header: plane icon, title, meta line "Tokyo, Japan · Jul 10 – Jul 12 · 2 travelers"
  (`:63-73`); a live **weather chip** on the right (`:76-91`) and a recessed 7-day
  **forecast strip** (weekday, max/min °, precip %) when `weather.daily` exists
  (`:94-112`, `:324-328`).
- **Day tabs** — a macOS segmented control (raised white active pill on a recessed
  track) with per-day cost chips summed from stop costs (`:114-146`, `:60-61`).
- **Stop timeline** (`:148-198`): time column, kind icon tile (`KIND_ICONS`,
  `:28-37`), name + external link, duration ("1h 30m"), address, **click-to-expand
  notes** (truncated by default), right-aligned cost in the trip currency
  (default `USD`, `:258`).
- **Map + route**: the active day's located stops become a `MapArtifact` — numbered
  markers in visit order plus a route polyline when ≥2 points — rendered through the
  shared `InlineMap` at 200 px (`:263-281`, `:347-351`). Days with zero located stops
  simply show no map.
- **Budget footer** (`:200-236`): budget lines + total; with no explicit budget it
  falls back to the summed stop costs labeled "Stops cost (from listed stop prices)".
- **Tips & packing** in a shared `Expandable` two-column section (`:353-360`).

**Compact** (`:295-312`): a ~140 px glance card — destination/dates meta, weather
chip, "N days · M stops", and day 1's first three stop names. No tabs, no map.

## Entry points

**`/trip` slash skill** — `services/chatSkills.ts:40-60`: command `trip` (aliases
`travel`, `itinerary`, `vacation`), required argument parsed leniently: "Tokyo, 5
days" or "5 days in Tokyo" → `{ destination: 'Tokyo', days: '5' }` (regex at
`:49-58`). Runs recipe `travel-planner`.

**`travel-planner` recipe** — `server/src/ai/recipes/library.ts:185-207`: parameters
`destination` (required), `days` (default "3"), `style` (select: balanced/foodie/
culture/outdoors/family/budget/luxury), `budget` (hint). The instructions enforce the
intended sequencing: **ground first** (`get_weather` + `find_places`), *then* call
`plan_trip` with realistic days, budget in local currency, and a forecast-informed
packing list; finish with a 2–3 sentence summary and book-early flags.

**Organic**: catalog keywords ("trip", "itinerary", "weekend in", "road trip", …,
`toolCatalog.ts:542`) route natural requests to the tool.

## Related tools and travel MCPs

Same-turn companions (all in `server/src/ai/tools/registry.ts`):

- `find_places` (`registry.ts:336`) — discover restaurants/sights ("near me", local
  pack); used pre-plan for ground truth, and itself refreshable post-render.
- `get_weather` (`registry.ts:136`) — full weather station card; `plan_trip` reuses
  its `getWeather` engine internally.
- `show_map` (`registry.ts:195`) — standalone map of specific places/routes (also
  Nominatim-geocoded via `maps.ts`).

Free travel MCPs in the curated catalog (`server/src/ai/tools/mcpCatalog.ts`,
category `travel`) extend planning with one-click connect from the Tools dashboard:

- **Ferryhopper** (`mcpCatalog.ts:122-130`, `https://mcp.ferryhopper.com/mcp`) —
  ferry routes, schedules and booking info across operators (island-hopping legs).
- **SubwayInfo NYC** (`mcpCatalog.ts:131-139`, `https://subwayinfo.nyc/mcp`) — NYC
  subway/transit status, delays and service alerts.

See `docs/features/mcp-directory.md` for how connected MCP tools enter the loop.

## Gotchas

- `plan_trip` is **not** in `REFRESHABLE_TOOLS` (`apiTypes.ts:828-837`) — the
  itinerary is a model composition, not a pure data snapshot, so there's no refresh
  button. The weather inside it is a point-in-time snapshot from plan time.
- Only 8 stops per plan get geocoded; on a 5-day trip the model should supply lat/lng
  for well-known stops so the budget goes to the obscure ones.
- Geocoding quality depends on the destination suffix — generic stop names
  ("Lunch", "Hotel check-in") will geocode to the city centroid or fail (fine: the
  failed ones are just unpinned).
- Nominatim and Open-Meteo are public, fair-use endpoints; they can't be verified in
  the build sandbox and may rate-limit under load (`maps.ts:1-5`, `weather.ts:6-8`).
