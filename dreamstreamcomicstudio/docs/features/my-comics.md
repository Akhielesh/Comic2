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
  `comic_docs` select of scalar paths only (`STAGE_SELECT`: the saved summary `doc->workspaceActivity`, and the gate,
  plan, draft and last-card scalars the AI activity feed already reads for comics saved before summaries existed), the
  owner's rows, newest first, paged 200 at a time until they run out. Rows go through the feed's own
  `comicActivityRow`, so a card's "Needs you" is the feed's, and a stage is kept only when `readStageFacts` validates it
  (`docs/features/comic-stages.md` §4).
- **When it runs** (`components/comicstudio/home/useComicStages.ts`): when the view opens, and again each time the list
  reloads (back from the studio, a new comic). Never on a timer. The last answer stays while a new one runs, and a
  failed read leaves every card working on its row counts. The QA scene and tests hand in rows through
  `ComicStagesSource`.
- On the first open the grid waits up to 1.2 s for that read, showing placeholder cards of the same footprint
  (`MyComicCardPlaceholder`), so a comic that needs the person is placed first from the start instead of jumping there.

## 2. The card (`components/comicstudio/home/MyComicCard.tsx`, model in `homeModel.ts` `myComicCard`)

Each card has the cover, the title, the stage, one status line, the next step, Read once a page is drawn, and a quiet ⋯.

| Comic | Stage row | Status line | Next step | Read |
| --- | --- | --- | --- | --- |
| Studio, stage saved | five ink marks (StageStrip's `StageMark`) + the stage word ("Drawing", "Ready to publish", "Publishing paused", "Published") | the stage's progress · edited … ("6 of 12 pages drawn · edited 2 hours ago") | `Next: <step>` (the strip's words), opening where it is worked | when a page is drawn (`drawn > 0`: a withheld picture never counts) |
| Studio, a question waiting, or a redraw that failed over a standing picture | as above | as above | `Next: answer the Director` (the conversation) or `Next: review the drawing problem` (the Pages tab), unless the stage itself is waiting (an approval, the Director planning, a draft to resume) or already says it ("Review 2 failed pages") | as above |
| Studio, every stage done | marks + "Published" | as above | none: Read is the next step (outline, the only button) | yes |
| Studio, saved before stages or unreadable | "Open to see" | the row's counts ("3 of 10 pages drawn", "All 4 pages drawn", "No pages planned yet", "Published") | what waits, if the activity data says ("Next: review the estimate"), else `Open` | the row's `studioRendered > 0` |
| Studio, the read not answered yet | a placeholder line of the same height | the row's counts | `Open` | the row's count |
| Classic / Page Studio | "Classic editor" / "Page Studio" | the step ("Step: Style"), drawn panels or pages, or "Building · 40% · about 2m left" (with a bar) | `Edit` (a button: no studio URL) | a drawn panel or page |

- **Where a next step opens** (`STAGE_PLACE_DESTINATION`): Story, Style, Pages, Read → that board tab; an approval, the
  Director's draft, the composer, a question → the conversation (at its newest message, where the open approval or the
  draft's control is); "Publish your changes" and "See why it is paused" → the Share sheet. It is a link to
  `/?view=studio&id=…&task=…` (a new tab opens it there), and a plain click opens the comic here through the task target
  (`workspaceTaskTarget.ts` `requestTaskTarget`, consumed by `ComicStudioShell`, which gained the `story` tab and the
  `share` sheet). **It never carries an action**: nothing starts, nothing spends, and no price is shown.
- **Needs you** is the summary's `attention` (an approval, a question, a plan to review, a look to choose, an
  interrupted draft, a drawing problem): an ink chip on the cover. Classic comics never.
- **Structure and keyboard.** An `<article>` named by its title; the title's `<h3>` holds the one primary control (open
  the comic as it was left). A pointer press anywhere else on the card is handed to it (ComicCard's rule). The next step,
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
  lines, the status clips with its words in a tooltip, the button row wraps, and the next step's words wrap inside their
  button rather than end in an ellipsis (they say what happens next; the layout smoke's truncated-label check holds that
  at 0). Every control is a 44 px target on a coarse pointer. Nothing is hover-only (the old Read / Open / Info
  row that showed on hover is gone).
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
  `components/comicstudio/ComicStudio.tsx` (the `share` target); `qa/app/scenes/creator-home.tsx` (fixture stages:
  every stage, three that need you, two saved before stages).
- Tests: `home/myComicsModel.test.ts` (each state, older comics, classic, Read, order, filter, places), `home/MyComicCard.test.tsx`
  (structure, deep link, menu, rename, cover, no colour, the phone row), `home/ContinueCard.test.tsx`,
  `ProjectDashboard.cards.test.tsx` (one read, Needs you first, 150 comics, never on a timer, empty states),
  `ProjectDashboard{,.home,.touch}.test.tsx`, `ComicStudio.taskTarget.test.tsx`, `services/comicWorkspaceActivity.test.ts`.

## 7. Left out on purpose

- No SQL and no server change: a comic not saved since stages shipped reads "Open to see" until its next save writes one.
- Arriving at the conversation shows its newest message; it does not scroll to and focus the approval card the way the
  studio's own strip does (that needs the mounted conversation).
- The pick of the Continue comic still ignores "Needs you" (it is the most recent comic; the grid puts what waits first).
