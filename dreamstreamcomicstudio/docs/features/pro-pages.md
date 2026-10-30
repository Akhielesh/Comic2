# Pro pages — panels as objects, consistency data (Ship 2 contract)

**Status:** K2a landed (2026-10-30): the shared contract only — types, normalizers, ops with exact inverses, limits, the
`'panel'` job kind and its quote, page-space helpers and staleness parts. Nothing a creator sees changes: no stored doc
has the new fields, no flag is on, and the new ops are not client-patchable until the server sanitizers land (K2b).
A page enters panels mode only when it opts in (`page.artMode = 'panels'`).

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
the normalizers and the sanitizers share. `PRO_PAGE_LIMITS.maxRefsMax` (16) is at least the largest reference count of
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

## 9. What comes next (not in K2a)

K2b: server sanitizers (`sanitize/{panels,consistency}.ts`), dispatch of the new actions, `versionMeta` stamping of
cuts/parts/anchor keys, the publication whitelist. Before `PRO_PAGE_OPS_PATCHABLE` flips, the server's `balloons`
sanitizer must keep `rot` and `minH` (the K2a inverses and the editor send whole-page balloon snapshots), and the cut
provenance rule above must hold. The History restore filter and forgetting a photo (H3, `sanitize/refs.ts`) must drop
frame and overlay sources too (`dropPanelSourcePaths`). B1 composition, B2 panelization, B4 continuity and anchors, B9 the
editor engine, then the C packages (UI).
