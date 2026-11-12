# Comic library: admin spend, caps and provenance

The comic library is the platform's own set of style, cast and swatch images (Admin › Library), built by admins and
shown to every user for free. The manifest is `server/src/comic/library/manifest.ts` (98 core images); the runner is
`server/src/comic/library/runner.ts`; the shared types are `shared/comic/library.ts`. The style catalogue it draws
from is in `docs/features/comic-studio-v4.md` (the Style panel). The env vars are in
`docs/infrastructure/ENV_MATRIX.md` ("Comic Studio: library and admin image spend").

## Admin spend: key, caps, provenance (Program 3 ST-A)

- Library builds and Model Lab spend only on DREAMSTREAMSTUDIO_MODELTEST (OpenRouter, never the platform Gemini key).
  If it is unset, nothing can be built. COMIC_ADMIN_SPEND_KEY=platform is the escape hatch
  (`server/src/comic/library/adminSpend.ts`; the key is referred to by name only, and its value is never logged,
  returned or stored).
- Each Build/Regenerate click first checks COMIC_LIBRARY_MONTHLY_CAP_USD ($20), then makes one GET /api/v1/key. It
  refuses below the run budget, warns on an unlimited key, and refuses if the check can't be read. Nothing is checked
  on page load or on a timer (`library/keyBudget.ts`).
- A build is pinned to the key it was checked on; flipping COMIC_ADMIN_SPEND_KEY mid-run stops its next step (cancel
  and start again).
- Regenerate budgets just that one image (at least $0.50).
- Every attempt is a comic_image_calls row (admin user_id, kind 'library'). Lab rows are 'lab_*'. Both are excluded
  from users' model stats.
- Breaker refusals and free cancels are 'blocked' ledger rows, not failed provider calls.
- Published images carry provenance and an LQIP. The public index never carries cost, run id, admin id or a key.

Refusals are `409 BUDGET_EXCEEDED` (the monthly cap or the key's limit) and `503 NOT_AVAILABLE` (the key check could
not be made or read, or storage is not configured); a start result may carry a `warning` (an unlimited key), which
the console shows. The LQIP is a blurred WebP data URL of at most 20 px and 1,200 characters (`LIBRARY_LQIP_MAX`),
painted while the image loads (`components/comicstudio/library/LibraryImage.tsx`).

## S2a lead decisions

- Model Lab calls are recorded as `lab_<kind>` (`lab_page`, `lab_sheet`) instead of `page` / `sheet`. The model-stats
  RPC groups by kind, so this is the only way to keep lab rows out of the platform aggregate without SQL. Side effect:
  the lab's own observed prices no longer learn from lab calls; they fall back to live or registry prices.
- The public index publishes the exact platform-authored final prompt and its hash inside `provenance` (PROGRAM3 §5),
  with the model facts, the route, which key paid (the key's name, `modeltest` or `platform`, never a value), the
  seed facts, the check score and model, the attempts, the strategy and the time. Never a cost: admins compute it
  client-side with `libraryAssetCostUsd`.
- The three Model Lab test assertions ST-A changed (`server/src/comic/models/lab.test.ts`, `lab.proPages.test.ts`:
  the `lab_page` kind and the key-missing copy) are confirmed.
- `spend` and `calls` stay optional on `LibraryDeps` as built; the testkit wires both, so tests exercise the guard.

## Deferred

- The provenance details sheet (seed "Not supported by this model"; cost for admins and ungoverned users, "Made by
  DreamStream: free for you" for governed users): ST-5 (S3).
- Q-EVAL reuses `adminSpendKeys` and the key budget check; its $15/month cap is EVAL_BUDGET_USD, not library_runs.
- Q-PRO4K: Model Lab D1 now runs on the model-test key, so it must be set before the owner clicks.
- Making `spend` / `calls` required in `runner.ts` once every caller passes them.
- Assets published before provenance existed carry none until rebuilt (production had 0 library rows at S2a).
