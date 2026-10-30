# Comic History — version control for comics

**Status:** H0 landed (2026-10-30): the contract, the shared history engine and every seam as a no-op stub. Wave 2b
added H1 (the history tables and the store — the SQL is written and **not applied anywhere**), H5 (the History UI, on a
fake API until H3's routes exist) and H6a (the "Earlier (images only)" derivation). Nothing a creator can see changes
until the later packages land and the server env `COMIC_HISTORY=1` is set.

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
| H1 | SQL (`comic_history.sql`: tables, put/label/delete/forget RPCs, GC roots), hashing, store + fake (§8) | **landed**; the SQL is not applied yet (**production SQL apply**: the owner applies) |
| H2 | Recorder: automatic moments (no timers) — replaces `createHistoryHooks` | after H1 |
| H3 | Restore service, owner routes, history actions — replaces `routes/comicHistory.ts`, `actions/history.ts` | after H2 |
| H4 | Director tools — replaces `tools/history.ts` | after H3 |
| H5 | Client History UI (phone first, Atlas) — replaces `components/comicstudio/history/{index,intents}.ts` (§9) | **landed** on the fake API |
| H6a | "Earlier (images only)" for comics older than History — `shared/comic/history/earlier.ts` (§4) | **landed** |
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
  before-restore kept 30 days, 30 named saves per hour that write a new row — automatic captures are never throttled).
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
  is assigned (K2a: `scenes`, `consistency` → meta). Every meta key beyond the typed seven (`TYPED_META_KEYS`) is an
  "extra" meta key (`isExtraMetaKey`): captured, compared by `diffBooks` and restored through `RestoreSet.metaExtra`
  (null removes a key), so a K2a key needs nothing beyond its `TOP_LEVEL_SECTIONS` entry. Volatile render fields (busy/failed status, attempts, error,
  errorDetail, updatedAt) never enter a section. `joinSections` reassembles through `normalizeDoc`; split → join is the
  identity (volatile fields aside) on v4, v5, empty and random books; `pageSpecHash` never changes.
- **apply.ts** — merge mode keeps **I1** no lost image (displaced art → that target's history → archive; removed pages
  → Deleted; anything else unreferenced → archived; an overflowed version is archived only when nothing references
  its path any more, each path once, so restore → Undo cycles never pile up duplicates), **I2** no lost translation (union by line id, version wins for its
  lines), **I3** forward-only state untouched (spend, conversation, memory, settings, safety, publication, the model
  lock, the inbox; `gate` → null; restored images keep the newest verdict and variants), **I4** busy targets untouched,
  **I5** normalized, **I6** later characters/places/options kept, later pages to Deleted. The source language is never
  changed by a merge restore. Exact mode (alternative switch only) replaces as stored; the trash belongs to the comic:
  it stays, the target line's Deleted pages join it (by page id, newest first, capped at 20 with the overflow
  archived) and a page live in the target is not also deleted, so a switch there and back gives every page back.
- **restore.ts** — `restoreOps(current, versionDoc, scope)` per scope; `restoreEffects` (what goes to Deleted / is
  kept); `exactRestoreSet`; `historyRestoreOp`.
- **diff.ts** — `diffManifests` (no body loads), `diffBooks` with the semantic filter (QC, variants and safety never
  count as a change), `diffWords` (word LCS), `diffLines`, `drawnModelOf`.
- **touched.ts** — `touchedKeys(op, doc?)`, `opActor(op, origin)` (you / ai / editor, §4.2), `CAPTURE_NEUTRAL_OPS`.
- **describe.ts** — `describeChanges(changes, kind)`, `changeItemsFromDiff`, `pageRangeText` (no git words, ever). A
  model switch leads ("Switched the image model and redrew pages 1–6"); up to three phrases are named before "and
  more".
- **when.ts** — `resolveWhen({day, part?, at?}, now, tz)`: "yesterday" ends at local midnight, "this morning" at 12:00
  local; DST days are 23/25 hours; no valid zone → UTC, and it says so.
- **lastAi.ts** — `planUndoLastAi(P, R, live, decisions?, sameContent?)`: untouched AI keys revert, changed-since keys
  are conflicts. Raw chunk hashes include QC, variants and safety verdicts, which the studio commits on its own
  (variant backfill on load, async verdicts), so H3 passes `sameContent(key)` comparing the live and R bodies with
  `semanticSectionContent` (diff.ts): such a key counts as untouched, never as "You've changed page 3 since".
- **earlier.ts** (H6a) — "Earlier (images only)" for comics older than History: dated drawings (`AssetRef.at`) from
  version stacks, the archive, the style board, Deleted pages and the last publish time, per owner and per local day,
  newest first; every gap says "not recorded"; only paths the doc holds; reference photos, chat uploads and the inbox
  are left out (art you uploaded for a page or the cover is listed); pure (`now` and `tz` are passed in).
  `earlierHistory(doc, {now, tz, before})` with `before` = when History started (the `start` row), so later drawings,
  which have real rows, are not repeated.

## 5. The seams (H0 stubs; later packages replace them in place, same names)

- **Server session** (`server/src/comic/session.ts`): `StudioSession.history` (`createHistoryHooks`, no-op) —
  `onCommit` in `commit()` (synchronous), `onFlush` awaited at the end of `flush()` (`final: true` from the sweeper's
  eviction and shutdown), `onLoad` after `getStudioSession` hydrates. A failing hook logs `comic_history_capture_failed`
  and never reaches a save, turn or render. The archive notice adds "History still keeps them." only once the hooks
  really record.
- **Server stubs**: `history/{hooks,legacyImport}.ts` (and `history/storeTypes.ts`, the store contract H1 implements: §8); `actions/history.ts` + `historyAlternatives.ts`
  (registered; refuse `NOT_AVAILABLE`, nothing committed or spent); `tools/history.ts` (ToolGroupId `history`, listed
  only while `COMIC_HISTORY` is on); `routes/comicHistory.ts` + `comicLegacyHistory.ts` (mounted after requireAuth,
  legacy first; off → the paths fall through untouched; on → the same bare 404 as a missing comic, `private, no-store`,
  text-limited on their exact paths).
- **routes/comic.ts**: the stream request's `tz` rides on the turn context (`turnTimeZone(ctx)` for H4); `POST
  /projects {importFromProjectId, fromVersionId}` (read only while history is on) → the classic snapshot loader (a
  present but malformed id answers the same 404, never the live classic state); one `onImported` call after a
  classic import; caps from `COMIC_HISTORY`. While history is off, `parseStreamRequest` answers a `history_*` action
  with the same 400 "Unknown action" as before H0 (`historyActionOff` in `routes/comicHistory.ts`).
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
  paths fall through, a `history_*` stream action is an unknown action (400) as before.

## 7. Security boundary (§12, holds from H0)

Owner-only routes behind requireAuth; a foreign or missing id answers the same 404; nothing under
`server/src/comic/publication/**`, `comics-edge/**` or the public reader router imports `comic/history/`
(`routes/comic.ts`, which also holds the public reader router, reaches the seams only through the owner route modules).
Share links are still built only from the live doc.

## 8. Persistence (H1)

Code: `server/sql/comic_history.sql` (written, **not applied**: the owner applies it, see below) and
`server/src/comic/history/{hash,store,store.fake,storeTypes}.ts`. The server takes the store from `getHistoryStore()`
(Supabase, service role); tests use `createFakeHistoryStore({ now })`, which has the same semantics in memory, through
`__setHistoryStoreForTests`.

**Tables** (server only: RLS on with no policies, every client grant revoked; the service role may only read them, and
every write goes through the RPCs below):

- `comic_alternatives` — "Versions you're trying" (H7). A comic with no rows has one line, "Original" (its versions have
  `alternative_id` null). At most one line is active. A removed line is never deleted: `removed_at` marks it.
- `comic_versions` — one row per saved moment: kind, actor, a plain-word label, optional name and note, pinned,
  `keep_until`, `rev`, `content_at`, a **manifest of chunk hashes** (never a whole doc), its root hash and chunk list,
  the change items, thumbnails, stats, and for a classic-editor snapshot `codec = 'legacy'` with its `legacy_ref`. A
  saved moment never changes except its label, name, note, pin, `keep_until`, line, `published_rev`, and
  `parent_id` / `undo_id` turning null.
- `comic_version_chunks` — the book's sections, content-addressed by `(project_id, hash)` (sha256 of the content, first
  32 hex characters, checked by the database on insert and by the store on read), so nobody can probe another comic's
  content. A chunk never changes, except that its `paths` (the image paths it mentions, at most 400) may only shrink.

**RPCs** (`SECURITY DEFINER`, executable by the service role only). Each takes one per-comic lock, then checks that the
user owns the comic. A comic that is not the user's raises `FORBIDDEN`, which the server answers exactly like a missing
comic (404).

| RPC | What it does | Refusals (`COMIC_HISTORY_<token>`) → what the store throws |
|---|---|---|
| `comic_history_put` | One transaction: chunks, presence check, dedupe, insert, thinning, chunk GC. Answers `{id, deduped, thinned, budgetThinned, gcChunks, bytesNew}` | `MISSING_CHUNKS` → 409 CONFLICT, retryable (the whole call rolls back); `LIMIT:saves_per_hour` → 429; `LIMIT:named` → 409; `NOT_FOUND` (a removed or unknown line) → 404; `INVALID` → 400 |
| `comic_history_label` | Name, note and pin. Naming an automatic moment pins it; saved kinds stay pinned | `LIMIT:named` → 409; not in this comic → null |
| `comic_history_delete` | Removes a moment the user saved or named (kind `named`, or any row with a name), then runs the chunk GC | `REFUSED:classic`, `REFUSED:not_named`, `REFUSED:newest`, `REFUSED:head` → 409; not in this comic → false |
| `comic_history_forget_path` | Drops a path from every chunk's `paths` (forgetting a reference photo, V-4), so the GC roots release it and restores skip it | — |
| `comic_history_set_head` | A line's head: pins the version and releases the previous head. For "Original" (null) it only checks the version is in this comic and pins nothing | not found → false (the store throws NOT_FOUND) |
| `comic_history_alternative_create` / `_update` / `_remove` | Start a line (its head is pinned), rename or activate one, remove one (soft: see below) | `LIMIT:alternatives` → 409; `NOT_FOUND` (the head version is not in this comic) → 404; `REFUSED:active` (removing the line you're on) → 409; `INVALID: name` → 400; a removed or unknown line → null / false |

The store also throws `TOO_LARGE` (409) for a chunk or manifest over its size cap and `HASH` for content that does not
match its hash. Every refusal is a `StudioError` carrying a plain sentence (`HISTORY_STORE_MESSAGES` in `store.ts`; no
git words). When the tables are not there yet, every call answers `NOT_AVAILABLE` (503).

**Rules the store keeps:**

- **Dedupe.** A capture whose root hash equals the line's newest row writes nothing. A saved kind (start, named,
  publish, import) pins that row instead, a publish marks it, and a before-restore moment extends its `keep_until`. A
  classic snapshot is imported once, by its snapshot id.
- **alreadyNamed.** A named save of an unchanged moment names it only when it has no name yet. If it already has one, it
  is never renamed: the answer carries `alreadyNamed: true` and that `name`, so the caller can say "This moment is
  already saved as '<name>'." instead of a success.
- **Saves per hour** (`HISTORY_LIMITS.savesPerHour`, 30) counts only named saves that write a new row. Automatic
  captures are never throttled, and naming or pinning an unchanged moment writes no row, so it is not counted. At the
  cap every named save is refused (429, `LIMIT:saves_per_hour`), even one that would only name an unchanged moment:
  the check runs before the dedupe. At most 100 named versions per comic (`LIMIT:named`).
- **The classic snapshot's own time.** `VersionInput.createdAt` (epoch ms) is used for codec `'legacy'` only: it
  becomes the row's `created_at`, never later than now, so the classic line keeps its order. A value outside 0..1e13
  falls back to now, and every other row is stamped by the database clock. `get()` opens a legacy row from its own
  chunk list (it has no v5 manifest).
- **Removing a moment.** Classic-editor snapshots can never be removed (`REFUSED:classic`: "Snapshots from the classic
  editor are kept safely, so they can't be removed."). Never a line's head, never the newest row of "Original" or of a
  line still being tried.
- **Thinning** (inside the put, at most 50 rows a call): every automatic moment for 48 hours, then the newest per hour
  for 7 days, per day for 90 days and per week after; at most 300 unpinned rows; over 25 MB per comic the oldest go
  first and the put reports them as `budgetThinned`, so the recorder can say so (never silent). A row is never thinned
  while it is pinned, named, before its `keep_until`, a line's head, or the newest row of "Original" or of a live line.
  Chunks no row references any more are collected after a 10-minute grace.

**Lines in the store** (what H5 and H7 rely on):

- The line argument of `head()` and `list()`: `undefined` = the line you're on, `null` = "Original", an id = a line
  still being tried.
- `head(null)` is "Original"'s own newest row; it carries `rootHash` and `manifest`.
- **Soft-removed lines.** Removing a line sets `removed_at`, makes it inactive, releases its head and unpins its rows
  (named and other saved kinds stay pinned). Its rows keep their line, so they never become "Original"'s newest row,
  and they age out through thinning. From then on every RPC and the store treat the line as not found: put, set head,
  rename or activate, a second remove, `head(lineId)` (null) and `list(lineId)` (empty), so a stale tab can never
  switch back to it.
- `list({alternativeId: null})` returns "Original"'s rows **plus the rows of removed lines**, each marked by its non-null
  `alternativeId`, so their named saves (kept forever) stay reachable. "You're here" comes from `head()`, never from the
  list's first row.
- **`set_head(null)` does not pin.** "Original"'s head is always its newest row, which thinning never removes. The call
  is still the one to make when leaving "Original"; switching away and back never leaves a pin behind.
- The five-line limit (`MAX_ALTERNATIVES`) counts "Original" plus the lines not removed.

**GC roots and storage sweeps.** History keeps images alive that nothing else references: their paths are in
`comic_version_chunks.paths` and nowhere else. The SQL re-creates `public.collect_active_image_paths()` from the live
definition (the broad, strict `$.**` rule over `projects.state`, `artifacts.data` and `comic_docs.doc`) plus **one
branch**: every path a kept history chunk lists. The guard `public.comic_history_assert_gc_roots()` raises when that
function is missing, lacks the history branch, or is a narrower copy; the SQL file runs it at the end, so a bad apply
fails instead of shipping a hole. **The storage-sweep rule:** no sweep exists today (the nightly purge only counts). Any
future sweep must call `comic_history_assert_gc_roots()` and then `collect_active_image_paths()` immediately before
deleting objects, and refuse to run if the guard raises.

**Applying it (the owner applies).** Before applying, the owner compares the live
`pg_get_functiondef('public.collect_active_image_paths()'::regprocedure)` with section 6 of the file minus the
`history_chunk_paths` branch. Then the owner applies `server/sql/comic_history.sql` (`apply_migration`, name
`comic_history`) before H6's classic-history SQL and before any server runs with `COMIC_HISTORY=1`. The file is
idempotent and fails the migration if RLS, the grants or the GC-roots branch are wrong. After it: the three tables
are empty, anon and authenticated have no table privilege, `select public.comic_history_assert_gc_roots()` returns
true, and `comic_alternatives.removed_at` exists.

## 9. History UI (H5)

Code: `components/comicstudio/history/**` (registered through `history/index.ts`). Every registration renders nothing
while Comic History is off (`caps.history` false, the default): no entry point shows and no history request is made.

**Entry points:**

- **Header** slot `history`, order 240 (after the usage meter, before Read): the History button. It also hosts the
  panel and answers every open request (`OPEN_HISTORY_EVENT` / `requestOpenHistory`).
- **Narrow phone headers.** A compact header shows the icon only from `HISTORY_HEADER_ICON_MIN_WIDTH` (480 px): below
  that one more 44 px icon overflows the header. There History is reached from the board's History tab, the card,
  typed requests and the page and timeline links; a History row in the header's ⋯ menu is a pending wave note for
  `ComicStudio.tsx`.
- **Board tab** `history`, order 510 (after Media).
- **Conversation card** `history` (ids only; it renders by fetching from the owner API, so an old card always shows
  the moment as stored): views list, moment, compare, confirm and undo_ai.
- **Links:** "See this page's history" in the page's versions (`VersionStack`, `PageHistoryLink`), "· History" in the
  book timeline's summary line (`BookTimeline`, `TimelineHistoryLink`), and "See changes since publishing" in the
  share sheet (`ShareSheet`, `ChangesSincePublishLink`).
- **Typed requests** (`intents.ts`, short exact commands only, handled locally and free): "history" / "show history"
  opens the panel; "undo last AI change" sends `history_undo_ai`; a typed "undo" whose newest change the local undo
  stack can't invert (an AI re-plan, a translation run, a render run) opens the undo-AI sheet instead of a dead end
  (`historyUndoFallback`). Anything richer ("go back to how page 3 looked") goes to the director (H4).

**The API and its fake.** The UI never calls the network directly: it reads a `HistoryApi` from `HistoryApiContext`
(the HTTP client, `httpHistoryApi`, by default, on the routes H3 will serve: `HISTORY_ROUTES`). Tests and QA scenes
wrap the components in `<HistoryApiProvider api={createFakeHistoryApi({ live, versions, classic? })}>` from
`historyApi.fake.ts`: an in-memory API on synthetic fixtures that uses the shared `diffBooks` for compare, records every
call, and never touches the network or spends anything. `history.testkit.tsx` sets this up for tests.

**QA scenes** (`history/__scenes__/HistoryScenes.tsx`, for the layout harness `?surface=kit&kit=<scene>`):
`history` (the panel with filmstrip, scrubber and moments by day, a moment's detail, a compare, the reader),
`history-sheets` (restore, save version, undo AI with a conflict) and `history-states` (a brand-new comic, a v4 comic
with "Earlier (images only)", a classic import, and the card in each view). Measured at 360×740 and 1440×900, light
and dark, `?skin=atlas`. Listing them in `qa/KitScenes.tsx` is a pending wave note.

**The RestoreScope each control sends** (every one is a free `history_restore`, with Undo):

| Control | Scope |
|---|---|
| Restore the whole book (restore sheet; always its own tap) | `{kind: 'book'}` with `baseRev` |
| A line's "Use then" (page compare) | `{kind: 'line', pageId, lineId}` |
| A panel's "Use then" | `{kind: 'panel', pageId, panelId}` |
| A page's words, art or both | `{kind: 'page', pageId, mode, part: 'text' / 'art' / 'all'}`; `mode` is `'replace'` (a page deleted since comes back where it was) or `'insert'` (a page that only exists then) |
| A character / a place (book compare) | `{kind: 'character', id}` / `{kind: 'place', id}` |
| The cover | `{kind: 'cover', part}` (`'art'`, `'text'` or `'all'`, whichever changed) |
| The script / the style | `{kind: 'script'}` / `{kind: 'style'}` |
| A language chip | `{kind: 'language', lang}` |

"Save this version" sends `history_save {name, note?}` and "Undo the last AI change" sends
`history_undo_ai {decisions?}`.

- **Out of date confirm.** Bringing back a character, a place, the style, the cover or the script
  (`STALE_CHECK_SCOPES`) can make drawn pages out of date. Before it runs, the UI works out which pages would newly
  show "Out of date" with the shared restore engine and asks: "Pages 2–4 will show Out of date until redrawn. Bring
  <the piece> back anyway?" When that can't be worked out, it asks with "Some pages may show…".
- **Panel drawing follow-up.** When a panel's action, shot or cast comes back, the page's drawing still shows the newer
  panel. The toast says "The drawing still shows the newer panel." and offers "Use the earlier drawing too · Free"
  (`{kind: 'page', part: 'art'}`) or "Redraw page N" with its quote, sent as the timeline's normal `render_pages`
  (the confirm policy applies). With no known price it only opens the page, so a paid redraw is never called free.
- **Undo after a restore** restores the moment saved just before it, with the same scope: the outcome's
  `beforeVersionId` when the stream carries it, else the restore row's `undoId`.
- **404s.** The list answering 404 means History can't be read for this comic: "History isn't available for this comic
  yet." A moment, its book or a compare answering 404 is about that moment only: "This moment isn't kept any more
  (older automatic saves are thinned). Nothing in your comic changed."
- **Earlier (images only).** A comic older than History shows its earlier drawings under "Earlier (images only)", with
  a note saying only drawings were recorded then. Each opens the timeline's MediaPreview, where "Use for this page"
  is free.
