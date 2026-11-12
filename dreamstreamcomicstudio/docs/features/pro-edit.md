# Pro Edit (Comic Studio): the Easy | Pro editor

**Status:** PE-0 landed (S1, 2026-11-05): the contract only. The object model, the motion ops, the flags and every
seam exist with their final names; nothing a creator or reader sees changes. Owner sign-off **D5** (the schema: effect
layers, sticker references, `Page.motion`, the new text-style fields; plus the video reveal default) is still pending,
so the contract is **additive and invisible**:

- every stored comic normalizes to the same object as before (fingerprint goldens in `proEdit.contract.test.ts`);
- no `pageSpecHash` (or any other spec hash) moves: no Pro edit ever marks the art out of date;
- no client can write a Pro op or a Pro field (the server sanitizer refuses them until PE-SERVER);
- no UI: the client parts are stubs that render nothing.

**S1 integration** (on `integ/s1`; nothing visible changes):
- `studioApi.asCaps` copies `proMotion`, `proStickers` and `readerMotion` when the server sends them as booleans. The
  client therefore sees the three caps, though no Pro UI reads them yet.
- The B9 frame engine's split and join leave opaque layers as written (§7).
- `COMIC_READER_MOTION` follows the lead's rule (§1).
- The exit preset and ease names are accepted (§7).

**S2b (on `integ/s2b`, local until PE-0 is in production one deploy earlier; master plan §6 item 4):** PE-SERVER (S2):
server gate built, still behind `PRO_EDIT_OPS_PATCHABLE = false`. PE-MOTION-ENGINE, PE-FX, PE-LETTER, PE-COMPOSE,
PE-FONTS, PE-SHELL and PE-INSPECT are merged (§6); the parts `compose`, `kit`, `inspector` and `layers` are ready
(`proEdit.contract.test.ts` pins the list). With the switch off no client can write a Pro op or field (C-9): the Pro
controls in the inspector render but stay behind it. The lead decisions taken at the S2b integration are in §10, with
the invented numbers and designs to review before the flip.

Plan: the master plan, Program 2 (§2.1–§2.12). Packages after PE-0: PE-1 (S2) PE-SERVER, PE-COMPOSE, PE-FX,
PE-MOTION-ENGINE, PE-LETTER, PE-FONTS, PE-SHELL, PE-INSPECT; PE-2 (S3); PE-3 (S4); PE-4 (S5).

**What it is for:** one Easy | Pro switch on the same editor, document and undo stack. Pro adds layers, effects,
assets, numeric fields and an animation timeline anchored to reading beats. Every Pro edit is free software ("Free —
done by the editor, no AI cost"); "Pro" is never "paid".

## 1. Flags

| Env var | Cap | Default | Stages | Turns on |
|---|---|---|---|---|
| `COMIC_PRO_EDITOR_V2` (W0) | `caps.proEditorV2` | `admins` | off \| admins \| all | The workspace: header switch, docked inspector, numeric fields, Layers |
| `COMIC_PRO_MOTION` | `caps.proMotion` | `off` | off \| admins \| all | Easy Animate row, timeline, motion edits, "Export this page as video" |
| `COMIC_PRO_STICKERS` | `caps.proStickers` | `off` | off \| admins \| all | The Stickers tab (after D6, PE-LICENCE and the credits block) |
| `COMIC_READER_MOTION` | `caps.readerMotion` | `off` | off \| all (`on` = all) | Readers play the creator's motion |

`server/src/comic/access.ts` reads them once per request (`proCapsFromEnv`, `shared/comic/capabilities.ts`). The client
reads only the caps (`asCaps` in `studioApi.ts`, then `proMotionOn`, `proStickersOn`, `readerMotionOn`). A bare `on` means admins only for motion and stickers;
reader motion has no admins stage (readers are not signed in), so a bare `on` (`true`, `1`, `all`, `everyone`) turns it on
for everyone and `admins` stays off (`readerMotionStage`, lead decision S1). Details and
rollout criteria: `docs/infrastructure/ENV_MATRIX.md`, "Comic Studio: Pro Edit".

`PRO_EDIT_OPS_PATCHABLE` (`shared/comic/ops.ts`) is a code constant, `false`: the S2 integration flips it **only after**
the PE-SERVER sanitizer is deployed.

## 2. The object model (`shared/comic/doc.ts`, all optional, never hashed)

| Object | Stored as | Behaviour (PE-0, then S2b) |
|---|---|---|
| Effect | `PageLayer {kind: 'effect', fx: {gen, v, seed, params}}` (`LayerFx`, ≤ `FX_LIMITS.fxBytes`) | Kept when structurally valid (`normalizeLayerFx`). 14 generators are registered (`fx/registry.ts`). Their drawings load lazily with `fx/generators.ts`: compose calls `import()` the first time a page holds an effect and before exports, and the Pro editor's pickers do the same. Until then `renderFx` draws nothing. An unregistered `gen@v` is inert. Nodes are fill-only paths, circles and rects in the 0..1 box (≤ 400 segments), drawn under one box transform; generators use `ctx.aspect` so marks keep their shape |
| Sticker | `PageLayer {kind: 'image', src: {lib: {pack, id, v}}}` (exactly one of `src.path` / `src.lib`) | Kept when well formed; resolves to `/library/<pack>/<v>/<id>.svg` (`libAssetUrl`); has no storage path, so GC, signing and History path homes skip it |
| Blend | `PageLayer.blend: 'multiply' \| 'screen' \| 'overlay'` | Kept on any kind; drawn (PE-COMPOSE) |
| Panel border | `PanelFrameBorder.style` (clean, rough, brush, double, dashed, wavy, jagged, film, bleed) + `seed` | Kept when valid; absent = today's clean line; drawn (PE-COMPOSE) |
| Motion | `Page.motion = {clips: MotionClip[] (≤ 48), camera?: {panelId, move}[], hold?}` (`shared/comic/motion/types.ts`) | `normalizePageMotion`: structural only, so a newer build's presets survive a rollback |
| Reader default | `ReaderSettings.motion?: 'on' \| 'off'` | Kept by `pickReader` when set; absent stays absent |
| Text styling | `LetterStyle.fillGradient`, `strokes` (≤ 3), `glow`, `warp`, `warpAmount` (`lettering/style.ts`) | Neutral `PRO_LETTER_DEFAULTS`. Drawn by PE-LETTER: glow as stacked strokes, gradient as a userSpaceOnUse linearGradient (mapped into each warped glyph's frame), ≤ 3 stacked outlines superseding textStroke, per-glyph warp for Latin and CJK editions; client writes only with `allowPro` (= `PRO_EDIT_OPS_PATCHABLE`). A stored one is kept on load (see "Rollback" below) |
| Bubble shapes, SFX effects, fonts | `PRO_BUBBLE_SHAPES`, `PRO_SFX_EFFECTS` (`style.ts`), `PRO_FONT_IDS` / `ProFontId` (28 faces, `lettering/proFonts.ts`; metadata `PRO_FONT_REGISTRY` in `lettering/fonts.ts`) | 6 Pro shapes and 5 S2 SFX effects draw (`DRAWN_PRO_SFX_EFFECTS`); `halftone_fill` is kept, not drawn, until S3; the Pro fonts draw (PE-FONTS). A client writes them only with `allowPro`; a stored id this build cannot draw is kept on load and `resolveLetterStyle` draws the cascade's value instead |
| Named styles | `LetteringStyle.named` (≤ 32, names ≤ 40 characters), `Line.styleId` (W0) | In the cascade between `doc.kinds` and `doc.speakers`; delete folds back (`foldNamedStyle`; refused calmly via `foldRefusal` when a fold would pass 2 KB); a reset keeps them. Client-writable only with `allowPro`. The server `line` op keeps a `styleId` that names a saved style while the switch is on and drops every `styleId` while it is off, as before PE-SERVER; the publication carries it |
| Looks | `PRO_LETTERING_PRESET_IDS` (16) beside the 8 | A stored unknown look keeps its patches and draws as classic |
| Rotation | `Balloon.rot`, `Balloon.minH` | Drawn; the tail tip stays on its point; a linked chain turns by its head's `rot`. Not gated (C-9) |

**Opaque passthrough (rollback, graft 1).** The server hydrates through `normalizeDoc` and writes the whole doc back, so a
rolled-back build would strip a newer build's layers for good. `normalizePageLayers` therefore keeps a layer of an
unknown kind exactly as written (valid `ly_…` id, a word for a kind, a valid box, ≤ `FX_LIMITS.opaqueLayerBytes`,
unsafe keys dropped). `isKnownLayerKind` is false for it; it is never drawn (`knownLayersOf`), never in the editor's
scene, never client-writable (the strict `normalizePageLayer` refuses it, so the sanitizer does) and the `layer` op
neither patches nor deletes it. This ships in PE-0 so it is in production one deploy before any effect or sticker
writer (§6).

**Rollback: what a newer build stored survives this one.** The same rule covers lettering: `normalizeDoc` calls the
lettering sanitizers with `{keepStoredPro: true}` (`normalizeLine` and the doc's `letterStyle`), which keeps the Pro text
keys, a Pro shape, SFX effect or font id and `letterStyle.named`, structurally checked. Client sanitizers never pass the
option, so a client still cannot store any of them. `resolveLetterStyle` skips a value this build cannot draw, so every
line draws exactly as before and the exhaustive records keyed by shape, effect and font only ever see drawn ids. An opaque
layer is also left as written by frame edits (`followFrames`) and panel removal, and no inverse ever patches one, so the
server accepts the undo.

**Load bounds vs write bounds.** The load normalizers apply only the plan's own bounds (48 clips, 12 keys, at −2000..10000
ms, dur 100..4000 ms, repeat 0..20, 3 strokes, 32 named styles, one camera move per panel) and the byte budgets
(`MOTION_LIMITS.pageBytes`: clips past it are dropped from the end; `FX_LIMITS.fxBytes`; `FX_LIMITS.opaqueLayerBytes`).
Every other number is kept as stored when finite (sign checks only), and text as stored. The bounds PE-0 invented (marked
"WRITE, LEAD TO CONFIRM" in `limits.ts`: key ranges, `holdMaxMs`, `paramsPerClip`, `paramTextChars`, `paramsPerFx`,
`strokeWMax`, `glowSizeMax`, `warpAmountMax`) belong to the PE-SERVER sanitizer and the players, so S2 can change one
without another load-side deploy.

**Dangling targets are inert.** A clip whose target is gone is skipped by every player, so undoing a delete brings the
animation back. `normalizeDoc` prunes a clip (or camera move) only when its target is absent from the whole document,
trash included (`pruneDanglingMotion`).

## 3. Ops (`shared/comic/ops.ts`, `undo.ts`)

- **`layer` (existing)** carries `fx`, `src.lib`, `blend`; the border style rides `page_frames`. No new op for objects.
- **`{op: 'motion', pageId, id, patch: MotionClipPatch | null, index?}`** upserts (null clears an optional key) or
  deletes one clip.
- **`{op: 'page_motion', pageId, patch: {camera?, hold?} | null}`** replaces the camera list and/or the hold; patch null
  clears both (the clips stay).
- Both sit in `PRO_EDIT_OPS`, behind `PRO_EDIT_OPS_PATCHABLE = false`, and are in `INVERTIBLE_OPS` and `KNOWN_DOC_OPS`
  from day one (an old tab that receives one refetches). Each has an exact inverse in `undo.ts`.
- **Server gate (PE-SERVER):** `motion` / `page_motion` go through `server/src/comic/sanitize/motion.ts` (registry ids
  and schemas, clamps, 12 keys, 48 clips, 16 KB page, 256 KB doc, ≤ 3 Hz per clip and per page), and the whole batch is
  checked as it will be stored (`motionPatchScreen`). A batch that would lose a clip it did not delete (the op's
  49th-clip skip or `normalizePageMotion`'s 16 KB trim from the end) is refused; only targets, start panels and camera
  moves the batch adds or changes must be on the page (dangling stored values are inert).
- `'motion'` is in `PAGE_OBJECT_KEYS`: the generic `page` op strips it.
- `page_duplicate` renames the copy's motion: line targets through its line map, panel targets, `at.panelId` and camera
  moves through `remapPanelIds`; layer ids stay (unique per page).

## 4. History, editor scene, seams

- `history/touched.ts`: `motion` / `page_motion` touch `page:<id>` and are the editor's when a job writes them;
  `resolve_conflict` is in `AI_ACTIONS` (the director's held-back changes, applied on "Use the director's").
- `history/describe.ts`: moments `effects`, `stickers`, `motion` ("changed the animation on page 2") and
  `proEditLabel(doc, op)` ("Added speed lines", "Animated “BOOM”: Shake", "Removed the animation from panel 2").
- `editor/scene.ts`: effects and stickers sit in the overlay bands (lettering always on top); `layerWord` names them.
- Effect names come from `fx/names.ts` (`FX_NAMES`, `fxName`; metadata only). The editor scene and History import it,
  never `fx/index.ts` or `fx/registry.ts`, so generator code never follows into those bundles (a source scan holds it).
- Shared modules with final names: `shared/comic/{fx,motion,assets,pro}/{types,index}.ts`, `fx/registry.ts`
  (`FX_GENERATORS`: 14 generators with names, groups and parameter schemas, frozen all the way down; the barrel carries
  these schemas only), `lettering/proFonts.ts`. `renderFx` dispatches to drawings registered by `fx/generators.ts`,
  which is never imported by the barrel or statically by anyone (a source scan holds it). It reads parameters through
  `fxParamsOf` and memoizes by (gen, v, seed, aspect, params). Drawing helpers are in `fx/draw.ts` (Pro chunk). The
  library's seeded geometry is in `fx/seed.ts`, the only fx module the library shim and the reader reach. `FX_PRESETS`
  (42 named presets: lines 6, bursts 8, emanata 12, atmosphere 6, borders 10) live in `fx/generators.ts`. The barrel
  exposes the modules as `comic.fx`, `comic.motion`, `comic.assets`, `comic.pro`.
- Client stubs: `components/comicstudio/{compose,render}/index.ts` and
  `components/comicstudio/editor/{kit,inspector,layers,assets,animate,stage}/index.ts`, each `part: {id, ready}`. After
  S2b `compose`, `kit`, `inspector` and `layers` are ready; `render`, `assets`, `animate` and `stage` are still stubs
  (S3). The shell mounts a part only when it is ready and its flag is on.
- Limits (`shared/comic/limits.ts`): `MOTION_LIMITS` (48 clips, 12 keys, 16 KB per page, 256 KB per doc, ≤ 3 Hz
  flashes), `FX_LIMITS` (1 KB per effect, 400 segments, 2 KB opaque layer), `PRO_LETTER_LIMITS`.

## 5. Contract tests

`shared/comic/proEdit.contract.test.ts` (and `server/src/comic/proEdit.server.test.ts`): stored fixtures normalize
deep-equal; `pageSpecHash` goldens unchanged; every new op followed by its inverse returns the original document; a
duplicated page carries renamed motion; the `page` patch strips `motion`; an unknown layer kind round-trips and is never
drawn; `PRO_EDIT_OPS ∩ CLIENT_PATCHABLE_OPS = ∅` while the switch is false; the Pro ops contain no spend action; a
source scan (TypeScript AST) proves `components/comicstudio/editor/**` (and `compose`, `render`) never imports
`editActionFor` and never calls `studio.act`; the server refuses every Pro op and field a client could send.

## 6. What each later package fills in

| Package | Fills |
|---|---|
| PE-SERVER (S2) | **Done** (behind `PRO_EDIT_OPS_PATCHABLE = false`): `sanitize/motion.ts` (registry ids, clamps, 48 clips, 12 keys, 16 KB per page, 256 KB doc budget, ≤ 3 Hz, target on the page after the batch: `motionPatchScreen`); `layerPatchOf` accepts `fx` (registry + `fxParamsOf`), `src.lib` (catalogue), `blend`, border style, and refuses unknown kinds; lettering keys, `named`, `styleId`; `reader.motion`; `publicLayers` / `publicMotion` / `layoutGeometryOf`. Also: lib triples are refused calmly until PE-ASSETS; with the switch off a client may re-send layer `kind: 'effect'`, `fx`, `blend` and `src.lib` only when they equal the stored JSON of the same layer id (A1, lead decision D1), and stored Pro lettering is kept on an inverse; the border look is carried through with the switch off; `reader.motion` is accepted on, and re-asserted off; the publication carries fx, `src.lib`, blend, the border look and `styleId`; page motion is published, and counted in the fingerprint, only while `COMIC_READER_MOTION` is `all` (`snapshot.ts` `readerMotionPublished`, lead decision D2); turning it on shows comics with motion as changed until they are republished |
| PE-FX (S2) | **Done:** 14 generators, 42 named presets, `FX_NAMES` per generator. `library/procedural/textures.ts` re-exports the moved seed, speed, focus, bokeh and rain code from `fx/seed.ts`. Tones and paper are PE-TONES's (S3). (The plan row said 36 entries; the 42 presets are on the D5 review list, §10) |
| PE-MOTION-ENGINE (S2) | **Done:** `motion/{beats,easing,presets,sample,reduced,budget}.ts` — `pageBeats` (the export's beats, golden-tested), every `EASE_IDS` curve, one pure curve + param schema + flash count per preset and camera move, `sampleAt` / `planMotion` / `samplePlan` (anchored to beats, keys override channel by channel, dangling inert, chain keyed by head, write bounds clamped at draw time, ≤ 3 Hz guard), Calm/reduced/poster readings, byte and flash budgets for PE-SERVER; `words.ts` label leaf; ≤ 3 Hz verdict per target and per panel area (visibility: opacity, reveal, collapsing scale) |
| PE-LETTER (S2) | **Done;** client acceptance behind `allowPro`: draws the Pro text styling, shapes and SFX effects, the 16 Pro looks, named styles in the cascade, rotation and minimum height (§2) |
| PE-FONTS (S2) | **Done:** `PRO_FONT_IDS` (28 faces), self-hosted Noto (no Google CSS2), lazy face tables (`fontFiles.ts` `LAZY_FONT_FILES`, each wait bounded by the caller's timeout) and the picker sprite (`fontSpecimens.ts`, under 60 KB; regenerate with `npx tsx scripts/build-font-specimens.mjs`). Lead decisions at the S2b integration: **D15** keeps the six CJK weights (the deploy stays within the Pages limits of 20,000 files and 25 MiB per file); **D16** the new packages come only through `package.json` and the lockfile (no npm install, ci or prune against a shared tree; the integration worktree used its own node_modules overlay) |
| PE-COMPOSE (S2) | **Compose part ready:** one page node tree for screen, print, PNG, PDF, ZIP; effects via `renderFx` with drawings loaded lazily through compose's `setFxLoader` seam (exports and print await it); stickers via `libAssetUrl`; blend as mix-blend-mode / globalCompositeOperation, composited once per layer through one pooled buffer (`docs/features/pro-pages.md` §9, B1 composition; lead decision D18) |
| PE-SHELL, PE-INSPECT (S2) | **Done:** the Easy \| Pro switch and the Pro workspace (§8); the docked inspector and Layers (§9) |
| PE-ANIMATE, PE-ASSETS, PE-STAGE, PE-PROPS (S3); PE-STICKERS, PE-READER-MOTION (S4) | the remaining client parts |
| S2 integration | **Done at S2b:** `conflicts.ts` keys `motion` per clip and `page_motion` per page (camera moves and hold); the history property tests run over random books with page motion. **Not in S2b:** flip `PRO_EDIT_OPS_PATCHABLE` (the lead, after the PE-SERVER deploy), and the dangling-motion prune (§7, lead decision D3), both in the package that flips the switch |

## 7. Known limits (PE-0, amended in S2b)

- **Accepted by the lead (S1), as named:**
  - the exit preset names: `EXIT_PRESET_IDS` mirrors the entrances (pop-out, fade-out, slide-out, zoom-out, drop-out,
    ink-wipe-out);
  - the ease ids: `ease`, `enter`, `spring`, `linear`, `in`, `out`, `in-out`, `damped`;
  - the reader-motion rule (§1).
- **Lead to confirm (invented by PE-0; the plan names none):**
  - the write bounds in `limits.ts` (`holdMaxMs` 10 s, `paramsPerClip` 8, `paramTextChars` 32, key ranges ±1 / 0..8 /
    ±720°, `paramsPerFx` 16, FX `paramTextChars` 32, `strokeWMax` 0.3, `glowSizeMax` 0.5, `warpAmountMax` 1). The load
    path never applies them (§2), so changing one needs no extra deploy;
  - `CALM_EXCLUDED_PRESETS` adds `jitter` (a shake) and `blink` (a flicker) to the plan's shake, flicker and zoom-punch;
  - the Layers note copy `LETTERING_ON_TOP_NOTE` (§2.4 gives no words);
  - `proEditLabel` quotes a line with the house curly quotes (“BOOM”) where §2.3's example uses straight ones.
- **PE-MOTION-ENGINE amendments (S2b):**
  - Amendment 1: the `sy` channel.
  - Amendment 3: visibility counts as a flash (opacity, reveal, collapsing scale), read with the one-second-window rule,
    summed per drawn target and per panel area (lead decision D4 confirms it as built).
  - Amendment 4: the ≤ 3 Hz guard holds visibility (the opacity hold over 3 Hz).
  - Amendment 5: playback follows `MOTION_PRESETS[id].role`; the stored role is ignored.
  - Amendment 6: `'reveal'` anchors on panels and overlays mean panel start + 450 ms (`REVEAL_LEAD_MS`); a `'panel'`
    anchor without `panelId` uses the target's own panel; chain members are timed from the head.
  - Amendment 8: the poster drops exits; under reduced motion entrances and exits jump at their start and the rest is
    off; `explicitPlay` overrides reduced motion.
  - Amendment 12: entrances and exits play once.
  - Amendment 13: flicker is seed-free, so the server's seed-0 count bounds every player.
- **Dangling motion and reloads (latent until S2 writes motion).** Ops never prune a clip whose target is deleted (so undo
  brings the animation back), but `normalizeDoc` prunes one whose target is gone from the whole doc. Every reload does
  that: the server hydrate (`store.ts`), a client refetch and History's `joinSections`. Once motion is writable:
  - the History invariant I5 (`history/apply.ts`, "normalizeDoc(after) deep-equals after") fails for a doc that holds a
    dangling clip;
  - a client that refetches drops the clip while the server's session doc keeps it;
  - undo after a reload no longer brings the animation back.
  **Lead decision D3 (S2b):** prune in the deleting op (line, `panel_remove` and layer deletes, and a trash purge, emit
  the clip removal and the inverse restores it), so History stays exact and the target check stays strict. It is not
  built in S2b: the package that flips `PRO_EDIT_OPS_PATCHABLE` builds it first. The random-book case with motion is in
  the history property tests (S2b). The dangling-targets test in `proEdit.contract.test.ts` and PE-SERVER's pinned test
  keep today's behaviour.
- **Undo after a rollback: mostly closed by PE-SERVER (re-assert).** Still lossy: re-adding a deleted Pro-styled line
  or a deleted effect/sticker overlay, undoing a lettering reset or a `line_style` replace that dropped the Pro keys,
  and (switch off) undoing `panel_remove` of a styled panel.
- **Undo of a lettering edit on a newer build's look (fixed at S2b-INT):** every `letter_style` inverse is a reset, then
  the stored look with its base, kinds and speakers. The shared op used to drop that restore when the look was an id this
  build does not know (kept on load), so one undo after a rollback reset the comic's whole lettering to classic. The op
  now applies any well-formed stored look id (`isStoredLookId`, `lettering/style.ts`); which look a client may send stays
  the server's call (a pickable look, or the doc's own stored one re-asserted). Pinned by `proEdit.contract.test.ts` and
  `server/src/comic/sanitize/lettering.pro.test.ts`.
- **Named styles (PE-LETTER):** trashed lines that use a deleted named style keep the link (and draw without it if
  restored). `Line.styleId` was not kept by the server `line` op or by the publication on PE-LETTER's branch (its notes
  19-20); PE-SERVER and the S2b integration close both: the `line` op keeps a link to a saved style while the switch is
  on, and a published linked line resolves the studio's lettering.
- **An opaque layer clipped to a panel (fixed in S1):** the B9 frame engine's split and join (`editor/frames.ts`) now
  loop over `knownLayersOf(page)`, as `panel_remove` and frame edits already did. They never emit a `layer {clip}`
  patch for an opaque layer, which the server would refuse. An opaque layer's lock never refuses the edit (frame edits
  never move one), and known overlays still follow their panel. Pinned by `shared/comic/editor/frames.test.ts`.

## 8. The Easy | Pro switch and the Pro workspace (PE-SHELL)

Behind `COMIC_PRO_EDITOR_V2` (`caps.proEditorV2`); with the flag off the editor is exactly today's (the flag-off DOM is
pinned by `board/PageEditor.flagOff.test.tsx`).

- **The switch** (`editor/ProModeSwitch.tsx`, in the editor header): a view, never an op. It is the one Easy | Pro
  switch with the flag on; the floating and sheet lettering inspectors draw none of their own.
- **D7, phones:** a phone shows Easy until `useStudioMode`'s `comicstudio.mode` holds a choice, then follows it; there is
  no second key (`editor/useProEditor.ts` `editorViewFor`).
- **Coach tips:** `comicstudio.editor.proTips` is a JSON array of dismissed ids; tips only point at reachable panels and
  come back from `?`.
- **Layouts** (`editor/ProWorkspace.tsx`): docked from 1024 with a fine pointer (rail, canvas, docked inspector:
  Properties | Layers | Assets | AI), the 280 px Layers / Assets rail on the left at 1440 (only while a part fills it),
  the 768 tool row with a Layers / Assets drawer and the inspector sheet capped at 40%, and on phones a Layers sheet above
  the thumb bar (a side sheet in landscape).
- **Tools and keys** (`editor/keys.ts`, `editor/shortcuts.ts`): V T B S U M H Z pick Select, Text, Balloon, Sound effect,
  Shapes, Mark up, Hand and Zoom; Shift+P switches Easy | Pro; `?` opens the shortcut sheet; Tab / Shift+Tab walk the
  balloons in reading order; Cmd+A selects every balloon; R / Shift+R rotate 15°.
- **Parts contract:** each part is `{part, loadPanel, Panel, samples}`; `selectLayers` selects from the Layers panel; Edit
  lettering opens the lettering inspector; the arrow fix; the height floor (`minH`).
- **The lazy split:** the workspace, tool rail and Pro panels load through the `editor/proLazy.ts` doors only while the
  flag is on, so the Easy path and the reader download no Pro editor code.
- `PRO_EDIT_OPS_PATCHABLE` is unaffected: the shell writes no Pro field.
- **Lead decision D17 (S2b):** PE-SHELL's Easy-path budget is accepted for S2b. PE-SHELL measured the PageEditor chunk
  at +3.2 KB gz (within the 5 KB budget) and the studio route at +8.3 KB gz with the flag off; the S2b verify step
  re-measures it after the merges, and the remaining work goes to PE-SHELL-2 (S3), with PE-QA pinning the numbers.

## 9. The docked inspector and Layers (PE-INSPECT)

- **The Properties tab:** the kind row with keys 1-6; typed X/Y/W/H/rotation in % or mm/in; typed size, tracking,
  leading, border, padding, tail width and opacity. A typed value always goes to the balloon it was typed for.
- **Align** to the selection, panel or page; one balloon aligns to its panel. Distribute across or down. Copy / Paste
  style with Cmd+Alt+C / V.
- **Behind `PRO_EDIT_OPS_PATCHABLE`:** gradient, 3 outlines, glow, warp (`WARP_SCRIPT_NOTE` outside Latin and CJK),
  6 shapes, 5 SFX effects, Pro fonts, Pro looks and saved styles (save, use, update, rename, duplicate,
  delete-folds-back).
- **Empty state:** the comic's lettering style and the page facts ("N with a set position").
- **Layers** (`editor/layers/LayersPanel.tsx`): front band first; reading-order groups for every panel, empty groups
  included as drop targets; the eye hides in this view only; lock; drag or Alt+Up/Down to restack; drag or
  Alt+Left/Right for `line_move`; overlay rows select; touch checkboxes; the "Director is editing" badge (an icon on
  touch); a polite live region.
- The Pro half is a lazy chunk (`lettering/pro/*`, `lettering/proStyleOps.ts`).

## 10. Lead decisions at the S2b integration (2026-11-12)

- **D1 (a):** PE-SERVER's switch-off re-assert of layer fields stays as built (§6). `PRO_EDIT_OPS_PATCHABLE` stays
  `false`.
- **D2 (a):** page motion is published only while `COMIC_READER_MOTION` is `all`; the flag stays `off` until
  PE-READER-MOTION (S4) (`docs/infrastructure/ENV_MATRIX.md`, Pro Edit).
- **D3 (a):** dangling motion is pruned in the deleting op, built by the package that flips the switch (§7).
- **D4 (a):** the flash rule as built (§7, amendment 3).
- **D5 (a):** the invented numbers and designs are confirmed for S2b. None is writable while the switch is off.
  **To review before the flip** (in the package that flips `PRO_EDIT_OPS_PATCHABLE`):
  - PE-MOTION-ENGINE build amendment 11: the preset defaults and the flashing defaults (≤ 3 Hz);
  - PE-SERVER build risk 5: the write bounds `holdMaxMs`, `paramsPerClip`, the key ranges and `paramsPerFx`, now
    enforced by `sanitize/motion.ts` (with PE-0's other invented bounds, §7);
  - PE-COMPOSE build amendments 4 and 5: the nine border looks; line shapes, radius, `strokeW` and image stretch;
  - PE-LETTER build amendment 1: its four extra looks (superhero, fantasy, comedy, zine);
  - PE-FX build amendment 1: 42 named presets where the plan row said 36.
- **D6 (a):** the new files outside the packages' Owns are granted: `shared/comic/motion/words.ts`,
  `shared/comic/fx/draw.ts`, `components/ds/overlayLayer.ts`, PE-SHELL's new editor files, PE-INSPECT's
  `lettering/pro/*` and `lettering/proStyleOps.ts`, and PE-FONTS's generated `fontTables/*` and `fontSpecimens.{ts,png}`.
- **D7 (a):** the test edits outside the Owns are accepted.
- **D15 (a), D16 (b):** the PE-FONTS row in §6.
- **D17 (a):** §8.
- **D18 (a):** `docs/features/pro-pages.md` §9 (B1 composition).
