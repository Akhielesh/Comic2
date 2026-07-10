// Modular tool registry for the agentic chat loop.
//
// Every capability the chat agent can use — DuckDuckGo today, custom MCP servers
// tomorrow — is a `ChatTool` registered here. The chat loop only ever sees this
// uniform interface, so adding a connector never touches the loop or the routes.

import type { ToolSpec } from '../providers/types.js';
import { ddgImageSearch, ddgVideoSearch, type ImageResult, type VideoSearchResult } from './duckduckgo.js';
import { youtubeVideoSearch } from './youtubeSearch.js';
import { webSearch } from './search.js';
import { readArticle, isFetchableUrl } from './readArticle.js';
import { hostOf } from './http.js';
import { isHostBlocked, markHostBlocked, getCachedPage, setCachedPage } from './readCache.js';
import { getWeatherDetailed } from './weather.js';
import { geocodePlaces } from './maps.js';
import { getDirections } from './directions.js';
import { fetchNews } from './news.js';
import { getStockQuote } from './stocks.js';
import { findPlaces, osmFilters } from './places.js';
import { foursquareEnabled, findPlacesFoursquare } from './foursquare.js';
import { learningPathTool } from './learningPath.js';
import { planTripTool } from './travel.js';
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
import { CONNECTOR_TOOL_NAMES, buildConnectorTool } from './connectors.js';
import { VIDEO_TOOLS } from './videoRender.js';
import { LIVE_TEMPLATE_TOOLS } from './liveTemplateTool.js';
import { MARKET_WIDGET_TOOLS } from './marketWidgets.js';
import { MACRO_WIDGET_TOOLS } from './macroData.js';
import { MARKET_INTEL_TOOLS } from './marketIntel.js';
import { TRAVEL_WIDGET_TOOLS } from './travelWidgets.js';
import { FLIGHT_TOOLS } from './flights.js';
import { PRODUCTIVITY_TOOLS } from './productivity.js';
import { REFRESHABLE_TOOLS, type ChatArtifact } from '../../../../apiTypes.js';
import { generateAppTool } from './codeStudio.js';
import { iconSearchTool } from './icons.js';
import { generativeUiTool, renderReactTool } from './generativeUi.js';
import { convertDataTool } from './convertData.js';
import { analyzeDataTool } from './analyzeData.js';
import { transformDataTool } from './transformData.js';
import { convertImageTool } from './convertImage.js';
import { makeRunPythonTool, runPythonTool } from './runPython.js';

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
      const { weather, source } = await getWeatherDetailed(location, signal);
      const content = `Weather for ${weather.location}: ${weather.current.tempC}°C (${weather.current.tempF}°F), ${weather.current.description}, wind ${weather.current.windKph} km/h. A weather card with the 5-day forecast is shown to the user.`;
      // CC BY 4.0 sources — surface the credit as a visible citation.
      return { content, artifacts: [{ type: 'weather', data: weather }], citations: [{ url: source.url, title: source.attribution }] };
    } catch (err) {
      return { content: `Weather lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

const videoSearchTool: ChatTool = {
  name: 'video_search',
  description:
    'Find videos to watch (tutorials, how-tos, reviews, clips) — prefers the YouTube Data API when configured, else DuckDuckGo. Use whenever the user types a topic and wants to find/see videos (e.g. "how to make X", "lo-fi beats", "Rivian review"); results render as playable cards. This is the "type a topic → get videos right here" search.',
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
      // Prefer YouTube (reliable, real results) when a key is set; the keyless DuckDuckGo
      // scraper is the fallback (and the recovery path if YouTube errors / returns empty).
      const fromYt = await youtubeVideoSearch(query, signal).catch(() => [] as VideoSearchResult[]);
      const results = fromYt.length ? fromYt : await ddgVideoSearch(query, signal);
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

// Great-circle distance (km) between two lat/lng points — used to decide whether a
// leg is a short hop (straight line) or a flight-scale hop (drawn as a curved arc).
const legKm = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number => {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
};

const mapTool: ChatTool = {
  name: 'show_map',
  description:
    'Show an interactive map. Use whenever the user asks about a location, place, directions/route between places, "where is…", or wants to see somewhere on a map. Pass the place names; they are geocoded and shown as markers (in order) in a side panel. Set route:true to connect them in order — long, flight-scale legs render as curved arcs automatically. Keep your text brief and let the map carry it.',
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
      // Connect the stops as per-leg segments so a flight-scale hop (> ~600 km) bows
      // into a dashed curved arc while short legs stay straight — one polished route
      // instead of a single straight line cutting across the globe.
      const segments =
        args?.route && markers.length > 1
          ? markers.slice(1).map((m, i) => {
              const a = markers[i];
              const longHop = legKm(a, m) > 600;
              return { points: [{ lat: a.lat, lng: a.lng }, { lat: m.lat, lng: m.lng }], arc: longHop, dashed: longHop };
            })
          : undefined;
      const content = `Showing a map with ${markers.length} location(s): ${markers.map((m) => m.label).join(', ')}. The interactive map is shown to the user.`;
      return {
        content,
        artifacts: [{ type: 'map', data: { title: typeof args?.title === 'string' ? args.title : undefined, markers, segments } }]
      };
    } catch (err) {
      return { content: `Map lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

const directionsTool: ChatTool = {
  name: 'get_directions',
  description:
    'Get real DIRECTIONS between two places — driving, walking and cycling routes with live ETAs, distances and route alternatives (OSRM), rendered as an interactive map card with a transport-mode toggle (Google-Maps-style). Use whenever the user asks how to get somewhere, travel time between places, or "directions from X to Y". For transit the card deep-links to Google Maps.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Start place/address, e.g. "Lincoln Memorial" or "123 Main St, Fairfax VA".' },
      to: { type: 'string', description: 'Destination place/address.' },
      mode: { type: 'string', enum: ['drive', 'walk', 'bike'], description: 'Preferred mode to preselect (all are fetched).' }
    },
    required: ['from', 'to']
  },
  execute: async (args, signal) => {
    const from = String(args?.from || '').trim();
    const to = String(args?.to || '').trim();
    if (!from || !to) return { content: 'Both a start ("from") and a destination ("to") are needed for directions.' };
    try {
      const mode = args?.mode === 'walk' || args?.mode === 'bike' || args?.mode === 'drive' ? args.mode : undefined;
      const data = await getDirections({ from, to, mode }, signal);
      const best = data.modes.find((m) => m.mode === (data.defaultMode ?? m.mode)) ?? data.modes[0];
      const r = best?.routes[0];
      const content = r
        ? `Directions ${data.origin.label} → ${data.destination.label}: ${best.mode} ${r.durationMin} min · ${r.distanceKm} km${r.summary ? ` (${r.summary})` : ''}. An interactive route card with drive/walk/bike toggles is shown — describe the best option briefly, don't repeat every number.`
        : `Directions ${data.origin.label} → ${data.destination.label} are shown on an interactive route card.`;
      return {
        content,
        artifacts: [{ type: 'directions', data }],
        citations: [{ url: 'https://routing.openstreetmap.de/about.html', title: 'FOSSGIS OSRM routing (OpenStreetMap)' }]
      };
    } catch (err) {
      return {
        content: `Directions lookup failed: ${(err as Error)?.message || 'unknown error'}.`,
        notice: { level: 'error', message: 'Route lookup is unavailable right now.' }
      };
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
        // Carry the per-source reasons — a datacenter-IP block upstream is
        // undiagnosable from a generic "unavailable".
        notice: { level: 'error', message: `Market quote unavailable for "${symbol}" — ${(err as Error)?.message || 'unknown error'}` }
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

// Compose a customizable glass dashboard of live widgets (clock, countdown, stats,
// charts, checklist, progress, globe with flight arcs, notes, links). Pure + local —
// the model supplies all data; the client renders, animates and lets the user
// drag-rearrange. The go-to tool for "build me a dashboard / tracker / overview".
const dashboardTool: ChatTool = {
  name: 'create_dashboard',
  description:
    'Create a customizable, drag-to-rearrange DASHBOARD of live widgets for the user — study plans, trip/flight overviews, market watch, project status, fitness, exam prep. Widgets: "clock" (live time, multiple time zones), "countdown" (to an ISO date), "stat" (value + delta + spark), "chart" (points), "progress" (value/max ring), "list" (checklist items), "globe" (lat/lon points + arcs between labeled points — perfect for flight paths), "note", "links". Give every widget a unique id and a short title; use size "md"/"lg" for wide widgets (charts, globes). Use it PROACTIVELY when the user asks to track, plan or monitor anything multi-part.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      subtitle: { type: 'string' },
      widgets: {
        type: 'array',
        description: 'The dashboard widgets (3-10 is the sweet spot).',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', enum: ['clock', 'countdown', 'stat', 'chart', 'progress', 'list', 'globe', 'note', 'links'] },
            title: { type: 'string' },
            size: { type: 'string', enum: ['sm', 'md', 'lg'] },
            timeZones: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, tz: { type: 'string', description: 'IANA zone, e.g. "Asia/Tokyo".' } }, required: ['label', 'tz'] } },
            target: { type: 'string', description: 'ISO datetime for countdown.' },
            value: { type: 'string' }, unit: { type: 'string' },
            delta: { type: 'number' }, deltaPercent: { type: 'number' },
            spark: { type: 'array', items: { type: 'number' } },
            points: { type: 'array', items: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'number' } }, required: ['x', 'y'] } },
            chartVariant: { type: 'string', enum: ['line', 'area', 'bar'] },
            progress: { type: 'object', properties: { value: { type: 'number' }, max: { type: 'number' }, label: { type: 'string' } }, required: ['value', 'max'] },
            items: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' }, meta: { type: 'string' } }, required: ['text'] } },
            globePoints: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, lat: { type: 'number' }, lon: { type: 'number' } }, required: ['label', 'lat', 'lon'] } },
            globeArcs: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Pairs of globePoint labels to connect, e.g. [["JFK","HND"]].' },
            text: { type: 'string' },
            links: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } }, required: ['label', 'url'] } }
          },
          required: ['id', 'kind']
        }
      }
    },
    required: ['title', 'widgets']
  },
  execute: async (args) => {
    const KINDS = new Set(['clock', 'countdown', 'stat', 'chart', 'progress', 'list', 'globe', 'note', 'links']);
    const raw = Array.isArray(args?.widgets) ? (args!.widgets as Record<string, unknown>[]) : [];
    const seen = new Set<string>();
    const widgets = raw
      .filter((w) => w && KINDS.has(String(w.kind)))
      .slice(0, 12)
      .map((w, i) => {
        let id = typeof w.id === 'string' && w.id.trim() ? w.id.trim().slice(0, 40) : `w${i}`;
        while (seen.has(id)) id = `${id}_`;
        seen.add(id);
        return { ...(w as Record<string, unknown>), id, kind: String(w.kind) };
      });
    if (!widgets.length) return { content: 'No usable widgets were provided (each needs an id and a valid kind).' };
    const data = {
      title: typeof args?.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 120) : 'Dashboard',
      subtitle: typeof args?.subtitle === 'string' ? args.subtitle.slice(0, 240) : undefined,
      widgets
    };
    return {
      content: `Built the "${data.title}" dashboard with ${widgets.length} widgets (${widgets.map((w) => w.kind).join(', ')}). It is shown to the user, live and drag-to-rearrange — keep your prose to one short line.`,
      artifacts: [{ type: 'dashboard', data }]
    };
  }
};

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

// Build an interactive SQL practice exercise. The model provides a schema + task; the
// user runs real queries against a sandboxed in-memory SQLite (server-side sql.js).
const sqlExerciseTool: ChatTool = {
  name: 'sql_exercise',
  description:
    'Create an interactive SQL practice playground where the user writes and RUNS real SQL against a sandboxed in-memory SQLite database (real results, real errors). Use this whenever the user is learning/practicing SQL or databases ("teach me SQL", "practice joins", "give me a SQL exercise"). Provide `schema` = the SQL that sets up the practice tables (CREATE TABLE … plus a few INSERT rows of realistic seed data), a clear `task` describing what to query, optional `instructions`, and an optional `starterSql` to prefill the editor. Keep prose brief — the playground is interactive.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      instructions: { type: 'string', description: 'What the user is learning / context.' },
      schema: { type: 'string', description: 'SQL that creates the practice tables AND inserts a few seed rows.' },
      task: { type: 'string', description: 'The query challenge for the user to solve.' },
      starterSql: { type: 'string', description: 'Optional starter query to prefill the editor.' }
    },
    required: ['schema', 'task']
  },
  execute: async (args) => {
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
    const schema = str(args?.schema);
    const task = str(args?.task);
    if (!schema || !task) return { content: 'A SQL exercise needs a schema (CREATE + seed) and a task.' };
    const data = { title: str(args?.title) || 'SQL practice', instructions: str(args?.instructions), schema, task, starterSql: str(args?.starterSql) };
    return { content: `Created an interactive SQL exercise${data.title ? ` ("${data.title}")` : ''}. A runnable, sandboxed SQL playground is shown to the user.`, artifacts: [{ type: 'sql_exercise', data }] };
  }
};

// Build an interactive JavaScript practice playground. The model provides a task +
// starter code; the user edits and RUNS it in a sandboxed Web Worker (real console
// output, real JS errors). Pure + local.
const codeExerciseTool: ChatTool = {
  name: 'code_exercise',
  description:
    'Create an interactive coding playground where the user writes and RUNS real code in a sandboxed in-browser terminal (real output, real errors/tracebacks). JavaScript and Python run live (set `language` to "javascript" or "python"). Use this whenever the user is learning/practicing JS or Python or general programming ("teach me Python", "practice array methods", "give me a coding exercise", "let me try it"). Provide a clear `task`, optional `instructions`, and `starterCode` to prefill the editor (use console.log / print to show output). Keep prose brief — the playground is interactive. (For SQL use sql_exercise.)',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      instructions: { type: 'string', description: 'What the user is learning / context.' },
      task: { type: 'string', description: 'The coding challenge for the user to solve.' },
      language: { type: 'string', description: '"javascript" or "python" — both run live. Default "javascript".' },
      starterCode: { type: 'string', description: 'Starter code to prefill the editor (use console.log / print for output).' }
    },
    required: ['task']
  },
  execute: async (args) => {
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
    const task = str(args?.task);
    if (!task) return { content: 'A code exercise needs a task.' };
    const data = {
      title: str(args?.title) || 'Code practice',
      instructions: str(args?.instructions),
      task,
      language: str(args?.language) || 'javascript',
      starterCode: str(args?.starterCode)
    };
    return { content: `Created an interactive code exercise${data.title ? ` ("${data.title}")` : ''}. A runnable, sandboxed ${data.language === 'python' ? 'Python' : 'JavaScript'} playground is shown to the user.`, artifacts: [{ type: 'code_exercise', data }] };
  }
};

// Package several generated files into one downloadable bundle (.zip). Pure + local —
// the client renders per-file download buttons plus a "download all as .zip" action.
const bundleTool: ChatTool = {
  name: 'generate_bundle',
  description:
    'Package a SET of files into one downloadable bundle the user can keep — they get per-file downloads plus a single "download all (.zip)" button. Use this when the user wants a KIT / PACK / BUNDLE of resources rather than a single document: e.g. a study pack (guide + practice questions + flashcards as files), a starter project (multiple code/config files), or data + notes (a CSV plus a README). Provide a `title` and a `files` array — each file has a `name` WITH extension (e.g. "study-guide.md", "data.csv", "starter.py") and its full text `content`. Keep chat prose brief; put the substance in the files.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      files: {
        type: 'array',
        description: 'The files to bundle (2–12). Each has a name with extension and text content.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Filename with extension, e.g. "notes.md".' },
            content: { type: 'string' },
            label: { type: 'string', description: 'Optional short description of the file.' }
          },
          required: ['name', 'content']
        }
      }
    },
    required: ['title', 'files']
  },
  execute: async (args) => {
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
    const MAX_FILES = 12;
    const MAX_FILE_CHARS = 60_000;
    const files = (Array.isArray(args?.files) ? (args!.files as unknown[]) : [])
      .flatMap((f) => {
        const fo = f as Record<string, unknown>;
        const name = str(fo?.name);
        const content = typeof fo?.content === 'string' ? fo.content : undefined;
        if (!name || content === undefined) return [];
        // Sanitize the path: no directory traversal / leading slashes in zip entry names.
        const safe = name.replace(/^[/\\]+/, '').replace(/\.\.[/\\]/g, '').slice(0, 120);
        return [{ name: safe || 'file.txt', content: content.slice(0, MAX_FILE_CHARS), label: str(fo?.label) }];
      })
      .slice(0, MAX_FILES);
    if (!files.length) return { content: 'No usable files were provided for the bundle (each needs a name and content).' };
    const data = { title: str(args?.title) || 'Resource bundle', description: str(args?.description), files };
    return {
      content: `Built a resource bundle "${data.title}" with ${files.length} file(s). A downloadable card (per-file + .zip) is shown to the user.`,
      artifacts: [{ type: 'resource_bundle', data }]
    };
  }
};

// Drop a fully playable mini-game into the chat. Pure + local — it just emits a
// `game` artifact; the client renders the real, interactive game (each ships with
// its own Compact/Medium/Large size control and a fullscreen toggle).
const playGameTool: ChatTool = {
  name: 'play_game',
  description:
    'Drop a fully playable mini-game into the chat for the user to play right now. Use whenever the user wants to play a game, take a break, or asks for one by name. Supported games: "snake" (classic grid snake), "breakout" (brick breaker / paddle), "2048" (slide-and-merge puzzle), "memory" (flip-card matching / concentration). Pick the one the user names; default to "snake" if they just say "a game". Optional `difficulty` ("easy"|"normal"|"hard") tunes Snake/Breakout speed and the Memory board size. The game card carries everything (controls, score, sizes, fullscreen) — keep your reply to one short line.',
  parameters: {
    type: 'object',
    properties: {
      game: { type: 'string', enum: ['snake', 'breakout', '2048', 'memory'], description: 'Which game to launch.' },
      difficulty: { type: 'string', enum: ['easy', 'normal', 'hard'], description: 'Speed (Snake/Breakout) or board size (Memory). Optional, default normal.' }
    },
    required: ['game']
  },
  execute: async (args) => {
    const games = new Set(['snake', 'breakout', '2048', 'memory']);
    const game = games.has(String(args?.game)) ? String(args.game) : 'snake';
    const difficulty = ['easy', 'normal', 'hard'].includes(String(args?.difficulty)) ? String(args.difficulty) : undefined;
    const label = game === 'breakout' ? 'Brick breaker' : game === '2048' ? '2048' : game === 'memory' ? 'Memory match' : 'Snake';
    return {
      content: `Launched ${label} — a fully playable game card is shown to the user (keyboard + touch, Compact/Medium/Large sizes and a fullscreen toggle). Invite them to play; one short line is enough.`,
      artifacts: [{ type: 'game', data: { game, ...(difficulty ? { difficulty } : {}) } }]
    };
  }
};

// Turn one refresh-whitelisted tool call into a LIVE MONITOR: the widget re-runs
// the call on an interval client-side (via /api/chat/tool-refresh), so the embedded
// card stays fresh without any model round-trip. This is the /loop skill's engine.
// Defined here (not in a tool pack) because it resolves other tools at execute time.
const MIN_MONITOR_SEC = 30;
const MAX_MONITOR_SEC = 3600;
export const clampMonitorInterval = (v: unknown): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 300;
  return Math.max(MIN_MONITOR_SEC, Math.min(MAX_MONITOR_SEC, n));
};

const monitorTool: ChatTool = {
  name: 'create_monitor',
  description:
    'Create a LIVE MONITOR — a widget that re-runs one live-data tool on an interval so it stays fresh on screen (a loop, no model round-trip). Use when the user wants to watch/track/monitor something continuously ("keep an eye on NVDA", "watch the weather", "refresh BTC every minute"). `tool` must be one of the refreshable live-data tools: ' +
    REFRESHABLE_TOOLS.join(', ') +
    '. Pass the exact args that tool expects (e.g. get_stock → {"symbol":"NVDA"}, get_weather → {"location":"Tokyo"}, get_news → {"query":"AI chips"}, crypto_price → {"coin":"bitcoin"}). intervalSec is clamped to 30–3600 (default 300).',
  parameters: {
    type: 'object',
    properties: {
      tool: { type: 'string', enum: [...REFRESHABLE_TOOLS], description: 'The refreshable live-data tool to loop.' },
      args: { type: 'object', description: 'Arguments for that tool, exactly as it expects them.' },
      intervalSec: { type: 'number', description: 'Refresh cadence in seconds (30–3600, default 300).' },
      label: { type: 'string', description: 'Short monitor label, e.g. "NVDA · every 5 min".' }
    },
    required: ['tool']
  },
  execute: async (args, signal) => {
    const tool = String(args?.tool || '').trim();
    if (!(REFRESHABLE_TOOLS as readonly string[]).includes(tool)) {
      return {
        content: `"${tool}" is not a refreshable live-data tool. Pick one of: ${REFRESHABLE_TOOLS.join(', ')} and pass its args.`
      };
    }
    const toolArgs =
      args?.args && typeof args.args === 'object' && !Array.isArray(args.args) ? (args.args as Record<string, unknown>) : {};
    const intervalSec = clampMonitorInterval(args?.intervalSec);
    const impl = resolveTools([tool])[0];
    if (!impl) return { content: `Tool "${tool}" is unavailable right now.` };
    // Take the initial snapshot so the monitor renders with real data immediately.
    const out = await impl.execute(toolArgs, signal);
    const inner = out.artifacts?.[0];
    if (!inner) {
      return {
        content: `Could not start the monitor: ${tool} returned no widget (${out.content.slice(0, 200)}). Fix the args and try again.`,
        notice: { level: 'warn' as const, message: `Monitor setup failed — ${tool} produced no artifact for those args.` }
      };
    }
    const label = typeof args?.label === 'string' && args.label.trim() ? args.label.trim().slice(0, 80) : undefined;
    const data = {
      label,
      tool,
      args: toolArgs,
      intervalSec,
      artifact: { ...inner, origin: { tool, args: toolArgs } },
      asOf: new Date().toISOString()
    };
    const mins = intervalSec % 60 === 0 ? `${intervalSec / 60} min` : `${intervalSec}s`;
    return {
      content: `Live monitor started: ${tool}(${JSON.stringify(toolArgs)}) refreshing every ${mins}. The widget updates itself while on screen — tell the user the cadence in one short line.`,
      artifacts: [{ type: 'live_monitor', data }]
    };
  }
};

// Apple-style SMART STACK: execute up to four refreshable live-data calls and
// embed their snapshots in one rotating widget. Like create_monitor, this lives
// in the registry because it resolves other tools at execute time.
const stackTool: ChatTool = {
  name: 'create_widget_stack',
  description:
    'Create a SMART STACK — one widget that auto-rotates between 2–4 live cards (Apple-watch-style): e.g. a stock + the weather + headlines in one slot. Use when the user wants several things "in one widget", a glanceable morning slot, or a rotating dashboard tile. Each item is one refreshable live-data tool call (' +
    REFRESHABLE_TOOLS.join(', ') +
    ') with its exact args. The stack rotates every `intervalSec` seconds (4–60, default 8), pauses on hover, and each card refreshes live through its own source.',
  parameters: {
    type: 'object',
    properties: {
      label: { type: 'string', description: 'Short stack label, e.g. "Morning glance".' },
      intervalSec: { type: 'number', description: 'Rotation cadence in seconds (4–60, default 8).' },
      items: {
        type: 'array',
        description: '2–4 live cards.',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', enum: [...REFRESHABLE_TOOLS] },
            args: { type: 'object', description: 'Arguments for that tool, exactly as it expects them.' }
          },
          required: ['tool']
        }
      }
    },
    required: ['items']
  },
  execute: async (args, signal) => {
    const raw = Array.isArray(args?.items) ? (args.items as Record<string, unknown>[]) : [];
    const specs = raw
      .map((it) => ({
        tool: String(it?.tool ?? '').trim(),
        args: it?.args && typeof it.args === 'object' && !Array.isArray(it.args) ? (it.args as Record<string, unknown>) : {}
      }))
      .filter((it) => (REFRESHABLE_TOOLS as readonly string[]).includes(it.tool))
      .slice(0, 4);
    if (specs.length < 2) {
      return { content: `A widget stack needs 2–4 items, each using a refreshable tool (${REFRESHABLE_TOOLS.join(', ')}).` };
    }
    const settled = await Promise.allSettled(
      specs.map(async (spec) => {
        const impl = resolveTools([spec.tool])[0];
        if (!impl) throw new Error(`${spec.tool} unavailable`);
        const out = await impl.execute(spec.args, signal);
        const inner = out.artifacts?.[0];
        if (!inner) throw new Error(`${spec.tool} produced no widget`);
        return { ...inner, origin: { tool: spec.tool, args: spec.args } };
      })
    );
    const items = settled.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<ChatArtifact>).value);
    if (items.length < 2) {
      return {
        content: 'Could not assemble the stack — fewer than two of the requested live calls produced a widget. Check the per-tool args and try again.',
        notice: { level: 'warn' as const, message: 'Widget stack setup failed (not enough live cards).' }
      };
    }
    const intervalSec = Math.max(4, Math.min(60, typeof args?.intervalSec === 'number' && Number.isFinite(args.intervalSec) ? Math.round(args.intervalSec) : 8));
    const data = {
      label: typeof args?.label === 'string' && args.label.trim() ? args.label.trim().slice(0, 80) : undefined,
      intervalSec,
      items
    };
    return {
      content: `Smart stack assembled: ${items.length} live cards (${items.map((i) => i.type).join(' → ')}), rotating every ${intervalSec}s. One short line is enough — the stack speaks for itself.`,
      artifacts: [{ type: 'widget_stack', data }],
      ...(items.length < specs.length
        ? { notice: { level: 'info' as const, message: `${specs.length - items.length} stack item(s) failed to load and were dropped.` } }
        : {})
    };
  }
};

// Flatten the free-API tool packs into a name→tool map. These are all context-free
// (they take explicit args), so they live alongside the original built-ins.
const FREE_API_TOOLS: ChatTool[] = [
  ...KNOWLEDGE_TOOLS,
  ...FINANCE2_TOOLS,
  ...FINANCE_TERMINAL_TOOLS,
  // Live finance widgets (ticker tape, sentiment, yield curve, portfolio, FX card).
  ...MARKET_WIDGET_TOOLS,
  // Macro & calendar widgets (tiles, econ/earnings calendars, debt clock, CB watch).
  ...MACRO_WIDGET_TOOLS,
  // Keyless market intelligence (predictions, funding, stablecoins, COT).
  ...MARKET_INTEL_TOOLS,
  // Travel widgets (boarding pass, world clocks, packing list, trip countdown).
  ...TRAVEL_WIDGET_TOOLS,
  ...FLIGHT_TOOLS,
  // Productivity widgets (/goal, /code-review, what-changed) + GitHub PR fetcher.
  ...PRODUCTIVITY_TOOLS,
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
// Read a web page / article and return its full readable text. Closes the gap where
// web_search only returns short snippets: with this the model can actually READ the
// most relevant result(s) before answering (the search→read chain), and read any URL
// the user pastes. SSRF-guarded inside readArticle (public http/https only).
const readUrlTool: ChatTool = {
  name: 'read_url',
  description:
    "Fetch a web page or article and return its full readable text (title, headings, paragraphs). Use this AFTER web_search / get_news to actually READ the most relevant 1–3 result URLs before answering — search only returns short snippets, so open the page whenever the answer needs detail, quotes, exact numbers, or specifics. Also use it whenever the user gives you a URL to read, summarize, or quote.",
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The full public http(s) URL of the page/article to read.' }
    },
    required: ['url']
  },
  execute: async (args, signal) => {
    const url = String(args?.url || '').trim();
    if (!url) return { content: 'No URL was provided.' };
    if (!isFetchableUrl(url)) {
      return {
        content: `That URL can't be fetched (only public http/https web pages are supported): ${url}`,
        notice: { level: 'warn', message: 'URL not fetchable' }
      };
    }
    const host = hostOf(url);
    // Fast-fail a host that already hard-blocked us this session, instead of re-paying the
    // ~9s fetch timeout (this is what turned "Couldn't read etihad.com ×5" into ~45s wasted).
    if (isHostBlocked(host)) {
      return {
        content: `Skipped ${url} — ${host} already blocked automated reads moments ago. Do NOT fabricate its contents; answer from web_search snippets or a different source instead.`,
        notice: { level: 'warn', message: `Couldn't read ${host}` }
      };
    }
    // Reuse a page read very recently (the agent often re-reads the same URL across rounds).
    const cached = getCachedPage(url);
    if (cached) return { content: cached, citations: [{ url, title: host || url }] };
    try {
      const data = await readArticle(url, signal);
      if (!data.ok || !data.blocks.length) {
        // Only a fetch-level failure means the HOST blocks reads — penalize the whole host.
        // A merely-thin page (`empty`) is page-specific, so don't skip the rest of the host.
        if (data.reason === 'fetch_failed') {
          markHostBlocked(host);
          if (data.resolvedHost && data.resolvedHost !== host) markHostBlocked(data.resolvedHost);
        }
        return {
          content: `Could not extract readable content from ${url} (the page may be paywalled, JavaScript-only, or blocking automated reads). Do NOT fabricate its contents — tell the user it couldn't be read, then try a different source or web_search.`,
          notice: { level: 'warn', message: `Couldn't read ${data.host || url}` }
        };
      }
      const sourceUrl = data.resolvedUrl || url;
      const body = data.blocks
        .map((b) => (b.type === 'h' ? `\n## ${b.text}` : b.text))
        .join('\n')
        .slice(0, 8000);
      const header = data.title ? `# ${data.title}${data.byline ? `\nBy ${data.byline}` : ''}\n` : '';
      const content = `${header}Source: ${sourceUrl}\n\n${body}`;
      setCachedPage(url, content);
      return {
        content,
        citations: [{ url: sourceUrl, title: data.title || data.host || sourceUrl }]
      };
    } catch (err) {
      return {
        content: `Failed to read ${url}: ${(err as Error)?.message || 'unknown error'}.`,
        notice: { level: 'error', message: 'Page read failed.' }
      };
    }
  }
};

const STATIC_TOOLS: Record<string, ChatTool> = {
  web_search: webSearchTool,
  read_url: readUrlTool,
  image_search: imageSearchTool,
  video_search: videoSearchTool,
  get_weather: weatherTool,
  show_map: mapTool,
  get_directions: directionsTool,
  get_stock: stockTool,
  render_chart: chartTool,
  show_metrics: metricsTool,
  create_dashboard: dashboardTool,
  render_ui: generativeUiTool,
  render_react: renderReactTool,
  convert_data: convertDataTool,
  analyze_data: analyzeDataTool,
  transform_data: transformDataTool,
  convert_image: convertImageTool,
  run_python: runPythonTool,
  generate_quiz: quizTool,
  generate_flashcards: flashcardsTool,
  generate_document: documentTool,
  generate_bundle: bundleTool,
  sql_exercise: sqlExerciseTool,
  code_exercise: codeExerciseTool,
  create_learning_path: learningPathTool,
  plan_trip: planTripTool,
  create_monitor: monitorTool,
  create_widget_stack: stackTool,
  play_game: playGameTool,
  generate_app: generateAppTool,
  icon_search: iconSearchTool,
  ...Object.fromEntries(FREE_API_TOOLS.map((t) => [t.name, t]))
};

/** Names of tools that are built per-request with situational context. */
const CONTEXTUAL_TOOL_NAMES = ['get_news', 'find_places'] as const;

// Meta-tools built outside resolveTools (they need provider creds / user keys), but still part
// of the client allowlist. `run_agent_swarm` and `generate_image` are wired in by the routes.
const META_TOOL_NAMES = ['run_agent_swarm', 'generate_image'] as const;

/** The set of tool names a client is allowed to enable (allowlist). */
export const KNOWN_TOOL_NAMES = [
  ...Object.keys(STATIC_TOOLS),
  ...CONTEXTUAL_TOOL_NAMES,
  // Per-user connector tools (Gmail/Drive/Calendar/Sheets/Maps + unified search),
  // built per-request with the signed-in user's context.
  ...CONNECTOR_TOOL_NAMES,
  ...META_TOOL_NAMES
];

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
    if (name === 'run_python') {
      // Built per-request so the current turn's attachments (on ctx) reach the sandbox.
      tools.push(makeRunPythonTool(ctx));
      continue;
    }
    // Per-user connector tools (built with ctx.userId so they only ever touch the
    // signed-in user's own connections).
    const connectorTool = buildConnectorTool(name, ctx);
    if (connectorTool) {
      tools.push(connectorTool);
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
