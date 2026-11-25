# Comic stages (Comic Studio)

**Status:** shipped with SH-A ("Every comic knows its stage"). My comics (SH-B) and the side panel (SH-C1, SH-C2)
read the same model and summary.

**What it is for.** Every comic says where it stands, in one of five stages, how far along that stage is, and the one
next step: "Drawing · 6 of 12 pages drawn · Next: draw the rest". The studio shows it as a stage strip under the
header; lists read it from a small summary saved with the comic, so they never load a full comic to say it.

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
| Publish | `publication.status === 'live'`. A suspended publication is not published. |

**A drawn page** uses the progress card's rule, `progressState` in `shared/comic/renderOutcome.ts`:

- a picture the content check withheld never counts;
- a reused picture counts (the owner can be served it);
- an out-of-date (stale) picture counts (it is a picture; the Pages tab still flags it);
- a redraw or edit in flight, or a redraw that failed, keeps the earlier picture on the page, so it still counts. A
  first draw in flight or a failed first draw does not.

## 3. Progress and the next step

| Stage | Status word | Progress | Next step (place) |
| --- | --- | --- | --- |
| Story | Story | Not started | Tell the Director your idea (composer) |
| Style | Style | Not chosen yet · N looks to compare | Choose a look · Pick a look (Style tab) |
| Plan | Planning | No pages planned yet · The Director is planning · P of N pages planned · N pages planned | Plan the pages · Follow the Director (conversation) · Plan the rest · Review the plan (Pages tab) |
| Draw | Drawing | D of N pages drawn | Watch the pages draw · Review N withheld pages · Review N failed pages · Draw the pages · Draw the rest (Pages tab) |
| Publish | Ready to publish | All N pages drawn | Read and publish (Read tab) |
| (all done) | Published | All N pages drawn | Read your comic · Publish your changes (Read tab) |

Two waits come before the stage's own step, without moving the stage: an open approval ("Review the estimate", the
conversation) and an interrupted Director draft ("Resume the draft"). **The next step only navigates.** It carries no
action, so it never starts anything that spends, and it never shows a price. A question the Director is waiting on
is left to the conversation's own card and the summary's `attention` (reading it needs the settle index).

## 4. The saved summary (lists without full docs)

`summarizeComicWork` (`shared/comic/workspaceActivity.ts`) runs on every save (`server/src/comic/store.ts`
`storedOwnerDoc`) and now carries `stage: StageFacts`: the current stage, the done stages, page counts (pages, planned,
drawn, drawing, withheld, failed), drawn looks and the next-step key. Counts and keys only: no title, text, prompts,
prices, models or paths. It stays private: `sanitizePublicDoc` strips `workspaceActivity`, and the summary keeps
`v: 1` (the field is optional, so older readers ignore it).

- `readStageFacts(value)` validates stored JSON strictly: known stage and step keys, safe integer counts, counts within
  the page count, the current stage being the first one not done, done flags the counts agree with (Draw done only when
  every page is drawn), and a next step from the current stage. Anything else is `null`.
- `stageSummaryOf(value)` gives a list its line: "Drawing · 6 of 12 pages drawn", or **"Open to see"**
  (`STAGE_UNKNOWN`) for a comic saved before stages or with an unreadable stage. Lists never guess a stage.
- `stageView(readStageFacts(saved))` equals `comicStage(doc)` for the doc it was saved from (tested), so a list and the
  studio always say the same words.
- `services/comicWorkspaceActivity.ts` keeps a stored stage only when it validates. The AI activity feed's "In progress"
  rows show it ("Drawing · 6 of 12 pages drawn"); a comic saved before stages keeps "Last reported in progress".

No SQL: the summary lives in the existing `comic_docs.doc` jsonb, read by the existing
`activity:doc->workspaceActivity` selector.

## 5. The studio strip (`components/comicstudio/stage/StageStrip.tsx`)

- Mounted by `ComicStudioShell` under the header and its banners, before the workspace. `StudioHeader` is unchanged.
- A `nav` named "Comic stages" with an ordered list of five buttons. Ink only: the current stage is the heavier ink
  (`aria-current="step"`), a done stage gets a check (its name ends ", done"), the rest are muted. No hue, spark, wash
  or price.
- Each stage opens where it is worked: Story → Story tab, Style → Style tab, Plan and Draw → Pages tab, Publish → Read
  tab (the board is revealed on phones and in Chat-only splits). The "Next: …" button opens its place: a board tab, the
  conversation, or the composer (focused). Its description says where ("Opens the Pages tab").
- Keyboard: native buttons in reading order; ArrowLeft, ArrowRight, Home and End move along the steps. A screen
  reader hears a polite note when the stage changes, never on each page drawn (the run's own card covers those).
- Layout, always one row high so the conversation and the board keep their room (the layout smoke's phone-content rule:
  a phone's content keeps at least 45 % of the screen; a second row cost the conversation 41 %):
  - from 768 px: the five named stages, then the status and the "Next: …" button;
  - below 768 px (phones, small tablets, the first screen of a book-posture foldable): one 44 px row with 16 px gutters.
    A stage button shows the five stages as marks (a check when done, a heavier ink dot for the current one, a ring for
    the rest; named "Stages: Draw, 3 of 5 done") and opens the five named stages in a row below; choosing one, or
    Escape, closes them and returns focus to the stage button. Next to it, the status is one button: its first line is
    "Drawing · 6 of 12 pages drawn", its second "Next: draw the rest". Below 360 px a done stage in the opened row
    shows only its check, keeping its name for screen readers and as a tooltip.
  - Coarse pointers get 44 px targets. It hides while the on-screen keyboard is up (`html.kb-open`), like the tab bar.
    On phones the board's tabs live in a drawer, so the strip is also a quick way between Story, Style, Pages and Read.
- The workspace navigation's list (`mobile/shell/WorkspaceNavigation.tsx`) is labelled "Board" (it was "Project
  stages"): those are the board's tabs, not the comic's stages.

## 6. Key files and tests

- `shared/comic/stage.ts`, `shared/comic/stage.test.ts`: the model, every boundary (empty, older and partial docs,
  withheld, failed, drawing, redraw in flight, reused, stale, blank pages, draft and approved plans, published,
  published and behind, published with a new page, open approval, interrupted draft), the summary round trip and
  validation.
- `shared/comic/workspaceActivity.ts`, `server/src/comic/store.test.ts`: the saved summary.
- `services/comicWorkspaceActivity.ts` (+ test), `components/comicstudio/home/ComicTaskActivity.tsx` (+ test).
- `components/comicstudio/stage/StageStrip.tsx` (+ test: names, places, keyboard, announcement, no hue, the 360 px row
  and its opened stages, 320 px, foldable), `components/comicstudio/ComicStudio.stage.test.tsx` (the strip in the shell).

## 7. Left out on purpose

- My comics cards and the side panel: SH-B and SH-C1 build them on this summary.
- Out-of-date pages in the stage line: the Pages tab already counts them.
- A "question waiting" next step: see §3.
