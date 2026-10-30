# Email fixtures (W1.3)

The renderer's contract by example. A change here is a contract change (ADR 0008).

| File | What it is |
|---|---|
| `hostile.json` | **Not a valid EmailDoc**: `check()` refuses it. It is what `renderEmail`, `emailToPlainText` and `reviewEmail` must survive unchecked: script and markup in every text field, `javascript:`, `vbscript:`, `http:`, `data:` and quote-breaking hrefs, SVG and lying `data:` images, a URL image, a path-traversal asset id, nested columns, control and bidi characters, unknown blocks and marks. It also carries a safe link in every place a run can sit (a heading, a paragraph, a quote, a list item, a list inside columns), `https:` and `mailto:` both, so the render test proves every href the HTML has is one `reviewEmail` lists (the contract `full.json` covers safe buttons). |
| `creator-brand.json` | A host-supplied BrandKit (a creator's own): a `data:` logo in the header, a footer line, registry fonts. It passes `checkBrandKit`. |
| `golden.json` | SHA-256 of the HTML and of the plain text for every render case in `src/email/render.test.ts`. |
| `golden/<case>.html`, `golden/<case>.txt` | The same renders, so a diff shows what changed. |

The contract fixtures under `fixtures/contract/email/` (minimal, full, reply) and every built-in template filled with
its own example are rendered too. Regenerate after an intended change with
`UPDATE_EMAIL_GOLDEN=1 npx vitest run packages/platform-core/src/email/render.test.ts` (from the app root), then
review the diff.
