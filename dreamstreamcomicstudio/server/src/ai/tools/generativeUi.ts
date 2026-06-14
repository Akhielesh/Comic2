import type { ChatTool } from './types.js';

// `render_ui` — lets the model compose a BESPOKE in-chat layout from a whitelisted
// block tree when no fixed card (chart, table, metric board…) fits the answer. The
// server bounds the payload (node + depth caps) so an oversized/hostile tree can't
// blow up context or storage; the CLIENT (GenerativeUICard) does the full
// normalization (prop coercion, image-src allowlisting, unknown-block dropping) before
// anything reaches the DOM. No raw HTML, no code execution — arbitrary HTML stays in
// the iframe-sandboxed code path.

const MAX_NODES = 200;
const MAX_DEPTH = 8;

function countTree(node: unknown, depth: number, ctx: { n: number; tooDeep: boolean }): void {
  if (depth > MAX_DEPTH) {
    ctx.tooDeep = true;
    return;
  }
  if (!node || typeof node !== 'object') return;
  ctx.n += 1;
  const children = (node as { children?: unknown }).children;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (ctx.n > MAX_NODES) return;
      countTree(child, depth + 1, ctx);
    }
  }
}

const BLOCK_GUIDE = [
  'Each block is an object with a "kind". Layout blocks nest others via "children":',
  '- stack {gap?:0-4, align?, children[]} — vertical',
  '- row {gap?, align?, wrap?, children[]} — horizontal',
  '- grid {columns?:1-4, gap?, children[]}',
  '- section {title?, accent?, children[]}',
  '- divider {}',
  'Content blocks:',
  '- heading {text, level?:1-3}',
  '- text {text, tone?:default|muted|strong, align?:left|center|right}',
  '- badge {text, tone?:neutral|good|warn|bad|info}',
  '- pill {label?, change?, changePercent?}',
  '- keyValue {items:[{label,value}]}',
  '- steps {items:[{title, text?}]} — numbered how-to / process steps',
  '- quote {text, author?} — pull quote / testimonial',
  '- callout {tone?:info|good|warn|bad, title?, text}',
  '- image {src(https/data-image only), alt?, caption?, ratio?:1:1|4:3|16:9}',
  '- progress {value, max?, label?}',
  '- rating {value:0-5, max?, count?, label?} — star rating',
  '- tags {items:string[]} — a row of chips',
  '- timeline {items:[{title, time?, text?, accent?}]} — vertical dated timeline (trips, processes, histories)',
  'Data-viz blocks:',
  '- metric {label, value, unit?, delta?, deltaPercent?, spark?:number[]}',
  '- sparkline {values:number[]}',
  '- gauge {value, max?, label?, unit?, color?} — radial gauge',
  '- bars {items:[{label, value, color?}], max?} — labeled horizontal bars (quick category breakdown)',
  '- chart {chart:<same shape as render_chart>}',
  '- table {table:<same shape as render_table>}',
  '- map {markers:[{lat, lng, label, category?}], connect?} — an interactive map; set connect:true to draw a route through the markers in order (only with real coordinates you know)'
].join('\n');

export const generativeUiTool: ChatTool = {
  name: 'render_ui',
  description:
    'Compose a CUSTOM in-chat layout from building blocks when no single fixed card (render_chart, render_table, show_metrics…) fits — e.g. a mini dashboard, a side-by-side comparison, a structured summary with sections, metrics, an embedded chart and a callout. You control structure and alignment via stack/row/grid/section containers. Build a tree under `root`. Prefer the dedicated tools for a single chart/table; use this when you need to ARRANGE several elements into one bespoke, well-aligned response. A polished card is shown to the user; keep prose brief.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Optional card title.' },
      subtitle: { type: 'string' },
      accent: { type: 'string', description: 'Optional accent hex, e.g. "#3B82F6".' },
      palette: { type: 'string', enum: ['brand', 'ocean', 'sunset', 'violet', 'bull', 'bear', 'mono'] },
      root: {
        type: 'object',
        description: `The root block (usually a stack or grid). ${BLOCK_GUIDE}`
      }
    },
    required: ['root']
  },
  execute: async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const root = a.root;
    if (!root || typeof root !== 'object') {
      return { content: 'No layout was provided — render_ui needs a `root` block (e.g. a stack or grid of children).' };
    }
    const ctx = { n: 0, tooDeep: false };
    countTree(root, 0, ctx);
    if (ctx.tooDeep || ctx.n > MAX_NODES) {
      return {
        content: `That layout is too large to render (limit ${MAX_NODES} blocks / depth ${MAX_DEPTH}). Simplify it into fewer blocks, or use render_chart / render_table for a single visual.`
      };
    }
    const str = (k: string): string | undefined => (typeof a[k] === 'string' ? (a[k] as string).slice(0, 400) : undefined);
    const data = { title: str('title'), subtitle: str('subtitle'), accent: str('accent'), palette: str('palette'), root };
    return {
      content: `Composed a custom layout (${ctx.n} block${ctx.n === 1 ? '' : 's'})${data.title ? ` — "${data.title}"` : ''}. A generative UI card is shown to the user.`,
      artifacts: [{ type: 'generative_ui', data }]
    };
  }
};

// `render_react` — a fully-custom widget: the model writes a self-contained React
// component which the CLIENT runs in a sandboxed iframe (Sandpack) on demand. The
// server only bounds size + coerces deps; the iframe is the isolation boundary. This
// is the in-house substrate for "custom widgets on demand" (and where a 21st.dev /
// shadcn MCP's generated TSX will land, unchanged).
const coerceDeps = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof k === 'string' && typeof val === 'string' && k.length < 100 && val.length < 60) out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
};

export const renderReactTool: ChatTool = {
  name: 'render_react',
  description:
    'Render a BESPOKE, fully-custom interactive widget by writing a self-contained React component (TSX). Use this ONLY when render_ui\'s block kit genuinely cannot express what is needed — a custom interaction, a small tool/calculator/simulator, or a novel visualization. Provide `code`: a COMPLETE module that DEFAULT-EXPORTS a React component (`export default function App() { … }`), using React + inline styles (or list extra npm packages in `dependencies`). It runs in a SANDBOXED iframe (no access to the page, cookies, storage or our data). Keep it small and self-contained. Prefer render_ui / render_chart / render_table for standard data displays; reach for this when the user wants something genuinely custom.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'A complete TSX module that default-exports a React component: `export default function App() { … }`.' },
      title: { type: 'string', description: 'Short widget title.' },
      description: { type: 'string', description: 'One-line description of what it does.' },
      height: { type: 'number', description: 'Preview height in px (default 320, max 720).' },
      dependencies: { type: 'object', description: 'Optional extra npm deps as { "name": "semver" }, e.g. { "recharts": "2.x" }.' }
    },
    required: ['code']
  },
  execute: async (args) => {
    const code = typeof args?.code === 'string' ? args.code : '';
    if (!code.trim()) return { content: 'No component code was provided to render_react.' };
    if (code.length > 24000) return { content: 'The component code is too large — keep custom widgets compact and self-contained.' };
    const height = typeof args?.height === 'number' && Number.isFinite(args.height) ? Math.max(160, Math.min(720, args.height)) : undefined;
    const data = {
      code,
      title: typeof args?.title === 'string' ? args.title : undefined,
      description: typeof args?.description === 'string' ? args.description : undefined,
      height,
      dependencies: coerceDeps(args?.dependencies)
    };
    return {
      content: 'A custom interactive React component is shown to the user (it runs sandboxed; they tap "Run"). Briefly say what it does and how to use it — do NOT paste the code.',
      artifacts: [{ type: 'react_component', data }]
    };
  }
};
