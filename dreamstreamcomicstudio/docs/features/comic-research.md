# Comic research (as it works today)

Comic Studio can look up a real place, period or event for a comic on Wikipedia and Wikimedia Commons. It is free,
keyless and on for every member who can use Comic Studio; there is no switch. This page describes the code as it is;
change it in the same change that alters the behaviour.

## Where a creator meets it

- **Research sheet** (`components/comicstudio/conversation/StudioComposer.tsx`, the composer's research button, label
  "Research for your comic"; the panel is `ResearchPanel.tsx`, lazy-loaded). One search box ("Place, event, or topic",
  2-120 characters) and a Search button. Results:
  - up to **4 Wikipedia articles**: title, one-line description, a "Source" link and **Add context**;
  - up to **6 Wikimedia Commons pictures**: thumbnail, title, credit and licence, a "Source" link and **Add image**.
- **Director tool** `research_comic` (`server/src/comic/tools/research.ts`, group `research`). It is offered only on a
  turn whose message asks for it in words such as "research", "fact-check", "look up", "find references",
  "historical sources" or "real-world references". It runs the same search and adds a **Research sources** card
  (`cards/ResearchCard.tsx`) with the same results and buttons, without a second search. The tool result the model
  reads holds the article list, at most 3 picture titles with licence and credit, and `incomplete`; the tool
  description tells the model the results are untrusted reference data.
- **Add context** pastes `Research source: {title} ({credit · licence})`, the link and the description into the
  message box; the creator sends it like any other text. **Add image** downloads the thumbnail in the browser
  (JPEG, PNG or WebP, at most 2 MB, 8 s) and attaches it to the message as a reference picture
  (`Visual reference: …` is pasted with it).
- A research card is stored with the conversation; stored cards are re-checked through the same allowlist whenever
  the conversation is normalised (`normalizeCards`, `shared/comic/doc.ts`).

## What leaves the server and the browser

- **Server → Wikipedia:** `GET https://en.wikipedia.org/w/rest.php/v1/search/page?q={search words}&limit=4`.
- **Server → Wikimedia Commons:** `GET https://commons.wikimedia.org/w/api.php` with `generator=search`, file
  namespace, `{search words} filetype:bitmap`, 6 results, image URL, type, licence and artist, 320 px thumbnails.
- Both calls carry only the search words and the app's `User-Agent`; no account, no script, no member IP (they are
  server-to-server). The research code and route write no log line with the search words.
- **Browser → Wikimedia:** the thumbnails load from `upload.wikimedia.org` with no referrer and no credentials, when
  the results show. The privacy page names this under "Research in Comic Studio" (`components/PrivacyPolicy.tsx`,
  section 3).

## The allowlist (`shared/comic/research.ts`, `normalizeComicResearch`)

- Article links: `https://en.wikipedia.org/wiki/…` only. Picture pages: `https://commons.wikimedia.org/wiki/File:…`.
  Thumbnails: `upload.wikimedia.org` or `thumb.wikimedia.org` under `/wikipedia/commons/thumb/`. No other scheme,
  host, port or credentials; query and fragment are dropped; at most 2,048 characters.
- Pictures need a licence of CC0, public domain, CC BY or CC BY-SA (with an optional version); the CC BY ones are
  kept only with a named credit.
- Text has tags and control characters removed and is capped: title 160 (pictures 235), description 260,
  licence 65, credit 160 characters.

## Budget, cache and limits

- Every call goes through `fetchJson` (`server/src/ai/tools/http.ts`): metered as provider `wikipedia` (both hosts),
  **60 a minute and 5,000 a day, shared with Chat** (`wiki_lookup`, the web-search fallback); 7 s per call. A search
  is 2 metered calls.
- Results are cached for **5 minutes** per lower-cased query (120 entries, `TtlCache` in
  `server/src/comic/research.ts`), partial results included.
- Per member: the shared text rate limit on `/api/comic` (`server/src/routes/comicMounts.ts`). The route is
  `POST /api/comic/projects/:id/research` (owner only, `server/src/routes/comic.ts`).

## Failure states

| Situation | What the creator sees |
|---|---|
| Both sources fail | Route 503; the sheet says "Research is temporarily unavailable. Try again in a moment." and keeps the search box. The Director tool says the sources are temporarily unavailable. |
| One source fails | Results with `incomplete: true`: "One source is unavailable. Showing the results we found." |
| Nothing found | "No matches. Try a more specific place or date." |
| A picture cannot be attached | "This image couldn't be attached. You can still open its source." |

## Key files

| File | Role |
|---|---|
| `server/src/comic/research.ts` | the two look-ups, parsing, cache |
| `server/src/comic/tools/research.ts` | the Director tool and its card |
| `server/src/routes/comic.ts` | the sheet's route |
| `shared/comic/research.ts` | result types, text caps, the link and licence allowlist |
| `components/comicstudio/conversation/ResearchPanel.tsx` | the sheet and the card's selector |
| `components/comicstudio/conversation/cards/ResearchCard.tsx` | the Director's card |
| `docs/DATA_CONNECTORS.md` | the "Comic research" row |
