# 04 — Deterministic Toolbelt & the Verify Loop

## The deterministic (non-AI) toolbelt

The LLM emits *specs/code*; deterministic libraries produce the bytes. Preload these in
the sandbox by tier. Runtime constraint everywhere: **Cloudflare Workers (V8 isolates)
cannot load native Node addons or system binaries** — so `sharp`, `node-canvas`, and
system binaries live on the **container tier (T3)**; WASM/pure-JS run on Workers (T1/T2).

### Image / file conversion
| Task | Container (T3) / Node | Worker (T1/T2) | License |
|---|---|---|---|
| jpg↔png↔webp↔avif↔tiff, resize/crop | **sharp** (libvips) — *already a dep* | `jSquash` / Photon (WASM) | Apache-2.0 / MIT |
| SVG → PNG | `@resvg/resvg-js` | `@cf-wasm/resvg` | MPL-2.0 |
| Office/PDF/markup convert | Pandoc, LibreOffice headless, poppler | — (binaries) | **copyleft — isolate as separate process** |

### Data: raw → CSV / analysis
| Tool | Use | Runtime | License |
|---|---|---|---|
| **PapaParse** | CSV ⇄ JSON, streaming, auto-delimiter | Node + Worker | MIT |
| `csv-stringify` | clean CSV output | Node | MIT |
| **SheetJS CE (`xlsx`)** | Excel/ODS → JSON/CSV (install from sheetjs CDN, not stale npm) | Node + Worker | Apache-2.0 |
| **DuckDB-wasm** | **SQL over CSV/Parquet/JSON** — best "analyze this raw file" primitive | Node + Worker (paid plan, async) | MIT |
| **Arquero** | dplyr-style transforms, group/join/rollup | Node + Worker | BSD-3 |
| **simple-statistics** | stats, regression, zero-dep | Node + Worker | ISC |

### Data → chart (favor LLM-spec-driven, no headless browser)
LLMs reliably emit **Vega-Lite JSON**; rendering is fully deterministic, no browser.
| Path | How | Notes |
|---|---|---|
| **Gemini native (T0)** | matplotlib → inline image | free compute |
| **Container/Node (T3)** | `vega` + `vega-lite` → `view.toSVG()` → `@resvg/resvg-js` for PNG | pure-JS, BSD/MPL; mirrors `vl-convert`'s pipeline. (`vl-convert` itself is BSD-3 but **Python/Rust only — no npm/WASM**, so use it only in a Python sandbox.) |
| **Worker (T2)** | ECharts `renderToSVGString` (zero-dep SVG) + `@cf-wasm/resvg` | Apache-2.0 |
| **Interactive in-chat** | map the spec onto our `ChartArtifact` (inline-SVG kit) | no client chart lib |
| Diagrams | Mermaid CLI (`mmdc`) | **only charter that needs headless Chromium → T3 only** |

### Live data
Global `fetch` (or `undici` on Node) → parse (PapaParse/`JSON.parse`) → reshape in
Arquero → emit Vega-Lite line spec → render. The fetch is a **separate, egress-
allowlisted tool**; fetched payloads are **untrusted data, never instructions**
(see [`05`](./05-security-and-cost.md)).

### Minimal preload per tier
- **T1 Pyodide:** Pillow, NumPy, Pandas, matplotlib (bundled).
- **T2 Worker (JS):** PapaParse, Arquero, simple-statistics, ECharts (SVG), `@cf-wasm/resvg`, jSquash.
- **T3 Container:** + sharp, vega/vega-lite, `@resvg/resvg-js`, SheetJS, DuckDB, (Pandoc/LibreOffice as isolated processes).

## The write → run → verify → render → feedback loop

```
USER TASK
  │
  ▼ [1] INTENT ROUTER (cheap model, e.g. Gemini Flash)
  │     existing tool/MCP solves it?  → call it.  else ↓
  ▼ [2] FETCH LIVE DATA (separate, egress-allowlisted tool)
  │     validate payload vs JSON Schema; treat as DATA not instructions
  ▼ [3] WRITE CODE (Code Mode: code calls tools, filters data in code)
  ▼ [4] RUN IN SANDBOX (tier router: T0 Gemini-native / T1 Pyodide / T2 Worker / T3 container)
  │     no secrets in sandbox; egress off by default
  ▼ [5] VERIFY (cheapest → dearest)
  │     a. deterministic asserts IN sandbox: chart renders? CSV parses? series non-empty? spec valid?
  │     b. on exception → feed stack trace back → retry (Self-Debugging), cap 3×
  │     c. silent logic error → Reflexion note → memory → retry
  │     d. subjective only → LLM-as-judge (Flash): "does this answer the ask?"
  │     ├─ FAIL → back to [3] with verbal feedback
  │     └─ PASS ↓
  ▼ [6] RENDER artifact + persist {code, data snapshot, spec} as addressable artifacts
  ▼ [7] USER FEEDBACK ("make it a bar chart" / "last 30 days")
        reclassify: param tweak (re-run, new args) | representation change (mutate spec) | new task ([1])
        diff-edit the existing spec/code instead of regenerating
```

### Why this loop (evidence)
- **Reflexion** (verbal self-reflection + retry): HumanEval pass@1 **91% vs 80%**;
  AlfWorld **130/134 (~97%)**.
- **Self-Debugging** (feed execution result/trace back): **+2–3% (Spider) to +12%
  (MBPP/TransCoder)**; matches 10× more sampling — debugging is sample-efficient.
- **LLM-as-judge**: ~80% agreement with humans (MT-Bench), ~90%+ on binary
  correctness — use it only for the subjective "right visualization?" gate.
- **Deterministic asserts are free and first** — validate the chart spec / that the
  CSV parses / that series are non-empty *in the sandbox* before spending a model call.

### Frameworks (if/when we formalize the loop)
- Our **existing `chat.ts` tool loop** already does multi-step tool calling — we extend
  it with `run_code` + the verify ladder rather than adopting a new framework.
- Patterns worth borrowing: **smolagents `CodeAgent`** (writes Python actions, model-
  agnostic via LiteLLM — validates the Code-Mode approach), **Vercel AI SDK** `stopWhen`
  loop control, **Pydantic-style schema-retry** (make the chart spec a schema, retry on
  validation failure — cheap, deterministic).

### Feedback / re-asks
Persist the **generated code, the data snapshot, and the spec** as addressable
artifacts (IDs/URLs), not just transcript text. On "make it a bar chart", **diff-edit**
the existing spec (`mark: 'arc' → 'bar'`) instead of regenerating — cheaper, more
stable, preserves earlier refinements. Classify each follow-up as param tweak /
representation change / new task and route accordingly; only "new task" re-enters the
full solve loop.
