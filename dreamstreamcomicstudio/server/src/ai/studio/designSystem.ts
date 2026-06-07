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
- USE REAL COMPONENT LIBRARIES, don't hand-roll primitives. Preferred web stack: Tailwind CSS for styling, shadcn/ui (Radix primitives) for accessible components, Magic UI + Framer Motion for animation/effects, lucide-react for icons, recharts/visx only when there is real data to visualize. If the target is a NATIVE mobile app, use Expo + React Native; for styling use NativeWind (Tailwind classes for RN) + react-native-reusables (shadcn-for-RN components) and react-native-reanimated for motion — import "nativewind" and the studio auto-wires babel/metro/tailwind + a global.css for the device build. Keep App.tsx and the source tree at the project root (Expo's entry expects it there).
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

// ---------------------------------------------------------------------------------------------
// Brand-grade design-system presets.
//
// Onboarded from the open-source nexu-io/open-design project (Apache-2.0): its `DESIGN.md` systems
// are markdown design languages injected into an agent's system prompt — the same pattern we use.
// Rather than vendoring its Electron/Next.js app, we curate the design KNOWLEDGE here as concrete,
// pickable design languages, and the agent applies the best-fit per the user's ask (grounding the
// aesthetic in proven systems instead of inventing one from scratch). The full 142-system library
// is also available by self-hosting open-design's MCP server (STUDIO_OPENDESIGN_MCP_URL).
// ---------------------------------------------------------------------------------------------

export interface DesignPreset {
  id: string;
  name: string;
  category: string;
  /** One-line "when to use" for the picker summary. */
  tagline: string;
  /** Prompt keywords that suggest this preset. */
  keywords: string[];
  /** Concrete design language injected when this preset is chosen. */
  directive: string;
}

export const DESIGN_PRESETS: DesignPreset[] = [
  {
    id: 'comic', name: 'DreamStream Comic', category: 'expressive', tagline: 'bold comic-book energy (house style)',
    keywords: ['comic', 'fun', 'bold', 'playful', 'kids', 'game', 'arcade', 'retro'],
    directive: 'Bold comic-book UI: thick 2px black borders, hard offset "comic" shadows, a display/condensed headline font + clean body, a saturated primary plus one accent, high contrast, chunky rounded buttons, and snappy pop/scale motion. Energetic and playful but always legible.'
  },
  {
    id: 'warm-editorial', name: 'Warm Editorial', category: 'editorial', tagline: 'literary, warm, book-like (after open-design "Claude")',
    keywords: ['editorial', 'warm', 'reading', 'blog', 'writing', 'literary', 'magazine', 'docs', 'content'],
    directive: 'Warm editorial "literary salon" (adapted from open-design): a parchment canvas (#f5f4ed), warm-tinted neutrals ONLY (no cool blue-grays), serif headlines (weight 500, tight 1.1–1.3 line-height) + sans body at 1.6 line-height, a terracotta CTA (#c96442), ring-based depth (0 0 0 1px) instead of drop shadows, 8–32px radii, generous spacing, and alternating light/dark sections for a chapter-like rhythm.'
  },
  {
    id: 'minimal-product', name: 'Minimal Product', category: 'product', tagline: 'crisp, monochrome, keyboard-first (Linear/Vercel)',
    keywords: ['minimal', 'clean', 'saas', 'tool', 'productivity', 'developer', 'linear', 'vercel', 'dashboard app'],
    directive: 'Minimal product UI: near-monochrome grayscale with ONE restrained accent, crisp 1px borders, a tight type scale, high information density, subtle fast micro-interactions (120–180ms), first-class dark mode, keyboard-first affordances. Nothing decorative — every element earns its place.'
  },
  {
    id: 'premium-saas', name: 'Premium SaaS', category: 'product', tagline: 'polished, trustworthy, expensive-feeling (Stripe)',
    keywords: ['premium', 'saas', 'landing', 'marketing', 'startup', 'fintech', 'enterprise', 'pricing'],
    directive: 'Premium SaaS: a confident type scale, generous whitespace, refined multi-stop gradients used sparingly, soft layered shadows, smooth 200–300ms easing, and polished empty/loading/success states. Trustworthy and expensive-feeling without being flashy.'
  },
  {
    id: 'playful', name: 'Playful Consumer', category: 'expressive', tagline: 'bright, rounded, delightful (Duolingo)',
    keywords: ['playful', 'consumer', 'social', 'kids', 'learning', 'rewards', 'gamified', 'cute', 'friendly'],
    directive: 'Playful consumer app: a bright saturated palette, big friendly rounded shapes, large rounded type, springy/bouncy motion, generous tap targets, and delightful micro-rewards. Fun and energetic while staying accessible (contrast + reduced-motion).'
  },
  {
    id: 'neobrutalist', name: 'Neobrutalist', category: 'expressive', tagline: 'stark, high-contrast, raw structure',
    keywords: ['brutalist', 'neobrutalism', 'raw', 'bold', 'edgy', 'statement', 'portfolio'],
    directive: 'Neobrutalist: stark high contrast, thick black borders, hard (non-blurred) offset shadows, raw grotesk/mono type, flat saturated blocks, NO gradients, visible structure. Bold and confident — but keep text contrast and tap targets accessible.'
  },
  {
    id: 'glass-aurora', name: 'Glass / Aurora', category: 'expressive', tagline: 'translucent glass over vibrant gradients',
    keywords: ['glass', 'glassmorphism', 'aurora', 'gradient', 'modern', 'crypto', 'web3', 'futuristic'],
    directive: 'Glassmorphism / aurora: translucent blurred panels (backdrop-blur), vibrant gradient/aurora backdrops, soft glows, light hairline borders, and layered depth. Use blur sparingly and keep text on solid-enough surfaces so contrast never drops below 4.5:1.'
  },
  {
    id: 'dark-terminal', name: 'Dark Terminal', category: 'technical', tagline: 'near-black, neon accent, technical',
    keywords: ['terminal', 'cyber', 'hacker', 'dev tool', 'cli', 'code', 'matrix', 'neon', 'dark'],
    directive: 'Dark terminal / cyber: near-black surfaces, a single neon accent, monospace accents, subtle grid lines and glow, crisp dense data. Technical and focused — restrained, not a toy.'
  },
  {
    id: 'ios-native', name: 'iOS Native', category: 'mobile', tagline: 'SF-style, large titles, springy (mobile)',
    keywords: ['ios', 'iphone', 'apple', 'mobile', 'native app', 'app store'],
    directive: 'iOS-native (mobile): SF-style type with large titles, system grays, rounded cards, blurred navigation bars, full-width grouped lists, safe-area insets, smooth spring transitions, and haptic-feeling interactions. Pair with the Expo/React Native target.'
  },
  {
    id: 'material', name: 'Material 3', category: 'mobile', tagline: 'dynamic color, elevation, ripple (Android)',
    keywords: ['material', 'android', 'google', 'mobile', 'm3'],
    directive: 'Material 3: dynamic color tokens, tonal elevation surfaces, FABs, ripple feedback, clear type roles, generous touch targets, and motion with standard easing. Good for Android-leaning or cross-platform apps.'
  },
  {
    id: 'data-dashboard', name: 'Data Dashboard', category: 'product', tagline: 'dense, scannable, chart-first',
    keywords: ['dashboard', 'analytics', 'admin', 'metrics', 'charts', 'report', 'data', 'monitoring', 'finance'],
    directive: 'Data-dense dashboard: compact spacing, tabular numerals, a muted neutral palette with semantic accents (success/warn/error), strong hierarchy, minimal motion, and excellent charts + tables that stay scannable at a glance.'
  },
  {
    id: 'luxury-editorial', name: 'Luxury Editorial', category: 'editorial', tagline: 'dramatic serif, vast whitespace, aspirational',
    keywords: ['luxury', 'fashion', 'brand', 'agency', 'portfolio', 'gallery', 'photography', 'elegant', 'premium brand'],
    directive: 'Luxury editorial / fashion: dramatic high-contrast serif display, vast negative space, large full-bleed imagery, a restrained near-monochrome palette with one accent, and slow elegant transitions. Refined and aspirational.'
  },
  {
    id: 'swiss', name: 'Swiss / International', category: 'editorial', tagline: 'grid-driven, objective, Helvetica-like',
    keywords: ['swiss', 'international', 'typographic', 'grid', 'minimalist', 'objective', 'bauhaus'],
    directive: 'Swiss / International Typographic: a strict modular grid, a neutral grotesk (Helvetica/Inter), flush-left ragged-right text, generous margins, mostly black/white/red, asymmetric balance, and near-zero decoration. Objective, precise, content-led.'
  },
  {
    id: 'bento', name: 'Bento Grid', category: 'product', tagline: 'modular rounded tiles (Apple-keynote style)',
    keywords: ['bento', 'grid', 'landing', 'feature', 'showcase', 'overview', 'tiles'],
    directive: 'Bento-grid layout: a responsive grid of rounded modular cards of varied sizes, each a self-contained feature/visual, soft shadows, consistent radius and gap, restrained palette with accent highlights, and subtle hover lift. Great for landing pages + overviews.'
  },
  {
    id: 'synthwave', name: 'Synthwave / Retro 80s', category: 'expressive', tagline: 'neon sunset, grids, retro-future',
    keywords: ['synthwave', 'retro', '80s', 'neon', 'vaporwave', 'arcade', 'outrun', 'retrowave'],
    directive: 'Synthwave / retro-80s: deep indigo-to-magenta sunset gradients, neon pink/cyan glows, perspective grid horizons, chrome/outline display type, and tasteful glow/scanline accents. Bold and nostalgic — keep body text on solid panels for contrast.'
  },
  {
    id: 'corporate-trust', name: 'Corporate Trust', category: 'product', tagline: 'calm, accessible, dependable (health/finance/gov)',
    keywords: ['corporate', 'healthcare', 'medical', 'finance', 'bank', 'insurance', 'government', 'enterprise', 'b2b', 'trust'],
    directive: 'Corporate trust: a calm, accessible palette (dependable blues/teals + neutral grays), clear hierarchy, comfortable reading sizes, conservative spacing, restrained motion, and obvious affordances. Prioritize clarity, accessibility (WCAG AA+) and credibility over flair.'
  },
  {
    id: 'ecommerce', name: 'E-commerce / Storefront', category: 'product', tagline: 'conversion-first product UI',
    keywords: ['ecommerce', 'shop', 'store', 'storefront', 'product', 'cart', 'checkout', 'retail', 'marketplace'],
    directive: 'Conversion-focused storefront: crisp product cards with strong imagery, clear price + primary CTA, trust signals (ratings, returns, secure checkout), sticky add-to-cart, fast filtering, and a clean grid. Reduce friction; make the buy action unmissable.'
  },
  {
    id: 'workspace', name: 'Calm Workspace', category: 'product', tagline: 'content-first productivity (Notion-like)',
    keywords: ['notion', 'workspace', 'docs', 'notes', 'wiki', 'productivity', 'editor', 'knowledge'],
    directive: 'Calm productivity workspace: a quiet neutral palette, content-first layout with a slim sidebar, comfortable typography, subtle dividers instead of heavy borders, hover-revealed controls, and minimal chrome so the user\'s content is the hero.'
  },
  {
    id: 'pastel-soft', name: 'Soft Pastel', category: 'expressive', tagline: 'gentle, rounded, wellness/calm',
    keywords: ['pastel', 'soft', 'wellness', 'calm', 'meditation', 'health', 'gentle', 'cozy', 'mindful'],
    directive: 'Soft pastel: muted pastel palette, large radii, airy spacing, gentle soft shadows, rounded friendly type, and slow easing. Warm and calming — keep enough contrast for legibility (don\'t wash text out).'
  },
  {
    id: 'gradient-mesh', name: 'Gradient Mesh', category: 'expressive', tagline: 'vivid mesh gradients, modern marketing',
    keywords: ['gradient', 'mesh', 'colorful', 'marketing', 'modern', 'vibrant', 'ai', 'launch'],
    directive: 'Vivid gradient-mesh: lush multi-color mesh/blob gradient backgrounds, white or near-black foreground panels for legibility, bold display headings, glassy accents, and smooth reveal motion. Energetic and modern — keep text off the busiest gradient areas.'
  },
  {
    id: 'claymorphism', name: 'Claymorphism', category: 'expressive', tagline: 'soft 3D clay, puffy depth',
    keywords: ['clay', 'claymorphism', '3d', 'puffy', 'soft ui', 'cute', 'rounded'],
    directive: 'Claymorphism: soft 3D "clay" surfaces with double (inner light + outer soft) shadows, big rounded shapes, playful saturated-but-soft palette, and squishy press motion. Friendly and tactile; keep contrast on text elements.'
  },
  {
    id: 'a11y-first', name: 'Accessibility-First', category: 'product', tagline: 'WCAG AAA, large, high-contrast, keyboard',
    keywords: ['accessible', 'accessibility', 'a11y', 'wcag', 'inclusive', 'low vision', 'high contrast', 'senior'],
    directive: 'Accessibility-first: WCAG AAA contrast, large base font (≥18px) and tap targets (≥48px), highly visible focus rings, full keyboard + screen-reader support (semantic landmarks, ARIA, skip links), no motion-dependence (honor prefers-reduced-motion), clear error text. Usable by everyone.'
  },
  {
    id: 'magazine', name: 'Magazine / Print', category: 'editorial', tagline: 'columns, drop caps, editorial grid',
    keywords: ['magazine', 'print', 'news', 'article', 'journal', 'editorial grid', 'publication'],
    directive: 'Magazine / print editorial: a multi-column grid, expressive serif headlines with drop caps, pull quotes, refined hierarchy, hairline rules, and image-led spreads. Reads like a publication; keep responsive single-column on mobile.'
  },
  {
    id: 'developer-docs', name: 'Developer Docs', category: 'technical', tagline: 'sidebar nav, code-first, readable',
    keywords: ['docs', 'documentation', 'api reference', 'developer', 'guide', 'sdk', 'reference'],
    directive: 'Developer docs: a persistent sidebar nav + on-page TOC, generous readable measure, first-class syntax-highlighted code blocks with copy buttons, callout/admonition styles, anchored headings, and fast search. Optimized for scanning and copy-paste; great dark mode.'
  },
  {
    id: 'monospace', name: 'Monospace Minimal', category: 'technical', tagline: 'strict mono, ascii-clean, minimal',
    keywords: ['monospace', 'mono', 'ascii', 'minimal', 'terminal-lite', 'indie', 'maker'],
    directive: 'Monospace-minimal: a single monospace family throughout, strict near-monochrome palette, hairline borders, tight grid, ASCII-clean dividers, and almost no color except one accent. Crisp, technical, indie-maker aesthetic.'
  },
  {
    id: 'kids-bright', name: 'Kids / Education', category: 'expressive', tagline: 'big, bright, friendly, safe',
    keywords: ['kids', 'children', 'education', 'school', 'learning', 'teach', 'classroom', 'toddler'],
    directive: 'Kids / education: big bright primary colors, large rounded friendly shapes and type, generous tap targets, simple obvious navigation, cheerful illustrations/mascots, encouraging feedback, and playful but gentle motion. Safe, legible, and easy for small hands.'
  }
];

/** Heuristically pick the best-fit preset from the prompt (or null when nothing clearly matches). */
export const pickDesignPreset = (prompt?: string): DesignPreset | null => {
  const p = (prompt || '').toLowerCase();
  if (!p.trim()) return null;
  let best: { preset: DesignPreset; score: number } | null = null;
  for (const preset of DESIGN_PRESETS) {
    const score = preset.keywords.reduce((n, k) => (p.includes(k) ? n + 1 : n), 0);
    if (score > 0 && (!best || score > best.score)) best = { preset, score };
  }
  return best?.preset ?? null;
};

/** Compact, model-facing list of the available design systems. */
export const presetLibrarySummary = (): string =>
  DESIGN_PRESETS.map((p) => `- ${p.name} (${p.category}) — ${p.tagline}`).join('\n');

/**
 * The self-customizing layer. Rather than forcing one house style on every app, this gives the
 * model a curated library of brand-grade design systems (onboarded from open-design), recommends
 * the best fit for the request, and tells it to commit — adaptive, but always on the charter.
 */
export const buildDesignDirective = (brief: DesignBrief = {}): string => {
  const adapt = brief.refining
    ? `This is an EDIT to an existing app: respect and EXTEND its established design language (its palette, type, spacing, motion and component patterns) — refine and elevate it, don't reinvent it. New UI must feel like it always belonged.`
    : `Before writing code, infer the right design from the request and COMMIT to it: who is this for, what mood fits, one accent-led color story, information density, and how much motion is appropriate. Then apply that language consistently across every screen and component.`;

  const preset = brief.refining ? null : pickDesignPreset(brief.prompt);
  const library = brief.refining
    ? ''
    : `\nDESIGN-SYSTEM LIBRARY — pick the brand-grade system that best fits this request and apply it fully (or commit to an equally strong custom one):\n${presetLibrarySummary()}${preset ? `\n\nRecommended for THIS request — **${preset.name}**:\n${preset.directive}` : ''}\n`;

  return `DESIGN DIRECTIVE (self-customize to THIS request, then hold the bar):
${adapt}
${library}
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
    id: 'opendesign',
    name: 'Open Design (local design assets via MCP)',
    what: "nexu-io/open-design's stdio MCP server (od mcp install) exposes a LOCAL Open Design instance via od search-files / get-file / get-artifact / plugin run (loopback by default) — i.e. it reads YOUR local OD projects, it is not a hosted design-system catalog. The brand-grade design SYSTEMS themselves are onboarded directly as DESIGN_PRESETS (Apache-2.0 DESIGN.md content).",
    transport: 'stdio',
    pkg: 'open-design (od mcp install)',
    license: 'Apache-2.0',
    free: true,
    envVar: 'STUDIO_OPENDESIGN_MCP_URL'
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

/**
 * Privacy / data-egress control. The always-on reference MCPs (Context7, DeepWiki) send the agent's
 * context — which can include the user's prompt and generated code — to THIRD-PARTY servers. Set
 * STUDIO_DISABLE_EXTERNAL_MCP=1 to turn them off for privacy-sensitive / no-egress deployments;
 * operator self-hosted MCPs (STUDIO_*_MCP_URL) and the user's own saved MCPs still work, and the
 * vendored design knowledge (DESIGN_PRESETS) never makes a network call at all.
 */
export const externalMcpEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  !/^(1|true|yes|on)$/i.test((env.STUDIO_DISABLE_EXTERNAL_MCP || '').trim());
