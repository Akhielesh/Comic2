// Modular tool registry for the agentic chat loop.
//
// Every capability the chat agent can use — DuckDuckGo today, custom MCP servers
// tomorrow — is a `ChatTool` registered here. The chat loop only ever sees this
// uniform interface, so adding a connector never touches the loop or the routes.

import type { ToolSpec } from '../providers/types.js';
import { ddgWebSearch, ddgImageSearch, type ImageResult } from './duckduckgo.js';

export interface ToolExecResult {
  /** Text fed back to the model as the tool result. */
  content: string;
  /** Images to surface in the UI (image search). */
  images?: { url: string; title?: string; thumbnail?: string; source?: string }[];
  /** Web citations to surface in the "sources" panel. */
  citations?: { url: string; title?: string }[];
}

export interface ChatTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolExecResult>;
}

const webSearchTool: ChatTool = {
  name: 'web_search',
  description:
    'Search the live web via DuckDuckGo for current, factual, or post-training information. Returns ranked results with titles, URLs and snippets. Use it whenever the user asks about recent events, specific facts, products, docs, or anything you are unsure about.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' }
    },
    required: ['query']
  },
  execute: async (args, signal) => {
    const query = String(args?.query || '').trim();
    if (!query) return { content: 'No search query was provided.' };
    try {
      const results = await ddgWebSearch(query, signal);
      if (!results.length) return { content: `No web results found for "${query}".` };
      const content = results
        .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`)
        .join('\n\n');
      return { content, citations: results.map((r) => ({ url: r.url, title: r.title })) };
    } catch (err) {
      return { content: `Web search failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

const imageSearchTool: ChatTool = {
  name: 'image_search',
  description:
    'Find images on the web via DuckDuckGo. Use ONLY when the user explicitly wants to see images/pictures/photos of something. Returns image URLs which will be shown to the user; reference them naturally in your answer.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to find images of.' }
    },
    required: ['query']
  },
  execute: async (args, signal) => {
    const query = String(args?.query || '').trim();
    if (!query) return { content: 'No image query was provided.' };
    try {
      const results: ImageResult[] = await ddgImageSearch(query, signal);
      if (!results.length) return { content: `No images found for "${query}".` };
      const content = `Found ${results.length} images for "${query}":\n${results
        .map((r, i) => `[${i + 1}] ${r.title || 'image'} — ${r.url}`)
        .join('\n')}`;
      return { content, images: results };
    } catch (err) {
      return { content: `Image search failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

/** All built-in tools, keyed by the name the model/clients reference. */
export const BUILTIN_TOOLS: Record<string, ChatTool> = {
  web_search: webSearchTool,
  image_search: imageSearchTool
};

/** The set of tool names a client is allowed to enable (allowlist). */
export const KNOWN_TOOL_NAMES = Object.keys(BUILTIN_TOOLS);

/** Resolve an allowlisted set of tool names to their implementations. */
export const resolveTools = (names: string[] | undefined): ChatTool[] => {
  if (!Array.isArray(names)) return [];
  const seen = new Set<string>();
  const tools: ChatTool[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    const tool = BUILTIN_TOOLS[name];
    if (tool) {
      tools.push(tool);
      seen.add(name);
    }
  }
  return tools;
};

/** Convert a ChatTool to the OpenAI-compatible spec sent to the provider. */
export const toToolSpec = (tool: ChatTool): ToolSpec => ({
  type: 'function',
  function: { name: tool.name, description: tool.description, parameters: tool.parameters }
});
