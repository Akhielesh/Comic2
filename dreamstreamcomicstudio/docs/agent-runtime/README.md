# Agent Runtime — Generative UI + Sandboxed Code Execution

> **Goal.** Give the chat agents the ability to (a) **render rich, custom-built UI
> in-chat** (charts, tables, file previews, bespoke layouts/alignments) and (b)
> **write & run their own code in a cloud sandbox** to solve tasks no existing tool
> covers — convert `jpg→png`, turn a table into a pie chart, reshape a raw file into
> CSV, plot a trend from live data — then **verify** the result, **render** it, and
> **iterate** on user feedback. Enterprise-grade, cost-optimized, mostly deterministic
> (non-AI) under the hood.

This folder is the design system of record. It is the synthesis of a multi-source,
fact-checked research pass (June 2026) **plus** a deep review of this codebase, so the
recommendations are grounded in what we already run.

## The headline findings (read these first)

1. **We already own most of the substrate.** The repo has a Cloudflare
   container sandbox (`studio-worker/` via `@cloudflare/sandbox`, HMAC-gated,
   per-user-scoped) *and* a whitelisted generative-UI pipeline (the chat **artifact**
   system: `{ type, data }` → `ARTIFACT_RENDERERS` → trusted React component, built on
   a dependency-free Primitive Kit). The work is **extension, not greenfield.**

2. **Gemini's API has a *native* Python code-execution sandbox** — matplotlib /
   pandas / numpy / scipy built in, returns charts as inline images, 30s runtime,
   5 self-correction retries, **compute is NOT billed (tokens only).** Since we call
   Gemini directly, "turn this table into a pie chart" can run at **zero compute
   cost** with no container spin-up. Our Cloudflare sandbox is the escape hatch for
   OpenRouter/NVIDIA-routed models and for jobs that exceed Gemini's limits.

3. **The recommended generative-UI architecture is the one we already use** — a
   *whitelisted structured spec* rendered by trusted components (the same pattern
   tambo / CopilotKit / assistant-ui / Vercel AI SDK converge on), with a
   *sandboxed-iframe* escape hatch for arbitrary generated UI. We extend the
   whitelist, we don't rip it out.

4. **The single biggest cost lever is "Code Mode"** — let the agent write code that
   calls tools and *filters data in code* before it re-enters the model context.
   Measured reductions: Anthropic 150k→2k tokens (98.7%), Cloudflare API 99.9%. We
   already execute code, so we route tool I/O through it.

## Document map

| # | File | What's in it |
|---|------|--------------|
| 01 | [`01-architecture-and-roadmap.md`](./01-architecture-and-roadmap.md) | Vision, gap analysis from the codebase review, the full target architecture, and the phased roadmap (with the 12 enterprise weaknesses to fix). |
| 02 | [`02-execution-sandbox.md`](./02-execution-sandbox.md) | The tiered execution model (Gemini native → Pyodide Worker → Dynamic Worker → CF Container), the full sandbox comparison, and why. |
| 03 | [`03-generative-ui.md`](./03-generative-ui.md) | The in-chat generative-UI design (**the first vertical slice**): the block spec, the recursive renderer, validation, animation, safety. |
| 04 | [`04-toolbelt-and-verification.md`](./04-toolbelt-and-verification.md) | The deterministic (non-AI) conversion/chart/data libraries the sandbox preloads, and the write→run→**verify**→render→feedback loop. |
| 05 | [`05-security-and-cost.md`](./05-security-and-cost.md) | Enterprise security (OWASP LLM/Agentic, sandbox isolation, SSRF, safe UI rendering) and cost/context optimization (caching, Code Mode, compaction, routing, observability). |
| 06 | [`06-sources.md`](./06-sources.md) | Every external citation behind these claims, grouped by topic. |
| 07 | [`07-agentic-quality-overhaul-and-evals.md`](./07-agentic-quality-overhaul-and-evals.md) | The staged, measured plan to make the chat **swarm** and **Code Studio** reliable: a golden-task eval scoreboard, closing the loop against reality, difficulty-aware model routing, real agent collaboration, and enterprise hardening — grounded in a six-part codebase review. |

## Status

- **Phase 0 (this PR):** documentation + the first generative-UI vertical slice
  (`generative_ui` artifact — agent-composed layouts from whitelisted blocks, with
  runtime validation + an artifact error boundary). See `03` and the roadmap.
- Subsequent phases wire the `run_code` tool to the tiered sandbox, the verification
  ladder, the deterministic toolbelt, and the security/cost hardening.

> Conventions for adding rich-output components live in the repo root `CLAUDE.md`
> (the artifact pipeline + the **mandatory** Gallery coverage rule). This folder does
> not supersede it — it builds on it.
