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
> JSON-RPC over HTTP. It **cannot** spawn local `npx` *stdio* servers — so the root `.mcp.json`
> (Magic) is for **Claude Code only**, not the running app. `stdio` servers (shadcn, Magic UI) must
> be fronted by an HTTP bridge first (`deploy/studio-tools/`, §4).
>
> **Trusted vs strict:** user-supplied MCP URLs stay behind the strict SSRF guard (https + public
> hosts only). **Operator-configured** servers — the always-on defaults and anything set via the
> `STUDIO_*_MCP_URL` env vars — are treated as **trusted**, so they may use `http` and internal
> hostnames (a self-hosted sidecar like `http://shadcn-mcp:8001/mcp`). Optional auth headers come
> from a companion `<ENVVAR>_HEADERS` JSON value.

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
(`mcpRegistry`). Both **DreamStream chat** and the **Code Studio** consume the same MCP plumbing:
the Code Studio always gets the always-on + self-hosted servers; **DreamStream chat** gets the same
set whenever the user is using tools (any tool enabled or an MCP server configured), so plain
conversations stay untouched.

### Nango connector tools (native, no MCP needed)
Beyond MCP, the agents get three first-class **Nango** tools (`server/src/ai/tools/nango.ts`),
registered globally and given to the **Data & Live APIs** agent — `nango_search_integrations`,
`nango_connect_integration`, `nango_call_api` — for OAuth + proxy across **800+ APIs**. These call a
self-hosted Nango's REST API directly (per-call `connectionId`), which is why they're preferred over
the connection-scoped Nango MCP for general use. Setup + the runtime pattern: `INTEGRATIONS-NANGO.md`.
Run everything with `deploy/studio-tools/docker-compose.yml`.

---

## 3. Web + mobile by default

- **Responsive web (live today):** the charter mandates mobile-first responsive layouts, and the
  React scaffold (`studio/scaffold.ts`) now auto-wires **Tailwind + PostCSS** when the model opts in
  (a `tailwind.config.*` or a CSS file with `@tailwind` directives), and **auto-adds imported design
  deps** (framer-motion, lucide-react, shadcn's `@radix-ui/*`, recharts, react-router, etc.) to
  `package.json` — so the recommended stack renders on first install instead of dying on a missing
  dependency or unstyled utility classes.
- **Native mobile (Expo / React Native) — live:** `scaffold.ts` auto-**detects** React Native/Expo
  (from a `react-native`/`expo` import, an `app.json` with `"expo"`, or RN deps) and scaffolds a real
  Expo project. The **same RN code runs two ways from one codebase**: the in-studio preview is a
  plain **Vite + react-native-web** app (aliases `react-native` → `react-native-web`, so it boots in
  the WebContainer like any web project), and `npm run native` runs it on device via `expo start`.
  - **App + source stay at the project root** (not under `src/`) so Expo's native entry
    (`node_modules/expo/AppEntry.js`) resolves `App` — the web harness (`index.html` + `web-entry.tsx`)
    is added alongside.
  - **NativeWind / react-native-reusables:** import `nativewind` and the scaffold wires the native
    build — `babel.config.js` (jsxImportSource), `metro.config.js` (`withNativeWind`),
    `tailwind.config.js` (`nativewind/preset`) and a `global.css`. NativeWind styling is canonical on
    device; the lightweight Vite preview renders layout/base styles. The shadcn MCP
    (`--framework react-native`) serves matching react-native-reusables component source.
  - Imported, web-compatible RN libs (safe-area-context, reanimated, react-navigation,
    `@expo/vector-icons`, …) are added with Expo-SDK-aligned versions; for exact native versions run
    `npx expo install`.

---

## 4. Self-hosting the stdio MCPs + Nango (one compose)

`deploy/studio-tools/docker-compose.yml` stands up everything: **Nango** (Postgres + Redis +
`nango-server`), the **shadcn/ui MCP**, and the **Magic UI MCP** — the two stdio MCPs fronted by
[`supergateway`](https://github.com/supercorp-ai/supergateway) (`--outputTransport streamableHttp`)
so the app can reach them over HTTP.

```bash
cd deploy/studio-tools
cp ../../.env.studio-tools.example .env   # set NANGO_ENCRYPTION_KEY (openssl rand -base64 32)
docker compose up -d
```

Then point the app at them (operator-set → **trusted**, so http/internal hosts are allowed):

```bash
STUDIO_SHADCN_MCP_URL=http://shadcn-mcp:8001/mcp
STUDIO_MAGICUI_MCP_URL=http://magicui-mcp:8002/mcp
NANGO_HOST=http://nango-server:3003
NANGO_SECRET_KEY=<from the Nango dashboard>
```

Any URL set via `STUDIO_SHADCN_MCP_URL` / `STUDIO_MAGIC_MCP_URL` / `STUDIO_MAGICUI_MCP_URL` /
`STUDIO_NANGO_MCP_URL` is merged into the studio's servers at request time (`envDesignMcpServers()`),
best-effort (an unreachable server simply yields no tools). Full Nango guide: `INTEGRATIONS-NANGO.md`.

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
| `STUDIO_SHADCN_MCP_URL` | Add a self-hosted shadcn/ui MCP to studio agents |
| `STUDIO_MAGIC_MCP_URL` | Add a self-hosted 21st.dev Magic MCP |
| `STUDIO_MAGICUI_MCP_URL` | Add a self-hosted Magic UI MCP |
| `STUDIO_NANGO_MCP_URL` | Add a (connection-scoped) self-hosted Nango MCP |
| `STUDIO_<NAME>_MCP_URL_HEADERS` | Optional JSON auth headers for that server (e.g. `{"Authorization":"Bearer …"}`) |
| `NANGO_HOST` | Nango base URL for the connector tools (default `http://localhost:3003`) |
| `NANGO_SECRET_KEY` | Enables `nango_search_integrations` / `nango_connect_integration` / `nango_call_api` |
| `NANGO_DEFAULT_CONNECTION_ID` | Optional default connection for build-time API inspection |

The `STUDIO_*_MCP_URL` servers are operator-set (**trusted**): http/internal hosts are allowed, all
are best-effort — an unreachable server simply yields no tools and never blocks a build. Full env
template: `.env.studio-tools.example`.
