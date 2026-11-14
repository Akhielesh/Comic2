# Models workspace

The `/models` page uses Atlas primitives and tokens, with the search, provider filtering, price columns and model details informed by [OpenRouter's model directory](https://openrouter.ai/models). Comic Studio keeps its own image lock and Director role choices; choosing a text default here does not overwrite them or an existing Chat conversation's pinned model.

## Scope and sources

- **Language:** ten featured model makers, initially up to three recent models each. Search and provider filters expose the rest of their supported text models. This is an editorial shortlist, not a claim that these makers occupy the ten highest benchmark ranks. Maker and serving connection are separate; each row names its serving connection.
- **Image:** four currently supported Comic models plus FLUX.3 for reference. Studio support is explicit. Reference price is tied to resolution and a registry observation date. A missing price is unknown, never free.
- **Benchmark:** all five image cards use Artificial Analysis text-to-image results from the [primary leaderboard](https://artificialanalysis.ai/image/leaderboard/text-to-image). The November 13, 2026 snapshot preserves exact tested variants, sample counts and dates. A `(max)` benchmark setting is not a claim about the cost of the selected Studio resolution. Other boards and history retain their own dates.
- **Response time:** successful Chat turns without tools, pooled across serving connections over seven days. This measures full response time, not tokens per second, first-token latency or intelligence. Different prompts and output lengths prevent controlled speed comparisons.
- **Usage:** monthly aggregate counters from recorded Chat responses and successful Comic calls. These are platform counts, not personal billing or provider market share. Missing records and failed reads have different UI states.

## Generated examples and privacy

`GET /api/models/showcase` joins registry facts with attributed published library images and privacy-approved image-call aggregates. With an authenticated session it also includes a bounded selection from that user's recent Comic documents and that owner's recorded image-call measurements. Only ready generated assets with explicit model provenance qualify; the project model lock is never substituted for an asset's model. Private images have short-lived signed URLs and are never included in a shared cache or public response.

The page clears private examples, measurements and open image dialogs on account changes. An explicit Your results / Platform results switch keeps private and aggregate observations separate. Private medians use the latest at most 20 successful priced or timed calls per exact model, kind and resolution, with at least three samples, from at most the latest 500 owner calls in 30 days. Cost and timing sample sizes can differ. These are provider-reported costs, not the customer billing amount. They are group observations, never an asserted cost for the displayed individual image. Published snapshots currently omit model provenance, so those images cannot be assigned to a model just by inspecting the artwork. An empty gallery is intentional until qualifying assets exist. No generated examples, measured latency, costs or usage are fabricated.

## Freshness and connections

The catalog combines live discovery, durable discoveries and explicitly dated curated fallback entries. A filtered browser request never replaces the full cached catalog. Each model carries catalog/pricing provenance and last observation; refresh failure retains the last usable list with a notice. Asynchronous batch models are excluded from interactive product selection.

Credential validation checks the selected credential, including an account-only credential. Saving or rotating a key is separate from verifying it. A late response cannot validate a replacement key. Disabling every source does not fall back to account or platform keys. Classic workflows accept only their implemented providers and report incompatible routes explicitly.

Scheduled catalog/NVIDIA workflows authenticate to fixed backend maintenance operations with short-lived GitHub OIDC tokens restricted to the production branch, repository and exact workflow. Provider/database credentials remain in backend configuration. Discovery is separate from credential validation and model callability; NVIDIA's public model list proves neither. Missing probe credentials remain explicit unavailability. Job execution and deployed commit evidence belong in the release audit; code changes alone do not establish operational success.

## Verification

Focused tests cover source governance, account-only key validation, stale credential responses, catalog persistence and paging, exact image provenance, owner isolation, observed costs by resolution, comparison limits and account-switch clearing. Design guards retain or lower existing baselines. The QA gallery's `models` scene uses visibly marked synthetic fixtures, never production examples.

Production and frontend/server typechecks should pass before release. Browser checks cover 320 px and 390 px layouts, desktop filtering, three-way comparison controls, image inspection, missing/error states and theme tokens. A signed-in user's private output still requires an authenticated live smoke check; unit tests do not establish provider entitlements or paid generation success.
