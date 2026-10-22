# 01 — Vision, Mission & Positioning

> Part I · Product & Strategy · Canon: [SPEC-INDEX](../SPEC-INDEX.md)

## 1.1 Mission

**Make building and running software a conversation, not a profession.** Anyone with an idea
should be able to get a real, hosted, improving product — without assembling a team, learning a
stack, or babysitting a deploy — while never being locked out of the code if they want it.

## 1.2 Vision (3–5 year)

A world where a "company" can be one person plus an always-on AI product team. You describe
what you want to exist; a fleet of agents plans it, builds it, ships it, watches it in
production, and keeps making it better — inside guardrails you set. The Code Studio is the
single place where that happens and where everything (compute, hosting, integrations, money) is
managed. DreamStream's comic/creative roots become one vertical among many a Venture can be.

## 1.3 Positioning statement

> **For** founders and builders who want to go from idea to a living product,
> **Code Studio Autopilot** is an always-on autonomous product studio
> **that** plans, builds, deploys, and continuously improves your product 24/7 with hard
> budgets and human checkpoints,
> **unlike** one-shot AI app builders that stop when the chat ends and hosted-only sandboxes
> that trap you,
> **because** it owns the whole loop — on your own cloud accounts, on any model, billed in one
> place — with governance built in.

## 1.4 The category we're creating

Existing tools are **"AI app builders"** (you prompt, it builds, you babysit). We are an
**"autonomous product studio"**: the unit of work is a *Venture* (a product that persists and
improves), not a *prompt* (a one-off generation). The shift is from *assisting a build* to
*owning a product's lifecycle* — with the human as **operator/approver**, not typist.

## 1.5 Design philosophy (the non-negotiable tenets)

1. **Brakes before engine.** Every autonomy capability ships *after* its governance
   (budget/checkpoint/audit/kill-switch). Safety is a feature, not a phase.
2. **Code-optional, never code-locked.** 90% of users never open the editor; the 10% who do get
   the real multi-file code, GitHub sync, and full takeover — always.
3. **Honest by construction.** The product shows what it's doing, what it costs, what it's
   unsure about, and what it can't verify. No fake previews, no hidden spend, no silent
   failures. (Mirrors the existing guardrails + "show your work" swarm trace.)
4. **Your cloud, your keys, your data.** BYO accounts + BYOK + a portable system-of-record.
   Managed mode is for speed, not lock-in.
5. **Continuous, not frantic.** Always-on means a governed heartbeat with budgets — not burning
   tokens in a hot loop.
6. **Reuse over rebuild.** The platform is orchestration + governance over assets that already
   exist; we don't re-implement what works.
7. **Enterprise-grade by default.** Observability, multi-tenancy, testing, and security are
   foundations (F-series), not afterthoughts.

## 1.6 The "magic moments" we are designing for

- **M1 — "It understood my idea."** Intake returns a roadmap that feels right; the user just
  approves.
- **M2 — "It's actually building."** The Operator Console streams real files, real installs,
  real errors being fixed — live.
- **M3 — "It shipped."** A real URL, on a real host, that works.
- **M4 — "It fixed itself."** A production error becomes a fix goal and a new deploy, without
  the user lifting a finger (within budget/checkpoints).
- **M5 — "I'm in control."** One screen shows spend, lets the user approve/deny, pause, or take
  the wheel.

## 1.7 What we are NOT

- Not a chatbot that writes code snippets you copy-paste.
- Not a hosted-only sandbox you can't escape.
- Not an "agent" demo that forgets everything when the tab closes.
- Not an ungoverned auto-builder that spends without limits.
- Not a GPU/LLM host. Models are API/BYOK.

## 1.8 Relationship to the existing DreamStream product

DreamStream Comic Studio (chat + comic/creative generation + the interactive Code Studio)
continues and is **not disrupted**. Autopilot is additive and flag-gated (`VENTURES_ENABLED`).
The existing chat/swarm/tools become *capabilities the autonomous engine uses*; the comic
pipeline becomes *one kind of Venture*. The brand can evolve (the studio domain
`dreamstreamstudio.ai` already exists) but no rename is required to ship.

## 1.9 Strategic bets (explicit, falsifiable)

1. **Bet: durable autonomy + governance is the wedge.** People will trust an agent that *can't*
   overspend or ship to prod without asking. (Falsified if users disable checkpoints en masse or
   churn citing lack of trust.)
2. **Bet: hybrid hosting beats hosted-only.** "Instant preview now, my own cloud for real" wins
   both speed and trust. (Falsified if nobody connects BYO accounts.)
3. **Bet: BYOK/free-first economics is a durable moat.** Running near-free on your own key
   undercuts subscription-bundled competitors. (Falsified if users prefer all-inclusive pricing
   and ignore BYOK.)
4. **Bet: Cloudflare DO/Workflows is the right substrate.** Per-tenant objects + durable
   execution give isolation + always-on cheaply. (Falsified if DO/Workflows limits force a
   different runtime.)

## 1.10 Guiding metric for vision (restated)

The vision is working when **active users accumulate Ventures that keep shipping healthy
improvements week over week** — i.e., the product is a teammate people keep, not a toy they try.
(Operationalized in [06-metrics-kpis.md](./06-metrics-kpis.md).)
