# Settled cards (Comic Studio chat)

**Status:**
- **SETTLE-CORE (S2b) built the contract and the server stamps:** `shared/comic/settle.ts`, the gate outcome stamps in
  `server/src/comic/jobs.ts` and `server/src/comic/session.ts`, and the plan counts where `jobs.ts` posts a plan or
  breakdown card.
- **SETTLE-UI (S2b) builds the client on it and extends this page:** the settled row in `MessageItem` and
  `CardRenderer`, A1's queue reading `isOpenQuestion`, and the QA scene.
- **The director part was a wave note, applied at the S2b integration** (§5), after B-TOOL (which owns `director.ts` and
  `tools.ts` in S2) merged.
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
  The cards `tools.ts` (`render_pages` with nothing to draw) and `tools/breakdown.ts` post carry them too (wave note 3,
  applied at the S2b integration): `breakdownCardFor` stamps them, so `intents.ts` and `actions/breakdown.ts` get them
  through it.
- **Types without touching `doc.ts`.** `doc.ts` is frozen in S2, so:
  - `GateCardStamped` (`Extract<Card, {type:'gate'}> & { closed? }`) and `BookCardCounted` are declared in
    `settle.ts`;
  - they are read through `gateClosedOf` / `planCountsOf`, which validate (`isGateClosed`, `isPlanCounts`);
  - `normalizeCards` keeps gate, plan and breakdown cards exactly as stored.
  Folding the types into `doc.ts` waits for its next owner slot.

## 5. Server agreement (§5.7): applied at the S2b integration

`director.ts` belongs to B-TOOL in S2, which could not see `settle.ts`, so this was a wave note; the S2b integration
applied it after B-TOOL merged (`server/src/comic/director.settle.test.ts`). It applies when
`settledCardsOn(ctx.caps?.admin)` (the route's `recordOptionAnswer`, `runDirectorTurn`'s own fallback call and its
`conversationForDirector(..., { outcomes })`), so a viewer who still sees live cards keeps today's behaviour:
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
  A conflict card adds its outcome inside its bracket the same way.
- **dialogue_edit's confirm gate** (`tools.ts` `confirmAnswerOf`) still reads `card.answered` as choice ids, which
  `commitAnswer` keeps writing (B-TOOL wave note 10, checked at the integration).

## 6. Flags and decisions

- **`SETTLED_CARDS`** (`'off' | 'admins' | 'all'`, a code constant in `settle.ts`) is `'admins'` in S2. The client
  reads `studio.caps.admin` (`settledCardsOn`), so `capabilities.ts` is untouched. The S2 integration flips it to
  `'all'` after a week, and `'off'` is the kill switch.
- **The stamps are written for everyone.** They are data only, and the existing GateCard keeps reading `doc.gate`.
- **`SETTLE_COURTESY_MATCH = false`** (lead decision D14 at the S2b integration: it stays false; turn it on only after
  the admin week shows misses). settle.md D7 ("Noir ink, please" picks Noir ink: a courtesy suffix only, never a
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
