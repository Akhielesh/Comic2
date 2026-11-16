# Comic Studio golden scripts

A small, fixed set of comic scripts used to judge **real output quality** before changing
prompts (`prompts.ts`), planning (`writer.ts`), QC/balloons (`vision.ts`), models or tier
defaults (`shared/comic/models.ts`). Unit tests prove the prompts are well-formed; only a
real render shows whether the comic is any good. Run the goldens before and after a change
and compare the pages side by side.

| Script | Tests | Tier |
|---|---|---|
| `single-lead.json` — *The Last Lamp* | one lead across every panel, atmosphere, silent beats, an insert shot | Standard |
| `dialogue-trio.json` — *Mother's Book* | three distinct people at one table, dialogue-heavy, 180° rule, balloon placement | Standard |
| `action-chase.json` — *Rooftop Run* | two characters in motion, screen direction, scene change, SFX | Standard |
| `kids-storybook.json` — *Pip and the Night Lantern* | storybook kind, kids audience, landscape 4:3, narration captions | Draft |
| `manga-rtl.json` — *Last Match* | manga, right-to-left reading, black & white, **in-art lettering on Pro** | Pro |

Each file is `{ title, script, format, quality, style?, checks[] }`: `format` is a partial
`Format` (`shared/comic/doc.ts`), `quality` the tier, `style` an optional preset id from
`shared/comic/stylePresets.ts` (fixed so runs stay comparable), and `checks` what a
reviewer should look for by eye.

## Running

The runner goes through the same code path as the studio — source analysis → page plan →
style board → character and place sheets → page renders with labeled references (page 1
first, then each page with its predecessor as the continuity reference) → vision QC and
balloon layout — but calls the providers directly with **your own key** (nothing is billed
to DreamStream and no database is touched).

```bash
# Show what would run and the estimated cost — spends nothing:
npx tsx server/src/comic/golden/run.ts

# Render one script on its own tier (≈ $0.45 on Standard):
OPENROUTER_API_KEY=sk-or-… npx tsx server/src/comic/golden/run.ts --script single-lead --yes

# Compare tiers on the same script:
npx tsx server/src/comic/golden/run.ts --script dialogue-trio --tier draft --yes
npx tsx server/src/comic/golden/run.ts --script dialogue-trio --tier pro --yes

# Plan + compiled prompts only (text models only, a few cents):
npx tsx server/src/comic/golden/run.ts --plan-only --yes
```

Options: `--script a,b` (default: all), `--tier draft|standard|pro` (default: each script's
own), `--out <dir>` (default: `<tmp>/comic-golden/<timestamp>`), `--plan-only`,
`--no-places` (skip location sheets), `--yes` (required to spend anything). Keys come from
`OPENROUTER_API_KEY` (preferred; same routing as production) and/or `GEMINI_API_KEY`
(`GOOGLE_API_KEY` also works). Text roles use the server defaults from `textModels.ts`
(`COMIC_WRITER_MODEL`, `COMIC_VISION_MODEL` env overrides apply).

Cost (provider prices, 2 pages): ≈ $0.34 Draft, ≈ $0.45 Standard, ≈ $1.04 Pro per script —
1 style board + up to 5 character sheets + up to 2 location sheets + the pages + QC + text.
All five scripts on their own tiers ≈ $2.70.

## Output

One folder per script and tier (`<out>/<script>-<tier>/`):

- `index.html` — open this. Style board, sheets, every page with the overlay balloons drawn
  where the vision pass placed them, QC score and issues, the page script, and a spend table.
- `page-1.png`, `sheet-*.png`, `place-*.png`, `style-board.png` — the raw images.
- `prompts.md` — every compiled prompt with its ordered, labeled references (check that the
  legend matches what was attached and that nothing leaked into the lettering).
- `doc.json` — the full ComicDoc as planned and rendered; `report.json` — spend ledger.

A failed step (safety block, rate limit, timeout) is reported with its studio error code;
the run moves on to the next script and exits non-zero at the end.

## What "good" looks like

Go through each script's `checks` list, then the general bar:

1. **Identity** — every named character matches their sheet on both pages; nobody merges,
   swaps or duplicates; extras stay generic.
2. **Page craft** — the panel layout matches the plan's blueprint, reading order is obvious
   (right-to-left for the manga), gutters are clean, the page ends on its hook.
3. **Lettering** — overlay pages carry no drawn text and leave space for balloons; balloons
   sit near the right speaker in reading order without covering faces. In-art pages (Pro)
   spell every line exactly — the QC issues list any misspelled or missing line.
4. **Continuity** — page 2 keeps page 1's lighting, outfits and props.
5. **Style** — every image (sheets included) reads as the same art style as the board.

Compare tiers before changing defaults, and keep the folders of the last accepted run so a
prompt change can be judged against it. `golden.test.ts` keeps these files valid in CI
(no network); it does not render anything.

## Director scenarios (`scenarios/*.json`, $0, run in CI)

The render goldens above judge pictures. The **director** golden set judges the conversation and
the tool surface, with scripted model replies and fake images — no network, nothing spent:

| Scenario | What it locks in |
|---|---|
| `lake-kids.json` | The owner's real session: "a baby near a lake with other animals, a kids comic, single page". The first reply is never empty and opens with the recap ("Got it — a 1-page storybook for kids 2–6 … The Baby with three Ducklings, a Frog and a Bunny"); the animals are first-class cast (`kind`, `count`); "generate all pages" on the drawn page answers for $0 with next steps. |
| `shinchan-homage.json` | Named IP becomes an original homage (decisions-final #5): an `IP NOTE` steers the model, the reply says so once, `doc.safety.ipNoted` stops repeats. |
| `generate-all-drawn.json` | The re-render bug: page numbers never redraw a drawn, current page (`nothing`, $0, breakdown + chips); a real "another take" is a `redraw` gate. |

`scenarios.test.ts` replays them through `runDirectorTurn` and also measures the tool surface:
every tool a golden turn needs must be offered (tool-choice accuracy stays 100 %), and the median
prompt (system prompt + doc summary + core tool specs) may grow at most 15 % over the wave-0
baseline (18,413 chars on commit `d785cac`). Other packages add their own scenario files here
(for example `kids-telugu.json`); fixtures for the docs live in `fixtures.ts`.

## The Ramayana golden case (`ramayana.golden.test.ts`, $0, run in CI)

The render goldens above are synthetic. This one is the owner's own comic: the Ramayana book "Brick Legends: Rama
Setu" (10 pages, 20 panels), kept as **text only** in `../__fixtures__/ramayana-setu.doc.json` with the owner's consent. It is the quality test every prompt, writer, run-order and page-check change must pass.

- **What the fixture keeps:** the brief (and the two messages that asked for it, in tidied words: nothing a person
  typed is kept word for word), format, style words and palette, the
  cast cards (names, looks, colours, roles), the place, every page's panels, actions, lines, layout sentence, summary
  and turn hook, the plan status, and one edit note on page 9 (also in tidied words). Every id is rewritten (`rama-setu` for the comic, readable ids such as
  `c_rama`, `pg_03`, `pn_03_1` for the rest) and every time is one constant.
- **What it never holds:** user, owner or project ids, names or emails of people, any asset path, link, storage key
  or image, model, version or job ids, chat other than the brief, usage or cost rows, share links.
  `promptChecks.ts` `privacyLeaks()` fails the golden if any of that comes back: no `@`, link, storage path or image
  file of any kind, no uuid, no hex run of 8 or more (including the original's `pg_` + hex ids), no ISO date, no epoch
  time but the one constant, no mixed letter-and-digit token, and no id outside the allowed spellings (`rama-setu`,
  `c_<name>`, `pg_NN`, `pn_NN_N`, `ln_NN_N_N`, `pl_NN`, `msg_brief_N`); only the allowed top-level fields. The guard is
  proved on every run: each kind of leak is put into the fixture one at a time and must be caught. The plan hash is a
  placeholder (`rama-setu-plan`), so no value of the original doc carries over.
- **How it compiles like the real thing:** `promptChecks.ts` `loadRamayanaCase()` gives every render that was drawn a
  synthetic in-memory image, so the compiler attaches the same references and writes the same `(Image n — …)`
  anchors as on the day. Compiled with this tree, the fixture's 10 page prompts, cover, cast sheet and page-9 edit are
  byte-identical to the original comic's (checked once, out of the repository, when the fixture was made).
- **`../__fixtures__/ramayana-setu.expected.json`:** what the case measured on the day (17 "serene calm smile" hits in
  6 page prompts, "coral and teal", the cover cast, the run order, the collapsed heads), the page each page really
  continued from, the page-check reply shapes, and a numbers-only colour baseline of the drawn pages. The replies are
  **rebuilt, not captured** (`replyShapesNote`): page 3 is a good page's stored marks; pages 4 and 9 are one guess that
  reproduces the stored marks exactly (heads as fractions plus one 0–1000 face box on a panel the page does not have,
  which sets the scale and is then dropped, so keepOut stays `[]` as stored) and carry the text the check really read
  (`राम`; `RAM`, `RAM`: Rama's name on the bridge stones).
- **Two kinds of test.** "Today" tests pin those measurements. `it.fails` tests state what a correct Ramayana page
  needs (no expression inside an identity anchor; saffron and royal blue; Lakshmana on the cover; page 3 after page 2;
  heads that keep their own scale while a good page keeps its own; Rama's name on the stones read as an inscription,
  not stray text; an edit note understood before it is drawn). The package that fixes a fault turns its `it.fails`
  into `it` and keeps the "today" pin for its flag off, so flags-off prompts stay byte-identical.
- **A third kind: must stay true after every fix.** Each panel's mood, every sentence of its action (where the left and
  right positions live), its shot and its angle reach that panel's block of the page prompt outside the anchors
  (`panelDirectionMisses`), on every entry of `CASE_COMPILE_VARIANTS`; a package with a compiler flag adds its flag-on
  variant there. Page 3's two Hanuman heads survive the page check. So a fix can never pass by deleting the feeling
  words from the whole prompt, or by dropping every head; the golden proves the first by trying it.
- **Not pinned yet, on purpose:** whether a page with no place (pages 3, 8, 9, 10) continues the scene before it is
  still open, so the "page 3 after page 2" fault is not flipped yet; the canon check (Nila is not Nala, Varuna is not Sagara)
  belongs to a later wave; the case has no glossary (i18n is stripped), so a test that needs Rama → राम adds that one
  entry to its in-memory doc.
- **Helpers** for later packages: `mustContain`, `mustNotContain`, `insideAnchors`, `outsideAnchors`, `panelBlocks`,
  `panelDirectionMisses`, `whoLines`, `expressionWordsInAnchors`, `countOf`, `compileCasePages`, `compileCaseCover`,
  `compileCaseEdit`, `privacyLeaks`.

**Never put the case (or any `.json`) in this folder:** `golden.test.ts` allows 3 to 5 render scripts here and `run.ts`
(the paid renderer) renders every `.json` it finds. The golden test checks that no script here mentions the case.

The Program 5 server flags are read by `../p5Flags.ts` (`COMIC_STORY_FIXES`, `COMIC_RUN_CHAINS`, `COMIC_QC_V2`; each
off | admins | all). Scene chains now default to all authors on models with spare object-reference capacity;
`COMIC_RUN_CHAINS=off` restores paired scheduling, and `admins` limits the rollout. Story fixes and QC v2 still
default off; an unrecognized explicit value is off.

Scene chaining changes dependency order, not the render quote or image-call count. Pages in the same scene wait
for their predecessor's stored artwork and safety result; independent scenes may proceed in parallel. Existing
per-provider deadlines, cancellation and retry limits still apply. A failed predecessor settles its dependency;
unstarted pages stop on cancellation. Legacy models with only one object-reference slot retain their original
schedule and cast/style reference capacity. Long single-scene books therefore take longer to finish.

Offline tests verify predecessor references, original sheet/style attachment, exact call counts, rollback,
limited-model behavior, cancellation, failed dependencies and provider deadlines. They do not establish the
visual quality or color stability of a newly rendered full book; that still needs review on a reversible copy.
Never regenerate or replace original production artwork as a test.
