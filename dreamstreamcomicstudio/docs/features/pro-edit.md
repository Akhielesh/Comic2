# Pro Edit (Comic Studio): the Easy | Pro editor

**Status:** PE-0 landed (S1, 2026-11-05): the contract only. The object model, the motion ops, the flags and every
seam exist with their final names; nothing a creator or reader sees changes. Owner sign-off **D5** (the schema: effect
layers, sticker references, `Page.motion`, the new text-style fields; plus the video reveal default) is still pending,
so the contract is **additive and invisible**:

- every stored comic normalizes to the same object as before (fingerprint goldens in `proEdit.contract.test.ts`);
- no `pageSpecHash` (or any other spec hash) moves: no Pro edit ever marks the art out of date;
- no client can write a Pro op or a Pro field (the server sanitizer refuses them until PE-SERVER);
- no UI: the client parts are stubs that render nothing.

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
| `COMIC_READER_MOTION` | `caps.readerMotion` | `off` | off \| all | Readers play the creator's motion |

`server/src/comic/access.ts` reads them once per request (`proCapsFromEnv`, `shared/comic/capabilities.ts`); the client
reads the caps only (`proMotionOn`, `proStickersOn`, `readerMotionOn`). A bare `on` means admins only; reader motion has
no admins stage (readers are not signed in), so only an explicit `all` turns it on (`readerMotionStage`). Details and
rollout criteria: `docs/infrastructure/ENV_MATRIX.md`, "Comic Studio: Pro Edit".

`PRO_EDIT_OPS_PATCHABLE` (`shared/comic/ops.ts`) is a code constant, `false`: the S2 integration flips it **only after**
the PE-SERVER sanitizer is deployed.

## 2. The object model (`shared/comic/doc.ts`, all optional, never hashed)

| Object | Stored as | PE-0 behaviour |
|---|---|---|
| Effect | `PageLayer {kind: 'effect', fx: {gen, v, seed, params}}` (`LayerFx`, ≤ `FX_LIMITS.fxBytes`) | Kept when structurally valid (`normalizeLayerFx`); `renderFx` draws nothing yet; an unregistered `gen@v` is inert |
| Sticker | `PageLayer {kind: 'image', src: {lib: {pack, id, v}}}` (exactly one of `src.path` / `src.lib`) | Kept when well formed; resolves to `/library/<pack>/<v>/<id>.svg` (`libAssetUrl`); has no storage path, so GC, signing and History path homes skip it |
| Blend | `PageLayer.blend: 'multiply' \| 'screen' \| 'overlay'` | Kept on any kind |
| Panel border | `PanelFrameBorder.style` (clean, rough, brush, double, dashed, wavy, jagged, film, bleed) + `seed` | Kept when valid; absent = today's clean line |
| Motion | `Page.motion = {clips: MotionClip[] (≤ 48), camera?: {panelId, move}[], hold?}` (`shared/comic/motion/types.ts`) | `normalizePageMotion`: structural only, so a newer build's presets survive a rollback |
| Reader default | `ReaderSettings.motion?: 'on' \| 'off'` | Kept by `pickReader` when set; absent stays absent |
| Text styling | `LetterStyle.fillGradient`, `strokes` (≤ 3), `glow`, `warp`, `warpAmount` (`lettering/style.ts`) | Types and neutral `PRO_LETTER_DEFAULTS` only; the sanitizer does not accept them until PE-LETTER |
| Bubble shapes, SFX effects, fonts | `PRO_BUBBLE_SHAPES`, `PRO_SFX_EFFECTS` (`style.ts`), `ProFontId` (`lettering/proFonts.ts`, empty) | Not accepted until they draw |

**Opaque passthrough (rollback, graft 1).** The server hydrates through `normalizeDoc` and writes the whole doc back, so a
rolled-back build would strip a newer build's layers for good. `normalizePageLayers` therefore keeps a layer of an
unknown kind exactly as written (valid `ly_…` id, a word for a kind, a valid box, ≤ `FX_LIMITS.opaqueLayerBytes`,
unsafe keys dropped). `isKnownLayerKind` is false for it; it is never drawn (`knownLayersOf`), never in the editor's
scene, never client-writable (the strict `normalizePageLayer` refuses it, so the sanitizer does) and the `layer` op
neither patches nor deletes it. This ships in PE-0 so it is in production one deploy before any effect or sticker
writer (§6).

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
- `'motion'` is in `PAGE_OBJECT_KEYS`: the generic `page` op strips it.
- `page_duplicate` renames the copy's motion: line targets through its line map, panel targets, `at.panelId` and camera
  moves through `remapPanelIds`; layer ids stay (unique per page).

## 4. History, editor scene, seams

- `history/touched.ts`: `motion` / `page_motion` touch `page:<id>` and are the editor's when a job writes them;
  `resolve_conflict` is in `AI_ACTIONS` (the director's held-back changes, applied on "Use the director's").
- `history/describe.ts`: moments `effects`, `stickers`, `motion` ("changed the animation on page 2") and
  `proEditLabel(doc, op)` ("Added speed lines", "Animated “BOOM”: Shake", "Removed the animation from panel 2").
- `editor/scene.ts`: effects and stickers sit in the overlay bands (lettering always on top); `layerWord` names them.
- Shared stubs with final names: `shared/comic/{fx,motion,assets,pro}/{types,index}.ts`, `fx/registry.ts`
  (`FX_GENERATORS` empty, `renderFx` returns `[]`), `lettering/proFonts.ts`. The barrel exposes them as `comic.fx`,
  `comic.motion`, `comic.assets`, `comic.pro`.
- Client stubs: `components/comicstudio/{compose,render}/index.ts` and
  `components/comicstudio/editor/{kit,inspector,layers,assets,animate,stage}/index.ts`, each `part: {id, ready: false}`.
  The shell mounts a part only when it is ready and its flag is on.
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
| PE-SERVER (S2) | `sanitize/motion.ts` (registry ids, clamps, 48 clips, 12 keys, 16 KB per page, 256 KB doc budget, ≤ 3 Hz, target exists); `layerPatchOf` accepts `fx` (registry + `fxParamsOf`), `src.lib` (catalogue), `blend`, border style, and refuses unknown kinds; lettering keys, `named`, `styleId`; `reader.motion`; `publicLayers` / `publicMotion` / `layoutGeometryOf` |
| PE-FX (S2) | `FX_GENERATORS` and `renderFx` (36 entries) |
| PE-MOTION-ENGINE (S2) | `motion/{beats,easing,presets,sample,reduced,budget}.ts` |
| PE-LETTER (S2) | draws the Pro text styling, shapes and SFX effects, then lets the sanitizer accept them |
| PE-FONTS (S2) | `PRO_FONT_IDS` |
| PE-COMPOSE, PE-SHELL, PE-INSPECT (S2); PE-ANIMATE, PE-ASSETS, PE-STAGE, PE-PROPS (S3); PE-STICKERS, PE-READER-MOTION (S4) | the client parts |
| S2 integration | flip `PRO_EDIT_OPS_PATCHABLE` after the PE-SERVER deploy; `conflicts.ts` keys `motion` / `page_motion` per page |

## 7. Known limits (PE-0)

- Exit preset names are not in the plan; `EXIT_PRESET_IDS` mirrors the entrances (pop-out, fade-out, slide-out,
  zoom-out, drop-out, ink-wipe-out), lead to confirm. The ease ids are `ease`, `enter`, `spring`, `linear`, `in`,
  `out`, `in-out`, `damped`.
- The lettering sanitizer is also the load normalizer (`normalizeLine`): PE-LETTER must teach it the Pro text keys one
  deploy before any writer, or a rollback would drop them (the same rule as the opaque layers).
- An opaque layer clipped to a panel: the B9 frame engine's split and join emit `layer {clip}` patches for every layer
  clipped to the panel, which the server refuses for an opaque one (wave note to the frames owner). Reachable only after
  a rollback.
