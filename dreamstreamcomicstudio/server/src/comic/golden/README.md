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
