# Clean and smooth: the rubric, the probe and the refinement loop

The owner's ask: *"keep it clean, smooth, reduce clutter, check redundant design elements, keep refining."*
This page is how we do that on purpose, every wave, instead of by taste once in a while.

- **The rubric** (§2): ten checks a screen must pass. Six are measured by a probe; four need a reviewer's eyes.
- **The instruments** (§3): a DOM probe with a ratchet baseline, a static pulse guard, and a screenshot sheet.
- **The loop** (§4): what the slot's integration owner runs after each wave merges, about half a day.
- **The ratchets** (§5): numbers only ever fall. A rise fails; a fall fails until the baseline is lowered.

Package DC-0 (Program 3, wave S2) built these. The design system rules still apply first: tokens, then recipes,
then primitives (`docs/design/design-system.md`, `docs/design/atlas-skin.md`). This page is about how much of
them a view shows at once.

## 1. Why

In November 2026 an audit of the studio found that it says most things two to five times. Examples:

- **Read** is offered four ways on one 1280 px screen.
- The image model is named four times.
- Two filled primary buttons start the same spend with three different counts.
- One card says the same sentence twice.
- The usage phrase appears 33 times in one document.

Each feature added its own entry point, count and price tag, and nothing removed the older one. No plan had a rule
or a test against that. This page is the rule, and the tests below enforce it.

## 2. The rubric (ten checks)

| # | Check | Pass when | Measured by |
| --- | --- | --- | --- |
| C1 | **One primary per view** | At most one enabled, accent-filled control in the viewport. A modal's primary replaces the page's. | Probe `primaries` (target 1) |
| C2 | **One home per action** | No action is reachable from two visible controls in the same viewport (Read, Share, History, Media, Quality, Easy/Pro). | Probe `duplicateActions` on `data-action` (target 0), plus review |
| C3 | **No box in a box** | Bordered rounded surfaces nest at most one level (depth ≤ 2). Inner sections use a divider or a well fill. | Probe `maxBoxDepth` (target 2), `nestedBoxes` (ratchet) |
| C4 | **One number, one definition** | A count appears once per view, with the same definition and unit everywhere. | Review, plus unit tests on the shared helper |
| C5 | **Say it once** | No sentence or meaning twice in one card. A price once per spend action. "Free" only beside something that costs. | Probe `usagePhrases`, `freeWords` (ratchet), plus review |
| C6 | **Labels fit** | No control label is truncated at 320, 360 or 1280 px. User content, such as a comic's title, may truncate. | Probe `truncatedLabels` (target 0) at 320 (light), 360 and 1280 |
| C7 | **Past is small** | What the conversation moved past is one line. Repeated images collapse. | Probe `transcriptScreens` (ratchet), plus the settled-card tests |
| C8 | **Chrome budget** | On a phone, chrome is at most 25 % of the viewport height in studio and reader scenes. | Probe `chromeShare` (target 25) |
| C9 | **Calm motion** | One live pulse per view. Every animation stops under reduced motion. Nothing moves the user (no auto tab switch, no scroll yank). | Probe `livePulses` (target 1, motion on), plus the pulse guard |
| C10 | **Same role, same control** | One button family per role (header actions, card actions, chips). Status shows as text or a chip, never as a button. | Review against the DS primitives; DS-0's guards cover the class side |

A **core screen** is the studio, My comics, the Library or a reader. A C1 or C6 failure on a core screen blocks the
production PR (PROGRAM3 §3.9).

### Building to the rubric

- **One primary.** A view gets one `Button` with the default variant, or one `create` once the colour layer
  lands. Everything else is `secondary`, `outline` or `ghost`. When a gate's Approve is on screen, the draw button
  beside it goes away.
- **Dividers and wells, not boxes.** Inside a `SECTION_CARD`, separate parts with a hairline (`border-t`) or a
  `--ds-well` fill. Never use another bordered card. The probe counts a box as all four borders plus a radius of
  6 px or more.
- **Name an action once.** When one action has more than one control, give each the same `data-action` id. This
  is how the probe finds duplicates; the rubric expects exactly one visible per viewport. The ids are `read`,
  `share`, `history`, `media`, `quality` and `mode` (Easy/Pro). Add new ids in kebab case. Where they are now (DC-1
  and the S2b integration):
  - `read`: the header Read (only while the board is out of sight), the Read tab's "Read full screen", the reader's
    full-screen entry and its browser full-screen button (`reader/ComicReaderView.tsx`), and the ⋯ "Read the comic"
    row on phones;
  - `quality`: the header chip below 1024, the composer chip from 1024 (`conversation/StudioComposer.tsx`, which
    reads "{Tier} · {Model}" with the lock glyph; lead decision D10), and the ⋯ Quality row wherever the header has
    no chip;
  - `media`: the board's Assets tab (`board/BoardPane.tsx`) and the timeline's Assets link, which hides while that
    tab is on screen;
  - `share`: the Read tab's "Share & export";
  - `history`: the ⋯ History row on narrow headers;
  - `mode`: both forms of the Easy | Pro switch (`mobile/ModeToggle.tsx`).
  Pending (lead decision D20): `share` on the header Share (`share/ShareButton.tsx`, DC-1 #6) and `history` on the
  header History icon and the timeline History link (`history/HistoryButton.tsx`, `history/EntryLinks.tsx`, DC-1 #7).
  Each would make its desk scene read duplicateActions 1 (studio-read and studio-history), and baselines only go
  down, so they wait until DC-3 / DS-R5 / DS-R12 remove the duplicate entries (the Read tab's button becomes
  "Export"; never two History entries in one viewport). The board's History tab gets its id only with #7. A ⋯ row's
  id counts only while the menu is open.
- **Announce a transient toast politely, once, in the one slot.** A transient toast is an app toast
  (`toast()` in `components/ds/Toast.tsx`, DS-1c): it takes the one slot, so it never stacks with the timeline's
  Undo toast or another app toast, and the host's always-mounted polite status region announces it (a region
  inserted already holding its words is often not announced). The header's savings slot (`mobile/SavingsChip.tsx`)
  does this since the S2b integration; it used to portal a private pill with its own hidden live region.
- **Mark user content.** Put `data-user-content` on text the user wrote or named, such as a title or a character
  name. It may truncate; a control's own label may not. No control carries the attribute yet, so today every cut
  label counts. The first candidates are the character name on the cast card's button
  (`conversation/cards/CastCard.tsx:104`) and a saved style's name on its pick button
  (`library/StylePresetsCard.tsx:109`). The studio title is an `<input>`, which the probe does not treat as a label.
- **One live state.** A live state uses `LiveDot` (`components/ds`), or a static label such as "Drawing…". A raw
  `animate-pulse` / `ping` / `bounce` needs `motion-safe:` or `motion-reduce:animate-none` in the same class list,
  and the pulse guard counts it either way (§3.2).
- **Price once.** Use the spend action's own label ("Draw 6 pages · ≈2%"). Do not add a second price chip or a
  second usage sentence beside it. Governed users still never see `$` or `¢` (`shared/comic/costText.ts`).
- **"Free" only beside something that costs (C5).** Free editing and navigation carry no lowercase "free" either:
  not in a toast ("Title page added — made by software"), a dialog title (the plate dialog is just its name), a menu
  hint ("Look back and restore") or the Reader look. The add tiles on the timeline say nothing about price.

## 3. The instruments

### 3.1 The clutter probe and the ratchet (C1, C2, C3, C5, C6, C7, C8, C9)

| File | What it is |
| --- | --- |
| `tests/e2e/helpers/clutterProbe.ts` | The in-page probe (`probeClutter`), the scene list (`DECLUTTER_SCENES`), the targets (`CLUTTER_TARGETS`) and the ratchet's pure rules |
| `tests/e2e/declutter.spec.ts` | Playwright: the probe self-test (`@selftest`) and every scene against the baseline (`@declutter`) |
| `tests/e2e/baselines/declutter.json` | The ratchet baseline: one generated line per `scene@view-theme` |

What each metric counts, per scene:

| Metric | Counts | Notes |
| --- | --- | --- |
| `primaries` | Visible, enabled controls in the viewport whose background is a primary token (`--ds-accent`, `--ds-accent-fill`, the colour layer's `--ds-spark`) | Resolved at the control, so a scoped skin is honoured. A selected tab or pressed segment (`aria-selected`/`-pressed`/`-checked`/`-current`) is state, not an action. A primary drawn without these tokens is missed, so use the primitives. |
| `duplicateActions` | Extra visible copies of each `data-action` id in the viewport | 0 everywhere until the ids exist (DC-1). The report also lists control names grouped by their first two words. That is a review aid for C2, not a count: "Change ×5" is five different "Change the …" buttons. |
| `nestedBoxes`, `maxBoxDepth` | Bordered (all four sides), rounded (≥ 6 px) surfaces in the viewport inside another one, and the deepest stack | Controls, SVG, comic pages, balloons and `[data-user-content]` are never boxes. |
| `truncatedLabels` | Controls in the viewport whose own label text is cut (ellipsis, line clamp, hidden overflow on the control or a box inside it) | Screen-reader-only text and user content are skipped. |
| `chromeShare` | Phones, studio and reader scenes: the % of the viewport height that is not the content region | The content region is the scene's selector, else the tallest scroller, else `<main>`. Fixed and sticky bars over it count as chrome. |
| `livePulses` | Elements in the viewport with an infinite animation running, spinners included | Measured with motion **on** and `still=0`, after entrances settle. The DS-1b smoke covers the reduced-motion half for app scenes. |
| `hOverflow` | Pixels of horizontal page overflow | Measured at 320 px as well, where the house rule is no overflow. |
| `usagePhrases`, `freeWords` | "a little of your usage" and the word "Free" in the whole document | Counted over the whole document because the transcript scrolls. |
| `transcriptScreens` | The Director transcript's height, in screens of its own scroller | The `heist-12p` fixture is the ratchet. |

The scenes are the DS-1b studio scenes (QA harness, `qa/comic-qa.html`, synthetic fixtures), plus the extra scenes
the rubric needs:

- the studio with an open render gate, streaming, busy, empty, and on each board tab;
- History on;
- the board pane alone;
- the editor in Easy and Pro;
- the immersive and public readers;
- the breakdown, timeline and model-picker kits;
- every `qa/app/scenes` page, discovered at runtime as `app-<id>`.

Each scene runs at **360×740 and 1280×800, light and dark**, with the page-level Atlas skin. It also runs at
**320×640, light only** (the `narrow` view, the DS-1b `smoke-320x640` device). That run ratchets just two metrics,
`truncatedLabels` and `hOverflow`: a label that fits at 360 can still be cut at 320, and the house rule is no overflow
at 320. Its baseline entries hold only those two. Library, Settings and Chat need auth, so they join when an
authenticated harness scene exists (DS-R6, DS-4).

The report, `<QA_ARTIFACTS>/declutter/clutter-report.json`, holds one run per view and theme:

- each run replaces all of its own entries, so a scene that was removed, or failed this time, never keeps an older
  run's numbers;
- a scene that could not be measured is written with its `error` and no counts;
- `runs` records when each view and theme was last measured.

The self-test seeds every kind of clutter on synthetic pages. On the fixture page, the probe must report exactly
two primaries, one depth-3 box and one clipped label, and nothing else. A clean page must report nothing. Dropping
any counter turns the self-test red; the mutation proof is in DC-0's return value.

### 3.2 The pulse guard (C9, static)

`tests/config/pulseGuard.test.ts` reads the whole app (`components/**`, `App.tsx`, `qa/**`; not
`components/ds/**`, where `LiveDot` lives). It counts per file:

- every raw `animate-pulse`, `animate-ping` and `animate-bounce` class (any variant prefix, `!` included);
- as `unguarded`, each one whose class list has neither `motion-safe:` on the pulse nor `motion-reduce:animate-none`.
  The class list is one literal, one template, one `cn(…)`/`cx(…)` call or one JSX `{…}`.

`animate-spin` is exempt: a spinner inside a busy control is that control's state. The runtime probe still counts
anything that spins on screen.

It ratchets against `tests/config/baselines/pulse.json`, the same way DS-0's guards do (`tests/config/baselines/README.md`):

- a new raw pulse fails;
- a new unguarded one fails twice (the pulse and its missing stop);
- a removed one fails until the entry is lowered.

The baseline was generated from the tree. Comic Studio holds 11 raw pulses in 10 files.

The guard's strict "never" rule fails today at exactly two lines: the board status chip, `components/comicstudio/board/ui.tsx:421`
and `:537`. DC-3 makes that chip static, and then the entry is lowered.

### 3.3 The screenshot sheet

`scripts/design/declutter-shots.mjs` shoots the same scenes still (`still=1`, reduced motion), so two waves compare
pixel for pixel. It writes, under `<QA_ARTIFACTS>/declutter/<wave>/`:

- `<scene>@<view>-<theme>.png`;
- the Director transcript, screen by screen (`transcript/<view>-<theme>-NN.png`);
- `index.json`;
- `index.html`, a review sheet.

The sheet sets each shot beside the previous wave's. It shows the ratchet's numbers and the labels behind them, and
it lists the four checks that need eyes. It uses no network and no script, so it opens from disk or as a CI
artifact. Shots are never committed.

```sh
node scripts/design/declutter-shots.mjs --wave s2 --previous <QA_ARTIFACTS>/declutter/s1
# --no-build | --dist <built QA folder>   reuse a QA build
# --only studio-chat,app-recipes,transcript
#                                         scene ids, app-<id> and transcript; an unknown value stops the run
# --view phone|desk|narrow                default: phone and desk (narrow, 320 px light, only when named)
# --theme light|dark
# --frames 30                             transcript screens per view (default 30)
```

A scene the ratchet could not measure shows its error on the sheet, never an older run's numbers. The sheet also says
when each view and theme was last measured.

It builds the QA entry into `<QA_ARTIFACTS>/declutter/dist-qa`, so the layout smoke's own bundle is untouched. It
serves the build with `vite preview` on `QA_PORT` (default 4182) and refuses every request that is not
same-origin. It uses Chromium by the harness's rule (`QA_CHROMIUM_PATH`, then `PLAYWRIGHT_BROWSERS_PATH`) and
never downloads a browser. It needs Node ≥ 22.18 (it imports the probe's TypeScript), or
`npx tsx scripts/design/declutter-shots.mjs`. It exits 1 only when a scene does not open: failing on clutter is
the ratchet's job.

## 4. The refinement loop (every wave)

**Who:** the slot's integration owner, after the wave's packages merge and before the PR to production. A reviewer
agent does step 3. About half a day in all.

1. **Measure.** Build the QA entry once, then run the ratchet:
   ```sh
   npm run qa:build                     # dist-qa/ (the layout smoke's build works too)
   npx playwright test -c tests/e2e/playwright.config.ts --project=declutter
   ```
   It writes `<QA_ARTIFACTS>/declutter/clutter-report.json`: every number, plus the labels behind it (which
   controls are the primaries, which labels are cut, which boxes nest, what pulses). The full run takes about 3½
   minutes on two workers.
2. **Shoot.** Run `node scripts/design/declutter-shots.mjs --dist dist-qa --wave <slot> --previous <last wave's folder>`.
   It reads the report from step 1.
3. **Review (about 30 minutes).** Read the sheet against the rubric, next to the previous wave's set. C2, C4, C5
   and C10 need eyes. List each finding as:

   > **screen · element · file:line · check · before → after**

   For example: *studio @1280 · header Read button · `ComicStudio.tsx:500` · C2 · Read ×4 → the Read tab only*.
4. **File.** Send findings to the next wave as wave notes to the file's owner in that slot (the hot-file tables
   in the master plan and PROGRAM3 §3.6). Nothing is fixed outside ownership.
5. **Ratchet.** Lower the baselines (§5). Only the integration owner does this, so two packages never edit one
   baseline in the same slot.

A C1 or C6 failure on a core screen blocks the production PR. Everything else is a finding for the next wave.

## 5. The ratchets: rules and how to lower a baseline

**The rules** are the same for `declutter.json` and `pulse.json`:

- A **listed** entry may neither rise nor fall.
  - **Above** fails: clutter came back. The message names the check, for example `C1: one primary per view`.
  - **Below** fails until the entry is lowered, so the gain is kept.
- A scene (or file) the baseline does **not** list must meet the rubric targets: primaries ≤ 1, duplicate actions 0,
  depth ≤ 2, truncated labels 0, phone chrome ≤ 25 %, live pulses ≤ 1, no overflow. A **new screen is clean from
  its first commit**. Nested-box counts, the C5 phrases and transcript length have no absolute target; they only
  ratchet once a scene is listed.
- An entry whose scene no longer exists fails until it is dropped.
- A key must name a view and theme the loop measures (`phone-light`, `phone-dark`, `desk-light`, `desk-dark`,
  `narrow-light`), and an entry may list only the metrics its view ratchets.
- Both files are **generated, never typed.** A hand edit fails the file check, and so does a `declutter.json` whose
  `targets` line no longer matches the probe's targets.

**A package that improves a scene** does not commit the baseline. It writes the new numbers in its wave note: the
scene key, then the counts from `clutter-report.json`.

**The integration owner then lowers the baselines once, after the merge:**

```sh
UPDATE_BASELINES=1 npx playwright test -c tests/e2e/playwright.config.ts --project=declutter   # declutter.json
UPDATE_BASELINES=1 npx vitest run tests/config/pulseGuard.test.ts                              # pulse.json
```

`UPDATE_BASELINES=1` **only lowers.** It takes each metric down to the measurement where that is lower, drops
vanished scenes, and never raises or adds anything, so a rise still fails afterwards.

**A reviewed exception.** Sometimes a rise is the right call. For example, the colour layer adds a `create` button
to the DS gallery, so the gallery shows one more primary by design. For that, the integration owner regenerates the
measured entries from the tree:

```sh
UPDATE_BASELINES=reset npx playwright test -c tests/e2e/playwright.config.ts --project=declutter --grep "<view> <theme>"
```

`<view> <theme>` is one of `phone light`, `phone dark`, `desk light`, `desk dark` or `narrow light`.

The diff shows every rise, and the PR says why each one is right. The reviewer reads that diff line by line.

## 6. Today's numbers (S2 baseline, light and dark are equal)

Phone (360×740) / desk (1280×800); the truncated column adds 320×640 (light) first. These are the numbers each
later package moves.

| Scene | Primaries | Box depth | Truncated (320 / 360 / 1280) | Phone chrome % | Live pulses | Usage phrase | "Free" |
| --- | --- | --- | --- | --- | --- | --- | --- |
| studio, open gate | 0 / **2** | 2 / 2 | 0 / 0 / 1 | **36** | 2 / 3 | 19 / 33 | 9 / 14 |
| studio, busy | 1 / **3** | 2 / 2 | 1 / 1 / 1 | **36** | 2 / 3 | 18 / 32 | 7 / 12 |
| studio, Pages tab | **2** / **2** | 2 / 2 | 2 / 2 / 1 | **36** | 1 / 3 | 8 / 33 | 1 / 14 |
| studio, Read tab | **2** / **2** | 1 / 2 | 1 / 1 / 0 | **30** | 1 / 1 | 1 / 20 | 0 / 9 |
| studio, Cast tab | **2** / **2** | 2 / 2 | 2 / 2 / 2 | **36** | 1 / 5 | 8 / 27 | 0 / 13 |
| studio, empty | 0 / 0 | 2 / 2 | 0 / 0 / 0 | **30** | 0 / 0 | 0 / 0 | 0 / 1 |
| page editor (Easy, Pro) | 0 / **2** | 2 / 2 | **2** / 0 / 2 | — | 2 / 5 | 19 / 35 | 9 / 15 |
| breakdown kit | 0 / 1 | **3** / **3** | 0 / 0 / 0 | — | 0 / 0 | 51 / 51 | 8 / 8 |
| model picker kit | 0 / 0 | **3** / **3** | 0 / 0 / 0 | — | 0 / 0 | 2 / 2 | 1 / 1 |
| immersive reader | 0 / 0 | 0 / 0 | 0 / 0 / 0 | 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| public reader | 0 / 0 | 0 / 0 | 0 / 0 / 0 | 8 | 0 / 0 | 0 / 0 | 0 / 0 |

The two desk primaries in the studio are "Approve" and "Render remaining 4" (the busy studio adds "Stop"). The
truncated desk label is "Compact" in the Pages tab's card-size control (`board/PagesTab.tsx:522`). On phones, the
render gate's "Draw the remaining pages · uses a little of your usage" is cut on every board tab. At 320 px, the page
editor's toolbar also cuts "Mark up" and "Lettering" (`mobile/editor/EditorToolbar.tsx:239`, `:252`), which fit at
360. No scene overflows horizontally at 320 px. The full list, with every scene and the labels behind each number, is
`tests/e2e/baselines/declutter.json` and the run's `clutter-report.json`.

**What moves these numbers next:**

- ~~**DC-1 (S2):** the studio header loses its duplicate Read, Quality and "Saved". The Read tab gets one full-screen
  control. The `data-action` ids go on.~~ Done in S2b: header Read and Quality each have one home, no "Saved" in the
  header, one full-screen entry on the Read tab, no "Free" on the add tiles, and the ids are on (see "After S2b").
- **SETTLE-UI (S2):** settled cards collapse, so the transcript and C5 counts fall.
- **DC-2 (S3):** the breakdown card goes from depth 3 to depth 2, and a held page's note appears once.
- **DC-3 (S3):** one primary while a gate is open, and a static board chip. The pulse guard's last two unguarded
  lines go away.

### After S2a (the first loop, 2026-11-12)

The S2a integration ran the loop once after its ten merges and regenerated `declutter.json` once, as a reviewed
reset (§5). Every other entry is byte-identical. The rises, each reviewed:

- `app-ds-gallery@desk-*`: primaries 4 → 8 and live pulses 6 → 7. This is the §5 exception: the gallery now shows
  the colour layer's `create` button and making dot as specimens, in both panels (CL-0). The gallery is a spark
  specimen, so the layout smoke's one-spark check skips it.
- Transcript screens up by one in six entries: `studio-busy@desk-*` 11 → 12, `studio-busy@phone-*` 18 → 19 and
  `editor-pro@phone-*` 20 → 21. The S2a review traced it to one package, PF-2: its tile progress block
  (`conversation/cards/renderTile.tsx`) printed lines under every busy tile, the model under a queued tile, and
  "much longer than usual" plus the model under a stuck one (whose pill already said "Still drawing"). On the
  `heist-12p` busy scene that grew the pages-and-cover grid and the "Pick a style" card (288 → 334 px at 320) and
  crossed one screen boundary in each entry. It was a regression, not an accepted design rise, and it is fixed: only
  a tile drawing normally says how long, only the live tile names the model (once per view, like the one live pulse),
  queued and stuck tiles add no line, and a compact style tile keeps just the dot in its pill (it read "Sti…").
  `renderTile.test.tsx` pins each of these. The loop then ran with `UPDATE_BASELINES=1`, lowering only, and all six
  entries came back to 11 / 18 / 20. So neither S1's base content nor any other S2a package crossed a boundary.
- The pulse guard: the chat tiles' raw `animate-pulse` is gone (PF-2), so `pulse.json`'s `animate-pulse` total is 32.
  The busy studio's live pulses did not change (3 desk, 2 phone).

Lead decisions recorded here: the C2 `data-action` ids go to DC-1 (until then duplicate actions read 0 everywhere and
the report's duplicate-name groups are the reviewer's lead). The phone render-gate label cut (`BoardPane.tsx`) is
deferred to DC-3 or the gate's owner, and the page editor's "Mark up" / "Lettering" cut at 320 px to PE-SHELL. The
calendar batch subtitles now wrap to two lines at 320 px instead of truncating (CHAT-0).

### After S2b (DC-1 and the S2b integration, 2026-11-12)

DC-1 merged last of the S2b UI packages, so its numbers were checked against every earlier merge. The loop ran with
`UPDATE_BASELINES=1` (lowering only) and nothing rose. In `desk-light` and `desk-dark` the C5 `freeWords` fell by 4
in each of these scenes (the four timeline add tiles): board-pages 5 → 1, editor-easy and editor-pro 15 → 11,
kit-timeline 4 → 0, studio-busy 12 → 8, studio-cast 13 → 9, studio-chat 14 → 10, studio-empty 1 → 0,
studio-history 14 → 10, studio-media 13 → 9, studio-pages 14 → 10, studio-story 13 → 9, studio-streaming 12 → 8
and studio-style 15 → 11. Phone and narrow views did not move (the dock is collapsed below 1024). C2
`duplicateActions` is 0 in every scene, now that the ids exist (§2). The terracotta and z-ladder baselines dropped
`SavingsChip.tsx`'s chip colour and its `z-30`.

Lead decisions recorded here:

- **D10:** the S2b integration applied DC-1 #3 to the frozen composer: its quality chip carries
  `data-action="quality"` and, when roomy, reads "{Tier} · {Model}" with the lock glyph and the screen-reader words
  ", locked for this comic". It names a tier and a model, never a price, and takes no spark. So at 1024 px and up a
  locked comic shows its lock on screen, not only inside the closed ⋯ › Quality row, and the probe now checks C2 for
  Quality at desk too (ComicStudio.test.tsx 'the quality cut is 1024' still pins the header side). The S2b review
  found the chip hidden at 1024 (a composer under `ROOMY_PX`) and clipped by the chip row's scroller up to about
  1900 px, so the integration fixed it: the quality chip leads the row, the lock leads its words, and from 1024 px
  (`qualityHome.ts`, shared with the header's cut) it never hides; a composer under `ROOMY_PX` shows a compact
  "{Tier}" plus the lock, with the model in its title. `declutter.spec.ts` 'the composer quality chip is on screen
  from 1024 px' hit-tests the chip and the lock at their centres at 1024 and 1280, light and dark.
- **D20:** DC-1 #6 and #7 (ids on the header Share and History) are held, as in §2, because each would be the first
  rise in a desk C2 entry.
- The page editor's flag-off snapshots (`board/PageEditor.flagOff.test.tsx`, PE-SHELL's pin of today's DOM) carry
  DC-1's add-tile words: "Add page — a blank page", with no "free" (lead decision D7, a test edit forced by the merge).

The S2b merges left three new scenes red (scenes the baseline did not list, so they are held to the targets). The
integration settled each before the PR:

- `app-landing` C1 primaries 2: **fixed, no entry.** The comics landing's header "Sign in" / "My comics" is now a
  `secondaryButton`, so the hero's spark CTA is the one filled primary in the first view, and the four feature spots
  draw `EmptyArt` in the card's own ink (`accent="currentColor"`), not terracotta. The scene meets the targets and
  stays unlisted (`comicshost.test.tsx` pins both).
- `app-ds-content` C3 depth 4 (nested boxes 9), in every phone and desk entry: **reviewed exception, listed.** The
  scene is DS-R1's QA content-kit specimen. Its depth is the specimen's own `SectionCard` wrapper around a ComicCard
  (section > ComicCard > MediaTile > chip); no production screen nests a ComicCard in a card. Cutting a level (the
  StatusChip `onArt` variant) is left to the kit's owner, and the listed entry stops it from rising meanwhile.
- `app-shell` C9 live pulses 8 at desk and 3 on phones: **reviewed exception, listed.** The pulses are
  `AppHeaderSkeleton`'s shimmer blocks (one per brand, nav and action placeholder). The skeleton is exported by
  `components/ds` and drawn only by the QA shell scene (`qa/app/scenes/shell.tsx`); nothing in production mounts it.
  Whoever first mounts it in the app gives it one shimmer (C9) before it ships, and the entry then falls.

Only those ten entries (`app-ds-content@*`, `app-shell@*`) came from the verify step's reset proposal; its other
35 new entries are scenes that already meet the targets and stay unlisted, and none of the 105 existing entries
changed.

## 7. Limits (what the probe does not see)

- A primary drawn without the primary tokens (a hand-rolled fill) is not counted. Build controls from the
  primitives.
- At 320 px only C6 and horizontal overflow are measured, in light. Primaries, boxes, chrome share and pulses are
  measured at 360 and 1280.
- Text inside `<input>`, `<textarea>` and `<select>` is not a label to the probe, so a cut title in a text field or
  a cut `<option>` is not counted.
- C2 counts only controls that carry `data-action`. The header Share and History carry none yet (D20, §2), so a
  duplicate there shows only in the report's duplicate-name groups, which stay the reviewer's lead.
- C4 (one number, one definition) and C10 (same role, same control) are review-only. C4 also has unit tests on the
  shared count helpers, in the packages that own them.
- CLS during a state change (C9's "nothing moves the user") is not measured yet. It needs a motion-on scene per
  state change.
- The QA fixture is synthetic. Production threads may show fewer notices at once.
- A static "nested Surface" check over the source is possible on DS-0's scanner, but it is deferred. The runtime
  probe sees the rendered result, with fewer false positives across files.
