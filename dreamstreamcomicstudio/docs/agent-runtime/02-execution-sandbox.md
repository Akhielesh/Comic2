# 02 — Execution Sandbox (tiered)

Where the agent runs the code it writes. The decision was "compare all, you
recommend." The recommendation is a **tiered model**: always use the cheapest tier
that can do the job. ~95% of tasks never reach a paid container.

## The tiers

### T0 — Gemini native code execution *(when the turn is a direct Gemini call)*
The Gemini API ships a **built-in Python sandbox**. Verified properties:

- Libraries: pandas, numpy, scipy, scikit-learn, **matplotlib**, sympy, opencv,
  python-docx, openpyxl, PyPDF2 (40+). *Only matplotlib renders graphs.*
- Returns **matplotlib charts as inline images** in the response.
- **30s** max per execution; model can self-correct & re-run up to **5×** without
  re-prompting.
- Accepts input files (inlineData / Files API).
- **Compute is not billed** — you pay only normal input/output tokens.
- Supported on `gemini-3.5-flash` (GA May 2026) and the Pro tier.

**Implication:** for self-contained tasks within 30s using the bundled libs — "convert
this table to a pie chart", "compute these stats and plot a trend" — Gemini's native
sandbox fully replaces our own at **zero compute cost**. This is the default for
Gemini-routed turns. Falls back to T1–T3 when: >30s, custom/pinned libraries, output
shapes other than inline images, or chained live-data fetches we want to control.

> ⚠️ Native exec only applies when we call **Gemini directly**. OpenRouter standardizes
> tool-calling/structured-outputs but **does not execute code** — OpenRouter/NVIDIA
> turns must use T1–T3.

### T1 — Pyodide Python Worker *(light Python, no container)*
CPython→WASM in a Cloudflare Worker. Bundled **NumPy / Pandas / Pillow** cover
image-convert and small-dataset chart/data tasks. Sub-second, zero extra backend, no
per-sandbox billing. Limits: bundled package set only (no arbitrary pip), no
multiprocessing/uvloop, Worker CPU/time limits. Use for small images and small data.

### T2 — Dynamic Worker / "Code Mode" *(agent-written JS, the workhorse)*
V8 isolates: **millisecond** cold start, best per-task cost, and the strongest egress
story — a `globalOutbound` handler can inspect/block/rewrite **every** outbound fetch,
and `globalOutbound: null` air-gaps the code entirely. Ideal for agent-written
JavaScript: CSV munging, JSON transforms, chart-spec assembly, controlled live-data
fetch. JS only (Python/WASM possible but slow). This is also the **Code Mode** lever:
the agent writes code that calls tools and filters data *before* it re-enters context.

### T3 — Cloudflare Container (`@cloudflare/sandbox`) *(heavy / arbitrary — we already run this)*
Full Linux, arbitrary Python, `npm install`, long jobs. **Already in the repo**
(`studio-worker/`), HMAC-gated, per-user scoped. GA Apr 2026. Verified trade-off: it is
**container-based (shared kernel), not a microVM** — weaker isolation than Firecracker
and ~30s cold boot (≈2s snapshot restore) — but it stays inside our Workers bill and
has the "Outbound Workers" zero-trust egress proxy. **Phase 1 adds a one-shot `exec`
action** (run-to-completion → stdout/stderr/files) alongside the existing long-lived
dev-server mode.

## Full comparison (verified June 2026)

| Provider | Isolation | Cold start | Langs | Egress control | Compute price | Free tier | OSS | MCP |
|---|---|---|---|---|---|---|---|---|
| **Gemini native** | Google-managed | n/a (in-API) | Python | n/a (no arbitrary net) | **$0 compute** (tokens only) | with Gemini | no | n/a |
| **CF Dynamic Worker** | V8 isolate | **~ms** | JS | `globalOutbound` (block/rewrite/null) | Workers CPU + $0.002/uniq-Worker/day (beta-waived) | Workers Paid | SDK open | — |
| **Pyodide Worker** | V8 + WASM | sub-sec | Python | Worker fetch rules | Workers CPU | Workers Paid | yes | — |
| **CF Container / Sandbox SDK** ✅ ours | container (shared kernel) | ~30s boot / ~2s restore | Py/JS/Linux | Outbound Workers proxy | $0.000020/vCPU-s + $0.0000025/GiB-s | in $5 Workers Paid | SDK open | — |
| **E2B** | **Firecracker microVM** | ~78ms p50 (claim) | any | domain allowlist | ~$0.0504/vCPU-hr | $100 credit | yes (self-host) | **official** |
| **Daytona** | container (Kata opt.) | sub-90ms (claim) | any | configurable | $0.0504/vCPU-hr + mem | $200 credit | Apache-2.0 | yes |
| **Modal** | gVisor | ~1–5s | Python | configurable | ~3× base (sandboxes) | $30–100/mo | no | Python SDK |
| **Vercel Sandbox** | Firecracker microVM | seconds | node/py3.13 | per-sandbox | $0.128/CPU-hr | Hobby 5 CPU-hr | no | JS SDK |
| **Riza** | WASM | ms | Py/JS/TS/Rb/PHP | HTTP-only | in-plan | 100k req/mo | partial | **official** |
| **Fly Machines / Sprites** | Firecracker | sec / ~300ms restore | any | Fly net | ~$1.94/mo min | reduced | Firecracker OSS | — |

Self-hosted primitives: **Firecracker** (strongest, heavy ops) > **Kata** (microVM,
container UX) > **gVisor** (userspace, 20–50% I/O overhead) > **Docker+seccomp**
(shared kernel, insufficient alone for untrusted code). `microsandbox` (libkrun
microVM, <100ms, Apache-2.0, has MCP) is the most turnkey self-host option.

## Recommendation

**Extend what we have. No new vendor required.**

- **T0 Gemini-native** for Gemini-routed simple tasks (free compute).
- **T2 Dynamic Workers** + **T1 Pyodide** for the cheap/fast 95% (ms–sub-sec, strong
  egress control, on our stack).
- **T3 existing CF Container** for heavy/arbitrary Python.
- **E2B (Firecracker)** is the *only* reason to add a vendor — if, after security
  review, container-grade isolation is judged insufficient for untrusted multi-tenant
  code and we want hardware microVM isolation without operating Firecracker ourselves.
  Keep the `run_code` tool's executor behind an interface so this is a config swap.

### The executor interface (so tiers are swappable)
```ts
interface CodeExecutor {
  run(input: {
    language: 'python' | 'js';
    code: string;
    files?: { path: string; bytes: Uint8Array }[];
    timeoutMs: number;
    egress: 'none' | { allow: string[] };   // default 'none'
    limits: { memMb: number; cpuMs: number; outBytes: number };
  }, signal: AbortSignal): Promise<{
    ok: boolean; stdout: string; stderr: string;
    files: { path: string; bytes: Uint8Array }[];
    artifacts?: unknown[];                   // e.g. a chart spec / image ref
  }>;
}
```
T0/T1/T2/T3 (and E2B) are implementations; the router picks the cheapest capable one
from `{language, needs custom libs?, est. runtime, needs network?}`.
