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

| Object | Stored as | PE-0 behaviour |
|---|---|---|
| Effect | `PageLayer {kind: 'effect', fx: {gen, v, seed, params}}` (`LayerFx`, ≤ `FX_LIMITS.fxBytes`) | Kept when structurally valid (`normalizeLayerFx`); `renderFx` draws nothing yet; an unregistered `gen@v` is inert |
| Sticker | `PageLayer {kind: 'image', src: {lib: {pack, id, v}}}` (exactly one of `src.path` / `src.lib`) | Kept when well formed; resolves to `/library/<pack>/<v>/<id>.svg` (`libAssetUrl`); has no storage path, so GC, signing and History path homes skip it |
| Blend | `PageLayer.blend: 'multiply' \| 'screen' \| 'overlay'` | Kept on any kind |
| Panel border | `PanelFrameBorder.style` (clean, rough, brush, double, dashed, wavy, jagged, film, bleed) + `seed` | Kept when valid; absent = today's clean line |
| Motion | `Page.motion = {clips: MotionClip[] (≤ 48), camera?: {panelId, move}[], hold?}` (`shared/comic/motion/types.ts`) | `normalizePageMotion`: structural only, so a newer build's presets survive a rollback |
| Reader default | `ReaderSettings.motion?: 'on' \| 'off'` | Kept by `pickReader` when set; absent stays absent |
| Text styling | `LetterStyle.fillGradient`, `strokes` (≤ 3), `glow`, `warp`, `warpAmount` (`lettering/style.ts`) | Neutral `PRO_LETTER_DEFAULTS`. A client cannot write them until PE-LETTER; a stored one is kept on load and draws nothing (see "Rollback" below) |
| Bubble shapes, SFX effects, fonts | `PRO_BUBBLE_SHAPES`, `PRO_SFX_EFFECTS` (`style.ts`), `ProFontId` (`lettering/proFonts.ts`, empty) | Not accepted from a client until they draw; a stored one is kept on load and `resolveLetterStyle` draws the cascade's value instead |
| Named styles | `LetteringStyle.named` (≤ 32, names ≤ 40 characters), `Line.styleId` (W0) | Kept on load and by every `letter_style` op, a reset included; not client-writable and not in the cascade until C-STYLES / PE-SERVER |

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
| PE-FX (S2) | `FX_GENERATORS` and `renderFx` (36 entries); one `FX_NAMES` entry per generator (each `name` equals it). Keep generator implementations out of `registry.ts`'s static imports (`renderFx` dispatches through a lazily imported module): the shared barrel re-exports the registry |
| PE-MOTION-ENGINE (S2) | `motion/{beats,easing,presets,sample,reduced,budget}.ts` |
| PE-LETTER (S2) | draws the Pro text styling, shapes and SFX effects, then lets the client sanitizer accept them (the load keep is already in PE-0) and lets `resolveLetterStyle` draw them |
| PE-FONTS (S2) | `PRO_FONT_IDS` |
| PE-COMPOSE, PE-SHELL, PE-INSPECT (S2); PE-ANIMATE, PE-ASSETS, PE-STAGE, PE-PROPS (S3); PE-STICKERS, PE-READER-MOTION (S4) | the client parts |
| S2 integration | flip `PRO_EDIT_OPS_PATCHABLE` after the PE-SERVER deploy; `conflicts.ts` keys `motion` / `page_motion` per page; settle the dangling-motion prune (§7) and add a random-book case with motion to the history property tests |

## 7. Known limits (PE-0)

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
- **Dangling motion and reloads (latent until S2 writes motion).** Ops never prune a clip whose target is deleted (so undo
  brings the animation back), but `normalizeDoc` prunes one whose target is gone from the whole doc. Every reload does
  that: the server hydrate (`store.ts`), a client refetch and History's `joinSections`. Once motion is writable:
  - the History invariant I5 (`history/apply.ts`, "normalizeDoc(after) deep-equals after") fails for a doc that holds a
    dangling clip;
  - a client that refetches drops the clip while the server's session doc keeps it;
  - undo after a reload no longer brings the animation back.
  **S2 integration** chooses one fix before `PRO_EDIT_OPS_PATCHABLE` flips: either prune in the deleting op (line,
  `panel_remove` and layer deletes, and a trash purge, emit the clip removal and the inverse restores it), or make the I5
  check and the restore path tolerate the prune. It also adds a random-book case with motion to the history property
  tests. The dangling-targets test in `proEdit.contract.test.ts` pins today's behaviour.
- **Undo after a rollback can drop stored Pro lettering.** After S2 is rolled back to PE-0, an undo whose inverse carries
  a stored style goes through PE-0's client sanitizers, which refuse the Pro keys. This covers: a `line_style` replace
  restoring a Pro-styled line, re-adding a deleted Pro-styled line, and a `letter_style` restore of a base, kind or
  speaker patch with Pro keys. The load, ordinary edits (a merge keeps them) and `named` are safe. Closing it needs the
  server sanitizers (`sanitize/lettering.ts`, `sanitize/panels.ts`, owned by PE-SERVER) to keep stored Pro keys on an
  inverse. That is a lead decision: S1 did not apply it, and it is carried to S2 PE-SERVER (wave note 9). Reachable only
  after a rollback.
- **An opaque layer clipped to a panel (fixed in S1):** the B9 frame engine's split and join (`editor/frames.ts`) now
  loop over `knownLayersOf(page)`, as `panel_remove` and frame edits already did. They never emit a `layer {clip}`
  patch for an opaque layer, which the server would refuse. An opaque layer's lock never refuses the edit (frame edits
  never move one), and known overlays still follow their panel. Pinned by `shared/comic/editor/frames.test.ts`.
