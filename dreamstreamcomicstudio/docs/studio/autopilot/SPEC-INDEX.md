# Code Studio Autopilot — Master Product Specification (SPEC-INDEX)

> **What this is.** The index + progress tracker for the **ultra-comprehensive product
> specification** (~200 pages) of Code Studio Autopilot — the always-on autonomous product
> studio built on top of DreamStream. Each section is its own file under
> [`spec/`](./spec/). This index is the source of truth for *what's written* and *what's
> left*. The build loop writes the next unwritten section in full depth, ticks it here, and
> commits.

**Last updated:** 2026-06-07 · **Branch:** `claude/gracious-albattani-bDL8T`

## How to use / how the loop works
1. Open this index → find the first section not marked ✅.
2. Read its brief, read the canon docs (below), write the section file in **full depth**.
3. Tick it here, update [`STATUS.md`](./STATUS.md) + [`../CHANGELOG.md`](../CHANGELOG.md),
   commit + push to the branch. Repeat until every section is ✅.

## Canon (read before writing any section — keep everything consistent)
- Locked decisions: **hybrid hosting** (managed preview + BYO via Nango), **generalize the
  studio** (idea → web app/SaaS), **continuous autonomy + checkpoints + budgets**, **extend
  this repo**.
- Architecture canon: [`ARCHITECTURE-CLOUDFLARE.md`](./ARCHITECTURE-CLOUDFLARE.md) —
  **Workers + Durable Objects + Workflows + Containers**.
- Plan canon: [`00-MASTER-PLAN.md`](./00-MASTER-PLAN.md) (A0–A9) +
  [`F-ENTERPRISE-FOUNDATIONS.md`](./F-ENTERPRISE-FOUNDATIONS.md) (F0–F10).
- Existing product reality: [`../02-CURRENT-STATE.md`](../02-CURRENT-STATE.md),
  [`../06-DATA-MODEL.md`](../06-DATA-MODEL.md), [`../AGENTS.md`](../AGENTS.md).
- **Terminology:** *Venture* (a product the agents own), *Goal* (backlog item), *Run*/*Tick*
  (loop session/pass), *Checkpoint* (human approval), *Budget*, *Connection* (BYO account),
  *Adapter* (deploy provider), *Operator Console* (the 24/7 UI), *UserCoordinatorDO* /
  *VentureDO* (Durable Objects).
- **House style:** honest (mark shipped vs planned), file-referenced, acceptance-gated,
  enterprise bar. No filler.

## Progress
**Sections complete: 24 / 55** · target ~200 pages. (Parts I + II complete; Part III underway.)

Legend: ✅ written · ✍️ in progress · 📋 planned

### Part I — Product & Strategy
| # | Section | File | Status |
|---|---|---|---|
| 00 | Executive summary | [spec/00-executive-summary.md](./spec/00-executive-summary.md) | ✅ |
| 01 | Vision, mission & positioning | [spec/01-vision-positioning.md](./spec/01-vision-positioning.md) | ✅ |
| 02 | Market & competitive analysis | [spec/02-market-competitive-analysis.md](./spec/02-market-competitive-analysis.md) | ✅ |
| 03 | Personas & jobs-to-be-done | [spec/03-personas-jtbd.md](./spec/03-personas-jtbd.md) | ✅ |
| 04 | Value proposition & differentiation | [spec/04-value-proposition.md](./spec/04-value-proposition.md) | ✅ |
| 05 | Business model & pricing | [spec/05-business-model-pricing.md](./spec/05-business-model-pricing.md) | ✅ |
| 06 | Success metrics, KPIs & North Star | [spec/06-metrics-kpis.md](./spec/06-metrics-kpis.md) | ✅ |
| 07 | Assumptions, constraints & risks | [spec/07-assumptions-risks.md](./spec/07-assumptions-risks.md) | ✅ |

### Part II — Product Definition
| # | Section | File | Status |
|---|---|---|---|
| 08 | Product principles & design tenets | [spec/08-principles-tenets.md](./spec/08-principles-tenets.md) | ✅ |
| 09 | Domain model & glossary | [spec/09-domain-model-glossary.md](./spec/09-domain-model-glossary.md) | ✅ |
| 10 | Feature catalog (epics → features) | [spec/10-feature-catalog.md](./spec/10-feature-catalog.md) | ✅ |
| 11 | End-to-end user journeys | [spec/11-user-journeys.md](./spec/11-user-journeys.md) | ✅ |
| 12 | Information architecture & navigation | [spec/12-information-architecture.md](./spec/12-information-architecture.md) | ✅ |
| 13 | UX spec: intake & onboarding | [spec/13-ux-intake-onboarding.md](./spec/13-ux-intake-onboarding.md) | ✅ |
| 14 | UX spec: Operator Console (24/7 workspace) | [spec/14-ux-operator-console.md](./spec/14-ux-operator-console.md) | ✅ |
| 15 | UX spec: build / iterate / preview | [spec/15-ux-build-iterate-preview.md](./spec/15-ux-build-iterate-preview.md) | ✅ |
| 16 | UX spec: approvals, checkpoints & notifications | [spec/16-ux-approvals-notifications.md](./spec/16-ux-approvals-notifications.md) | ✅ |
| 17 | UX spec: billing & account | [spec/17-ux-billing-account.md](./spec/17-ux-billing-account.md) | ✅ |
| 18 | UX spec: integrations & connections | [spec/18-ux-integrations.md](./spec/18-ux-integrations.md) | ✅ |
| 19 | Mobile experience | [spec/19-mobile.md](./spec/19-mobile.md) | ✅ |
| 20 | Accessibility (WCAG) spec | [spec/20-accessibility.md](./spec/20-accessibility.md) | ✅ |
| 21 | Content, voice & persona guidelines | [spec/21-content-voice.md](./spec/21-content-voice.md) | ✅ |

### Part III — Architecture
| # | Section | File | Status |
|---|---|---|---|
| 22 | System architecture overview | [spec/22-system-architecture.md](./spec/22-system-architecture.md) | ✅ |
| 23 | Cloudflare topology (DO/Workflows/Containers) — deep | spec/23-cloudflare-topology.md | ✍️ |
| 24 | The autonomous engine (the loop) — deep | spec/24-autonomous-engine.md | ✍️ |
| 25 | Multi-tenancy & isolation | [spec/25-multitenancy-isolation.md](./spec/25-multitenancy-isolation.md) | ✅ |
| 26 | Data model & schema (all tables + RLS) | spec/26-data-model-schema.md | ✍️ |
| 27 | API surface — REST | spec/27-api-rest.md | ✍️ |
| 28 | API surface — realtime & events | spec/28-api-realtime-events.md | ✍️ |
| 29 | AI/model gateway (providers, routing, reliability) | spec/29-model-gateway.md | 📋 |
| 30 | Integrations framework (Nango + MCP + webhooks) | spec/30-integrations-framework.md | 📋 |
| 31 | Deploy adapters (managed + BYO) | spec/31-deploy-adapters.md | 📋 |
| 32 | Storage & file management | spec/32-storage.md | 📋 |
| 33 | Sessions & identity architecture | spec/33-sessions-identity.md | 📋 |
| 34 | Real-time & sync architecture | spec/34-realtime-sync.md | 📋 |

### Part IV — Non-functional / Foundations
| # | Section | File | Status |
|---|---|---|---|
| 35 | Security architecture & threat model | spec/35-security-threat-model.md | 📋 |
| 36 | Privacy, compliance & data governance | spec/36-privacy-compliance.md | 📋 |
| 37 | Reliability & SRE (SLOs, error budgets) | spec/37-reliability-sre.md | 📋 |
| 38 | Observability (logs/metrics/traces/alerts) | spec/38-observability.md | 📋 |
| 39 | Performance & scalability | spec/39-performance-scalability.md | 📋 |
| 40 | Cost model & FinOps | spec/40-cost-finops.md | 📋 |
| 41 | Billing & metering architecture | spec/41-billing-metering.md | 📋 |
| 42 | Disaster recovery & backups | spec/42-disaster-recovery.md | 📋 |
| 43 | Quality & testing strategy | spec/43-testing-strategy.md | 📋 |
| 44 | CI/CD & release management | spec/44-cicd-release.md | 📋 |

### Part V — Delivery
| # | Section | File | Status |
|---|---|---|---|
| 45 | Foundations backlog F0–F10 (detailed) | spec/45-foundations-backlog.md | 📋 |
| 46 | Autonomy backlog A0–A9 (detailed) | spec/46-autonomy-backlog.md | 📋 |
| 47 | Roadmap, milestones & sequencing | spec/47-roadmap.md | 📋 |
| 48 | Team, RACI & ways of working | spec/48-team-raci.md | 📋 |
| 49 | Owner actions & external dependencies | spec/49-owner-actions.md | 📋 |
| 50 | Runbooks & operational procedures | spec/50-runbooks.md | 📋 |
| 51 | Launch plan & GTM | spec/51-launch-gtm.md | 📋 |
| 52 | Appendix A: configuration & env var reference | spec/52-appendix-config.md | 📋 |
| 53 | Appendix B: decision log (ADRs) | spec/53-appendix-decisions.md | 📋 |
| 54 | Appendix C: data dictionary | spec/54-appendix-data-dictionary.md | 📋 |
