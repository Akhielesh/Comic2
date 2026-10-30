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

Every patched spot is marked `[DreamStream Pn]` in `pptxgen.es.js`. Each throws an `Error` whose `code` is `'blocked'`
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

Nothing else is changed: XML generation, charts, tables, text and the zip writer are upstream's code.

## Updating

1. `npm pack pptxgenjs@<ver>` in an empty folder; check the tarball's sha512 against the registry's `dist.integrity`.
2. Re-apply P0–P7 to `package/dist/pptxgen.es.js` (each anchor must match exactly once; review any upstream change
   near a patched function by hand), copy `LICENSE` unchanged, and update the version and integrity above.
3. Update `vendored.records[0].version` in `scripts/licence-policy.json` and run `node scripts/licence-check.mjs`.
4. Run `npx vitest run packages/platform-render` (the vendor guard test fails if any network or file path comes back)
   and regenerate the PPTX golden on purpose: `UPDATE_GOLDENS=1 npx vitest run packages/platform-render`.
