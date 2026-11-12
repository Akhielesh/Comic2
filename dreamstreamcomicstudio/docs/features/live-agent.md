# Live agent: queue, steering and conflicts (Comic Studio)

**Status:**
- **Wave 0 landed (2026-11-04).** The contract, the flags and every seam, as stubs with their final names.
- **Wave 1 (S1) is integrated on `integ/s1`:**
  - A1 QUEUE: the "Up next" queue;
  - A2 TURN: the turn reservation, `POST …/steer` and the director's steer rounds;
  - A3 CONFLICT: the conflict guard, the conflict card, the DECIDED line and the contradiction questions.
- **Each part sits behind its flag (§1).** Flag defaults are unchanged, so steering stays off. The queue and the conflict guard are on for admins only.
- **Wave 2 (S2), A4 STEER-UI + PRESENCE (`live/a4`):** presence, set from `activity.where` and shown on the activity line
  and to the editor (§3.1); the "Send now" steer path checked against A2's refusal table (§3.2). It has no flag of its
  own and stays invisible until a server sends `where`.
- **Wave 2 (S2), B-TOOL (`live/b-tool`):** the dialogue writers call the guard (§5), and the director's tool activity
  carries `where` (§3.1). PE-SHELL and PE-INSPECT build the editor outline and the Layers badge that read presence.
- **Plan:** the agent-editor plan, Track A (§3), waves (§4), flags (§5).

**What it is for:** the creator keeps working while the director works.
- Notes typed during a turn are queued, not lost.
- "Send now" can steer the running turn.
- When the creator and the director change the same thing mid-turn, the creator's edit wins and the director asks
  instead of overwriting.

## 1. Flags (stage defaults)

Each flag is a rollout stage, `off` | `admins` | `all`. `server/src/comic/access.ts` reads it once per request into the
studio caps (`studioCapsFor` → `liveCapsFromEnv`, `shared/comic/capabilities.ts`). The client reads only the caps
(`liveQueueOn`, `steerOn`, `conflictGuardOn`), never env. Parsing, synonyms and rollout criteria are in
`docs/infrastructure/ENV_MATRIX.md`, under "Comic Studio: live agent, dialogue, Pro editor v2".

| Env var | Cap | Default (unset) | Turns on |
|---|---|---|---|
| `COMIC_LIVE_QUEUE` | `caps.liveAgent.queue` | `admins` | The visible "Up next" queue (A1, §4) |
| `COMIC_STEER` | `caps.liveAgent.steer` | `off` | `POST …/steer`, so "Send now" joins the running turn (A2, §3). Off: the route answers 501 `NOT_AVAILABLE`, whatever the body |
| `COMIC_CONFLICT_GUARD` | `caps.liveAgent.conflicts` | `admins` | The conflict guard, the conflict card's answers, the DECIDED line and the contradiction questions (A3, §5) |

- A bare switch (`on`, `true`, `1`, `yes`) means admins only. Everyone needs an explicit `all`.
- An older server sends no `liveAgent` caps, which reads as off.
- With A1 and A3 built, the `admins` defaults mean admins get the queue and the guard as soon as this ships. Set
  `off` to keep either one dark.
- **What admins see on the first S1 deploy** (non-admins see neither): Up next (A1), and A3's director prompt changes in
  every turn: the DECIDED line, the ask-once rule (`CONFLICT_PROMPT_LINE`) and the four contradiction questions, so the
  director can ask Keep/Change questions it never asked before. Conflict cards cannot appear yet: no writer calls
  `guardUserEdits` until B-TOOL. To ship S1 with the director prompt unchanged, set `COMIC_CONFLICT_GUARD=off` (and
  `COMIC_LIVE_QUEUE=off` for nothing but DS-R0 visible) in the backend env for that deploy: an env change, not code.
- None of this spends: no part makes a model or image call of its own, and nothing bypasses the spend gate. The one
  exception is the steer screen, which is the capped safety classifier a chat message also gets.

## 2. The contract (wave 0) and who filled it

**Contract (`shared/comic/**`, all optional and additive; old comics normalize to the same object):**
- `events.ts`:
  - `SteerRequest {text, focus?}` and `SteerResponse {ok, msgId}`;
  - `STEER_LIMITS {inbox: 3, extraRounds: 2, whereLines: 20, noteChars: 6000}`;
  - `ActivityWhere` on the `activity` event (`where?: {pageId?, lineIds?}`);
  - `NOT_RUNNING` in `STREAM_ERROR_CODES`.
- `doc.ts`:
  - `Msg.steered?: true`;
  - the `conflict` card (`ConflictCard`, `ConflictItem`, `ConflictWhere`), `CONFLICT_LIMITS` and `normalizeConflictCard`;
  - `OptionVisual` `balloon` and `spot`, for pictures in questions.
- `ops.ts`: the free `resolve_conflict` action `{cardId, itemIds, choice: 'mine' | 'theirs'}`, in
  `NON_SPEND_ACTION_TYPES`.
- `conflicts.ts`: `EntityKey`, `entityKeys(op)` and `collidingKeys(a, b)`. A3 fills it with these keys:
  - `line:<id>`: words, kind, speaker, language;
  - `balloon:<id>`: the balloon box;
  - `lstyle:<id>`: the line's own style;
  - `panel:<id>`;
  - `order:<panelId>`: line order;
  - `letter:preset`, `letter:base`, `letter:kind:<kind>`, `letter:speaker:<id>`, `letter:margin`, `letter:auto`.

  Two of them are reset wildcards. `letter:*` collides with every `letter:` key. `letter:kind:*` (a preset switch
  without `keepOverrides`) collides with every `letter:kind:` key. Two balloons on one page never collide.
- `capabilities.ts`: `LiveAgentCaps`, `FlagStage`, `LIVE_FLAG_ENV`, `LIVE_FLAG_DEFAULTS`, `parseFlagStage`,
  `stageAllows`, `liveCapsFromEnv` and the readers.

**Server seams (A2 and A3 filled them in place):**
- `session.ts`:
  - `takeSteer()`, `pushSteer()`, `steerRefusal()`, `holdSteerSeat()`, `openSteer()`;
  - `reserveTurn()`;
  - `recentCommits(sinceRev)` and `recentCommitsComplete(sinceRev)`;
  - `RECENT_COMMITS_MAX = 300` and `RECENT_COMMITS_BYTES = 1_000_000`;
  - `LONG_MESSAGE_CHARS`;
  - the `takeSteerOf` / `openSteerOf` / `recentCommitsOf` helpers.
- `director.ts`:
  - `turn.startRev = doc.rev` at the start of a turn;
  - the steer drain points and extra rounds (§3);
  - `steerNoteText` and `unreadSteerReply`;
  - `conflictCardFor(turn)` after the loop, on a Stopped turn too;
  - the DECIDED line and the prompt rule while the guard is on (§5).
- `conflictGuard.ts`: `guardUserEdits`, `conflictToolNote`, `recordConflicts`, `conflictCardText` and `conflictCardFor`.
- `actions/conflict.ts`: `resolve_conflict`.
- `decided.ts`: `decidedLine`, `CONFLICT_PROMPT_LINE`.
- `replies.ts`: the four contradiction gaps.

**`reserveTurn` closes the BUSY race (G19) whatever the flags.** The stream route reserves the turn synchronously,
before its first await. A second message therefore answers BUSY instead of starting a second turn. The release is
idempotent, and it runs on every refusal or failure before the turn takes the lock.

**Client contract (`components/comicstudio/`):**
- `SendOutcome`: `'sent' | 'queued' | 'held' | 'refused'`;
- `StudioPresence`;
- `StudioController.send`, which returns `Promise<SendOutcome | void>` (void reads as `'sent'`);
- the optional `StudioController.presence`;
- the queue members of `StudioController` (§4);
- `asCaps`, which reads `liveAgent`: only a literal `true` turns a part on.

## 3. Steering a running turn (A2; `COMIC_STEER`)

**`POST /api/comic/projects/:id/steer` with a `SteerRequest` (`server/src/routes/comic.ts`).**
- The text is trimmed and screened like a chat message.
- With a director turn running, the note goes on the session's inbox. It is committed as a user message with
  `steered: true`, which reads "Added while the director was working" on the stream's `ops` event.
- The answer is a `SteerResponse` with that message's id.
- Every refusal keeps the note, and nothing is committed.

| Code | Status | When |
|---|---|---|
| `NOT_AVAILABLE` | 501 | Steering is off. Checked first, whatever the body. The client then takes D2: Stop, then send |
| `BAD_REQUEST` | 400 | Empty text or a malformed focus |
| `LIMIT` | 409 | Over `STEER_LIMITS.noteChars` (6000) characters. A long note goes as its own message, where a pasted script is saved as the source |
| `NOT_RUNNING` | 409 | No director turn reads the inbox. This covers the reserve, upload and screen phase before the first model call, and a turn that ended while the note was being screened |
| `BUSY` | 409 | The notes waiting plus the notes being screened already reach `STEER_LIMITS.inbox` (3) |
| `COOLDOWN` | 429 | The account is in a safety cooldown |
| `CONTENT_POLICY` | 422 | The screen blocked the note. Nothing is committed |

- **Seats.** `holdSteerSeat()` holds an inbox seat through the cooldown lookup and the screen. At most 3 notes per
  session are being screened or waiting, however many requests arrive at once. A note nobody will read is never
  screened.
- **The push decides the commit.** Push and commit are one synchronous step. A note is committed only once the running
  turn holds it, so every committed note is one the turn will read or answer for.
- **One number.** `LONG_MESSAGE_CHARS` (`session.ts`, = `STEER_LIMITS.noteChars`) is shared by three limits:
  - the pasted-script threshold;
  - the steer note cap (`MAX_STEER_CHARS`);
  - the longest text a "Send my note" chip says.
- **The director (`director.ts`):**
  - It drains the inbox after each tool round, before its next model call, into one user message:
    `(The user added while you were working:) …`. Several notes are numbered. Each note brings its Focus line and its
    safety note.
  - A note that arrives at the tool cap, or during the final answer, buys an extra round. There are at most
    `STEER_LIMITS.extraRounds` (2) extra rounds per turn, and each allows one more tool round. A turn therefore has at
    most `MAX_TOOL_ROUNDS + 2` tool rounds.
  - With no extra round left, the note stays unread. A turn that ends on a question (`ask_user`) never takes a note.
- **Unread notes are answered for.** This covers a turn that ended, a question, a failure, a Stop, and a crash after
  the loop.
  - The reply gets one honest line and plain `say` chips: "Send my note", or "Send my notes" when the combined
    message fits 6000 characters. Otherwise there is one "Send note N" chip per note.
  - The note chips go first. The exception is an outage or R5 turn, where they follow the first outage chip.
- **The recent-commit ring.** It keeps the last 300 commits, bounded at 1 MB of ops; the newest commit is always kept.
  `recentCommitsComplete(sinceRev)` says whether the ring still covers a turn.
- **Presence (A4, wave 2):** `activity.where` names the page and at most `STEER_LIMITS.whereLines` (20) line ids the
  running tool is changing. The client side is built (§3.1); the server emit is B-TOOL's (`director.ts`, the two tool
  activity emits).

### 3.1 Presence: where the director is working (A4)

**What the creator sees.** While a director step names its place, the live activity line says it in words beside the
step: "Moving a balloon… page 2 · 1 balloon". The page editor outlines those balloons ("Director is editing this
balloon") and the Layers panel badges them; those two read `StudioController.presence` and are PE-SHELL's and
PE-INSPECT's. A step that names no place reads exactly as before.

**What the server sends (B-TOOL, wave 2).** The activity start and end events carry where {pageId, lineIds} (at most
STEER_LIMITS.whereLines) from activityWhere (server/src/comic/tools.ts), for set_line, edit_panel_text, dialogue_edit,
arrange_balloons, restyle_balloons and edit_page.

**The state (`studioReducer.ts`).** A `presence` slice of live entries, newest last, at most `MAX_PRESENCE` (8):
- **Set** by an `activity` start whose `where` names something. `presenceWhere` keeps the page id and at most
  `STEER_LIMITS.whereLines` (20) distinct line ids; ids that are not short strings are dropped. A `where` that names
  nothing usable is the same as none.
- **Cleared** by that activity's `end` (whichever stream delivers it), by its stream's `done` or `error`, by the stream
  closing without one (a dropped connection), and by Stop (`cancel_start`, before the streams close). A project switch
  starts empty.
- **Not set while Stop winds down.** A start that arrives after Stop and before the server sees the cancel (about one
  round trip) names no place, so the editor outline never shows while the activity line says "Stopping…". An end still
  removes its entry. Once Stop is over (`cancel_end`), new starts set it again.
- **Many streams.** Every open stream receives every session event, so one start can arrive twice. An entry lives until
  every stream that delivered its start has finished. A second message refused BUSY (another tab) also saw the start;
  its error does not clear the running turn's presence. A stream that never saw the start never clears it.
- **Shown:** `presenceOf(state)`, the newest live entry or null. It is the same object while the entry lives, so the
  panes that read it do not re-render for nothing.

**The controller (`useStudio.ts`).** `presence: StudioPresence | null`, with `{pageId?, lineIds, label, at}`
(`types.ts`). `label` is the step's label and `at` is when it started. It adds no timer and no fetch; a fake-timer test
pins that.

**The words (`studioReducer.ts`, shown by `conversation/ActivityLine.tsx`).** `presencePlace(doc, presence)` is pure and
sits beside the slice, so the board imports it without a conversation component (`ActivityLine.tsx` re-exports it).
It gives "page 2 · 1 balloon", "page 2" or "3 balloons". The page comes from the page id, or else from the page that
holds the first known balloon. A page the doc does not have yet is left out, never guessed. The words sit beside the
line the place came from, matched by label. They never sit beside a newer job's line ("Drawing page 3…"); in that case
they show on their own row under "+N". They are muted, visible text only, so the phone View button's name still starts
with what it shows. While Stop winds down, no place is named.

**For the editor (PE-SHELL, PE-INSPECT).** Read `studio.presence` (optional on the type: absent or null means nobody is
anywhere). Outline the balloons in `lineIds` on the page you show. `pageId` may be absent, and the line ids alone
identify the balloons. Reuse `presencePlace` from `studioReducer.ts` for words. Never treat it as a lock: the creator
can still edit the balloon, and the conflict guard (§5) settles a collision.

### 3.2 "Send now" with steering on: the path as built (A4 check)

S1 built the client half of steering; A4 checked it against A2's refusal table (§3) and its tests
(`useStudio.queue.test.tsx`):
- `useStudio` steers through `studioApi.steerStudio` (`DEFAULT_STEER`). It does so only while
  `caps.liveAgent.steer` is on (`COMIC_STEER`), which is off by default.
- `NOT_RUNNING`, `BUSY` and `LIMIT` put the note first in Up next without stopping the director. So does a note over
  `STEER_LIMITS.noteChars`, which never tries to steer. `COOLDOWN` keeps the note in its place. `CONTENT_POLICY` keeps
  it, with the reason. `NOT_AVAILABLE` and other failures fall back to D2 (Stop, then send) with a calm notice.
- A4 added two cases that were not yet covered. A note with photos stops the director instead of steering, because a
  steer carries text only. A `plan_pages` run is neither steered nor stopped; the note goes the moment the plan is in.
- **One fix (`QueuedMessages.tsx`).** After a refusal that keeps the director working, the note's button read
  "Stopping, then sending…" while nothing stopped. It now reads "Goes next, after this step". During a `plan_pages`
  run (the turn is locked, no message in flight) it reads "Goes once the plan is in", as its tooltip says, not
  "Sending next…" for the whole plan. "Stopping, then sending…" shows only while a Stop is really under way.

## 4. Up next: the message queue (A1; `COMIC_LIVE_QUEUE`)

`components/comicstudio/messageQueue.ts` holds the pure helpers. The state lives in the `studioReducer.ts` queue
slice, the logic in `useStudio.ts`, and the UI in `conversation/QueuedMessages.tsx`.

**`send()` outcomes.**
- `'sent'`: the stream started.
- `'queued'` / `'held'`: the note went to Up next.
- `'refused'`: nothing was sent or queued, and the composer keeps the draft.
- With the queue off, a send while a turn is in flight is `'refused'`: nothing is sent or queued, and an info notice
  says why (`BUSY_REFUSED_COPY`: "The director is still working on your last message, so this one is waiting in the
  message box. Send it when it finishes.").
- Three board call sites hand a refused text back to the message box with `keepRefusedInComposer`
  (`conversation/composerBus.ts`): the page editor's Ask AI, and "Write page N" in Pages and in the timeline. These
  are the only senders that reach the refusal: the composer's own Send is disabled while the director works. Before
  S1 those words were dropped without a word; on a phone the studio now switches to the chat, and the notice says
  why.

**The drain (D1).** When the reply lands, the notes go as ONE message: `(Sent while you were working:) 1. … 2. …`.
- A batch is split only by differing focus, or where it would pass a cap:
  - two or more notes join only up to 6,000 characters (`QUEUE_PASTE_CHARS`, the same number as
    `STEER_LIMITS.noteChars`). That is the server's pasted-script threshold (`LONG_MESSAGE_CHARS`): it saves any
    longer message as the comic's source script, replacing the one there, and the chat keeps only a stub;
  - 12 photos per message.
- A single note whose prefixed text would pass 6,000 characters (a deliberate long paste, or a full message requeued
  after BUSY) drains without the prefix, exactly as it would outside the queue: the saved script is the creator's own
  words.
- A note holds at most 59,969 characters (`QUEUE_NOTE_MAX_CHARS`), inside the server's 60,000-character message cap.

**Holds.** Every hold shows a line; none is silent (`holdLine`).

| Hold | Line | Way out |
|---|---|---|
| Stop | "Stopped. N notes are waiting." | Send now · Clear |
| A reload | "N notes were waiting." | Send · Clear |
| A failed message | "Your last message didn’t go. Try again or dismiss it first, or" | Send anyway |
| `plan_pages` | "Planning the pages — these go once the plan is in." | — |
| An open question or spend gate | "Answer the question above first, or" | Send anyway |
| BUSY from another tab or device | "The director is busy in another tab or on another device. Trying again shortly." | Try again |

- **Reloads.** A restored queue is held and never auto-sent.
- **A failed message.** Try again goes before the notes, and Dismiss releases them. Send anyway, or Send now, first
  puts the failed words back in the message box ("Your message that didn’t go is back in the message box.").
- **BUSY.** The retries come at 8, 20 and 45 s (`QUEUE_RETRY_MS`; bounded, never an idle timer). After that the line
  reads "Still busy in another tab or on another device." with Try again.
- **A Stop hold with nothing waiting** ends with the turn it stopped.
- **Storage.** The queue is saved per project in `sessionStorage` under `comicstudio.queue.v1.<projectId>`, with
  every access in try/catch.

**Refusals, always with a notice:**
- Up next is full (10 notes);
- a note that is too long, or has more than 12 photos;
- script files or photos that didn’t upload (inline files cannot wait);
- a card answer while the turn is locked: "Answer that question once the director finishes this step.".

On a free turn, an options-card answer always goes out, even while notes wait. `OptionsCard` is disabled on
`studio.turnLocked ?? studio.messageBusy`. When an answer is refused, the card opens again and a typed answer goes
back in its box.

**Send now** moves the note to the front (`queue_express`).
- On a free turn it goes at once.
- While a director turn runs, with steering on and a note with no photos, it steers (§3). The refusals keep the note:
  - `NOT_RUNNING`, `BUSY`, `LIMIT`, or a note over `STEER_LIMITS.noteChars` (which never tries): the note goes first,
    as a message, when the turn ends, and the director is not stopped. BUSY and LIMIT say why;
  - `COOLDOWN` shows the message and keeps the note in its place;
  - `CONTENT_POLICY` keeps the note with the reason.
- While its steer call is open, the drain leaves that note out (`steeringRef` in `useStudio`). The turn can end before
  the call answers (the server pushed the note during the final answer), and the note must not also go as a new
  message. The answer decides: 200 removes it from Up next; `NOT_RUNNING`, `BUSY` or `LIMIT` send it once, as the next
  message; after `COOLDOWN` or `CONTENT_POLICY` it drains like any other note once the turn is free.
- `NOT_AVAILABLE` and any other failure fall back to D2 with a calm notice: "Couldn’t add it to this step, so the
  director stops and it goes next.".
- Steering off, or a note with photos: D2, which means Stop the director, then send.
- A `plan_pages` run is never stopped from here.
- The tooltips:
  - "Adds it to what the director is doing now";
  - "Send this note now — the director stops its current step first";
  - "Sends it as soon as the plan is in";
  - "Send this note now".

**Chips.** While the director works, the latest reply's chips stay visible. A text chip tapped then goes to Up next,
and an action chip waits for the turn lock.

**Controller members:** `queue`, `editQueued`, `moveQueued`, `removeQueued`, `sendNow` and `queueSteers`.
- `queueSteers` is true when the queue is on, `caps.liveAgent.steer` is on and a steer call exists. `useStudio`
  defaults that call to `studioApi.steerStudio`.
- The QA harness has a `queued` state (`testing/qaController.ts`) for screenshots of Up next, and a `conflict` state:
  a two-item conflict card (a balloon both sides changed, and a panel description too big to keep, "…and 2 more") on
  the last reply, with the conflict guard on (`qaConflictCard`). S1 measured it, with `share=live` and
  `share=live-public` (the Share sheet's link-first block), at 320 and 360 px with touch, reduced motion on and off: no
  horizontal overflow, every button and link at least 44 × 44 px, no request left the harness.

## 5. Conflict cards and the contradiction questions (A3; `COMIC_CONFLICT_GUARD`)

**The guard (`server/src/comic/conflictGuard.ts`).**
- A director write first asks `guardUserEdits` which of its planned ops touch an entity the creator committed (origin
  `user`) after the turn's `startRev`.
- It commits the allowed part, tells the model "Conflict: … so I left it", and records the rest on `turn.conflicts`.
- Ops are split as finely as their keys allow. For example, a restyle of five lines where the creator restyled one
  still applies to the other four.
- If the ring no longer covers `startRev` (`recentCommitsComplete` false), every planned entity is held back and
  `comic_conflict_ring_incomplete` is logged. Unseen edits never lose to the director.
- With the guard off, everything is allowed, exactly as before.
- Wave 2 B-TOOL: every director line, balloon and style writer goes through commitGuarded
  (server/src/comic/tools/lettering.ts). That covers edit_panel_text (create ops included), set_line, dialogue_edit,
  the automatic lettering-preset follow, set_lettering_style, restyle_balloons and every arrange_balloons action. The
  hold carries over to dependent ops: a balloon, line_style or line_move on a held line, and every op of a unit
  (edit_panel_text's line structure; a dialogue_edit reorder or swap). Those join the line's card item. The panel cast
  change is built after the guard, from the lines that commit. Results are worded from what committed.

**The card (D3).** The creator's edit always wins. The director applies the rest of its edit and asks with one
conflict card per turn.
- The card reads "We both changed page 2 · panel 1", shows Yours vs the director's, and offers [Keep mine]
  [Use the director's] [Show me]. Here `mine` is the creator's current version and `theirs` the director's held-back
  version.
- An entity held twice in one turn is ONE item. Its Yours / The director's describe all its held ops, so the card
  shows everything "Use the director's" applies.
- Lettering items are labelled from what the creator changed ("the shout lettering … which drops your look for
  shouts").
- A director line created on a panel the creator reordered is its own "· a new line" item.
- **Show me** opens the page and selects the balloon. `PageEditor` passes the `page_editor` selection to
  `useLetteringSelection({initial})`, which drops ids no longer on the page. An editor that is already open selects
  the balloon when Show me arrives.
- With `COMIC_CONFLICT_GUARD` off, the card stays readable and says: "Answering conflict questions is switched off
  right now. Your version stays as it is.".

**"Use the director's" (`server/src/comic/actions/conflict.ts`).**
- It re-sanitizes each item's stored ops against the current doc with the client patch sanitizer
  (`sanitizePatchOps`), so a server-only op can never come from a card.
- It follows a line the creator moved to another panel.
- It refuses, in plain words, a line that was deleted since or a `tooBig` item; the item stays open.
- It commits once, with origin `director` and the label "Use the director's version", so one Undo brings the
  creator's version back.
- A too-big item with no page to open (the page plan, the lettering) says "Ask the director to redo it if you want
  it" instead of pointing at Show me.
- Items are marked answered by rewriting the card's message, so a reload or another device shows the answer.

**Limits:** `CONFLICT_LIMITS = {items: 10, opsPerItem: 20, ops: 50, textChars: 300, labelChars: 120}`.
- An item's held-back ops are kept whole or not at all. An item over the per-item cap or the card's remaining 50-op
  budget, or holding anything that is not an op, keeps `proposed: []` with `tooBig: true`. "Use the director's" can
  never apply half an edit.
- Collisions past 10 items are counted in `more` ("…and N more I left alone"), never dropped silently.
- Labels and the two text versions are clipped to their caps.
- A malformed card is dropped on load, and a clean card normalizes to the same object.

**What the creator settled reaches the director (only while the guard is on).**
- The DOC SUMMARY's never-clipped tail carries the DECIDED line (`server/src/comic/decided.ts`, at most 600
  characters), before OPEN QUESTIONS. It lists the approved plan, the page count, the art style, the lettering preset
  and the comic's own looks, the image-model lock, and the pinned or locked balloons.
- The system prompt adds: "If a request contradicts DECIDED or a Conflict: result, ask once; never override
  silently."
- The four contradiction gaps (`replies.ts`) each ask one question:
  - `contradiction_pages`: a new page count once the plan is approved or pages are drawn;
  - `contradiction_style`: a lettering preset switch while the comic has its own looks;
  - `contradiction_pinned`: an edit aimed at a balloon the creator pinned or locked;
  - `contradiction_note`: a page count, audience or language that differs from an earlier brief note.
- The readers count a slot only with positive context ("make it 4 pages", "for teens", "write it in Hindi", "switch
  the lettering to manga"). Everyday mentions stay silent.
- Pictures in questions are live: `OptionsCard` draws a `balloon` visual (a crop of that balloon) and a `spot` visual
  (a page or panel cell highlighted).

## 6. Lead decisions

**Accepted 2026-11-04 (wave 0):**
- D1: queued notes drain as ONE combined message, split only by differing focus (and the size caps).
- D2: server steering is behind `COMIC_STEER`, default off. Off, "Send now" means Stop the director, then send.
- D3: the creator's edit always wins. The agent applies the rest and asks with a conflict card.
- D9: flags follow the stage pattern `off | admins | all`, read server-side into caps.
- The K3 bounds: `CONFLICT_LIMITS {items 10, opsPerItem 20, ops 50, textChars 300, labelChars 120}` and
  `STEER_LIMITS.whereLines 20`. Only `ops 50` came from the plan.

**S1 (wave 1):**
- **No idle-time prune of the recent-commit ring.** Plan §3 B2 reads the ring for "pages touched in the last two
  turns", so the ring keeps its count and size bounds only.
- **`queue_express` keeps lifting a Stop or reload hold for every note,** as the reviewer specified. After Stop,
  tapping a row's Send now while the director is still stopping lets the other notes drain after that note's reply.
  On a free turn they stay held. The reducer test pins this.
- **The bounds stay as built:** the ring's 1 MB, and the steer cap of 6000 (= `LONG_MESSAGE_CHARS`). Steer seats are
  per session.

**S2 (wave 2), A4:**
- **Presence has no flag of its own.** It shows only what the server sends in `where`, so B-TOOL's emit decides when it
  appears. It spends nothing and fetches nothing.
- **An entry outlives a stream only while another stream that delivered it is still open.** This follows the activity
  lines. The cost is rare: an action stream open beside a turn whose tool failed without an end keeps the place until
  that stream ends, as its activity line already does.
- **`StudioController.isUnsignable` (S2a PF-2 #7, landed on integ/s2a as a required member).** A4 keeps integ/s2a's
  member, its fixtures and its test, and adds two things in `useStudio.ts`: its identity renews whenever a path is given
  up on (the server declines it, the last allowed try fails, or the image keeps failing to load), so a tile re-renders
  out of its shimmer; and the last allowed try still in flight is not given up on yet, so a tile never flashes
  "Preview unavailable" before a late signature arrives.

## 7. What each package fills in

| Package | Wave | Status | Fills in |
|---|---|---|---|
| A1 QUEUE | 1 | Done (S1) | `messageQueue.ts`; the queue slice in `studioReducer.ts`; `send()` outcomes; the drain (D1); the holds; `sessionStorage`; Send now; the controller members (§4) |
| A2 TURN | 1 | Done (S1) | `reserveTurn` (G19); the steer inbox, seats and the recent-commit ring; `POST …/steer`; the director's drain, extra rounds and unread-note chips; `steerStudio` in `studioApi.ts` (§3) |
| A3 CONFLICT | 1 | Done (S1) | `entityKeys`; `guardUserEdits` and the card; `resolve_conflict`; the DECIDED line and the contradiction gaps; pictures in questions; Show me selecting the balloon (§5) |
| A4 STEER-UI + PRESENCE | 2 | Done (S2, `live/a4`) | The presence slice (`presenceWhere`, `presenceOf`) and `StudioController.presence`, set from `activity.where` and cleared on the activity's end, the stream's `done` or `error`, and Stop; the place in words on the activity line (`presencePlace`); the "Send now" steer path checked, with two cases added and one copy fix (§3.1, §3.2). Also `StudioController.isUnsignable` for the chat tiles (S2a PF-2 #7) |
| B-TOOL | 2 | Done (S2, `live/b-tool`) | Every line, balloon and style writer calls `guardUserEdits`, commits `allowed`, then `recordConflicts` and `conflictToolNote`. Also `offer_next` (up to 2 free chips, never a spend); offer_next is not core: buildTurnToolset gives it a seat the groups leave free (see `docs/features/dialogue.md`) |

## 8. Tests

- `shared/comic/comic.contract.test.ts`, section "Live agent, dialogue and Pro editor v2 contract (K3)". It covers:
  - the union members round-trip;
  - `isStreamErrorCode('NOT_RUNNING')`;
  - the caps default off;
  - the conflict-card bounds;
  - `entityKeys` / `collidingKeys` of a balloon op (`balloon:<lineId>`);
  - the dialogue engine filled by B-RESOLVE.
- `server/src/comic/k3.contract.test.ts`. It covers:
  - env → caps in `access.ts` (a failed admin lookup fails closed);
  - `recentCommits` recording each commit;
  - `reserveTurn` refusing while a turn runs;
  - the conflict guard with the flag off;
  - `resolve_conflict` refusing `NOT_AVAILABLE` while the guard is off;
  - the director call sites.
- **A2:**
  - `server/src/comic/session.steer.test.ts`;
  - `server/src/routes/comic.steer.test.ts`;
  - `server/src/comic/director.steer.test.ts`;
  - `components/comicstudio/studioApi.steer.test.ts`.
- **A1:**
  - `components/comicstudio/messageQueue.test.ts`;
  - `studioReducer.queue.test.ts`;
  - `useStudio.queue.test.tsx`;
  - `conversation/QueuedMessages.test.tsx`;
  - `conversation/StudioComposer.queue.test.tsx`;
  - `conversation/keepRefusedInComposer.test.tsx`.
- **A4:**
  - `components/comicstudio/studioReducer.presence.test.ts` (set, each clear, many streams, the bounds);
  - `useStudio.presence.test.tsx` (the controller's `presence`, no fetch on a timer, `isUnsignable`);
  - `conversation/ActivityLine.test.tsx` (the place words);
  - `useStudio.queue.test.tsx` and `conversation/QueuedMessages.test.tsx` (the steer path cases).
- **A3:**
  - `shared/comic/conflicts.test.ts`;
  - `server/src/comic/conflictGuard.test.ts`;
  - `decided.test.ts`;
  - `director.conflicts.test.ts`;
  - `replies.test.ts`;
  - `actions/conflict.test.ts`;
  - `conversation/cards/ConflictCard.test.tsx`;
  - `OptionsCard.visuals.test.tsx`;
  - `board/PageEditor.showMe.test.tsx`.

## 9. S1 wave summary (integ/s1)

S1 merged six packages onto the wave 0 base: PE-0, DS-R0, B-RESOLVE, A2, A1 and A3, in that order. Each package's
wave notes were then applied. Notes owned by a later package were carried to the S2 briefs. Every flag kept its
default. Where each package is documented:

- **A1, A2, A3**: this doc (§3–§5).
- **B-RESOLVE**, the dialogue engine: `docs/features/dialogue.md`. It stays dormant until B-TOOL.
- **PE-0**, the Pro Edit contract: `docs/features/pro-edit.md`. It is invisible.
- **DS-R0**, the names (Library, My comics, Assets) and one-step Library + link / Link only publishing: client copy and
  layout.

**Owner-visible layout change (DS-R0, lead decision: link-first for Link only, as built).** In the Share sheet, once
a comic is live (Link only included):
- The link block (copy, QR, Share…) comes first, above "Who can read it". It also sits above the "You’ve made changes
  since publishing … Update" banner, which used to be above the link card.
- On the phone sheet, the 640–1023 px dialog and the short-landscape side sheet, the QR (or "Show QR code" on phones)
  now sits in that first block instead of at the very end.
- The wide (≥ 1024 px) dialog keeps the QR in its left column.
- A listed comic adds "See it in the Library" under the block.
- On short side sheets, the choices may now need a scroll.

**Lead decisions recorded in S1:**
1. **DS-R0 layout:** link-first for Link only, as built (above).
2. **DS-R0 apostrophes:** typographic (’), as built. This covers the new Share wording and the Share sheet's and
   publish card's "That didn’t work" fallbacks.
3. **B-RESOLVE colours:** the shared `NAMED_COLORS` values, not the plan's B4 literals: red `#e63946`, yellow
   `#ffd60a`, "a bit see-through" `+b3`. See `docs/features/dialogue.md` §4.
4. **A2:** no idle-time prune of the recent-commit ring (§6).
5. **A1/A2:** `queue_express` keeps lifting a Stop or reload hold for every note (§6).
6. **PE-0 names:** `EXIT_PRESET_IDS` and `EASE_IDS` are accepted as named (`docs/features/pro-edit.md` §7).
7. **PE-0 reader motion:** a bare `on` (`true`, `1`, `all`, `everyone`) turns `COMIC_READER_MOTION` on for everyone.
   `admins` stays off, and any other value is off (`readerMotionStage`; `docs/infrastructure/ENV_MATRIX.md`).

**Not applied in S1, waiting for a lead decision:** PE-0's server sanitizer change, which keeps stored Pro lettering
on an undo after a rollback (`docs/features/pro-edit.md` §7). It is carried to S2 PE-SERVER.
