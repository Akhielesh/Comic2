# Comic stages (Comic Studio)

**Status:** shipped. The studio shows it as a stage strip; the AI activity feed's "In progress" rows and My comics'
cards (`docs/features/my-comics.md`) read it from the saved summary.

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
- `services/comicWorkspaceActivity.ts` keeps a stored stage only when it validates. The AI activity feed's "In progress"
  rows show it ("Drawing · 6 of 12 pages drawn"); a comic saved before stages keeps "Last reported in progress".

No SQL for the summary itself: it lives in the existing `comic_docs.doc` jsonb, which the AI activity feed reads with
the existing `activity:doc->workspaceActivity` selector. My comics, which reads every comic of the account at once, reads
the same summary from `comic_docs.listing` instead, a small copy a trigger keeps in step with `doc`
(`server/sql/comic_docs_listing.sql`, `docs/features/my-comics.md` §1), so its read never opens a doc.

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
- The workspace navigation's list (`mobile/shell/WorkspaceNavigation.tsx`) is labelled "Board" (it was "Project
  stages"): those are the board's tabs, not the comic's stages.

## 6. Key files and tests

- `shared/comic/stage.ts`, `shared/comic/stage.test.ts`: the model, every boundary (empty, older and partial docs,
  withheld, failed, drawing, redraw in flight, reused, stale, blank pages, draft and approved plans, published,
  published and behind (render rule and the server's view), paused, published with a new page, open approval, the
  Director planning at Style, an interrupted draft with and without pages), the summary round trip and validation.
- `components/comicstudio/board/boardModel.ts` `pageProgress` (+ test: a withheld picture is never ready),
  `conversation/DirectorDraftControl.tsx` (+ test), `conversation/ConversationPane.tsx` (`revealApiRef`),
  `conversation/cards/GateCard.tsx` (the open card is marked and focusable), `board/BoardPane.tsx` (`lead`, + test).
- `shared/comic/workspaceActivity.ts`, `server/src/comic/store.test.ts`: the saved summary.
- `services/comicWorkspaceActivity.ts` (+ test), `components/comicstudio/home/ComicTaskActivity.tsx` (+ test).
- `components/comicstudio/stage/StageStrip.tsx` (+ test: names, places, keyboard, announcement, no hue, the 360 px row
  and its opened stages, Escape from the stage button, forced-colour marks, 320 px, foldable, the server's "behind", one
  count with the Board badge), `components/comicstudio/ComicStudio.stage.test.tsx` (the strip in the shell: the phone
  board placement, the approval and the draft focused on a desktop split, the Share sheet for a paused publication).

## 7. Left out on purpose

- The side panel's recent comics do not show the stage. My comics' cards and its Continue card do (SH-B,
  `docs/features/my-comics.md`): they read this summary in one list read and say the same words as the strip.
- Counting a cast as a story (the Director's suggestions treat a cast as an idea): the brief defines Story by the story
  or premise, so a cast alone keeps Story current, with the words "No story yet".
- A "question waiting" next step: see §3.
