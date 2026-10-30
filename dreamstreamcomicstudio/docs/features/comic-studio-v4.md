# Comic Studio v4 — the conversational studio

**Status:** building (2026-10-21). Supersedes the wizard (`comic-studio.md`) and the
unshipped v3 agent stream (`comic-studio-v3-agent-stream.md`) as the default way to
make a comic. Legacy projects keep opening in the classic editor.

**Owner brief (verbatim intent):** the user just talks (types or speaks) like in
Gemini's image generation; the options panel pops up when it's relevant; the studio
keeps building and *sticking* the idea; the backend does the heavy lifting —
prompting, structuring, cost, context, input/output — and is model-capability aware so
new models slot in. "Not a single comic has turned out well" — quality is the bar.

---

## 1. Why the old studio failed (diagnosis, 2026-10-21)

Full evidence: the deep-map reports summarized in the PR. The ranked root causes:

1. **No page.** Every panel was a separate text-free image, center-cropped into a
   square CSS grid. Composition, gutters, lighting and identity were never shared
   across a page. Slot ratios contradicted generation ratios (up to 47% cropped).
2. **Reference overload + mislabeling.** Up to 8 *unlabeled* references per panel to a
   default model (`gemini-2.5-flash-image`) that accepts **3**. Scene cast was unioned
   into every panel → identity bleed (Arjun rendered as a second Maya).
3. **Weak, capability-blind planning.** Panel breakdowns ran on free/coding models
   (`qwen3-coder`, `nemotron:free`) at temperature 0.1 with no comics craft, 620-char
   scene clips, forced filler captions ("every panel must include dialogue").
4. **No plan review before spend; every fix wiped downstream work** (re-analysis reset
   style/cast/panels). Trial and error = full re-spend.
5. **Lettering leaked prompt text** (`ensureDialogueBlocks` captioned the image prompt)
   and bubbles were placed blind on fixed quadrants.
6. **Cost invisible and wrong** (three disagreeing estimators, unknown models priced at
   $0, BYOK spend untracked, ledger 32 events vs 1,006 artifacts).
7. **Browser-run orchestration** (close the tab = lose the run), stale/shut-down model
   ids, aspect ratio sent as prose, no QA loop.

## 2. The decisions

| Decision | Why |
|---|---|
| **The page is the unit** of planning and rendering. One image per page (panels, gutters, composition in one call). | Current models (Nano Banana 2.1 / Pro) compose full pages with 4–5 consistent characters from 14 labeled references. Removes B1/B3 failure classes outright. |
| **One structured ComicDoc**, server-authoritative, changed only by `DocOp`s (`shared/comic/`). | "Sticking the idea": every utterance lands in the doc; every render is *compiled* from it; the chat is never the source of truth. |
| **Server-side Comic Director** (tool-calling LLM) + **server job runner**. | Backend control, resumable renders, real billing, no browser orchestration. |
| **Capability registry** (`shared/comic/models.ts`) drives routing, reference caps, aspect/resolution validation, lettering choice and estimates. | New models = one registry entry. No more 9 disagreeing places. |
| **Labeled references within caps**, compiled per page from the page's actual cast. | Fixes identity bleed. |
| **Overlay lettering by default** (vector balloons placed by a vision pass), **in-art lettering on Pro**. | Exact, editable text everywhere; Pro letters beautifully when asked. |
| **Plan before pixels.** Page scripts are shown and editable before any page render. | Cuts trial-and-error spend. |
| **Gated spend with estimates** (confirm policy + budget cap), per-image billing, BYOK spend still tracked. | Trust. |
| **Edits are scoped**: "fix panel 2" = an image edit of that page with the region marked; plan edits mark pages *stale*, never auto-wipe. | Iteration without re-spending everything. |

## 3. Experience

### Layout (desktop ≥1024px)
```
┌──────────────────────────────────────────────────────────────────────────┐
│ ‹  Title (editable)        ● Standard ▾   $0.42   [Read]  [Export ▾]  ⚙  │
├───────────────────────────────┬──────────────────────────────────────────┤
│ CONVERSATION                  │ BOARD   Story · Cast · Style · Pages · Read│
│                               │                                          │
│  user / director messages     │  live, structured view of the ComicDoc   │
│  + inline cards:              │  (fills in as the director works)        │
│   options chips, style picks, │                                          │
│   plan, spend gate, renders   │                                          │
│                               │                                          │
│ [suggestion chips]            │                                          │
│ ┌───────────────────────────┐ │                                          │
│ │ Describe your comic…      │ │                                          │
│ │ [+] [🎙] [▭ 2:3·6p] [🎨 Style] [✦ Standard]           [➤]       │ │
│ └───────────────────────────┘ │                                          │
└───────────────────────────────┴──────────────────────────────────────────┘
```
Mobile: one column with a `Chat | Board` segmented switch; the composer stays docked.

### The flow (nothing is a mandatory step)
1. **Empty state**: "What's your comic about?" + starter chips, "Paste a script",
   "Add character photos". The composer's option chips are visible from the start.
2. User talks. The director **immediately writes what it understood** into the doc
   (brief, cast, places, format, style direction) and replies briefly with what it
   captured + the single most useful next question, as tappable option chips.
3. **Style**: pick a preset (Style panel) or let the director propose 3 directions →
   3 cheap style boards (~$0.13) render live in a `style_choice` card → tap to lock.
4. **Cast sheets** render for leads/supports (model sheet: turnaround + expressions).
5. **Plan**: the director writes page scripts (layout, panels, shots, cast, dialogue)
   → `plan` card + the Pages board show them. User edits by talking ("make page 2 a
   splash", "Maya should be angrier") or by editing lines directly. **No image spend.**
6. **Render**: "Render pages" → estimate → gate (per confirm policy) → pages develop
   live on the board (page 1 first, then the rest in parallel, with page 1 as the
   continuity anchor). Each page gets a vision QC pass + balloon layout.
7. **Edit**: open a page → Mark up (drag a box) + instruction, or say "in page 3 panel
   2 make it night". Versions are kept; restore any time. Edit balloons by dragging.
8. **Cover**, **Read**, **Export** (print-quality PDF via print view, PNG pages ZIP).

### Option panels (Gemini-style, pop above the composer)
- **Format**: kind (Comic/Manga/Webtoon/Strip/Storybook), page aspect, page count
  (1–40), panels per page (Auto/3–6), lettering (Overlay/In-art), reading direction.
- **Style**: preset grid (`shared/comic/stylePresets.ts`) + "Describe your own".
- **Quality**: Draft / Standard / Pro with model nickname, per-page price, speed.
The director can also *open* a panel for the user by emitting an `options` card.
Changing a panel = a `patch` action (instant, no LLM), and the director sees it next turn.

### Voice
Mic in the composer reuses `hooks/useDictation` (on-device Whisper / Web Speech).
"Auto-send when I stop talking" toggle (default on) sends the transcript on stop.

## 4. Architecture

```
client (components/comicstudio)                 server (server/src/comic, routes/comic.ts)
 useStudio ── POST /stream {message|action} ──▶  StudioSession (per project, in-process)
   ▲ applyOps(ops)        SSE events  ◀────────   ├─ director.ts  (tool loop, streams text)
   │                                              ├─ tools.ts     (doc tools → DocOps)
 Board/Conversation render the doc                ├─ jobs.ts      (spend gate + render runner)
                                                  │    ├─ prompts.ts  (compile PageSpec → image job)
                                                  │    ├─ imageClient.ts (OpenRouter Images API / Gemini)
                                                  │    ├─ vision.ts   (QC + balloon layout)
                                                  │    └─ billing.ts  (per-image reserve/settle)
                                                  ├─ writer.ts    (page-script planner, strict JSON)
                                                  ├─ assets.ts    (storage save/load/sign)
                                                  └─ store.ts     (comic_docs table, rev)
```

- **Session**: one in-process `StudioSession` per project (single backend instance):
  holds the doc, serializes mutations (`commit(ops)` → `applyOps` → `rev++` → emit
  `ops` event → debounced persist ≤500 ms, forced flush at turn end). Subscribers =
  active SSE streams for that project. A stream ends when its turn and every job it
  started settle (keeps the container sleepable — no idle open streams, no polling).
- **Interrupted jobs**: on session load, renders stuck in `queued/rendering` for >3 min
  become `failed` ("Interrupted — retry").
- **Cancel**: `POST /cancel` is scoped to what it says it stops. Each message request runs
  its turn on its own session AbortController (renders capture the controller current when
  they start). While a director turn is in flight it is "Stop the director": that turn's loop
  and the not-yet-started renders it queued stop, and renders an earlier request queued keep
  drawing. With no turn in flight it is "Stop drawing": every not-yet-started render of the
  session stops. In-flight image calls finish and are kept (paid).

### Transport & events
`POST /api/comic/projects/:id/stream`, body `StreamRequest` (`shared/comic/events.ts`).
SSE framing identical to chat (`event: <type>\ndata: <json>\n\n`, 15 s `: keep-alive`,
`X-Accel-Buffering: no`). Events: `hello, ops, delta, activity, urls, error, done`.
Client: `services/sse.ts readSSEStream` + `postStream`. 45 s idle watchdog.

### Endpoints (`server/src/routes/comic.ts`, mounted at `/api/comic` after requireAuth)
| Method | Path | Body → Response |
|---|---|---|
| POST | `/projects` | `{title?, importFromProjectId?}` → `{projectId, doc, urls}` (creates `projects` row + `comic_docs` row) |
| GET | `/projects/:id` | → `{doc, urls}` (owner only) |
| POST | `/projects/:id/stream` | `StreamRequest` → SSE |
| POST | `/projects/:id/cancel` | → `{ok}` |
| POST | `/projects/:id/urls` | `{paths}` → `{urls}` (owner; paths must belong to the doc) |
| GET | `/models` | → `{models, tiers, presets}` |
| GET | `/public/:id` (mounted before requireAuth, optionalAuth) | → `{doc (sanitized: no conversation/spend/gate/memory/source), urls}` when `projects.is_public && !is_forced_private` |

### Persistence
New table `public.comic_docs(project_id uuid pk → projects.id on delete cascade,
user_id uuid, doc jsonb, rev int, created_at, updated_at)`, RLS on, owner SELECT only;
writes are server-only (service role). `server/sql/comic_docs.sql` also extends
`collect_active_image_paths()` with every `path` string in `comic_docs.doc`
(`jsonb_path_query(doc, 'lax $.**.path')`) so the 45-day asset GC never deletes a
studio asset. The `projects` row stays the listing record: the server mirrors
`name`, `updated_at`, and a minimal legacy-compatible `state` (`studioVersion: 4`,
empty legacy arrays, `coverImageId` = cover or page-1 asset, `overview` = logline).

**Canonical hashes (back-compat F1, v5).** Postgres `jsonb` reorders object keys on save (shorter keys first), so a
hash of `JSON.stringify` in memory order changed after a reload and drawn pages read "Out of date" for nothing. Every
hash that decides staleness or "changed since" now serialises with `stableStringify` (`shared/comic/hash.ts`: keys
sorted at every depth, array order kept): `pageSpecHash`, `sheetSpecHash`, `placeSpecHash`, `coverSpecHash`,
`planInputHashOf`, and the publication's `contentFingerprint` (`server/src/comic/publication/snapshot.ts`). The
hashed tuples themselves are unchanged.
- **Load-time legacy acceptance.** A doc stamped before F1 is repaired once per load: `session.ts recoveryOps` runs
  `legacySpecHashOps`, which tries a bounded set of likely key-order variants of each non-canonical render (and the
  plan input hash) with the pre-F1 serialisation. On a match it writes a server-only render patch with the
  canonical hash, so nothing is redrawn, re-quoted or charged; no match stays stale, honestly.
- **Publication.** `fingerprintMatches(doc, languages, stored)` accepts the canonical fingerprint or the pre-F1
  `legacyContentFingerprint`, so a link published before F1 does not show "Update the published version" after a
  reload. The next publish stores the canonical form. A legacy hash stamped in a session whose keys were later
  reordered can still read "behind" once; republishing clears it ($0, cosmetic).
- **Release order.** Ship the v5 server and client together (a cached old client computes the pre-F1 page hash
  until it reloads), and cut over only when v5 replaces production: once v5 has re-stamped a doc, older v4 code
  reading the same row would show those pages as out of date (cosmetic, $0).

### Keys, routing, billing
- Keys from `req.apiKeys.providerKeys` (`openrouter`, `gemini`), already governed by
  `X-Allowed-Sources` + account BYOK. Prefer OpenRouter (platform key in prod), else
  Gemini direct. No key → a clear notice card ("Connect a Gemini or OpenRouter key").
- **No silent cross-model fallback.** A page renders on the model its tier resolves to;
  failures retry the same model (2 attempts, backoff on 429/5xx), then mark failed.
- **Billing per call**: `billing.ts` wraps `reserveForOperation/settleReservedOperation/
  releaseReservedOperation` with a per-call request clone (`Object.create(req)`) so
  parallel images never share `req.usageReservation`. Operations:
  `comic.image.{style|sheet|page|edit|cover}`, `comic.text.{director|writer|vision}`.
  Settle with provider-reported `usage.cost` when present. Release on every failure.
  Allowance/credit denials become an error notice card, never a silent stop.
- Every paid call also appends a `SpendEntry` (byok flagged) → the header chip and
  spend breakdown are always truthful, including BYOK.

## 5. Models

Registry: `shared/comic/models.ts`. Tiers:

| Tier | Pages | Sheets | Cover | Price/page (provider) |
|---|---|---|---|---|
| Draft | Nano Banana 2.1 @1K | 1K | NB 2.1 @1K | $0.034 |
| Standard (default) | Nano Banana 2.1 @2K | 2K | NB 2.1 @2K | $0.050 |
| Pro | Nano Banana Pro @2K | 2K | Pro @2K | $0.134 |

Style options always NB 2.1 @1K. Text roles (`server/src/comic/textModels.ts`, env
overridable): director `COMIC_DIRECTOR_MODEL` = `google/gemini-3.8-flash` (fallbacks
`anthropic/claude-sonnet-5.5`, `openai/gpt-6-luna`); writer `COMIC_WRITER_MODEL` =
`anthropic/claude-sonnet-5.5` (fallbacks `google/gemini-4-argon`, `google/gemini-3.8-flash`);
vision `COMIC_VISION_MODEL` = `google/gemini-3.8-flash`. Gemini-direct equivalents
strip the `google/` prefix. **The client's `X-Text-Model` is ignored** for these roles
(it is what put planning on free/coding models before).

Reference budget per page job (from `refs` caps):
- characters ≤ `refs.characters` (NB 2.1: 4, Pro: 5) — the page's lead/support cast
  ranked by panel appearances. Extras are described in words until they have a sheet; an on-page extra (not a
  prop) with a ready sheet or photo is attached within the character slots on every page it appears on. The cast
  card says "Described in text" / "Sheet ready · used on pages" ("Sheet ready" for a prop, whose sheet is never
  attached on a page; "Queued" / "Drawing sheet…" while a sheet the user asked for is being drawn), and the
  director's summary "text only" / "sheet ready". The Cast tab's extra note and its optional "Draw a sheet anyway"
  button say "a ready sheet (not a prop's) is attached on every page they appear on".
- style: Pro → board + up to 2 user style refs as style refs; others → board as an object ref.
- objects/places ≤ remaining `refs.objects`: place sheets used on the page, then the
  previous page (continuity) last.
- total ≤ `refs.total`.

Cost & model insights (v5, `components/comicstudio/insights/`): the Pages tab lists every drawn
image as a stacked row and switches to two columns at the named `medium` screen (600 px). The
spec said 480 px; the lead accepted 600 px (2026-10-29) because arbitrary `min-[…]:` screens do
not work in this Tailwind config and the ordered screen list (`tests/config/appShell.test.ts`)
has no 480 px step. Between 480 and 599 px the rows stay stacked, which never overflows.

### 5.1 Model lock, preflight and recording (v5)

One comic, one image model. The table above is what an **unlocked** comic draws with; once it is locked, a
tier only picks the resolution on the locked model.

- **Lock.** The server locks the comic (`doc.imageModel`, `origin: 'first_render'`) in the same op batch as the
  first comic image (sheet, place, page, cover or edit; style swatches do not lock). Legacy comics get the lock
  they were drawn with (`deriveLock`, persisted with the next image commit). Every job resolves through
  `resolveImageJob(kind, tier, override, lock)` and `jobs.ts` refuses, with no provider call, any job whose model
  is not the lock (`MODEL_LOCKED`, logged as `comic_model_lock_violation`). Jobs never switch models: not on a 429,
  an outage, a safety retry or a tier change.
- **Who can change it.** Only the user, through the picker's confirm (`change_image_model` with `ack`, the redraw
  scope and the quote they saw). The server re-checks pickable, plan access, transport, fit (4:5 on GPT Image is a
  block), no active run (409 `RUN_ACTIVE`), the redraw quote (outside 15 % + $0.01 → a requote, nothing switched)
  and the budget, then writes the lock and a `changes[]` entry and posts the switch notice with "Redraw them" and
  "Switch back" chips. Before the lock, `settings.imageModelOverride` is only a preference; after it, a settings
  patch that would change the model is refused (409 `MODEL_LOCKED`). The director has no tool that changes the
  model and cannot change the tier of a locked comic; it explains options with `model_options` (real prices,
  characters held, redraw cost) and offers the picker chip (`suggest_model`).
- **Preflight.** Before any spend reserves money, `preflightImageRun` (`server/src/comic/models/health.ts`)
  reads the process health port (OpenRouter's free public endpoint status, cached 3 min, plus our own outcomes).
  When the locked model is down on every route this account can use, nothing starts and nothing is charged: the
  action answers `blocked` and the conversation gets one `model_outage` card (origin `preflight`) with real
  alternatives. An upstream 429 mid-run ends with the same card and "Try again" / "See other models" chips; a model
  this comic can no longer use (access lost, retired, no transport) fails honestly with "See other models".
- **Prices.** Gates, reservations and the model change (`jobs.ts`, `actions/models.ts`) read the request's
  PriceBook (`ctx.prices`, built on the first quote and memoised per request): the live OpenRouter price, or our
  observed median when it is higher, plus QC, × the platform markup unless the user's own key pays. Chips on free
  actions wait up to 800 ms for it, else quote the registry list. `model_options` builds the same live PriceBook for
  its numbers. Gates re-quote before anything is reserved, so money stays safe.
- **Lock-aware quotes everywhere.** The shared quote helpers derive the lock from the doc themselves:
  `shared/comic/plan.ts` `quoteRenderPages`, `unitPrice` and `estimateDocJobs` price on `quoteLockOf(doc)` (the
  persisted `doc.imageModel`, else the legacy `deriveLock`), with the tier only picking the resolution, exactly as
  `jobs.ts resolveJobFor` draws. So a comic locked to Nano Banana Pro quotes Pro in the breakdown card and tool, the
  plan card, the Pages tab, the cast card, every next-step and "Try again" chip (`replies.ts estimateOf`), the $0
  intents (`intents.ts`) and the director's DOC SUMMARY, with no call-site change. A caller can pass `lock: null` to
  price a what-if on the unlocked tier model. `BookSummary.pricing.locked` is true when the comic is locked (or has
  an explicit override). Every other display quotes and names the locked model too: the board's draw and sheet
  prices and its "drawn with / will draw on" model names (`boardModel.ts`), the style panel's boards, the format
  panel's redraw quote and "≈ $X to draw all N on {model}" line (`unitPrice`, so it matches the breakdown card),
  the renders card's sheet, style and cover retries, the languages tab and the server's translated-edition overlay
  and textless-cover quotes (`i18n/index.ts`), all through `estimateDocJobs`. Reference slots follow the lock as
  well: the refs badges (`refsModel.ts`), the refs tool's sheet photos (`tools/refs.ts`), the writer's per-page
  cast limit (`writer.ts`) and the page check's estimate of an unsized page's shape (`vision.ts`) resolve the page
  or sheet model with `quoteLockOf(doc)`, as the prompt compiler does. Chip quotes outside a gate use the registry
  list; the gate's PriceBook re-quote is still the price that is reserved.
- **Recording.** Every image attempt, paid or failed, writes a SpendEntry and a fire-and-forget
  `comic_image_calls` row (route, provider, resolution, references, outcome, provider-reported cost and model
  version) and bumps `model_usage_monthly`. Recording never blocks or fails a job; until
  `server/sql/comic_image_calls_model_version.sql` is applied the row is written without `model_version`.
- **Model Lab** (Admin → Model Lab, `server/src/comic/models/lab.ts`): the owner's paid checks (D1–D4) run only on
  an explicit admin click, one provider call per click, under a hard $2 per UTC day cap reserved atomically in the
  database before the call. A call that reached the provider is also a `comic_image_calls` row.
- **Model Lab P1 · Pro pages A/B** (Ship 1, the `COMIC_LAYOUT_GUIDE` decision, PD-8): the owner's 3 golden pages
  (b4b5774f pages 2 and 4, f8312c86 page 1) are each drawn twice with everything else the same, layout guide off
  and on, and each drawing gets one page check (beats matched, panels drawn, art crossing a border). The pair is
  shown blind as A and B; the names appear after the vote, and a voted pair is final (its arms can't be drawn
  again). After the vote the owner marks, per side, whether the drawing copied the guide's lines. The beats tally
  and that guide-lines mark are the two inputs to the decision: turn `COMIC_LAYOUT_GUIDE` on only if the guide-on
  pages bind their beats better and never copy the guide's lines.
  - Off until the server switch `COMIC_LAB_AB_BUDGET_USD` is set; its value is the A/B's limit, never above the
    hard cap `LAB_AB_HARD_CAP_USD` ($1.20), shared across days and with part 2 (P2). Every run also counts against
    the $2 day cap.
  - A/B runs reserve only through `comic_model_lab_reserve_ab` (`server/sql/comic_model_lab_pro_pages.sql`, applied
    after `comic_model_lab.sql`; that file's check-id list includes P1/P2 and its `comic_model_lab_reserve` refuses
    them). The reservation leaves headroom for the unquoted reference cost: it reserves against
    `limit − images × LAB_AB_REF_ALLOWANCE_USD` ($0.004 per image).
  - Before the paid call the arm asserts the comic's model lock, withholds blocked, quarantined and not-yet-checked
    uploads (`shared/comic/sendable.ts`, the same helpers as the runner), and skips the page check when the drawing
    couldn't be stored. Runs and votes reuse the lab's endpoints and vote table (pair ids `p1-…`).
- **Tests never reach the network.** `tests/setup.ts` refuses any fetch to a real host and fails the test that tried.
  Server tests that build a real context install `__setModelHealthForTests(fakeModelHealth())` and pass registry
  prices (`testContext()` in `orchestrator.fakes.ts` does both).

## 6. Prompts (the craft)

All prompts are compiled server-side from the doc (`prompts.ts`, pure, unit-tested).
Principles: positive, concrete language; one source of truth per fact (no triple
repetition); every reference image labeled by index; short negative list only where it
matters; no blanket "no text" on pages lettered in-art.

### 6.1 Reference legend (all image jobs)
OpenRouter Images API takes `input_references` in order; Gemini direct interleaves a
text part before each image. Either way the prompt carries the legend:
```
REFERENCE IMAGES (in the order attached):
Image 1 — CHARACTER SHEET: MAYA. Match her face, hairstyle, body type, outfit and colors exactly.
Image 2 — CHARACTER SHEET: ARJUN. Match his face, beard, build, outfit and colors exactly.
Image 3 — LOCATION: SPICE MARKET. Match architecture, props and palette.
Image 4 — STYLE BOARD. Match its rendering style, line quality and color treatment (not its content).
Image 5 — PREVIOUS PAGE. Keep lighting, outfits and props continuous with it (not its layout).
```

### 6.2 Page
```
Create one finished comic book page as a single image: a {kind} page, {aspect} portrait,
{color sentence}. It must look like a professionally drawn and colored published page.

ART STYLE — apply identically in every panel:
{style.spec} {palette sentence} {linework sentence} Never: {avoid list}.

{reference legend}

CAST ON THIS PAGE — keep every identity distinct; never merge, swap or duplicate people:
- MAYA (Image 1): {look.summary}; {hair}; {outfit}; {marks}.
- ARJUN (Image 2): …
- VENDOR (no reference): {look.summary}   ← extras: described in words until they have a ready sheet

PAGE LAYOUT — {n} panels, read {left-to-right, top-to-bottom | right-to-left (manga)}:
{page.layout}
Clean white gutters between panels, crisp black panel borders, no panel overlaps unless stated.

PANELS:
Panel 1 — {size}, {shot}{, angle}. {place name}: {action}. Characters: MAYA (left), ARJUN (right). Mood: {mood}.
Panel 2 — …

LETTERING (overlay): Do not draw any text, letters, speech balloons, captions or sound
effects. Leave natural empty space near the top of each panel for balloons that will be
added later; keep faces and key action out of that space.
LETTERING (in_art): Letter the page like a professional comic: speech balloons as white
ovals with black borders and a tail pointing to the speaker; thought balloons as clouds;
captions as rectangular boxes; sound effects as bold display lettering integrated into the
art. Use a clean comic lettering font in UPPERCASE. Spell every line exactly as written:
  Panel 1 — MAYA (speech): "…"   CAPTION: "…"
No other text anywhere on the page.

Consistency: each character keeps the same face, hair, outfit and colors in every panel,
matching their reference sheet. Only the characters listed for a panel appear in it.
```

### 6.3 Character sheet (3:2 landscape)
```
Character model sheet for a comic, one image on a plain light-grey background, no text,
no labels: {NAME}. Left to right: full-body front view, full-body three-quarter view,
full-body side profile — same outfit in each. Bottom-right: three head close-ups
(neutral, smiling, angry). Even studio lighting, clean edges.
Identity: {age} {gender}, {build}. Face: {face}. Hair: {hair}. Eyes: {eyes}. Skin: {skin}.
Outfit: {outfit}. Colors: {palette}. Props: {props}. Distinguishing marks: {marks}.
Art style: {style.spec}
{legend: author's reference photos/drawings first ("match the face and features"), then style board}
```

### 6.4 Style option (4:5, NB 2.1 @1K)
A single key-moment illustration of *this* story in the candidate style:
```
Style test for a comic: one striking, cover-quality illustration of this moment:
{premise/logline-derived key moment}. Feature {lead look.summary} (no specific likeness
required). Rendered in this exact style: {option.spec}. No text, no letters, no logos.
```

### 6.5 Page edit
References: Image 1 = current page (clean), Image 2 = the same page with the area to
change outlined in red (only when a region is given), then the cast sheets involved.
```
Edit Image 1, a finished comic page. Change only this: {instruction}
{region: "The area to change is outlined in red in Image 2 (in panel {n})."}
Keep everything else exactly as it is: page layout, panel borders, every other panel,
characters' identities and outfits, lettering, colors and art style. Do not add a red
outline to the result. Output the full page at the same framing.
```

### 6.6 Cover
```
Comic book cover, {aspect} portrait, published-quality. Title lettering at the top:
"{TITLE}" in bold display lettering that fits the genre ({genre}); {tagline line}.
Hero image: {direction or key moment}, featuring {lead cast with Image refs}.
Art style: {style.spec}. Spell the title exactly; no other text except an optional small
issue number.
```

### 6.7 Writer (page-script planner) — system prompt essentials
"You are a veteran comics writer and editor…" Craft rules: every page ends on a
turn-hook; establishing shot when a scene changes; vary shot types (no more than 2
same-size shots in a row); 1 splash max per 6 pages; action is *visible* (no
inner-monologue in action fields); dialogue ≤ 25 words per balloon, ≤ 3 balloons per
panel, ≤ 210 words per page; captions only when they earn their place (time/place,
voice-over) — silent panels are good; respect the 180° rule within a scene; ≤ `refs.characters`
recurring named characters per page; speakers must be in the panel's cast; panels per
page from `format.panelsPerPage` (auto: 3–6 by pacing); layout string as a row
blueprint; obey brief notes and the user's script faithfully (do not invent major plot
beats when a script is provided; adapt, compress, never contradict).
Output: strict JSON schema `{pages:[{n, summary, layout, turnHook, panels:[{n,size,shot,
angle, action, castIds, placeId, mood, lines:[{kind, speakerId, text}]}]}], newCast?:
[{name, role, tier, look:{summary,…}}]}`. Validated server-side: unknown castIds dropped
(or mapped by name), speakers forced into cast, counts clamped, ids assigned.

### 6.8 Director — system prompt essentials
Persona: a warm, decisive comics editor + art director. Rules:
1. **Capture first.** Every concrete idea the user states goes into the doc via tools
   in the same turn (brief, notes, cast with full look fields, places, format, style).
   Never ask for something the user already said.
2. **One question at a time**, always with `ask_user` options (2–5 chips) so the user
   can tap; propose a sensible default rather than interrogate.
3. **Default forward motion**: idea → style → cast sheets → plan → render. Suggest the
   next step in `suggestions`.
4. **Plan before pixels**: never render pages without an approved plan unless the user
   explicitly asks to skip.
5. **Money**: spend tools return gate results; when gated, tell the user the estimate in
   one line. Never claim something rendered that didn't.
6. Brief replies (≤ 80 words) unless the user asks for depth. No markdown headings.
Each turn the model receives: compact doc summary (brief, format, style, cast with ids,
places, page plan headlines + render statuses, spend, open gate), `memory` (older
conversation summary) and the last 14 messages.

### 6.9 Vision QC + balloon layout (per rendered page)
Flash-class vision model, image + page spec → strict JSON:
`{panels:[{n, box:{x,y,w,h}}], issues:[...], textFound:[...], characterCountOk, balloons:
[{lineId, x, y, w, tailX, tailY}]}` — balloons placed inside their panel, near the
speaker's head, never covering faces/hands/key action, top-to-bottom in reading order.
Fallback (vision unavailable): even grid boxes from the layout + top-of-panel stacking.

### 6.10 Plan fit, the layout as drawn and honest page checks (v5, Ship 1)
"Better pages at the same price": one image call per page, fewer and larger panels, and words that fit them.
- **Panel rules and budgets** (`shared/comic/panelRules.ts`, `density.ts`): auto plans use about 3 panels (2–4; 5
  only for a fast, nearly silent sequence); storybooks set above 3 per page plan new pages with at most 3 and show
  a note (PD-2, `PLAN_POLICY.clampStorybook`; existing pages untouched). Each panel's lettering need is measured
  against its area: roomy ≤ 0.18, fits ≤ 0.22, tight ≤ 0.30, overfull above (kids: 0.25).
- **The layout as drawn.** The page prompt draws `effectiveLayout(page, format)`: the page's blueprint when it agrees
  with its panels (count, format, sizes), else the blueprint synthesized from the panel sizes. It lives in
  `shared/comic/pageGeometry.ts` with `harmonizePanelSizes` and `layoutConflicts` (one implementation; `prompts.ts`
  re-exports them under the same names, and `ops.ts layoutFixOps` uses them). The page-plan check
  (`pagePlanCheck.ts planBoxes`), the Render-all hold-back and its quote, the breakdown card's fit dots
  (`summarizeBook` planFit; `drawnPanelBoxes` for a drawn page without measured boxes) and the director's line-edit
  budget all measure that layout. So a stored page whose layout text contradicts its panel sizes is held back exactly
  when it would be drawn overfull, and never because of layout text the prompt does not draw. The prompt's own panel
  rectangles (`prompts.ts pageLayoutBoxes`) are `drawnLayoutBoxes` — one implementation — and when the page check
  can't use its reading (no usable reply, or another panel count) the estimate it stores as `panelBoxes`
  (`boxesFrom: 'estimate'`) and letters the fallback balloons on is made on `effectiveLayout` too (`vision.ts`).
- **The Render-all hold-back** (PD-1, `PLAN_POLICY.holdBackOverfull`; `server/src/comic/planCheckGate.ts`): applies
  only to "Render all" (`render_pages` with no explicit `pageIds` and no `force`). An overfull page that Render all
  would draw is left out of the run AND its quote; it is never refused. The notice ("Page 2 is held back: panel 3 has
  70 words in 22% of the page …") carries fix chips, free first:
  - "Use the layout that fits" — a free patch from `layoutFixOps`: the blueprint plus panel sizes that agree with
    it (a bare layout patch would be drawn as the old layout). Offered only when the page really fits once applied.
  - "Draw page N anyway (with the rest)" next to an open Render-all gate: that same Render all with the page added
    to `render_pages.drawOverfull`, quoted for the whole run, so it extends the open gate instead of replacing it.
  - "Draw page N anyway" after a run, or when nothing else is left to draw: that page alone (`pageIds: [id]`),
    quoted. Explicit page draws and forced new takes always pass through the gate unchanged.
  A spend retires an open `render_pages` gate only when it draws every page that gate would still draw (and its
  cover), so a single-page draw never silently drops the other pages' approval. The breakdown card shows held-back
  pages in red with the same free fixes and "Draw anyway" (`summarizeBook(…, { drawOverfull })` re-quotes).
- **Plan fit in the UI** (Ship 1 A5). Every wireframe panel carries a fit dot: green fits, amber tight, red too
  full, in the readable status tones (`--ds-success-text`, `--ds-warning-text`, `--ds-danger-text`, `FIT_DOT_COLOR`)
  and in different shapes (a filled dot, a ring, a diamond), and the tile and its detail row say it in words
  ("Fits (12 of 18 words)", "Tight — …", "Too full — 34 words, fits about 32"). A held-back page is a red tile, left
  out of the quote and the run. Its free fixes come first: the layout that fits (`layoutFixOps`), the page editor,
  then "Split the page…" / "Shorten it…", which only prefill the composer for the director. "Draw anyway" outside a
  gate is a toggle that adds the page to `drawOverfull` and re-quotes (`summarizeBook(…, { drawOverfull })`); next
  to an open Render-all gate it sends `render_pages { drawOverfull, includeCover?, safe? }`, quoted as a whole.
  The cost view never says "drawn and up to date" while pages are held back: "To draw now" reads "Nothing yet"
  with "N pages held back — too many words for a panel, not in this price. Fix free or draw anyway.", or adds
  "· N pages held back (not in this price)" after the quote lines. The Format panel offers Auto ("3–4 big panels", the beats decide within the
  kind's range) or a fixed 2–6, with the storybook note (`panelCountRule`).
- **Notice fix chips** (`NoticeCard`, rendered through `CardRenderer` with the studio controller): free chips come
  first; a paid chip shows its quote in the user's terms (a usage share for governed users, never dollars; "on
  your key" for BYOK) and needs a positive quote, else it isn't offered. Chips are re-checked against the live doc:
  a free fix already applied reads "Done", a paid one already drawing reads "Started", and a chip with nothing
  left to do (or a free edit that would put a drawn page out of date) is hidden.
- **Planning quote.** "Plan the pages" is one writer pass per page; the plan check can send it back for one repair
  round, so the chip and the director's DOC SUMMARY (when `planStatus` is `none`) say the honest bound:
  "≈ $0.09 for 6 pages (up to ≈ $0.19 if the plan needs its one writer repair)" — in usage words for governed users.
- **The honest page-check notice** (`server/src/comic/qcNotice.ts qcNoticeFor`, called from `jobs.ts letterPage`):
  after a page is checked, the chat speaks only for a major structured problem (the drawn panel count differs from
  the plan, the planned moments look reordered or missing, a speaker who should be visible may not be drawn) or a
  score below 0.75. The words hedge ("looks like", "may not be drawn") because beat accuracy is not yet measured;
  off-panel voices are never blamed; a page the safety check withheld gets no notice (its safety card speaks).
  Fix chips are free first; paid ones carry their quote and go through the spend gate. Badges and the page's
  quality list always show everything.
- **Letter fit: the coverage cap** (Ship 1 A4, FX2/F8; `shared/comic/lettering/layout.ts`, `place.ts`). A panel's
  lettering may cover at most `PANEL_LIMITS.coverCap` (0.30) of its picture, 0.25 for children's books
  (`coverCapFor`); coverage is fill × (outline ∩ panel) ÷ panel area, with fill π/4 for elliptical outlines and 1 for
  boxy ones (`outlineFill`, which `density.ts` uses too, so the chip, the plan check and the cap agree).
  - At render time `planLettering` applies it to stored, unpinned balloons: a panel over the cap is lettered again,
    its movable balloons re-placed (partly across the panel's border when that helps). Pinned and locked balloons
    never move. Stored values never change; "Re-letter page" (free) saves the re-placement.
  - The cap re-places only: it never shrinks text unless the owner flips `LETTER_FIT_POLICY.coverShrink` (off; a
    one-line edit), and even then never below 82% (`COVER_STEPS` 1, 0.9, 0.82), panel by panel.
  - A panel still over the cap is flagged `dense` (words, what it holds, coverage before and as drawn). Balloons
    the cap drew elsewhere are crowded with reason `'cover'`, so a first drag, nudge, "Keep here" or Lock starts
    from where the balloon is drawn (`drawnSpotPatch`, in `styleOps.ts`; `lockOps` pins the drawn spot too) and
    never jumps back to its stored spot.
  - No balloon is left over another balloon's text while the page has a text-free spot for it; the settle
    fallback keeps a stored balloon within its own tier and panel, never carried panels away.
  - A pinned balloon stored narrower than its longest word is drawn as wide as that word within its panel (FX6).
  - Every placement that is SAVED uses the doc's cap and fills (`placementCoverOptions`): the page check's
    balloons, its fallback and the free re-layout (`vision.ts`), Tidy and Reset position (`styleOps.ts`) and the
    director's `arrange_balloons` (`tools/lettering.ts`). The board's and lettering hooks' own unsaved placements
    stay uncapped: the render-time cap is what is drawn.
  - Two editor chips: "Too much text for panel 6" / "Too much text in N panels" selects the panel, and the
    inspector says how much it holds ("Too much text for panel N: W words cover about P% of the picture — it holds
    about M.") with the free fixes; "Fix balloon placement" (drawn pages whose check has no face data)
    offers the free placement around the art's busy areas first, then the paid face-aware re-check
    (`recheck_page`) quoted in the user's terms. A face-aware check stores its `keepOut`/`heads` even when it
    found no faces, so a page re-checked once is not offered the paid re-check again (`busyGrid.ts hasFaceData`).
  - The board's page script shows each lettered panel's "N words / fits about M" (pagePlanCheck on the panels the
    words are lettered into), with "too full" said in words on an overfull panel.
- **Flags, both off.** `COMIC_LAYOUT_GUIDE` attaches a text-free layout-guide image (`panelize/wireframe.ts`) as
  Image 1 on page renders; it stays unset until the owner approves the paid Model Lab A/B (PD-8). With it off, page
  references and quotes are unchanged. `COMIC_IDENTITY_NOTICES` (identity findings in the chat notice) stays unset
  until Ship 2.

## 7. Client modules (`components/comicstudio/`)
`ComicStudio.tsx` (shell), `useStudio.ts` (state + stream), `studioApi.ts`,
`conversation/*` (pane, message, composer with voice + option panels, cards),
`board/*` (Story, Cast, Style, Pages, Read, PageEditor with Mark-up + balloon editing,
BalloonLayer), `export/*` (print view, PNG ZIP). Design: calm-studio glass tokens
(`components/chat/studioDesign.ts`, `--ds-*`). The comic *content* (pages, balloons)
uses comic lettering (`font-comic`); chrome never does.

## 8. Legacy & rollout
- Dashboard "New comic" creates a v4 project. Existing projects open the classic
  editor with a banner: **"Open in the new studio"** → `POST /projects {importFromProjectId}`
  copies script, title, characters (look from structured details), style prompt.
- Public reading of v4 comics: `ComicReader` delegates to the v4 reader when
  `state.studioVersion === 4` (data from `/api/comic/public/:id`).

## 9. Quality bar & verification
- Unit tests: ops/applyOps, normalizeDoc, registry resolution + estimates, prompt
  compilers (reference caps, labels, lettering modes), writer validation, gate logic,
  balloon fallback, billing wrapper, store, route auth.
- Golden script set (`server/src/comic/golden/*.json`) + `npm run comic:golden` to
  render a real 2-page comic per script on a chosen tier with a live key (manual, costs
  ≈ $0.50 on Standard). Compare tiers before changing defaults.
