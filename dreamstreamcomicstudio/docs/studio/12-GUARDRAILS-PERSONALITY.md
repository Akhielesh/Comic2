# 12 — Guardrails & Personality

How the platform stays safe, accurate, and on-brand — current state and the plan to make
it coherent and enterprise-grade.

## Current state (what exists)

### Guardrails that exist ✅
- **Anti-fabrication chat persona** (`server/src/ai/chat.ts` `CHAT_SYSTEM_PROMPT` + the
  "LIVE TOOLS" block): be accurate, call a tool for anything factual, never invent
  prices/specs/links, be honest on tool failure, don't loop the same empty search.
- **Context sanitization** (`server/src/ai/assistantPolicy.ts`): the DreamStream
  connector context is allowlist-sanitized — `SENSITIVE_KEY_PATTERN` strips tokens/keys/
  emails/billing/PII; depth/length/array caps; numbers-only for stat maps.
- **Universal Assistant scoping:** `isPlatformScopedMessage` + `buildOffTopicResponse`
  keep the in-app assistant to platform topics (off-topic → redirect).
- **Source/provider governance** (`services/sourceGovernance.ts`): users disable any AI
  provider; enforced client + server (`X-Allowed-Sources`) — even platform keys.
- **MCP SSRF guard** (`mcpClient.isSafeMcpUrl`): https-only, blocks private/loopback.
- **Tool allowlisting:** swarm agents + custom agents can only use allowlisted tools; no
  recursive swarm; the read-only connector "cannot create/edit/delete".
- **Usage/billing guards:** `usageEnforcer` reserves/settles; free-only mode never falls
  back to a paid model silently.

### Personality that exists ⚠️ (fragmented)
- The chat persona ("DreamStream Chat") is strong but lives only in `chat.ts`.
- Each swarm agent has its **own ad-hoc** persona prompt (`registry.ts`).
- The Universal Assistant has a different platform-scoped voice.
- The prompt-enhancer/memory have their own system prompts.
- → **No single source of brand voice.** Tone/formatting can drift between surfaces.

## Honest gaps
- **No unified persona** → inconsistent voice across chat / swarm / assistant / studio.
- **No output-level guardrail layer** → relies on prompt instructions only; no
  post-generation checks (e.g., "claimed a price with no tool call", "emitted a private
  URL", "unsafe code"), and no critic stage in the swarm.
- **No safety policy for generated/executed code** (Studio): arbitrary AI code runs in the
  container — isolation handles infra risk, but there's no content policy / secret-leak
  scan / prompt-injection defense for what the build agent ingests from the web.
- **No confidence/uncertainty signaling** surfaced to users.
- **No audit log** of guardrail events.

## Plan (→ PHASE-11)

### A. One brand persona, composed everywhere
- Create a single `PERSONA` module (server) defining: identity, tone, formatting rules,
  do/don'ts, refusal style. Compose it into: chat persona, swarm synthesizer, each agent
  (brand voice + expertise layer), the assistant, and the studio build agent.
- Keep specialized instructions (finance accuracy, code completeness) as *layers* on top,
  never contradicting the base voice.

### B. Output guardrail layer (defense beyond prompts)
- A lightweight post-generation pass for high-risk outputs:
  - **Fabrication check:** numeric/price/factual claims should map to a tool result;
    otherwise label "unverified".
  - **Leak check:** never emit secrets/keys/private URLs (regex + allowlist).
  - **Citation check:** sourced answers include real links.
- A **critic/verifier agent** in the swarm (see `10-AGENTS-SWARM.md §A`).

### C. Code/agent safety (Studio)
- **Prompt-injection defense:** treat web/tool content the build agent ingests as
  untrusted (don't let a fetched page redirect the agent); the existing
  `<untrusted-data>` framing pattern extends here.
- **Secret hygiene:** never inject platform secrets into containers; scan generated code
  for accidental secret echoes before deploy/commit.
- **Content policy:** refuse to build disallowed categories; safe-by-default templates.

### D. Trust signals (usability)
- Confidence chips, "verified vs from memory" labels, expandable sources, and a visible
  "what tools ran" trace (ties to legitimacy in `10-AGENTS-SWARM.md`).

### E. Auditability
- Structured guardrail/event logging (reuse `capabilities.ts` notice logging) so
  degraded/blocked/flagged events are observable and reviewable.

## Acceptance criteria (PHASE-11 done)
- A single persona module drives every surface; voice is consistent (spot-checked).
- The output guardrail layer catches fabricated numbers, leaked secrets, and missing
  citations in tests; flags surface to the user.
- Studio build agent treats ingested web/tool content as untrusted; secret-scan runs
  pre-deploy/commit.
- Confidence/verification signals appear in the UI; guardrail events are logged.
