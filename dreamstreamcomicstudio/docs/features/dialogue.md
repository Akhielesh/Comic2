# Dialogue understanding (Comic Studio)

**Status:**
- **Wave 0 landed (2026-11-04).** The tool-hint fix (0a) is live. The dialogue vocabulary, the pipeline signatures and
  the `dialogue_edit` tool exist with their final names (0b).
- **Wave 1 B-RESOLVE built the engine (2026-11-05; integrated in S1).** `shared/comic/dialogue/{grammar,speakers,
  resolve,placement,compile}.ts` fill the K3 stubs (§5). The engine is pure and free, and it is also exported as the
  barrel namespace `comic.dialogue` (`shared/comic/index.ts`).
- **Wave 2 B-TOOL wired it into the director (2026-11-12).** `dialogue_edit` is a core tool and `offer_next` takes a
  seat the feature groups leave free; every line, balloon and style writer goes through the conflict guard, with the
  hold carried to the ops that depend on a held line; and the fast path exists in `intents.ts` behind
  `COMIC_DIALOGUE_FAST` (§3a). The stream route calls it once the S2b integration applies B-TOOL's route wave note.
- **Plan:** the agent-editor plan, Track B (§3), waves (§4), flags (§5).

**What it is for:** "say anything freely" about dialogue. "Make it a whisper", "move Mira's line to the top left",
"the tail should point at the robot" become free, undoable edits on the right line, and the studio asks "Which line?"
with pictures when a sentence could mean several. It never invents a speaker.

## 1. Flag

| Env var | Cap | Default (unset) | Turns on |
|---|---|---|---|
| `COMIC_DIALOGUE_FAST` | `caps.dialogueFast` | `off` | The fast path: a clear dialogue edit answered with no model call (B3; D4: admins when on). Built: `dialogueFastIntent` (`server/src/comic/intents.ts`) |

`dialogue_edit` itself, `offer_next`, the hint fix below and the `read_pages` line ids need no flag: they only make the
existing director more accurate. The conflict guard in every writer and the `dialogue_target` open question follow
`COMIC_CONFLICT_GUARD` (`docs/features/live-agent.md`). Parsing and rollout criteria:
`docs/infrastructure/ENV_MATRIX.md`.

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

**The pipeline (`shared/comic/dialogue/index.ts`).** It exports `parseDialogue`, `resolveLineRef`, `matchSpeaker`,
`placementFor`, `cellBox` and `compileIntent`, all pure and free. Wave 0 shipped them as stubs that answered
"nothing" or `DIALOGUE_NOT_READY`. B-RESOLVE replaced the bodies (§5); `DIALOGUE_NOT_READY` stays exported for old
callers, and nothing returns it any more.

**Pictures in questions (`doc.ts`).** `OptionVisual` `{kind: 'balloon', pageId, lineId}` (a crop of that balloon) and
`{kind: 'spot', pageId, panelN?, cell, frame}` (a thumbnail with one cell highlighted).

**Named styles (`shared/comic/lettering/style.ts`, `doc.ts`).** `LetteringStyle.named` (`NamedLetterStyle {name,
patch}`, keyed by style id) and `Line.styleId`. Not client-writable yet: the client
sanitizers drop `named` until C-STYLES teaches them. Since PE-0, the load path (`normalizeDoc`, `{keepStoredPro: true}`)
keeps a stored one, so a rollback never loses it (`docs/features/pro-edit.md` §2).

## 3. `dialogue_edit` and the director's dialogue tools (wave 2 B-TOOL)

**`dialogue_edit` (core, free; `server/src/comic/tools.ts`).** One tool for every dialogue edit, offered every turn (it
took the seat `RESERVED_CORE_TOOLS` kept for it; that list is empty now).
- Arguments → one intent: `intentFromArgs(args, {style})`. The style args go through the lettering engine first
  (`styleArgsToPatch`, relative to the scope's look); size always comes from the args (words relative, numbers
  absolute). An unknown font is carried through, so the engine asks with the 3 nearest fonts instead of dropping it.
- Then `compileDialogue(doc, [intent], {lineIds, pageId, panelN, recentPageIds, confirmed})`. The resolver sees the
  selection, the creator's page and panel, and the pages the last two turns touched (`recentPageIdsOf`, from the
  session's recent-commit ring).
- **`confirmed` is checked, not trusted.** The model's `confirmed: true` skips "Go ahead?" only when THIS turn answers
  that question for the same count (`confirmAnswerOf`): the assistant message right before the creator's message carries
  the engine's "Yes, change all N of them." choice, the creator tapped it (the card records it) or sent its words, and
  the edit still asks to confirm exactly N lines. Otherwise the tool compiles without it and asks again; a first call
  with `confirmed: true` never applies a big plural.
- **apply:** the ops pass the lettering sanitizers (`sanitizeLetteringOps`) and the conflict guard (`commitGuarded`),
  commit as one director step labelled `run.label`, and the result is the engine's sentence (`run.note`). The engine's
  follow-up chips (`run.followUps`, free `say` / `client` chips only) join the reply's chips.
  - A reorder or a swap (any `line_move` in the run) is one unit: if the guard holds any of it, all of it waits (half a
    swap would read as neither order). Other plurals split line by line.
  - The result is worded from what committed: all of it → the engine's sentence; nothing → only the "Conflict: …" note;
    part → "Did “<label>” for K of the N lines; the rest waits for the creator." plus the note. A held line's balloon
    waits with it, so a held add never leaves a balloon without its line.
- **ask:** an options card built from `run.ask` (each "Which line?" choice shows its balloon) plus the engine's say-chips
  ("Yes, change all N of them.", "I mean Mira.", "Use Bangers", "New shout…") as more choices, at most 5; the rest stay
  chips. `askedUser` is set and the turn ends, as with `ask_user`.
- **none:** the engine's honest note (an inventory, a lock, in-art lettering).
- Schema: the B3 names plus B-RESOLVE's `confirmed`, `dir` and `target.all`; `index` reads "0 = first, -1 = last, any
  other = 0-based position". Every object is typed key by key, bare (no per-key descriptions): `target`, `place` (its
  enums), `style` (font, size, bold, italic, text_color, fill_color, shape, tail). `second`, the other line of a swap, a
  "before it" or a link, is a string: its `[id]`, its speaker ("Arjun's line") or words from it (`secondLineArgs`; an
  object still passes through). Why typed: some function-calling validators refuse an object schema without properties,
  and a model fills declared keys most reliably (`server/src/comic/tools.schema.test.ts` walks every core tool).

**`offer_next` (free; not core).** Up to 2 tappable reply chips per turn that follow what was just asked. A chip only
sends its words: it carries no action, so it never spends (a chip whose words ask for spend meets the normal gate when
sent). It never ends the turn. Governed users read no `$` or `¢` on a chip: dollars become usage words (`governDollars`),
a cents price loses its parenthetical ("Redraw it (40¢)" → "Redraw it"), and a chip whose words are still a price is not
offered. `buildTurnToolset` gives it a seat the feature groups left free, after all of them, so it never trims a group
(a core offer_next cost every turn one group seat: "delete page 4 and fix the speech bubble" lost the timeline).

**The other tools.**
- `set_line` and `edit_panel_text` take a line target (`line_ids`, `selected`, `speaker`, `text_contains`), resolved like
  dialogue_edit's; set_line refuses a target that names several lines (`all` included), listing their ids.
- A new speaker joins the panel's cast only with the line change that brings them: set_line and edit_panel_text build
  that `panel` op after the guard (`commitGuarded`'s `follow`), from the lines that really commit. A held line holds its
  cast change too, so the drawn page stays current (a cast change makes it stale and a redraw PAID); "Use the
  director's" on the card applies both.
- edit_panel_text's line structure (its new, removed and moved lines) stands or falls as one unit, and its result counts
  the lines the panel really has, the ones kept and the moves that committed.
- `edit_panel_text` keeps a line's id whenever it is still that line, wherever it moved: the same words, kind and
  speaker first, then the same words, the same speaker, the same kind of unspoken line (ties to the nearest position).
  A reorder is one `line_move` per moved line, in the same undo step. Pins and translations follow the id.
- `read_pages` prints `[lineId]` on every line, with its balloon cell in the panel, pinned or locked, where its tail points
  (the nearest head mark, else "set by hand") and its own style.
- `ask_user` options take an optional picture: `{kind:'balloon', lineId}` (its page is looked up) or `{kind:'spot', page,
  cell, panel?}`, checked against the doc (anything else is dropped, the option still works).
- `arrange_balloons move` takes `frame: 'page'` (a spot of the whole page) and `near` (next to a character), placed by the
  shared dialogue placement, so both tools put a balloon in the same spot for the same words.
- Every line, balloon and style writer (edit_panel_text with its create ops, set_line, dialogue_edit, the automatic
  lettering preset follow, set_lettering_style, restyle_balloons, every arrange_balloons action) goes through
  `commitGuarded` (`server/src/comic/tools/lettering.ts`): `guardUserEdits`, then the hold carried to what depends on a
  held op (a `balloon`, `line_style` or `line_move` on a line whose `line` op is held, every op of a unit the tool names,
  joined to that line's card item with words for what they add), the allowed part committed as one step,
  `recordConflicts` right after, and `conflictToolNote` in the result. Results are worded from what committed.
- `LETTERING_RULES` gains the two B3 lines (kind words change the kind; several matches let dialogue_edit ask).
- The director prompt's Dialogue line names dialogue_edit; the activity events carry `where: {pageId, lineIds}`
  (`activityWhere`, at most `STEER_LIMITS.whereLines` ids) for A4's presence.

**The `dialogue_target` open question (`server/src/comic/replies.ts`, `dialogueTargetGap`).** Behind
`COMIC_CONFLICT_GUARD`, after the contradictions: a sentence the grammar reads as a dialogue edit whose target resolves to
2–5 lines tells the director to let dialogue_edit ask "Which line?", quoting each candidate. One match, a plural, the
selection, more than 5 lines or a message longer than 600 characters stays silent.

### 3a. The fast path (`COMIC_DIALOGUE_FAST`)

`dialogueFastIntent(ctx, text, focus)` (`server/src/comic/intents.ts`) runs `dialogueFastPath` on the creator's
selection, page and panel. It never passes `confirmed`, and never runs on an open spend gate. The ops pass the
sanitizers and commit as one director step, and the reply is the engine's sentence with an Undo chip first. No model
call, $0.

It needs no conflict guard: the edit is compiled from the doc the creator sees right now and committed in the same
synchronous step (no edit of theirs can land in between), and the route refuses a message BUSY while a director turn
runs, so no director edit is in flight either. The guard protects edits made while a turn works; this path never spans
one.

The stream route calls it, before the `COMIC_FAST_INTENTS` path, once the S2b integration applies B-TOOL's route wave
note. Until then the flag changes nothing.

## 4. Lead decisions

**Accepted 2026-11-04 (wave 0):**


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

**S1 (wave 1):**
- **Colours: the shared `NAMED_COLORS` registry wins over the plan's B4 literals** (B-RESOLVE amendment 9). The engine
  uses the same mapping as the server's `normalizeColor` and `set_lettering_style`, so `dialogue_edit` and the
  existing lettering tools agree:
  - red is `#e63946`, not the plan's `#d12a2a`;
  - yellow is `#ffd60a`;
  - "a bit see-through" adds `b3`, so a yellow box reads `#ffd60ab3`, not `#ffe066b3`.
  The plan's B4 literals are amended to these values.
- **Size words vs numbers** (amendment 10). A size word ("larger", "much smaller") is relative to each line's own size
  (`scaleBy`). A number is an absolute `sizeScale`, clamped to 0.5–3.5, and "normal" means 1. This matches the
  server's `sizeArg`.
- **No "tidy the bubbles" act** (amendment 8). That stays with `arrange_balloons` auto layout.

**S2b (wave 2 B-TOOL):**
- **Compact core schemas, every object typed** (amendment, revised by the B-TOOL review). The golden prompt cap
  (`server/src/comic/golden/scenarios.test.ts`, median ≤ 1.15× the wave-0 baseline) had about 260 characters left, and
  the full dialogue_edit schema alone was about 5,900. Every object keeps typed keys (bare); the room comes from:
  - offer_next out of the core (it takes a free seat instead);
  - `second` as words (its `[id]`, speaker or words) instead of a second LineRef object; `target` drops `which` (still
    read when sent);
  - edit_panel_text's lines no longer advertise a per-line `style` (dialogue_edit restyles a line; the body still reads
    one when sent);
  - the character look keeps one hint (summary) and folds the others into its description;
  - trivial or example descriptions ("Page number.", "e.g. noir mystery.", "How they talk.") went from the core tools.
    `set_style` was left alone (ST-4).
  - The median ratio is 1.1445 on 756b5a70 (100 characters of headroom; the cap is unchanged).
- **Ids follow the line** (amendment). edit_panel_text keeps an id on a matching speaker even when the line moves. The
  old test "changed kinds replace" assumed a positional match; it now pins the plan's rule.
- **`offer_next` fills a free seat** (revised by the B-TOOL review; it was core). Up to 2 chips per turn, as plain
  replies (each is its own label and message). Lowest priority of all: on a full turn it is not offered, and the
  director suggests next steps in its reply instead.

## 5. The engine (wave 1, B-RESOLVE)

All of it lives in `shared/comic/dialogue/`. It is pure and free: no model call, no I/O, no spend. Every op it makes is
an existing, undoable doc op.

**Grammar (`grammar.ts`): a sentence → `DialogueIntent[]`.** It is deterministic and English-first. It serves the
fast path (only when `confident`) and the tests.
- Quotes and ALL-CAPS words are set aside as words to place, never instructions. Fillers go ("um", "like", "can
  you").
- Run-ons split on "and / then / also" only where an action verb follows. "between Mira and Leo" stays whole.
- A later clause's "it" means the line the earlier clause named, and "her" the speaker it named.
- **Kind words vs look words (G12).** Kind words change the line's kind: whisper (quietly, softly), shout (yell, loud),
  thought, caption (narration, voice-over), sfx. Look words restyle instead: a robot or radio voice → the
  `electronic` shape; telepathy or a dream → `wavy`.
- A font-name-like phrase the studio lacks ("comic sans") becomes a restyle with `unknownFont`. The compiler then asks
  with the 3 nearest fonts and changes nothing. Mood words and stop words stay with the director.
- One-word emphasis ("bold never") must start the clause.
- Sentences that are not about dialogue are left to the director.

**Speakers (`speakers.ts`).** A name resolves only on ONE candidate; otherwise the candidates come back, so the studio
can ask. The match order is:
1. exact id;
2. exact name;
3. a unique first or last name;
4. a unique 3+ letter prefix;
5. a cast kind or species word ("the robot");
6. a role word ("her mom").

A pronoun resolves only to the speaker in focus: the selected line's, or that of the last line the sentence named.
With nothing to point to, the studio asks "Who do you mean by “her”?" with "I mean <name>." cast chips.

**Resolver (`resolve.ts`, plan B2 steps 1–6).**
1. The selection wins.
2. Quoted text narrows the candidates.
3. Speaker, kind, panel, ordinal and `which` narrow further.
4. Scope widens only when empty: focus panel → focus page → pages touched in the last two turns → the whole comic.
5. One match applies. 2–5 matches ask "Which line?" (`whichLineChoices`: one chip per candidate, each with a balloon
   picture). More than 5 ask to tap the balloon. None gives an honest inventory.
6. Plural words ("all whispers", "these") apply to every match. Above 20 lines or 3 pages (`RESOLVE_LIMITS`) the
   studio confirms first: "That changes N lines on M pages. Go ahead? It's free and undoable." with the chip "Yes,
   change all N of them.".

**The confirm flow.** The re-call after that "yes" carries `confirmed: true` (`DialogueContext`), so a big plural
resolves to the lines instead of asking again. It never widens a match, never answers "Which line?" and never skips
a lock. The fast path never passes it.

**Placement (`placement.ts`).** Every position starts from where the balloon is drawn today.
- **Frames:**
  - panel or page cells (`Pos9`);
  - an edge bar: a full-width bar inside the frame, at its top or bottom;
  - near a character's head mark. When it has to fall back to where the page staged them, a sentence says so;
  - between two heads.
- **Nudges:** 0.02 of the page for "a bit", 0.08 for "a lot".
- **Caption bars become rectangles.** Only placed lines get the `rect` style, and locked balloons are skipped.

**Compiler (`compile.ts`).** These rules never bend:
- It never invents a speaker. A new spoken line, or a caption turned into speech, asks "Who says it?" with cast chips.
- It never re-assigns a speaker on a move. A speaker who is not drawn in the destination panel asks first, with the
  three `move_to_panel` options.
- Locks and in-art lettering are honoured, in plain words.
- **All or nothing:** a refused part stops the whole instruction. A part that is "already so" is skipped and the rest
  carries on.
- **Never silent:** every step adds a sentence to `note`, and stale line ids are named.
- "the X panel needs a shout" asks whether to change a line or add one (`orChange`). An explicit add asks only for the
  words.
- `reorder` takes a 0-based `index` (`atIndex`).
- **The plan's other B4 asks:**
  - a character who is absent;
  - "between" with too few people;
  - a tail target who is absent.

**The calls B-TOOL makes (§3):**
- **`compileDialogue(doc, intents, ctx)`** runs resolve → compile and answers `apply` (ops, label, note, follow-up
  chips), `ask` (a question and options), or `none` (an honest note).
- **`askForResolution`** turns a `Resolution` into a question card.
- **`intentFromArgs`** (`grammar.ts`) turns `dialogue_edit` arguments into an intent. This is how other languages and
  messy wording arrive, filled by the director.
- **`dialogueFastPath(doc, text, ctx)`** answers only when all of these hold; otherwise the director takes the
  sentence:
  - the grammar is confident;
  - every intent is one line (an add: one panel);
  - nothing is kind-, speaker- or comic-wide;
  - the whole instruction applies;
  - every op is in `FREE_DIALOGUE_OPS`.

**The corpus (`__fixtures__/phrases.json`, `phrases.test.ts`).** It has 73 rows, run through grammar → resolve →
compile on `__fixtures__/dialogueDoc.ts`:
- every row of the plan's B4 table;
- 8 `args` rows: the director's structured arguments, in Hindi (3), Telugu (3) and English (2: an unknown font and a
  stale line id);
- 1 `preset` row.

The goldens are regenerated only on a reviewed behaviour change.

## 6. What each later package fills in

| Package | Wave | Fills in |
|---|---|---|
| B-RESOLVE | 1 | **Done (S1).** The engine behind the `index.ts` signatures, with the phrase corpus (§5). It also adds the barrel namespace `comic.dialogue`. Its amendments, all additive and optional, each work through a structural extension of the frozen K3 types: (1) `LineRef.all`; (2) `RestyleExtras` `scaleBy`, `asKind` and `unknownFont`; (3) `CompileOutcome` `ask` and `already`; (4) `DialogueContext.confirmed`; (5) `AddExtras.orChange`; (6) `ReorderExtras.atIndex`; (7) `PronounResolution`; (8) no "tidy" act; (9) `NAMED_COLORS` colours; (10) size semantics (§4) |
| A3 CONFLICT | 1 | **Done (S1):** the conflict guard every dialogue write goes through (`docs/features/live-agent.md`). The `dialogue_target` question is not built yet (carried to S2, B-TOOL: build it on `resolveLineRef` / `whichLineChoices`). |
| B-TOOL | 2 | **Done (S2b, §3).** The `dialogue_edit` body (core; `'dialogue_edit'` appended to `CORE_TOOL_NAMES` in `server/src/comic/extensions.test.ts`); `offer_next` (a free seat, not core); `ask_user` visuals; the line target on `set_line` and `edit_panel_text`; line ids in `read_pages`; the guard in every writer; the lettering rules; the `dialogue_target` gap; the fast path in `intents.ts`; the `TOOL_ACTIVITY` label, the Dialogue prompt line and `activity.where` in `director.ts`. The route call of the fast path is a wave note. |
| C-STYLES | 2 | The style cascade with `named` and `sanitizeLetteringStyle` accepting it (name length and count caps); the server lettering sanitizer accepting `styleId` and dropping unknown ids; `l.styleId` in the publication fingerprint's line tuple, only when present. |
| B-PLACE, C-TYPO, B-EVAL-LIVE | 3 | Persisted placement anchors; inline emphasis; recorded model runs over the dialogue golden set (paid calls, needs the owner's budget). |

## 7. Known limits

- Two asks in one sentence still trim the timeline on a drawn, model-locked book: "delete page 4 and fix the speech
  bubble" makes lettering and the timeline hot, and core 22 + lettering 3 + timeline 7 = 32 is over the 30 seats. The
  old hints and the old budget trimmed it too. On an unlocked drawn book (timeline 5) both fit exactly: 22 + 3 + 5 = 30
  (pinned by `tools.hints.test.ts`). A page action alone fits either way.
- offer_next has no seat on a full turn (it is lowest priority by design).
- A swap or reorder whose lines the creator touched mid-turn waits whole, even when only one line's move collides (the
  guard keys a move on the line, and half a swap would scramble the panel).
- The "I mean <name>." pronoun chips are not grammar: the director reads them and re-calls dialogue_edit with that
  speaker. "Add X to panel N, then…" chips are the same.
- The fast path runs only once the stream route calls `dialogueFastIntent` (B-TOOL's route wave note).
- With a balloon selected, "move it to page 3" counts as a page action: the timeline gets the seat, not lettering.
