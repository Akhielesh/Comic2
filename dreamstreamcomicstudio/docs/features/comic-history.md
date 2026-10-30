# Comic History — version control for comics

**Status:** H0 landed (2026-10-30): the contract, the shared history engine and every seam as a no-op stub. Nothing a
creator can see changes until the later packages land and the server env `COMIC_HISTORY=1` is set.

**Owner's words:** "make sure that we have version control for comics, that really helps" — backwards compatible with
every old comic. Plan: `inv/versions/plan.md` (the judge's synthesized plan, 2026-10-29). Owner direction D-OWN-5:
creator confidence — no lost work, easy undo and versions.

## 1. What the creator gets (when every package has landed)

- A **timeline** of plain-word moments ("AI revised pages 3–4", "You edited dialogue on page 2", "The editor re-fitted
  balloons, no AI cost"), grouped by day, with page thumbnails.
- **Saved before every AI change** (re-plan, revision, redraw, translation, image-model switch), so a bad AI run never
  has to be paid for twice.
- **Read the past** in the real reader (Guided View on phones, any language), read-only.
- **Compare** any moment with now or "Published": lettered pages side by side, swipe/blink on phones, word-level
  dialogue diffs in every language.
- **"Use then"** on one line, panel, page (words, art or both), character, place, cover, script, style or language;
  **restore the whole book** (saved first, undoable after a reload); **"Undo the last AI change"**.
- **Named versions** kept forever; **"Try another version"** — up to 5 versions inside one comic (decision V-1).
- The **director** understands "go back to how page 3 looked this morning" and "show me yesterday's version".
- **Everything is free** (no AI, no spend entry), **private** (owner-only; never on share links) and **honest** (the
  granularity is stated; missing data says "not recorded"; thinning is never silent).

## 2. Packages

| Package | What | Status |
|---|---|---|
| **H0** | Contract, shared engine, every hotspot seam once (no-op stubs) | **landed** |
| H1 | SQL (`comic_history.sql`: tables, put/label/delete/forget RPCs, GC roots), hashing, store + fake | next (**production SQL apply**) |
| H2 | Recorder: automatic moments (no timers) — replaces `createHistoryHooks` | after H1 |
| H3 | Restore service, owner routes, history actions — replaces `routes/comicHistory.ts`, `actions/history.ts` | after H2 |
| H4 | Director tools — replaces `tools/history.ts` | after H3 |
| H5 | Client History UI (phone first, Atlas) — replaces `components/comicstudio/history/{index,intents}.ts` | on fakes, after H0 |
| H6 | Classic comics' history (trigger + backfill, owner routes, modal) — replaces `legacyImport.ts`, `routes/comicLegacyHistory.ts` | after H1 (**production SQL apply**) |
| H7 | Alternatives — replaces `actions/historyAlternatives.ts` | after H3 |

## 3. The contract (H0, `shared/comic/**`; all additive)

- **Op** `history_restore {set: RestoreSet, mode: 'merge'|'exact', versionId, at}` — in `SERVER_ONLY_OPS` (never
  client-patchable, no inverse: its undo is the before-restore moment). Applied by the same pure `applyOps` on server and
  client (`shared/comic/history/apply.ts`, called from `ops.ts`). `KNOWN_DOC_OPS` / `isKnownDocOp` list every op this
  build applies.
- **Actions** (all in `NON_SPEND_ACTION_TYPES`, all free): `history_save {name?, note?}`, `history_restore {versionId,
  scope, baseRev?}`, `history_undo_ai {decisions?}`, `history_forget_photo {path}`, `history_alternative {mode, …}`.
- **RestoreScope**: `book`, `page {pageId, mode: replace|insert, part: all|text|art}`, `panel`, `line`, `character`,
  `place`, `cover {part}`, `script`, `style`, `language {lang}`, `keys {keys[]}`.
- **Card** `{type: 'history', id, view: list|moment|compare|confirm|undo_ai, versionId?, a?, b?, pageId?, scope?}` —
  ids only; it renders by fetching from the owner API.
- **Events**: `StreamRequest.tz?` (IANA, validated with Intl by `normalizeTimeZone`); SSE `{type: 'history', version}`.
- **Limits** (`limits.ts`): `MAX_ALTERNATIVES = 5` (V-1) and `HISTORY_LIMITS` (300 unpinned rows, 100 named, 25 MB per
  comic, 60 changes and 8 thumbs per row, quiet edits 10 min / 25 commits / 3 pages, 30-min gap, 10-min AI runs,
  before-restore kept 30 days, 30 saves per hour).
- **Caps**: optional `StudioCaps.history` and `maxAlternatives` — absent unless the server env `COMIC_HISTORY=1`
  (`withHistoryCaps`, `historyEnabled`, `maxAlternativesOf`). Off adds nothing to the caps on the wire.
- **Wire types** (`shared/comic/history/types.ts`): `VersionRow`, `VersionDetail`, `CompareResult`, `AlternativeRow`,
  `Manifest`, `BookDiff`, `ChangeItem`…, so H5 builds on fakes while H3 builds the routes.

## 4. The engine (`shared/comic/history/`, pure, shared)

- **sections.ts** — a version is the book split into sections (`meta`, `source`, `style`, `option:<id>`, `cover`,
  `char:<id>`, `places`, `page:<id>` = the page minus {n, render, balloons}, `art:<id>` = {render, balloons},
  `ed:<lang>`, `edp:<lang>:<pageId>`, `glossary`, `archive:<n>` blocks of 32 from the oldest end, `trash:<pageId>`).
  **Future-proof by exclusion**: new page/panel fields land in `page:` automatically; `meta` takes every unlisted
  top-level key; `TOP_LEVEL_SECTIONS` is typed `Record<keyof ComicDoc, …>` so a new doc key fails the typecheck until it
  is assigned (K2a: `scenes`, `consistency` → meta). Volatile render fields (busy/failed status, attempts, error,
  errorDetail, updatedAt) never enter a section. `joinSections` reassembles through `normalizeDoc`; split → join is the
  identity (volatile fields aside) on v4, v5, empty and random books; `pageSpecHash` never changes.
- **apply.ts** — merge mode keeps **I1** no lost image (displaced art → that target's history → archive; removed pages
  → Deleted; anything else unreferenced → archived), **I2** no lost translation (union by line id, version wins for its
  lines), **I3** forward-only state untouched (spend, conversation, memory, settings, safety, publication, the model
  lock, the inbox; `gate` → null; restored images keep the newest verdict and variants), **I4** busy targets untouched,
  **I5** normalized, **I6** later characters/places/options kept, later pages to Deleted. The source language is never
  changed by a merge restore. Exact mode (alternative switch only) replaces as stored; the trash belongs to the comic.
- **restore.ts** — `restoreOps(current, versionDoc, scope)` per scope; `restoreEffects` (what goes to Deleted / is
  kept); `exactRestoreSet`; `historyRestoreOp`.
- **diff.ts** — `diffManifests` (no body loads), `diffBooks` with the semantic filter (QC, variants and safety never
  count as a change), `diffWords` (word LCS), `diffLines`, `drawnModelOf`.
- **touched.ts** — `touchedKeys(op, doc?)`, `opActor(op, origin)` (you / ai / editor, §4.2), `CAPTURE_NEUTRAL_OPS`.
- **describe.ts** — `describeChanges(changes, kind)`, `changeItemsFromDiff`, `pageRangeText` (no git words, ever).
- **when.ts** — `resolveWhen({day, part?, at?}, now, tz)`: "yesterday" ends at local midnight, "this morning" at 12:00
  local; DST days are 23/25 hours; no valid zone → UTC, and it says so.
- **lastAi.ts** — `planUndoLastAi(P, R, live, decisions?)`: untouched AI keys revert, changed-since keys are conflicts.

## 5. The seams (H0 stubs; later packages replace them in place, same names)

- **Server session** (`server/src/comic/session.ts`): `StudioSession.history` (`createHistoryHooks`, no-op) —
  `onCommit` in `commit()` (synchronous), `onFlush` awaited at the end of `flush()` (`final: true` from the sweeper's
  eviction and shutdown), `onLoad` after `getStudioSession` hydrates. A failing hook logs `comic_history_capture_failed`
  and never reaches a save, turn or render. The archive notice adds "History still keeps them." only once the hooks
  really record.
- **Server stubs**: `history/{hooks,storeTypes,legacyImport}.ts`; `actions/history.ts` + `historyAlternatives.ts`
  (registered; refuse `NOT_AVAILABLE`, nothing committed or spent); `tools/history.ts` (ToolGroupId `history`, listed
  only while `COMIC_HISTORY` is on); `routes/comicHistory.ts` + `comicLegacyHistory.ts` (mounted after requireAuth,
  legacy first; off → the paths fall through untouched; on → the same bare 404 as a missing comic, `private, no-store`,
  text-limited on their exact paths).
- **routes/comic.ts**: the stream request's `tz` rides on the turn context (`turnTimeZone(ctx)` for H4); `POST
  /projects {importFromProjectId, fromVersionId}` (read only while history is on) → the classic snapshot loader; one
  `onImported` call after a classic import; caps from `COMIC_HISTORY`.
- **Client**: `components/comicstudio/history/{index,intents}.ts` (registered in `features.ts`, listed once they
  register something); `studioReducer` refetches on an unknown op, records a `history_restore` (and drops queued
  director batches), marks AI changes the undo stack cannot invert, and feeds the `history` event to an open panel;
  `useStudio` clears its undo stack on an incoming `history_restore` and — only while `caps.history` — sends `tz`,
  routes typed history intents locally and offers the `history_undo_ai` fallback for a typed "undo".

## 6. Back-compat and rollout

- No `ComicDoc` field is added; every version reconstructs through today's `normalizeDoc`; v4/v5/empty/classic-shaped
  synthetic fixtures (`shared/comic/history/__fixtures__/`) prove old shapes split and join unchanged.
- Old client tabs refetch on any op they do not know. Release order: client first, then H1's SQL, then the server with
  `COMIC_HISTORY=1`.
- With `COMIC_HISTORY` unset nothing observable changes: no caps keys, no tz on requests, no director group, history
  paths fall through, the action stubs are unreachable from the UI.

## 7. Security boundary (§12, holds from H0)

Owner-only routes behind requireAuth; a foreign or missing id answers the same 404; nothing under
`server/src/comic/publication/**`, `comics-edge/**` or the public reader router imports `comic/history/`
(`routes/comic.ts`, which also holds the public reader router, reaches the seams only through the owner route modules).
Share links are still built only from the live doc.
