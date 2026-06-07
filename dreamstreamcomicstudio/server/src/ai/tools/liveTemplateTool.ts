// render_live_template — produce a data-driven HTML artifact from an html_template_v1 template
// (HTML + {{ dot.path }} bindings, NO JavaScript) and a data object. Pure + local (no egress); the
// engine HTML-escapes values and rejects any script-bearing markup. For live dashboards/reports.

import type { ChatTool, ToolExecResult } from './types.js';
import { renderLiveTemplate, validateLiveTemplate } from '../studio/liveTemplate.js';

const MAX_OUTPUT = 8000;

const renderTool: ChatTool = {
  name: 'render_live_template',
  description:
    'Render a DATA-DRIVEN HTML artifact: an html_template_v1 template (HTML with {{ dot.path }} bindings, NO JavaScript — no <script>/<iframe>/on*=) plus a data object → safe, HTML-escaped interpolated HTML. Use to build live dashboards/reports that re-render from data.',
  parameters: {
    type: 'object',
    properties: {
      template: { type: 'string', description: 'HTML with {{ path }} bindings (data-only; no scripts/iframes/event handlers).' },
      data: { type: 'object', description: 'Data the bindings resolve against; dot-paths like "users.0.name".' },
    },
    required: ['template'],
  },
  execute: async (args): Promise<ToolExecResult> => {
    const template = String(args?.template || '');
    const check = validateLiveTemplate(template);
    if (!check.ok) return { content: `Template rejected: ${check.reason}. Live templates are data-only HTML (no JS).` };
    try {
      const html = renderLiveTemplate(template, args?.data && typeof args.data === 'object' ? args.data : {});
      const out = html.length > MAX_OUTPUT ? `${html.slice(0, MAX_OUTPUT)}\n<!-- …truncated -->` : html;
      return { content: out };
    } catch (err) {
      return { content: `Render failed: ${(err as Error)?.message || 'unknown error'}` };
    }
  },
};

export const LIVE_TEMPLATE_TOOLS: ChatTool[] = [renderTool];
export const LIVE_TEMPLATE_TOOL_NAMES = LIVE_TEMPLATE_TOOLS.map((t) => t.name);
