# PptxGenJS 4.0.1 — vendored and patched

- **Upstream:** https://github.com/gitbrent/PptxGenJS, npm `pptxgenjs@4.0.1` (published 2025-06-26, the latest release on
  2026-10-30), file `dist/pptxgen.es.js`.
- **Tarball integrity (npm):** `sha512-TeJISr8wouAuXw4C1F/mC33xbZs/FuEG6nH9FG1Zj+nuPcGMP5YRHl6X+j3HSUnS1f3at6k75ZZXPMZlA5Lj9A==`
- **Licence:** MIT (`LICENSE`, copied unchanged from the tarball). Recorded in `scripts/licence-policy.json`
  (`vendored.records`: `pptxgenjs`, `4.0.1`, MIT, browser scope).
- **Runtime dependency:** `jszip` (the app's own `jszip`, used under its MIT option). Upstream's `image-size` and
  `https` dependencies are not needed: the code that used them is removed below.
- **Why vendored:** the renderers must never fetch a URL or read a path (plan §9, "SSRF" and "Craft-specific" rows).
  Upstream reads `path:` media with `node:fs`, `node:https` or `XMLHttpRequest`, and draws SVG through an `<img>` and a
  canvas. We take images only as `data:` URIs from our own storage, so those paths are cut out of the library itself
  rather than trusted to every caller.
- **Types:** `pptxgen.es.d.ts` is ours: only the API `src/pptx.ts` uses, written against the patched behaviour (no
  `path`, no media, no `writeFile`).

## Patches

Every patched spot is marked `[DreamStream Pn]` in `pptxgen.es.js`. Each of P1–P7 throws an `Error` whose `code` is `'blocked'`
and whose message starts with `blocked:`; `src/pptx.ts` maps it to `RenderError('blocked')`.

| # | Where | Change |
|---|---|---|
| P0 | top of file | A banner, plus the guards: `dsBlocked`, `dsAssertImageData` (`^(data:)?image/(png\|jpeg\|webp);base64,`), `dsAssertHyperlink` (`https://` or `mailto:` only; a `slide` jump is allowed). |
| P1 | `addImageDefinition` (`slide.addImage`, master `image` objects, `tableToSlides` `addImage`) | A non-empty `path` throws (so `path:`, `http:`, `https:` and `file:` sources, absolute or relative, are refused); `data` must be a PNG, JPEG or WebP `data:` image (so SVG and a URL in `data` are refused); an image hyperlink must pass `dsAssertHyperlink`. |
| P2 | `addMediaDefinition` (`slide.addMedia`) | Always throws: no audio, video or online media (plan §9: media insert stays off). |
| P3 | `addBackgroundDefinition` (slide and layout backgrounds, the deprecated `bkgd`) | A background `path` / `src` throws; background `data` must pass `dsAssertImageData`. Colours are unchanged. |
| P4 | `encodeSlideMediaRels` | Replaced: no `node:fs`, `node:https` or `XMLHttpRequest`. Any media rel without data (unreachable after P1–P3) throws. |
| P5 | `createSvgPngPreview` | Replaced: rejects (`<img>` and canvas removed; SVG is refused by P1). |
| P6 | `createHyperlinkRels` (text and table-cell hyperlinks) | A `url` hyperlink must pass `dsAssertHyperlink` (so `javascript:`, `data:`, `http:` and `file:` links are refused). |
| P7 | `writeFile`, `writeFileToBrowser` | Replaced: both reject. No `node:fs` write and no DOM download from inside the library; callers use `write({outputType})` and save the bytes themselves. |
| P8 | `genXmlTextBody` (bug fix) | Upstream writes an `<a:pPr>` before every run of a paragraph (never empty since its ISSUE#589 fix), so a paragraph with two runs (bold inside a sentence, a link) gets a second `<a:pPr>` after its first `<a:r>`, which the DrawingML schema does not allow. Only the first run of a paragraph writes it now. Worth upstreaming. |

P0–P7 are security patches; P8 is a correctness fix. Nothing else is changed: XML generation, charts, tables, text
and the zip writer are upstream's code.

## Updating

`scripts/pptxgenjs-patches.json` holds the exact edits (P0–P8, as `old` → `new` pairs in order) and
`scripts/vendor-pptxgenjs.mjs` applies them, refusing to run when an `old` no longer matches exactly once. The rest of
the file stays byte-for-byte upstream (its CRLF line ends included).

1. `npm pack pptxgenjs@<ver>` in an empty folder; check the tarball's sha512 against the registry's `dist.integrity`;
   `tar -xzf pptxgenjs-<ver>.tgz`.
2. `node packages/platform-render/scripts/vendor-pptxgenjs.mjs package/dist/pptxgen.es.js`. If an edit no longer
   matches, read the upstream change near that function and update the edit by hand. Copy `LICENSE` unchanged, and
   update the version and integrity above and in the JSON.
3. Update `vendored.records[0].version` in `scripts/licence-policy.json` and run `node scripts/licence-check.mjs`.
4. Run `npx vitest run packages/platform-render` (the vendor guard tests fail if any network or file path comes back)
   and regenerate the PPTX goldens on purpose: `UPDATE_GOLDENS=1 npx vitest run packages/platform-render/src/golden.test.ts`.
