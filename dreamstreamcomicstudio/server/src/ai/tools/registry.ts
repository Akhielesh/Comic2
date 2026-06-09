// Modular tool registry for the agentic chat loop.
//
// Every capability the chat agent can use — DuckDuckGo today, custom MCP servers
// tomorrow — is a `ChatTool` registered here. The chat loop only ever sees this
// uniform interface, so adding a connector never touches the loop or the routes.

import type { ToolSpec } from '../providers/types.js';
import { ddgImageSearch, ddgVideoSearch, type ImageResult } from './duckduckgo.js';
import { webSearch } from './search.js';
import { getWeather } from './weather.js';
import { geocodePlaces } from './maps.js';
import { fetchNews } from './news.js';
import { getStockQuote } from './stocks.js';
import { findPlaces, osmFilters } from './places.js';
import { foursquareEnabled, findPlacesFoursquare } from './foursquare.js';
import type { ChatTool, ToolExecResult, ToolContext } from './types.js';
// Free-API tool packs (see services/toolCatalog metadata). Each is a list of
// keyless (or key-optional) public-API ChatTools grouped by domain.
import { KNOWLEDGE_TOOLS } from './knowledge.js';
import { FINANCE2_TOOLS } from './finance2.js';
import { GEO_TOOLS } from './geo.js';
import { SPACE_TOOLS } from './space.js';
import { CULTURE_TOOLS } from './culture.js';
import { DEV_TOOLS } from './dev.js';
import { FINANCE_TERMINAL_TOOLS } from './financeTerminal.js';
import { NANGO_TOOLS } from './nango.js';
import { VIDEO_TOOLS } from './videoRender.js';
import { LIVE_TEMPLATE_TOOLS } from './liveTemplateTool.js';
import { generateAppTool } from './codeStudio.js';

export type { ChatTool, ToolExecResult, ToolContext } from './types.js';

// Derive Google-News-style region/language from the user's context: prefer an
// explicit country, else the country segment of the locale (e.g. "en-US" ⇒ US).
const regionLangFromCtx = (ctx?: ToolContext): { region?: string; lang?: string } => {
  const locale = ctx?.locale || '';
  const parts = locale.split('-');
  const lang = parts[0] || undefined;
  const region = ctx?.location?.country || (parts[1] ? parts[1].toUpperCase() : undefined);
  return { region, lang };
};

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
      const { results, provider, status } = await webSearch(query, signal);
      if (!results.length) {
        // Be HONEST about WHY there's nothing: a failed/blocked search ('error') is not
        // the same as a genuinely empty one ('empty'). Telling the model the difference
        // stops it from confidently answering from stale memory as if it had checked.
        const unavailable = status === 'error';
        return {
          // Be explicit so the model PIVOTS instead of re-querying web_search (which is
          // what produced the "8 empty searches then a fabricated TBD table" failure).
          content: unavailable
            ? `Live web search is currently UNAVAILABLE for "${query}" — every search provider failed or was blocked. This is an outage on our side, NOT evidence that nothing exists. Do NOT retry web_search. Tell the user plainly that you could not reach live sources right now. You may answer from your own knowledge ONLY with an explicit caveat that it is not from a live source and may be outdated; NEVER fabricate facts, prices, or specs, and never present a guess as verified.`
            : `No results were found for "${query}" from any available search provider. Do NOT retry web_search with reworded variations — it will keep returning nothing. Instead: use a more specific tool if one fits (wiki_lookup for background/definitions, get_news for recent events), OR answer from your own knowledge while CLEARLY stating it is not from a live search and may be out of date. NEVER fabricate facts, prices, or specs, and never fill a table with "TBD"/placeholder values.`,
          notice: {
            level: unavailable ? 'error' : 'warn',
            message: unavailable
              ? `Live web search is temporarily unavailable (every provider failed or was blocked) for "${query}".`
              : `Web search returned no results for "${query}".`,
            fix: provider === 'none' ? 'Web search is on free/keyless sources right now; self-host SearXNG and set SEARXNG_URL (or add a free TAVILY_API_KEY/BRAVE_API_KEY) for reliable results' : undefined
          }
        };
      }
      const content =
        results.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`).join('\n\n') +
        `\n\n(${results.length} result${results.length === 1 ? '' : 's'} via ${provider})`;
      return { content, citations: results.map((r) => ({ url: r.url, title: r.title })) };
    } catch (err) {
      return {
        content: `Web search failed: ${(err as Error)?.message || 'unknown error'}.`,
        notice: { level: 'error', message: 'Web search is temporarily unavailable.' }
      };
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
      if (!results.length) {
        return {
          content: `No images found for "${query}".`,
          notice: { level: 'warn', message: `Image search returned no results for "${query}".` }
        };
      }
      const content = `Found ${results.length} images for "${query}":\n${results
        .map((r, i) => `[${i + 1}] ${r.title || 'image'} — ${r.url}`)
        .join('\n')}`;
      return { content, images: results };
    } catch (err) {
      return {
        content: `Image search failed: ${(err as Error)?.message || 'unknown error'}.`,
        notice: { level: 'error', message: 'Image search is unavailable right now.' }
      };
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
      if (!results.length) {
        return {
          content: `No videos found for "${query}".`,
          notice: { level: 'warn', message: `Video search returned no results for "${query}".` }
        };
      }
      const content = `Found ${results.length} videos for "${query}":\n${results
        .map((r, i) => `[${i + 1}] ${r.title}${r.publisher ? ` — ${r.publisher}` : ''} (${r.url})`)
        .join('\n')}`;
      return { content, artifacts: [{ type: 'video_results', data: { query, results } }] };
    } catch (err) {
      return {
        content: `Video search failed: ${(err as Error)?.message || 'unknown error'}.`,
        notice: { level: 'error', message: 'Video search is unavailable right now.' }
      };
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
        return {
          content: `No news found for "${query || topic || 'top headlines'}".`,
          notice: { level: 'warn', message: `No news results for "${query || topic || 'top headlines'}".` }
        };
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
      return {
        content: `News lookup failed: ${(err as Error)?.message || 'unknown error'}.`,
        notice: { level: 'error', message: 'Live news is unavailable right now.' }
      };
    }
  }
});

const stockTool: ChatTool = {
  name: 'get_stock',
  description:
    'Get a live market quote for almost ANY asset — stocks, ETFs, indices, commodities (gold, oil, silver, copper, natural gas…), FX pairs and crypto. Pass a ticker OR a plain name ("gold", "crude oil", "the S&P 500", "EURUSD", "bitcoin"). Returns a RICH interactive card — live price, an intraday→multi-year range timeline, 52-week range, key stats, related peers and recent headlines. Use it for ANY "price of X / how is X doing / X trend" question, across asset classes (the same card explains metals, oil, indices and FX, not just stocks). The card carries the numbers, so add a short insightful read (range position, momentum, what is driving it), not a restatement. For comparisons or baskets, call this ONCE PER ASSET in the SAME turn — the cards then lay out side by side in a grid.',
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Ticker or asset name, e.g. "AAPL", "^GSPC", "gold", "crude oil", "EURUSD", "BTC-USD".' }
    },
    required: ['symbol']
  },
  execute: async (args, signal) => {
    const symbol = String(args?.symbol || '').trim();
    if (!symbol) return { content: 'No ticker symbol was provided.' };
    try {
      const q = await getStockQuote(symbol, signal);
      const dir = q.change > 0 ? '▲' : q.change < 0 ? '▼' : '■';
      const pct = (n?: number) => (typeof n === 'number' ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—');
      const big = (n?: number) =>
        typeof n !== 'number' ? undefined : n >= 1e12 ? `${(n / 1e12).toFixed(2)}T` : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : String(n);
      const s = q.stats;
      // 52-week position as a 0–100% band, so the model can comment on where it sits.
      const pos52 =
        s && typeof s.week52Low === 'number' && typeof s.week52High === 'number' && s.week52High > s.week52Low
          ? Math.round(((q.price - s.week52Low) / (s.week52High - s.week52Low)) * 100)
          : undefined;
      const facts = [
        `${q.name || q.symbol} (${q.symbol}${q.exchange ? `, ${q.exchange}` : ''}): ${q.price.toFixed(2)}${q.currency ? ` ${q.currency}` : ''} ${dir} ${q.change >= 0 ? '+' : ''}${q.change.toFixed(2)} (${pct(q.changePercent)})${q.asOf ? ` as of ${q.asOf}` : ''}${q.marketState ? ` [${q.marketState}]` : ''}.`,
        s?.week52Low != null && s?.week52High != null ? `52-week range ${s.week52Low.toFixed(2)}–${s.week52High.toFixed(2)}${pos52 != null ? ` (now ~${pos52}% of range)` : ''}.` : '',
        s?.marketCap != null ? `Market cap ${big(s.marketCap)}.` : '',
        s?.peRatio != null ? `P/E ${s.peRatio.toFixed(1)}.` : '',
        s?.dividendYield != null ? `Dividend yield ${s.dividendYield.toFixed(2)}%.` : '',
        q.volume != null ? `Volume ${big(q.volume)}.` : '',
        q.related?.length ? `Related: ${q.related.map((p) => `${p.symbol} ${pct(p.changePercent)}`).join(', ')}.` : '',
        q.headlines?.length ? `Recent headlines: ${q.headlines.slice(0, 3).map((h) => `"${h.title}"`).join('; ')}.` : ''
      ].filter(Boolean);
      const content = `${facts.join(' ')}\nA rich interactive quote card is shown to the user. Add a brief, insightful read (52-week position, momentum, valuation, notable news/peers) — do not just restate these numbers.`;
      return { content, artifacts: [{ type: 'stock_quote', data: q }] };
    } catch (err) {
      // Be explicit that this FAILED (no card was shown) so the model doesn't claim a
      // price was "retrieved" or invent one / deflect the user to another website.
      return {
        content: `Could not fetch a live quote for "${symbol}" right now (${(err as Error)?.message || 'unknown error'}). No card was shown. Tell the user the market data is temporarily unavailable and do NOT invent a price or tell them to check another site.`,
        notice: { level: 'error', message: `Market quote unavailable for "${symbol}".` }
      };
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
      // Prefer Foursquare (rich: ratings, price, photos) when configured; fall back
      // to keyless OpenStreetMap on absence or any Foursquare failure.
      let data;
      const fsqOn = foursquareEnabled();
      let usedFsq = false;
      let fsqFailed = false; // a Foursquare ERROR (auth/rate-limit/5xx), distinct from "no matches"
      if (fsqOn) {
        try {
          data = await findPlacesFoursquare(
            { query, near: near || undefined, userLocation, label: osmFilters(query).label },
            signal
          );
          if (!data.results.length) data = undefined; // fall through to OSM
          else usedFsq = true;
        } catch {
          data = undefined;
          fsqFailed = true;
        }
      }
      if (!data) {
        data = await findPlaces({ query, near: near || undefined, userLocation }, signal);
      }
      // Be honest about degraded mode — and don't misreport a Foursquare OUTAGE as "no matches".
      const notice = !usedFsq
        ? {
            level: fsqFailed ? ('warn' as const) : ('info' as const),
            message: fsqFailed
              ? 'Foursquare is unavailable right now (auth or rate limit) — showing OpenStreetMap results (no ratings/photos).'
              : fsqOn
                ? 'Foursquare had no matches here, so these are OpenStreetMap results (no ratings/photos).'
                : 'Showing OpenStreetMap results — ratings, photos and price need a Foursquare key.',
            fix: fsqOn ? undefined : 'Set FOURSQUARE_API_KEY'
          }
        : undefined;
      if (!data.results.length) {
        return { content: `No ${data.query} found near ${data.near}.`, notice };
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
      return { content, artifacts: [{ type: 'places_results', data }], notice };
    } catch (err) {
      return {
        content: `Places lookup failed: ${(err as Error)?.message || 'unknown error'}.`,
        notice: { level: 'error', message: 'Local place search is unavailable right now.' }
      };
    }
  }
});

// Render an interactive chart from model-provided data. Pure (no network) — it
// validates + normalizes the structure into a `chart` artifact the client draws.
const chartTool: ChatTool = {
  name: 'render_chart',
  description:
    'Render an interactive chart (line, area, bar, grouped-bar, stacked-bar, pie, donut or scatter) from data YOU provide. Use this to visualize any quantitative data you have gathered or computed — trends over time, category comparisons, breakdowns/parts-of-a-whole, distributions, benchmarks, poll results. Provide one or more named series of {x, y} points (for pie/donut, a single series whose points are the slices). A polished chart card with a legend and hover tooltips is shown to the user; keep prose brief and let the chart carry the detail.',
  parameters: {
    type: 'object',
    properties: {
      variant: {
        type: 'string',
        enum: ['line', 'area', 'bar', 'grouped-bar', 'stacked-bar', 'pie', 'donut', 'scatter'],
        description: 'bar/grouped-bar for category comparisons, line/area for trends over time, pie/donut for parts of a whole, scatter for correlation.'
      },
      title: { type: 'string' },
      subtitle: { type: 'string' },
      unit: { type: 'string', description: 'Optional unit suffix for values, e.g. "%", "ms", "$".' },
      xLabel: { type: 'string' },
      yLabel: { type: 'string' },
      palette: { type: 'string', enum: ['brand', 'ocean', 'sunset', 'violet', 'bull', 'bear', 'mono'], description: 'Optional color theme.' },
      series: {
        type: 'array',
        description: 'One or more data series. For pie/donut, provide exactly one series whose points are the slices.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Series name (shown in the legend).' },
            color: { type: 'string', description: 'Optional hex color override, e.g. "#3B82F6".' },
            points: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  x: { type: 'string', description: 'Category label, or a number/date written as a string.' },
                  y: { type: 'number' }
                },
                required: ['x', 'y']
              }
            }
          },
          required: ['points']
        }
      }
    },
    required: ['variant', 'series']
  },
  execute: async (args) => {
    const variant = String(args?.variant || 'bar');
    const rawSeries = Array.isArray(args?.series) ? (args!.series as unknown[]) : [];
    const series = rawSeries
      .map((s) => {
        const so = s as Record<string, unknown>;
        const points = Array.isArray(so?.points)
          ? (so.points as unknown[])
              .map((p) => {
                const po = p as Record<string, unknown>;
                const y = Number(po?.y);
                return { x: typeof po?.x === 'number' ? po.x : String(po?.x ?? ''), y: Number.isFinite(y) ? y : 0 };
              })
              .filter((p) => p.x !== '')
          : [];
        return { name: typeof so?.name === 'string' ? so.name : undefined, color: typeof so?.color === 'string' ? so.color : undefined, points };
      })
      .filter((s) => s.points.length > 0);
    if (!series.length) return { content: 'No usable chart data was provided (need at least one series with points).' };
    const str = (k: string) => (typeof args?.[k] === 'string' ? (args[k] as string) : undefined);
    const data = { variant, title: str('title'), subtitle: str('subtitle'), unit: str('unit'), xLabel: str('xLabel'), yLabel: str('yLabel'), palette: str('palette'), series };
    return { content: `Rendered a ${variant} chart${data.title ? ` ("${data.title}")` : ''} with ${series.length} series. A chart card is shown to the user.`, artifacts: [{ type: 'chart', data }] };
  }
};

// Render a board of KPI tiles from model-provided metrics.
const metricsTool: ChatTool = {
  name: 'show_metrics',
  description:
    'Show a board of KPI / stat tiles from data YOU provide — totals, rates, scores, deltas. Each tile has a label and value, plus an optional change (delta), a sparkline trend, a progress ring, and a status (good/warn/bad). Use for at-a-glance dashboards, summaries, before/after comparisons or scorecards. A polished metric board is shown to the user.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      columns: { type: 'number', description: 'Grid columns 1–4 (optional).' },
      tiles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: 'string', description: 'The headline value (a number or a preformatted string like "$72").' },
            unit: { type: 'string' },
            delta: { type: 'number', description: 'Absolute change vs. a baseline (drives a green/red trend pill).' },
            deltaPercent: { type: 'number' },
            spark: { type: 'array', items: { type: 'number' }, description: 'Recent values for an inline sparkline.' },
            progress: { type: 'object', properties: { value: { type: 'number' }, max: { type: 'number' } }, description: 'Renders a progress ring.' },
            status: { type: 'string', enum: ['good', 'warn', 'bad', 'neutral'] }
          },
          required: ['label', 'value']
        }
      }
    },
    required: ['tiles']
  },
  execute: async (args) => {
    const rawTiles = Array.isArray(args?.tiles) ? (args!.tiles as unknown[]) : [];
    const tiles = rawTiles
      .map((t) => {
        const to = t as Record<string, unknown>;
        if (typeof to?.label !== 'string' || (typeof to?.value !== 'string' && typeof to?.value !== 'number')) return null;
        const num = (k: string) => (typeof to?.[k] === 'number' ? (to[k] as number) : undefined);
        const prog = to?.progress as Record<string, unknown> | undefined;
        return {
          label: to.label as string,
          value: to.value as string | number,
          unit: typeof to?.unit === 'string' ? to.unit : undefined,
          delta: num('delta'),
          deltaPercent: num('deltaPercent'),
          spark: Array.isArray(to?.spark) ? (to.spark as unknown[]).map(Number).filter(Number.isFinite) : undefined,
          progress: prog && typeof prog.value === 'number' && typeof prog.max === 'number' ? { value: prog.value, max: prog.max } : undefined,
          status: ['good', 'warn', 'bad', 'neutral'].includes(String(to?.status)) ? (to.status as 'good' | 'warn' | 'bad' | 'neutral') : undefined
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
    if (!tiles.length) return { content: 'No usable metric tiles were provided (each needs a label and value).' };
    const columns = typeof args?.columns === 'number' ? Math.max(1, Math.min(4, Math.round(args.columns))) : undefined;
    const data = { title: typeof args?.title === 'string' ? args.title : undefined, columns, tiles };
    return { content: `Rendered a metric board with ${tiles.length} tiles. A KPI board is shown to the user.`, artifacts: [{ type: 'metric_board', data }] };
  }
};

// Build an interactive, self-grading quiz from questions the model authors — for
// on-demand learning/practice. Pure + local (no external API).
const quizTool: ChatTool = {
  name: 'generate_quiz',
  description:
    'Generate an interactive, self-grading quiz to help the user learn or test a topic. Use it whenever the user is studying/learning and would benefit from practice ("quiz me", "test me", "practice questions"), or PROACTIVELY right after explaining a concept. Mix question types: "single" (one correct choice), "multi" (several correct), "true_false", and "short" (typed answer). For single/multi/true_false provide `choices` (each with an id + text) and put the correct choice id(s) in `correct`; for "short" put accepted answer strings in `correct`. Add a brief `explanation` per question (shown after grading) and an optional `hint`. The interactive quiz card is shown to the user — keep prose brief.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      topic: { type: 'string', description: 'Subject area, e.g. "Biology" or "SQL joins".' },
      description: { type: 'string' },
      questions: {
        type: 'array',
        description: 'The quiz questions (aim for 3–8, varied types and difficulty).',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['single', 'multi', 'true_false', 'short'] },
            prompt: { type: 'string', description: 'The question text.' },
            choices: {
              type: 'array',
              description: 'For single/multi/true_false. Omit for "short".',
              items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] }
            },
            correct: { type: 'array', items: { type: 'string' }, description: 'Choice id(s) for single/multi/true_false; accepted answer strings for "short".' },
            explanation: { type: 'string', description: 'Shown after the user checks answers.' },
            hint: { type: 'string' }
          },
          required: ['type', 'prompt', 'correct']
        }
      }
    },
    required: ['title', 'questions']
  },
  execute: async (args) => {
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
    const types = new Set(['single', 'multi', 'true_false', 'short']);
    const rawQs = Array.isArray(args?.questions) ? (args!.questions as unknown[]) : [];
    const questions = rawQs
      .map((raw, i) => {
        const q = raw as Record<string, unknown>;
        const type = types.has(String(q?.type)) ? String(q.type) : 'single';
        const choices = Array.isArray(q?.choices)
          ? (q.choices as unknown[])
              .map((c, ci) => {
                const co = c as Record<string, unknown>;
                return { id: str(co?.id) || String.fromCharCode(97 + ci), text: str(co?.text) || '' };
              })
              .filter((c) => c.text)
          : undefined;
        const correct = Array.isArray(q?.correct) ? (q.correct as unknown[]).map((x) => String(x)).filter(Boolean) : [];
        return { id: str(q?.id) || `q${i + 1}`, type, prompt: str(q?.prompt) || '', choices, correct, explanation: str(q?.explanation), hint: str(q?.hint) };
      })
      .filter((q) => q.prompt && q.correct.length > 0);
    if (!questions.length) return { content: 'No usable quiz questions were provided (each needs a prompt and at least one correct answer).' };
    const data = { title: str(args?.title) || 'Quiz', topic: str(args?.topic), description: str(args?.description), questions };
    return {
      content: `Created a ${questions.length}-question quiz${data.topic ? ` on ${data.topic}` : ''}. An interactive, self-grading quiz card is shown to the user.`,
      artifacts: [{ type: 'quiz', data }]
    };
  }
};

// Author a downloadable document (study guide, cheat sheet, notes, report, plan) the
// user can keep as a real resource. Pure + local — the client renders it with
// .md / .html / PDF download buttons.
const documentTool: ChatTool = {
  name: 'generate_document',
  description:
    'Create a downloadable document the user can keep — a study guide, cheat sheet, notes, report, plan, summary, worksheet, or reference. Use this whenever the user asks you to "make/write/create a document / guide / cheat sheet / notes / report / handout" or would benefit from a saved resource rather than an ephemeral chat reply. Provide a clear `title` and the full document body as Markdown in `content` (headings, lists, tables, code blocks all supported). The user gets an inline card with Download .md / .html / PDF buttons. Keep your chat prose brief — put the substance in the document.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      subtitle: { type: 'string' },
      filename: { type: 'string', description: 'Optional base filename (no extension).' },
      content: { type: 'string', description: 'The full document body as Markdown.' }
    },
    required: ['title', 'content']
  },
  execute: async (args) => {
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
    const title = str(args?.title) || 'Document';
    const content = str(args?.content);
    if (!content) return { content: 'No document content was provided.' };
    const data = { title, subtitle: str(args?.subtitle), filename: str(args?.filename), content };
    return {
      content: `Created the document "${title}". A downloadable document card (.md / .html / PDF) is shown to the user.`,
      artifacts: [{ type: 'document', data }]
    };
  }
};

// Build a flip-card study deck the user can drill — for memorization/vocab. Pure + local.
const flashcardsTool: ChatTool = {
  name: 'generate_flashcards',
  description:
    'Create a deck of study flashcards (flip cards) to help the user memorize terms, definitions, vocabulary, formulas or facts. Use it when the user wants to MEMORIZE/DRILL something ("flashcards", "help me memorize", "vocab", "study cards"), or proactively alongside an explanation of definition-heavy material. Each card has a `front` (term/question) and `back` (definition/answer). The user gets an interactive deck they can flip, shuffle and mark known/review.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      topic: { type: 'string' },
      cards: {
        type: 'array',
        description: 'The cards (aim for 5–20).',
        items: { type: 'object', properties: { front: { type: 'string' }, back: { type: 'string' } }, required: ['front', 'back'] }
      }
    },
    required: ['cards']
  },
  execute: async (args) => {
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
    const cards = (Array.isArray(args?.cards) ? (args!.cards as unknown[]) : [])
      .map((c) => { const co = c as Record<string, unknown>; return { front: str(co?.front) || '', back: str(co?.back) || '' }; })
      .filter((c) => c.front && c.back);
    if (!cards.length) return { content: 'No usable flashcards were provided (each needs a front and back).' };
    const data = { title: str(args?.title) || 'Flashcards', topic: str(args?.topic), cards };
    return { content: `Created a ${cards.length}-card flashcard deck${data.topic ? ` on ${data.topic}` : ''}. An interactive deck is shown to the user.`, artifacts: [{ type: 'flashcards', data }] };
  }
};

// Flatten the free-API tool packs into a name→tool map. These are all context-free
// (they take explicit args), so they live alongside the original built-ins.
const FREE_API_TOOLS: ChatTool[] = [
  ...KNOWLEDGE_TOOLS,
  ...FINANCE2_TOOLS,
  ...FINANCE_TERMINAL_TOOLS,
  ...GEO_TOOLS,
  ...SPACE_TOOLS,
  ...CULTURE_TOOLS,
  ...DEV_TOOLS,
  // External API connectors via a self-hosted Nango (800+ providers). Always registered so the
  // tool names resolve; each call returns a clear "not configured" notice until NANGO_SECRET_KEY is set.
  ...NANGO_TOOLS,
  // HTML→MP4 rendering via a self-hosted HyperFrames worker (not configured → clear notice).
  ...VIDEO_TOOLS,
  // Data-driven live HTML artifacts (html_template_v1) — pure + local.
  ...LIVE_TEMPLATE_TOOLS
];

/** All context-free built-in tools, keyed by the name the model/clients reference. */
const STATIC_TOOLS: Record<string, ChatTool> = {
  web_search: webSearchTool,
  image_search: imageSearchTool,
  video_search: videoSearchTool,
  get_weather: weatherTool,
  show_map: mapTool,
  get_stock: stockTool,
  render_chart: chartTool,
  show_metrics: metricsTool,
  generate_quiz: quizTool,
  generate_flashcards: flashcardsTool,
  generate_document: documentTool,
  generate_app: generateAppTool,
  ...Object.fromEntries(FREE_API_TOOLS.map((t) => [t.name, t]))
};

/** Names of tools that are built per-request with situational context. */
const CONTEXTUAL_TOOL_NAMES = ['get_news', 'find_places'] as const;

// Meta-tools built outside resolveTools (they need provider creds / user keys), but still part
// of the client allowlist. `run_agent_swarm` and `generate_image` are wired in by the routes.
const META_TOOL_NAMES = ['run_agent_swarm', 'generate_image'] as const;

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
