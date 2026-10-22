# 29 — AI / Model Gateway

> Part III · Architecture · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [F-ENTERPRISE-FOUNDATIONS](../F-ENTERPRISE-FOUNDATIONS.md) (**F1** provider reliability — the
> owner's #1 pain · F0 observability · F8 secrets) ·
> [Master Plan](../00-MASTER-PLAN.md) (§3 reuse, §6 adapters, §11 abuse risk) ·
> [System Architecture](./22-system-architecture.md) (§22.2 model gateway box, §22.8 reuse map) ·
> [Autonomous Engine](./24-autonomous-engine.md) (ORIENT/ACT routing, metering, §24.3.3) ·
> [Data model](./26-data-model-schema.md) (`token_ledger_entries`, `generation_cost_events`,
> `venture_budgets`). Grounded in the audited code: `server/src/ai/gateway.ts`, `client.ts`,
> `autoRouter.ts`, `utils.ts`, `providers/openrouter.ts`, `providers/nvidia.ts`,
> `services/modelCatalog.ts`, `services/billingLedger.ts`.

## 29.1 What this section is, and the honesty frame

The **model gateway** is the single boundary between every part of the platform that needs an LLM
or an image model and the upstream providers that serve them. It is the subsystem the owner called
out by name: *"significant model connection & source issues."* The audit
([F-ENTERPRISE-FOUNDATIONS §"scorecard" #4](../F-ENTERPRISE-FOUNDATIONS.md)) graded it **🟡 partial
(fragile)** and named the gap precisely: *single platform key per provider, no pool/rotation, no
circuit breaker, model-only (not cross-provider) failover.* This section specifies (a) what is
**shipped today** — file-referenced and not oversold; (b) the exact **gaps** the audit found; and
(c) the **target design** (F1) that closes them, with pseudocode for the two functions that carry
the most weight: `selectKey()` and `callWithBreakerAndFailover()`.

Two framing rules, consistent with the rest of Part III:

1. **Shipped vs planned is marked on every claim.** `✅` = exists in this repo today (cited);
   `📋` = specced here, not built; `◐` = partly exists. The current gateway is small, clean, and
   genuinely good at what it does — the honesty is in naming what it *does not yet do*, not in
   pretending it is unfinished everywhere.
2. **The gateway is reused, not rewritten.** F1 is **additive and interface-compatible**: the
   `AIProvider` registry, the auto-router, the resilient catalog, and the BYOK path all stay. The
   pool, breaker, and cross-provider failover wrap the *existing* call path — they do not replace
   it. This is the same "evolution, not rewrite" discipline as §22.7.

---

## 29.2 Architecture — the provider registry & key resolution (✅ shipped)

The gateway is a thin **façade + provider registry** so that no route, tool, or pipeline imports a
vendor SDK directly. Adding a provider is a drop-in `AIProvider`; it touches no caller
(`server/src/ai/gateway.ts`).

```
                       callers (routes · tools · studio buildAgent · swarm · chat)
                                              │  getProvider() / resolveProviderContext()
                                              ▼
   ┌──────────────────────────────── AI GATEWAY (gateway.ts) ─────────────────────────────────┐
   │  PROVIDERS registry  { openrouter: openRouterProvider, nvidia: nvidiaProvider }   (✅)     │
   │  getProvider(id?)            → provider impl (default = AI_PROVIDER, fallback openrouter)  │
   │  resolveProviderContext(userKey?, providerId?) → { apiKey, byok }                  (✅)     │
   │  platformKeyFor(id)         → NVIDIA_API_KEY | OPENROUTER_API_KEY  (single key)    (◐ gap) │
   └───────────────┬───────────────────────────────────────────────────┬──────────────────────┘
                   ▼ AIProvider interface                               ▼
   ┌───────────────────────────────┐                  ┌───────────────────────────────┐
   │ openRouterProvider (✅)         │                  │ nvidiaProvider (✅)             │
   │  generateText / …Stream         │                  │  generateText (no stream yet)   │
   │  generateImage · listModels     │                  │  generateImage · listModels     │
   │  withRetry + model-only fallback│                  │  withRetry + model-only fallback│
   └───────────────┬───────────────┘                  └───────────────┬───────────────┘
        OpenAI-compatible /chat/completions, /models      OpenAI-compatible (NIM) endpoints
                   ▼                                                    ▼
            api.openrouter.ai                                integrate.api.nvidia.com
```

A third path exists for legacy comic generation: when `AI_PROVIDER='gemini'`, `client.ts` returns
the real Google `GoogleGenAI` SDK; when the key is an OpenRouter (`sk-or-`) or NVIDIA (`nvapi-`)
key, `client.ts` returns a **gateway-backed shim** that maps the Gemini `generateContent` shape
onto `getProvider().generateText`, so the analyze/world/panel/continuity pipeline runs through any
OpenAI-compatible provider unchanged (`client.ts:55`, `createGatewayTextClient`). The shim already
surfaces the provider's real usage (`costUsd`, token counts) so metering bills on exact cost, not
estimate (`client.ts:99`).

### 29.2.1 BYOK vs platform-key resolution (✅ shipped)

Key resolution is one function, and it is the security-relevant fork in the whole gateway
(`gateway.ts:47`):

```ts
resolveProviderContext(userKey?, providerId?) -> { apiKey, byok }
  trimmed = (userKey ?? '').trim()
  if (trimmed)  return { apiKey: trimmed,                 byok: true  }  // BYOK wins, bypasses billing
  else          return { apiKey: platformKeyFor(id),      byok: false }  // platform key funds + meters
```

| Mode | Key source | Billing | Metering tag |
|---|---|---|---|
| **BYOK** (✅) | user-supplied `sk-or-…` / `nvapi-…` (trimmed, non-empty) | none — bypasses credit wallet | `is_byok=true`, `BYOK_TRACKED` / `BYOK_SETTLED` (`billingLedger.ts`) |
| **Platform key** (◐) | `OPENROUTER_API_KEY` / `NVIDIA_API_KEY` (single env var) | metered to the user's credit wallet | `RESERVE`→`SETTLE` ledger + `generation_cost_events` |

The `byok` flag rides on `ProviderContext` all the way to the provider implementation and back to
the ledger, which is why a BYOK call never touches the wallet (`billingLedger.ts:839`,
`reserveUsageTokens` BYOK branch). **This BYOK custody model is good and is preserved verbatim by
F1** — see §29.10. The single gap is on the *platform* side: `platformKeyFor()` returns exactly one
key per provider (`gateway.ts:21`). That one fact is the root of the audit's #4 finding.

---

## 29.3 Current state — what genuinely works (✅, honest)

The gateway is not a stub. Four things are shipped and should be **protected, not regressed** (the
audit's "strengths to preserve"):

**1. Exponential backoff retry (`utils.ts` `withRetry`).** Every provider call is wrapped in
`withRetry(op, retries=3, baseDelay=1500, label)`. It retries **only** on a narrow retriable set
and gives up immediately otherwise:

```ts
isRetryable = msg.includes('429') || msg.includes('503')
           || msg.toLowerCase().includes('quota')
           || msg.toLowerCase().includes('load failed')
delay = baseDelay * 2^attempt           // 1.5s → 3s → 6s ; throws on last attempt
```

This is honest exponential backoff — but note two real limitations the target fixes: it has **no
jitter** (synchronized clients retry in lockstep), and it retries *the same key against the same
upstream*, so a sustained 429 on the single platform key burns the full `1.5+3+6 = 10.5s` ladder
before failing (§29.4 gap).

**2. Model-only fallback (`openrouter.ts:332`, `nvidia.ts:150`).** If the chosen model 404s ("no
endpoints"), 429s, or rate-limits, `generateText` retries **once** on `req.fallbackModel` (a
reliable model on the *same* provider) — unless `freeOnly` is set, where it deliberately surfaces
the error rather than silently charging a paid fallback (`openrouter.ts:344`). Streaming has the
same fallback (`openrouter.ts:454`). This makes a single flaky free model non-fatal, which is the
common case.

**3. Resilient model catalog (`services/modelCatalog.ts`).** `getCatalog()` is
stale-while-revalidate with a **durable Supabase mirror**: fresh memory → serve; stale memory →
serve + revalidate in background; cold start → hydrate from the persisted index + revalidate; total
failure → serve last snapshot flagged `degraded` (never throws). `persistHarvestedModels` mirrors
the live OpenRouter catalog into Postgres so cold starts are instant. This is the backbone of the
**auto-router** (§29.6), which only ever picks models the catalog says exist *right now* — the fix
for the old "404 No endpoints found" class of failure (`autoRouter.ts:1`).

**4. Structured-output + tool-call plumbing (`openrouter.ts`).** The provider already extracts
`tool_calls`, reasoning traces, web-search citations, and generated images; runs a **one-shot JSON
repair round-trip** when `jsonMode`/`jsonSchema` output doesn't parse (`openrouter.ts:301`); and
honors `response_format: json_schema` for strict structured output. NVIDIA requests a plain
`json_object` and leans on the same coerce/repair pass since NIM `json_schema` support varies
(`nvidia.ts:112`). The streaming path accumulates deltas for content, reasoning, **and** tool-call
arguments across chunks (`openrouter.ts:394`).

> **Net:** the *single-call* reliability story is solid (backoff, model fallback, catalog
> resilience, JSON repair). What's missing is everything that makes the **platform-key path**
> survive a bad key or a provider outage at fleet scale.

---

## 29.4 The gaps (from the audit — F1)

Stated plainly, with the file evidence, so the target design has a concrete target:

| # | Gap | Evidence (today) | Consequence |
|---|---|---|---|
| G1 | **Single platform key per provider** | `platformKeyFor()` returns one of two env vars (`gateway.ts:21`); config exposes only `OPENROUTER_API_KEY` / `NVIDIA_API_KEY` (`config.ts:153,177`) | One rate-limited key throttles **all** non-BYOK users at once. |
| G2 | **No key pool / rotation / per-key cooldown** | no `OPENROUTER_API_KEYS`; no per-key accounting anywhere | Can't spread load; a 429'd key keeps getting picked. |
| G3 | **No circuit breaker** | grep for "breaker" hits comments only; `withRetry` always attempts the full ladder | A known-down upstream still eats `3×backoff` (≈10.5s) on every call. |
| G4 | **Model-only failover, not cross-provider** | fallback swaps `model` on the *same* provider (`openrouter.ts:344`) | An OpenRouter outage can't fail over to NVIDIA; the whole flow stalls. |
| G5 | **Weak image-gen retry / hard throw** | image path retries only `2×`, then hard-throws "no image" (`openrouter.ts:480,489`); NVIDIA image `retries=1` (`nvidia.ts:176`) | Image generation degrades to a 500 instead of trying an alternative. |
| G6 | **No per-provider error/latency/429 metrics** | `withRetry` only `console.warn`s; no counter feeds `alerting-thresholds.md` (F0) | Provider failures are invisible; the documented alerts have no signal. |
| G7 | **No timeout budget / hedging** | per-call `AbortController` timeout exists, but no stage budget or hedged second attempt | The slowest upstream sets the latency floor with no escape hatch. |
| G8 | **No provider contract tests** | the code itself admits it "cannot be runtime-verified in the build sandbox" (`openrouter.ts:8`, `nvidia.ts:13`) | A silent upstream response-shape change breaks parsing in prod undetected. |

These map 1:1 onto the F1 task list. The rest of this section is the design that satisfies them.

---

## 29.5 Target design (F1) — reliability layer

F1 inserts a **reliability layer** *inside* the gateway, between `getProvider()` and the provider
implementations, so callers are unchanged. It is the same "wrap, don't replace" pattern as the
Tick wrapping the build loop (§24.4.3).

```
   caller → gateway.generate*( req, ctx )
              │
              ▼
   ┌──────────────────────── RELIABILITY LAYER (📋 F1) ────────────────────────┐
   │  1. resolveProviderContext(userKey)                                        │
   │       BYOK?  → use user key directly (skip pool, skip metering)            │
   │       else   → selectKey(provider)         ← key pool + 429 cooldown (§29.7.1)
   │  2. callWithBreakerAndFailover(provider, model, ctx)   (§29.7.2)           │
   │       per-(provider,model) circuit breaker  → fail fast while OPEN         │
   │       per-call timeout budget               → abort + (optional) hedge     │
   │       on retriable failure: model fallback → CROSS-PROVIDER failover       │
   │  3. record metrics: latency, outcome, 429, provider, model  → F0           │
   │  4. on platform call: meter cost (tokens→USD) → ledger + venture budget    │
   └────────────────────────────┬──────────────────────────────────────────────┘
                                 ▼
                    existing AIProvider.generateText/Image/Stream  (✅ unchanged)
```

The two new state stores the layer needs are tiny and **shared** (Redis in the transition
realization, a Durable Object or `state.storage` in the Cloudflare realization — same interface, per
§22.7), because per-process state would be useless the moment we run >1 instance (the exact F2
lesson):

- **Key health map**: `{ provider → [ { keyId, inFlight, cooldownUntil, recent429 } ] }`.
- **Breaker map**: `{ (provider,model) → { state, failures, openedAt, halfOpenInFlight } }`.

---

## 29.6 Model routing — build vs chat (✅ today, extended by F1)

Routing — *which model* — is already shipped in `autoRouter.ts` and is independent of the
reliability layer (*which key / which provider survives*). Both compose: the router picks a model id;
the reliability layer makes the call to it actually land.

| Surface | Picker | Cost preference | Ranking |
|---|---|---|---|
| **Chat / general text** | `pickTextModel` (✅) | free-first (or `cheap`/`quality`/`free-only`) | `FREE_TEXT_PRIORITY` (strong open generalists) |
| **Code Studio build / FIX** | `pickCodingModel` (✅) | free-first; `quality` for BYOK/credit | `CODING_MODEL_PRIORITY` → `STRONG_CODING_PRIORITY` under `quality` |
| **Autopilot ORIENT** | `pickTextModel` (cheap) (✅, §24.5) | cheap — it runs every Tick | `FREE_TEXT_PRIORITY` |
| **Autopilot ACT (build)** | `pickCodingModel` (✅) | free-first → strongest coder via BYOK | coding priorities |
| **Images** | `pickImageModel` (✅) | free-first; NVIDIA free-tier preferred under `free-only` | cheapest-by-image |

The coding preference is the load-bearing routing decision for Autopilot: `pickCodingModel`
prefers strong coder families (`prefersCodingModel`) and, in `quality` mode, ranks **frontier
coders first** so a BYOK/credit user's autonomous build gets the most capable available coder, not
just the best *free* one (`autoRouter.ts:192`). All pickers degrade gracefully to `TEXT_FALLBACK` /
`IMAGE_FALLBACK` if the catalog is unreachable (`autoRouter.ts:126,152`), and **never** return a
paid id under `free-only` (they throw `NoFreeModelAvailableError` instead — the
"block, don't silently charge" rule).

**F1's only routing change** is to make the *provider* dimension explicit: today the router returns
a bare model id and the call goes to the default provider. The cross-provider failover path (§29.7.2)
needs a small **equivalence map** — "if `glm-4.6` on OpenRouter is down, the nearest NVIDIA-hosted
equivalent is X" — so failover preserves capability, not just availability. This is a lookup table
keyed off the annotated catalog, not new model logic.

---

## 29.7 Pseudocode — the two functions that carry F1

### 29.7.1 `selectKey()` — pool, rotation & per-key 429 cooldown (📋 F1)

`selectKey` replaces `platformKeyFor()` for the platform path. It reads N keys
(`OPENROUTER_API_KEYS`, `NVIDIA_API_KEYS`, comma-separated; falls back to the single legacy var so
existing deploys keep working), and picks the **least-loaded key that is not in 429 cooldown**.
BYOK never enters here.

```ts
// server/src/ai/keyPool.ts  (📋 F1) — shared state in Redis / DO storage
type KeyHealth = { keyId: string; key: string; inFlight: number; cooldownUntil: number; recent429: number };

function loadKeys(provider): KeyHealth[] {
  const raw = env[`${provider.toUpperCase()}_API_KEYS`] || env[`${provider.toUpperCase()}_API_KEY`] || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean)
            .map(key => ({ keyId: hash8(key), key, inFlight: 0, cooldownUntil: 0, recent429: 0 }));
}

async function selectKey(provider): Promise<KeyHealth> {
  const now = Date.now();
  const pool = await poolState(provider);                 // shared, atomic read
  const live = pool.filter(k => k.cooldownUntil <= now);  // skip keys cooling down from a 429
  if (live.length === 0) {
    // every key is cooling down → pick the one that frees soonest (fail slower, not harder)
    return pool.reduce((a, b) => a.cooldownUntil <= b.cooldownUntil ? a : b);
  }
  // least-loaded (round-robin emerges when inFlight ties); tie-break on fewest recent 429s
  live.sort((a, b) => a.inFlight - b.inFlight || a.recent429 - b.recent429);
  const chosen = live[0];
  await bump(provider, chosen.keyId, { inFlight: +1 });   // atomic increment; decremented in finally
  return chosen;
}

// called by the reliability layer when a call returns / throws
async function onKeyResult(provider, keyId, outcome) {
  await bump(provider, keyId, { inFlight: -1 });
  if (outcome.status === 429 || /rate.?limit|quota/i.test(outcome.message || '')) {
    const backoff = outcome.retryAfterMs ?? 30_000;       // honor Retry-After if present
    await setCooldown(provider, keyId, Date.now() + backoff);
    await bump(provider, keyId, { recent429: +1 });        // decays on a timer
    metrics.inc('provider_429_total', { provider, keyId });
  }
}
```

**Acceptance (F1):** *"killing one key doesn't throttle the platform."* With a 2-key pool, taking
one key offline (force it into permanent cooldown) routes all platform traffic to the survivor with
no caller-visible change — directly testable.

### 29.7.2 `callWithBreakerAndFailover()` — breaker + cross-provider failover (📋 F1)

This wraps the existing `AIProvider.generateText/Image/Stream`. It adds a circuit breaker per
`(provider,model)`, a per-call timeout budget, model-on-same-provider fallback (generalizing
`openrouter.ts:332`), and finally **cross-provider failover** (OpenRouter ↔ NVIDIA).

```ts
// server/src/ai/reliableCall.ts  (📋 F1)
const ORDER = ['openrouter', 'nvidia'];                    // failover order; configurable

async function callWithBreakerAndFailover(req, opts): Promise<Result> {
  const chain = providerFailoverChain(req.provider, req.model);  // [{provider,model}, {altProvider,equivModel}]
  let lastErr;
  for (const hop of chain) {
    const brk = await breaker(hop.provider, hop.model);

    if (brk.state === 'open' && Date.now() < brk.openedAt + OPEN_MS) {
      metrics.inc('provider_breaker_short_circuit', hop);  // fail fast — no 10.5s ladder on a dead upstream
      continue;                                            // skip straight to the next hop
    }
    const probing = brk.state === 'open';                  // OPEN cooldown elapsed → HALF-OPEN probe
    if (probing && !(await tryAcquireHalfOpen(hop))) continue;  // only one probe at a time

    const key = req.byok ? req.byokKey : await selectKey(hop.provider);
    const t0 = nowMs();
    try {
      const res = await withTimeout(
        getProvider(hop.provider).generate(req.kind, { ...req, model: hop.model }, ctxFor(key)),
        opts.budgetMs ?? defaultBudget(req.kind),          // §29.8 timeout budget
        `${hop.provider}:${hop.model}`
      );
      await onSuccess(hop, key, nowMs() - t0);             // breaker→closed; metrics: latency, ok
      return res;
    } catch (err) {
      lastErr = err;
      const status = parseStatus(err);                     // 404/429/503/timeout/shape
      await onFailure(hop, key, status, nowMs() - t0);     // breaker++ ; selectKey 429 cooldown ; metrics
      const retriable = /\b(404|429|503)\b|no endpoints|rate.?limit|timed out/i.test(err.message);
      if (!retriable) throw err;                           // a 400/auth error is not failover-worthy
      if (req.freeOnly && hop.isPaidFallback) continue;    // never silently fall to a paid model (autoRouter rule)
      // else fall through to the next hop (same-provider model, then cross-provider)
    }
  }
  throw lastErr ?? new Error('all providers exhausted');
}

// breaker transitions (per provider,model) — closed → open → half-open → closed
function onFailure(hop, key, status, ms) {
  brk.failures++; metrics.observe('provider_latency_ms', ms, hop); metrics.inc('provider_error_total', hop);
  if (brk.failures >= FAIL_THRESHOLD) { brk.state = 'open'; brk.openedAt = Date.now(); }
  if (status === 429) onKeyResult(hop.provider, key.keyId, { status, retryAfterMs: parseRetryAfter });
}
function onSuccess(hop, key, ms) {
  brk.failures = 0; brk.state = 'closed'; releaseHalfOpen(hop);
  metrics.observe('provider_latency_ms', ms, hop); metrics.inc('provider_ok_total', hop);
  onKeyResult(hop.provider, key.keyId, { status: 200 });
}
```

**Acceptance (F1):** *"simulating an OpenRouter outage auto-fails over to NVIDIA; the breaker opens
under sustained failure (tested)."* Both are unit-testable with a fake provider that throws on
command — no live network needed (which is also why the contract tests in §29.9 use recorded
fixtures).

---

## 29.8 Timeout budgets, hedging & image hardening (📋 F1)

**Timeout budgets (G7).** Today each provider call has a flat `AbortController` timeout
(`OPENROUTER_REQUEST_TIMEOUT_MS` / `NVIDIA_REQUEST_TIMEOUT_MS`). F1 makes the budget **per call
kind** and threads it through `withTimeout` (already present in `utils.ts:3`):

| Call kind | Default budget | Hedge after | Notes |
|---|---|---|---|
| chat (interactive) | 30s | 8s (one hedged attempt to the failover hop) | hedging only when a cross-provider equivalent exists |
| ORIENT (cheap, per-Tick) | 15s | none | cheap + frequent; hedge cost not worth it |
| ACT build / FIX | 120s | none | long by nature; breaker, not hedge, protects it |
| image | 60s | none (use failover, not hedge) | images are expensive to duplicate |

**Hedging** is optional and conservative: only the slowest *interactive* stage, only one hedged
attempt, and the first response wins (the loser is aborted). It is off by default and behind a flag,
because a careless hedge doubles provider load — exactly the bill we are protecting (§22 abuse risk).

**Image-gen hardening (G5).** The current image path retries `2×` then hard-throws "no image"
(`openrouter.ts:489`). F1 routes image generation through the same
`callWithBreakerAndFailover` so it gets retry parity and **graceful degradation**: on exhaustion it
returns a typed `{ ok:false, reason:'image_unavailable', triedProviders:[...] }` the route can turn
into a soft, explainable failure (mirroring the search chain's honest `ok/empty/error` status, the
audit's #4 strength) — instead of a 500. NVIDIA's free-tier image models stay the preferred
free-only image path (`autoRouter.ts:208`).

---

## 29.9 Provider metrics & contract tests (📋 F1, feeds F0)

**Per-provider metrics (G6).** Every call through the reliability layer emits to the F0 exporter
(`prom-client`, `/metrics`) the exact signals `docs/production/alerting-thresholds.md` lists but
nothing yet produces:

```
  provider_ok_total{provider,model}            provider_error_total{provider,model}
  provider_429_total{provider,keyId}           provider_breaker_state{provider,model}   (0/1/2)
  provider_latency_ms (histogram → p50/p95/p99){provider,model}
  provider_failover_total{from,to}             keypool_cooldown_keys{provider}
```

These are tagged with `requestId` trace context (F0) so a slow build's provider hop is traceable
end to end. The Operator Console surfaces provider error rate + breaker state on the system
dashboard (extends `services/systemDashboard.ts`).

**Contract tests (G8).** The provider modules openly state they "cannot be runtime-verified in the
build sandbox" (`openrouter.ts:8`). F1 closes this with **recorded-fixture contract tests**: capture
real `/chat/completions`, `/models`, and image responses once (scrubbed of keys via `guardrails.ts`
redaction), then assert the parsers (`extractText`, `extractToolCalls`, `extractImages`,
`normalizeCatalogModel`, `parseUsage`) still produce the expected shapes. A nightly
`openrouter:smoketest` in CI hits the live API with a real key to catch upstream drift the fixtures
can't. **Acceptance (F1):** a provider response-shape change fails CI (§F5).

---

## 29.10 Streaming, tool-calling & the JSON-tool fallback

**Streaming (◐).** OpenRouter streaming is shipped: `generateTextStream` parses the SSE event
stream, accumulates content/reasoning/tool-call deltas, and applies the same model-fallback on a
retriable failure (`openrouter.ts:444`). NVIDIA has **no** stream method yet (`nvidiaProvider`
exposes only `generateText`/`generateImage`/`listModels`, `nvidia.ts:227`) — so cross-provider
*streaming* failover degrades to a non-streamed NVIDIA call. F1 notes this honestly: streaming
failover is best-effort; the breaker/pool benefits apply to both, but a streamed call that fails
over to NVIDIA arrives as one chunk, not a stream, until NVIDIA streaming lands (📋).

**Tool-calling + the JSON-tool fallback.** Tool support is shipped end to end: the request carries
`tools[]`, the gateway sets `tool_choice:'auto'` (`openrouter.ts:271`), and the response
`tool_calls` are extracted in both buffered and streamed paths. The **fallback for non-tool models**
is the structured-JSON path that already exists: when a routed model lacks native function calling
(its catalog `supportsJsonOutput`/`supported_parameters` shows no `tools`), the caller asks for the
tool decision as **JSON** (`jsonMode`/`jsonSchema`) and the provider's one-shot **JSON repair
round-trip** (`openrouter.ts:301`, `nvidia.ts:127`) salvages malformed output before it reaches the
caller. This is the same `coerceJsonOrNull` → repair → `coerceJson` ladder the swarm planner and
ORIENT rely on (§24.5.2) — so "this model can't call tools" degrades to "this model emits a tool
intent as JSON," never to a hard failure. F1 formalizes the model→capability check so routing
*prefers* tool-native models for tool-heavy work and only falls back to JSON-tool emulation when it
must.

---

## 29.11 Cost accounting per call (✅ shipped; 📋 venture tagging)

Metering is **woven through the call path, not bolted on** — it is a security control, the same
stance as the Tick's budget brake (§24.3.3). The shipped flow (`services/billingLedger.ts`):

```
  reserveUsageTokens(estimate, provider, model, operation, projectId, byok?)   (✅)
        BYOK   → ledger BYOK_TRACKED (no wallet touch) + daily rollup
        else   → billing_try_reserve_tokens (atomic RPC) → ledger RESERVE + generation_cost_events(RESERVED)
                          │
                       (call runs through the gateway)
                          ▼
  settleReservation(actual, reservationId, …)                                  (✅)
        actualCt from provider usage (exact costUsd when present, client.ts:99)
        → billing_settle_tokens RPC → ledger SETTLE (ct_delta, usd_delta, provider, model)
        → generation_cost_events(SETTLED) → usage_daily_rollups → usage alert thresholds
```

Each ledger row already carries `provider`, `model`, `operation`, `reservation_id`, `is_byok`, and a
`metadata` blob; `generation_cost_events` additionally carries `stage` and powers the per-comic cost
report (`getComicCostReport`, by `stage` and by `model`). **This is exactly the substrate Autopilot
needs.**

**F1/A2 delta — `venture_id` tagging.** For Autopilot, every gateway call made on behalf of a Tick
must be tagged `venture_id` (and `goal_id`, `kind` ∈ {orient,act,verify,reflect}) so cost rolls into
`venture_budgets.spent_usd_today` / `spent_usd_total` in the **same transaction** as the REFLECT
event write — the invariant from §24.3.3 that "the audit trail and the brake can never disagree."
Concretely: add `ventureId?` / `goalId?` / `tickKind?` to the `reserveUsageTokens` /
`settleReservation` inputs (they already accept arbitrary `metadata` and a `projectId`, so this is a
typed promotion of existing fields, not a schema upheaval), and write the budget-counter update keyed
by `(run_id, tick_number, phase)` for the at-most-once-spend guarantee (§24.9). The per-call cost the
gateway returns (`usage.costUsd`, or token×price estimate when the upstream omits it) is the number
that lands on the `venture_event` and the budget counter alike.

---

## 29.12 BYOK key custody & security (✅ core; 📋 hardening)

The BYOK custody model is already correct in the ways that matter, and F1 + F8 harden the edges:

- **User keys are request-scoped, never persisted by the gateway (✅).** `resolveProviderContext`
  trims the user key into a transient `ProviderContext`; it is sent upstream as a `Bearer` header
  (`openrouter.ts:46`, `nvidia.ts:36`) and discarded. The gateway holds no key store.
- **Platform keys live only in host env (✅).** `OPENROUTER_API_KEY` / `NVIDIA_API_KEY` are read
  from `config.ts` (Railway/Cloudflare secrets), never shipped in the client bundle, never written
  to the DB — consistent with the platform/tenant secret split (§22.6).
- **BYO *provider* credentials for deploy adapters live in Nango (✅ wiring), referenced only by
  `venture_connections`** — plaintext never enters our DB (§22.6, Master Plan §5.3). Model BYOK keys
  for *generation* are the request-scoped case above; longer-lived stored BYOK (so a user need not
  paste their key each session) is a **📋 F8 item**: store encrypted-at-rest via Nango/KMS, reference
  only, and never log.
- **Keys are scrubbed from logs and errors (◐→📋).** Provider error messages truncate upstream
  bodies (`.slice(0,500)`), and F0 wires `guardrails.ts` redaction into the structured logger so a
  key can never land in Sentry or a log line. F8 adds secret-scanning in CI to catch a committed key.
- **Pool keys (📋 F1) are loaded from a comma-separated secret** (`OPENROUTER_API_KEYS`), identified
  in metrics/state by a non-reversible `hash8(key)` `keyId` — the raw key never appears in the health
  map, metrics, or logs.

---

## 29.13 Mapping to F0 / F1 and acceptance

| F-task (F1 unless noted) | This section | Status |
|---|---|---|
| API key pool + rotation + per-key 429 cooldown | §29.7.1 `selectKey()` | 📋 |
| Circuit breaker per (provider,model) + half-open probe | §29.7.2 `callWithBreakerAndFailover()` | 📋 |
| Cross-provider failover OpenRouter ↔ NVIDIA | §29.7.2 failover chain + §29.6 equivalence map | 📋 |
| Image-gen hardening (retry parity + graceful degrade) | §29.8 | 📋 |
| Provider contract tests (recorded fixtures + nightly smoketest) | §29.9 | 📋 (F5) |
| Per-provider error/latency/429 metrics | §29.9 | 📋 (feeds F0) |
| Timeout budgets + optional hedging | §29.8 | 📋 |
| BYOK custody / platform-key resolution | §29.2.1, §29.12 | ✅ (◐ hardening F8) |
| Model routing (build vs chat, coding preference) | §29.6 | ✅ |
| Streaming + tool-calling + JSON-tool fallback | §29.10 | ✅ (◐ NVIDIA stream) |
| Cost accounting per call → ledger, `venture_id` tag | §29.11 | ✅ (📋 venture tag, A2) |

**Section acceptance (aggregating F1):** killing one pooled key does not throttle the platform
(§29.7.1 test); a simulated OpenRouter outage auto-fails over to NVIDIA (§29.7.2 test); the breaker
opens under sustained failure and half-open-probes back to closed (§29.7.2 test); image generation
degrades gracefully instead of 500ing (§29.8); per-provider error rate + breaker state are charted
(§29.9); a provider response-shape change fails CI (§29.9); and every platform call's cost is
metered to the ledger, tagged `venture_id` for Autopilot Ticks, reconciling against
`venture_budgets` (§29.11).

> **Stance (restated):** the shipped gateway is small and good at single calls — backoff, model
> fallback, a resilient catalog, JSON repair, honest BYOK custody. F1 does not rewrite it; it
> **wraps** it with the fleet-scale survival the audit found missing — a key pool so one bad key
> can't throttle everyone, a breaker so a dead upstream fails fast, cross-provider failover so an
> outage routes around itself, and the metrics that make all of it visible (F0). Routing,
> custody, and metering — the parts that already work — are preserved verbatim. This is the
> precondition the autonomous engine (§24) is built to trust: an always-on builder cannot run on
> providers that fail silently.
