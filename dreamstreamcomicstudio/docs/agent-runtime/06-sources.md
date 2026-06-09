# 06 — Sources

Primary/authoritative sources behind these docs (fact-checked June 2026). Vendor
pricing and best-case token-savings figures should be re-verified against live docs and
measured on our own traffic before being relied on.

## Execution sandboxes
- Cloudflare Dynamic Workers / Code Mode — https://blog.cloudflare.com/dynamic-workers/ , https://blog.cloudflare.com/code-mode-mcp/
- Cloudflare Containers/Sandboxes GA — https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/ , pricing https://developers.cloudflare.com/containers/pricing/ , InfoQ https://www.infoq.com/news/2026/04/cloudflare-sandboxes-ga/
- Cloudflare Python Workers (Pyodide: NumPy/Pandas/Pillow) — https://blog.cloudflare.com/python-workers-advancements/
- E2B (Firecracker) pricing + MCP — https://e2b.dev/pricing , https://github.com/e2b-dev/mcp-server
- Daytona — https://www.daytona.io/pricing ; Modal — https://modal.com/pricing ; Vercel Sandbox — https://vercel.com/docs/sandbox/pricing ; Riza — https://riza.io/pricing ; Fly — https://fly.io/pricing/
- Isolation comparison (Firecracker/Kata/gVisor) — https://edera.dev/stories/kata-vs-firecracker-vs-gvisor-isolation-compared ; microsandbox — https://github.com/superradcompany/microsandbox

## Agent loop, code execution, verification
- Gemini API native code execution — https://ai.google.dev/gemini-api/docs/code-execution ; changelog https://ai.google.dev/gemini-api/docs/changelog
- OpenAI Code Interpreter — https://developers.openai.com/api/docs/guides/tools-code-interpreter ; pricing https://developers.openai.com/api/docs/pricing
- OpenRouter tool-calling / structured outputs (no code exec) — https://openrouter.ai/docs/guides/features/tool-calling , https://openrouter.ai/docs/guides/features/structured-outputs
- Anthropic "Code execution with MCP" (98.7% token reduction) — https://www.anthropic.com/engineering/code-execution-with-mcp
- Anthropic "Advanced tool use" (Tool Search 77k→8.7k; Programmatic Tool Calling −38%) — https://www.anthropic.com/engineering/advanced-tool-use
- Reflexion — https://arxiv.org/pdf/2303.11366 ; Self-Debugging — https://arxiv.org/abs/2304.05128 ; Self-generated tests — https://aclanthology.org/2025.acl-long.881/
- LLM-as-judge survey — https://arxiv.org/pdf/2411.15594
- smolagents CodeAgent — https://huggingface.co/docs/smolagents/en/index , https://huggingface.co/blog/structured-codeagent
- Vercel AI SDK loop control — https://ai-sdk.dev/docs/agents/loop-control ; LangGraph HITL — https://docs.langchain.com/oss/python/langchain/human-in-the-loop ; Pydantic-AI — https://ai.pydantic.dev/agent/

## Generative UI
- Vercel AI SDK Generative UI — https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces (RSC `streamUI` paused — https://ai-sdk.dev/docs/reference/ai-sdk-rsc/render)
- assistant-ui — https://www.assistant-ui.com/docs ; CopilotKit `useCopilotAction` — https://docs.copilotkit.ai/
- Thesys C1 (paid generative-UI API) — https://www.thesys.dev/ , https://www.thesys.dev/pricing
- MCP-UI / MCP Apps — https://mcpui.dev/ , https://modelcontextprotocol.io/extensions/apps/overview , https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/
- How Anthropic built Artifacts (sandboxed iframe + CSP) — https://simonwillison.net/2024/Aug/28/how-anthropic-built-artifacts/
- iframe `sandbox` (never allow-scripts+allow-same-origin) — https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox
- tambo (Zod-validated component props) — https://docs.tambo.co/guides/enable-generative-ui/register-components
- Sandpack EOL / CodeSandbox→Together AI — https://codesandbox.io/blog/joining-together-ai-introducing-codesandbox-sdk
- react-live (eval, not a sandbox) — https://github.com/FormidableLabs/react-live
- Charts: Recharts/ECharts/Vega-Lite/visx/Nivo/Tremor — https://blog.logrocket.com/best-react-chart-libraries-2026/ , https://vega.github.io/vega-lite/
- Motion (framer-motion) LazyMotion — https://motion.dev/docs/react-lazy-motion , https://motion.dev/docs/react-upgrade-guide ; auto-animate — https://auto-animate.formkit.com/

## Deterministic conversion / charting / data
- vl-convert (BSD-3; Python/Rust only) — https://github.com/vega/vl-convert
- sharp — https://sharp.pixelplumbing.com/ ; resvg-js / @cf-wasm/resvg — https://github.com/yisibl/resvg-js , https://www.npmjs.com/package/@cf-wasm/resvg
- ECharts SSR (`renderToSVGString`) — https://apache.github.io/echarts-handbook/en/how-to/cross-platform/server/
- QuickChart (AGPL) — https://quickchart.io/ ; chartjs-node-canvas — https://github.com/SeanSobey/ChartjsNodeCanvas ; mermaid-cli — https://github.com/mermaid-js/mermaid-cli
- PapaParse — https://www.papaparse.com/ ; SheetJS — https://docs.sheetjs.com/ ; DuckDB-wasm — https://github.com/duckdb/duckdb-wasm ; Arquero — https://idl.uw.edu/arquero/ ; simple-statistics — https://simple-statistics.github.io/
- Document converters: Pandoc (GPL) https://pandoc.org/ ; LibreOffice headless https://www.npmjs.com/package/libreoffice-convert ; poppler https://poppler.freedesktop.org/

## Security & cost
- OWASP Top 10 for LLM Apps 2025 — https://owasp.org/www-project-top-10-for-large-language-model-applications/
- OWASP Top 10 for Agentic Applications (ASI, Dec 2025) — https://genai.owasp.org/
- Gemini pricing + context caching (90% off reads) — https://ai.google.dev/gemini-api/docs/pricing , https://ai.google.dev/gemini-api/docs/caching
- OpenRouter prompt caching — https://openrouter.ai/docs/guides/best-practices/prompt-caching
- Anthropic context editing/compaction — https://platform.claude.com/docs (context management)
- Cloud metadata SSRF / DNS-rebind pinning — OWASP SSRF guidance; instance metadata `169.254.169.254`
- Guardrails: LLM Guard (MIT), Llama Guard, NVIDIA NeMo Guardrails, Lakera
- Observability: Langfuse — https://langfuse.com/ ; Helicone — https://www.helicone.ai/ ; OpenLLMetry/Traceloop — https://github.com/traceloop/openllmetry ; Arize Phoenix — https://phoenix.arize.com/
- NVIDIA NIM (OpenAI-compatible; per-GPU production economics) — https://build.nvidia.com/models
