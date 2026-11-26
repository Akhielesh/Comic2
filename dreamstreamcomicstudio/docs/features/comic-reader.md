# Comic reader: page turns, reader tokens and never-blank turns

The immersive reader (`components/comicstudio/immersive/`) is the full-screen reader for a comic's pages: book,
guided view and webtoon. This page is its performance and token contract since Program 3 RD-A (S2a, 2026-11), and
the page-turn contract every reader shares (fx-reader, 2026-11). The inline reader is
`components/comicstudio/reader/ComicReaderView.tsx`; older (Classic) comics open in `components/ComicReader.tsx`. The
shared design-system view of the reader tokens is in `docs/design/design-system.md` ("Reader tokens").

## Page turns: flip, paper, slide, fade

Four styles, listed in this order everywhere (`PAGE_TURN_STYLES`, `shared/comic/doc.ts`):

- **Flip** (the default): the new page swings in from the spine. It is the Classic reader's original Page Flip:
  index.css's `pageFlipNext` / `pageFlipPrev` keyframes through `.animate-page-flip-next` / `-prev`
  (perspective(1600px) rotateY(∓28deg) scale(0.96) at 0.35 opacity, flat after 0.45 s on cubic-bezier(0.22,1,0.36,1)).
  Transform and opacity only, no per-frame JS (`reader/pageFlip.ts` puts the class on and takes it off). Right-to-left
  books mirror it (the classes swap). A spread swings as a pair around its spine.
- **Paper**: the drag-to-fold paper turn. The only style that follows the finger.
- **Slide** and **Fade**: the turn engine's slide and crossfade.

Which style a reader gets (`turnStyleFor`, `immersive/readerPrefs.ts`): the reader's own choice (the full-screen
reader's settings: "Page turn style", stored on the device), else the creator's (`creatorTurnOf`), else the flip.

- The creator picks in the board's Read tab, Reader look → Page turn (or asks the director, `set_reader_options`).
  A pick stores `reader.turn` with `turnChosen: true`.
- Past comics keep working with no migration. Every comic saved before the flip came back stored `turn: 'paper'` as the
  old default (and that is still how "no choice" is stored, so stored docs and their hashes are unchanged): without
  `turnChosen` it reads as the flip. A comic with no reader settings flips. 'slide' and 'fade' (only ever stored by a
  choice) keep theirs, and so does a chosen paper turn. Undoing a pick on an old comic brings the flip back.
- In the reader's settings, picking the creator's own style follows the creator again (the stored preference goes back
  to 'auto'); choosing Page turn over Scroll never rewrites the style. The comic's own style is named under the
  picker ("Paper is this comic's own style."), on screen and read with the group, so a phone shows it too.
- A reader's own pick is stored with `turnPicked: true`. Release #316's Reading mode switch wrote `turn: 'paper'`
  whenever a reader went back to turning pages; that was never a pick, so a stored 'paper' without the mark reads as
  'auto' (the creator's style, else the flip). Stored 'slide' and 'fade' were always picks and keep.

Where it applies: the Classic reader (it has no creator style: the flip, unless the reader picked another), the inline
reader (the board's Read tab, public, shared and embed readers, Studio Originals), the immersive reader and the
landing's sample comic. Buttons, the arrow keys, Space, PageUp/PageDown, the page edges, a swipe (≥ 45 px, mostly
horizontal, `FLIP_SWIPE_PX`), the scrubber, and Home and End all turn with the style, and the page-turn sound plays
when it is on (Home and End included). A
pinch or a zoomed page never turns. The Classic toolbar reads "Page flip" / "Scroll", and so does its phone menu; on
phones the art and the dialogue under it swing together. Its stored reading state (`flip` or `scroll`) restores as
before.

Reduce motion (the device setting, or the reader's own in the full-screen reader's settings) changes the page at once
in every reader and every style: no swing, no fold. The landing's sample reads the reader's setting through
`immersive/readerMotionPref.ts` alone, so the landing's first load carries none of the reader's preference model.

No blank turn: a flip mounts the incoming page out of sight and swings it in once its pictures have decoded (inline,
at most 1.8 s, `FLIP_DECODE_MS`). In the immersive reader a tapped turn waits up to 300 ms for the pages themselves,
then holds on (1.8 s in all, `NEVER_BLANK_MS`, the same wait) until each page has at least its stand-in; a failed load
never holds it. A turn pressed right after a zoom waits for the camera to return to the whole page. While a flip waits
(the gate, the camera), the page you are on stays on screen and the new one stays hidden, decoding; it shows in the
same commit that its swing class goes on (`BookStage.tsx`, `swinging`), so it never sits flat or blank first. A flip
called back while it waits never shows the new page.

Inline reader details: a webtoon (and any fit-to-width page) opens the next page at its top, and the previous one at
its foot. A page taller than its window swings about the middle of what shows of it (`flipOriginY`), never the middle
of the whole tall page, so the visible slice swings from the spine instead of shearing. Below 560 px the toolbar's
arrows and counter are pinned outside the scrolling, faded lead, so Next never looks disabled at 320 px. Below 400 px
the row still fits with them: the counter shows just "3/12" (the whole "Page 2 · 3/12" is still read out), Share
moves into the More menu, and when four controls would still trail the row (an embed's link, the language picker,
More and Full screen) Full screen joins the menu too. The Classic stage keeps its padding for a slide or fade preview,
so those land at the page's own size. Auto-hiding chrome lays the page (and the scroll column) out below the measured toolbar. A
page is read out as "Page n of N", N being the book's page count. The QA scene `page-flip`
(`/qa/comic-qa.html?surface=app&scene=page-flip`) shows a live stage in all four styles and both directions, and the
swing held part-way, at every smoke viewport.

Proof: `reader/pageFlip.test.ts`, `reader/PaperTurnSurface.test.tsx`, `reader/ComicReaderView.flip.test.tsx`,
`ComicReader.flip.test.tsx`, `immersive/turnPlan.test.ts`, `immersive/leafEngine.test.ts`,
`immersive/ImmersiveReader.test.tsx`, `immersive/readerGpu.test.tsx` (the gate), `immersive/readerPrefs.test.ts` (the
chain and the unmarked 'paper'), `shared/comic/comic.contract.test.ts` (old docs), `comicshost/ComicsLanding.atlas.test.tsx`
(the sample's Reduce motion), `reader/ComicReaderView.test.tsx` (the phone-narrow toolbar),
`tests/e2e/public.reader.spec.ts` (the row fits on every device), and the server's `sanitize/reader.test.ts` and
`tools/reader.test.ts` (asking for the flip a comic already gets stores nothing).

## Reader tokens and never-blank turns (RD-A)

- `readerDesigns.css` on `[data-reader-root]` is the one motion and ink token set for the reader. `readerTokens.ts`
  reads it once per mount. "Fade" is 280 ms everywhere (`--ds-reader-turn-fade`).
- Per-frame writes are transform and opacity only: the spotlight is four shutters (`GuidedCamera.tsx`), the edges use
  `translateX`, and progress uses `scaleX`.
- Loading states are still paper, never the `studio-shimmer` (it animates `background-position`, a full-box repaint
  every frame): the immersive cover and pages (`ReaderSlot.tsx`, `ComicPageView stillLoading`) show the toned paper,
  and the classic reader's scroll view (`ComicReaderView.tsx`) the reader paper. `readerGpu.test.tsx` and
  `ComicReaderView.test.tsx` fail if a shimmer comes back under the reader.
- A page shows its source, then the cached original, then the fit variant, then the 480w stand-in, and cross-fades in
  over 120 ms (`--ds-reader-standin-swap`). A page with no stand-in (pages stored before variants) stands on the reader
  paper washed 14 % with the nearest cached page palette (`PAPER_TONE_ALPHA`, `ReaderSlot.tsx`), never white.
- A tapped turn onto undecoded pages waits at most 300 ms (`--ds-reader-turn-gate`) for the pages themselves, then
  holds on (1.8 s in all) until each has at least its stand-in, and never for a page whose load failed. Chained turns
  and drags never wait.
- The cache is device-sized (`pageImageCache.ts`): blob bytes 96 / 48 / 24 MB and entries 48 / 16 / 12 (desktop, phone
  or ≤ 4 GB, ≤ 2 GB). It trims back when the reader closes, and the reader raises the cap to its own warm set while
  open.
- Preloads: +1 page and its stand-in, −1 page, +2…+3 pages, +4…+5 stand-ins. Save-Data or 2G: stand-ins +1…+2 only. A
  fast 4g link (≥ 5 Mbps): no stand-in preloads, and only the page on screen may fetch one.
- Withheld pages never fetch anything.
- `window.__comicReaderPerf.blankTurns` counts blank turns (the QA log, `leafEngine.ts`).
- Room-side focus and progress use `--ds-reader-hud-focus` / `--ds-reader-accent` (Night `#fafafa`, Day `#3b3026`).
  The fit:width ring is two-tone.
- "Drawn" means drawn and current, plus "· N out of date", in the board and in the studio's Read tab: that line is the
  author's working status, so only the owner sees it (`ComicReaderView` `showDrawnStatus`); a shared or public reader
  never renders it. Below 560 px the inline toolbar keeps one row (the leading controls scroll sideways), so the menus
  and Full screen stay on it at 360 px.

Proof: `components/comicstudio/immersive/*.test.*` (the combined suite), `tests/config/tokenContrast.test.ts` ("the
reader rooms"), and the e2e `tests/e2e/reader.turns.spec.ts`. The e2e delays every fixture image through the public
`QaHarness.delayImages`. The QA flag `&variants=0` strips page and cover variants, for pages stored before variants.

## Reserved names

The `--ds-reader-*` names are DreamStream reader-scope names on `[data-reader-root]`, not skin tokens: they are not in
`:root` or the brand skins, and the Atlas session is told they are reserved (`docs/design/atlas-skin.md`). The reader
takes no colour-layer token (no spark, hue or art: `sparkGuard.test.ts` and `tokenContrast.test.ts`). The motion comic
export reads `--ds-reader-room` and `--ds-reader-paper-back` from `:root`, so both stay there (AV-0).

## S2a decisions and what is deferred

Recorded choices (the lead keeps them): the device-aware cache and its trim on close; the palette-washed paper for
pages with no stand-in; the turn gate for tapped and key turns only, never waiting on a failed load; no stand-in
preloads on a fast 4g link; the two-tone fit:width ring. The e2e file `tests/e2e/reader.turns.spec.ts` lives outside
the immersive folder by a lead grant.

Share links reuse the edge's cover variant when the comic snapshot arrives. Once the cover loads, or
the reader focuses or points at a reading control, the card warms one small variant for the first
reading page in the shared image cache. It skips the warmup on Save-Data and 2G connections. Links
that open directly on an interior page skip the edge's cover preload.

Reader settings offer Night and Day room light. The choice stays on the device and only changes
the room around the artwork. Reduced-motion and low-power settings still apply in either room.

Deferred (carried to later packages):

- Webtoon stand-ins for the next 2 items, then scroll stand-in preloads: RD-B (S3).
- A second reader.turns e2e on pages with no variants (the QA flag is ready): RD-B (S3).
- Keeping the drawn count, the `scaleX` bar and `readerTokens` when the inline reader is reworked, and a per-owner
  `pageImageCache.retain(owner, paths)`: PE-READER-MOTION / DS-6 (S4).
