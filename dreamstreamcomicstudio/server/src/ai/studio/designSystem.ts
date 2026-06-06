// The Code Studio design system — the instructions that push EVERY coding model to ship
// genuinely good UI/UX, motion and visual design, on web AND mobile, regardless of which
// model is routed.
//
// Why this exists: model quality varies, but the *ceiling* a model reaches on design is
// largely set by how hard and how concretely we ask. A vague "make it look nice" gets
// unstyled scaffolding; a concrete charter + a per-request, self-customized directive gets
// production-grade UI. So this module is the single source of design truth, composed into
// the generate / refine / fix / agent prompts (the same pattern persona.ts uses for voice).
//
// Two layers:
//   1. DESIGN_CHARTER — the non-negotiable bar (responsive web+mobile, real component
//      libraries, motion, accessibility). Identical everywhere.
//   2. buildDesignDirective(brief) — the *self-customizing* layer: it tells the model to
//      infer the right aesthetic from THIS user's ask and commit to one cohesive design
//      language, instead of us hard-coding a single palette onto every app.
//
// Kept dependency-free + pure so it stays unit-testable and reusable across surfaces.

/** Minimal brief the directive adapts to. Decoupled from GenerateInput on purpose. */
export interface DesignBrief {
  /** The user's app idea or requested change. */
  prompt?: string;
  /** True when iterating on an existing app (respect the established look, don't reinvent it). */
  refining?: boolean;
}

/**
 * The non-negotiable quality bar, identical on every studio surface. Concrete on purpose:
 * naming real libraries and real numbers is what lifts a weak model's output.
 */
export const DESIGN_CHARTER = `DESIGN BAR — build like a senior product designer + engineer shipping to production. This is mandatory, not optional polish:

- WEB + MOBILE BY DEFAULT. Design mobile-first, then scale up. Fluid, responsive layouts (CSS grid/flex, container queries or breakpoints at ~640/768/1024/1280px) that look intentional at 360px AND 1440px. Touch targets ≥ 44px, respect safe-area insets, no horizontal scroll, no fixed pixel widths that overflow small screens.
- USE REAL COMPONENT LIBRARIES, don't hand-roll primitives. Preferred web stack: Tailwind CSS for styling, shadcn/ui (Radix primitives) for accessible components, Magic UI + Framer Motion for animation/effects, lucide-react for icons, recharts/visx only when there is real data to visualize. If the target is a NATIVE mobile app, use Expo + React Native with react-native-reusables (shadcn for RN) + react-native-reanimated.
- COHESIVE VISUAL SYSTEM. Commit to one design language and apply it everywhere: a spacing scale (multiples of 4px), a type scale with clear hierarchy, a constrained color palette with a real accent, consistent radius + shadow, and BOTH light and dark themes (prefers-color-scheme or a class toggle). Generous whitespace. No clashing fonts, no random one-off colors.
- TASTEFUL MOTION. Add purposeful micro-interactions and enter/transition animations (hover/press feedback, list/section reveals, route/tab transitions). Animate transform/opacity (GPU-friendly), 150–300ms, with easing — never animate layout in a janky loop. ALWAYS honor prefers-reduced-motion. Motion should clarify, not decorate gratuitously.
- EVERY STATE IS DESIGNED. Provide loading (skeletons/spinners), empty (helpful, with a call to action), error (recoverable), and success states — not just the happy path. Seed realistic sample data so the UI looks alive on first load.
- ACCESSIBILITY IS PART OF DESIGN. Semantic HTML, labelled controls, alt text, visible focus rings (focus-visible), full keyboard navigation, ARIA only where needed, and text contrast ≥ 4.5:1.
- SETUP THAT RUNS. If you use Tailwind/shadcn/Magic UI, EMIT the setup yourself: a tailwind.config.{js,ts} (content globs for ./index.html and ./src/**), and a CSS entry containing the @tailwind base/components/utilities directives — the studio auto-installs Tailwind + wires PostCSS when it sees them. List every dependency you import in package.json (or rely on the studio to add well-known ones). Never invent packages that don't exist on npm.`;

/** Compact checklist for the review agents (UI/UX, Visual Design, Frontend) — same bar, terser. */
export const DESIGN_REVIEW_CHECKLIST = `Hold the app to the studio DESIGN BAR: responsive web + mobile (looks intentional at 360px and 1440px, touch targets ≥44px); a cohesive system (4px spacing scale, type hierarchy, constrained palette + accent, consistent radius/shadow, light AND dark); real component libraries (Tailwind + shadcn/ui, Magic UI + Framer Motion, lucide icons) instead of hand-rolled primitives; tasteful, performant motion that honors prefers-reduced-motion; designed loading/empty/error/success states; and accessibility (semantic HTML, labels, visible focus, keyboard nav, contrast ≥4.5:1).`;

/** One-liner for the build-loop FIX stage — fixes must not regress the design. */
export const DESIGN_FIX_NOTE =
  'When a fix touches the UI, preserve (and where trivial, improve) the existing design language — keep it responsive for web + mobile, accessible, and tastefully animated. Never regress to unstyled scaffolding to "just make it build".';

/**
 * The self-customizing layer. Rather than forcing one house style on every app, this tells the
 * model to READ the user's ask, choose an aesthetic that fits it, and commit. This is the
 * "broadly self-customized by the agent depending on the user's ask" behavior — adaptive, but
 * always on top of the non-negotiable charter.
 */
export const buildDesignDirective = (brief: DesignBrief = {}): string => {
  const adapt = brief.refining
    ? `This is an EDIT to an existing app: respect and EXTEND its established design language (its palette, type, spacing, motion and component patterns) — refine and elevate it, don't reinvent it. New UI must feel like it always belonged.`
    : `Before writing code, infer the right design from the request and COMMIT to it: who is this for, what mood fits (e.g. playful, minimal, premium, editorial, technical), one accent-led color story, information density, and how much motion is appropriate. Then apply that language consistently across every screen and component.`;

  return `DESIGN DIRECTIVE (self-customize to THIS request, then hold the bar):
${adapt}

${DESIGN_CHARTER}`;
};

// ---------------------------------------------------------------------------------------------
// Curated, free / open-source tool sources the studio agents can use as MCP tools.
//
// IMPORTANT TRANSPORT NOTE: the app's MCP client (server/src/ai/tools/mcpClient.ts) speaks
// JSON-RPC over HTTPS (with an SSRF guard) — it CANNOT spawn local `npx` stdio servers. So:
//   - transport 'http'  → can be added directly to the studio's default MCP servers.
//   - transport 'stdio' → must be self-hosted as an HTTPS/SSE endpoint first, then pointed at
//     via the matching env var (e.g. STUDIO_SHADCN_MCP_URL). The shadcn server supports this
//     with MCP_TRANSPORT_MODE=sse|dual; Magic/Magic UI can be wrapped with a stdio→HTTP bridge.
// ---------------------------------------------------------------------------------------------

export interface CuratedMcp {
  id: string;
  name: string;
  /** What it gives the agents. */
  what: string;
  transport: 'http' | 'stdio';
  /** Public HTTPS endpoint (http transport) or install hint (stdio transport). */
  endpoint?: string;
  pkg?: string;
  license: string;
  free: boolean;
  /** Env var an operator sets to point at a (self-hosted) HTTPS endpoint for stdio servers. */
  envVar?: string;
}

export const CURATED_MCP_CATALOG: CuratedMcp[] = [
  {
    id: 'context7',
    name: 'Context7',
    what: 'Live, version-correct docs for any library (Tailwind, shadcn, Framer Motion, React, Expo, …) so the model uses real, current APIs instead of hallucinating them.',
    transport: 'http',
    endpoint: 'https://mcp.context7.com/mcp',
    license: 'MIT',
    free: true
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki (GitHub repos)',
    what: 'Turns any public GitHub repo into a searchable wiki so agents can borrow proven patterns/references before building.',
    transport: 'http',
    endpoint: 'https://mcp.deepwiki.com/mcp',
    license: 'open',
    free: true
  },
  {
    id: 'shadcn',
    name: 'shadcn/ui MCP',
    what: 'Real shadcn/ui component source, demos and blocks for React, Svelte, Vue AND React Native (react-native-reusables) — directly serves the web+mobile goal.',
    transport: 'stdio',
    pkg: '@jpisnice/shadcn-ui-mcp-server',
    license: 'MIT',
    free: true,
    envVar: 'STUDIO_SHADCN_MCP_URL'
  },
  {
    id: 'magic',
    name: '21st.dev Magic',
    what: 'AI component builder/refiner + logo search from the 21st.dev component universe.',
    transport: 'stdio',
    pkg: '@21st-dev/magic',
    license: 'proprietary (free tier)',
    free: true,
    envVar: 'STUDIO_MAGIC_MCP_URL'
  },
  {
    id: 'magicui',
    name: 'Magic UI',
    what: 'Animated React + Tailwind components (marquee, blur-fade, shimmer, etc.) for tasteful motion/effects.',
    transport: 'stdio',
    pkg: '@magicuidesign/mcp',
    license: 'MIT',
    free: true,
    envVar: 'STUDIO_MAGICUI_MCP_URL'
  },
  {
    id: 'nango',
    name: 'Nango (800+ API connectors)',
    what: 'Managed OAuth + token refresh + proxy + actions for 800+ third-party APIs, exposed to agents as MCP tools. Self-host (Elastic License v2) and point the studio at its MCP endpoint.',
    transport: 'http',
    license: 'Elastic License v2',
    free: true,
    envVar: 'STUDIO_NANGO_MCP_URL'
  }
];

/** The always-on HTTPS reference MCPs every studio build gets (safe, free, no key required). */
export const ALWAYS_ON_STUDIO_MCP_SERVERS: { id: string; name: string; url: string }[] =
  CURATED_MCP_CATALOG.filter((m) => m.transport === 'http' && m.endpoint)
    .map((m) => ({ id: m.id, name: m.name, url: m.endpoint as string }));

export interface EnvMcpServer {
  id: string;
  name: string;
  url: string;
  /** Operator-configured → may use http / internal hosts (bypasses the user-URL SSRF guard). */
  trusted: true;
  /** Optional auth headers, supplied as JSON via `<ENVVAR>_HEADERS` (e.g. an Authorization bearer). */
  headers?: Record<string, string>;
}

/**
 * Optional MCP servers an operator has self-hosted and pointed at via env vars (the stdio servers
 * above, exposed over HTTP/SSE, plus a self-hosted Nango MCP). Read at call time so deployments add
 * design/connector tools with zero code changes. Marked `trusted` since only the operator sets them;
 * a companion `<ENVVAR>_HEADERS` JSON env attaches auth headers. Invalid/empty URLs are skipped.
 */
export const envDesignMcpServers = (
  env: Record<string, string | undefined> = process.env
): EnvMcpServer[] =>
  CURATED_MCP_CATALOG.filter((m) => m.envVar && env[m.envVar])
    .map((m) => {
      const url = (env[m.envVar as string] as string).trim();
      let headers: Record<string, string> | undefined;
      const raw = env[`${m.envVar}_HEADERS`];
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') headers = parsed as Record<string, string>;
        } catch { /* ignore malformed header JSON */ }
      }
      return { id: m.id, name: m.name, url, trusted: true as const, ...(headers ? { headers } : {}) };
    })
    .filter((s) => /^https?:\/\//i.test(s.url));
