# Live agent: queue, steering and conflicts (Comic Studio)

**Status:** wave 0 landed (2026-11-04): the contract, the flags and every seam as a stub with its final name and
signature. Nothing a creator can see changes yet: every consumer is a stub until the wave 1 and wave 2 packages
replace it in place. Plan: the agent-editor plan, Track A (§3), waves (§4), flags (§5).

**What it is for:** the creator keeps working while the director works. Notes typed during a turn are queued, not
lost; "Send now" can steer the running turn; and when the creator and the director change the same thing mid-turn,
the creator's edit wins and the director asks instead of overwriting.

## 1. Flags (stage defaults)

Each flag is a rollout stage, `off` | `admins` | `all`, read once per request by `server/src/comic/access.ts`
(`studioCapsFor` → `liveCapsFromEnv`, `shared/comic/capabilities.ts`) into the studio caps. The client reads the caps
only (`liveQueueOn`, `steerOn`, `conflictGuardOn`), never env. Parsing, synonyms and rollout criteria:
`docs/infrastructure/ENV_MATRIX.md`, "Comic Studio: live agent, dialogue, Pro editor v2".

| Env var | Cap | Default (unset) | Turns on |
|---|---|---|---|
| `COMIC_LIVE_QUEUE` | `caps.liveAgent.queue` | `admins` | The visible "Up next" queue (A1) |
| `COMIC_STEER` | `caps.liveAgent.steer` | `off` | `POST …/steer` and "Send now" into the running turn (A2, A4) |
| `COMIC_CONFLICT_GUARD` | `caps.liveAgent.conflicts` | `admins` | The conflict guard, the conflict card, the contradiction questions (A3) |

A bare switch (`on`, `true`, `1`, `yes`) means admins only; everyone needs an explicit `all`. An older server sends no
`liveAgent` caps, which reads as off. None of this spends: no model or image call of its own, and nothing bypasses the
spend gate.

## 2. What wave 0 put in place

**Contract (`shared/comic/**`, all optional and additive; old comics normalize to the same object):**
- `events.ts`: `SteerRequest {text, focus?}`, `SteerResponse {ok, msgId}`, `STEER_LIMITS`, `ActivityWhere` on the
  `activity` event (`where?: {pageId?, lineIds?}`), and `NOT_RUNNING` in `STREAM_ERROR_CODES`.
- `doc.ts`: `Msg.steered?: true`; the `conflict` card (`ConflictCard`, `ConflictItem`, `ConflictWhere`),
  `CONFLICT_LIMITS` and `normalizeConflictCard`; `OptionVisual` `balloon` and `spot` (pictures in questions).
- `ops.ts`: the free `resolve_conflict` action `{cardId, itemIds, choice: 'mine' | 'theirs'}` (in
  `NON_SPEND_ACTION_TYPES`).
- `conflicts.ts`: `EntityKey`, `entityKeys(op)` (stub: `[]`) and `collidingKeys(a, b)`.
- `capabilities.ts`: `LiveAgentCaps`, `FlagStage`, `LIVE_FLAG_ENV`, `LIVE_FLAG_DEFAULTS`, `parseFlagStage`,
  `stageAllows`, `liveCapsFromEnv` and the readers.

**Server stubs:**
- `session.ts`: `takeSteer()` (returns `[]`), `reserveTurn()` (a no-op release; it sets no flag, so the BUSY race stays
  until A2), `recentCommits(sinceRev)` (returns `[]`), `RECENT_COMMITS_MAX = 300`, and the `takeSteerOf` /
  `recentCommitsOf` helpers.
- `director.ts`: `turn.startRev = doc.rev` at the start of a turn; the steer drain point after each tool round, after
  the `ask_user` break, so a turn that ends on a question never takes a note; `steerNoteText`; and `conflictCardFor(turn)`
  after the loop, on a Stopped turn too.
- `conflictGuard.ts`: `guardUserEdits` (stub: allows every op), `conflictToolNote`, `recordConflicts` and
  `conflictCardFor` (null unless `turn.conflicts` has items; the stub guard records none).
- `actions/conflict.ts`: `resolve_conflict` refuses with `NOT_AVAILABLE` and changes nothing.

**Client contract (`components/comicstudio/`):** `SendOutcome` (`'sent' | 'queued' | 'held' | 'refused'`),
`StudioPresence`, `StudioController.send` returning `Promise<SendOutcome | void>` (void reads as `'sent'`), the optional
`StudioController.presence`, and `asCaps` reading `liveAgent` (only a literal `true` turns a part on).

## 3. The steer contract

- `POST /api/comic/projects/:id/steer` with a `SteerRequest`. With a director turn running, the text is screened like a
  chat message (a block answers `CONTENT_POLICY`), committed as a user message with `steered: true` ("Added while the
  director was working"), and queued on the session's inbox. The answer is a `SteerResponse` with that message's id.
- No turn running: error code `NOT_RUNNING`, and the client queues the note instead.
- The inbox holds at most `STEER_LIMITS.inbox` (3) notes. The director drains it after each tool round, before its next
  model call, into one user message: `(The user added while you were working:) …`, numbered when there are several.
- A note that arrives during the final round adds one more round, at most `STEER_LIMITS.extraRounds` (2) per turn, so a
  late note is never stranded.
- Presence: `activity.where` names the page and at most `STEER_LIMITS.whereLines` (20) line ids the running tool is
  changing.
- Steering off (D2): "Send now" means Stop the director, then send.

## 4. Conflict cards and their limits

- D3: the creator's edit always wins. The director applies the rest of its edit and asks with one conflict card per
  turn: "We both changed page 2 · panel 1", Yours vs the director's, [Keep mine] [Use the director's] [Show me].
- `mine` is the creator's current version and `theirs` the director's held-back version. The plan's `yours` is `mine`.
- `CONFLICT_LIMITS = {items: 10, opsPerItem: 20, ops: 50, textChars: 300, labelChars: 120}`:
  - an item's held-back ops are kept whole or not at all. An item over the per-item cap or the card's remaining
    50-op budget, or holding anything that is not an op, keeps `proposed: []` with `tooBig: true`, so "Use the
    director's" can never apply half an edit;
  - collisions past 10 items are counted in `more` (a positive integer), never dropped silently;
  - labels and the two text versions are clipped to their caps;
  - a malformed card is dropped on load, and a clean card normalizes to the same object.

## 5. Lead decisions (accepted 2026-11-04)

- D1: queued notes drain as ONE combined message ("(Sent while you were working:) 1. … 2. …"), split only by differing
  focus.
- D2: server steering is behind `COMIC_STEER`, default off.
- D3: the creator's edit always wins; the agent applies the rest and asks with a conflict card.
- D9: flags follow the stage pattern `off | admins | all`, read server-side into caps.
- The K3 bounds are accepted: `CONFLICT_LIMITS {items 10, opsPerItem 20, ops 50, textChars 300, labelChars 120}` and
  `STEER_LIMITS.whereLines 20`. Only `ops 50` came from the plan.

## 6. What each later package fills in

| Package | Wave | Fills in |
|---|---|---|
| A1 QUEUE | 1 | `messageQueue.ts` (add, edit, remove, move, `batchesForDrain`, `holdReason`); the queue slice in `studioReducer.ts`; `useStudio.send()` returning a `SendOutcome`; the drain effect (D1); holds for an open question, an open spend gate, Stop and `plan_pages`; `sessionStorage` per project, never auto-sent after a reload; 10 notes at most. The lead then adds the optional controller members (`queue`, `editQueued`, `moveQueued`, `removeQueued`, `sendNow`) to `StudioController`. |
| A2 TURN | 1 | `takeSteer`, `pushSteer` (inbox of 3), `reserveTurn` (held synchronously at the BUSY check, released on any early failure) and the `recentCommits` ring, filled in `commit()`; the `/steer` route; the director's extra round; `steerStudio` in `studioApi.ts`. |
| A3 CONFLICT | 1 | `entityKeys`; `guardUserEdits` (allows everything while `conflictGuardOn(caps)` is false); `resolve_conflict`: `'theirs'` re-sanitizes the stored ops with the client patch sanitizer (`sanitizePatchOps`, never a server-only op from a card), commits with origin `director` (undoable), refuses a `tooBig` item in plain words and never marks it resolved `'theirs'`; items are marked resolved by rewriting the card's message; the card renderer ("…and N more I left alone"); the contradiction gaps in `replies.ts`. `conflictCardFor` also runs on a Stopped turn, so its body stays cheap and synchronous. |
| A4 STEER-UI + PRESENCE | 2 | "Send now" calls `steerStudio` when steering is on (`NOT_RUNNING` → queue); `StudioController.presence` set from `activity.where` and cleared on the activity's end or `done`. |
| B-TOOL | 2 | `offer_next` (up to 2 free chips, never a spend). If it becomes a core tool, add it to `RESERVED_CORE_TOOLS` first (see `docs/features/dialogue.md`). |

## 7. Tests that pin wave 0

- `shared/comic/comic.contract.test.ts`, section "Live agent, dialogue and Pro editor v2 contract (K3)": the new union
  members round-trip, `isStreamErrorCode('NOT_RUNNING')`, the caps default off, the conflict-card bounds, and the
  `resolve_conflict` route refusing `NOT_AVAILABLE`.
- `server/src/comic/k3.contract.test.ts`: env → caps in `access.ts` (a failed admin lookup fails closed), the session
  stubs, the conflict stubs (a held-back edit is never silent), and the director call sites (the steer drain point,
  `startRev`, the conflict card on a finished and on a Stopped turn).
