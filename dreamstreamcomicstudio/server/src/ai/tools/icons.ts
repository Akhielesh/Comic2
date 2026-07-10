// icon_search — search 200k+ open-source SVG icons via the free Iconify API and
// return a pickable grid. Free, no key. Iconify aggregates Lucide, Material Symbols,
// Heroicons, Tabler, Phosphor, Simple Icons (brand logos) and 150+ more sets.
//
// Security: icon SVG bodies are inlined client-side (so they inherit the theme's
// currentColor), so this tool is the trust boundary — it ONLY ever fetches from the
// fixed Iconify host and runs every body through `sanitizeIconBody` (drops anything
// with <script>, event handlers, <foreignObject>, etc.) before it reaches the client.

import type { ChatTool, ToolExecResult } from './types.js';
import { fetchJson } from './http.js';

const ICONIFY = 'https://api.iconify.design';
const MAX_ICONS = 30;
const MAX_SETS = 8;

export interface IconHit {
  /** Iconify id, "set:name" (e.g. "lucide:rocket"). */
  id: string;
  name: string;
  prefix: string;
  /** Inner SVG markup (paths/shapes), sanitized. */
  body: string;
  width: number;
  height: number;
}

interface IconifySearch {
  icons?: string[];
  total?: number;
}
interface IconifyCollection {
  width?: number;
  height?: number;
  icons?: Record<string, { body: string; width?: number; height?: number }>;
}

/**
 * Defensive sanitizer for an Iconify icon body. Iconify bodies are path/shape markup,
 * but since we inline them, never let anything executable through. Returns the body
 * when safe, or null to drop the icon.
 */
export const sanitizeIconBody = (body: unknown): string | null => {
  if (typeof body !== 'string') return null;
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (/<\s*script/i.test(trimmed)) return null;
  if (/<\s*foreignObject/i.test(trimmed)) return null;
  if (/<\s*iframe/i.test(trimmed)) return null;
  if (/<!|<\?/.test(trimmed)) return null; // comments / processing instructions / CDATA
  if (/\son[a-z]+\s*=/i.test(trimmed)) return null; // onload=, onclick=, …
  if (/(javascript|data):/i.test(trimmed)) return null;
  return trimmed;
};

/** Group "set:name" ids by their set prefix, preserving first-seen order. */
export const groupByPrefix = (ids: string[]): Map<string, string[]> => {
  const m = new Map<string, string[]>();
  for (const id of ids) {
    const idx = id.indexOf(':');
    if (idx <= 0) continue;
    const prefix = id.slice(0, idx);
    const name = id.slice(idx + 1);
    if (!prefix || !name) continue;
    if (!m.has(prefix)) m.set(prefix, []);
    m.get(prefix)!.push(name);
  }
  return m;
};

export const iconSearchTool: ChatTool = {
  name: 'icon_search',
  description:
    'Search 200,000+ open-source SVG icons (Lucide, Material Symbols, Heroicons, Tabler, Phosphor, Simple Icons brand logos, and 150+ more sets) via Iconify and show a pickable grid. Use when the user wants an icon/glyph/logo for a UI, or when you need the right icon to reference in a component or app (each result has an id like "lucide:rocket"). Free, no key required.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to find, e.g. "rocket", "shopping cart", "github logo".' },
      limit: { type: 'number', description: 'How many icons to show (1–30, default 24).' }
    },
    required: ['query']
  },
  execute: async (args, signal): Promise<ToolExecResult> => {
    const query = String(args?.query || '').trim();
    if (!query) return { content: 'Provide something to search for, e.g. "rocket" or "shopping cart".' };
    const limit = Math.min(30, Math.max(1, Math.floor(Number(args?.limit) || 24)));
    try {
      const search = await fetchJson<IconifySearch>(
        `${ICONIFY}/search?query=${encodeURIComponent(query)}&limit=${limit}`,
        { signal }
      );
      const ids = Array.isArray(search.icons) ? search.icons.slice(0, MAX_ICONS) : [];
      if (!ids.length) {
        return { content: `No icons found for "${query}". Try a simpler term (e.g. "cart" instead of "shopping trolley").` };
      }
      const byPrefix = groupByPrefix(ids);
      const hits: IconHit[] = [];
      // One collection fetch per set (bounded), each returning the bodies for the
      // requested names — far fewer requests than fetching each icon individually.
      for (const [prefix, names] of [...byPrefix.entries()].slice(0, MAX_SETS)) {
        try {
          const coll = await fetchJson<IconifyCollection>(
            `${ICONIFY}/${encodeURIComponent(prefix)}.json?icons=${names.map(encodeURIComponent).join(',')}`,
            { signal }
          );
          const setW = coll.width || 24;
          const setH = coll.height || 24;
          for (const name of names) {
            const ic = coll.icons?.[name];
            const body = sanitizeIconBody(ic?.body);
            if (!body) continue;
            hits.push({ id: `${prefix}:${name}`, name, prefix, body, width: ic?.width || setW, height: ic?.height || setH });
          }
        } catch {
          /* a single set failing must not sink the whole result */
        }
      }
      if (!hits.length) {
        return { content: `Found matches for "${query}" but couldn't load their SVGs just now — please try again.` };
      }
      // Restore the relevance order Iconify returned.
      const order = new Map(ids.map((id, i) => [id, i] as const));
      hits.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      return {
        content: `Found ${hits.length} icon(s) for "${query}": ${hits.map((h) => h.id).join(', ')}. Each id is "set:name" (Iconify) — reference one in a component/app, or tell the user which to use.`,
        artifacts: [{ type: 'icon_set', data: { query, total: typeof search.total === 'number' ? search.total : hits.length, icons: hits } }]
      };
    } catch (err) {
      return {
        content: `Icon search failed: ${(err as Error)?.message || 'unknown error'}.`,
        notice: { level: 'error', message: 'Iconify lookup failed.' }
      };
    }
  }
};
