# 01 — Vision

## What we're building
An **AI-centric app builder** inside DreamStream: the user describes an app in chat, an
**agent builds it end to end**, it **runs live in a cloud container**, and the user can
preview it from any device, dive into the real code, sync to GitHub, and deploy in one
click. The bar is **Lovable / Emergent-class**.

## Why (the problem)
Today the "code studio" only reliably produced a single-file Markdown preview; the AI
rarely opened the real multi-file studio, and there was no persistence, no real editor,
no deploy. It felt like a toy. We want it to feel like a professional product that turns
an idea into a running, shippable app.

## The one-sentence positioning
> **Build and run real apps by chatting with AI — on any model you want, from any
> device, for pennies.**

## Who it's for
- Builders/founders who want to go from idea → running MVP fast (Lovable's audience).
- Developers who want AI to scaffold + iterate but still **dive into the code** (our
  "code optional" stance).
- Existing DreamStream users who already chat with AI and now want to *build*, not just talk.

## Goals (what "great" means)
1. **AI-centric:** 90% of users never touch code; chat drives plan → build → fix → deploy.
2. **Real execution:** actual `npm install` + dev server + a live URL, not a fake preview.
3. **Universal:** works on desktop *and* mobile (server-side execution; device just opens a URL).
4. **Agentic:** the AI sees real build/runtime errors and fixes them itself, iterating to green.
5. **Persistent:** projects are saved, versioned, re-openable; nothing is lost.
6. **Shippable:** GitHub sync + one-click deploy.
7. **Cheap to run:** BYOK / free-model first → ~cents/session compute; tokens on the user.

## Non-goals (explicitly out of scope)
- **Self-hosting LLMs / GPU compute.** Models are API/BYOK. Renting GPUs to run a 500B–1T
  model is ~$10k–25k/mo for one user — never. (See `CLOUDFLARE_STUDIO_PLAN.md §10c`.)
- Being a general cloud IDE / replacing VS Code. We're an *AI app builder* with an editor.
- 24/7 always-on app hosting as the core loop (we deploy to CF Pages/Workers for that).

## Our honest edge vs Lovable / Emergent
| Lever | Lovable / Emergent | DreamStream Studio |
|---|---|---|
| Models | hosted, their cost baked in | **BYOK + free + any OpenRouter/NVIDIA model** |
| Cost to user | subscription covers their model spend | can run near-free (own key / free models) |
| Control plane | bolted on | **billing/usage/credits already exist** |
| Multi-agent | yes | **agent swarm already built** |
| Execution | hosted sandbox | Cloudflare containers (cheap, universal) |

We are **behind** on the *experience* (agentic loop, editor, persistence, deploy) and
**ahead** on *economics + control plane*. This doc set closes the experience gap.

## Success metrics (when we'll know it's working)
- % of "build me X" chats that produce a **running** app (target > 80%; was ~15%).
- Median iterations for the agent to reach a clean build.
- Time from prompt → live preview URL.
- % of projects deployed / pushed to GitHub.
- Compute cost per active user (target: a few $/month; see cost docs).
