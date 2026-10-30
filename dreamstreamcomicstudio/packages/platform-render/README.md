# @dreamstream/platform-render

The platform's light renderers (plan §4.2, wave 1 package W1.7): Word and PowerPoint files from the platform
contract, and Markdown into the contract. They run in the browser today (a lazy chunk) and, from wave 4, in the light
engine (Node), so the shipped sources compile against the ES2017 library alone: no DOM, no Node, no timers.

| Function | In | Out |
|---|---|---|
| `renderDocx(doc, opts)` | RichDoc v1 | `.docx` bytes (`Uint8Array`) |
| `renderPptx(deck, opts)` | DeckSpec v1 | `.pptx` bytes (`Uint8Array`) |
| `richdocFromMarkdown(md, opts)` | Markdown (CommonMark + GFM) | RichDoc v1 within every contract cap |

Every refusal is a `RenderError` with a stable `code`: `blocked`, `overlap`, `invalid`, `unsupported`,
`asset-missing`, `too-large`.

## Rules

- **Never fetch, never read a path.** Images are `data:` PNG, JPEG or WebP images we already hold, checked by the
  contract's own `s.assetRef()` rule (magic bytes, at most 5 MB). A host asset id (`{kind: 'asset', id}`) goes through
  the host's `resolveAsset(id)`, which answers with a `data:` URI from the host's own storage. Anything else
  (`path:`, `http:`, `https:`, `file:`, SVG) throws `blocked`. WebP is re-encoded by the host's `transcode` (the
  browser passes a canvas one) or refused as `unsupported`, because not every Word and PowerPoint reader takes it.
  Before any decode its header is measured: over 12,000 px a side or 50 megapixels (plan §9) is `too-large`, and a
  size that cannot be read is `unsupported`, so a tiny file declaring a gigapixel canvas never reaches the canvas.
- **The vendored PptxGenJS refuses the same things itself** (`src/vendor/pptxgenjs/PATCHES.md`, P0–P9): no `path`,
  no URL or SVG image, no media, no background path, `https:`/`mailto:` hyperlinks only, no `node:fs`, `node:https`,
  `XMLHttpRequest` or `writeFile`. P8 fixes an upstream bug (one `<a:pPr>` per paragraph); P9 makes each chart's
  embedded workbook name the deck's author instead of the library.
- **Links survive only as `https:` or `mailto:`** (`isSafeHref` from platform-core); any other link keeps its text and
  loses the link. Text is escaped by the writers and cleaned of characters XML cannot carry and of bidi overrides.
- **Markdown is data.** Raw HTML is dropped at any depth, list items and table cells included (with the content of
  `<script>`, `<style>` and similar, up to the closing tag even across emphasis or link spans), images are never
  fetched (only valid `data:` images become image blocks, placed after the table when they sit in a cell, whose text
  keeps `[alt]`; others keep `[alt]`), and every cap holds: runs ≤ 4,000
  characters, tables ≤ 50 × 12 (long tables continue with the header repeated), ≤ 2,000 blocks per section, ≤ 200
  sections, input ≤ 2,000,000 characters.
- **Decks are laid out by their own rectangles.** `renderPptx` refuses a deck while two `content` elements of a
  slide overlap (`RenderError('overlap')`, with every pair in `overlaps`), using the rule of platform-core's
  `overlapCheck` (`contentOverlaps` here; a host may pass `overlapCheck` itself).
- **Page breaks are sections** in DOCX: `pageBreakBefore` gives a next-page section break, otherwise a continuous one,
  so no paragraph is restyled to carry a break.

## Brand

`opts.brand` takes a BrandKit (platform-core `src/brand/brandKit.ts`) or any object with its `docStyles` and
`deckTheme` fields (`RenderBrand`). DOCX: body and heading fonts, colours and sizes, line spacing and link colour go
into the file's style sheet (Normal, Heading 1–3, Hyperlink, Lead, Quote, Caption and the comic-script styles), so an
edited file keeps the brand. PPTX: `theme.preset: 'brand'` takes the kit's deck theme, `light`/`dark` are fixed, and
the deck's own colours win; titles use the kit's title font. Fonts are registry ids; pass
`fontFamily: (id) => platformFont(id)?.family` to name the installed family (without it, `space-grotesk` becomes
`Space Grotesk`, which Office matches regardless of case). The default kit (`DEFAULT_RENDER_BRAND`) carries the values
platform-core's `DREAMSTREAM_BRAND` derives from the skin tokens.

## Using it in the app

Never import this package statically from app code: `services/platformExport.ts` loads each renderer with its own
`import()` (`./docx`, `./pptx`, `./markdown`) the first time it is needed, so `docx`, PptxGenJS and remark stay out of
the entry chunk and an export downloads only its own renderer (a deck never pays for docx or remark; a chat
document's Word file never pays for PptxGenJS). It maps every failure to the app's `ExportError` with a message for
the person exporting (`exportDocx`, `exportPptx`, `exportMarkdownDocx`, `downloadPlatformFile`). esbuild estimate,
minified (gzip): docx 463 KB (136 KB), pptx 376 KB (127 KB), markdown 116 KB (34 KB), plus a 17 KB shared chunk.

Markers for an entry-chunk test (literals that survive minification and live only in one renderer chunk):
`w:document` (docx), `addMedia() is disabled` (the vendored PptxGenJS's P2 guard). Comments (`[DreamStream P0]`) and
package names (`remark-gfm`, which the chat already uses) are not markers.

## Dependencies

`docx` 9.11.0 (MIT, pinned exactly in the app's `package.json`; the newest 9.x at least two weeks old on 2026-10-30),
`unified` 11.0.5 and `remark-parse` 11.0.0 (MIT, pinned exactly), `remark-gfm` (MIT, already a dependency), and the
vendored PptxGenJS 4.0.1 (MIT, `src/vendor/pptxgenjs`, with its `LICENSE` and `PATCHES.md`, recorded in
`scripts/licence-policy.json`). Adding or bumping one goes through the licence gate (`node scripts/licence-check.mjs`).

## Tests

`npx vitest run packages/platform-render` (from the app root):

- `golden.test.ts`: three DOCX and two PPTX outputs as normalised XML (`render.testkit.ts`: every part name, the
  content parts one tag per line, media by sha256, and each chart's embedded workbook unzipped: its sheet, shared
  strings and properties; timestamps, random relationship ids, GUIDs and PptxGenJS's chart
  counter normalised). **Regenerate them on purpose only**, and review the diff:
  `UPDATE_GOLDENS=1 npx vitest run packages/platform-render/src/golden.test.ts` (also `npm run goldens` here).
- `docx.test.ts`, `pptx.test.ts`, `markdown.test.ts`: brand styles, blocked image sources (with `fetch` and
  `XMLHttpRequest` spied on), overlap refusal, links, escaping, caps, the vendored library's guards and an AST scan of
  its source.
- `purity.test.ts`: imports and globals of the shipped sources, `.js` on every relative import, and a compile against
  ES2017 alone (`tsconfig.json`).
