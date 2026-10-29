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
  ranked by panel appearances; extras are text-locked only.
- style: Pro → board + up to 2 user style refs as style refs; others → board as an object ref.
- objects/places ≤ remaining `refs.objects`: place sheets used on the page, then the
  previous page (continuity) last.
- total ≤ `refs.total`.

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
- VENDOR (no reference): {look.summary}   ← extras: text lock only

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
