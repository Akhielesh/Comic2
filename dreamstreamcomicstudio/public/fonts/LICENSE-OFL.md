# Self-hosted fonts — licences

The woff2 files in this folder are the Atlas design language's chrome fonts (latin subsets, the same
files Atlas ships under its `public/fonts/`). They are used only when the Atlas skin is on
(`[data-ds-skin="atlas"]`, see `docs/design/atlas-skin.md`); the comic pages themselves keep lettering
in Bangers / Comic Neue / Inter, which `index.html` still loads from Google Fonts.

Both families are licensed under the SIL Open Font License, Version 1.1 (OFL-1.1). The full licence
text is at <https://openfontlicense.org/open-font-license-official-text/> (also distributed with each
family's source repository below). The OFL permits bundling, embedding and redistributing the fonts
with this software as long as they are not sold by themselves and the copyright and licence notices
are kept; the names "IBM Plex" and "Space Grotesk" are Reserved Font Names under that licence.

| Family | Files | Copyright | Source |
| --- | --- | --- | --- |
| IBM Plex Sans | `ibm-plex-sans-latin-{400,500,600,700}-normal.woff2` | Copyright © 2017 IBM Corp. (<https://github.com/IBM/plex>), with Reserved Font Name "Plex" | OFL-1.1 — <https://github.com/IBM/plex/blob/master/LICENSE.txt> |
| Space Grotesk | `space-grotesk-latin-{500,600,700}-normal.woff2` | Copyright 2020 The Space Grotesk Project Authors (<https://github.com/floriankarsten/space-grotesk>) | OFL-1.1 — <https://github.com/floriankarsten/space-grotesk/blob/master/OFL.txt> |

The subsets follow the Fontsource packaging (`@fontsource/ibm-plex-sans`, `@fontsource/space-grotesk`),
which redistributes the families unchanged under the same licence.
