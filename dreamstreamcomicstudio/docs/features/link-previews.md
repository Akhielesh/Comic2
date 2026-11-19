# Link previews on the comics host

What a link to `comics.dreamstreamstudio.ai` shows when it is pasted into LinkedIn, X, WhatsApp, iMessage, Slack or
Discord, where each part of that card comes from, and how to change it.

Every client gets the same HTML: people, preview bots and search engines alike (no user-agent sniffing). Link
preview bots are not AI agents, so the page half of the agent gate (`comics-edge/src/policy.ts` `shouldGatePage`
with `api-proxy/src/agent-gate.ts`) lets them through.

## The three kinds of link

| Link | Head written by | Title | Image |
|---|---|---|---|
| `https://comics.dreamstreamstudio.ai/` and every SPA path without a head of its own | `comics-edge/src/brand.ts` `HOME_HEAD` (HTMLRewriter at the edge) | Comic Studio — DreamStream | `/icons/comics-og.png?v=<hash>` |
| `https://comics.dreamstreamstudio.ai/library` (302) → `/?view=gallery` | `comics-edge/src/brand.ts` `LIBRARY_HEAD` | Library · Comic Studio | `/icons/comics-library-og.png?v=<hash>` |
| `https://comics.dreamstreamstudio.ai/c/<slug>[?lang=xx]` | `functions/c/[[path]].ts` + `functions/_shared/shareHead.ts` (Pages Function) | the comic's title in the shown edition | `/og/<key>/og-<lang>-<hash>.jpg`, made at publish time |

### Home

The edge replaces the suite head of the shared `index.html` with the Comic Studio head: title, description,
canonical and `og:url` of `https://comics.dreamstreamstudio.ai/`, `og:*` and `twitter:*` (summary_large_image)
with the home card. Nothing from the request is ever reflected into the head.

### The Library

The app draws the Library at `/?view=gallery` (App.tsx restores the view from the query; the share sheet's
"See it in the Library" link is the same URL). The SPA has no `/library` route, so the edge answers
`GET|HEAD /library` and `/library/` with a 302 to `/?view=gallery`, keeping any other query params (utm tags)
behind `view=gallery`. Static files under `/library/<pack>/…` (sticker packs) are not touched.

The Library view carries its own head: title "Library · Comic Studio", its own description, canonical and
`og:url` of `https://comics.dreamstreamstudio.ai/?view=gallery`, and the Library card. The canonical is the page
that answers 200, never the redirect, so a preview service that re-fetches `og:url` lands on the same head (no
redirect loop). A bundled sample opened inside the Library (`/?view=gallery&sample=…`) keeps the Library head.
If the app ever serves `/library` itself, drop the redirect (`comics-edge/src/index.ts`) and set
`LIBRARY_HEAD.canonicalPath` to `/library` in the same change.

### A published comic

`/c/<slug>` is a Pages Function: it reads the anon RPC `comic_share_card` and injects the comic's head
(`renderShareHead`). The edge leaves its head, framing and caching alone (`isSharePath`).

The edition shown is the requested `?lang=` when that language is published, otherwise the comic's default
edition (`pickLang`). With `?lang=en` on a comic whose default is another language, the head carries the English
title and description, `og:locale` `en_US`, the English card image (`og-en-…jpg`), and a canonical and `og:url`
that keep `?lang=en`, so the preview service records the English page. Without `?lang`, the card is in the
default edition. The default edition is the creator's choice (Share sheet); the head never changes it.

## The preview pictures

### Home and Library cards (static)

`public/icons/comics-og.png` and `public/icons/comics-library-og.png` are 1200×630 PNGs in the Atlas ink look:
ink type on white paper (IBM Plex Sans and Space Grotesk from `public/fonts`), the Comic Studio mark
(`components/comicshost/ComicsMark.tsx`) in ink, and the product's own sample comics from
`public/assets/comic-sample` ("The Paper Boat" cover, "The Last Tram" pages, the same files the landing and the
Library's "Studio samples" row show). No user's comic is used.

They are made by `scripts/og-cards.mjs`, which renders a small HTML card per picture in the local Chromium and
palette-quantises it under 200 KB:

```
QA_CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/og-cards.mjs   # from dreamstreamcomicstudio/
```

The script prints each file's short content hash. Copy it into `OG_IMAGE_REV` in `comics-edge/src/brand.ts`:
the image URL carries it as `?v=`, so preview services that cache by image URL (LinkedIn keeps one for days)
fetch the new picture. `comics-edge/src/index.test.ts` fails until the hash matches the file.
`scripts/og-cards.test.ts` checks the size, the format, that the text column has no hue and that the art column is
real colour. (`comics-edge/scripts/gen-comics-icons.mjs` makes only the app icons now.)

### Per-comic cards (made at publish)

`server/src/comic/publication/ogImage.ts` `renderOgCard` draws one 1200×630 JPEG (≤ 300 KB) per published
edition: the blurred cover as backdrop, the cover card, title, description, meta row, and at the bottom right the
Comic Studio mark in ink with "DreamStream Studio". The mark is `ComicsMark.tsx`'s geometry with a light ink
tile and the page cut out in dark paper, as the product shows it on dark paper; the backdrop is always dark, so
it reads on every cover. `ogImage.test.ts` checks the geometry against `ComicsMark.tsx`, that the drawn mark has
no hue, and the file-name hash.

A card's file name is a content hash (`ogHash`). `OG_RENDER_REV` joins that hash, so the first publish after a
template change writes a new file instead of reusing the old card (`buildOg` reuses a card only when the name
matches). Cards are drawn only when a comic is published or updated: a comic published before the change keeps
its old card until its next Update. `functions/og/[[path]].ts` serves them same-origin with a 5-minute cache.

## Checking a card

- Tests: `comics-edge/src/index.test.ts`, `functions/share.test.ts`, `server/src/comic/publication/ogImage.test.ts`,
  `scripts/og-cards.test.ts`.
- Live: one `curl -A 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)' <url>`
  and read the `og:*` tags; LinkedIn's Post Inspector re-scrapes a URL on demand.

## How each part ships

| Part | Files | Reaches production by |
|---|---|---|
| Home and Library heads, `/library` redirect | `comics-edge/src/*` | `.github/workflows/deploy-comics-edge.yml` on a push to `Dreamstrream-v1` touching `comics-edge/**` |
| Home and Library pictures | `public/icons/*.png` | the Cloudflare Pages build of `Dreamstrream-v1` |
| Share-link heads | `functions/c/*`, `functions/_shared/shareHead.ts` | the Pages build (Pages Functions) |
| Per-comic card | `server/src/comic/publication/ogImage.ts` | the backend deploy (`deploy-api-proxy.yml`, `server/**`), then each comic's next publish or Update |
