# Comic stages (Comic Studio)

**Status:** shipped. The studio shows it as a stage strip, as a stage map (from the strip and the side panel, SH-C2) and
in the side panel's own section; the side panel's Your comics reads it from the saved summary (`comic-navigation.md`).

**What it is for.** Every comic says where it stands, in one of five stages, how far along that stage is, and the one
next step: "Drawing · 6 of 12 pages drawn · Next: draw the rest". The studio shows it as a stage strip (under the
header from 768 px, at the top of the board on a phone); lists read it from a small summary saved with the comic, so
they never load a full comic to say it.

## 1. The stages and their order

**Story → Style → Plan → Draw → Publish.** The look comes before the plan because that is the real flow:

- the Director's rule is "idea → style → plan_pages → pages → cover" (`server/src/comic/director.ts`, rule 4);
- "Draft it for me" sets the look before it plans (`server/src/comic/directorDraft.ts`).

Each stage has its own done flag, and **the current stage is the first one not done**. So a hands-on comic that planned
its pages before choosing a look reads "Style", with Plan already ticked. No stage is ever claimed early.

## 2. Boundaries (`shared/comic/stage.ts`, from real doc fields)

| Stage | Done when |
| --- | --- |
| Story | a premise, logline or pasted script (trimmed), or any page exists. A title alone is not a story. |
| Style | `style.spec` is set (the test drawing itself uses: `jobs.ts` `ensureStyle`), or any page holds a picture. A name, refs or undrawn options are not a look. |
| Plan | pages exist, every page is planned (panels, or a picture), and the plan is approved (`planStatus: 'approved'`) or drawing began. An older doc normalised to `'draft'` that already has pictures counts. |
| Draw | every page has a picture the owner can be served (below). |
| Publish | `publication.status === 'live'`. A publication paused by moderation (`'suspended'`) is not published. |

**A drawn page** uses the progress card's rule, `progressState` in `shared/comic/renderOutcome.ts`:

- a picture the content check withheld never counts;
- a reused picture counts (the owner can be served it);
- an out-of-date (stale) picture counts (it is a picture; the Pages tab still flags it);
- a redraw or edit in flight, or a redraw that failed, keeps the earlier picture on the page, so it still counts. A
  first draw in flight or a failed first draw does not.

**The count the words show** is the board's own: pages drawn, current and shown to you (`current`, the same number as
`boardModel` `pageProgress`, the Pages and phone Board badges, and the reader's "6 of 12 pages drawn"), plus the
reader's "· 1 out of date" (`outOfDate`). So with a page out of date the strip reads "Ready to publish · 11 of 12 pages
drawn · 1 out of date", next to a Board badge of 11 of 12, never "All 12". A redraw in flight is not current. The
badge, the reader's count and the Director-led draft control ("Drawing your comic · 6 of 12 pages drawn", and its Read
comic button) never count a picture the content check withheld.

## 3. Progress and the next step

| Stage | Status word | Progress | Next step (place) |
| --- | --- | --- | --- |
| Story | Story | No story yet (true whatever else is done: a look picked first, a cast) | Tell the Director your idea (composer) |
| Style | Style | Not chosen yet · N looks to compare | Choose a look · Pick a look (Style tab) |
| Plan | Planning | No pages planned yet · P of N pages planned · N pages planned | Plan the pages · Plan the rest · Review the plan (Pages tab) |
| Draw | Drawing | C of N pages drawn (· K out of date) | Watch the pages draw · Review N withheld pages · Review N failed pages · Draw the pages · Draw the rest (Pages tab) |
| Publish | Ready to publish | All N pages drawn, or C of N pages drawn · K out of date | Read and publish (Read tab) |
| Publish, paused | Publishing paused | as above | See why it is paused (Share sheet, which shows the reason; sharing is off while paused) |
| (all done) | Published | as above | Read your comic (Read tab) · Publish your changes (Share sheet, like the Director's "Update the published version" chip) |

Three waits come before the stage's own step, at any stage, without moving the stage:

1. an open approval: "Review the estimate" (the approval card in the conversation);
2. the Director planning a draft: "Follow the Director", progress "The Director is planning" (the draft's control in the
   conversation). It is never "Pick a look" then: picking a look while the writer runs changes the style the plan is
   written for, and the draft throws that plan away (`directorDraft.ts` `assertPlanUnchanged`);
3. an interrupted Director draft **with no pages yet**: "Resume the draft" (the draft's control, whose sheet offers the
   retry). Once a draft has pages (stopped during the book offer, "Your page plan changed", a restart) there is nothing
   to resume: the stage's own step leads ("Review the plan", the drawing steps, publishing).

"Publish your changes" follows `publicationBehind` (exported from `shared/comic/stage.ts`, and the same function the
server's "Update the published version" chip uses in `jobs.ts`): a page or the cover drawn after the last publish. In
the studio the owner's publication view (`studio.publication.behind`, which also compares lettering, text, languages
and rating) adds to it when it is loaded, so the strip never says "Read your comic" while the Share button says
"changes not published". Lists have no such view and keep the render rule.

**The next step only navigates.** It carries no action, so it never starts anything that spends, and it never shows a
price. A question the Director is waiting on is left to the conversation's own card and the summary's `attention`
(reading it needs the settle index).

## 4. The saved summary (lists without full docs)

`summarizeComicWork` (`shared/comic/workspaceActivity.ts`) runs on every save (`server/src/comic/store.ts`
`storedOwnerDoc`) and now carries `stage: StageFacts`: the current stage, the done stages, page counts (pages, planned,
drawn, current, outOfDate, drawing, withheld, failed), drawn looks, whether the publication is paused, and the next-step
key. Counts and keys only: no title, text, prompts,
prices, models or paths. It stays private: `sanitizePublicDoc` strips `workspaceActivity`, and the summary keeps
`v: 1` (the field is optional, so older readers ignore it).

- `readStageFacts(value)` validates stored JSON strictly: known stage and step keys, safe integer counts, counts within
  the page count (current and out-of-date pages within the drawn ones), the current stage being the first one not done,
  done flags the counts agree with (Draw done only when every page is drawn; a live publication is never paused), and a
  next step that fits (from the current stage; never "publish" while paused; "resume the draft" only with no pages).
  Anything else is `null`.
- `stageSummaryOf(value)` gives a list its line: "Drawing · 6 of 12 pages drawn", or **"Open to see"**
  (`STAGE_UNKNOWN`) for a comic saved before stages or with an unreadable stage. Lists never guess a stage.
- `stageView(readStageFacts(saved))` equals `comicStage(doc)` for the doc it was saved from (tested), so a list and the
  studio always say the same words.
- `services/comicWorkspaceActivity.ts` keeps a stored stage only when it validates. The side panel's Your comics (which
  took in the old AI activity feed, SH-C1) shows it on every row: the five marks, and the words on "In progress" and
  Recent rows ("Drawing · 6 of 12 pages drawn"); a comic saved before stages keeps "Last reported in progress" in
  progress and "Open to see" elsewhere.

No SQL: the summary lives in the existing `comic_docs.doc` jsonb, read by the existing
`activity:doc->workspaceActivity` selector.

## 5. The studio strip (`components/comicstudio/stage/StageStrip.tsx`)

- Mounted by `ComicStudioShell`. `StudioHeader` is unchanged. From 768 px (and on any split or foldable) it is a row
  under the header and its banners, before the workspace. **On a phone** it is the first thing in the board's scrolling
  panel (`BoardPane` `lead`; not in Read, where the reader owns the scroll), so it adds no fixed chrome: the
  conversation keeps its room (its activity line already reports drawing), and the row scrolls away with the work.
- A `nav` named "Comic stages" with an ordered list of five buttons. Ink only: the current stage is the heavier ink
  (`aria-current="step"`), a done stage gets a check (its name ends ", done"), the rest are muted. No hue, spark, wash
  or price.
- Each stage opens where it is worked: Story → Story tab, Style → Style tab, Plan and Draw → Pages tab, Publish → Read
  tab (the board is revealed on phones and in Chat-only splits). The "Next: …" button opens its place: a board tab, the
  composer (focused), the Share sheet, or a step waiting in the conversation. That last one works wherever the chat
  already shows (a desktop split too): the conversation (`ConversationPane` `revealApiRef`) scrolls the newest open
  approval card into view and focuses the card itself, never its Approve, or goes to the latest message and focuses the
  draft's own control. Its description says where ("Opens the Pages tab", "Shows the approval in the conversation").
- Keyboard: native buttons in reading order; ArrowLeft, ArrowRight, Home and End move along the steps. A screen
  reader hears a polite note when the stage changes, never on each page drawn (the run's own card covers those).
- Layout, one row high:
  - from 768 px: the five named stages, then the status and the "Next: …" button;
  - below 768 px (a narrow split, the first screen of a book-posture foldable, and the phone's board): one 44 px row
    with 16 px gutters. A stage button shows the five stages as marks (a check when done, a filled ink dot for the
    current one, a ring for the rest; named "Stages: Draw, 3 of 5 done") and opens the five named stages in a row
    below; choosing one, or Escape (from the stage button or the list), closes them and returns focus to the stage
    button. Next to it, the status is one button: its first line is "Drawing · 6 of 12 pages drawn", its second "Next:
    draw the rest". Below 360 px a done stage in the opened row shows only its check, keeping its name for screen
    readers and as a tooltip.
  - The marks are SVG drawn in the text colour (`currentColor`), never a background fill, so the current stage keeps
    its dot in forced colours (Windows high contrast).
  - Coarse pointers get 44 px targets. It hides while the on-screen keyboard is up (`html.kb-open`), like the tab bar.
    On phones the board's tabs live in a drawer, so the strip is also a quick way between Story, Style, Pages and Read.
- The side panel's own section for the comic (`panel/ComicSection.tsx`, SH-C1; `comic-navigation.md`) says the same
  words as one button ("Drawing · 6 of 12 pages drawn" / "Next: draw the rest", the five marks beside "This comic",
  which open the stage map), and its board is labelled "Board" (it was "Project stages"): the board's tabs, grown into
  the comic's parts tree (SH-C2), not the comic's stages.
- A **Stage map** button ends the strip in both layouts (44 px on touch) and opens the stage map (§5a).

## 5a. The stage map (`stage/StageMap.tsx`, words in `stage/stageMapModel.ts`, SH-C2)

The five stages on one small map, from the same facts as the strip, so it never says something the strip does not.

| Part of a row | What it says |
| --- | --- |
| The mark | a check when done, a filled dot for the current stage, a ring for the rest, joined by one hairline (SVG in the text colour, so forced colours keep it) |
| The name and state | "Draw · Now": Done, Now, Next (the first stage after the current one that is not done), Later; a published comic's last stage reads "Published" |
| What is left | Story "No story yet"; Style "No look chosen yet", "3 looks to compare"; Plan "No pages planned yet", "4 pages to plan", "The plan is ready to review"; Draw "5 pages to draw · 2 drawing now · 1 withheld · 1 failed · 1 out of date", "Nothing to draw yet", and when done "1 page out of date"; Publish "Publish once the pages are drawn", "Ready to publish", "Paused for review", "Changes not published yet", "Live · new pages not published yet"; otherwise "Nothing left" |
| The target | the current stage's next step (the label and place of "Next: …"; so is a published comic's last one: "Read your comic", "Publish your changes"); any other stage opens its tab ("Open Pages") |

- Ink weights only: the current stage semibold, done stages ink, the rest muted. No hue, no spark, no wash, no price,
  and every target only navigates (the strip's `onGo`): nothing on the map can start a paid step.
- **From the strip**: the "Stage map" button opens it as a popover anchored to the button, a bottom sheet titled
  "Stage map" on phones. Focus lands on the current stage's target; a target closes the map and goes there; Escape or a
  click outside closes it and returns focus to the button.
- **From the side panel**: the five marks beside "This comic" are a disclosure ("Stage map", `aria-expanded`) that shows
  the map in place under the next step; in the phone drawer a target closes the drawer first.
- **Keyboard and screen readers**: an ordered list labelled "Stage map"; the current stage's row is `aria-current="step"`.
  The targets are native buttons in reading order; Arrow Up and Down (or Left and Right), Home and End move between
  them; Enter opens one. Each target is described by its row and its place ("Draw, now. 6 pages to draw. Opens the
  Pages tab.").

## 6. Key files and tests

- `shared/comic/stage.ts`, `shared/comic/stage.test.ts`: the model, every boundary (empty, older and partial docs,
  withheld, failed, drawing, redraw in flight, reused, stale, blank pages, draft and approved plans, published,
  published and behind (render rule and the server's view), paused, published with a new page, open approval, the
  Director planning at Style, an interrupted draft with and without pages), the summary round trip and validation.
- `components/comicstudio/board/boardModel.ts` `pageProgress` (+ test: a withheld picture is never ready),
  `conversation/DirectorDraftControl.tsx` (+ test), `conversation/ConversationPane.tsx` (`revealApiRef`),
  `conversation/cards/GateCard.tsx` (the open card is marked and focusable), `board/BoardPane.tsx` (`lead`, + test).
- `shared/comic/workspaceActivity.ts`, `server/src/comic/store.test.ts`: the saved summary.
- `services/comicWorkspaceActivity.ts` (+ test); the side panel's Your comics reads it (`components/comicstudio/panel/`,
  `comic-navigation.md`).
- `components/comicstudio/stage/StageStrip.tsx` (+ test: names, places, keyboard, announcement, no hue, the 360 px row
  and its opened stages, Escape from the stage button, forced-colour marks, 320 px, foldable, the server's "behind", one
  count with the Board badge, the Stage map button last), `stage/stageMarks.tsx` (the shared mark and place words),
  `stage/stageMapModel.ts` (+ test: a new comic, drawing with every kind of page, a comic planned before its look,
  partial and full plans, an open approval, ready and paused, published with and without changes, live with a new page,
  the strip's own next step), `stage/StageMap.tsx` (+ test: states and descriptions, keyboard, ink only, the popover's
  focus and Escape, a target closes it, the phone sheet, the panel's disclosure), `components/comicstudio/ComicStudio.stage.test.tsx` (the strip in the shell: the phone
  board placement, the approval and the draft focused on a desktop split, the Share sheet for a paused publication).

## 7. Left out on purpose

- My comics cards do not show the stage yet; they are the next reader of this summary (`stageSummaryOf`). The side
  panel's Your comics reads it already (SH-C1, `comic-navigation.md`).
- Counting a cast as a story (the Director's suggestions treat a cast as an idea): the brief defines Story by the story
  or premise, so a cast alone keeps Story current, with the words "No story yet".
- A "question waiting" next step: see §3.
- The stage map is not in the slim rail (open the panel), and it has no actions of its own: it shows the way, the
  places themselves do the work.
