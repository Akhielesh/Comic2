# Best coding models for Code Studio (2026)

> Research snapshot compiled from external, verified leaderboards and vendor cards
> (swebench.com, llm-stats.com, LMArena, OpenRouter, build.nvidia.com, vendor model cards).
> Numbers are **SWE-bench Verified** (real GitHub bug-fixing) unless noted, and are approximate
> point-in-time figures for orientation — verify at the source links. The app's live ranking is
> computed from `services/modelBenchmarks.ts` + `services/modelDomains.ts`; this doc is the
> human-readable summary and the basis for the curated shortlist in
> `services/codingRecommendations.ts`.

## TL;DR — what Code Studio should default to

Code Studio builds apps **free-first** with a strong open coder, independently of the comics/chat
model. The auto-pick order (server `CODING_MODEL_PRIORITY`) leads with the proven open agentic
coders below; users can pin any specific model + source in **Code Studio → Settings**.

## Best free / open-source coders (OpenRouter + NVIDIA)

| Rank | Model | Vendor | ~SWE-bench Verified | Context | Free? | Why |
|------|-------|--------|--------------------|---------|-------|-----|
| 1 | **Qwen3-Coder 480B** | Alibaba | ~67% | 256K–1M | ✅ (`:free` on OR; NVIDIA) | Purpose-built open agentic coder; the default for building apps |
| 2 | **MiniMax M2** | MiniMax | ~69% | 200K | ✅ | Efficient open coder, competes with paid frontier on SWE-bench |
| 3 | **GLM-4.6** | Z.ai (Zhipu) | ~68% | 200K | ◑ (GLM-4.5-Air free) | Strongest all-round open coder for long-horizon agentic work |
| 4 | **DeepSeek V3.1 / V3.2** | DeepSeek | ~67% | 164K | ✅ | Reasoning-heavy MoE; great at complex multi-file changes |
| 5 | **Kimi K2** | Moonshot | ~66% | 128K | ✅ | Trillion-param MoE, excellent tool use → agentic builds |
| 6 | **DeepSeek R1 (0528)** | DeepSeek | ~49–57% | 128K | ✅ | Open reasoning with visible chain-of-thought; good for debugging |
| 7 | **GPT-OSS 120B** | OpenAI (open-weight) | ~55% | 131K | ✅ | Strong reasoning/math, solid coding, generous free tier |
| 8 | **Devstral** | Mistral | ~53% | 128K | ✅ | Agentic coder tuned for Aider/Cline-style tool workflows |
| 9 | **Qwen2.5-Coder 32B** | Alibaba | ~38% | 128K | ✅ | Fast, reliable low-cost default for smaller apps |
| 10 | **Llama 3.3 70B** | Meta | ~25% | 131K | ✅ | Dependable open generalist, broad free availability |
| — | **Nemotron (Llama/Mistral)** | NVIDIA | ~22% | 128K | ✅ (NVIDIA) | Instruction/function-calling tuned; good for agentic tooling |

✅ = a genuinely-free variant is commonly available · ◑ = free tier on a smaller sibling

## Sources & routing

- **OpenRouter** — unified gateway; many families ship a `:free` variant (rate-limited, ~20 req/min).
  Free models are marked with a `:free` suffix in the id (e.g. `qwen/qwen3-coder:free`).
- **NVIDIA Build (NIM)** — 100+ models on DGX Cloud with a credit-based free tier, OpenAI-compatible.
  Strong coders include Qwen3-Coder 480B, DeepSeek V3.x, Kimi K2, MiniMax M2, and Nemotron.

## Frontier (BYOK / credits) for the "Quality" preference

When a user sets Code Studio's spend preference to **Quality** with a funded key, the strongest
coders are proprietary frontier models — Claude Opus/Sonnet (SWE-bench ~70–72%), Gemini 2.5 Pro,
GPT-4.1/o-series. These are reached through the same source picker (OpenRouter) via the user's key.

## How this maps to the code

- `services/modelBenchmarks.ts` — curated benchmark snapshot (per-family regex → scores). Updated
  with the 2026 open coders above (Qwen3-Coder, DeepSeek V3.1/V3.2, GLM-4.5/4.6, Kimi K2, GPT-OSS,
  MiniMax, Devstral, Codestral).
- `services/modelDomains.ts` — derives a 0–100 **coding** strength from HumanEval + SWE-bench
  (+ a purpose-built-coder bonus). This drives the Library's coding leaderboard ranking.
- `services/codingRecommendations.ts` — the curated shortlist above, surfaced as "Recommended"
  chips in the leaderboard and Code Studio settings.
- `server/src/ai/autoRouter.ts` — `CODING_MODEL_PRIORITY` ranks free candidates for `pickCodingModel`,
  so Code Studio's seamless auto-pick lands on a proven coder.

## Sources

- SWE-bench Verified leaderboard — https://www.swebench.com/ , https://llm-stats.com/benchmarks/swe-bench-verified
- Open LLM / coding leaderboards — https://kilo.ai/open-source-models , https://onyx.app/insights/best-llms-for-coding-2026
- OpenRouter free models — https://openrouter.ai/collections/free-models , https://openrouter.ai/collections/programming
- NVIDIA Build models — https://build.nvidia.com/models
- Vendor cards — Qwen, DeepSeek, Z.ai (GLM), Moonshot (Kimi), OpenAI (gpt-oss), Mistral (Devstral/Codestral)
