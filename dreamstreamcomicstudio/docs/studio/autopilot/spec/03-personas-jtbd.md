# 03 — Personas & Jobs-to-be-Done

> Part I · Product & Strategy · Canon: [SPEC-INDEX](../SPEC-INDEX.md)

## 3.1 How to read this

Each persona has: a profile, their **Jobs-to-be-Done** (functional, emotional, social), pains
today, what "success" feels like, how Autopilot serves them, and the **must-have features** that
make them adopt. Personas are prioritized: **P1 (primary, design-for), P2 (secondary,
accommodate), P3 (later).**

---

## 3.2 Persona A — "Maya", the non-technical founder · **P1**

**Profile:** has a sharp product idea and domain expertise; can't code; has limited budget; does
not want to hire a dev shop or learn a stack. Comfortable describing what she wants and making
decisions.

**JTBD**
- *Functional:* "When I have an idea, help me get a real, hosted product I can show users and
  iterate on — without writing code or managing servers."
- *Emotional:* "Make me feel in control and safe, not like I've handed my idea (and my credit
  card) to a black box."
- *Social:* "Let me say *I built this* and show a live URL."

**Pains today:** no-code tools hit ceilings; dev shops are slow/expensive; AI builders produce a
demo then stall, and she can't fix what breaks; she fears runaway costs.

**Success feels like:** describe → approve a plan → watch it build → get a link that works →
it keeps improving → she's never surprised by a bill.

**How Autopilot serves Maya:** intake → approved roadmap → autonomous build → managed preview
(instant) → BYO/managed production behind a checkpoint → budget she sets → Operator Console she
can actually understand.

**Must-haves:** plain-language intake; a roadmap she can approve/edit; a live activity stream
that's legible; **hard budget cap + spend meter**; one-click approvals; "it shipped" with a real
URL; email/in-app notifications; zero forced code.

---

## 3.3 Persona B — "Dev", the solo developer / indie hacker · **P1**

**Profile:** ships side projects; values control, their own keys, and the code; wants leverage,
not a babysitter; skeptical of magic.

**JTBD**
- *Functional:* "Do the grind for me — scaffolding, wiring, fixes, deploys, chores — while I keep
  architectural control and the real code."
- *Emotional:* "Don't lock me in or hide what you did; let me trust it because I can inspect it."
- *Social:* "Let me run several projects at once and look like a team of five."

**Pains today:** context-switching across many side projects; boilerplate fatigue; AI tools that
can't see real runtime errors or that trap code in a sandbox; one rate-limited API key killing a
session.

**Success feels like:** point it at a goal, walk away, come back to a green build + a PR + a
deploy he can review; **his own OpenRouter/Cloudflare keys**; full GitHub sync; take over in the
editor anytime.

**How Autopilot serves Dev:** BYOK + BYO accounts; code-optional but code-first when he wants;
GitHub two-way sync; multiple simultaneous Ventures (per-venture isolation); the swarm + build
loop doing the grind; provider key pool so a single 429 doesn't stop him (F1).

**Must-haves:** BYOK + BYO hosting; GitHub sync + PRs; real code + editor + diffs; **multiple
concurrent ventures**; reliable model connectivity (F1); transparent activity/trace; manual
takeover + redirect mid-loop.

---

## 3.4 Persona C — "Sam", the small-team lead / agency · **P2**

**Profile:** runs a small team or agency; ships products for clients; needs work to land in the
*client's* cloud and to bill cleanly.

**JTBD**
- *Functional:* "Spin up client products fast, deploy into the client's own accounts, and track
  cost per project."
- *Emotional:* "Look professional and in control; never leak one client's data into another's."
- *Social:* "Show clients a live, improving product and a clean invoice."

**Pains today:** repetitive client setup; juggling many clouds/credentials; attributing cost per
client; isolation/compliance worries.

**Success feels like:** per-client Ventures, each on the client's connected accounts, each with
its own budget + spend report; strict isolation; exportable artifacts.

**How Autopilot serves Sam:** per-venture **Connections** (BYO via Nango), per-venture budgets +
metering, RLS + per-tenant DO/container isolation, audit trail, GitHub handoff.

**Must-haves:** per-venture BYO accounts; per-venture budgets + invoices; hard tenant isolation;
audit log; export/handoff; role-based access (later).

---

## 3.5 Persona D — "Riley", the existing DreamStream creator · **P2/Adjacent**

**Profile:** already uses DreamStream for comics/creative; chats and builds; now wants the
product to keep building itself or to make creative apps.

**JTBD:** "Turn my creative output into a living app/site that improves without me babysitting."

**How Autopilot serves Riley:** the comic/creative pipeline becomes a **Venture vertical**; the
existing chat/swarm/tools become engine capabilities; same account, same billing.

**Must-haves:** continuity with the current app (no disruption); creative-friendly templates;
the same low-cost BYOK economics.

---

## 3.6 Persona E — "Ops/Owner" (you) · **internal P1**

**Profile:** the platform owner/operator who must run this safely and profitably, and the AI
(Claude) building it.

**JTBD:** "Run an always-on, multi-tenant autonomous platform without getting burned by cost,
abuse, outages, or a security incident — and keep shipping it."

**How Autopilot serves Ops:** the F-series (observability, provider reliability, distributed
correctness, security) + the A-series governance (budgets, kill switch, audit) + runbooks +
GA gating. The Operating Model doc defines how Claude builds it continuously and safely.

**Must-haves:** global kill switch; per-tenant + global budgets/quotas; metrics + alerts +
error tracking; audit log; incident runbooks; security review gate before GA.

---

## 3.7 Anti-personas (who we are NOT optimizing for, yet)

- **Large enterprise with strict procurement/SSO/SOC2 today** — needs compliance we haven't
  built (F-series is the path; not the launch target).
- **Users who want a pure no-code visual builder** — we're agent-driven, code-optional, not
  drag-and-drop-first.
- **Users wanting us to host LLMs/GPUs** — out of scope (BYOK/API only).

## 3.8 JTBD → feature mapping (traceability)

| Job | Serving features | Spec refs |
|---|---|---|
| "Understand my idea" | Intake → roadmap + approval checkpoint | 13, A3 |
| "Build it without me coding" | Autonomous loop + build engine + swarm | 24, A2, A4 |
| "Show me what it's doing" | Operator Console live activity stream | 14, A8 |
| "Don't surprise me with a bill" | Budgets + spend meter + alerts | 41, A0, A7 |
| "Ship it for real" | Deploy adapters (managed + BYO) | 31, A5 |
| "Keep improving it" | Sense layer → fix/improve goals | 24, A6 |
| "Let me keep control / take over" | Editor, GitHub sync, pause/redirect/kill | 15, 14 |
| "Run many projects safely" | Per-venture isolation (DO/RLS/containers) | 25, 33 |
| "Reliable model access" | Provider key pool + failover + breaker | 29, F1 |

## 3.9 Adoption thesis per persona

- **Maya** adopts when intake feels smart and budgets feel safe.
- **Dev** adopts when BYOK + GitHub + real code + reliability are undeniable.
- **Sam** adopts when per-client BYO + isolation + invoices work.
- **Riley** adopts when it's continuous and stays cheap.
- **Ops** can run it when governance + observability + security gates are real.
