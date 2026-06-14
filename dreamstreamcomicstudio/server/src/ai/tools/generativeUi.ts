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
