# One true price: one quote path, one formatter, real rates

Every price Comic Studio and the Images workspace show for a paid step is computed by one function from one price
book, and printed by one formatter. A Draw button, the Approve card it opens, the chip the director posts, the run
that draws it and the credit card that stops it all name the same figure. Planning, style ideas, the page re-check and
translation are priced from what those steps really cost. Governed people (DreamStream's allowance) still see only a
share of their usage, never `$` or cents, and no colour sits on or beside a price.

## 1. The price book

`shared/comic/priceBook.ts` `priceBookFromSources(sources)` (moved from the server's `models/pricing.ts`, which
re-exports it) builds one person's book:

| Figure | Rule |
| --- | --- |
| One image (`unit`) | max(live list + per-reference × refs, observed median): the person's last ≤ 20 same model / kind / resolution calls when n ≥ 3, else everyone's when ≥ 5 people (models.md §2.3). Null when there is no basis. |
| Page check (`qcUsd`) | max(the person's observed QC median when n ≥ 5, `QC_USD_PER_PAGE`). An observed median below the constant no longer lowers it. |
| Text rates (`text`) | the constants × max(1, observed factor) — §3. |

`sources` are the live catalog rows (merged with the registry), the observed medians, observed QC and the text rates.
The server loads them per request (`models/index.ts` `priceSourcesFor` → `createPriceBook`; bounded waits, never
throws: the registry list and the constants on any failure).

## 2. One quote path

- `shared/comic/models.ts` `estimateJobs(jobs, tier, { …, prices })` is the image quote: Σ (unit + one check for page,
  edit and panel jobs) × count × markup unless own key. With a book each unit is the book's (`jobUnitUsd`, registry
  when it has no number) and the check is the book's (`jobQcUsd`); without one it is the registry quote byte for byte.
- `shared/comic/plan.ts` `quoteRenderPages`, `estimateDocJobs`, `unitPrice` and `summarizeBook` take `prices` and pass
  it through (anchor lines included). The server's `jobs.ts` `priceImageJobs` is exactly `estimateJobs` with its book.
- Text steps: `planUsd(pages, byok, prices)`, `styleDirectionsQuoteUsd`, `recheckQuoteUsd` (one vision pass at the
  book's QC) and the translation factor — server gates and chips, the director's summary and the client buttons.

**The price sheet** — `GET /api/comic/models/prices` (owner bearer, text-limited, `private, no-store`) serves the
caller's sources as `PriceSheet { v: 1, at, sources }`: prices and bases only, never a note (notes are words, and
some name dollars). `services/priceSheet.ts` keeps one sheet per signed-in owner per page and builds the book with the
same `priceBookFromSources`. It reads when a view that quotes opens and the sheet is missing or older than 10 minutes,
and again after a drawing run settles (something was drawing, now nothing is: a new observation); concurrent asks
share one request, a failed read keeps the old sheet and waits 2 minutes, an account switch starts from nothing.
Nothing reads on a timer. Until a sheet arrives a surface quotes the registry list, as before.

`components/comicstudio/usage/useStudioPrices.ts` hands the book to every surface that quotes: the Pages tab (Render
all — which now holds overfull pages back in its figure and its count, as the server's plan check does — Render selected, page and cover cards, the clip menu's Redraw / Redesign / Write, the empty plan line), the Cast
and Style tabs, the page editor (draw, edit, re-check), the breakdown card, the progress card's Retry, the style
choice card, notice chips, the plan card, the timeline and version stack, History's quoted redraw, and the quality and
style panels. The model picker's book (`models/priceBook.ts`) takes its numbers from the shared book over the
catalog rows. The Approve card (whole-book approval included), chips, the run and MA's credit card were already
server figures from the same book.

`quotedUsd` on a tapped step is that figure; the server re-quotes with its own book and re-gates only when the fresh
quote is more than 15 % + $0.01 above it, which the shared book now makes rare.

## 3. Text rates from what is really paid

Every text operation tags its calls in the usage ledger (`metadata.textOp = { id, kind, units, baseUsd }`, ids and
numbers only; `server/src/comic/billing.ts`):

| Kind | One operation | `baseUsd` |
| --- | --- | --- |
| `plan` | one planning pass (outline, chunks, the plan check's repair), units = pages written | `PLAN_USD_PER_PAGE` × pages |
| `style_directions` | one proposal call | `STYLE_DIRECTIONS_USD` |
| `translate` | one language (translator chunks and review) | the plan's token estimate (provider cost, uncalibrated) |

The base is always the constant or the token estimate, never a calibrated quote, so a rate never feeds on itself.
Page checks and re-checks use the observed QC median (`comic_image_calls` kind `qc`, already recorded).

`server/src/comic/models/textRates.ts` reads the newest ≤ 1000 tagged `SETTLE` / `BYOK_SETTLED` rows of
`token_ledger_entries` from the last 30 days, once per 10 minutes per process (single flight, 5 s bound, a failed
read keeps the last batch and is retried after 2 minutes; quotes wait at most 1.5 s, then use what is cached). Then:

- an operation counts only when **every** call reported its provider cost (our own guess for a cancelled or timed-out
  call is billed but marked `providerCostReported: false`);
- factor = Σ cost ÷ `baseUsd`; under 0.5 the operation did not finish (stopped, cut short) and is left out; above 10
  it is clipped;
- per kind: the median of the newest ≤ 20 factors — the person's own when they have ≥ 5, else everyone's when those
  come from ≥ 5 people, else nothing;
- quoted = constant × max(1, median). Few observations → the constant; cheaper than the constant → the constant.

Translation also keeps its in-process calibration: the factor is max(1, observed, calibration). The "% of usage"
unit (`standardPageProviderUsd`) stays on the constants: it is a unit both sides convert with, not a quote.

No SQL: the tags ride on the ledger's existing metadata.

## 4. One formatter

`components/comicstudio/conversation/cost.ts` `costFormat(ctx)` prints every price: dollars ("≈ $0.07") for admins and
the person's own key; a share of the usage ("≈2% of your usage", "uses a little of your usage" while unknown) for
governed people. The board's `costFormatFor().quote` is `costFormat(ctx).approx` (0 reads "Free" everywhere); money
already spent keeps the board's per-call precision. The credit card's own-key figures go through the same format.

## 5. The Images workspace

`components/images/ImagePrice.tsx`, under Generate: the book's `jobQuote` on the route's model at the size Generate
sends ('native' is 1K), kind `image` (no page check, no comic observed median), with the references the model
receives on the list basis (Flash takes at most three; more become numbered sheets), × markup unless the person's own
key pays. "≈ $0.04 an image on your OpenRouter key" · "≈0.4% of your usage an image" (governed) · "Each image uses a
little of your usage" (governed, share unknown) · dollars for admins. Generating is a small paid step the person asks
for directly, so it starts at once and states its cost; Generate is described by the line (`aria-describedby`), and a
screen reader hears "Each image costs about $0.04 on your OpenRouter key." Hidden until the route is known and while
the sheet is on its way (the registry list only if the read failed); an unpriced model shows nothing. Muted ink.

## Left out

- A balance check before a standalone image (credit-safety.md covers comic steps).
- The board's spent amounts keep their 3-decimal precision; only prices are unified.
- Consistency-anchor lines: the client quotes them only where it already did (the breakdown's consistency view); the
  run draws anchors only when `COMIC_CONSISTENCY_ANCHORS` is on, which it is not today.

## Tests

`shared/comic/priceBook.test.ts` (floors, the wire sheet, round trip, malformed sheets),
`server/src/comic/models/textRates.test.ts` (few, many, outliers, own vs everyone, unreported and unfinished operations,
the cache, a failed or slow read), `server/src/comic/textRates.quotes.test.ts` (plan, re-check, style and translation
quotes, the ledger tag on a planning pass), `server/src/comic/billing.test.ts` (the tag, a guessed cost not reported),
`server/src/comic/onePrice.parity.test.ts` (the studio's quote from the served sheet equals the server's gate, chips
and `priceImageJobs`), `server/src/routes/comicModels.test.ts` (the sheet route; governed: no `$`),
`services/priceSheet.test.ts` (when it reads, no timer, account switch), `components/comicstudio/usage/onePrice.test.tsx`
(every surface hands its quote helpers the book and never prices from the registry or constants directly; the Pages
tab names the book's figure; governed reads a share), `components/images/ImagePrice.test.tsx`.
