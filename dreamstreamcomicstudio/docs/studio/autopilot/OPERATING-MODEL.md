# Autopilot — Operating Model (how Claude builds this, continuously)

> This is the contract for **how the AI (Claude) executes the
> [Master Plan](./00-MASTER-PLAN.md) backlog continuously** — so building Autopilot is
> itself a safe, resumable, never-lost loop. It mirrors the existing studio working rules
> ([`../AGENTS.md`](../AGENTS.md)) and adds the autonomy-specific guardrails.

## The build loop (per work session)

```
 pick next ──► branch ──► implement ──► verify ──► update docs ──► commit ──► PR/ship ──► repeat
 unchecked       │          (small,      (type+      (STATUS +       │          (per the
 task in the     │           reversible,  build+      CHANGELOG +     │          shipping
 first non-done  │           flag-gated)  tests)      OWNER-ACTIONS)  │          rule)
 epic (A0→A9)    │                                                    │
                 └──────────── if blocked on an owner decision → STOP & ASK ────┘
```

1. **Orient** (cold-start safe): read [`STATUS.md`](./STATUS.md) → the Master Plan's
   current epic → [`../OWNER-ACTIONS.md`](../OWNER-ACTIONS.md) → [`../CHANGELOG.md`](../CHANGELOG.md).
2. **Pick** the first unchecked task in the first non-done, non-blocked epic. **Never skip
   A0→A2** — the brakes ship before the engine.
3. **Branch** per the task's git rules (this workstream develops on
   `claude/gracious-albattani-bDL8T` unless the owner says otherwise).
4. **Implement** in small, reversible increments. Everything new is **flag-gated**
   (`VENTURES_ENABLED` default off) and **additive** (no behavior change for existing users
   until explicitly enabled).
5. **Verify** before every commit, from `dreamstreamcomicstudio/`:
   ```
   npm run typecheck && npm run build:server && npx vitest run && npm run build
   ```
   New code ships with tests. A red suite blocks the commit.
6. **Update docs** (mandatory): tick the task box in the Master Plan, refresh
   [`STATUS.md`](./STATUS.md), append to [`../CHANGELOG.md`](../CHANGELOG.md), and add any
   new owner action/deferred validation to [`../OWNER-ACTIONS.md`](../OWNER-ACTIONS.md).
7. **Commit** with a clear message; **open/refresh a draft PR**.
8. **Ship** per the owner's shipping rule (see *Shipping* below).
9. **Repeat** until the epic's acceptance criteria are met, then move to the next epic.

## When Claude must STOP and ask (don't guess)

These are the *human's* calls — raise them via the question tool, don't proceed:
- Any **owner action** in the Master Plan §12 / `OWNER-ACTIONS.md` that's a prerequisite
  (migrations, secrets, new accounts, a Railway service).
- A **semantic/architectural** fork not settled by the plan (e.g. a new provider, a schema
  that breaks an existing table, a change to non-Autopilot surfaces).
- Anything that would **spend money**, **touch production data**, or **change the existing
  Comic/Chat/Studio product's behavior** for live users.
- A merge conflict on production that isn't a faithful both-sides keep.

Everything else: **build it.** The plan is the authorization to proceed on in-scope,
reversible, flag-gated engineering.

## The two loops are mirror images (and that's the point)

Autopilot's *runtime* loop (SENSE→ORIENT→DECIDE→ACT→VERIFY→SHIP→REFLECT, governed by
budgets + checkpoints) is the same shape as *this* build loop (pick→implement→verify→ship,
gated by owner decisions). The guardrails we design for the product are the guardrails we
follow building it: **brakes before engine, small reversible steps, durable state in docs,
stop at the human-gated decisions.**

## Definition of done (per task / per epic)

- **Task:** code + tests written; the four verify commands green; the Master Plan box
  ticked; docs updated; committed on the branch.
- **Epic:** all task boxes ticked; the epic's **acceptance criteria** demonstrably met;
  STATUS shows it ✅ with a one-line proof; CHANGELOG entry; owner actions (if any) recorded;
  PR updated/shipped.

## Safety defaults (non-negotiable while building)

- `VENTURES_ENABLED` defaults **false**; nothing autonomous runs in prod until A9 GA gating
  and the owner flips it.
- No autonomous loop is wired to real builds/deploys (A4/A5) until A0–A2's brakes are
  shipped and tested.
- Secrets are never committed or printed; BYO creds live only in Nango.
- Never force-push production. Never delete/overwrite the owner's data or existing tables.

## Running it "constantly"

The owner can have Claude carry this backlog forward across sessions:
- Each session: orient → pick the next unchecked task → ship → repeat, leaving STATUS +
  CHANGELOG as the always-current handoff so the next session starts cold and correct.
- For PR-driven continuity, Claude can **subscribe to PR activity** (CI + reviews) and
  auto-fix/iterate, and schedule periodic self-check-ins to keep the PR green and the
  backlog moving — pausing at the human-gated decisions above.

> The whole point: the owner only ever has to read [`STATUS.md`](./STATUS.md). If it's
> stale, the loop is broken — keep it current.
