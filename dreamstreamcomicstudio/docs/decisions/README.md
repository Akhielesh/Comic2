# Architecture Decision Records (ADRs)

Each ADR captures one significant decision: the context, the choice, and the
consequences. ADRs make the *why* durable so future work (human or AI) doesn't
relitigate settled questions or accidentally undo them.

## Format

Copy `0000-template.md` to a new numbered file. Sections:

- **Status:** Proposed | Accepted | Superseded by NNNN
- **Context:** the forces at play, constraints, what prompted the decision.
- **Decision:** what we chose, stated plainly.
- **Consequences:** trade-offs, follow-ups, what this rules in/out.

Rules:
- Numbers are sequential and never reused.
- An `Accepted` ADR is immutable. To change course, write a new ADR and mark the
  old one `Superseded by NNNN` (and link forward).

## Index

| # | Title | Status |
|---|-------|--------|
| 0001 | OpenRouter gateway + BYOK as the AI control plane | Accepted |
| 0002 | Remove pricing/billing UI; keep billing backend dormant | Accepted |
| 0003 | Multi-key API configuration + per-key usage limits | Proposed |
