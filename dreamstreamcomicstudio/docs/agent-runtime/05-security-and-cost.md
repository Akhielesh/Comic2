# 05 — Enterprise Security & Cost/Context Optimization

The brief demanded enterprise-scale quality and "context optimization to reduce costs."
Two playbooks, each an ordered checklist. Skeptic's rule throughout: **vendor detection
rates and best-case token savings are marketing until measured on our own traffic.**

## Part 1 — Security

Map the design to **OWASP Top 10 for LLM Apps 2025** (Prompt Injection = LLM01, still
#1) and the **OWASP Top 10 for Agentic Applications (ASI, Dec 2025)** — Goal Hijack,
Tool Misuse, Identity/Privilege Abuse, Memory Poisoning. For a code-executing agent the
dominant threat is **indirect prompt injection** (malicious instructions hidden in
fetched pages, files, tool output) chaining into **SSRF/exfiltration**.

### Checklist (do in this order)
1. **Secrets never enter the sandbox.** Use a **host-side credential proxy** that
   injects API keys into outbound headers; the agent code only sees a localhost proxy.
   (Highest impact, lowest effort.) — *fixes review weakness #9 for the sandbox path.*
2. **No-network-by-default + egress allowlist** on the sandbox. Default deny; allow only
   the specific endpoints a task needs. — *fixes weakness #1.* On Workers use
   `globalOutbound`; on the container use Outbound Workers.
3. **Block internal/metadata ranges** even when network is allowed: `169.254.0.0/16`
   (incl. `169.254.169.254` cloud-metadata/IAM), `10/8`, `172.16/12`, `192.168/16`,
   `127/8`, IPv6 equivalents.
4. **Strong isolation + per-tenant.** One sandbox per session; full reset between
   tenants; prefer microVM/gVisor over plain containers for untrusted code (our CF
   container is shared-kernel — accept with the egress guard, or escalate to E2B/
   Firecracker if review demands).
5. **Layered resource limits:** per-call (≤30s) / per-loop (≤20min) / per-lifetime
   timeouts + CPU/mem/disk/process caps + **output-size caps** (security *and* cost).
   — *addresses weaknesses #1, #5, #12; LLM10 Unbounded Consumption.*
6. **Fail closed** on cap/permission checks — never log-and-allow paid compute. —
   *fixes weakness #2; replaces fail-open `catch {}` from weakness #8.*
7. **SSRF defense on the fetch tool:** URL allowlist; block private CIDRs; **pin the
   resolved IP for the request lifetime** (defeats DNS rebinding); re-validate after
   each redirect. *(We already do DNS-rebind-safe resolution in `mcpClient.ts` /
   `unfurl.ts` — reuse it.)*
8. **Safe UI rendering** (LLM05 Improper Output Handling): the `generative_ui`
   whitelist renders **no raw HTML** (this PR). For the arbitrary-UI hatch: separate-
   origin iframe, `sandbox="allow-scripts"` **only** (never with `allow-same-origin`),
   strict CSP (`connect-src`/`script-src`), validate every `postMessage` origin,
   DOMPurify for any must-inject HTML, `HttpOnly`+`Secure`+`SameSite=Strict` cookies.
9. **Treat all tool output / fetched data / user files as untrusted data, not
   instructions** — segregate ("spotlight") external content in the prompt; never let
   it reach the system prompt. — *fixes weakness #3.*
10. **Least privilege + human-in-the-loop** for high-consequence actions; **guardrails
    as defense-in-depth** (LLM Guard (MIT) / Llama Guard / NeMo for our NVIDIA stack /
    Lakera), validated on our own red-team set — never the sole control. Red-team
    continuously.

## Part 2 — Cost / Context optimization

### Checklist (highest leverage first)
1. **Code Mode: orchestrate tools + filter data IN code** before results hit the model.
   This is *the* lever and we already run code. Measured: Anthropic 150k→2k (98.7%);
   Cloudflare API surface 1.17M→~1k tokens (99.9%). Treat as best-case — but the
   *mechanism* (don't round-trip raw data through the model) is real and general.
2. **Prompt caching everywhere.**
   - **Gemini 2.5+: 90% discount on cached input tokens** (e.g. 2.5 Flash $0.30→$0.03;
     2.5 Pro $1.25→$0.125). **Implicit caching is on by default**, storage-free; min
     2,048 tok (2.5) / 4,096 (3.x); 1-hour default TTL. Put the **system prompt + tool
     defs first** to maximize prefix hits.
   - **OpenRouter passes provider discounts through** (`cache_discount` field): Anthropic
     ~90% off reads but **writes cost 1.25× (5-min) / 2× (1-hour)** — only cache stable,
     high-reuse prefixes; OpenAI ~0.25–0.5× reads, automatic.
3. **Progressive tool disclosure.** Don't dump all ~60 tool schemas; load on demand
   (we already cap to ≤20 via `selectRelevantTools` — extend toward filesystem/tool-
   search). Anthropic Tool Search: 77k→8.7k tokens (~85%), and tool accuracy 49%→74%.
4. **Context compaction.** Summarize old turns near ~85% of the window; replace old
   tool results with **artifact pointers** (~15 tokens each). Anthropic context-editing:
   −84% tokens with +29% performance on a search task; Google reports 60–80% from
   compaction.
5. **Return references, not blobs.** Persist large outputs (files, query results,
   generated UI) and pass the model an **ID/URL/path** — pairs perfectly with the
   sandbox writing results to disk. — *also fixes weakness #12.*
6. **Model routing.** Default to **Flash-tier** (Gemini 3.x Flash-Lite / 3.5 Flash);
   escalate to Pro/Sonnet/Opus only on genuinely hard reasoning (~60–80% savings). On
   tool/agentic tasks small models often **match** big ones (92–100% vs 88%). Our
   `autoRouter.ts` already does fallback chains — add a cost-aware classifier route.
   (NVIDIA NIM is great free for prototyping but production is **per-GPU** (~$1/GPU-hr /
   $4.5k/GPU-yr), not per-token — model that carefully.)
7. **Structured outputs** to cut output tokens; **stream** for perceived latency.
8. **Observability with cost tracking.** **Langfuse** (MIT, self-host: Postgres+
   ClickHouse) for an all-in-one tracing + token/cost dashboard, or **Helicone** as a
   drop-in proxy; instrument via **OpenLLMetry** (vendor-neutral OTel) so the backend
   stays portable. Measure before optimizing further. We already have
   `observability/{auditLog,metrics}.ts` to build on.

### Targets to track
- Tokens/request (input cached vs uncached), $/request, cache-hit rate, tool-loop
  wall-clock, sandbox seconds, p50/p95 latency, verify-pass-rate, retries/task.
- Wire these into the existing `usageEnforcer` / `billingLedger` so cost ceilings are
  enforceable (weakness #5: add a per-request total-cost ceiling on the tool loop).
