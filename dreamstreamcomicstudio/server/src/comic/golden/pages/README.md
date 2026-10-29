# Golden page prompts

Synthetic docs shaped like the owner's measured pages, and the exact page prompt Ship 1 compiles
for each. No production data: names, looks and paths (`u/golden/…`) are invented.

| Key | Shaped like | Why it is in the set |
|---|---|---|
| `courier-p2` | b4b5774f p2 | 6 panels in 2-1-3 rows; the most words in the smallest panels; a POV panel whose viewer was forced into the cast |
| `courier-p4` | b4b5774f p4 | a wide row over a tall panel beside a stack; a long caption; a silent insert |
| `pond-p1` | f8312c86 p1 | a 4:5 storybook page whose protagonist is an **extra** with a ready sheet and 4 photos, in every panel |

- `fixtures.ts` — `pageFixtures()` / `pageFixture(key)`: fresh normalized docs, the target page, its
  previous page and `pins` (the page's `pageSpecHash` before Ship 1, in today's serialisation and in
  back-compat F1's canonical one).
- `*.prompt.txt` — the golden prompts (`courier-p2.guide.prompt.txt` is the same page with the layout
  guide attached). Ship 2 (B5) must compile a doc without new data to these byte for byte.
- `pages.test.ts` — the Ship 1 checks: no blank-bar wording, one block per panel (box N, Must show, Who
  with an identity anchor, Speaks or OFF-PANEL VOICE), the extra's sheet within the character slots,
  the layout guide as Image 1, and `pageSpecHash` unchanged.

Changing the page prompt changes these files on purpose: run
`npx vitest run server/src/comic/golden/pages -u`, then read the diff like code before committing.
