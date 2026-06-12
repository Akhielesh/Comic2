# Model bench — one trigger, every model, plain data

`npm run bench:models` live-tests **every model on your connected sources**
(OpenRouter + NVIDIA Build) in one manual run. No UI — it writes log/table data
under `bench-results/run-<stamp>/`:

| File | Contents |
|---|---|
| `results.jsonl` | One record per request — timestamps, TTFT, total latency, tokens, tok/s, actual billed cost, HTTP status, error class, served-model id, response preview. |
| `results.csv` | Same data, spreadsheet-ready. |
| `summary.md` | Per-model table, failures first, then slowest. |
| `meta.json` | Run config, healthy/tested counts, spend vs budget. |

The console prints the same table plus an **anomaly section** (timeouts, rate
limits, wrong answers, empty responses, served-model mismatches, anything slower
than `--slow-ms`) and a spend report. Exit code is non-zero when any tested model
hard-fails, so the run can gate CI.

## What each model gets

Three phases, sequential per model (a dead model costs one request, not three):

1. **echo** — "reply with exactly `BENCH-OK-<nonce>`". Proves the model is up,
   follows instructions, and gives the clean latency numbers (TTFT via streaming,
   total, output tokens/sec).
2. **context** — a vault code planted mid-way through ~6K tokens of filler
   (`--context-tokens`), then asked back. Proves real context ingestion, not just
   an advertised window. Skipped when the model's window is smaller than the probe.
3. **reasoning** — a deterministic arithmetic expression with one right answer.
   A *working-condition* check, *not* a capability ranking — one prompt can't
   rank intelligence, only catch models that are broken.

All requests use `temperature: 0`, a `--max-tokens` cap (default 120), and a
per-request `--timeout` (default 60s — anything that can't answer a one-liner in
60s is itself a finding).

## Budget safety

- `--budget` (default **$5**) is a hard cap enforced with reserve-then-settle
  accounting: a request's worst-case cost is committed before it launches, then
  corrected to the provider-billed actual (OpenRouter returns `usage.cost`).
- `--max-per-model` (default $0.25) skips any model whose single run would be
  disproportionate.
- Models run **cheapest-first**, so free models never get crowded out by pricey
  ones, and the budget cuts off only the expensive tail.
- `--dry-run` prints the plan + worst-case estimate without a single call.
- NVIDIA Build bills credits, not per-call USD, so its cost column is `—` and it
  doesn't consume the USD budget.

## Common runs

```bash
npm run bench:models -- --dry-run                      # plan + cost estimate only
npm run bench:models                                   # everything, all 3 phases
npm run bench:models -- --source openrouter --free-only
npm run bench:models -- --match claude --budget 2      # one family, tight cap
npm run bench:models -- --phases echo --concurrency 10 # fast availability sweep
npm run bench:models -- --models openrouter:anthropic/claude-fable-5
```

Keys come from the environment or `.env`. OpenRouter prefers the dedicated test key
`DREAMSTREAMSTUDIO_MODELTEST` (falling back to `OPENROUTER_API_KEY`), so bench spend
never lands on the user-serving `DREAMSTREAMSTUDIO_ALL` key. NVIDIA: `NVIDIA_API_KEY`.

## Is $10 enough? (the honest math)

Yes — comfortably. A full three-phase probe is ~6.2K prompt + ~360 completion
tokens per model. At Claude-Fable-class pricing ($10/M in, $50/M out) that's
**~$0.08 for the most expensive model in the catalog**; the median paid model is
under a cent, and `:free` variants cost nothing. A full ~300-model OpenRouter
sweep lands around **$1.50–$3 per run**, so $10 buys 3–6 complete sweeps — enough
to re-run after fixes and compare. The script's real constraints are not money:

- **Rate limits** — free-tier models 429 aggressively; that's why retries with
  backoff exist and why `rate_limited` is reported as its own class instead of
  pretending the model is down.
- **Time** — ~300 models × up to 3 phases at concurrency 6 is roughly 15–30
  minutes; raise `--concurrency` for sweeps, lower it if you see 429 storms.
- **Interpretation** — pass/fail here means "working condition", and latency
  is a point sample per run. Trends need repeated runs (the JSONL is
  append-friendly for exactly that).

## Related tooling

- `npm run validate:sources` — quick per-source round-trip check.
- `npm run openrouter:smoketest` — single-model smoke test.
- `services/modelSpeed.ts` — in-app measured latency badges in the chat picker,
  fed by real chat telemetry (the complement to this synthetic bench).
