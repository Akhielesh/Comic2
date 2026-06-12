# Product Vision & Prioritized Roadmap

_Added June 2026 from a product-owner session. This is the durable statement of
where the platform is going, the standardized way new data sources join it, and
an honest prioritization. Update it when direction changes — don't fork new
vision docs._

## The one-sentence vision

**DreamStream becomes the user's personal AI workspace: they connect the
services that hold their life's data (email, calendar, files, purchases,
messages), and the assistant uses that context — retrieved, ranked, and
permissioned — to answer, create, alert, and act across any device they log
in from.**

### North-star scenario (canonical example)

A user connects their Google account. They're cooking tonight:

1. They ask for a paneer tikka recipe. The assistant retrieves their Whole
   Foods receipts (parsed from Gmail) and recent grocery history, checks which
   ingredients they already have, and produces the recipe **plus a shopping
   checklist of only the missing items**.
2. It's 6:05 pm and their calendar shows a 7:00 pm meeting. The recipe takes
   ~75 minutes. The assistant gently flags the conflict ("you have Standup at
   7 — want a 40-minute version instead?") rather than letting them find out
   at 6:55.
3. They like the result, customize the instructions, and share it with a
   friend — first via email/share-link (we own that path today), later via
   connected messaging services.

Every piece of that scenario maps to a phase below. None of it requires new
products — it requires **connectors + ingestion + retrieval + a small amount
of proactivity** layered on the existing Chat Studio.

## Where this fits honestly (focus statement)

The platform today spans Comic Studio, Chat Studio (100+ tools, artifacts,
dashboards), Code Studio, DreamStream Live, LearnHub, Model Bench, ventures
specs, and five Cloudflare workers. That is **real sprawl for the team size**,
and the owner has asked for honesty about it, so:

- **Chat Studio is the center of gravity.** Personal-data connectors deepen
  it; they are an extension of the existing connector + memory architecture,
  not a new surface. This work is *aligned*, not divergence.
- **Deliberately NOT now** (parked, revisit only after Phases 0–3 ship and
  have users): building the studio-autopilot/ventures spec, WhatsApp/Business
  messaging integrations, more long-tail free-API tools, new product surfaces,
  proactive background agents beyond the chat-time version.
- The standing rule: **a new capability must reuse the standard below or it
  doesn't ship.** That's how we pack many services into one product without
  the codebase forking into twenty.

## The Connector Standard (the "standardized process" — mostly already built)

There are exactly **three lanes** for an external service. New work picks a
lane; it never invents a fourth.

| Lane | When | What exists | Docs |
|---|---|---|---|
| **1. First-party built-in** | Flagship UX: typed data, rich artifact cards, RAG ingestion, budgets (Google is this) | `ChatTool` registry (`server/src/ai/tools/registry.ts`), catalog (`toolCatalog.ts`), metering (`lib/providerUsage.ts`), artifact pipeline | `DATA_CONNECTORS.md` checklist |
| **2. Nango (self-hosted)** | Long-tail OAuth SaaS (800+ providers) where text answers suffice | 3 meta-tools (`server/src/ai/tools/nango.ts`); needs deploy + per-user connection mapping | `docs/studio/INTEGRATIONS-NANGO.md` |
| **3. MCP** | User-extensible: users bring their own servers; curated marketplace | Per-user registry, SSRF guards, marketplace, outbound endpoint | `features/mcp-directory.md` |

**Every personal-data connector (lane 1) must implement the same contract:**

1. **Identity** — per-user OAuth, tokens encrypted with the existing
   `secureStore` (AES-256-GCM, same as BYOK keys), stored in a
   `user_connections` table (provider, scopes, status, expiry), RLS owner-only.
2. **Tools + artifacts** — typed `ChatTool`s registered in `registry.ts` +
   `toolCatalog.ts`, rendering rich cards per the `CLAUDE.md` pipeline
   (gallery rule applies). Write actions (send, create event) ALWAYS render a
   draft card requiring an explicit user confirmation click — the model never
   sends on its own.
3. **Ingestion (optional)** — a BullMQ sync job (Redis already in stack)
   pulling recent items into `user_documents` (pgvector, 768-d, same embedding
   family as `user_memories`), every row tagged `source` + `connection_id`.
4. **RAG adapter** — retrieval merged into `buildUserMemoryBlock()` so context
   follows the user across products/devices/models (the June 2026 RAG
   foundation, `server/sql/user_memory_rag.sql`).
5. **Privacy surface** — disconnect revokes the token AND purges that source's
   `user_documents` rows; the memory opt-out covers documents; list/delete
   endpoints mirror `/api/chat/memory/*`.
6. **Untrusted-content rule** — ingested third-party content (email bodies!)
   is prompt-injection surface. It enters the model wrapped/labelled as
   untrusted data, and can never trigger a write action without the
   human-approval card from rule 2.
7. **Honest budgets** — provider quotas in `lib/providerUsage.ts`; degraded
   modes return capability notices, never fake data.

## Google services — phased plan (the flagship connector)

Costs verified June 2026. Key external constraint: Google classifies scopes as
public / sensitive / **restricted**. Restricted scopes (full Gmail read,
full Drive) require **annual CASA security assessment (~$540–$4,500/yr via
approved labs)** plus a multi-week verification. Sensitive scopes (Calendar,
`gmail.send`, `youtube.readonly`) need only standard free verification.
`drive.file` (user-picked files) avoids even that. Unverified "testing" apps
are capped at 100 test users with 7-day refresh-token expiry. **So the scope
ladder below is ordered to defer the CASA spend until traction justifies it.**

| Phase | Ships | Scopes | Hard cost |
|---|---|---|---|
| **0 — Security gate** | Close open audit items (H3 studio-worker replay, H4 live-worker CORS/compare, M8 email-worker replay+allowlist, M2 egress secret, M5 encrypt `mcp_servers.headers`, M6 RPC rate-limit); apply pending SQL migrations (`user_memory_rag.sql` et al.) | — | $0 |
| **1 — Account linking** | Google Cloud project, consent screen, incremental-auth connect flow in Settings → Connections; `user_connections` table; token refresh | none yet | $0 |
| **2 — Read + compose tools & cards** | `calendar_agenda` (agenda card), `calendar_create_event` (draft card → confirm), `gmail_compose`/`gmail_send` (draft card → user clicks Send), `drive_search`/`drive_read` (picker-scoped), `youtube_search`; inbox/agenda widgets on custom dashboards | `calendar.readonly`, `calendar.events`, `gmail.send`, `drive.file`, `youtube.readonly` — **all non-restricted**; standard verification | $0 |
| **3 — Inbox ingestion + personal RAG** | `gmail.readonly` behind testing mode (owner + ≤100 testers); BullMQ sync (90-day window, configurable); receipt/itinerary extraction via cheap model into structured `purchases` rows; `user_documents` retrieval in chat | `gmail.readonly` (**restricted**) | $0 while in testing; **CASA ~$540–4,500/yr when going public** |
| **4 — Context-aware assistance** | Chat-time first (no new infra): recipe/task answers consult the calendar tool and warn about conflicts; then rules → `notifications` table → email/push for true proactive alerts | reuses 2–3 | $0 |
| **5 — Sharing & messaging out** | Share recipes/notes via email (email-worker exists) + public share links; WhatsApp/Telegram/Slack outbound **later** (WhatsApp = Meta business verification + per-conversation fees — parked) | — | $0 now |

### Running-cost reality check (marginal, at early scale)

- **Google APIs:** $0 — generous free quotas (Gmail ~1B units/day, Calendar
  ~1M/day, YouTube 10k units/day).
- **Embeddings:** gemini-embedding free tier covers early use; paid ≈ $0.15/1M
  tokens → ~$0.08 to index 1,000 emails for one user. Negligible.
- **Extraction (receipts):** flash-class model, ~$0.0001/receipt. Negligible.
- **Storage:** ~3 KB/vector row → 10k emails ≈ 30 MB/user; Supabase Pro
  ($25/mo, already needed) carries hundreds of users at a 90-day window.
- **Nango (lane 2, when wanted):** one small container (~$5–10/mo Railway).
- **Net new fixed cost until CASA: ≈ $0–10/mo.** The real costs are LLM
  tokens (mitigated by BYOK + free models) and engineering time.

### Security non-negotiables before Phase 3

Email is the most sensitive data class we will ever hold. In addition to the
Connector Standard rules: no raw bodies in logs (`requestLogger` already
structured — keep it that way), per-source purge proven by test, RLS verified
on `user_connections`/`user_documents`, and the Phase 0 audit items closed
first. **We do not pipe inboxes into a platform with known open security
items.**

## Prioritization (owner-requested, honest)

**P0 — before any new connector code:**
1. Phase 0 security items above (`PLATFORM_HEALTH_2026-06.md` §4 open list).
2. Apply pending migrations so the shipped RAG foundation actually runs in
   production (it silently no-ops today).
3. `country_info` migration off the deprecated REST Countries legacy API
   (deadline was June 2026 — it's breaking now).

**P1 — the vision, in order:** Google Phases 1 → 2 → 4(chat-time) → 3, each
shipped thin and end-to-end (connect → tool → card → memory) before widening.

**P2 — platform health over new features:** memory settings UI (promised
privacy surface), onboarding/first-run for Chat Studio, usage/retention
instrumentation — *getting and keeping users for what's already built beats
adding surface #9*. Comic Studio's fate is DECIDED (June 2026): recommitted as
a shareable product — one engine, simplified flow, ComicForge removed (ADR
0004, `features/comic-studio.md`).

**Parked (in the vision, not the plan):** WhatsApp/messaging connectors,
studio-autopilot build-out, proactive background agent infrastructure beyond
chat-time checks, additional long-tail API tools.
