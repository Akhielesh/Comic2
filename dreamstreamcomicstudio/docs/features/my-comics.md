# My comics

**Status:** shipped (SH-B, on the comic stages of SH-A). The signed-in member's own comics: the Comic Studio host's
"All comics" (`comicWorkspace`) and the main dashboard both render `components/ProjectDashboard.tsx`.

**What it is for.** Every comic as a calm card that says where it stands and what to do next, with that next step one tap
away, and the comics that wait on the person first. It never loads a full comic to say any of this, and nothing on it
spends.

## 1. Where the words come from (no full doc, no request per card)

- **The list** is `loadProjectCards` (`services/db.ts`): the projects rows' card projection (title, cover id and signed
  thumbnail, the server-mirrored `studioPages` / `studioRendered`, `isPublic`, Featured, the classic editor's keys).
- **The stage and "Needs you"** come from ONE read, `loadComicStages` (`services/comicWorkspaceActivity.ts`): one
  `comic_docs` select of `project_id,listing` (`STAGE_SELECT`), the owner's rows, newest first, paged 200 at a time
  until they run out. `listing` (`server/sql/comic_docs_listing.sql`) is a small copy, kept in step with `doc` by a
  trigger on every write, of the saved summary `doc->workspaceActivity` and the gate, plan, draft and last-card scalars
  the AI activity feed reads for comics saved before summaries existed. **The read never touches `doc`**: any path into a
  stored doc (up to several MB) makes Postgres fetch and decompress the whole doc, once per path, and this read covers
  every comic of the account. Until the SQL file is applied the select fails with `42703` and the read falls back to the
  same values as scalar paths into `doc` (`STAGE_DOC_SELECT`); any other failure is just a failed read. Rows go through
  the feed's own `comicActivityRow`, so a card's "Needs you" is the feed's, and a stage is kept only when
  `readStageFacts` validates it (`docs/features/comic-stages.md` §4).
- **When it runs** (`components/comicstudio/home/useComicStages.ts`): when the view opens, again each time the list
  reloads (back from the studio, a new comic), and after a run in this tab settles (studioStreams'
  `WORK_CHANGED_EVENT`, for this account, 700 ms after the last one, the moment the AI activity feed beside the grid
  reads again; a run that settles while the tab is hidden is read when it shows again). Never on a timer, never per
  card. The last answer stays while a new one runs, and the tab remembers it per account: coming back from a comic
  paints the cards at once, in their known order, and reads again behind them (a comic with no row yet shows the
  placeholder stage line until the read lands). A read that has not answered in 12 s is aborted, and a failed read
  leaves every card working on its row counts and "Open to see". The QA scene and tests hand in rows through
  `ComicStagesSource`.
- Until a read has answered once in this tab, the grid waits up to 1.2 s for it (counted from when there are cards to
  show, even while the list itself is still reloading), showing placeholder cards of the same footprint
  (`MyComicCardPlaceholder`), so a comic that needs the person is placed first from the start instead of jumping there.

## 2. The card (`components/comicstudio/home/MyComicCard.tsx`, model in `homeModel.ts` `myComicCard`)

Each card has the cover, the title, the stage, one status line, the next step, Read once a page is drawn, and a quiet ⋯.

| Comic | Stage row | Status line | Next step | Read |
| --- | --- | --- | --- | --- |
| Studio, stage saved | five ink marks (StageStrip's `StageMark`) + the stage word ("Drawing", "Ready to publish", "Publishing paused", "Published") | the stage's progress · edited … ("6 of 12 pages drawn · edited 2 hours ago") | `Next: <step>` (the strip's words), opening where it is worked | when a page is drawn (`drawn > 0`: a withheld picture never counts) |
| Studio, a question waiting, or a page whose drawing failed | as above | as above | `Next: answer the Director` (the conversation) or `Next: review the drawing problem` (the Pages tab), unless the stage itself is waiting (an approval, the Director planning, a draft to resume) or already says it ("Review 2 failed pages"). A failed page is read from the stage's counts, in Draw or Publish only: a page with no picture whose drawing failed, or a standing picture that is neither current nor out of date while nothing draws (its redraw failed). The summary's `render_failed` alone says only that *some* render failed (a look, the cover, a cast sheet: a failed look stays failed after another is picked), so with no failed page the stage's own step stays (a published comic keeps Read; a new one keeps "Tell the Director your idea"), and the card still says Needs you | as above |
| Studio, every stage done | marks + "Published" | as above | none: Read is the next step (outline, the only button) | yes |
| Studio, saved before stages or unreadable | "Open to see" | the row's counts ("3 of 10 pages drawn", "All 4 pages drawn", "No pages planned yet", "Published") | what waits, if the activity data says ("Next: review the estimate"); a render that failed keeps its words but opens the comic as it was left (nothing says where it failed); else `Open` | the row's `studioRendered > 0` |
| Studio, the read not answered yet | a placeholder line of the same height | the row's counts | `Open` | the row's count |
| Classic / Page Studio | "Classic editor" / "Page Studio" | the step ("Step: Style"), drawn panels or pages, or "Building · 40% · about 2m left" (with a bar; the time only once the build has one, never "Calculating...") | `Edit` (a button: no studio URL) | a drawn panel or page |

- **Where a next step opens** (`STAGE_PLACE_DESTINATION`): Story, Style, Pages, Read → that board tab; an approval, the
  Director's draft, the composer, a question → the conversation (at its newest message, where the open approval or the
  draft's control is); "Publish your changes" and "See why it is paused" → the Share sheet. It is a link to
  `/?view=studio&id=…&task=…` (a new tab opens it there), and a plain click opens the comic here through the task target
  (`workspaceTaskTarget.ts` `requestTaskTarget`, consumed by `ComicStudioShell`, which gained the `story` tab and the
  `share` sheet). **It never carries an action**: nothing starts, nothing spends, and no price is shown.
- **The Share sheet on arrival.** The `share` target brings the board forward (on a phone the studio opens on the
  conversation) and runs `open_share`. With no Share button mounted to answer it, `useStudio` opens the Read tab with a
  one-shot reader request (`ReaderRequest.share`), and the Read tab opens its own Share sheet. The same path serves the
  stage strip's "Publish your changes" and the translation card's "Publish…".
- **Needs you** is the summary's `attention` (an approval, a question, a plan to review, a look to choose, an
  interrupted draft, a drawing problem): an ink chip on the cover. Classic comics never. The chip is `aria-hidden`; a
  screen reader hears "Needs you" right after the title (an `sr-only` line), so someone moving by heading hears why the
  comic is listed first.
- **Structure and keyboard.** An `<article>` named by its title; the title's `<h3>` holds the one primary control (open
  the comic as it was left). A pointer press anywhere else on the card is handed to it by ds `ComicCard`'s own
  `handCardClickToPrimary` and its `COMIC_CARD_FOCUS` outline: one rule for both cards (a click on a control of the
  card's own, a drag-to-select, or a click that bubbles through React from a portalled menu never opens either). The next step,
  Read and ⋯ are siblings, never inside a button or the heading: no nested controls. Tab order: title, ⋯, next step,
  Read. Names say which comic: "Next: draw the rest, Spice Market", "Read Spice Market", "More for Spice Market"; the
  marks read "Stage 4 of 5: Drawing"; each next step describes where it opens ("Opens the comic's Pages tab").
- **The ⋯ menu** (ds `Menu`) keeps every older action: Rename (the title becomes a field; Enter saves, Escape cancels,
  leaving it saves; focus returns to the title after the keyboard ends it), Mark / Unmark as featured (a featured comic
  shows a star by its title), Details (the info modal), Duplicate (classic; for a studio comic a disabled row that says it
  isn't available yet), Delete… → the ds `AlertDialog` ("Delete “Title”?", focus on Cancel; `window.confirm` is gone, it
  threw in embedded webviews and deleted without asking). A delete is announced.
- **The cover**: a box of fixed proportions before anything loads (3:4 beside the words on a phone, 4:3 across the top
  from 640 px), the picture laid over it lazily (`RevealImage`; the first three cards load at once), framed from the top,
  decorative (the heading names the comic). If it fails, the next candidate is tried (cover → first drawn panel → first
  Page Studio page → first look), then a line drawing.
- **No colour on a card**: ink, muted ink and the cover only. No hue, wash, spark or price on or beside the next step or
  Read, and no fill (the frame's New comic stays the view's one).

## 3. Layout

- Grid (`ProjectDashboard` `MY_COMICS_GRID`): one column of row cards below 640 px (the cover in a 6 rem column, the
  words beside it, the buttons across both); from 640 px as many 17 rem cards as fit (`auto-fill`, so the frame's
  sidebar, open or collapsed, never squeezes a card). At 360 px a card is 328 px inside 16 px gutters; titles clamp to two
  lines, the button row wraps, and the next step's words wrap inside their button rather than end in an ellipsis (they
  say what happens next; the layout smoke's truncated-label check holds that at 0). **The status is never cut**
  (`CardStatus`): its parts ("6 of 12 pages drawn", "1 out of date", "edited 2 hours ago") are inline blocks, so they
  share a line while they fit and otherwise a part moves down whole: at 360 px (a 194 px column, about 27 characters)
  "6 of 12 pages drawn ·" sits over "edited 2 hours ago". A part wider than the column wraps inside itself. No tooltip
  stands in for it (touch has none); the Continue card uses the same line. Every control is a 44 px target on a coarse
  pointer. Nothing is hover-only (the old Read / Open / Info row that showed on hover is gone).
- 24 cards at first, then "Show more comics" (its name says how many more). Cards are memoised and their words cached per
  comic, so a star or a rename re-renders one card; 150 comics are tested.

## 4. Order, filters, search

- The default sort, "Needs you, then recent": comics that wait on the person first, then the most recently edited.
  Created, A–Z and Z–A sort exactly so. Search, Featured, Recent changes, dates, status, cover and comments are kept.
- The Step filter gains the studio's stages (Story, Style, Plan, Draw, Publish, Published) from the saved summary; a
  comic without a saved stage matches none of them. The classic editor's steps stay.
- Nothing matching: an inline empty state, "No comics match", with Reset filters (no wash: it is a working view).

## 5. Continue and the empty page

- **Continue** (`ContinueCard.tsx`, comics host only): the most recently edited studio comic within 14 days (the pick is
  unchanged, made once per list load). It shows the same stage row and status as the comic's card, and its next step (a
  deep link) or Continue when the stage is unknown, plus Read. No fill. On a phone its buttons run under the cover and the
  words, so the next step keeps its words on one line; from 640 px they sit under the words, beside the cover.
- **No comics yet** (`MyComicsEmpty.tsx`, the main dashboard; the comics host shows the idea form instead): the page's one
  warm moment, the empty-state wash (`WASH_EMPTY`, listed in `tests/config/colourUseGuard.test.ts` WASH_FILES), a line
  drawing, one sentence and Create a new comic, which opens the form and spends nothing.

## 6. Key files and tests

- `components/ProjectDashboard.tsx`; `components/comicstudio/home/{MyComicCard,MyComicsEmpty,ContinueCard}.tsx`,
  `homeModel.ts`, `useComicStages.ts`, `workspaceTaskTarget.ts`; `services/comicWorkspaceActivity.ts` (`loadComicStages`);
  `server/sql/comic_docs_listing.sql` (the `listing` column, its trigger and backfill; additive, idempotent, applied by
  hand); `components/ds/ComicCard.tsx` (the shared click handoff); `components/comicstudio/ComicStudio.tsx` (the `share`
  target), `useStudio.ts` / `board/ReaderTab.tsx` (`ReaderRequest.share`); `qa/app/scenes/creator-home.tsx` (fixture
  stages: every stage, three that need you, two saved before stages).
- Tests: `home/myComicsModel.test.ts` (each state, older comics, classic, Read, order, filter, places, what a failed
  look, cover or page leads to, a build's time left), `home/MyComicCard.test.tsx` (structure, deep link, menu, rename,
  cover, no colour, Needs you after the heading, the phone row and its whole status), `home/ContinueCard.test.tsx`,
  `ProjectDashboard.cards.test.tsx` (one read of the listing column and its fallback, Needs you first, 150 comics, never
  on a timer, a settled run, the hidden tab, back from a comic, the 12 s limit, empty states),
  `ProjectDashboard{,.home,.touch}.test.tsx`, `ComicStudio.taskTarget.test.tsx`, `board/tabs.test.tsx` and
  `useStudio.undo.test.tsx` (the Share sheet request), `services/comicWorkspaceActivity.test.ts`,
  `server/sql/tests/comic_docs_listing.test.sql` (backfill, trigger, nothing private copied, locked-down function).

## 7. Left out on purpose

- No server change: a comic not saved since stages shipped reads "Open to see" until its next save writes one (the
  listing's backfill copies only what the doc already holds).
- Arriving at the conversation shows its newest message; it does not scroll to and focus the approval card the way the
  studio's own strip does (that needs the mounted conversation).
- The pick of the Continue comic still ignores "Needs you" (it is the most recent comic; the grid puts what waits first).
