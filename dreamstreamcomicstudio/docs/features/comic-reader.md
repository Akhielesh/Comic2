# Comic reader: reader tokens and never-blank turns

The immersive reader (`components/comicstudio/immersive/`) is the full-screen reader for a comic's pages: book,
guided view and webtoon. This page is its performance and token contract since Program 3 RD-A (S2a, 2026-11). The
classic inline reader is `components/comicstudio/reader/ComicReaderView.tsx`. The shared design-system view of the
reader tokens is in `docs/design/design-system.md` ("Reader tokens").

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
- A tapped turn onto undecoded pages waits at most 300 ms (`--ds-reader-turn-gate`), and never for a page whose load
  failed. Chained turns and drags never wait.
- The cache is device-sized (`pageImageCache.ts`): blob bytes 96 / 48 / 24 MB and entries 48 / 16 / 12 (desktop, phone
  or ≤ 4 GB, ≤ 2 GB). It trims back when the reader closes, and the reader raises the cap to its own warm set while
  open.
- Preloads: +1 page and its stand-in, −1 page, +2…+3 pages, +4…+5 stand-ins. Save-Data or 2G: stand-ins +1…+2 only. A
  fast 4g link (≥ 5 Mbps): no stand-in preloads, and only the page on screen may fetch one.
- Withheld pages never fetch anything.
- `window.__comicReaderPerf.blankTurns` counts blank turns (the QA log, `leafEngine.ts`).
- Room-side focus and progress use `--ds-reader-hud-focus` / `--ds-reader-accent` (Night `#fafafa`, Day `#3b3026`).
  The fit:width ring is two-tone.
- "Drawn" means drawn and current, plus "· N out of date", in the reader and the board.

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

Deferred (carried to later packages):

- Webtoon stand-ins for the next 2 items, then scroll stand-in preloads: RD-B (S3).
- The share page's cover-card page-1 prefetch (`PublicComicReader.tsx`): RD-5b with DS-R14 (S5).
- Turning the Day room on (`data-reader-room="day"`, the ReaderHud glass token): RD-2 (S3).
- A second reader.turns e2e on pages with no variants (the QA flag is ready): RD-B (S3).
- Keeping the drawn count, the `scaleX` bar and `readerTokens` when the inline reader is reworked, and a per-owner
  `pageImageCache.retain(owner, paths)`: PE-READER-MOTION / DS-6 (S4).
