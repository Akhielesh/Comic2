# The side panel (Comic Studio navigation)

**Status:** shipped (SH-C1). One panel, the same everywhere in Comic Studio: My comics (All comics), New comic, Images
(on the comics host) and inside a comic. It replaced two navigations that showed stacked in the studio: the creator
list (`ComicProjectNavigation`, with its AI activity feed) and the studio's own rail (`WorkspaceNavigation`).

## 1. What it shows, from the top

1. **Where you are.** "My comics", then the place itself in heavier ink as the current page: the comic's title, "New
   comic" or "Images". On My comics, "My comics" is itself the current page. From anywhere else it is the way back
   ("Back to My comics").
2. **This comic** (inside a comic only, `panel/ComicSection.tsx`). The comic's stage (SH-A, `comic-stages.md`): the five
   marks beside "This comic", and one two-line button, "Drawing · 6 of 12 pages drawn" / "Next: draw the rest", which
   only opens the place (a board tab, the approval or the draft in the conversation, the composer, the Share sheet; its
   description says which). Then Ask the Director, then the board's tabs (Story, Cast, Style, Pages n/N, Read and the
   registry tabs). It is the comic's own section, and the place its parts tree grows (SH-C2).
3. **Your comics** (`panel/PanelComics.tsx`, `panel/panelModel.ts`). Every comic once, in the group that needs the
   person most: **Needs you** (an approval, a question, a plan to review, a look to choose, an interrupted draft, a
   drawing issue), **In progress**, **Finished**, **Recent**. Each row: the title, the stage's five marks, and one status
   line. The old AI activity feed's groups live here now, not beside the list.
4. **Go to.** New comic, Images, Chat, Library, the studio guide, Report a problem.

Ink only: no hue, no ultramarine, no wash, no spark, no price (`tests/config/sparkGuard.test.ts` and
`colourUseGuard.test.ts` hold `components/comicstudio/panel/**` to the ink-only navigation rule). One fill per view:
New comic is the ink fill on My comics, an outline on its own view (where the idea form's Start is the fill), and a plain
row on Images and inside a comic.

## 2. Your comics: groups, words and order

| Group | When | Status line | Opens at | Order |
| --- | --- | --- | --- | --- |
| Needs you | the saved summary has `attention` | "Review drawing estimate", "Answer the Director", "Review page plan", "Choose a look", "Resume interrupted draft", "Review drawing issue" | the conversation, or Pages for a drawing issue | last update |
| In progress | `working` (a render or the Director's draft running) | the stage ("Drawing · 6 of 12 pages drawn"); "Last reported in progress" without a readable stage; "Check stalled progress" after 15 minutes silent | the conversation | last update |
| Finished | a fresh finished work (below) | the latest one: "2 pages drawn", "Cover drawn", "Page plan ready", "Comic published", … | where it is (Pages, Read, Style, Cast, Languages, the conversation) | finish time |
| Recent | everything else | the stage; "Open to see" for a Studio comic without a readable stage; "Classic editor" for a classic comic | the comic | last edit; 5 shown |

- **Fresh** means: a finished work with a real time (`at > 0`), from the last 7 days, not cleared by this viewer. The
  activity fallback for a comic saved before the summary records its page count with `at: 0`
  (`services/comicWorkspaceActivity.ts`); that is a count, not a completion, so such a comic is never "Finished".
- **Clear finished** marks this viewer's finished work seen (`dreamstream.comic-work.<owner>.<comic>.<kind>` =
  `at:count`, the keys the old feed wrote, so earlier clears still hold); newer work of the same kind brings it back.
  Three finished comics show, then "Show all N finished".
- The comic you are in is always listed, as the current page, and reads its live stage from the open doc.
- Five Recent comics show; "All comics · N more" opens the full list when some are left out.
- Rows are links (`/?view=studio&id=…&task=…`), so a modified click opens a new tab; a plain click sets the task target
  (`home/workspaceTaskTarget.ts`) and opens the comic. A classic comic opens through App's classic routing.
- A row's accessible name is its title, status, and stage when the status is something else: "Salt Road · Review
  drawing estimate · Drawing · 6 of 12 pages drawn". The marks are decorative.

## 3. When it fetches (the backend and the database stay idle)

`panel/usePanelActivity.ts` reads the owner's own `comic_docs` through the existing scalar projection
(`WORK_SELECT`, 25 a page, account-checked); it never loads a full comic. It fetches:

- when the list mounts (the panel opens; not while it is the rail);
- when the tab comes back into view or gets focus, at most every 30 s;
- 700 ms after a run settles in this tab (`WORK_CHANGED_EVENT`, from `live/studioStreams.ts`);
- on reconnecting, on Refresh, and on "Check older comics" (which adds the next 25).

Never on a timer: the old feed's 15/60 s poll while expanded is gone, and a test fails on any interval in the panel. The
last rows are remembered per account for the tab, shown at once when the panel opens again, and not refetched while
under 20 s old. A failed refresh keeps the last rows ("Couldn’t refresh · Last checked 10:42"); offline says so; a
response for a previous account is dropped. Without an account (previews, QA scenes) the list is App's project list.

## 4. Where it docks

| Where | Width | Panel |
| --- | --- | --- |
| Inside a comic (`ComicStudioShell`) | from 1024 px, not a foldable split | docked: open (14rem) or the slim rail (3.5rem); the header's panel button toggles |
| Inside a comic | below 1024 px, phones, dual-screen | the left `SideSheet` (modal), opened from the header; any choice closes it |
| My comics, New comic, Images (`ComicWorkspaceFrame`) | from 900 px | docked: open (14rem, the brand on top) or the slim rail under the header; the header's menu button toggles |
| My comics, New comic, Images | below 900 px | the frame's modal drawer; any choice closes it |

- **Open or rail is one choice for the whole studio**, remembered per viewer (`dreamstream.comic-panel.<accountId>`,
  `open` | `closed`; `panel/panelPreference.ts`). Every read and write is in try/catch; when storage fails the choice is
  kept for the session in memory, so the frame and the studio still agree. With no choice yet the studio opens it on a
  wide desktop (from 1280 px) and shows the rail below that, so the conversation and the board keep their room; the frame
  opens it wherever it docks, as before.
- **The rail**: My comics, then (inside a comic) Ask the Director and the board tabs, then New comic, Images, Chat and
  Library, each a 44 px icon with its name as label and tooltip.
- **Go to** stays at the foot on a window 720 px tall or more (the rest scrolls); on a shorter one the whole panel
  scrolls, so nothing is squeezed. Its rows are 36 px under a mouse and 44 px for touch.
- **Names**: one name everywhere: the panel is the navigation "Project navigation"; its toggle is "Open project
  navigation" (drawer), "Expand project navigation" / "Collapse project navigation" (docked); the drawer is the dialog
  "Project navigation".
- **Keyboard and screen readers**: the reading order is the visual order (where you are, this comic, your comics, Go
  to). The board tabs are one tab stop: Arrow keys, Home and End move along them without opening one (Enter or Space
  opens it). Drawers take focus, trap it, and Escape returns it to the toggle. No headings in the panel (the page's
  outline starts at its own h1); groups are labelled lists.
- **Phones**: 44 px targets, titles clip with an ellipsis (their full words are the tooltip and the name), no sideways
  scroll at 360 px.

## 5. App wiring

- `App.tsx` keeps one set of links (projects, account, New comic, Images, **Chat**, Library, open a comic) and gives it to
  the studio (`panel`, with My comics = leave the studio): Chat was missing from the studio before. On the comics host it
  gives the same links to Images (`ImageWorkspace panel`), which then sits in `ComicWorkspaceFrame` (title "Images",
  loaded lazily from the image chunk, so the first load does not carry it) and drops its own Back and main landmark.
- `ComicWorkspaceFrame` lost its unused `onAccount` prop (the header's account menu opens Settings).
- `ProjectDashboard` passes the same links for My comics and New comic.

## 6. Key files and tests

- `components/comicstudio/panel/ComicSidePanel.tsx` (+ test: open and rail, remembered per viewer, storage that throws,
  where you are, the one fill, focus order, board keyboard, the phone drawer, 44 px rows and clipped titles),
  `ComicSection.tsx`, `PanelComics.tsx` (+ test: task targets, Clear finished across a reload, an older comic never
  freshly finished, stages on rows, failure, offline and reconnect, a previous owner's late response, when it fetches,
  no interval, the remembered rows and Check older comics), `panelModel.ts` (+ test: grouping, ordering, recent limit,
  the open comic, fresh rules, older and classic comics, row names), `usePanelActivity.ts`, `panelPreference.ts`,
  `panelStyles.ts`, `StageMarks.tsx`.
- `components/comicstudio/ComicCreationWorkspace.tsx` and `comicCreationWorkspace.css` (the frame, the rail column);
  `tests/config/creationWorkspaceTokens.test.ts`.
- `components/comicstudio/ComicStudio.tsx` (the aside and the drawer), `ComicStudio.test.tsx` (open by default on a
  wide desktop, the rail below, Chat, the phone drawer), `ComicStudio.stage.test.tsx` (the panel's next step only
  navigates).
- `tests/e2e/workspace.navigation.spec.ts` (the studio's panel at three sizes).

## 7. Left out on purpose

- No SQL and no server change: the list reads the summary the server already saves.
- The two old open/closed keys (`cs.workspace.navigation.expanded`, `comicstudio.creation.navigation`) are not migrated:
  the studio's defaulted to collapsed, and the new default is the point.
- No "Needs you" count on the rail: the list says it when open.
- The comic's parts tree (SH-C2).
