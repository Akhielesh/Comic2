# Settled cards (Comic Studio chat)

**Status:**
- **SETTLE-CORE (S2b) built the contract and the server stamps:** `shared/comic/settle.ts`, the gate outcome stamps in
  `server/src/comic/jobs.ts` and `server/src/comic/session.ts`, and the plan counts where `jobs.ts` posts a plan or
  breakdown card.
- **SETTLE-UI (S2b) built the client on it (§8):** the settled row (`cards/SettledCard.tsx`) chosen by
  `CardRenderer`, the settle index and prop wiring in `ConversationPane`, `MessageItem`'s compact rows, Assign on the
  latest message only, the fresh-only entrance (MO-2) and memoised rows (PF-7a), `GateCard`'s past tense from the
  stamp, A1's queue reading `isOpenQuestion`, and the QA scene `director-settled`.
- **The director part is a wave note to the S2b integration** (§5): B-TOOL owns `director.ts` and `tools.ts` in S2.
- **Plan:** PROGRAM3 §3.2 rows SETTLE-0, SETTLE-SRV and SETTLE-UI; the lens spec is `settle.md` (Program 3 audit).

**What it is for.** The owner: users "should not be able to view/edit those options once the chat has moved forward".
Before this, every card in every old Director message stayed live: option chips, "Approve & render all", paid
"More options" and "Draw N sheets", recap editors. An old tap could still start a turn or a spend.

## 1. The rule (lead decision D3, CHANGED)

- **A settled card has NO controls and NO "Show details".** It collapses to one line of words:
  - "You picked Noir ink";
  - "Not answered — you moved on";
  - "Approved · ≈2% of your usage · 6 images";
  - "Closed — a newer plan replaced it", and so on (§3).
- **A settled renders or media card** shows that line plus one plain link to where the pictures live: the board, a
  page, the cast, the style or Assets (the media tab's visible name). It mounts no `<img>`.
- **There is no details model** and no per-card browser storage.
- **Derived, not stored.** `cardSettle(doc, msgIndex, card, {pending})` is a pure function of the stored doc and this
  tab's sending message. A reload, a second tab and another device all agree. Legacy docs need no migration.

## 2. When a card settles (§5.1, §5.2)

- **passed(card):** a committed user message comes after the card's message, or this tab's message is sending.
  - A steered note (`Msg.steered`) is a user message, so it passes the cards before it.
  - A message that failed before the server took it passes nothing.
- **Exception, picked by sending:** if the sending message is this card's own answer, the card settles as `picked`
  (`pending: true`), not `skipped`. The answer is either:
  - the card the client named (`pending.card`), when the answer fits it;
  - or text that `matchChoices` finds on the most recent unanswered, not-passed options card.
  This mirrors what the server records.
- **A committed message never picks by text.** Only the server's `answered` does. Production's 10 unanswered cards
  stay "Not answered — you moved on", even where the next message happened to equal a choice.
- **Live views settle on "newer" too.** No later card may have the same kind key (`kindKeyOf`):
  - `plan` and a `breakdown` without `gateId` share `book`;
  - `style_choice`, `cast`, `recap`, `style_presets`, `share` and `renders` key by type;
  - the rest key by what they show: `refs:<owner>`, `versions:<target>`, `translation:<languages>` and
    `history:<view>`.
- **Never settled by passing:**
  - **an open gate** (`doc.gate.id === card.gateId`, status `open`): it is the one live approval, and the redesign's
    Approval bar mirrors it;
  - **a running render**: a target queued or rendering keeps live only the **latest renders card that includes
    it**. "Redraw page 1" or "Render all" never brings back every earlier renders card with those pages: an older card
    stays settled and its line counts them as "being redrawn";
  - **a running publish** (`status: 'running'`);
  - **an outage card with a waiting "wait and retry"** (`opts.retrying`, from `waitingRetries()`);
  - **the latest translation card** for its languages while the director works and an edition is unfinished
    (`opts.working`). An older card for an edition that never finished (failed, abandoned) stays settled.
- **States:** `open` (a question or approval to answer now), `live` (a current view), `settled` (the line). Outcomes:

| Card | Settles when | Outcome |
|---|---|---|
| `options` | answered, or passed | `picked` · `answered` (typed) · `skipped` |
| `conflict` (A3) | every item resolved, or passed | `resolved` · `left` (the creator's edit stands) |
| `gate` | its gate closes or is replaced | `closed` (the line reads the stamp, §4) |
| `breakdown` with `gateId` | its gate closes | `folded`: nothing renders, the gate's line covers it |
| book, `style_choice`, `cast`, `recap`, `refs`, `versions`, `share`, `history`, `renders` | passed, or a newer card of the kind | `passed` · `newer` |
| `style_presets` | also once `picked` | `picked` |
| `publish` | done or declined, or passed (never while `running`) | `done` · `passed` |
| `notice`, `model_outage`, unknown types | passed | `passed` |

## 3. The line (`summaryOf`)

- **Signature:** `summaryOf(card, doc, settle, cost)` returns `{ text, tone, link?, folded? }`, or null while the card
  is open or live.
- **Words only.** `tone` is `done` (a ✓: picked, approved, published), `quiet` (muted: skipped, closed, replaced) or
  `plain` (the card's own icon).
- **Prices go only through `cost`,** the viewer's formatter: the client's `conversation/cost.ts` `useCostFormat()` or
  the server's `costFormatter()`, which both have `approx`.
  - Governed users read a share of their usage, never `$` or `¢`.
  - Without a formatter the line names no amount.
- **Gate lines (bug B3).** A close the studio made never reads as the creator's "Not now":

| Stamp | Line |
|---|---|
| `approved` | "Approved · ≈ $0.42 · 6 images" (governed: "Approved · ≈2% of your usage · 6 images") |
| `declined` by the user | "Not now — nothing spent" |
| `declined`, by the system or unknown | "Closed — nothing spent" |
| `nothing_to_draw` | "Nothing left to draw — nothing spent" |
| `replaced` | "Closed — a newer approval replaced it" |
| `superseded` | "Closed — a newer request covered it" |
| `expired` | "Closed after a day — nothing spent" |
| none, and not the current gate (legacy) | "An earlier approval" |

- **Other lines:**
  - **options:** "You picked Noir ink and Crayon"; a typed answer reads "You answered “…”", clipped to 60
    characters at a word.
  - **conflict:** "Kept yours (2) · used the director’s (1)", or "Left as yours".
  - **book:** "Page plan · 12 pages · 38 panels" from the stamped counts. Legacy: "An earlier page plan". Replaced:
    "Closed — a newer plan replaced it".
  - **renders:** "Drew 6 pages and the cover · 1 didn’t finish · 1 being redrawn", tallied from current statuses:
    ready or stale counts as drawn; queued or rendering (a newer run is drawing it) reads "being redrawn"; failed,
    never started or gone reads "didn’t finish". When everything is busy again: "Being redrawn: 2 pages". The link is
    "Open the pages" (several targets, or the cover, which lives with the pages), "Open page 3", "Open the cast" or
    "Open the style".
  - **picture cards** (`versions`, `refs`, `style_choice`, `cast`) keep one link as well; photos and places open
    "Open Assets" (`open_tab: 'media'`). Every link is a `ClientAction` (`open_page`, `open_tab`): it changes nothing.
  - **notice:** its text (≤ 200 characters), plus "· 2 fixes offered".
  - **outage:** "{Model} was paused · 3 pages waited". No status fetch.
  - **publish,** by mode, never claiming a change that did not happen (no Copy link under D3):

| Mode | Done | Failed | Declined, or passed while pending |
|---|---|---|---|
| `publish` | "Published" | "Didn’t publish" | "Not published" |
| `update` | "Updated" | "Didn’t update" | "Kept the published version" |
| `unpublish` | "Unpublished" | "Didn’t unpublish" | "Still published" |
| `regenerate` | "New link made" | "Didn’t make a new link" | "Kept the current link" |

  - **unknown:** "Earlier card", never silent and never interactive.
- **Feature cards** may give their own words through `CardRegistration.settledSummary`
  (`components/comicstudio/extensions.ts`). It returns null to keep `summaryOf`'s line.

## 4. Server stamps (§5.6)

Two facts the live doc forgets are stamped on the card with `message_patch`. Each stamp is at most about 120 bytes.

- **The gate outcome, `closed`:** `{ status, by, usd?, imageCount?, model?, at }`.
  - `status` is one of `approved`, `declined`, `nothing_to_draw`, `replaced`, `expired` or `superseded`.
  - `by` is `user` only for the creator's own Approve and "Not now".
  - The quote (USD, image count, model clipped to 24 characters) is kept only for an approval.
- **Every gate write goes through `commitGate(ctx, gate, origin, write)` in `jobs.ts`.** It writes the `gate` op and,
  in the same commit, the stamp (`gateStampOps`):

| Site | Write | Stamp |
|---|---|---|
| `approveGate`, stale quote: re-quoted | close | `replaced`, by the system |
| `approveGate` | close | `approved`, by the user, with the quote |
| `approveGate` → `reopen()` (the run never started) | reopen | **cleared**, so it never reads "Approved" |
| `approveGate` → `close()` (nothing left to draw) | close | `nothing_to_draw`, by the system |
| `declineGate` (`decline_gate`: GateCard, the board, a chip the creator taps) | close | `declined`, by the user |
| `createGate` | open | the open gate it replaces: `replaced`, by the system |
| `startSpend`: a newer spend makes the gate moot | close | `superseded`, by the system |
| `startRecheck`: the same | close | `superseded`, by the system |
| `session.ts` `recoveryOps`: open for longer than `GATE_EXPIRY_MS` (a day) | (gate op + stamp) | `expired`, by the system |

  A gate card the conversation does not show yet (a director turn still collecting its cards) is not stamped.
- **Plan counts, `counts`:** `{ pages, panels }`, set by `withPlanCounts(card, doc)` where `jobs.ts` posts a book card:
  - the plan breakdown after `plan_pages`, and its unchanged-inputs reply;
  - the status breakdown of a "nothing to draw" reply.
  The cards `tools.ts`, `intents.ts`, `actions/breakdown.ts` and `tools/breakdown.ts` post get theirs by wave note.
- **Types without touching `doc.ts`.** `doc.ts` is frozen in S2, so:
  - `GateCardStamped` (`Extract<Card, {type:'gate'}> & { closed? }`) and `BookCardCounted` are declared in
    `settle.ts`;
  - they are read through `gateClosedOf` / `planCountsOf`, which validate (`isGateClosed`, `isPlanCounts`);
  - `normalizeCards` keeps gate, plan and breakdown cards exactly as stored.
  Folding the types into `doc.ts` waits for its next owner slot.

## 5. Server agreement (§5.7): wave note to the S2b integration

`director.ts` belongs to B-TOOL in S2, which cannot see `settle.ts`. The integration applies the following, with its
tests. It applies them when `settledCardsOn(ctx.caps?.admin)`, so a viewer who still sees live cards keeps today's
behaviour:
- **`answerByRef` returns `'kept'`** for a card whose message is followed by a user message. Nothing is written, and
  the message is handled as ordinary text, so an old tab can no longer reopen a settled question.
  (`recordOptionAnswer` runs before the user message is committed, so the current message does not count.)
- **`recordOptionAnswer`'s text match** considers only cards after the last user message (not passed), through
  `settle.matchChoices`. The director's own `normalizeAnswer` and `pickedChoices` are removed.
  `server/src/comic/settle.parity.test.ts` pins that both give the same ids today.
- **`cardText` adds the outcome** (`settle.outcomeForModel`): "[asked: … — options: …; no option picked]",
  "[asked: … — options: …; answered: Noir ink]", "[asked the user to approve a spend; approved]". "no option picked",
  not "skipped": the next message may still answer the question in free text ("the noir one"). An open card's outcome
  is empty and adds nothing. It names no amount: a governed user's director never sees a dollar figure to repeat.

## 6. Flags and decisions

- **`SETTLED_CARDS`** (`'off' | 'admins' | 'all'`, a code constant in `settle.ts`) is `'admins'` in S2. The client
  reads `studio.caps.admin` (`settledCardsOn`), so `capabilities.ts` is untouched. The S2 integration flips it to
  `'all'` after a week, and `'off'` is the kill switch.
- **The stamps are written for everyone.** They are data only, and the existing GateCard keeps reading `doc.gate`.
- **`SETTLE_COURTESY_MATCH = false`.** settle.md D7 ("Noir ink, please" picks Noir ink: a courtesy suffix only, never a
  fuzzy guess) has no recommended default. `matchChoices(card, text, { courtesy: true })` already does it, for when
  the owner decides.

## 7. Tests

- **`shared/comic/settle.test.ts`:**
  - heist-12p's `o1` settles as skipped;
  - the production-shaped fixture (10 passed option cards) is all skipped;
  - a tapped card is picked, and a sending message equal to a choice is picked (pending);
  - an open gate that was passed stays open, and a running render and a waiting retry stay live;
  - "Redraw page 1" keeps only the newest renders card live: the old one reads "· 1 being redrawn", never
    "didn’t finish";
  - only the latest translation card stays live while the director works;
  - a running publish stays live, and every publish mode reads honestly;
  - latest-of-kind works across plan and breakdown cards, and within one message;
  - an unstamped replaced gate reads "An earlier approval";
  - every gate line, and a governed line has no `$`;
  - `isOpenQuestion` equals A1's `openQuestion` on A1's cases;
  - the stamp size and guards.
- **`server/src/comic/jobs.gateClosed.test.ts`:**
  - approve stamps `approved` with the quote;
  - a new gate stamps the old card `replaced`, and a stale re-quote does too;
  - `nothing_to_draw` is stamped, and so is the user's "Not now";
  - a moot gate is stamped `superseded`, by a newer spend and by a confirmed re-check;
  - the reopen clears the stamp;
  - expiry stamps `expired`;
  - `plan_pages` posts counts, and so do its unchanged-inputs reply and a "nothing to draw" status breakdown.
- **`server/src/comic/settle.parity.test.ts`:** `matchChoices` equals the director's `pickedChoices`.

## 8. The client (SETTLE-UI)

### 8.1 Who sees it

- **Settled rows are behind `SETTLED_CARDS`** (`'admins'` in S2): `ConversationPane` builds the settle index only when
  `settledCardsOn(studio.caps.admin)`. Everyone else sees today's live cards, unchanged.
- **For everyone** (they change no card, only how the conversation is drawn and when the queue waits):
  - the fresh-only entrance (MO-2, bug B24) and the memoised rows (PF-7a, perf F9);
  - A1's queue no longer waits on a question the creator moved past (§8.6);
  - `GateCard`'s closed copy reads the stamp (§8.5), so a close the studio made never reads "Not now" (bug B3).

### 8.2 The row (`components/comicstudio/conversation/cards/SettledCard.tsx`)

- **Anatomy:** one row, 28 px high (44 px on coarse pointers), no `CardShell` frame, at the card's place in the reply.
  - A 14 px mark: a ✓ in `TONE_TEXT.success` for a `done` line (picked, approved, published); a muted dot for a
    `quiet` one (skipped, declined, closed, replaced); otherwise the card's own icon (options, gate, plan, renders,
    cast, style, recap, versions, photos, translation, publish, share, outage, History, notice).
  - The words from `summaryOf` (`settledSummaryFor` adds a feature card's own `settledSummary` words), 13 px,
    `--ds-ink`, or `--ds-muted` for a quiet line. They wrap at any width. A notice's words clamp to 2 lines
    (`line-clamp-2`, §5.2), so an old error stays a compact log line at 320 px; the words stay whole for screen
    readers. Every other line wraps whole.
  - **At most one plain link**, for renders and picture cards: "Open the pages", "Open page 3", "Open the cast",
    "Open the style", "Open Assets". It is an `<a>` whose click runs the controller's `runClientAction` (`open_tab`,
    `open_page`): navigation only, never a change. Without a controller to run it, the link is left out.
- **Never a control:** no `<button>`, input, toggle or "Show details" (D3). Nothing is `disabled` or `inert`; there is
  nothing to disable. A settled card mounts no `<img>`.
- **Accessibility:**
  - the row carries `aria-live="off"`, so collapsing old cards when the creator sends is not announced by the log
    (`role="log"`, `aria-live="polite"`, `aria-relevant="additions"`);
  - an error notice keeps `role="alert"` only while unsettled: a settled notice is its row, so a reload never
    re-announces an old error;
  - **focus on settle:** when focus was inside the live card as it settled (the creator just tapped an option, its
    button is gone), the summary takes focus (`tabIndex=-1`, `preventScroll`), so a screen reader hears "You picked
    Noir ink" instead of losing focus to the page. It shows `FOCUS_RING` (`:focus-visible` only): a keyboard user who
    picked with Enter sees where focus went and Tabs on from there (WCAG 2.4.7); a tap never rings it. A card that
    mounts already settled, or settles while focus is elsewhere, never takes it;
  - no animation on the row; the link's hover ink is `motion-reduce:transition-none`.

### 8.3 Choosing live or settled (`CardRenderer`)

- With a `settle` from the index and `state === 'settled'`, `CardRenderer` renders `SettledCardView` and **never
  mounts the live component**: no option chips, "Approve & render all", paid "More options" or "Draw N sheets", no
  render thumbnails or their signing requests, no History fetch (`HistoryCard`), no model-status request or 60 s
  re-check (`useModelStatus`), no per-revision `summarizeBook` / `quoteRenderPages` / `applyOps` in old notices.
- A gate's own breakdown (`outcome: 'folded'`) renders nothing and takes no room: the gate's line covers it.
- A card type this client does not know reads "Earlier card": never silent, never interactive.
- Without a `settle` (SETTLED_CARDS off, older hosts, tests that render a card alone) every card renders live,
  exactly as before.
- The error boundary starts over when a card settles (it is keyed on live/settled), so a live card that failed still
  gets its one line instead of "This card couldn't be shown" for ever.

### 8.4 The conversation (`ConversationPane`, `MessageItem`)

- **The index:** `buildSettleIndex(doc, { pending, retrying, working })`, memoised on the doc revision, this tab's
  pending message, the waiting "wait and retry" intents (`reliability/retryIntents.ts`, local memory only, through
  `useSyncExternalStore`) and whether the director is working. Each reply gets the index; each card its settle.
- **Picked at once:** tapping an option sends the answer with the card's ref; the pending message is "sending", so the
  card reads "You picked Noir ink" in the same tick, before the server has the message, and its chips are gone. Any
  other message the creator sends passes the card: "Not answered — you moved on".
- **Compact log:** consecutive settled rows in one reply stack 4 px apart (`data-settled-slot`), not the reply's
  12 px; live cards keep 12 px.
- **Assign:** the user bubble's "Unassigned · Assign" and the per-photo assign button show on the latest committed
  user message only (none while this tab's message is sending). An older unfiled photo reads "Not filed yet".
- **Fresh-only entrance (MO-2; styles.md M3 with C17):**
  - the pane seeds, once per doc, the newest server `at` present on its first render (`seedEntrances`, a module-level
    map in `MessageItem`). Only a message whose `at` is newer rises in: the server clock on both sides, so a device
    clock that is off changes nothing;
  - this tab's sending bubble and a reply streaming in before it is committed rise as they appear; their committed
    copies (the same id, or the same words for the bubble) never rise a second time, and a remount never replays;
  - a fresh user message gets `ds-rise-in`; a fresh reply's column gets `ds-stagger`, so its words and first 12
    cards arrive one after another. `styles/ds-motion.css` turns both off under reduced motion;
  - the old `studio-reveal` on every row and card (which replayed on every mount) is gone.
- **Memoised rows (PF-7a; perf F9):** the pane renders `UserMessageRow`, `AssistantMessageRow` (React.memo) and
  `PendingMessageRow`. `useRowStudio` keeps the controller's identity while only `drafts` changes, so a token delta
  re-renders only the row it streams into. Any other change (a doc revision, busy, caps, …) is a new controller and
  re-renders every row, so the memo never hides fresh state.

### 8.5 `GateCard`'s past tense

The live `GateCard` (settled cards off, or a gate card rendered alone) reads a closed gate's sentence from the stamp
(`gateClosedCopy`):

| Stamp | Sentence |
|---|---|
| `declined` by the user | "Not now — nothing was spent." |
| `declined` by the system | "Closed by the studio — nothing was spent." |
| `superseded` | "Closed — a newer request covered it. Nothing was spent here." |
| `expired` | "Closed after a day without an answer — nothing was spent." |
| `nothing_to_draw` | "Nothing left to draw — nothing was spent." |
| `replaced` | "This approval was replaced by a newer one." |
| `approved`, and a newer gate followed | "Approved · ≈ $0.42 · 6 images." (governed: a share of their usage) |
| `approved`, still the current gate | "Approved — drawing now." (as before) |
| no stamp (older cards) | today's words |

### 8.6 A1's queue

`messageQueue.openQuestion(doc, pending?)` is `settle.isOpenQuestion`, and `holdReason` takes an optional `pending`.
A question the creator moved past (their message committed after it, or this tab's message sending) no longer holds
Up next. Before, a director turn that ended without a reply left the old question holding every note behind "Answer
the question above first". On a reply nobody answered or passed it is exactly A1's rule.

### 8.7 QA scene

`qa/app/scenes/director-settled.tsx`, as an admin (`caps.admin`) over the QA controller:
- **`?surface=app&scene=director-settled`** (what the DS-1b layout smoke measures): the reply column, through the
  pane's own rows and the same settle index, on heist-12p plus three more turns a little later
  (`directorSettledHistoryDoc`): "Render all" approved and stamped, every page done, the cover question answered.
  Every card is its line: an unanswered question, a replaced plan, an approval with its quote, a resolved conflict,
  renders tallies with their link, notices, the recap, picked answers.
- **`…&pane=1`**: the same chat one step earlier (`directorSettledDoc`) in the real `ConversationPane`: the old
  cards are lines while the open "Render all" gate, the running renders and the last question stay live.
- The smoke runs `--grep @app` at 320 to 1440 px, light and dark. The pane view is for a manual look: its live cards
  and composer are the studio scenes' to measure (two pre-existing findings there are wave-noted: the stale render
  tile's accessible name, and `transition-all` controls under the skin's reduced-motion check).

### 8.8 Tests (each fails without the client code; mutation-proven)

- `conversation/MessageItem.settle.test.tsx`: heist-12p has no enabled control inside any settled card (control:
  with settled cards off, o1 keeps its tiles and Done); the long chat keeps the open gate, the running renders and
  the open question live, mounts no image in a settled row, and reads the stamped approval, the answer and the
  conflict; the QA scene's history is settled rows only; rows are `aria-live="off"` and stack 4 px apart; Assign only
  on the latest user message, and on none while this tab's message is sending.
- `conversation/ConversationPane.live.test.tsx`: through the pane's own wiring, a waiting "wait and retry" (armed
  through the retry store) keeps its passed outage card live with "Don't retry", and cancelling it settles the card;
  the real flow (tap "Wait and retry", then send something else) keeps the cancel; a translation stays live while
  the director works and settles once it stops.
- `conversation/cards/CardRenderer.settle.test.tsx`: a settled renders card mounts 0 `<img>` and keeps one link; a
  settled history card makes no `api.list` / `api.compare` call; a settled outage card makes no status request;
  `role="alert"` only while unsettled; a notice clamps to 2 lines; folded breakdowns, unknown types, governed gate
  lines, feature words.
- `conversation/cards/CardRenderer.boundary.test.tsx`: a live card that threw reads its settled line once the chat
  moves past it.
- `conversation/cards/SettledCard.test.tsx`: the marks and inks, no control and one link, no animation, the 28 px row
  and its 44 px coarse target (row and link), only a notice clamped, and the focus hand-off (to the summary,
  `preventScroll`, with a focus-visible ring; never stolen).
- `conversation/cards/OptionsCard.settle.test.tsx`: a tap reads "You picked …" before the server answers; multi-select
  and typed answers; any other message reads "Not answered — you moved on"; with the flag off, today's locked chips.
- `conversation/cards/GateCard.stamp.test.tsx`: the stamp's past tense; a studio close never says "Not now".
- `conversation/MessageItem.entrance.test.tsx`: 20 stored messages give 0 animated nodes and a new one gives 1; a
  fresh row keeps its class when it re-renders mid-animation; the server clock decides; no replay on remount; the
  sent bubble and a streamed reply rise once.
- `conversation/ConversationPane.memo.test.tsx`: a token delta re-renders only the streaming row and no user row
  (flag on and off); a doc revision still re-renders.
- `messageQueue.test.ts`: a passed card does not hold the queue.

### 8.9 Decisions recorded here (lead decision D3, CHANGED)

- **No "Show details", no details body, no `settledDetails.tsx`**, so the row's "except Show details", "lazy width-160
  images once opened" and "static option visuals" tests fall away (s2b-collisions C-6).
- **No Copy link on settled publish and share rows**: D3 says no controls; the line says what happened, and the live
  Share sheet keeps the link.
- `OptionsCard`, `NoticeCard` and `ConflictCard` needed no edit: a settled card never mounts them, so the options
  card's locked state, the notice's live region and A3's resolve buttons simply are not there once settled.
- `GateCard`'s "embedded breakdown only while open" was already true (settle.md V.5).
- **One test edit outside the row's Owns:** `conversation/registryCards.test.tsx:47` finds a registry card's slot by
  `[data-card-slot]` instead of `[data-role="assistant"] .studio-reveal`, because MO-2 removes the replaying
  `studio-reveal` class from card slots. One selector, no assertion changed; no other S2a or S2b package touches the
  file. Recorded for the S2b integration.
