# Pro pages — panels as objects, consistency data (Ship 2 contract)

**Status:** K2a landed (2026-10-30): the shared contract only — types, normalizers, ops with exact inverses, limits, the
`'panel'` job kind and its quote, page-space helpers and staleness parts. Nothing a creator sees changes: no stored doc
has the new fields, no flag is on, and the new ops are not client-patchable until the server sanitizers land (K2b).
A page enters panels mode only when it opts in (`page.artMode = 'panels'`). B4 (the consistency core, §9) and B9 (the
editor engine, §10) landed on top of it as pure shared code that no screen calls yet, so they change nothing a creator
sees either.

**Owner's words** (2026-10-29): one image call per page (D-OWN-1), fewer and larger panels (D-OWN-2), consistency and
detail first (D-OWN-3), an Adobe-like editor where everything can be deleted, dragged, resized and customised
(D-OWN-4), creator confidence (D-OWN-5). Plan: `inv/pro/plan.md` §5.2–§5.6 (the contract) and §10 Wave 2.

## 1. What the contract makes possible

- **Panels become objects.** A drawn page can be shown as its panel *frames* (`Panel.frame`): each frame shows its cut
  of the page's drawing (or another take, or an image), cropped and zoomed, with its own border. Frames move, resize
  and reorder for free; the drawing never changes. Balloons, overlays clipped to a panel and every language's balloon
  overrides follow their frame.
- **Overlays** (`Page.layers`): stickers, images and shapes, optionally kept inside a panel, optionally guide-only
  (never printed).
- **Consistency data:** scenes (`doc.scenes`), what changes from a page on (`page.continuity`), per-panel direction
  (`Panel.direction`), check findings with fix offers (`QcReport.findings`), book settings (`doc.consistency`).
- **Honest staleness:** `VersionMeta.parts` records what a drawing was made from, part by part, so "out of date" can say
  *what* changed ("Panel 2: who's in it") and offer the smallest paid scope.
- **One-panel fixes are quotable:** the `'panel'` job kind is the locked model at the page tier one step down, plus one
  check run. At Standard: 0.0476 (0.0366 on the user's own key).

## 2. Data (`shared/comic/doc.ts`; every field optional, never hashed)

| Where | Field | Notes |
|---|---|---|
| `Panel` | `frame?: PanelFrame` | `{box, fit?, src?, border?, z?, locked?}`; box page-normalized at the **book** aspect, shortest side 0.04 |
| `Panel` | `direction?: PanelDirection` | lens, composition, light, palette, focus, ≤ 4 background details, per-cast staging, off-panel voices |
| `Page` | `artMode?: 'panels'` | read through `artModeOf(page)`, which falls back to `'page'` (I2) |
| `Page` | `frameStyle?: Partial<FrameStyle>` | missing fields are `DEFAULT_FRAME_STYLE`; read through `frameStyleOf` |
| `Page` | `layers?: PageLayer[]` | ≤ 24; ids `ly_…` |
| `Page` | `continuity?: PageContinuity` | outfits, holdings, marks, where; props; ≤ 3 notes |
| `Balloon` | `rot?`, `minH?` | ±45°, ≤ 0.6; shared by every language |
| `ComicDoc` | `scenes?`, `consistency?` | History's book section (extra meta keys) |
| `VersionMeta` | `cuts?`, `parts?`, `anchorKeys?` | in `VERSION_META_KEYS`: a new drawing clears them, history keeps them (I3) |
| `QcReport` | `checkV?: 2`, `findings?` | ≤ 16 findings |

Normalizers (`normalizePanelFrame`, `normalizePageLayers`, `normalizePanelCuts`, `normalizePageContinuity`,
`normalizePanelDirection`, `normalizeScenes`, `normalizeConsistencySettings`, `normalizeVersionParts`,
`normalizeConsistencyFinding`, `normalizeBalloonShip2`) drop what is malformed, clamp ranges, round geometry to 4
decimals and are idempotent. They only run on keys that are present: an old doc normalizes byte-for-byte as before (the
contract test pins the normalized fingerprint of both fixture shapes captured on the base commit).

**I2, `artModeOf(page)`** is `'panels'` only when the page opted in, every panel has a usable frame, and the frames
that show the page's own drawing can be cut from it (the drawing exists, it has cuts, at least one of those panels has
its cut; a panel without one is an empty frame). Anything else — a redraw cleared the cuts, a frame is broken, the cuts
name another plan's panels — shows the page as drawn. Never a crash, never a blank page.

**Asset paths:** `collectAssetPaths` includes frame sources and overlay images on live **and** trashed pages
(GC-protected); `displayAssetPaths` includes those of live pages. `pageSourcePaths(page, {printOnly})` lists them
(readers and exports pass `printOnly`). `mapPanelSourcePaths` is the companion of `mapAssetRefs` for path rewrites;
`dropPanelSourcePaths(doc, drop)` removes the ones an image filter rejects (a History restore leaving out blocked,
deleted, `q/` or forgotten images; forgetting a reference photo, V-4): the frame loses its source, the overlay goes
whole, so no path is left dangling.

## 3. Ops (`shared/comic/ops.ts`) and undo (`shared/comic/undo.ts`)

| Op | Effect |
|---|---|
| `page_frames {pageId, artMode?, frameStyle?, frames?, moveBalloons?}` | frames of one page; everything on a panel whose frame or display changed follows it (I6) unless `moveBalloons: false` |
| `page_cuts {pageId, path, cuts, keepBy?, moveBalloons?}` | only when `path` is the current drawing; written as the user's (`keepBy`: the exact inverse). New cuts can bring the page into frames or change what a frame shows, so the lettering on those panels follows as for `page_frames` (I6) unless `moveBalloons: false` |
| `panels_order`, `panel_add`, `panel_remove` | structural; re-stamp the drawing's `specHash` only on a fresh page shown in frames, before or after (I5). A panel added without a frame shows the page as drawn again (I2); that is how undo brings back a removed frameless panel |
| `layer`, `continuity`, `scene`, `consistency`, `finding` | overlays and consistency data |
| `balloon` | gains `rot`, `minH` (clamped; null clears) |
| `panel` | accepts `direction`; never writes `frame` (frames move only through `page_frames`) |
| `page` | never writes `artMode`, `frameStyle`, `layers`, `continuity` (their own ops do) |

`page_panels` stays server-only (its first producer is `rebind_panels`, K2b).

**Following a frame (I6)** goes *through the picture* when the panel shows the same picture before and after: page
point → image point (old frame) → page point (new frame), so a balloon's tail stays on the head it points at. Otherwise
frame box to frame box. Balloons move by their top-centre and keep their width (lettering never rescales); locked
balloons stay; pinned flags are untouched.

**Cut provenance:** `keepBy` exists so an undo restores the detector's cuts exactly. Once the ops are patchable, the
server must not trust a client's `by`: K2b refuses a `page_cuts` batch with `keepBy` unless its cuts deep-equal cuts
the server itself stamped for that same drawing, and the automatic-panelization shadow counts read only cuts the
server stamped (at stamping time), never `by` from a stored doc.

**The re-stamp rule (I5):** a structural edit of a page shown in frames keeps a fresh drawing fresh (the frames are the
display truth), and leaves a stale one stale. A page shown as drawn is never re-stamped: reordering its script panels
is a real change and reads "Out of date".

**Patchability:** the ten Ship 2 client ops are listed in `PRO_PAGE_PATCH_OPS`. They join `CLIENT_PATCHABLE_OPS` when
`PRO_PAGE_OPS_PATCHABLE` is switched on (one line), together with the server sanitizers (K2b). Until then the server
refuses them in a client batch; clients still apply them from the server (`KNOWN_DOC_OPS`), and `undo.ts` computes
their exact inverses (`INVERTIBLE_OPS`).

## 4. Spaces (`shared/comic/panelize/space.ts`)

- `composeAspect(doc, page)`: the book aspect in panels mode; otherwise exactly the old `letteringAspect`. The lettering
  engine (`letteringAspect`) and the board (`pageAspectOf`) both read it.
- `frameAffine(doc, page, panel)`: page ↔ image for one frame (cover crop, zoom, pan), both ways.
- `pageSpaceQc(doc, page)`: the page check in page space (keep-outs and heads moved into their frames). In page mode it
  returns the stored report itself, so lettering takes today's path byte for byte.
- `pageBoxToImage(doc, page, box)`: a marked region on the picture it shows.
- `upscaleOf(doc, page, panelId, pageWidthPx?)`: how much a panel is enlarged (soft above 1.5×, blurry above 2×).
- `panelPointMap(...)`: where page-space content goes when a frame or the display changes (the ops use it).
- `panelBoxesFor` (`pageGeometry.ts`) returns the frames in panels mode, so balloons, Guided View, the transcript,
  motion export and wireframes follow with no code of their own.

## 5. Parts (`shared/comic/parts.ts`)

`partsOf(doc, page)` → `{panels: {[panelId]: {c, a, p, s, m, d?}}, cont?, places?, props?}`: six-hex fingerprints of
cast (ids, looks), action, place, shot, mood and direction per panel, the page's continuity with its scene, the places
used and the props named. Key order never matters; provenance (`by`) never counts; ≤ 80 keys. The server stamps it on a
new page version (K2b); B4's `partsStale`/`staleReasons` compare it with the live doc. Renders without parts are never
stale from consistency features (I8).

## 6. Limits (`shared/comic/limits.ts`)

`EDITOR_LIMITS` and `CONSISTENCY_LIMITS` are the plan §5.5 values; `PRO_PAGE_LIMITS` holds the ranges and text lengths
the normalizers and the sanitizers share. `CONSISTENCY_LIMITS.placeAnchors` and `propAnchors` (2 each, plan §4.2: "≤ 2
place sheets → ≤ 2 prop sheets") are the per-page anchor caps; `anchors.ts` `ANCHOR_CAPS.placesPerPage` /
`propsPerPage` read them. `PRO_PAGE_LIMITS.maxRefsMax` (16) is at least the largest reference count of
any registered model (a contract test holds it); the comic's model lock caps the real call.

## 7. History (`shared/comic/history/*`)

- `scenes` and `consistency` are book-section (`meta`) keys, captured, compared and restored generically (not typed
  meta keys). Frames, overlays, continuity and directions ride in the `page:` chunk by exclusion; cuts, parts, anchor
  keys and findings in the `art:` chunk.
- `touchedKeys`: frames/overlays/continuity → `page:`; cuts and findings → `art:`; a frame move, or new cuts that carry
  lettering, also touches `art:` (balloons), `page:` (clipped overlays) and the page's translated overrides;
  scenes/consistency → `meta`.
- `opActor(op, origin, doc, action?)`: `panelize_page`, `flatten_page`, `rebind_panels`, `apply_finding` batches are the
  editor's; `fix_panel`, `enrich_pages` the AI's; server panel ops without an action are the editor's.
- Words (`describe.ts` panel moments): "You rearranged the panels on page 2", "The editor made page 2's panels editable
  (no AI cost)", "AI redrew panel 3 on page 2", "Matched page 1's script to its art (free)", "You dismissed a check on
  page 2" / "You brought back a check on page 2", "You showed page 2 as drawn". The recorder adds
  `panelMomentsOfOps(ops, by, doc, action)` to a row's diff items with `withPanelMoments`. The undo label of a finding
  op is neutral ("change a check"): the same op dismisses a check and brings one back.

## 8. Invariants (contract tests in `shared/comic/comic.contract.test.ts`)

I1 golden spec hashes and the normalized fingerprint unchanged on the v4- and v5-shaped fixtures, with every new field
filled · I2 `artModeOf` fallbacks · I3 cuts/parts/anchor keys follow their drawing · I5 re-stamp rule and exact
inverses (property) · I6 frames carry their lettering · I7 client/server parity over random Ship 2 sequences and their
inverses (property) · the `'panel'` quote · op sets disjoint, `page_panels` server-only · frame/layer paths collected ·
History's "every key assigned" with scenes and consistency.

## 9. After K2a: B4 landed, what comes next

**B4, the consistency core** (`shared/comic/{continuity,directions,anchors}.ts`, `plan.ts`; re-exported by the
`shared/comic` barrel). `resolveContinuity` carries what a page changes (outfits and marks book-wide, holdings per
scene, where per page); `lintContinuity` and `lintDirections` find contradictions. `normalizeDirection` coerces the lens
to the shot and keeps off-panel voices out of the page prompt's drawn cast (`drawnCastIds`, so a POV viewer is an
off-panel voice; `offPanel ∉` drawn). `planAnchors` in `ship1` mode is today's `planPageReferences`; in `anchors` mode
(any of places, props or styleKey on — sheetV2 alone stays `ship1`) it follows the plan's §4.2 priorities and caps and
says why each anchor was left out. `staleReasons` / `partsStale` name what changed (never for renders without parts).
`quoteRenderPages` with `anchors: 'auto'` adds only the anchor sheets some page of the run attaches (the others are
`unused`, said in words, never quoted): recurring character sheets, place and prop sheets at 1K, and
`REF_ALLOWANCE_USD` ($0.004) per extra reference (or the model's `perRefUsd`), with the anchor lines returned by kind so
the server's PriceBook re-prices them. `summarizeBook` has a consistency view (per-page anchors, text-only reasons,
changed details, lint, and the book's missing anchors as tickable line items).

Around it: the anchor kinds are the server flag `COMIC_CONSISTENCY_ANCHORS` (unset = every kind off), read once per
request into `StudioCaps.anchorKinds` (`server/src/comic/access.ts` `studioCapsFor`; unset gives `ANCHOR_KINDS_OFF`), so
the client quotes and summarizes with the kinds the runs use. The Model Lab's A/B allowance is the same number
(`LAB_AB_REF_ALLOWANCE_USD = REF_ALLOWANCE_USD`). Nothing calls the anchors quote or the consistency view yet.

**Next.** K2b: server sanitizers (`sanitize/{panels,consistency}.ts`), dispatch of the new actions, `versionMeta`
stamping of cuts/parts/anchor keys, the publication whitelist. Before `PRO_PAGE_OPS_PATCHABLE` flips, the server's
`balloons` sanitizer must keep `rot` and `minH` (the K2a inverses and the editor send whole-page balloon snapshots), and
the cut provenance rule above must hold. The History restore filter and forgetting a photo (H3, `sanitize/refs.ts`)
must drop frame and overlay sources too (`dropPanelSourcePaths`). B1 composition, B2 panelization, B5 (the page prompt
on `planAnchors`), then the C packages (UI) on the editor engine (§10).

## 10. Editor engine (B9)

Code: `shared/comic/editor/` — pure functions (no React, no server imports, no clock) shared by the editor canvas (C1),
lettering (C2), the confidence surfaces (C4) and the director's layout tools (B10). The `shared/comic` barrel exposes
them as one namespace, `comic.editor.*`, so none of their helpers shadows a top-level name.

| Module | What it does |
|---|---|
| `scene.ts` | the page's objects in four bands (page, art, overlays, lettering; z is free only within a band), hit tests, locks, ids, the result shape |
| `transform.ts` | move, resize and rotate math for overlays and balloons |
| `snap.ts`, `align.ts` | snap targets (margins, safe area, frames, gutters, objects, guides); align and distribute |
| `frames.ts` | gutter drag, resize, split, join, add, delete, close gap, equalize, make biggest, close-up, takes, swap pictures, crop |
| `templates.ts`, `layoutText.ts` | the page templates with fit dots and "Best fit"; frames ↔ the layout sentence |
| `drop.ts` | what a drop from the asset bin does (ops, label, cost) |
| `checks.ts`, `readingOrder.ts` | the per-page checklist; reading order of frames and balloons, with its free fix |

**The EditResult contract.** Every edit returns `{ok: true, ops, label, undo, notes?}` or `{ok: false, reason}`.
`ops` are K2a ops; `undo` is `inverseOps(doc, ops)` from `undo.ts` (the one undo path, never a parallel system);
`label` and `reason` are plain words ("Split panel 2 side by side", "It already looks like that."). A label never holds
a price or '$': the UI adds " · Free" or the price through `formatCostForUser`. Ids are deterministic by default
(`pe1`, `le1`, `ly_e1`); the editor UI should pass a random `IdFactory` to split, add, close-up and drop.

**Cuts are named before panels move.** A drawing's cuts that name no panel are matched by position. Before add,
delete, join, split and the "Renumber the panels to match" fix, `withNamedCuts` puts `nameCutsOp(page)` first: one
`page_cuts` op (no `keepBy`, `moveBalloons: false`) that names each cut by the panel showing it now, so each picture
stays with its panel. It is sent only when no cut names a panel yet; its inverse restores the stamped cuts exactly.

**Templates.** Twelve curated layouts led by two to four large panels (Splash, Two tiers, Hero + inset, Big top + two,
Two + big bottom, Tall left + two, Tall right + two, Three tiers, Four grid, Wide + tall left + two, Wide / two / wide,
Fast five) and three webtoon stacks; `DEFAULT_TEMPLATE_ID` is `big-top-two`. Each has frames and a layout sentence in
`parseLayout`'s words; `templatesFor` adds this page's fit dots and marks the best fit; `applyTemplateEdit` writes the
frames, the sentence and the sizes on a page not drawn yet, and only the frames on a drawn page (the art re-fits).
**Hero + inset is offered** (`INSET_TEMPLATES_ON = true`): the blueprint geometry reads the inset clause the editor
writes ("… (panel 1) with a small inset panel in its lower right corner (panel 2)", or "… in the upper left corner of
panel 3 (panel 4)"). `pageGeometry.parseLayout` parses the rows without it and lists each inset in
`ParsedLayout.insets` with its reading number and host; `layoutPanelCount` counts it; `estimatePanelBoxes` puts it in
its host's corner with the editor's numbers (`LAYOUT_INSET`, `layoutInsetBox` = `layoutText`'s `INSET`, `insetBox`).
The server reads the same module (`vision.ts`, `prompts.ts`), and the page prompt measures the rows without the inset
and names it in its host's corner. A sentence without the clause reads exactly as before:
`server/src/comic/layoutSentences.golden.test.ts` pins every sentence the code and the fixtures make (templates,
synthesized and derived sentences, the plan check's candidate blueprints, and the fixture and test literals). A clause
that does not add up (a number used twice or out of range, an inset hosting an inset, or an inset numbered before a
full-page splash) is ignored and the sentence reads as before; `estimatePanelBoxes` always gives one box per panel.
**Not yet: the lettering does not keep a host's balloons off its inset.** The engine
(`shared/comic/lettering/place.ts`, called by `vision.ts` and the client's lettering) places each panel's balloons in its
own box only, and a closing caption's default corner (end-bottom) is the Hero + inset template's inset corner, so a
hero's closing caption can land on the inset. This is the lettering owner's follow-up (the inset boxes become keep-outs
for their host panel's lines only). Until it lands a page gets the inset clause only from the editor engine, which no
screen calls yet, so a creator does not meet it.

**Drops and real people (PD-5).** `PERSON_PHOTO_GUIDE_ONLY` is on: a photo of a real person dropped on a panel offers
the guide-only sticker first (`choices[0]`, a layer with `print: false`, with a warning for the UI to show once) and
filling the panel (printed) second. A drop that changes a drawn panel's plan says `NEEDS_REDRAW` (" · needs a redraw to show").

**Language editions.** `buildScene(doc, page, {lang})` gives `PageScene.lang`: balloon edits (`setBoxEdit`,
`moveEdit`, `alignEdit`, `distributeEdit`) then write that language only (`edition_balloon`); changing only the height
there is refused (`EDITION_HEIGHT_SHARED`: the height is shared by every language); rotation and z-order stay shared.
`distributeEdit` refuses when a locked object sits between the first and the last (`DISTRIBUTE_LOCKED`).

**Checks.** `pageChecks(doc, page, opts)` gives text fits, faces clear, characters, speakers drawn, reading order,
panels match the plan, sharp, empty panels and up to date. Each is `ok`, `look` or `unknown` (checked before that check
existed: it offers the paid re-check). Fixes list free ones first, then paid ones.

- Free, with ops or resolved by `checkFixEdit`: `make_bigger`, `move_line`, `template`, `shrink_text`, `renumber`,
  `swap_lines`, `looks_fine`, `off_panel`, `caption`, `delete_panel`, `close_gap`.
- Free, done by the editor UI or the server (no ops here): `check_edges` (opens "Check the edges"), `move_clear`
  (`lettering/styleOps.ts` `resetPositionOps`), `widen` (`widenOps`), `smaller` (`resizeFrameEdit`), `rebind` (`rebind_panels` with
  the order the check read), `accept_state` and `drop_cast` (`apply_finding`), `undo_changes` (the undo stack),
  `drop_image` (opens the bin).
- Paid, always quoted and approved through the existing gated actions: `recheck`, `redraw_panel`, `redraw_page`,
  `edit_ai`.

**The speakers rule.** A speaker the page check found missing counts as still missing only while they speak there (a
speech, thought, whisper or shout line with words), the shot draws its speakers (not a POV, insert or establishing
shot) and the panel's cast lists them. A cast member also marked off-panel is contradictory and the cast wins, so the
check reads `look`, never a false `ok`. Its fixes: make them a voice from off the panel (out of the cast and the
staging, into `direction.offPanel`, `by: 'user'`), turn their lines into a caption (overlay lettering only), or redraw
the panel (paid).

## 11. Seams and sanitizers (K2b)

K2b made the Ship 2 client ops patchable (`PRO_PAGE_OPS_PATCHABLE = true`) together with their server sanitizers, put
the six Ship 2 actions in the shared contract, and wired every seam the B packages fill. Nothing a creator meets changes
yet: every seam calls a stub that keeps today's behaviour, and every new action is refused by its stub.

**The actions** (`shared/comic/ops.ts`; `doc.ts` names them, so the stream accepts them and the action registry lists
their handlers):

| Action | Kind | Where it runs | Today (stub) |
|---|---|---|---|
| `fix_panel {pageId, panelId, mode, instruction?, region?}` | spend (image) | core: `jobs.ts startSpend` (quote, gate, budget, lock, preflight, reservation, `RenderRun.panelFix`) | `fixPanelProblem` refuses before any quote: "Fixing a single panel isn't available yet. Nothing was drawn or charged." |
| `enrich_pages {pageIds}` | spend (text, `ENRICH_USD_PER_PAGE` = $0.006 a page before the markup) | `actions/consistency.ts`, through the gate like `translate` | a UI click is refused (`NOT_AVAILABLE`, nothing charged). Until the stub declares `unavailable` (below), a director start, or a click on a budget with less than the quote left, still shows its gate card first; approving it is refused the same way |
| `panelize_page`, `rebind_panels`, `apply_finding`, `flatten_page` | free | `actions/{panels,consistency,editor}.ts` | refused with `NOT_AVAILABLE`, nothing changed |

**Refused before any quote.** A registered handler may answer `unavailable(ctx, action)` with its refusal words
(`jobs.ts PreQuoteCheck`). `runFeatureAction` asks it before the estimate and the gate, and `approveGate` before it
re-quotes: the same calm notice an inert stub gives, no card, no quote, no spend, and an open card is left as it was.
Open: `extensions.ts ActionHandler` declares the hook (then `PreQuoteCheck` folds into it), and B7's `enrich_pages` stub
returns `CONSISTENCY_NOT_AVAILABLE` from it; until then that stub can still show a gate card before it refuses.

`render_pages` carries `followFrames` ("Redraw with my layout") and `anchors` ('auto' | 'none'); `edit_page` carries
`pasteBack` ('region', the default whenever a region is marked, or 'page'). The stream parser keeps them on the action.
`fix_panel` and `enrich_pages` are spends everywhere spends are checked: refused for restricted accounts and during a
safety cooldown, and governed users read usage, never '$'. `jobs.ts` re-exports the action types for its importers.

**Sanitizers** (`server/src/comic/sanitize/{panels,consistency}.ts`, registered in `sanitize/index.ts`). Every Ship 2
op is free (no spend, no render, no new asset). A sanitizer rebuilds the op from known keys with bounded values or
rejects the whole batch: 400 malformed (a NaN or out-of-range box, a non-hex colour, an unknown panel, 13 cuts, a line
of another page), 409 `CONFLICT` (cuts for a drawing the page no longer shows), `LIMIT` (25 overlays, 3 extra
pictures) or `CONTENT_POLICY` (a blocked image). Sanitizers see the batch as built so far, so a panel or scene added
earlier in a batch exists for the ops after it.

- **Image paths** (`frame.src`, `layer.src`) follow the "Use for page" (`render_use`) rule, with its very words
  (`OUTSIDE_IMAGE_MESSAGE`, `UNPUBLISHABLE_IMAGE_MESSAGE`, exported by `sanitize/timeline.ts`): an image this comic
  already holds, not blocked, written by the server for this comic and publishable. The page's own drawing is always
  allowed in a frame and does not count as an extra picture.
- `page_frames`: boxes, fit, border (hex colours), z on insets. `page_cuts`: the path must be the page's current
  drawing; at most `EDITOR_LIMITS.maxCuts`; `moveBalloons` boolean only. `panels_order`; `panel_add` (a frameless panel
  is allowed: it is the exact undo of removing one); `panel_remove` (`linesTo` exists, lines per panel held, valid line
  homes); `layer` (`LAYER_ID_RE`, at most 24, the path rule, the name through safeText; `print: false` is a guide-only
  overlay: PD-5 real-person photos default to it); `continuity`, `scene`, `consistency` (safeText; `sceneId` and
  `styleKeyPageId` must exist); `finding` (`dismissed` only).
- Core ops in `jobs.ts`: a `panel` patch accepts `direction` (normalized, never `frame`); `balloon` and the whole-page
  `balloons` keep `rot` and `minH` within the editor limits; a `page` patch drops `artMode`, `frameStyle`, `layers`
  and `continuity` (they have their own ops).
- **Text is stored as written.** `safeText` makes text jsonb-safe, one line and clipped, and never rewrites it:
  `SOFTEN_SAFE_TEXT_ON_STORE` stays `false`. Lead decision: softening for a safe take happens when B5 compiles the text
  into a prompt (`prompts.ts safeText`; `SAFE_TEXT_RATINGS` / `isSafeMode` name safe mode, G and PG), never lossily at
  store time. The whole-batch safety screen still reads every string.

**Who wrote the cuts (`keepBy`).** The server never trusts a client's `by`. `keepBy` (the undo inverse that puts the
detector's cuts back) keeps the incoming `by` only when the cuts deep-equal cuts the server stamped for that drawing:
the page's current cuts while still server-stamped, a version of that drawing in `render.history` (its
`VersionMeta.cuts`), or the process record `STAMPED_CUTS` (remembered when a client first replaces stamped cuts; lost on
a restart). **After a restart** a claim the server can't prove is not refused: `keepBy` is dropped and the cuts are
written as the user's (`by: 'user'`). Undo always works and nothing reads `cuts.by` today. B2 may call
`rememberStampedCuts` when it stamps; exact provenance across restarts (a `cutsStamped` hash in RenderState) is optional.

**The run engine.**

- `versionMeta` stamps `parts`, `cuts` and the anchor keys actually attached on each new page version.
- `followFrames` changes where the layout guide comes from (the page's frames instead of the blueprint) **only while
  `COMIC_LAYOUT_GUIDE` is on**; it is off by default (PD-8), so a redraw with my layout draws as before.
- Place and prop anchor sheets draw at `ANCHOR_SHEET_RES` (`anchorSheetJobFor`; billed as `comic.image.sheet`), the
  resolution the quote prices, and run only when `runDrawsAnchors()` says so (the stub says no).
- `runAfter`: a page's predecessor that throws stops its own dependents; a recorded failure never blocks the chain.
- `prepare()` resolves the generated references (`PANEL_REFERENCE_PATH` `__panel__`, `PAGE_REFERENCE_PATH` `__page__`,
  `BOARD_REFERENCE_PATH` `__board__`) and throws `NOT_FOUND` ("nothing was charged") before any reservation when one
  can't be made.
- Publishing: the public snapshot copies Ship 2 geometry only (art mode, frame style, frames, cut boxes without the
  detector's diagnostics, printed overlays; balloons keep `rot` and `minH`). Frame and overlay pictures go out only as
  checked server art at the rating the publish check verified (`planSnapshot({rating})`); the readiness list names the
  printed photos and panel pictures a page will publish without (`leftOutPictures`, never a blocker).

**The seams and their stubs** (fixed export names; the B packages replace the bodies in place). Every stub is a no-op
that keeps today's behaviour:

| Seam | Owner | Stub behaviour |
|---|---|---|
| `panelize/raster.ts` `cropForPanel`, `pasteIntoCut`, `pasteRegion`, `bakeComposition`, `REGION_FEATHER`, `PANEL_CROP_CONTEXT` | B8 | `null` (a panel fix fails before any reservation); `pasteRegion` returns the whole edited image (today's edit) |
| `actions/panelFix.ts` `fixPanelProblem`, `fixPanelJobs`, `compileFixPanel`, `finishFixPanel`, `fixPanelMeta`, `PANEL_FIX_ACTIONS` | B8 | refuses every fix (nothing quoted as runnable) |
| `actions/panels.ts`, `actions/consistency.ts` (`rebind_panels`, `apply_finding`, `enrich_pages`), `actions/editor.ts` | B2, B7, B8 | `NOT_AVAILABLE`, nothing changed or charged |
| `consistency/contactSheet.ts` `boardForCheck`, `boardImage` | B3 | no board (the page check runs as today) |
| `consistency/findings.ts` `withFindings` | B3 | the QC report unchanged |
| `consistency/schedule.ts` `runDrawsAnchors`, `scheduleRun`, `previousPageFor` | B7 | no anchors; today's order (page 1 alone, then the rest and the cover); the nearest drawn page before |
| `panelize/server.ts` `panelizeAfterLetter`, `AUTO_PANELIZE_FLAG` | B2 | no ops (tracked, never awaited by the page job) |

Still open for B7: whether settle `stored` may use a predecessor whose safety check is still pending as the next
page's reference (the stub uses `done`). For B5: honour `board: false`, emit the generated reference paths, list
`__region__` after `__page__`, and soften directions and continuity on a safe take.
