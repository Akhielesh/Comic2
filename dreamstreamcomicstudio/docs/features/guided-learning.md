# Guided learning (progress-tracked courses in chat)

"Teach me X" produces a real course, not a wall of text: the model composes modules
and steps, the `create_learning_path` tool validates them into a typed artifact, and
`LearningPathCard` renders an interactive, progress-tracked course card. Progress is
client-side only — no server round-trip.

## The tool: `create_learning_path`

`server/src/ai/tools/learningPath.ts` — deterministic, no network
(`learningPath.ts:1-3`). Registered in the tool map at
`server/src/ai/tools/registry.ts:887`; catalog entry (category `learning`, keyless,
"renders locally") at `toolCatalog.ts:531-536`.

**Schema** (`learningPath.ts:82-120`): `title` + `modules` are required; modules need
`title` + `steps`; steps need `title`. Step `kind` enum:
`read | practice | quiz | flashcards | project | checkpoint | resource`
(`learningPath.ts:8`). The tool description steers the model: 3–6 modules of 3–6
steps, rich markdown in `read` steps, a ready-to-send `prompt` on practice steps
(`learningPath.ts:76-81`).

**Coercion rules** — `coerceLearningPath` (`learningPath.ts:51-72`) never trusts the
model payload:

- Strings trimmed + length-capped: title 200, topic 120, description 600, step title
  160, step `content` 6000, `prompt` 500, outcomes 200 each (`str()` helper, `:13-14`).
- Caps: ≤12 modules, ≤14 steps/module, ≤8 outcomes (`:54`, `:38`, `:67`).
- Invalid `kind` → defaults to `'read'` (`:21`); step/module without a title (or
  module without valid steps) is dropped entirely (`:19-20`, `:41`).
- `url` must be `https://` (≤500 chars) or it's stripped (`:27`).
- Missing ids are synthesized: path id = slug of the title (`:10-11`, `:60`), module
  `m{n}`, step `m{n}-s{m}` (`:23`, `:43`). **Stable ids matter** — they key the
  localStorage progress map across sessions.
- `estMinutes` clamped (step ≤600, module ≤6000); the path total is derived from
  module estimates, falling back to summed step estimates (`:65`).
- `level` only accepted as `beginner | intermediate | advanced` (`:58`).

Coercion failure returns a plain-text correction to the model ("provide a title and at
least one module with steps") instead of throwing (`:122-125`); success returns a
summary string plus `artifacts: [{ type: 'learning_path', data }]` (`:126-130`).

## Artifact contract

`LearningPathArtifact` (`apiTypes.ts:842-874`):

```ts
interface LearningStep   { id; kind; title; content?; url?; prompt?; estMinutes? }
interface LearningModule { id; title; summary?; estMinutes?; steps: LearningStep[] }
interface LearningPathArtifact {
  id: string;                 // stable — keys progress across sessions
  title: string;
  topic?; description?;
  level?: 'beginner' | 'intermediate' | 'advanced';
  estMinutes?; outcomes?: string[];
  modules: LearningModule[];
  palette?: string;           // kit palette name (defaults to 'violet' in the card)
  density?: 'compact' | 'detailed';
}
```

`step.prompt` is the hook for one-click practice ("Quiz me on module 2 of …");
`step.content` is markdown rendered inline for `read` steps; `step.url` is the link
for `resource` steps.

## Card UX — `components/chat/artifacts/LearningPathCard.tsx`

Registered as type `learning_path` (`ChatArtifacts.tsx:67`), density-aware and
full-width. Theme via `resolveTheme({ palette })`, default `violet`
(`LearningPathCard.tsx:197`).

**Progress (localStorage `ds.learning.progress.v1`)** — `LearningPathCard.tsx:29`:
a JSON map of `pathId → string[]` of completed step ids. `loadDone` tolerates an
older object-map shape `{stepId: true}` (`:31-44`); `saveDone` rewrites the entry on
every toggle (`:46-59`). Private-mode storage failures are swallowed — progress just
doesn't persist.

**Detailed view** (`:289-396`):
- Header: graduation cap, title, "topic · N modules · ~X min", level badge
  (green/amber/red per level, `:71-75`), SVG progress ring with percent hub (`:78-103`).
- Optional outcomes well ("You'll be able to…", `:340-352`).
- **Module accordions** (`:354-392`): numbered square (turns accent + check when the
  module completes), per-module `done/total` counts, chevron. The first module with an
  incomplete step is open by default (`:233-237`).
- **Step rows** (`:110-193`): round check toggle, kind icon (`KIND_ICONS`, `:61-69`),
  strikethrough when done; `read` steps expand inline markdown (`ChatMarkdown`);
  `resource` steps render as external links; steps with a `prompt` get a
  "Do this with AI" pill.
- **Continue footer** (`:305-335`): "Next up: <first incomplete step>" with a primary
  "Do it with AI" button (when the step has a prompt) and a "Continue" button that
  opens that module; when everything is done it switches to "All N steps complete".

**Compact view** (`:264-287`): a ~140 px glance card — ring, "X of Y steps", level
badge, and the next step title.

**The `dreamstream:compose` bridge** — "Do this with AI" dispatches a window event
instead of prop-drilling through the artifact tree:

```ts
// LearningPathCard.tsx:105-107
window.dispatchEvent(new CustomEvent('dreamstream:compose', { detail: { text: prompt } }));
```

`ChatComposer` listens (`components/chat/ChatComposer.tsx:129-149`), fills the draft,
focuses the textarea and places the caret at the end. Nothing auto-sends — the user
reviews and hits send. Any widget can reuse this event.

## Entry points

**`/learn` slash skill** — `services/chatSkills.ts:29-39`: command `learn` (aliases
`course`, `teach`, `study`), required `topic` argument, runs recipe
`guided-learning-course` with `{ topic }`. Slash skills stream through
`/api/recipes/run` (see `chatSkills.ts:1-7`).

**`guided-learning-course` recipe** — `server/src/ai/recipes/library.ts:162-183`:
parameters `topic` (required), `level` (select, default `beginner`), `timeframe`
(default "2 weeks, ~30 min/day"). The instructions tell the model to assess the topic,
then call `create_learning_path` with 3–6 modules × 3–6 steps, rich markdown lessons,
and checkpoint steps carrying ready-to-send prompts; follow-up activities include
"Start module 1 with me now" and "Quiz me on the first module".

**Organic**: the tool description (`learningPath.ts:76-81`) plus catalog keywords
(`toolCatalog.ts:535` — "teach me", "study plan", "curriculum", "roadmap", …) let
smart routing offer the tool on natural requests without the slash command.

## Composition with the other learning tools

The course card is the spine; the practice steps fan out into the existing
self-contained learning artifacts, all registered in
`server/src/ai/tools/registry.ts`:

| Tool | Artifact | Use in a path |
|---|---|---|
| `generate_quiz` (`registry.ts:614`) | `quiz` — self-grading questions | `quiz` checkpoint steps ("Quiz me on module 2 …" prompt) |
| `generate_flashcards` (`registry.ts:707`) | `flashcards` — flip deck with persisted known/review | `flashcards` steps for memorization |
| `sql_exercise` (`registry.ts:737`) | `sql_exercise` — sandboxed SQL playground | `practice` steps for database topics |
| `code_exercise` (`registry.ts:765`) | `code_exercise` — JS/Python worker playground | `practice` steps for programming topics |

The glue is `step.prompt` + the compose event: clicking "Do this with AI" drafts e.g.
"Quiz me on module 2 of Spanish", the user sends it, the model calls `generate_quiz`,
and the quiz renders as a sibling artifact in the conversation. The course card itself
never embeds those tools.

## `studyGuidance` auto-detection

Independent of the course tool, every real chat turn is scanned for exam/study intent:
`EXAM_STUDY_INTENT` regex (`server/src/ai/chat.ts:143-144` — "exam", "quiz me",
"teach me", "interview prep", "practice problems", …). On a hit,
`studyGuidanceBlock` (`chat.ts:148-157`) appends an "EXAM / STUDY MODE" system block
demanding exam-ready depth (core concepts, pitfalls, worked examples) and — key for
this feature — telling the model to **proactively offer the learning tools** (quiz,
flashcards, code/SQL exercise, study pack). It is applied only on real chat turns,
never on `systemOverride` sub-agent calls (`chat.ts:390-401`), and is deliberately
specific so casual "what is X" questions don't trigger it (`chat.ts:140-142`).

## Gotchas

- Progress is keyed by `data.id`. If the model regenerates a course with a different
  id (or different step ids), prior progress won't apply. The slug fallback
  (`learningPath.ts:60`) makes same-title regenerations collide *intentionally* —
  same id → same progress.
- Progress lives in this browser's localStorage only — it does not sync across
  devices or survive a storage clear.
- `step.content` markdown is capped at 6000 chars by coercion; longer lessons should
  be split across steps.
- A gallery demo exists (`components/chat/ComponentGallery.tsx:577`) — interacting
  with it writes real progress under the demo path id.
