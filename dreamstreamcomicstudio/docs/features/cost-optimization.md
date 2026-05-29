# Cost & Efficiency Optimization

Goal: lower token/API cost per comic without losing accuracy, using data we capture.

## What we capture (telemetry)

Every generation reserves + settles through the billing layer, writing a row to
`generation_cost_events` (and `token_ledger_entries`) with:
`operation, stage, provider, model, estimated_ct, actual_ct, billable_usd,
provider_cost_usd, is_byok, status, project/comic id`. For OpenRouter we record the
provider's **real** `usage.cost` (not a token estimate). See
`server/src/services/billingLedger.ts`.

## Analysis surface

`getComicCostReport(userId, comicId)` aggregates those events into
`{ totalActualCt, totalBillableUsd, totalProviderCostUsd, byStage, byModel, events }`.
The **Review/Export** screen now shows a **per-stage and per-model cost breakdown**
(sorted by cost) so the priciest stages/models are obvious — that's the optimization
analysis input.

## Optimization levers (ranked by expected impact)

1. **Batch panel generation** — generate multiple panels per image call (e.g. a 2×2
   grid) instead of one call per panel. Comics are mostly images, so this is the
   biggest lever (~up to 75% fewer image calls on dense pages).
2. **Trim per-stage context** — pass only the continuity each stage needs (relevant
   characters/world for the current scene) instead of the whole bible → fewer input
   tokens on script/world/panel/continuity calls.
3. **Right-size models per stage** — free/cheap text models for planning
   (script→scenes→panels→dialogue), premium image models only for final art / covers.
   The model selection + capability index already make this selectable.
4. **Cache & dedupe** — reuse identical sub-results (idempotency already exists for
   images); add prompt caching where the provider supports it.
5. **Avoid redundant re-analysis** — only re-run a stage when its inputs changed.

## Status

- ✅ Telemetry capture (per stage/model/provider, real OpenRouter cost).
- ✅ Analysis surface (per-comic byStage/byModel breakdown in Review/Export).
- ⏳ Flow changes (batching, context trimming) — these touch the generation pipeline
  and must be validated against output quality before shipping, so they are a
  **separate, tested increment**, not a rushed change to a production path.

When implementing the flow changes, measure before/after with the byStage/byModel
breakdown to confirm the cost drop and watch the continuity/accuracy tests.
