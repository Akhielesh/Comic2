# 00 — Executive Summary

> Part I · Product & Strategy · Code Studio Autopilot Master Specification
> Canon: [SPEC-INDEX](../SPEC-INDEX.md) · [Master Plan](../00-MASTER-PLAN.md) ·
> [Cloudflare Architecture](../ARCHITECTURE-CLOUDFLARE.md) ·
> [Foundations](../F-ENTERPRISE-FOUNDATIONS.md)

## 0.1 The one-paragraph pitch

**Code Studio Autopilot** turns a sentence into a shipped, living product. A user describes a
business or product idea; the platform drafts a roadmap they approve; then a team of
**always-on AI agents builds, tests, deploys, observes, and keeps improving that product
24/7** — pausing only at the decisions a human must own (spending money, going to production,
anything destructive) and stopping the moment it hits a budget the user set. It runs on a
**hybrid cloud** (instant managed previews now, the user's own Cloudflare/Vercel/Supabase/
Railway accounts for production), and everything — agent compute, hosting, third-party usage —
is metered and billed through **one portal**: the Code Studio.

## 0.2 What's genuinely new (and what isn't)

This is **not** a greenfield moonshot. DreamStream already ships ~60% of the machinery:
an agentic build loop (`server/src/ai/studio/`), a multi-agent swarm (`server/src/ai/agents/`),
a Cloudflare container sandbox (`studio-worker/`), Nango connectors, Stripe billing + usage
metering, GitHub sync, and the `studio_*` data model. The existing roadmap (Phases 0–11) builds
the **interactive** "chat → build one app → preview/deploy" product.

Autopilot adds exactly **three** new things on top, and reuses everything else:

1. **Continuous autonomy** — a durable, always-on loop that keeps building a product against a
   roadmap across days and weeks, surviving restarts, governed by hard budgets + human
   checkpoints.
2. **The "Venture" abstraction** — a product/business the agents *own* (roadmap, backlog,
   deployments, analytics, budget, connected accounts, audit trail), one level above today's
   single `studio_projects`.
3. **Hybrid hosting + central billing for autonomy** — ship to managed infra or the user's own
   accounts, metered per venture through one portal.

The honest reframing the owner accepted: **"never stop building" means *continuous with hard
budgets and checkpoints*, not ungoverned.** Truly uncapped autonomy is how a platform wakes up
to a five-figure cloud bill or a production incident. We build the brakes before the engine.

## 0.3 The architecture in five words

**Workers + Durable Objects + Workflows + Containers.** The platform's brain is *not* an
always-on server. "Always-on" emerges from **Durable Object Alarms** (the per-venture
heartbeat), **Workflows** (durable, auto-retrying, resumable build pipelines), and
**Containers** (per-tenant sandboxed execution that scales to 1,000+ concurrent instances).
Workers are the edge/API/preview tier. Supabase remains the portable system-of-record; Railway
is the API tier during the transition. (Full topology:
[ARCHITECTURE-CLOUDFLARE.md](../ARCHITECTURE-CLOUDFLARE.md).)

Durable Objects also directly resolve the cross-cutting weaknesses an audit surfaced:
per-user coordinators give authoritative **sessions, multi-device sync, instant revocation**;
per-venture objects give **isolation for many simultaneous projects** and the real-time
activity stream.

## 0.4 The product, in three surfaces

1. **Intake** — describe the idea → an agent returns a structured venture spec + roadmap to
   approve (the first checkpoint).
2. **Operator Console** — the 24/7 cockpit: live activity stream, roadmap/backlog board,
   approval queue, budget meter, deployments, logs, and pause/resume/kill controls.
3. **Code Studio** — the existing builder/editor/preview, now driven autonomously and able to
   be taken over manually at any time ("code optional, never code-locked").

## 0.5 Who it's for

- **Non-technical founders** who want idea → running, improving MVP without hiring a team.
- **Solo developers / small teams** who want an autonomous teammate that does the grind
  (scaffolding, fixes, deploys, chores) while they steer architecture and product.
- **Existing DreamStream users** who already chat and build, and now want the product to keep
  building itself.

(Full personas: [03-personas-jtbd.md](./03-personas-jtbd.md).)

## 0.6 Why it can win

| Lever | Most "AI app builders" (Lovable / Bolt / v0 / Replit Agent / Emergent) | Code Studio Autopilot |
|---|---|---|
| Loop | one-shot or session-bound "build this" | **continuous, always-on, budget-governed** ownership of a product |
| Models | hosted, cost baked into subscription | **BYOK + free + any OpenRouter/NVIDIA model**; near-free runs possible |
| Hosting | their sandbox only | **hybrid** — managed previews *and* your own cloud accounts |
| Control plane | bolted on later | **billing, usage, credits, RLS, multi-agent already exist** |
| Governance | minimal | **budgets + checkpoints + audit + kill switch as first-class** |

We are **behind** on polish/experience and **ahead** on economics + control plane + governance.
This spec closes the experience gap while protecting the governance edge.

## 0.7 The plan, at a glance

Two interleaved backlogs, sequenced **safety/foundations-first**:

- **F-series (Enterprise Foundations, F0–F10):** observability, AI-provider reliability,
  distributed correctness, sessions, real-time, testing, migrations, API docs, security,
  design system, integrations. **F0 → F1 → F2 ship before any real autonomy.**
- **A-series (Autonomy, A0–A9):** brakes → control plane → loop engine → intake/roadmap →
  real build → deploy adapters → sense layer → billing portal → operator console → hardening +
  GA.

Milestones: **M-A1** governed-but-idle loop · **M-A2** idea→build→deploy end-to-end ·
**M-A3** self-improving · **M-A4** product (billing + console) · **M-A5** secure + GA.

## 0.8 What success looks like (North-Star + guardrail metrics)

- **North Star:** *weekly shipped, healthy venture-improvements per active user* (the product
  is demonstrably building things people keep).
- **Activation:** % of intakes that reach an approved roadmap, then a first live deploy.
- **Autonomy quality:** median goals shipped per run without human fix; stuck-rate.
- **Trust/safety:** zero budget overruns; zero cross-tenant incidents; 100% of prod deploys
  checkpoint-gated.
- **Economics:** compute cost per active venture; gross margin per plan.
(Full metric tree: [06-metrics-kpis.md](./06-metrics-kpis.md).)

## 0.9 Top risks (and the mitigation stance)

| Risk | Mitigation |
|---|---|
| Runaway cost / runaway loop | Budgets + kill switch + no-progress detector are **A0**, before the engine. |
| LLMs unreliable for arbitrary scope | First scope = web apps/landing/simple SaaS (where the loop already works); expand later. |
| Multi-tenant secret/data leak | Nango-held secrets + RLS + per-tenant DO/container isolation + the A9 security audit gate. |
| Managed-hosting abuse/cost | Tight quotas on managed previews; push real production to BYO accounts. |
| Provider outages (the audit's #1 finding) | F1: key pool + circuit breaker + cross-provider failover. |
| Vendor concentration on Cloudflare | Supabase as portable system-of-record; provider-agnostic deploy adapters. |

## 0.10 Scope boundaries (non-goals)

- **Self-hosting LLMs / renting GPUs** — out (per `01-VISION.md`; ~$10k–25k/mo per user). Models
  stay API/BYOK.
- **General cloud IDE / VS Code replacement** — out. We're an autonomous *builder* with an editor.
- **Unbounded autonomy with no human gates** — out by design.

## 0.11 How to read this spec

55 sections across five parts: **Strategy** (why), **Product Definition** (what/UX),
**Architecture** (how), **Non-functional/Foundations** (how well), **Delivery** (when/who).
Each section is self-contained and acceptance-gated. Start at [SPEC-INDEX](../SPEC-INDEX.md).
