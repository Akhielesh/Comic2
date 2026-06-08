# 18 — UX Spec: Integrations & Connections

> Part II · Product Definition · Code Studio Autopilot Master Specification
> Canon: [SPEC-INDEX](../SPEC-INDEX.md) · [Master Plan](../00-MASTER-PLAN.md) (§6 hosting &
> adapters, Epic A5) · [Foundations](../F-ENTERPRISE-FOUNDATIONS.md) (F10) ·
> [Information Architecture](./12-information-architecture.md) (§12.2 Connections surface)

## 18.1 What this surface is (and the honest scope)

A **Connection** is a user's external account — Cloudflare, Vercel, Railway, Supabase, GitHub,
or any of Nango's 800+ providers, plus MCP servers — linked so Autopilot can act on the user's
behalf. An **Adapter** is the pluggable `deploy()`/`provision()` implementation that *uses* a
Connection to ship a **Venture** to a provider. The two are deliberately separate concepts: you
connect an account once (a Connection), and one or more Adapters consume it.

This section specs the **UX** of connecting, viewing, and revoking accounts. It does **not**
respec the integrations *framework* (that is [§30](./30-integrations-framework.md)) or the
deploy *adapters* (that is [§31](./31-deploy-adapters.md)); it specs the screens the user
touches.

**Shipped vs planned — the honest baseline.** We are not starting from zero, and we will not
pretend the unified surface exists yet.

| Capability | Status today | Where |
|---|---|---|
| Nango OAuth/connect meta-tools (search, connect-session, proxy) | **shipped** (agent-side) | `server/src/ai/tools/nango.ts` |
| MCP marketplace one-click connect (DeepWiki, Context7, Hugging Face) | **shipped** (UI) | `components/chat/ToolsDashboard.tsx` (`MCP_MARKETPLACE`) |
| Custom MCP server add/edit/remove (local store) | **shipped** | `services/mcpServers.ts`, `ToolsDashboard.tsx` |
| MCP server health + auto-disable-after-3-fails | **shipped** | `server/src/services/mcpRegistry.ts` |
| Chat connector category toggles | **shipped** | `services/chatConnectors.ts` |
| **Unified Connections catalog** (one surface, all kinds) | **planned (F10)** | `?view=integrations`, `?view=connections&v=:id` |
| **Per-venture** connections + deploy-target picker | **planned (A5)** | `venture_connections`, Operator Console |
| Connection **health / scope / expiry** display | **planned (F10)** | this section |

The work in this section is the *new product UX* that unifies the shipped pieces into one
honest catalog and adds the venture-scoped layer. Epic **A5** delivers the deploy-relevant
connections and the deploy-target picker; **F10** delivers the unified catalog, health/expiry
tracking, and connection-state surfacing. Each subsection marks which epic owns it.

## 18.2 Two scopes: account-level vs per-venture

Connections live at **two altitudes**, mirroring the IA's two-level scheme
([§12.4](./12-information-architecture.md)):

| Scope | Route | What lives here | Who uses it |
|---|---|---|---|
| **Account-level** | `?view=integrations` (`/integrations`) | Connections shared across all the user's ventures (e.g. one GitHub account, model-provider keys, MCP servers). | Maya, once. Reused everywhere. |
| **Per-venture** | `?view=connections&v=:id` (`/ventures/:id/connections`) | The deploy targets and provider accounts *this venture* ships to; selected from account-level or connected fresh in-context. | The venture's Operator Console + deploy step. |

The mental model: **connect once at the account level; assign to ventures.** A venture's
Connections tab shows account-level connections it *can* use plus any it has *adopted*, and lets
you connect a new account inline without leaving the venture (the new account is also recorded
account-level, never trapped inside one venture). This avoids the trap of re-authorizing GitHub
for every venture while still giving each venture an explicit, auditable set of accounts it
touches — important because a misattributed deploy is a trust-destroying error
([§12.4](./12-information-architecture.md)).

`venture_connections` (Epic A1) stores only a reference: the Nango `connection_id` +
`provider_config_key`, the scope (`account` | `venture`), owner `user_id`, the granted scopes,
and metadata. **No secret is ever stored in our DB or shipped to the client** (§18.9).

## 18.3 The connections catalog (account-level)

The catalog is the single surface F10 calls for — *one place that shows every connection's
health, scopes, and expiry*. It reuses the `ToolsDashboard` visual grammar (`border-2
border-black`, `shadow-comic`, kind/auth badges) so it feels native to the existing product.

```
┌─ Integrations & Connections ─────────────────────────────────  [+ Connect account] ┐
│                                                                                     │
│  [ All ]  [ Deploy ]  [ Source ]  [ Data ]  [ Comms ]  [ MCP ]      🔍 Search…       │
│                                                                                     │
│  ── DEPLOY TARGETS ───────────────────────────────────────────────────────────────│
│  ┌───────────────────────────┐  ┌───────────────────────────┐                      │
│  │ ▲ Cloudflare      ● Healthy│  │ ▲ Vercel          ● Healthy│                      │
│  │ acme@team · OAuth          │  │ jdoe · OAuth               │                      │
│  │ scopes: Pages,Workers,DNS  │  │ scopes: deployments,projects│                     │
│  │ used by 2 ventures         │  │ used by 1 venture          │                      │
│  │ [Manage]        [Disconnect]│  │ [Manage]       [Disconnect]│                      │
│  └───────────────────────────┘  └───────────────────────────┘                      │
│  ┌───────────────────────────┐  ┌───────────────────────────┐                      │
│  │ 🚆 Railway     ⚠ Expiring  │  │ ⬡ Supabase      ✕ Not conn.│                      │
│  │ token · expires in 4 days  │  │ Provision DBs/auth/storage │                      │
│  │ scopes: project.deploy     │  │ for your ventures          │                      │
│  │ [Reconnect]    [Disconnect]│  │ [Connect →]                │                      │
│  └───────────────────────────┘  └───────────────────────────┘                      │
│                                                                                     │
│  ── SOURCE & DATA ─────────────────────────────────────────────────────────────────│
│  ┌───────────────────────────┐  ┌───────────────────────────┐                      │
│  │ ⎇ GitHub          ● Healthy│  │ + 800 more via Nango       │                      │
│  │ @maya · OAuth · repo,workflow│ │ Slack, Notion, Stripe, …  │                      │
│  │ [Manage]       [Disconnect]│  │ [Browse all providers →]   │                      │
│  └───────────────────────────┘  └───────────────────────────┘                      │
│                                                                                     │
│  ── MCP SERVERS ──────────────── (one-click connect — shipped) ─────────────────────│
│  ┌───────────────────────────┐  ┌───────────────────────────┐                      │
│  │ ▣ DeepWiki   [MCP][KEYLESS]│  │ ▣ Context7   [MCP][KEYLESS]│                      │
│  │ Q&A over any public repo   │  │ Up-to-date library docs    │                      │
│  │ ● Healthy        [Connected]│  │ ● Healthy         [Connect]│                      │
│  └───────────────────────────┘  └───────────────────────────┘                      │
│  [+ Add custom MCP server]                                                           │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

**Catalog grouping.** Connections are grouped by *job*, not by mechanism — the user does not
care whether GitHub comes via Nango OAuth and DeepWiki via MCP; they care "deploy", "source",
"data", "comms", "MCP". The grouping:

| Group | Members | Backing mechanism |
|---|---|---|
| **Deploy targets** | Cloudflare, Vercel, Railway, Supabase (provision) | Nango OAuth / PAT → Adapter (A5) |
| **Source** | GitHub (two-way sync) | Nango OAuth (reuses `studioGithub.ts`) |
| **Data** | Supabase, Postgres, any Nango data provider | Nango |
| **Comms / 800+** | Slack, Notion, Stripe, Gmail, … | Nango meta-tools (`nango.ts`) |
| **MCP servers** | DeepWiki, Context7, Hugging Face, custom | `mcpServers.ts` / `mcpRegistry.ts` |

Each card carries a **kind badge** (`OAUTH` / `PAT` / `MCP`) and an **auth badge**
(`KEYLESS` / `KEY OPTIONAL` / `KEY REQUIRED`), reusing `KindBadge`/`AuthBadge` from
`ToolsDashboard.tsx`. A "used by N ventures" line makes the account→venture fan-out visible.

## 18.4 The connect flow (OAuth via Nango / PAT)

The connect flow has two paths, chosen by what the provider supports; the UI presents a single
**Connect** button and routes correctly behind it.

```
 User clicks [Connect →] on a provider card
        │
        ▼
 ┌──────────────────────────────────────────────┐
 │  Choose how to connect  (provider supports…)   │
 │  ◉ Sign in with OAuth   (recommended, default) │
 │  ○ Paste a token / PAT  (advanced)             │
 │  Scope:  ◉ All my ventures   ○ This venture only│
 └──────────────────────────────────────────────┘
        │ OAuth                              │ PAT
        ▼                                    ▼
 server mints a Nango connect-session   user pastes token + label
 (POST /connect/sessions, nango.ts)     into a masked field
        │                                    │
        ▼                                    ▼
 nango.openConnectUI({ sessionToken })  server validates the token
 → provider's own consent screen        with a probe call, stores
 → user approves the requested scopes   reference in venture_connections
        │                                    │
        └──────────────┬─────────────────────┘
                       ▼
        Connection appears in the catalog as ● Healthy,
        with its granted scopes + (OAuth) refresh handled by Nango.
        A venture_event is appended (who connected what, when).
```

**OAuth path (default, recommended).** Exactly the shipped pattern in `nango.ts`: the server
mints a short-lived connect-session token with the operator secret key (`POST
/connect/sessions`), and the client loads `@nangohq/frontend` and calls
`nango.openConnectUI({ sessionToken })`. The user approves on the provider's own consent screen;
Nango stores and **refreshes** the tokens. The secret key never reaches the client. We request
**least-privilege scopes per adapter** ([Master Plan §5.9](../00-MASTER-PLAN.md)) — e.g.
Cloudflare asks for Pages/Workers/DNS only, not account-admin.

**PAT path (advanced).** For users who prefer a scoped token (or providers where it's simpler),
a masked field accepts a personal access token. The server runs a **probe call** (e.g. a
`whoami`/account read) to validate it before saving, surfaces the inferred scopes, and stores
the reference — never the raw token in the client bundle or our logs.

**Scope picker.** The connect dialog includes the account/venture scope toggle (§18.2). Default
is "All my ventures" for account-shared providers (GitHub, model keys); when launched from a
venture's deploy step, it defaults to "This venture" and pre-selects the venture.

**Inline, never a dead-end.** The flow can be launched from three places — the account catalog,
a venture's Connections tab, or the **deploy-target picker** (§18.6) at the moment a deploy
needs an account it doesn't have. In every case the user lands back exactly where they started,
with the new connection selected.

## 18.5 Connection health, scopes & expiry (F10)

Today only MCP servers track health (`mcpRegistry.ts`: `health: ok|error|unknown`,
`last_checked_at`, `fail_count`, auto-disable after 3 fails). F10 generalizes this to **every**
connection. The detail card is the canonical view:

```
┌─ Cloudflare ───────────────────────────────────────────  ✕ │
│  ▲  Cloudflare            ● HEALTHY · last checked 2m ago    │
│  acme-team@cloudflare.com · connected via OAuth (Nango)      │
│  ─────────────────────────────────────────────────────────  │
│  STATUS                                                       │
│    Health        ● Healthy   (3/3 recent checks ok)          │
│    Token         🔄 Auto-refreshed by Nango — no expiry shown │
│    Connected     2026-05-21 by you                           │
│  GRANTED SCOPES                                              │
│    ✓ Pages:edit     ✓ Workers Scripts:edit                   │
│    ✓ DNS:edit       ✓ Account:read                           │
│    (least-privilege — request more only if an adapter needs it)│
│  USED BY                                                      │
│    • Acme Booking   → cloudflare-pages   (prod)              │
│    • Habit Tracker  → cloudflare-workers (preview)           │
│  ─────────────────────────────────────────────────────────  │
│  [ Re-check now ]   [ Re-authorize ]      [ Disconnect ⚠ ]   │
└──────────────────────────────────────────────────────────────┘
```

**Health.** A periodic, owner-scoped health probe (a cheap authenticated read per provider)
writes `health` + `last_checked_at` to `venture_connections`, generalizing the MCP pattern.
States: `● Healthy`, `⚠ Degraded/Expiring`, `✕ Error/Revoked`, `… Checking`. Per F10's
acceptance ("an expired connection is surfaced to the user"), a degraded/expired connection
raises an in-app + email notice and shows a **Reconnect** CTA on every surface that lists it.

**Scopes.** We show the **granted** scopes (from the OAuth grant / token probe) so the user can
see exactly what they handed over, with a plain-English label per scope. If an Adapter later
needs a scope the connection lacks, the UI surfaces a targeted **"grant additional access"**
re-auth rather than failing opaquely at deploy time.

**Expiry.** OAuth connections via Nango are auto-refreshed, so we show "Auto-refreshed — no
action needed" rather than a misleading countdown. PATs and non-refreshable tokens show a real
**expiry date + countdown** and turn `⚠ Expiring` inside a 7-day window with a reminder notice.
This is the concrete fix for the F10 gap "no connection-state/expiry tracking."

## 18.6 The deploy-target picker (managed preview vs BYO adapter)

This is the A5 surface where Connections meet Adapters. When a venture is about to ship — or in
its Connections tab — the user chooses *where it deploys*. The picker maps the hybrid hosting
model ([Master Plan §6](../00-MASTER-PLAN.md)) to one control.

```
┌─ Deploy target — Acme Booking ───────────────────────────────┐
│  Where should this venture ship?                              │
│                                                              │
│  ◉ Managed preview         (default · no account needed)     │
│      acme-booking.dreamstreamstudio.ai                       │
│      Instant. We host it. Metered + budget-capped.   [Active]│
│                                                              │
│  ── Production (your own account) ──────────────────────────  │
│  ○ Cloudflare Pages   ● connected   scopes ok    [Select]    │
│  ○ Vercel             ● connected                [Select]    │
│  ○ Railway            ⚠ token expiring           [Reconnect] │
│  ○ Supabase (data)    ✕ not connected            [Connect →] │
│                                                              │
│  ⓘ Production deploys are gated by a checkpoint — Autopilot   │
│    will ask you to approve the first go-live.                │
└──────────────────────────────────────────────────────────────┘
```

- **Managed preview** is always available and selected by default — no Connection required
  (`adapters/managedPreview.ts` wraps `studio-worker/`). It is the "few clicks → it's live" wow,
  and it is quota- and budget-capped because we carry the cost.
- **BYO adapters** appear with their Connection's health inline. Selecting one that isn't
  connected launches the connect flow (§18.4) scoped to this venture, then returns to the
  picker. A BYO row whose Connection lacks a required scope shows **Reconnect** with the missing
  scope named.
- **Honest checkpoint note.** The picker states plainly that the **first production deploy is a
  checkpoint** ([Master Plan §8](../00-MASTER-PLAN.md)) — selecting a BYO target arms it; it
  does not silently push to prod. Managed preview never needs a checkpoint.
- **Billing clarity** (Master Plan §7): a one-line note says managed = "we front the cost,
  metered against your budget"; BYO = "you pay the provider directly; we meter only agent
  compute." No billing surprises.

## 18.7 MCP marketplace one-click connect (shipped, surfaced here)

The MCP marketplace is **already shipped** in `ToolsDashboard.tsx` (`MCP_MARKETPLACE` with
DeepWiki, Context7, Hugging Face) and mirrored server-side in
`server/src/ai/tools/mcpCatalog.ts`. The connections catalog **re-exposes** it as the "MCP
servers" group rather than rebuilding it:

- **One-click connect** for vetted, keyless HTTPS servers — `addMcpServer({ name, url })` writes
  to the local store (`services/mcpServers.ts`), which already flows into the agent's tool loop.
  The button flips `[Connect]` → `[● Connected]` (shipped behavior, reused verbatim).
- **Custom MCP server** add accepts `{ name, url, authorization? }`; the SSRF-guarded client
  (`mcpClient.ts`) and registry (`mcpRegistry.ts`) handle health + auto-disable-after-3-fails —
  so an MCP card shows the same `● Healthy / ✕ Error` states as everything else, *and this part
  works today*.
- **What's new (F10):** unifying MCP into the same catalog grammar, and (planned) inbound MCP
  push → SENSE signals for Autopilot (A6). MCP servers are account-level by nature (tools the
  agent can use anywhere); they are not deploy targets.

We explicitly mark the marketplace as **shipped** in the UI (a small "live" tag) so the catalog
honestly distinguishes working pieces from planned ones — matching the spec's house rule.

## 18.8 Disconnect / revoke

Disconnecting is a **first-class, reversible-aware** action — never buried, never silent.

```
┌─ Disconnect Cloudflare? ─────────────────────────────────────┐
│  ⚠ 2 ventures use this connection:                            │
│     • Acme Booking   → cloudflare-pages (prod, live)          │
│     • Habit Tracker  → cloudflare-workers (preview)           │
│                                                              │
│  Disconnecting will:                                          │
│    • revoke the stored credential in Nango (tokens deleted)  │
│    • stop future deploys to this provider for those ventures │
│    • NOT take down already-deployed sites                    │
│                                                              │
│  Live production deployments stay up. To take a site down,    │
│  use the venture's Deployments panel (a destructive checkpoint).│
│                                                              │
│  Type the provider name to confirm:  [ Cloudflare      ]      │
│                          [ Cancel ]   [ Disconnect ⚠ ]        │
└──────────────────────────────────────────────────────────────┘
```

- **Impact preview is mandatory.** A connection in use shows exactly which ventures + adapters
  depend on it before you confirm; we never let a user blind-revoke an account two live ventures
  deploy through.
- **Type-to-confirm** for any connection used by ≥1 venture (lightweight friction proportional
  to blast radius); a one-tap confirm for unused connections.
- **Revoke means revoke.** Disconnect deletes the credential reference and asks Nango to delete
  the stored tokens (OAuth) or discards the PAT; the secret was never ours to keep beyond Nango.
  The action writes a `venture_event` (append-only audit, A0) so revocation is explainable.
- **Disconnect ≠ teardown.** Removing an account does not delete deployed resources — taking
  down a live site is a separate **destructive checkpoint** in the venture's Deployments panel
  ([Master Plan §8](../00-MASTER-PLAN.md)). We keep these distinct so a routine credential
  rotation can never accidentally nuke production.

## 18.9 Security note (non-negotiable)

This surface holds the keys to users' clouds; the [Master Plan §5](../00-MASTER-PLAN.md) rules
are load-bearing UX constraints, not fine print:

- **Secrets live in Nango, never in our DB, never in the client.** `venture_connections` stores
  only a Nango `connection_id` + `provider_config_key` + metadata + granted scopes. The connect
  secret key is server-only (`nango.ts`). The UI **never displays a token** — not masked, not on
  hover; once entered, a PAT is write-only from the user's side.
- **Least-privilege scopes.** Each adapter requests the minimum scopes; the catalog shows what
  was granted so over-broad grants are visible and correctable.
- **Tokens never logged.** Per Master Plan §5.9 and Epic A5 acceptance ("tokens never logged"),
  no credential value enters logs, traces, or `venture_events` — only references and outcomes.
- **Re-auth on sensitive actions.** Connecting/disconnecting a deploy account is a sensitive
  action (F3 step-up): it may require re-auth, and it always lands in the audit log.
- **Owner isolation.** Every connection row is RLS owner-isolated (`auth.uid() = user_id`,
  mirroring `projects_rls_owner_isolation.sql`); no cross-tenant read of a connection ever.

## 18.10 Empty, loading & error states

| State | What the user sees | Primary action |
|---|---|---|
| **No connections at all** (first run) | Warm empty catalog: "Managed preview works right now — connect a cloud account when you're ready for production." | **Browse providers** (and a reassurance that nothing is required yet) |
| **No connections, in a venture's deploy step** | Inline: "This venture ships to a managed preview today. Connect your cloud to go to production." | **Connect a deploy target →** |
| **Loading the catalog** | Skeleton cards in each group (shape preserved, no layout shift); health badges show `… Checking`. | — |
| **OAuth window blocked / closed** | "We couldn't finish connecting — the provider window was closed. No account was linked." | **Try again** |
| **Token probe failed (PAT)** | "That token didn't validate against {provider} (401). Check the value and scopes." (raw error not echoed) | **Re-enter token** |
| **Nango not configured (operator)** | The exact honest message from `nango.ts`: "external API connectors are unavailable. Set NANGO_SECRET_KEY…" | (admin) configure Nango |
| **Connection degraded / expired** | `⚠` badge on the card + a banner: "Your {provider} connection needs attention." | **Reconnect** |
| **MCP server unhealthy / auto-disabled** | `✕` badge: "Auto-disabled after 3 failed checks." (shipped behavior) | **Re-check** / **Remove** |

The rule, consistent with [§12.7](./12-information-architecture.md): **every empty/error state
offers exactly one forward action**, and the always-available managed preview means a user is
never *blocked* from shipping by a missing connection.

## 18.11 Mobile

Per [§12.6](./12-information-architecture.md), mobile is monitoring-first, but connection
*health and reconnect* are essential on the go (an expired token can block a deploy the user
approved from their phone).

```
┌──────────────────────────────┐
│  Connections                 │
├──────────────────────────────┤
│ ▲ Cloudflare      ● Healthy   │
│ ▲ Vercel          ● Healthy   │
│ 🚆 Railway        ⚠ Expiring  │
│    [ Reconnect ]             │  ← one-tap, OAuth resumes
│ ⎇ GitHub         ● Healthy   │
│ ▣ DeepWiki (MCP)  ● Healthy   │
├──────────────────────────────┤
│ [+ Connect]  managed preview ✓│
└──────────────────────────────┘
```

- The catalog collapses to a single-column list of cards; groups become section headers.
- **Reconnect is one tap** and resumes the OAuth flow in the system browser (Nango Connect is
  mobile-friendly); PAT entry is supported but de-emphasized (hard to paste tokens on a phone).
- **Adding a custom MCP server is desktop-first** (URL + header entry) — on mobile we show it
  read-only with a "manage on desktop" hint, matching the "editing is a desktop job" stance.
- Connection health is reachable from a deploy-checkpoint notification deep-link
  ([§12.8](./12-information-architecture.md)) so a blocked deploy routes straight to the fix.

## 18.12 Accessibility (WCAG 2.1 AA)

- **Status is never color-only.** Health is conveyed by an icon + text label (`● Healthy`,
  `⚠ Expiring`, `✕ Error`) and an `aria-label`, so red/green color-blind users get the state —
  the current `ToolsDashboard` badges already pair color with text; we keep that invariant.
- **Keyboard-complete.** The whole flow — open Connect, choose OAuth/PAT, pick scope, confirm,
  disconnect (incl. type-to-confirm) — is operable by keyboard with a visible focus ring; no
  hover-only affordance (the docs-link/secret-reveal patterns are also focusable).
- **Dialogs are real dialogs.** Connect and Disconnect modals use `role="dialog"`,
  `aria-modal`, focus trap, Escape to close, and return focus to the triggering card.
- **Live regions.** Connection result ("Cloudflare connected" / "Couldn't connect") and health
  changes announce via an `aria-live="polite"` region so screen-reader users hear the outcome
  without polling the page.
- **Labels & masking.** The PAT field has a programmatic label and `aria-describedby` for the
  "never shown again" note; masked values expose an accessible "hidden, write-only" description,
  not a stream of bullet characters read aloud.
- **Targets & contrast.** Touch targets ≥44px on mobile; badge and text contrast meet AA
  against the white card surface.

## 18.13 Which epic delivers what

| Capability | Epic | Status |
|---|---|---|
| Nango OAuth/connect/proxy meta-tools | (existing studio) | **shipped** (`nango.ts`) |
| MCP marketplace one-click + custom MCP + health/auto-disable | (existing, Phase 10) | **shipped** (`ToolsDashboard.tsx`, `mcpRegistry.ts`) |
| `venture_connections` data + per-venture scope | **A1** (control plane) | planned |
| Deploy adapters + connect flow wired to deploy + deploy-target picker | **A5** | planned |
| Managed-preview default target | **A5** | planned (infra live) |
| Unified connections catalog (all kinds, one surface) | **F10** | planned |
| Connection health / scopes / expiry display + notices | **F10** | planned |
| Disconnect/revoke with impact preview + audit | **A5** (revoke) + **A0** (audit) | planned |
| Re-auth on connect/disconnect (sensitive action) | **F3** | planned |
| RLS owner-isolation on connections | **A1** | planned |

## 18.14 Acceptance criteria

- The connections catalog shows every connection — Cloudflare/Vercel/Railway/Supabase/GitHub,
  Nango 800+, and MCP servers — grouped by job, each with a kind badge, auth badge, and health
  state; shipped pieces (MCP marketplace) are visibly marked as live.
- A user can connect a provider via **OAuth** (Nango connect-session → `openConnectUI`) or
  **PAT** (probed before save), choosing **account** or **venture** scope, and lands back where
  they started with the connection selected.
- The connection detail card shows granted **scopes**, **health** (with last-checked), and
  **expiry** (real countdown for PATs; "auto-refreshed" for Nango OAuth); a degraded/expired
  connection raises a notice with a Reconnect CTA on every surface that lists it.
- The deploy-target picker offers **managed preview** (default, no account) and **BYO**
  adapters (with inline health), states the production checkpoint and the billing model, and
  launches the connect flow inline for an unconnected target.
- **Disconnect** shows an impact preview (which ventures/adapters depend on it), requires
  type-to-confirm when in use, revokes the credential in Nango, writes an audit event, and does
  **not** tear down live deployments.
- **No secret is ever displayed or logged**; `venture_connections` holds only references +
  metadata + scopes; rows are RLS owner-isolated.
- Every empty/loading/error state has exactly one forward action; managed preview means a
  missing connection never blocks shipping.
- The surface is fully keyboard-operable, status is never color-only, dialogs are accessible,
  outcomes announce via live regions, and mobile supports one-tap Reconnect.
