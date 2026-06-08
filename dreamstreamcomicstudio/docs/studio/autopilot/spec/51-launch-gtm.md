# 51 — Launch Plan & GTM

> Part V · Delivery · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan §9–10](../00-MASTER-PLAN.md) (A0–A9 epics, milestones M-A1…M-A5, **A9 GA
> gating**) · [Vision §1.3 positioning](./01-vision-positioning.md) ·
> [Market §2.8 GTM thesis](./02-market-competitive-analysis.md) ·
> [Personas](./03-personas-jtbd.md) · [Value Prop §4.5 messaging](./04-value-proposition.md) ·
> [Pricing §5.3](./05-business-model-pricing.md) · [Metrics §6.4 funnel](./06-metrics-kpis.md)

## 51.1 What this section commits to (and what it doesn't)

This is the launch contract: the **phases** we ship through (private alpha → closed beta →
public beta → GA), the **entry/exit gates** that bind each phase to a real engineering
milestone and the A9 security gate, the **go-to-market motion** that lands and expands, the
**channels and messaging** we use, and the **success criteria, guardrails, and risks** that
decide whether a phase advances or holds.

Two honesty notes carry the whole section:

- **Nothing here moves a launch gate that the product hasn't earned.** A phase advances only
  when its engineering milestone is *shipped* (not specced) and its exit metrics clear the
  bar in [§6.8](./06-metrics-kpis.md). Marketing does not get ahead of the loop. As of this
  spec the autonomy engine is **planned** (Epics A0–A9, nothing built); this plan describes
  *how* we launch it, not a claim that it is launchable today.
- **Pricing and numeric targets are illustrative.** Prices restate the strawman in
  [§5.3](./05-business-model-pricing.md) (owner sets finals); conversion/retention numbers
  restate the *illustrative starting hypotheses* in [§6.4/§6.8](./06-metrics-kpis.md). The
  real contract is the **gate structure** and the **guardrails** (which are at their final
  value — 0 incidents, 100% checkpoint-gated — from the first external user).

## 51.2 The GTM thesis (land and expand)

The thesis is set in [Market §2.8](./02-market-competitive-analysis.md) and the personas in
[§3](./03-personas-jtbd.md); this restates it as the motion we execute.

| Phase of motion | Who | The wedge that lands them | Spec ref |
|---|---|---|---|
| **Land** | Indie hackers / solo devs (**Dev**, P1) | **BYOK + BYO hosting + control + an autonomous teammate** — own keys, own cloud, real code, GitHub sync, multiple concurrent ventures; a single 429 doesn't stop a run | [§3.3](./03-personas-jtbd.md#33-persona-b--dev-the-solo-developer--indie-hacker), [§4.2 Dev](./04-value-proposition.md) |
| **Land (adjacent)** | Non-technical founders (**Maya**, P1) | "Idea in, living product out" + a hard budget so the bill never surprises | [§3.2](./03-personas-jtbd.md), [§4.2 Maya](./04-value-proposition.md) |
| **Expand** | Small teams / agencies (**Sam**, P2) | **BYO client clouds + per-venture billing** — a venture per client on the client's accounts, clean per-client spend reports, provable isolation | [§3.4](./03-personas-jtbd.md#34-persona-c--sam-the-small-team-lead--agency), [§4.2 Sam](./04-value-proposition.md) |
| **Seed** | Existing DreamStream base (**Riley**, P2) + "watch it build itself" demos | Continuity (same account, same billing) + the single most shareable artifact we own: a venture improving *itself* on camera | [§3.5](./03-personas-jtbd.md), [§1.8](./01-vision-positioning.md) |

**Why land with Dev first.** Dev is the *least* trust-sensitive primary persona: BYOK and BYO
hosting mean we ask them to trust their own keys and their own cloud, not ours — the smallest
possible leap of faith for the highest-leverage user. They are also the loudest channel (they
write threads, record demos, file issues) and the most forgiving of rough edges if the core
leverage is real. Maya lands in parallel but converts on a *different* proof — budget safety
and a legible console — so we do not gate her on Dev's polish.

**Why expand to Sam second, not first.** The agency motion needs per-venture BYO Connections,
per-venture budgets/invoices, and provable isolation — i.e. Epics A5 + A7 shipped and the A9
isolation audit clean. We cannot honestly sell "per-client, provably isolated" before the
isolation is audited, so Sam is structurally a post-GA (or GA-coincident) expansion, not a
launch wedge.

**Why the DreamStream base is the seed, not the target.** It is a *small* base ([§2.5](./02-market-competitive-analysis.md):
"we start from DreamStream's small base"), so it cannot be the growth engine — but it is a
warm, zero-CAC pool of users who already trust the account and the billing, ideal for closed
beta (§51.3). The "watch it build itself" demo is the seed's force-multiplier: it is the one
piece of content that *only we* can make truthfully, because only we own the lifecycle loop.

## 51.3 Launch phases & gates

Each phase has an **entry gate** (what must be true to start), an **exit gate** (what must be
true to advance), the **engineering milestone** it rides on, and the **audience + price
surface**. Gates are conjunctive: *all* conditions must hold. The safety guardrails
([§51.7](#517-launch-success-criteria--guardrails)) are entry conditions for **every** phase
from private alpha onward — they are never relaxed for an early stage
([§6.8](./06-metrics-kpis.md): "safety guardrails are already at their final value from
Alpha").

| Phase | Engineering milestone (Master Plan §10) | Audience | Price surface |
|---|---|---|---|
| **Private alpha** | **M-A2** "it builds itself end to end" (A3–A5) | Owner + ≤10 hand-picked Devs (invite-only) | Free; managed-only; tight quotas |
| **Closed beta** | **M-A3** "it keeps improving" (A6) + **M-A4** portal/console (A7–A8) | ~50–150 invited (Dev-heavy + DreamStream base) | Free + BYOK; Pro waitlist; managed preview + checkpointed prod |
| **Public beta** | **M-A5** entry: A9 hardening underway, kill-switch drill + isolation audit *passing* | Open sign-up, flag-gated, no marketing spend | Free / Pro live (BYOK + BYO); "beta" labelled |
| **GA** | **M-A5 complete** — **A9 GA gate cleared** (see §51.4) | Public, marketed | Free / Pro / Team live |

### Private alpha — "does the loop actually own a product?"

- **Entry gate:** M-A2 shipped — an approved venture autonomously builds backlog goals into a
  working `studio_project`, ships a managed preview automatically, and a checkpointed prod
  deploy works (A3 intake/roadmap + A4 real ACT/VERIFY + A5 adapters, [Master Plan A3–A5](../00-MASTER-PLAN.md#9-the-epic--sprint-backlog)).
  `VENTURES_ENABLED` admin-only. All six checkpoints enforced; global kill switch tested.
- **Goal:** falsify (or confirm) the core bet — that the loop is a *durable owner*, not a
  one-shot builder that stalls in week two ([§4.3 Pillar 1](./04-value-proposition.md);
  [§6.2](./06-metrics-kpis.md)). Watch the loop survive restarts and budget breaches in the
  wild, with real users' messy ideas.
- **Exit gate:** North Star **WSHI/AU ≥ 1** (it ships *at all*, [§6.8](./06-metrics-kpis.md));
  budget overruns = 0; cross-tenant incidents = 0; 100% of prod deploys checkpoint-gated; at
  least 3 of ~10 alphas have a venture that shipped a healthy improvement in week 2 (the
  anti-stall proof). Stuck-rate measured (no cap yet).

### Closed beta — "is it trustworthy and economic, with a real console?"

- **Entry gate:** M-A3 (A6 sense layer — a runtime error becomes a fix goal that ships) + M-A4
  (A7 billing portal + A8 Operator Console) shipped. BYOK path verified-free in the ledger
  ([§5.2](./05-business-model-pricing.md)). Spend alerts (80%/100%) wired to in-app + email.
- **Goal:** prove the *governed economics* and the *operator experience* — that users can watch,
  approve, pause, and budget from one screen, and that BYOK collapses model COGS to ~0
  ([§4.3 Pillar 3](./04-value-proposition.md)). First real read on activation funnel drop-off.
- **Exit gate:** **WSHI/AU ≥ 3**; first-deploy→first-autonomous-improvement ≥ 45%; TTFD median
  < 30 min; stuck-rate ≤ 15%; gross margin per plan ≥ 0; W4 account retention ≥ 35%; all
  safety guardrails at 0/100% ([§6.8](./06-metrics-kpis.md) Beta column). Qualitative: ≥ 60% of
  beta users say the console made them feel "in control" (the trust signal, [§1.6 M5](./01-vision-positioning.md)).

### Public beta — "does it hold up open to the world (before we spend on marketing)?"

- **Entry gate:** A9 hardening *in progress* with the **kill-switch drill passing** and the
  **tenant-isolation audit passing** ([Master Plan A9](../00-MASTER-PLAN.md#epic-a9--multi-tenant-security-hardening--ga)).
  Abuse/anomaly auto-pause live (spend spikes, runaway loops, suspicious egress). Open sign-up
  behind `VENTURES_ENABLED` plan-gating; **no paid acquisition yet** — public beta is a
  load-and-trust test, not a growth push.
- **Goal:** harden under real, uninvited load and abuse; validate self-serve onboarding without
  a human in the loop; confirm guardrails hold against adversarial users (not just friendly
  betas).
- **Exit gate:** all GA exit metrics in reach (trending to [§6.8](./06-metrics-kpis.md) GA
  column); guardrails = 0/100% under open load; abuse attempts blocked (trended, all blocked);
  p95 API latency ≤ 2.5s and 5xx ≤ 1% under load ([§6.5](./06-metrics-kpis.md)); the full A9
  security review queued/scheduled.

### GA — "secure, marketed, sold"

- **Entry gate:** the **A9 GA gate cleared** (§51.4). Team tier + per-venture BYO + invoices
  live (the Sam expansion). Pricing finalized by owner. Runbooks + incident response ([§50](./50-runbooks.md)) live.
- **Goal:** open the marketed funnel, turn on the land-and-expand motion at full channel breadth.
- **Exit gate:** GA is the steady state; we hold here. Post-GA we ratchet targets (WSHI/AU ≥ 5,
  W4 retention ≥ 50%, [§6.8](./06-metrics-kpis.md)) and watch guardrails. A guardrail breach
  *post-GA* triggers the rollback posture in §51.7, not a phase regression by default.

## 51.4 The A9 GA gate (the hard gate)

GA is the **only** phase whose gate is an external, adversarial review — because GA is where
we tell the world "secure" and turn on marketing. This restates the A9 acceptance bar
([Master Plan A9](../00-MASTER-PLAN.md#epic-a9--multi-tenant-security-hardening--ga)) as a
launch gate; **all must pass** before any GA announcement:

| A9 GA condition | What proves it | Source |
|---|---|---|
| **No cross-tenant leak** | Automated isolation test + `get_advisors` clean; RLS coverage across all `venture_*` + `studio_*` tables | [§6.3.3](./06-metrics-kpis.md), [§35](./35-security-threat-model.md) |
| **No secret exposure** | BYO creds only in Nango; nothing sensitive in DB/logs/client bundle | [§5.2](./05-business-model-pricing.md), [§36](./36-privacy-compliance.md) |
| **No uncapped spend path** | Budget evaluator + account cap + kill switch; a confused agent cannot exceed the cap | [§4.3 Pillar 4](./04-value-proposition.md) |
| **Kill-switch drill passes** | Scheduled drill halts the fleet within SLA (100%) | [§6.3.3](./06-metrics-kpis.md) |
| **Full code-safety scan live** | Committed-secret + dangerous-op + dep audit + secret scanning on pushes | Master Plan A9 |
| **External security review clean** | `/security-review` of the whole `venture_*` surface; owner reviews + approves GA | Master Plan A9 owner action |

**Marketing-readiness corollary.** GA messaging in §51.5 leans hard on "autonomy you can
actually trust" and "provably isolated per client." Per the honesty rule in
[§4.6/§4.7](./04-value-proposition.md), we **may not make those claims publicly until this
gate is green.** The security gate is therefore also the *messaging* gate.

## 51.5 Positioning & messaging pillars

Positioning is fixed in [§1.3](./01-vision-positioning.md): *for founders and builders, an
always-on autonomous product studio that plans/builds/deploys/improves 24/7 with hard budgets
and human checkpoints — unlike one-shot builders and hosted-only sandboxes — because it owns
the whole loop on your cloud, on any model, billed in one place, with governance built in.*

The launch picks from the [§4.5](./04-value-proposition.md) messaging pillars per audience and
per phase. We lead with **ambition for Maya** and **control for Dev**, and we **never lead with
governance until the governance is shipped and audited**.

| Pillar (from §4.5) | Lead audience | Phase it's allowed to lead | Honesty constraint |
|---|---|---|---|
| **"Idea in. Living product out."** | Maya | Closed beta → GA | Only once a managed preview reliably ships (M-A2) |
| **"Your cloud. Your keys. Your code. Our agents."** | Dev | Private alpha → GA | BYOK/BYO must be live and verified-free (A5, [§5.2](./05-business-model-pricing.md)) |
| **"An autonomous product team that never sleeps — and never overspends."** | Maya, Sam | Closed beta → GA | Requires budgets + spend meter shipped (A0/A7) |
| **"Autonomy you can actually trust — budgets, checkpoints, audit, kill-switch."** | Dev, Sam, Ops | **GA only** | Gated on the A9 review (§51.4) — do not claim "trust"/"secure" before it |
| **"From one-shot builder to lifelong product owner."** | All | Public beta → GA | The category claim; needs the sense loop (A6) so "lifelong" is true |

**Anti-messaging (the honesty box, [§4.7](./04-value-proposition.md)).** Launch comms must
*not* claim: fully-autonomous/no-human, "build any software" (scope is web apps / landing /
simple SaaS), best/cheapest code-gen model, more polished than Lovable/v0 today, that we host
LLMs/GPUs, or enterprise-compliant (SSO/SOC2). Every "planned" capability is labelled
*planned* in public materials until shipped — the same discipline the spec uses internally.

## 51.6 Channels

No paid acquisition until public-beta exit; the early phases are **earned + owned + warm**.

| Channel | Motion | Primary persona | First active phase |
|---|---|---|---|
| **"Watch it build itself" demos** | The signature artifact — a venture taking an idea → roadmap → live URL → fixing its own runtime error, on camera. Short clips + a long unedited stream. | Dev, Maya | Private alpha (internal) → closed beta (shared) |
| **Content & teardowns** | Honest build-in-public posts, the spec itself as a credibility asset, "we shipped X autonomously" logs, economics teardown (BYOK vs bundled). | Dev | Closed beta |
| **Developer communities** | Indie/solo-dev forums, BYOK/agent communities, Show-and-tell posts; founder answers issues in public. | Dev | Closed beta → public beta |
| **Existing DreamStream base** | In-app banner + email to current users; same account, same billing; warm, zero-CAC. | Riley, Maya | Closed beta (seed cohort) |
| **Word-of-mouth / referral** | "Looks like a team of five" is inherently shareable; referral credits (top-up CT grant) at GA. | Dev, Sam | Public beta → GA |
| **Integrations & marketplaces** | Listings where BYO providers/tools live (Cloudflare/Vercel/Supabase/Railway ecosystems via Nango; MCP tool/marketplace surface). | Dev, Sam | GA |
| **Founder-led / agency outreach** | Direct to small agencies for the per-client motion once isolation is audited. | Sam | GA |

**Channel→persona→pillar coherence.** Demos and dev communities carry "your cloud, your keys,
your code"; the DreamStream base and email carry "idea in, living product out"; GA marketplaces
and agency outreach carry "provably isolated, billed per client." We do not run a channel whose
message the product can't yet back (e.g. no agency outreach before the A9 isolation audit).

## 51.7 Launch success criteria & guardrails

Success at each phase is the **exit gate** (§51.3) plus the **guardrails**, which are the
must-not-regress floor from [§6.5](./06-metrics-kpis.md). A guardrail breach **blocks the next
phase regardless of how good the headline numbers look**, and post-GA triggers the rollback
posture below.

| Guardrail | Threshold (from §6.5) | Effect on launch |
|---|---|---|
| Budget overruns | **0** | Any overrun → hold the phase; root-cause before advancing |
| Cross-tenant incidents | **0** | One leak → immediate halt; existential for a multi-tenant launch |
| Prod deploys not checkpoint-gated | **0** | Any ungoverned prod deploy → halt + audit |
| Gross margin per plan | **≥ 0** (target band per plan) | Negative margin at a plan → fix pricing/COGS before public marketing |
| p95 API latency / 5xx | ≤ 2.5s / ≤ 1% (warn) per [alerting-thresholds](../../../production/alerting-thresholds.md) | Sustained breach → hold public beta / GA |
| Provider error rate (F1) | breaker-open trended, no silent failure | Degraded models = bad ships → hold |
| Rework rate | not rising as throughput rises | Rising → shipping faster but worse; hold and fix |

**Rollback / hold posture.** The launch has the same brakes as the product:

- **Per-phase hold:** any exit-gate metric short of bar → stay in the phase, no announcement.
- **Flag rollback:** `VENTURES_ENABLED` returns to admin-only (closes self-serve sign-up
  instantly) without touching existing ventures ([§1.8](./01-vision-positioning.md): additive,
  flag-gated).
- **Global kill switch:** `VENTURES_KILL` halts every venture fleet-wide — the nuclear option
  for a safety incident, drilled before public beta (§51.4).

## 51.8 Activation & onboarding goals

The launch funnel *is* the activation funnel in [§6.4](./06-metrics-kpis.md). Onboarding's job
is to move a stranger to a self-improving venture, and the launch optimizes the steps that leak.

| Funnel step (§6.4) | Onboarding goal at launch | Illustrative target (§6.4/§6.8) |
|---|---|---|
| Visit → intake started | Intake feels smart on the first idea (Maya's adopt trigger, [§3.9](./03-personas-jtbd.md)) | 25% (visit→intake); 12%→15% visit→approved-roadmap (beta→GA) |
| Intake → approved roadmap | A roadmap the user can read and approve in one pass (human-trust gate) | 60% |
| Roadmap → first build green | The loop produces a passing build fast | 85% |
| First build → first live deploy | A real URL the user owns; the "it shipped" moment ([§1.6 M3](./01-vision-positioning.md)) | 75% |
| First deploy → first autonomous improvement | **The make-or-break step** — it fixes/improves itself once, unattended | 50%; TTFD median < 30 min (beta) → < 15 min (GA) |

**Onboarding success criteria.** A launched user is *activated* when they hit step 5 — a first
healthy, loop-originated shipped goal — because that is the truest read on the core promise
"it keeps improving" ([§6.4](./06-metrics-kpis.md)). Per-persona, activation completes when:
Maya has approved a roadmap and seen a live URL under a budget she set; Dev has connected a key
and a cloud and walked away to a green build + PR; Sam has spun a per-client venture on the
client's account ([§3.9](./03-personas-jtbd.md)). We instrument drop-off *reasons* at each step
(intake abandoned, roadmap rejected, budget too low to deploy) so onboarding fixes target the
real leak, not a vanity number.

## 51.9 Risks & mitigations

The launch-specific risks are concentrated in three categories the spec already names — trust,
reliability at first contact, and abuse ([§2.1](./02-market-competitive-analysis.md),
[§2.5](./02-market-competitive-analysis.md), [§4.6](./04-value-proposition.md),
[Master Plan §11](../00-MASTER-PLAN.md#11-risks--honest-caveats)).

| Risk | Why it bites *at launch* | Mitigation | Owner |
|---|---|---|---|
| **Trust — "I won't let an agent touch prod / my card"** | First-contact autonomy is scary; one bad story spreads | Land with Dev (own keys/cloud = smallest leap); checkpoints on all 6 irreversibles; visible budget meter; the Operator Console's transparency is the headline demo, not a footnote | GTM + A8 |
| **Reliability at launch — a public stall/flake** | The exact failure we exist to beat ([§3.2](./03-personas-jtbd.md)) playing out in public | Gate public beta on F1 provider key-pool/failover; no-progress detector raises a checkpoint, never loops; p95/5xx guardrails block advance; private alpha invite-only to absorb the roughest edges | Eng + Ops |
| **Abuse — free-tier mining, runaway loops, malicious egress** | Open sign-up (public beta) invites adversarial users | Free is *managed-cost-bounded* (1 venture, 1 tick, preview-only, [§5.3](./05-business-model-pricing.md)); daily guardrail CT; A9 abuse/anomaly auto-pause; global concurrency cap + kill switch | Ops + A9 |
| **Overspend on managed hosting** | We front provider cost; a launch spike could hurt margin | Budgets are A0 (before the engine); managed quotas tight; push real prod to BYO; gross-margin guardrail blocks public marketing if negative | Ops + Owner |
| **Marketing gets ahead of the product** | Tempting to claim "secure/trust" pre-A9 | Messaging gate = A9 gate (§51.4/§51.5); every "planned" capability labelled in public; under-promise rule from [§4.7](./04-value-proposition.md) | GTM + Owner |
| **Distribution — small starting base** | Incumbents have audiences; we start small ([§2.5](./02-market-competitive-analysis.md)) | Seed from DreamStream base + the unique "watch it build itself" demo; earned/community channels before paid; referral at GA | GTM |
| **Polish gap vs Lovable/v0** | We're honestly behind on build-loop polish ([§2.5](./02-market-competitive-analysis.md)) | Compete on economics + governance + lifecycle, not polish parity; invite-only alpha buys time to close the gap (F/A series) | Eng + GTM |

## 51.10 Pre-launch checklist

Phase-gated; an item is "done" only when verifiable (a passing test, a live dashboard, a
cleared review), per the spec's acceptance-gated house style.

**Before private alpha (M-A2)**
- [ ] A3–A5 shipped: intake→roadmap, real ACT/VERIFY build, managed + BYO deploy adapters.
- [ ] All 6 checkpoints enforced; first-prod-deploy checkpoint verified.
- [ ] `venture_budgets` hard pause verified; global kill switch tested.
- [ ] `venture_events` audit trail populated; Operator dashboard ([§6.7.1](./06-metrics-kpis.md)) live.
- [ ] North Star + funnel events emitting (`intake.started` … `goal.shipped`).
- [ ] Invite list (~10 Devs) + a feedback channel; alpha NDA/expectations set.

**Before closed beta (M-A3 + M-A4)**
- [ ] A6 sense loop: an injected runtime error → fix goal → healthy ship, demonstrated.
- [ ] A7 portal: per-venture spend, budget sliders, top-up, 80%/100% alerts (in-app + email).
- [ ] A8 console: live stream, roadmap board, approval queue, pause/resume/kill — desktop + mobile.
- [ ] BYOK verified-free in the ledger ([§5.2](./05-business-model-pricing.md)); BYO connect flow works.
- [ ] Business dashboard ([§6.7.1](./06-metrics-kpis.md)) live with activation funnel + drop-off reasons.
- [ ] DreamStream in-app banner + email drafted (not sent until cohort selected).

**Before public beta (M-A5 entry)**
- [ ] A9 abuse/anomaly auto-pause live; tenant-isolation audit **passing**; kill-switch drill **passing**.
- [ ] Free tier hard-bounded (1 venture, 1 tick, preview-only, daily CT guardrail).
- [ ] Reliability dashboard live; p95/5xx + per-provider breaker thresholds wired to real alerts.
- [ ] Self-serve onboarding works with no human in the loop; "beta" labelling on all surfaces.
- [ ] Incident runbook + on-call ([§50](./50-runbooks.md)) live; rollback posture (§51.7) rehearsed.

**Before GA (A9 GA gate, §51.4)**
- [ ] External `/security-review` of the `venture_*` surface **clean**; owner approves GA.
- [ ] No cross-tenant leak / no secret exposure / no uncapped spend path — all proven.
- [ ] Team tier + per-venture BYO + invoices live (Sam expansion); pricing finalized by owner.
- [ ] GA messaging cleared against the honesty rules ([§4.7](./04-value-proposition.md)); "trust/secure" claims now permitted.
- [ ] Referral/credit-grant mechanics live; marketplace/integration listings prepared.
- [ ] Go-live checklist (`go-live-checklist.md`) green; CHANGELOG + STATUS updated.

---

**Net:** we launch the way the product runs — **brakes before engine**. Each phase rides a real
milestone (M-A2 → M-A5), each gate is conjunctive and includes the safety guardrails at their
final value, and **GA is gated on an external security pass that is simultaneously the gate on
our "trust/secure" messaging.** The motion lands with Devs on BYOK + control, seeds from the
DreamStream base and the "watch it build itself" demo, and expands to agencies on per-client
BYO + provable isolation — never claiming, in public, a capability the loop hasn't shipped and
the audit hasn't cleared.

*Next: [52 — Appendix A: configuration & env var reference](./52-appendix-config.md). Upstream:
[01 positioning](./01-vision-positioning.md) · [02 §2.8 GTM](./02-market-competitive-analysis.md) ·
[04 §4.5 messaging](./04-value-proposition.md) · [05 §5.3 pricing](./05-business-model-pricing.md) ·
[06 §6.4/§6.8 funnel & targets](./06-metrics-kpis.md) · [Master Plan §9–10](../00-MASTER-PLAN.md).*
