# 48 — Team, RACI & Ways of Working

> Part V · Delivery · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Operating Model](../OPERATING-MODEL.md) (the continuous build loop this section formalizes
> into responsibilities) · [Master Plan](../00-MASTER-PLAN.md) (A0–A9, §12 owner actions) ·
> [Enterprise Foundations](../F-ENTERPRISE-FOUNDATIONS.md) (F0–F10) ·
> [AGENTS.md](../../AGENTS.md) (the mandatory STATUS/CHANGELOG/OWNER-ACTIONS discipline) ·
> [CI/CD & Release](./44-cicd-release.md) · sibling: [49 — Owner Actions](./49-owner-actions.md)
> (the live checklist this section governs).

## 48.1 Scope & stance

This section answers a deliberately unglamorous question: **who actually does the work, who
is accountable, and how do we work together day to day?** It is the org chart, the RACI
matrix, and the ways-of-working contract for building Code Studio Autopilot.

**House rule for this section: describe the team that exists, not the team a deck would
invent.** Right now the team is exactly two participants — the **owner** (one person) and
**Claude** (the AI build agent). There is no backend team, no SRE on call, no design org.
Pretending otherwise would make every RACI cell a lie. So this section does two things at
once:

1. **Documents the real, two-actor operating model** that is shipping the spec and the code
   today (owner + Claude), and the decision rights that make it safe.
2. **Defines the roles a growing team would fill** (backend, frontend, SRE/security,
   design) and pre-assigns the RACI so that *adding a person is a substitution, not a
   reorg* — a future hire steps into a column that is already drawn.

The throughline is the same one that governs the product: **brakes before engine.** The
human holds every irreversible lever (money, secrets, production, accounts); the AI does the
reversible, flag-gated engineering at volume. That division is not a temporary scaffold — it
is the permanent safety model, and it scales unchanged as humans are added.

---

## 48.2 The honest reality: a team of one-plus-an-agent

### 48.2.1 What the team actually is

| Actor | Who | Capacity | What they are |
|---|---|---|---|
| **Owner** | One person (the product owner / founder) | Part-time, asynchronous, reviews in batches | Product authority, sole holder of accounts/secrets/money, the only one who can approve production and irreversible actions. |
| **Claude** | The AI build agent (this assistant) | Effectively continuous across sessions, bounded by the build loop | Implementer, writer, tester, doc-keeper. Produces code + spec + tests on a branch; never holds a credential; never approves its own irreversible actions. |

That is the whole team. Everything below — the roles, the RACI columns, the hiring order —
is **planned structure layered over this reality**, marked as such. We do not have a
backend engineer; we have a *backend column* in the matrix that Claude currently fills and a
human will later inherit.

### 48.2.2 Why this is enough to start (and where it stops)

It is enough because Autopilot is, by the Master Plan's own framing, **mostly orchestration
+ state + governance over assets that already exist** (the build loop, the swarm, the
sandbox, billing, model routing). The expensive, risky primitives are built. The remaining
work is sequenced into small, reversible, flag-gated epics (A0–A9, F0–F10) — precisely the
shape an AI agent can carry forward continuously while a single human reviews at the gates.

It **stops** at the things an AI cannot and must not do alone: spend money, hold provider
credentials, approve a production launch, accept legal/compliance risk, or make a
non-reversible architectural commitment. Those are owner-only by construction (§48.6), and
they are also the natural first places a human hire adds leverage (§48.4).

### 48.2.3 Honest caveats about this model

- **Bus factor is two, and one of them is an AI.** STATUS.md / CHANGELOG.md / OWNER-ACTIONS.md
  are the mitigation: they are written so *any* fresh session (or a future hire) can start
  cold and continue correctly. If those drift, the bus factor is one. Keeping them current is
  therefore a P0 responsibility, not housekeeping (§48.5).
- **The owner is the bottleneck at every gate, deliberately.** Throughput is gated by how
  fast the owner reviews checkpoints, applies migrations, and approves prod. This is the
  intended trade: slower at the gates, safe everywhere. The fix for throughput is hiring
  (§48.4), not loosening the gates.
- **The AI is fallible.** Claude can produce a confidently wrong diff. The defenses are the
  verify gate (typecheck + server build + tests + frontend build), flag-gating
  (`VENTURES_ENABLED=false` by default), additive-only changes, and human review of the PR —
  not trust.

---

## 48.3 Roles (current holders and future hires)

Each role is a **responsibility surface**, not a headcount. The "Current holder" column is
the honest 2026 reality; "Eventual hire" is who should own it as the team grows.

| Role | Responsibility surface | Current holder | Eventual hire | Owner-only? |
|---|---|---|---|---|
| **Product / Owner** | Vision, scope, prioritization, roadmap approval, money, accounts, secrets, production sign-off, legal/compliance acceptance. | Owner | Owner (never delegated in full) | **Yes** for the irreversible subset (§48.6) |
| **AI Build Agent** | Implement backlog tasks, write tests + docs, keep STATUS/CHANGELOG/OWNER-ACTIONS current, open/refresh PRs, run the build loop. | Claude | Remains Claude; humans review its output | No |
| **Backend engineer** | Control plane, ventures worker, data model + migrations, model gateway, deploy adapters, API contracts (A1–A6, F2–F6). | Claude (proposes) + Owner (approves) | First hire | No (but migrations/prod data = owner gate) |
| **Frontend engineer** | Operator Console, intake wizard, billing UI, gallery-covered components, accessibility (A3/A7/A8, F1/F9). | Claude | Second hire (or shared with backend early) | No |
| **SRE / Security** | SLOs + error budgets, observability, kill-switch drills, incident response, tenant-isolation audit, secret handling, supply-chain (F0/F8, A9, §37/§35). | Claude (proposes) + Owner (holds secrets/approves) | Critical hire before/at GA (A9) | **Partly** — prod secrets, GA approval owner-only |
| **Design** | Design system tokens, console UX, content/voice, brand. | Claude (within existing system) + Owner (brand calls) | Later / contract | Brand identity = owner |

**Reading the table:** today every "Current holder" that isn't "Owner" is **Claude**.
That is the literal staffing. The "Eventual hire" column is the substitution plan: when a
backend engineer joins, they take the backend row's RACI from Claude (who drops to
Consulted/contributor on that workstream), and the owner's gates stay exactly where they are.

---

## 48.4 Hiring order (when the team grows)

Sequenced by where a human removes the most risk or the most owner-bottleneck, not by
generic seniority.

1. **SRE / Security (first or co-first).** The Master Plan treats A9 (multi-tenant security
   hardening) as a *real gate, not a formality*, and §35/§37 set an enterprise bar. An AI can
   draft the hardening; a human must own the security posture, the incident response, and the
   judgment calls before GA. This is the role most dangerous to leave to "Claude + a
   part-time owner."
2. **Backend engineer.** Once autonomy is live (A4+), the control plane, worker durability,
   and adapter correctness become continuous, high-stakes surfaces. A human owner here
   reduces the owner's review load and adds architectural judgment Claude shouldn't make
   alone.
3. **Frontend engineer.** The Operator Console (A8) is the product's face and the heaviest UX
   surface. Splittable from backend once both exist; can be a contractor early.
4. **Design (contract / part-time).** The existing Linear-style design system carries the
   product a long way; dedicated design is a polish/brand investment, not a blocker.

Until each hire lands, **Claude fills the column and the owner holds the gate.** The matrix
in §48.5 is written so the team can grow without redrawing it.

---

## 48.5 RACI matrix across workstreams

**Legend:** **R** = Responsible (does the work) · **A** = Accountable (owns the outcome,
exactly one per row) · **C** = Consulted · **I** = Informed.

**Columns:** *Owner* (the human) · *AI* (Claude, the build agent) · *BE/FE/SRE/Design* =
the eventual hires, shown as their **future** RACI (today those cells collapse into Claude
proposing + Owner accountable).

### 48.5.1 Product & delivery workstreams

| Workstream | Owner | AI (Claude) | Backend | Frontend | SRE/Sec | Design |
|---|---|---|---|---|---|---|
| Vision / scope / roadmap **approval** | **A/R** | C (drafts roadmap, A3) | I | I | I | I |
| Prioritization (pick next backlog item) | A | **R** (per Operating Model) | C | C | C | I |
| Spec authoring (this `spec/` set) | A | **R** | C | C | C | C |
| Definition of done / acceptance sign-off | **A** | R (self-verifies) | C | C | C | I |

### 48.5.2 F-series (enterprise foundations, F0–F10)

| Workstream | Owner | AI (Claude) | Backend | Frontend | SRE/Sec | Design |
|---|---|---|---|---|---|---|
| F0 Observability (Sentry/metrics/tracing) | A · provisions DSNs/secrets | **R** | C | I | **A**→ (post-hire) | I |
| F2 Model gateway (pool/rotation/breaker) | A · provider keys | **R** | **A**→ | I | C | I |
| F1/F3 Sessions & real-time sync | A | **R** | **A**→ | C | C | I |
| F5 Testing & coverage gate | A | **R** | C | C | C | I |
| F6 Migrations (ordered/RLS-checked) | **A · applies migrations** | R (writes them) | **A**→ | I | C | I |
| F8 Supply-chain security (audit/secrets/CodeQL) | A · approves policy | R | C | I | **A**→ | I |
| F1/F9 Design system & a11y | A | R | I | **A**→ | I | **A**→ |

### 48.5.3 A-series (autonomy, A0–A9)

| Workstream | Owner | AI (Claude) | Backend | Frontend | SRE/Sec | Design |
|---|---|---|---|---|---|---|
| A0 Brakes (budgets/kill-switch/checkpoints/audit) | **A** | **R** | C | I | C | I |
| A1 Control plane (data + API) | A · applies migrations | **R** | **A**→ | I | C | I |
| A2 Loop engine (scheduler/tick, stub ACT) | A · provisions Redis/worker | **R** | **A**→ | I | C | I |
| A3 Intake → roadmap | A · **approves roadmap** | **R** | C | R (wizard) | I | C |
| A4 Wire ACT/VERIFY to build engine | A | **R** | **A**→ | I | C | I |
| A5 Deploy adapters (managed + BYO) | **A · connects accounts** | R | **A**→ | I | C | I |
| A6 Sense layer (signals → goals) | A | **R** | **A**→ | C | C | I |
| A7 Central billing & budgets portal | **A · Stripe config** | R | C | **A**→ | I | C |
| A8 Operator Console (24/7 UI) | A | R | C | **A**→ | I | **A**→ |
| A9 Security hardening & GA | **A · approves GA, prod secrets** | R | C | I | **A**→ | I |

### 48.5.4 Infra, security, billing, GTM (cross-cutting)

| Workstream | Owner | AI (Claude) | Backend | Frontend | SRE/Sec | Design |
|---|---|---|---|---|---|---|
| **Infra** — cloud accounts, DNS, Railway/CF services | **A/R** (owns accounts) | C (writes config/IaC) | C | I | **R**→ | I |
| **Infra** — deploy to production | **A** (approves & triggers) | C (prepares + merges per ship rule) | C | I | R→ | I |
| **Security** — secrets / credentials custody | **A/R** (sole holder) | I (never sees them) | I | I | C | I |
| **Security** — threat model / isolation audit | A (accepts risk) | R (drafts/automates) | C | I | **A**→ | I |
| **Billing** — Stripe products/prices/payouts | **A/R** | C (wires config) | C | C | I | I |
| **Billing** — metering & ledger code | A | **R** | **A**→ | C | I | I |
| **GTM** — launch decision / messaging / pricing | **A/R** | C (drafts copy, §51) | I | C | I | C |
| **GTM** — landing page / docs build | A | **R** | C | R | I | C |

> **The pattern to notice:** the owner is **Accountable** on every row that touches money,
> credentials, production, or external commitment, and Claude is **Responsible** on every
> row that is reversible, flag-gated engineering. That split is the §48.6 decision-rights
> rule expressed as a matrix.

---

## 48.6 Decision rights — what only the owner decides

These are **never** delegated to the AI and never inferred from the plan. Per the
[Operating Model](../OPERATING-MODEL.md) "stop and ask" gate and the Master Plan's
checkpoint list (§8), Claude must **STOP and ask** — it does not proceed on any of these:

| Decision class | Examples | Why owner-only |
|---|---|---|
| **Money** | Buying a domain, paying a provider, raising a budget cap, any paid API beyond budget, Stripe payout config. | Irreversible spend; the AI cannot be trusted with the wallet by design (a confused agent must not be able to overspend). |
| **Secrets & accounts** | Provider tokens (Cloudflare/Vercel/Railway/Supabase), Stripe keys, Nango/OAuth credentials, creating new cloud accounts. | Custody is the sharpest security edge; BYO creds live only in Nango, platform secrets only in host env — the AI never holds them. |
| **Production** | First prod deploy of a venture, custom-domain go-live, flipping `VENTURES_ENABLED` on, GA approval (A9), schema migrations against prod data. | Irreversible blast radius on live users / the existing Comic/Chat/Studio product. |
| **Destructive ops** | Deleting a DB/resource/deployment, dropping data, force-pushing production. | No undo. Explicitly listed as always-checkpoint regardless of autonomy level. |
| **External publishing** | Anything that puts the product or the user's brand in public. | Reputational/legal exposure the owner must accept. |
| **Architectural / semantic forks** | A new provider, a schema that breaks an existing table, changes to non-Autopilot surfaces, an ambiguous prod merge conflict. | Not settled by the plan; needs human judgment, not a guess. |
| **Scope changes** | Work materially outside the approved venture roadmap. | Prevents drift and runaway feature invention. |

Everything **else** — in-scope, reversible, flag-gated engineering — is pre-authorized:
*the plan is the authorization to proceed.* Claude builds it without asking. The owner's job
is the gates, not the keystrokes.

---

## 48.7 The Claude continuous-build operating model

This is the day-to-day "how the work happens," lifted from the
[Operating Model](../OPERATING-MODEL.md) and made explicit as a responsibility.

### 48.7.1 The build loop (per work session)

```
 pick next ──► branch ──► implement ──► verify ──► update docs ──► commit ──► PR/ship ──► repeat
 unchecked       │         (small,       (type+      (STATUS +        │         (per the
 task in the     │          reversible,   build+      CHANGELOG +      │          shipping
 first non-done  │          flag-gated)   tests)      OWNER-ACTIONS)   │          rule)
 epic            │                                                     │
                 └──────────── if blocked on an owner decision → STOP & ASK ────┘
```

1. **Orient (cold-start safe):** read STATUS → the current epic → OWNER-ACTIONS → CHANGELOG.
2. **Pick** the first unchecked task in the first non-done, non-blocked epic. **Never skip
   A0→A2 — the brakes ship before the engine.**
3. **Branch** per the task's git rules.
4. **Implement** in small, reversible increments; everything new is flag-gated
   (`VENTURES_ENABLED` default off) and additive.
5. **Verify** before every commit, from `dreamstreamcomicstudio/`:
   `npm run typecheck && npm run build:server && npx vitest run && npm run build`.
6. **Update docs (mandatory):** tick the plan box, refresh STATUS, append CHANGELOG, record
   any owner action in OWNER-ACTIONS.
7. **Commit** with a clear message; open/refresh a draft PR.
8. **Ship** per the owner's shipping rule (§48.8.3).
9. **Repeat** until the epic's acceptance criteria are met, then move to the next epic.

### 48.7.2 Stop-and-ask gates

Claude raises a question (via the question tool) and **does not proceed** when it hits any
owner-only decision (§48.6): an owner-action prerequisite (migration, secret, new account,
a Railway service), a semantic/architectural fork, anything that spends money / touches
production data / changes the existing product's behavior, or an ambiguous prod merge
conflict. Everything else: build it.

### 48.7.3 Definition of done

- **Task:** code + tests written; the four verify commands green; the plan box ticked; docs
  updated (STATUS/CHANGELOG/OWNER-ACTIONS); committed on the branch.
- **Epic:** all boxes ticked; the epic's **acceptance criteria** demonstrably met; STATUS
  shows it ✅ with a one-line proof; CHANGELOG entry; owner actions recorded; PR
  updated/shipped.

A red test suite blocks the commit. New code ships with tests. There is no "done" without
green verify and current docs.

### 48.7.4 Brakes before engine (the safety invariant)

The product's runtime loop (SENSE→ORIENT→DECIDE→ACT→VERIFY→SHIP→REFLECT, governed by
budgets + checkpoints) is the **same shape** as this build loop (pick→implement→verify→ship,
gated by owner decisions) — and that is the point. The guardrails we design for the product
are the guardrails we follow building it:

- `VENTURES_ENABLED` defaults **false**; nothing autonomous runs in prod until A9 GA gating
  and the owner flips it.
- No autonomous loop is wired to real builds/deploys (A4/A5) until A0–A2's brakes are
  shipped and tested.
- Secrets are never committed or printed; BYO creds live only in Nango.
- Never force-push production; never delete/overwrite the owner's data or existing tables.

---

## 48.8 Ways of working

### 48.8.1 Branch strategy

| Branch | Role | Who writes | Rule |
|---|---|---|---|
| `Dreamstrream-v1` | **Production.** Cloudflare Pages builds the frontend from it; Railway builds the backend. | Merged into, never force-pushed | The owner's standing ship-to-production target. Fetch + merge before pushing (it diverges between sessions). |
| Autopilot feature branch (currently `claude/gracious-albattani-bDL8T`) | The Autopilot workstream's active development line. | Claude | All Autopilot work develops here unless the owner says otherwise; draft PR open against it. |

The spec-writing work (this document and its siblings) develops on the feature branch and
follows the same discipline as code: commit per section, keep the tracker current.

### 48.8.2 The mandatory docs discipline (per [AGENTS.md](../../AGENTS.md))

After **any** change, three files are updated — this is non-negotiable and is the entire
reason a two-actor team can hand off cleanly:

1. **STATUS** (`docs/studio/00-STATUS.md` and the autopilot `STATUS.md`) — phase status, next
   step, blockers, "last updated."
2. **CHANGELOG** (`docs/CHANGELOG.md`) — date, what was done, files touched, follow-ups
   (newest first).
3. **OWNER-ACTIONS** (`docs/studio/OWNER-ACTIONS.md`) — every new owner action, deferred
   validation, open decision, or PR (and every resolution) — the owner's resume anchor.

> The whole point of this system: the owner only ever has to read STATUS. **If STATUS is
> stale, the loop is broken** — keeping it current is a P0 responsibility, not a courtesy.

### 48.8.3 PR discipline & the ship-to-production rule

- **PR discipline:** work rides on a draft PR against the feature branch; Claude can
  subscribe to PR activity (CI + reviews) and auto-fix to keep it green; commit messages are
  clear and reference the session.
- **Standing rule — always ship to production.** The owner wants every *completed,
  verified* change pushed straight to production (`Dreamstrream-v1`), not parked on a
  preview branch. After committing + verifying (typecheck, server build, tests, frontend
  build): push the feature branch → fetch `Dreamstrream-v1` and merge it in (resolving
  conflicts faithfully — keep both sides' features, honor the owner's intent on semantic
  conflicts) → fast-forward/merge the work into `Dreamstrream-v1` and push. Never
  force-push production; if a merge is genuinely ambiguous or risky, **pause and ask.**
- **The current-scope nuance:** sub-phases stay on the feature branch until their phase is
  done; an *entire* completed phase merges to production. Everything shipped to prod must be
  **safe-by-default** — new infra-dependent features are flag-gated or no-op until the owner
  configures them, so production behavior is unchanged until the owner enables them. This is
  what makes "always ship" compatible with "the owner holds production": shipped ≠ enabled.

### 48.8.4 Cadence

There are no standups; the team is asynchronous. The cadence is the loop itself: Claude
works continuously across sessions, leaving STATUS + CHANGELOG as the always-current handoff
so the next session (or a future hire) starts cold and correct. The owner reviews in
batches at the gates — checkpoints, migrations, account connections, GA. For PR-driven
continuity, Claude schedules periodic self-check-ins to keep the PR green and the backlog
moving, pausing at the human-gated decisions.

---

## 48.9 Summary

| Question | Answer |
|---|---|
| Who is the team? | One owner + Claude. Everything else is planned structure. |
| Who is Accountable for money/secrets/prod? | The owner — always, never delegated. |
| Who is Responsible for the engineering? | Claude — for in-scope, reversible, flag-gated work. |
| How does work get done? | The build loop: pick→branch→implement→verify→docs→commit→PR→ship, stopping at owner gates. |
| How does the team scale? | Hires (SRE/Security first, then backend, frontend, design) substitute into existing RACI columns — no reorg. |
| What keeps it safe? | Brakes before engine: flag-off by default, additive-only, verify-gated, owner-gated irreversibles, current docs. |

The org will grow; the **safety model will not change.** The human holds the wallet, the
keys, and the production lever; the agent does the reversible work at volume; the docs make
the handoff lossless. That is the team, and it is honest about being small.
