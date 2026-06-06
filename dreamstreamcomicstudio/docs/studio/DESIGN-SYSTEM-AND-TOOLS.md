# Code Studio — Design System & Agent Tools

How we push every coding model (regardless of which one auto-routes) to ship genuinely good
UI/UX, motion and design — on **web and mobile** — and which free / open-source MCPs and APIs
the studio agents get as tools.

---

## 1. The design-instruction system

Model quality varies, but the *ceiling* a model reaches on design is mostly set by how hard and
how concretely we ask. So design guidance is now a single source of truth, composed into every
studio prompt — the same pattern `persona.ts` uses for brand voice.

**Module:** `server/src/ai/studio/designSystem.ts`

Two layers:

1. **`DESIGN_CHARTER`** — the non-negotiable bar, identical everywhere. Concrete on purpose
   (it names real libraries and real numbers, which is what lifts a weaker model's output):
   - **Web + mobile by default** — mobile-first, fluid responsive layouts (looks intentional at
     360px *and* 1440px), touch targets ≥ 44px, safe-area insets, no overflow.
   - **Real component libraries**, not hand-rolled primitives — Tailwind + shadcn/ui (Radix),
     Magic UI + Framer Motion for animation, lucide-react icons; for native mobile: Expo +
     react-native-reusables + react-native-reanimated.
   - **Cohesive visual system** — 4px spacing scale, type hierarchy, constrained palette + accent,
     consistent radius/shadow, light **and** dark themes, generous whitespace.
   - **Tasteful motion** — purposeful micro-interactions + enter/transition animations,
     transform/opacity only, 150–300ms, honoring `prefers-reduced-motion`.
   - **Every state designed** — loading/empty/error/success, with realistic seed data.
   - **Accessibility** — semantic HTML, labels, visible focus, keyboard nav, contrast ≥ 4.5:1.
   - **Setup that runs** — emit the Tailwind config + a CSS entry with the `@tailwind` directives;
     the scaffold auto-installs Tailwind + PostCSS when it sees them (see §3).

2. **`buildDesignDirective(brief)`** — the *self-customizing* layer. Instead of forcing one house
   style on every app, it tells the model to **read the user's ask, pick an aesthetic that fits
   (audience, mood, color story, density, motion intensity), and commit to it** — then hold the
   charter. In **refine** mode it instead respects and extends the app's *existing* design language.

### Where it's injected
| Surface | File | What it gets |
|---|---|---|
| Generate / refine / plan prompts | `studioGenerate.ts` | `buildDesignDirective(...)` before the JSON contract |
| UI/UX, Visual Design, Frontend review agents | `studioAgents.ts` | `DESIGN_REVIEW_CHECKLIST` appended to each `focus` |
| Build-loop FIX stage | `studioFix.ts` | `DESIGN_FIX_NOTE` (fixes must not regress the design) |

---

## 2. Agent tools — curated free / open-source MCPs

> **Transport constraint:** the app's MCP client (`server/src/ai/tools/mcpClient.ts`) speaks
> JSON-RPC over **HTTPS** (SSRF-guarded). It **cannot** spawn local `npx` *stdio* servers — so the
> root `.mcp.json` (Magic) is for **Claude Code only**, not the running app. `http` servers can be
> added directly; `stdio` servers must be self-hosted as an HTTPS/SSE endpoint first (see §4).

Catalog lives in code as `CURATED_MCP_CATALOG` (`designSystem.ts`):

| Tool | Gives the agents | Transport | License | Wired in by default? |
|---|---|---|---|---|
| **Context7** | Live, version-correct docs for any library (Tailwind, shadcn, Framer Motion, Expo…) so models use real APIs, not hallucinated ones | http (`https://mcp.context7.com/mcp`) | MIT | ✅ always-on |
| **DeepWiki** | Any public GitHub repo as a searchable wiki → borrow proven patterns | http (`https://mcp.deepwiki.com/mcp`) | open | ✅ always-on |
| **shadcn/ui MCP** | Real shadcn component source, demos, blocks for React, Svelte, Vue **and React Native** | stdio (`@jpisnice/shadcn-ui-mcp-server`) | MIT | via `STUDIO_SHADCN_MCP_URL` |
| **21st.dev Magic** | AI component builder/refiner + logo search | stdio (`@21st-dev/magic`) | free tier | via `STUDIO_MAGIC_MCP_URL` |
| **Magic UI** | Animated React + Tailwind components (marquee, blur-fade, shimmer…) | stdio (`@magicuidesign/mcp`) | MIT | via `STUDIO_MAGICUI_MCP_URL` |
| **Nango** | OAuth + proxy + actions for **800+ APIs** as MCP tools | http (self-hosted) | Elastic License v2 | via `STUDIO_NANGO_MCP_URL` |

Plus the in-app tools the agents already have: `web_search`, `github_repo`, `npm_package`,
`pypi_package`, `image_search`, live-data tools, and any MCP servers a user saves in their account
(`mcpRegistry`). Both **DreamStream chat** and the **Code Studio** consume the same MCP plumbing,
so anything added here is available to both.

---

## 3. Web + mobile by default

- **Responsive web (live today):** the charter mandates mobile-first responsive layouts, and the
  React scaffold (`studio/scaffold.ts`) now auto-wires **Tailwind + PostCSS** when the model opts in
  (a `tailwind.config.*` or a CSS file with `@tailwind` directives), and **auto-adds imported design
  deps** (framer-motion, lucide-react, shadcn's `@radix-ui/*`, recharts, react-router, etc.) to
  `package.json` — so the recommended stack renders on first install instead of dying on a missing
  dependency or unstyled utility classes.
- **Native mobile (Expo / React Native):** the charter already steers native targets to Expo +
  react-native-reusables, and the shadcn MCP serves React Native components. A first-class **Expo
  scaffold + preview runtime** is the natural next step (WebContainer can run an Expo *web* export;
  native preview needs a device/emulator bridge) — tracked as a follow-up, not in this change.

---

## 4. Self-hosting the stdio MCPs (shadcn / Magic / Magic UI)

Because the app only talks HTTPS MCP, expose the stdio servers over HTTP/SSE and point an env var
at them. Example for shadcn (its server supports SSE natively):

```bash
# Run the shadcn MCP in SSE mode behind your gateway/TLS
MCP_TRANSPORT_MODE=sse npx @jpisnice/shadcn-ui-mcp-server --framework react
# then in the studio deployment:
export STUDIO_SHADCN_MCP_URL="https://mcp.internal.yourdomain.com/shadcn/sse"
```

Servers without a built-in HTTP mode can be fronted with a thin stdio→HTTP bridge
(e.g. `supergateway`). Any URL set via `STUDIO_SHADCN_MCP_URL` / `STUDIO_MAGIC_MCP_URL` /
`STUDIO_MAGICUI_MCP_URL` / `STUDIO_NANGO_MCP_URL` is merged into the studio's default servers at
request time (`envDesignMcpServers()`), https-only, best-effort.

---

## 5. Nango (800+ APIs) — feasibility & recommended integration

**Question:** can we integrate [Nango](https://github.com/nangohq/nango) — all 800+ API connectors —
and "onboard their repo" so Code Studio agents can use these to build apps for our users?

**Short answer: yes, and it's a strong fit — but run it as a self-hosted *sidecar service*, do
*not* vendor their whole repo into ours.**

### What Nango is
Open-source integration platform: **managed OAuth + API-key auth + token refresh**, an
**authenticated proxy**, deployable **actions/functions**, and a **built-in MCP server** — across
**800+ APIs**. It explicitly supports "AI tool calling & MCP".

### License — the important nuance
Nango is **Elastic License v2 (ELv2)**. Under ELv2 you **may** self-host it for free, modify it, and
**embed it as internal infrastructure that powers our product**. You may **not** offer *Nango itself*
as a managed/hosted service to third parties, circumvent its license keys, or strip license notices.
Using a self-hosted Nango to give *our* studio agents API access is squarely **using** it (allowed),
not **reselling** it. (If we ever exposed "bring Nango hosting" as a product to others, that would
cross the line.)

### Free self-hosted feature set
Free self-hosting covers **Auth + Proxy** (managed OAuth/API-key/token-refresh + authenticated
proxying) — which is exactly the core needed to let agents call 800+ APIs. Advanced *managed* sync
features are gated to Cloud/Enterprise. Footprint: Postgres (control plane, credentials, tasks),
Elasticsearch (execution data), Redis, server + workers — via `docker-compose`.

### Recommended pattern (do this)
1. **Run Nango as a self-hosted sidecar** (its `docker-compose`), upgraded with `docker pull`.
   **Don't** git-subtree/submodule their entire codebase into ours — vendoring it creates a
   permanent merge/maintenance burden and an ELv2 footgun, with no upside unless we must patch
   internals.
2. Our backend talks to Nango via its **Node SDK / REST API** for OAuth + proxy, **or** points the
   studio at Nango's **MCP server** via `STUDIO_NANGO_MCP_URL`.
3. **Don't expose 800 tools to the model** — that blows the tool budget and degrades selection.
   Expose a *small* set of meta-tools instead: `search_integrations`, `connect_integration`
   (kick off OAuth), `call_api` (proxy a request to a connected provider). Curate per-task subsets
   when an app clearly needs a specific provider.
4. Treat connections as **per-end-user** (each user authorizes their own Google/Slack/etc.), with
   Nango holding and refreshing the tokens — never hard-code third-party credentials into generated
   apps.

### Why not "onboard the repo"
Forking 800+ connectors into our tree means we own their upgrades, security patches, and connector
drift forever. The connectors are the value; the way to "take control" of them is to **operate**
Nango (self-host + configure which providers/actions are allowed), not to **absorb its source**.

---

## 6. Config reference

| Env var | Effect |
|---|---|
| `STUDIO_SHADCN_MCP_URL` | Add a self-hosted shadcn/ui MCP (HTTPS/SSE) to studio agents |
| `STUDIO_MAGIC_MCP_URL` | Add a self-hosted 21st.dev Magic MCP |
| `STUDIO_MAGICUI_MCP_URL` | Add a self-hosted Magic UI MCP |
| `STUDIO_NANGO_MCP_URL` | Add a self-hosted Nango MCP (800+ API connectors) |

All are optional, https-only, and best-effort — an unreachable server simply yields no tools and
never blocks a build.
