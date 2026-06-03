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
import { fetchNews } from './news.js';
import { getStockQuote } from './stocks.js';
import { findPlaces } from './places.js';

/**
 * Per-request situational context made available to tools that benefit from it
 * (news region/language, "near me" geocoding, unit defaults). Threaded in from
 * the validated ChatClientContext so tools default sensibly when the model
 * doesn't specify a region/location explicitly.
 */
export interface ToolContext {
  timezone?: string;
  locale?: string;
  units?: 'metric' | 'imperial';
  location?: { city?: string; region?: string; country?: string; lat?: number; lng?: number };
}

// Derive Google-News-style region/language from the user's context: prefer an
// explicit country, else the country segment of the locale (e.g. "en-US" ⇒ US).
const regionLangFromCtx = (ctx?: ToolContext): { region?: string; lang?: string } => {
  const locale = ctx?.locale || '';
  const parts = locale.split('-');
  const lang = parts[0] || undefined;
  const region = ctx?.location?.country || (parts[1] ? parts[1].toUpperCase() : undefined);
  return { region, lang };
};

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

// News is context-aware (region/language default from the user's locale), so it's
// built per-request via a factory rather than held as a static singleton.
const makeNewsTool = (ctx?: ToolContext): ChatTool => ({
  name: 'get_news',
  description:
    'Get the latest news headlines from real news outlets (via Google News). Use this — NOT web_search — whenever the user asks for news, headlines, "latest", "what\'s happening", or news on a topic/place. Provide a `query` for a topic ("Apple Vision Pro", "Bitcoin") OR a `topic` section for general feeds. Returns a news card with sourced, dated headlines shown to the user; summarize the top items briefly and cite them.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Topic/keywords to search news for. Omit for general/top headlines.'
      },
      topic: {
        type: 'string',
        enum: ['top', 'world', 'business', 'technology', 'entertainment', 'sports', 'science', 'health', 'politics'],
        description: 'A general news section when there is no specific query.'
      }
    }
  },
  execute: async (args, signal) => {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    const topic = typeof args?.topic === 'string' ? args.topic.trim() : '';
    const { region, lang } = regionLangFromCtx(ctx);
    try {
      const data = await fetchNews({ query, topic, region, lang }, signal);
      if (!data.items.length) {
        return { content: `No news found for "${query || topic || 'top headlines'}".` };
      }
      const label = query || (topic ? `${topic} news` : 'top headlines');
      const content = `Latest ${label}${region ? ` (${region})` : ''}:\n${data.items
        .map(
          (n, i) =>
            `[${i + 1}] ${n.title}${n.source ? ` — ${n.source}` : ''}${
              n.publishedAt ? ` (${n.publishedAt.slice(0, 10)})` : ''
            }\n${n.url}`
        )
        .join('\n\n')}`;
      return {
        content,
        citations: data.items.map((n) => ({ url: n.url, title: n.title })),
        artifacts: [{ type: 'news_results', data }]
      };
    } catch (err) {
      return { content: `News lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
});

const stockTool: ChatTool = {
  name: 'get_stock',
  description:
    'Get a live stock, ETF or index quote with a recent price history. Use whenever the user asks about a stock price, ticker, market, or how a company/index is doing. Pass a ticker symbol (e.g. "AAPL", "MSFT", "^SPX"). Returns a quote card with price, daily change and a chart shown to the user — keep prose brief and let the card carry the detail.',
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Ticker symbol, e.g. "AAPL", "TSLA", or an index like "^SPX".' }
    },
    required: ['symbol']
  },
  execute: async (args, signal) => {
    const symbol = String(args?.symbol || '').trim();
    if (!symbol) return { content: 'No ticker symbol was provided.' };
    try {
      const q = await getStockQuote(symbol, signal);
      const dir = q.change > 0 ? '▲' : q.change < 0 ? '▼' : '■';
      const content = `${q.name || q.symbol} (${q.symbol}): ${q.price.toFixed(2)} ${dir} ${q.change >= 0 ? '+' : ''}${q.change.toFixed(2)} (${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}%)${q.asOf ? ` as of ${q.asOf}` : ''}. A quote card with a chart is shown to the user.`;
      return { content, artifacts: [{ type: 'stock_quote', data: q }] };
    } catch (err) {
      return { content: `Stock lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

// Local/places search is context-aware ("near me" + distances use the user's
// location), so it's built per-request via a factory.
const makePlacesTool = (ctx?: ToolContext): ChatTool => ({
  name: 'find_places',
  description:
    'Find real nearby places / points of interest (restaurants, cafes, bars, hotels, pharmacies, ATMs, shops, attractions, etc.) with distance, address, hours, website and a map. Use this — NOT show_map or web_search — whenever the user wants to find/discover places, "near me", "restaurants in X", "coffee near Y", "where can I…". Provide what to find as `query`; pass `near` only when the user names a place to search around (omit it for "near me"). Returns a rich local results card shown to the user; keep prose brief and reference the top options.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to find, e.g. "restaurants", "italian food", "coffee", "hotels".' },
      near: { type: 'string', description: 'Optional place to search around (e.g. "Eiffel Tower", "downtown Austin"). Omit for the user\'s current location.' }
    },
    required: ['query']
  },
  execute: async (args, signal) => {
    const query = String(args?.query || '').trim();
    const near = typeof args?.near === 'string' ? args.near.trim() : '';
    const userLocation =
      ctx?.location && typeof ctx.location.lat === 'number' && typeof ctx.location.lng === 'number'
        ? { lat: ctx.location.lat, lng: ctx.location.lng }
        : undefined;
    if (!query) return { content: 'No place type was provided to search for.' };
    try {
      const data = await findPlaces({ query, near: near || undefined, userLocation }, signal);
      if (!data.results.length) {
        return { content: `No ${data.query} found near ${data.near}.` };
      }
      const lines = data.results
        .slice(0, 8)
        .map(
          (p, i) =>
            `[${i + 1}] ${p.name}${p.distanceKm != null ? ` — ${p.distanceKm} km` : ''}${
              p.cuisine ? ` · ${p.cuisine}` : ''
            }${p.openingHours ? ` · ${p.openingHours}` : ''}${p.website ? ` · ${p.website}` : ''}`
        )
        .join('\n');
      const content = `Found ${data.results.length} ${data.query} near ${data.near}:\n${lines}\nA rich local results card with a map is shown to the user.`;
      return { content, artifacts: [{ type: 'places_results', data }] };
    } catch (err) {
      return { content: `Places lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
});

/** All context-free built-in tools, keyed by the name the model/clients reference. */
const STATIC_TOOLS: Record<string, ChatTool> = {
  web_search: webSearchTool,
  image_search: imageSearchTool,
  video_search: videoSearchTool,
  get_weather: weatherTool,
  show_map: mapTool,
  get_stock: stockTool
};

/** Names of tools that are built per-request with situational context. */
const CONTEXTUAL_TOOL_NAMES = ['get_news', 'find_places'] as const;

// Meta-tools built outside resolveTools (they need provider creds), but still part
// of the client allowlist. `run_agent_swarm` is wired in by the chat route.
const META_TOOL_NAMES = ['run_agent_swarm'] as const;

/** The set of tool names a client is allowed to enable (allowlist). */
export const KNOWN_TOOL_NAMES = [...Object.keys(STATIC_TOOLS), ...CONTEXTUAL_TOOL_NAMES, ...META_TOOL_NAMES];

/** Resolve an allowlisted set of tool names to their implementations. */
export const resolveTools = (names: string[] | undefined, ctx?: ToolContext): ChatTool[] => {
  if (!Array.isArray(names)) return [];
  const seen = new Set<string>();
  const tools: ChatTool[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (name === 'get_news') {
      tools.push(makeNewsTool(ctx));
      continue;
    }
    if (name === 'find_places') {
      tools.push(makePlacesTool(ctx));
      continue;
    }
    const tool = STATIC_TOOLS[name];
    if (tool) tools.push(tool);
  }
  return tools;
};

/** Convert a ChatTool to the OpenAI-compatible spec sent to the provider. */
export const toToolSpec = (tool: ChatTool): ToolSpec => ({
  type: 'function',
  function: { name: tool.name, description: tool.description, parameters: tool.parameters }
});
