// Modular tool registry for the agentic chat loop.
//
// Every capability the chat agent can use — DuckDuckGo today, custom MCP servers
// tomorrow — is a `ChatTool` registered here. The chat loop only ever sees this
// uniform interface, so adding a connector never touches the loop or the routes.

import type { ToolSpec } from '../providers/types.js';
import type { ChatArtifact } from '../../../../apiTypes.js';
import { ddgWebSearch, ddgImageSearch, ddgVideoSearch, type ImageResult } from './duckduckgo.js';
import { getWeather } from './weather.js';
import { geocodePlaces } from './maps.js';

export interface ToolExecResult {
  /** Text fed back to the model as the tool result. */
  content: string;
  /** Images to surface in the UI (image search). */
  images?: { url: string; title?: string; thumbnail?: string; source?: string }[];
  /** Web citations to surface in the "sources" panel. */
  citations?: { url: string; title?: string }[];
  /** Typed rich-output artifacts (weather, etc.) rendered as components. */
  artifacts?: ChatArtifact[];
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

const weatherTool: ChatTool = {
  name: 'get_weather',
  description:
    'Get current weather and a short forecast for a place. Use whenever the user asks about weather, temperature, rain, or forecast. Returns a weather card shown to the user — keep your text brief and let the card carry the detail.',
  parameters: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City or place name, e.g. "Tokyo" or "Austin, TX".' }
    },
    required: ['location']
  },
  execute: async (args, signal) => {
    const location = String(args?.location || '').trim();
    if (!location) return { content: 'No location was provided.' };
    try {
      const weather = await getWeather(location, signal);
      const content = `Weather for ${weather.location}: ${weather.current.tempC}°C (${weather.current.tempF}°F), ${weather.current.description}, wind ${weather.current.windKph} km/h. A weather card with the 5-day forecast is shown to the user.`;
      return { content, artifacts: [{ type: 'weather', data: weather }] };
    } catch (err) {
      return { content: `Weather lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

const videoSearchTool: ChatTool = {
  name: 'video_search',
  description:
    'Find videos (tutorials, how-tos, reviews, clips) via DuckDuckGo. Use whenever the user wants to watch or see how to do something (e.g. "how to make X"), or asks for videos/tutorials — alongside a normal web_search for text. Returns video cards shown to the user.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What videos to find.' }
    },
    required: ['query']
  },
  execute: async (args, signal) => {
    const query = String(args?.query || '').trim();
    if (!query) return { content: 'No video query was provided.' };
    try {
      const results = await ddgVideoSearch(query, signal);
      if (!results.length) return { content: `No videos found for "${query}".` };
      const content = `Found ${results.length} videos for "${query}":\n${results
        .map((r, i) => `[${i + 1}] ${r.title}${r.publisher ? ` — ${r.publisher}` : ''} (${r.url})`)
        .join('\n')}`;
      return { content, artifacts: [{ type: 'video_results', data: { query, results } }] };
    } catch (err) {
      return { content: `Video search failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

const mapTool: ChatTool = {
  name: 'show_map',
  description:
    'Show an interactive map. Use whenever the user asks about a location, place, directions/route between places, "where is…", or wants to see somewhere on a map. Pass the place names; they are geocoded and shown as markers (in order) in a side panel. Keep your text brief and let the map carry it.',
  parameters: {
    type: 'object',
    properties: {
      places: {
        type: 'array',
        items: { type: 'string' },
        description: 'Place names / addresses to show, in order (e.g. ["Eiffel Tower", "Louvre"]).'
      },
      title: { type: 'string', description: 'Optional title for the map.' },
      route: { type: 'boolean', description: 'Set true to draw a path connecting the places in order.' }
    },
    required: ['places']
  },
  execute: async (args, signal) => {
    const places = Array.isArray(args?.places) ? (args.places as unknown[]).map((p) => String(p)).filter(Boolean) : [];
    if (!places.length) return { content: 'No places were provided for the map.' };
    try {
      const markers = await geocodePlaces(places, signal);
      if (!markers.length) return { content: `Couldn't locate any of: ${places.join(', ')}.` };
      const route = args?.route && markers.length > 1 ? markers.map((m) => ({ lat: m.lat, lng: m.lng })) : undefined;
      const content = `Showing a map with ${markers.length} location(s): ${markers.map((m) => m.label).join(', ')}. The interactive map is shown to the user.`;
      return {
        content,
        artifacts: [{ type: 'map', data: { title: typeof args?.title === 'string' ? args.title : undefined, markers, route } }]
      };
    } catch (err) {
      return { content: `Map lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

/** All built-in tools, keyed by the name the model/clients reference. */
export const BUILTIN_TOOLS: Record<string, ChatTool> = {
  web_search: webSearchTool,
  image_search: imageSearchTool,
  video_search: videoSearchTool,
  get_weather: weatherTool,
  show_map: mapTool
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
