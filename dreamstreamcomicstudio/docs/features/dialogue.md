# Dialogue understanding (Comic Studio)

**Status:** wave 0 landed (2026-11-04): the tool-hint fix (0a) is live, and the dialogue vocabulary, the pipeline
signatures and the `dialogue_edit` tool exist as stubs with their final names (0b). The stubs answer "not understood",
so the director behaves exactly as before for every dialogue edit. Plan: the agent-editor plan, Track B (§3), waves
(§4), flags (§5).

**What it is for:** "say anything freely" about dialogue. "Make it a whisper", "move Mira's line to the top left",
"the tail should point at the robot" become free, undoable edits on the right line, and the studio asks "Which line?"
with pictures when a sentence could mean several. It never invents a speaker.

## 1. Flag

| Env var | Cap | Default (unset) | Turns on |
|---|---|---|---|
| `COMIC_DIALOGUE_FAST` | `caps.dialogueFast` | `off` | The fast path: a clear dialogue edit answered with no model call (B3; D4: admins when on) |

`dialogue_edit` itself, the hint fix below and the `read_pages` line ids need no flag: they only make the existing
director more accurate. Parsing and rollout criteria: `docs/infrastructure/ENV_MATRIX.md`.

## 2. What wave 0 put in place

**The tool-hint fix (0a, live).** The director offers its core tools plus the feature groups whose words appear in the
sentence (`GROUP_HINTS`, `server/src/comic/tools.ts`), trimmed to `MAX_TOOLS_PER_TURN` (30).
- Lettering now wakes on dialogue words (`line`, `dialogue`, `said`, `says`, `speech`, `narration`, …) and on
  position words (`top`, `bottom`, `corner`), except when a page is the object of the sentence ("move the second page to
  the top").
- Breakdown no longer wakes on a bare `left` ("top left"), and not on `page` / `panel` in a page action ("delete page 4").
- Selected balloons make lettering relevant ("swap these two"), except when a page is the object.
- Pinned by `server/src/comic/tools.hints.test.ts`: 7 dialogue phrases × 2 fixtures offer the lettering tools, and page
  actions keep the timeline on a drawn, model-locked book.

**The vocabulary (`shared/comic/dialogue/types.ts`, frozen for wave 1).** `LineRef` (which line), `Placement` (where:
a cell of the panel or page, a full-width edge bar, near or between characters, a nudge), `DialogueIntent` (18 acts,
`DIALOGUE_ACTS`), and the pipeline's results: `GrammarResult`, `Resolution` (`lines` | `which` | `tap` | `confirm` |
`none`), `SpeakerMatch`, `PlacementResult`, `CompileResult`. `Pos9` / `POS9` (the nine cells) live in `doc.ts`.

**The pipeline stubs (`shared/comic/dialogue/index.ts`).** `parseDialogue`, `resolveLineRef`, `matchSpeaker`,
`placementFor`, `cellBox` and `compileIntent`, pure and free. Each answers "nothing" or `DIALOGUE_NOT_READY` until
B-RESOLVE replaces the bodies.

**Pictures in questions (`doc.ts`).** `OptionVisual` `{kind: 'balloon', pageId, lineId}` (a crop of that balloon) and
`{kind: 'spot', pageId, panelN?, cell, frame}` (a thumbnail with one cell highlighted).

**Named styles (`shared/comic/lettering/style.ts`, `doc.ts`).** `LetteringStyle.named` (`NamedLetterStyle {name,
patch}`, keyed by style id) and `Line.styleId`. Types only for now: `sanitizeLetteringStyle` drops `named` until
C-STYLES teaches it.

## 3. The reserved `dialogue_edit` seat

- `dialogue_edit` is the one free tool for every dialogue edit (resolve → compile → conflict guard → commit with origin
  `director`; ask "Which line?" and end the turn on ambiguity).
- Its schema is final (B3): `action` (one of `DIALOGUE_ACTS`), `target` and `second` (`LineRef`), `kind`, `text`,
  `speaker` (or `off_panel`), `place` (`Placement`, `frame` required), `tail_to`, `to_panel`, `index`, `style` (the
  lettering style schema) and `scope`. Keep these property names when filling the body.
- It is **not offered yet**. Its stub refuses with `NOT_AVAILABLE`, naming the tools that work today (`set_line`,
  `edit_panel_text`, `arrange_balloons`). Offering a tool that always refuses would cost a model round on every dialogue
  turn.
- Instead `RESERVED_CORE_TOOLS = ['dialogue_edit']` keeps one seat free in `buildTurnToolset` while the core list lacks
  it: today 29 of the 30 seats are offered. The group budget is therefore already the final one, and adding
  `dialogue_edit` to the core list trims no group. An explicit `opts.maxTools` stays the whole budget.

## 4. Lead decisions (accepted 2026-11-04)

- D4: the fast path is behind `COMIC_DIALOGUE_FAST`, default off, admins when on.
- D6: named styles are LINKED: editing a style restyles every line that uses it.
- D7: inline word emphasis, recorded model evaluations and panels-as-objects are wave 3. Until then "make 'never'
  bold" is answered honestly (the whole balloon can be bold now).
- Hashing wording, accepted: `LetteringStyle.named` and `Line.styleId` are **never part of a spec hash**
  (`pageSpecHash` / `planInputHash`: a style reference changes no drawn art) **but counted in the publication
  fingerprint** (a restyle is a change since publishing).
  - `named` already reaches the fingerprint through `doc.letterStyle` (pinned by `server/src/comic/k3.contract.test.ts`).
  - `styleId` joins the fingerprint's line tuple in C-STYLES, appended only when present, so old comics keep their
    fingerprint.

## 5. What each later package fills in

| Package | Wave | Fills in |
|---|---|---|
| B-RESOLVE | 1 | `grammar.ts`, `resolve.ts`, `speakers.ts`, `placement.ts`, `compile.ts` behind the `index.ts` signatures, with the phrase corpus (`__fixtures__/phrases.json`). Selection wins; scope widens only when empty (focus panel → page → pages touched in the last two turns → whole comic); 2–5 matches → "Which line?", more than 5 → "tap the balloon"; a speaker resolves only on one candidate. |
| A3 CONFLICT | 1 | The `dialogue_target` question and the conflict guard every dialogue write goes through (`docs/features/live-agent.md`). |
| B-TOOL | 2 | The `dialogue_edit` body, added to `buildDirectorTools` (and `'dialogue_edit'` appended to `CORE_TOOL_NAMES` in `server/src/comic/extensions.test.ts`); `offer_next`; `ask_user` visuals; `TARGET_SCHEMA` on `set_line` and `edit_panel_text`; line ids in `read_pages`; the lettering rules; the fast path in `intents.ts`; `TOOL_ACTIVITY` labels in `director.ts`. |
| C-STYLES | 2 | The style cascade with `named` and `sanitizeLetteringStyle` accepting it (name length and count caps); the server lettering sanitizer accepting `styleId` and dropping unknown ids; `l.styleId` in the publication fingerprint's line tuple, only when present. |
| B-PLACE, C-TYPO, B-EVAL-LIVE | 3 | Persisted placement anchors; inline emphasis; recorded model runs over the dialogue golden set (paid calls, needs the owner's budget). |

## 6. Known limits

- Two asks in one sentence can still trim the timeline on a drawn, locked book: "delete page 4 and fix the speech
  bubble" makes lettering and the timeline hot, and core 21 + lettering 3 + timeline 7 = 31 is over the 29 seats. The
  old hints and the old 30-seat budget trimmed it too. The real fix is a smaller core or a bigger budget.
- With a balloon selected, "move it to page 3" counts as a page action: the timeline gets the seat, not lettering.
