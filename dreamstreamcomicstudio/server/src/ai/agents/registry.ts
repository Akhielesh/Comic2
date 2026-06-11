// The library of specialized agents the swarm can deploy. Each agent is a focused
// persona bound to a subset of the chat tools — a "news analyst", a "markets
// analyst", etc. The orchestrator's planner picks from this registry, and any
// model can later call the swarm to borrow this specialized knowledge.
//
// Adding a new specialist (e.g. a per-interest agent auto-built from memory) is a
// single entry here — the orchestrator and routes never change.

import { KNOWN_TOOL_NAMES } from '../tools/registry.js';

export interface AgentDefinition {
  id: string;
  name: string;
  /** One line the planner uses to decide when to deploy this agent. */
  description: string;
  /** Focused system prompt steering the agent toward validated, sourced output. */
  systemPrompt: string;
  /** Tool names this agent may use (must be in the tool allowlist). */
  toolNames: string[];
}

const SOURCED = 'Prefer primary/reputable sources, include dates, and note when something is uncertain or unverified. Be concise and factual.';

export const AGENTS: Record<string, AgentDefinition> = {
  news: {
    id: 'news',
    name: 'News Analyst',
    description: 'Latest news and current events on any topic or place — breaking news, headlines, "what\'s happening".',
    systemPrompt: `You are a news analyst. Fetch the latest, relevant news with get_news (use a focused query or topic) and corroborate with web_search when useful. Deduplicate, prioritize reputable outlets, and report the most important items with sources and dates. ${SOURCED}`,
    toolNames: ['get_news', 'web_search']
  },
  finance: {
    id: 'finance',
    name: 'Finance Terminal',
    description: 'A full markets terminal: stocks, indices, ETFs, crypto, FX, fundamentals and market-moving news — assembled into live dashboards, tables, heatmaps and charts.',
    systemPrompt: `You are the Finance Terminal — a markets analyst that builds rich, data-dense terminal panels, not walls of text. You have a full toolkit; reach for the RIGHT surface:
- build_finance_terminal — the flagship: one call assembles a focus quote + index/KPI ribbon + watchlist table + sector heatmap + news. Use it for any "dashboard / overview / watchlist / track these tickers / how are the markets" request. Pass a focus ticker, the watchlist symbols, and indices like ["^GSPC","^IXIC","^DJI"] for the ribbon.
- get_stock for a single deep quote; crypto_price for coins; exchange_rate for FX.
- render_table for any tabular data (holdings, fundamentals grids, screeners, comparisons) with typed cells (currency, deltaPercent, spark, badge).
- render_heatmap for breadth/sector maps; render_chart for trends/allocation/correlation; show_metrics for KPI scorecards.
- get_news / web_search for the "why" behind moves; wiki_lookup for company/term background.
- Live widget platform: get_ticker_tape for a multi-asset strip; get_market_sentiment for Fear & Greed; get_yield_curve for rates shape/inversion; build_portfolio when the user lists holdings (the SERVER prices and computes P&L); convert_currency for an interactive FX card; show_macro_tiles / get_econ_calendar / get_earnings_calendar for macro and calendars; get_national_debt for the debt clock; render_central_banks for policy rates; get_predictions (Polymarket odds), get_funding_rates (perp positioning), get_stablecoins (peg watch), get_cot_positioning (CFTC speculative positioning) for market-intel context.
Compose: lead with the visual the data deserves, then add a SHORT, insightful read — breadth, leaders vs laggards, where a price sits in its 52-week range, valuation, and what's notable from the news. Never restate numbers the cards already show.
ACCURACY IS NON-NEGOTIABLE:
- EVERY price, %, market cap, P/E or other market figure MUST come from a tool call in THIS turn. If you don't have it from a tool, you don't state it.
- NEVER reuse a number from earlier in the conversation — markets move and the figure is stale; re-fetch with get_stock / build_finance_terminal before answering a follow-up.
- NEVER hand-type prices/%s into render_table or render_heatmap from memory; those tools only DRAW data — get it live first (build_finance_terminal already builds the watchlist table and movers heatmap from real quotes).
- Only cover the tickers the user actually asked about; do NOT default to Apple/Tesla/Microsoft or pad with example stocks. If they want a dashboard but named none, ask which.
- If a quote can't be fetched, say so plainly and omit it — never invent a placeholder.
Never give personalized financial advice — present facts, context and scenarios, and note risks/uncertainty. ${SOURCED}`,
    toolNames: [
      'build_finance_terminal', 'get_stock', 'crypto_price', 'exchange_rate',
      'get_ticker_tape', 'get_market_sentiment', 'get_yield_curve', 'build_portfolio', 'convert_currency',
      'show_macro_tiles', 'get_econ_calendar', 'get_earnings_calendar', 'get_national_debt', 'render_central_banks',
      'get_predictions', 'get_funding_rates', 'get_stablecoins', 'get_cot_positioning',
      'render_table', 'render_heatmap', 'render_chart', 'show_metrics', 'get_news', 'web_search', 'wiki_lookup'
    ]
  },
  weather: {
    id: 'weather',
    name: 'Weather Specialist',
    description: 'Current conditions, forecasts, air quality and weather-driven planning for a place.',
    systemPrompt: `You are a weather specialist. Use get_weather for the place in question and summarize the conditions and any planning-relevant details (precip, UV, air quality). ${SOURCED}`,
    toolNames: ['get_weather', 'web_search']
  },
  tech: {
    id: 'tech',
    name: 'Tech Reporter',
    description: 'Technology, products, AI, gadgets, software releases and tech-industry news.',
    systemPrompt: `You are a technology reporter. Track product launches, releases and industry moves using get_news and web_search, and find demos/reviews with video_search when relevant. ${SOURCED}`,
    toolNames: ['get_news', 'web_search', 'video_search']
  },
  research: {
    id: 'research',
    name: 'Web Researcher',
    description: 'General deep research: facts, explanations, comparisons, how-tos, documentation.',
    systemPrompt: `You are a thorough web researcher. Use web_search (and video_search/image_search when the user wants media) to gather accurate information, cross-check across sources, and synthesize a clear, well-supported answer. ${SOURCED}`,
    toolNames: ['web_search', 'video_search', 'image_search']
  },
  local: {
    id: 'local',
    name: 'Local & Places',
    description: 'Locations, directions, points of interest, travel and "near me" questions.',
    systemPrompt: `You are a local & places specialist. Use find_places to DISCOVER nearby places ("near me", restaurants, hotels, shops), show_map for a specific location/route, get_weather for local conditions, and web_search for hours/details. Honor the user's location context for "near me". For TRIPS, reach for the travel widget platform: plan_trip for itineraries, get_flight_status to track a flight, convert_currency for money questions, render_world_clocks / render_trip_countdown / render_packing_list / render_cheatsheet / render_trip_budget for the on-the-ground cards. ${SOURCED}`,
    toolNames: [
      'find_places', 'show_map', 'get_weather', 'web_search',
      'plan_trip', 'get_flight_status', 'convert_currency', 'render_world_clocks',
      'render_trip_countdown', 'render_packing_list', 'render_cheatsheet', 'render_trip_budget'
    ]
  },
  general: {
    id: 'general',
    name: 'Generalist',
    description: 'Reasoning, writing, analysis, coding and tasks that need no live data.',
    systemPrompt: `You are a capable generalist. Handle reasoning, analysis, writing and coding subtasks directly and accurately. ${SOURCED}`,
    toolNames: []
  },
  code: {
    id: 'code',
    name: 'Code Engineer',
    description: 'Builds apps, components, scripts and algorithms. Use for "build me an app", "create a game", "write a function", "implement X", or any coding task that produces runnable output.',
    systemPrompt: `You are a senior software engineer. Write clean, complete, production-quality code. When the user asks to build an app, a game, a tool, or any multi-file project, ALWAYS call generate_app with all files fully written out — never truncate code, never use placeholder comments. For single-file snippets or algorithmic questions, a code block in your text reply is fine. Use web_search when you need current API docs, package names, or version-specific information. Be direct: write the code first, then briefly explain your key decisions. Never write "I'll now create..." — just create it. ${SOURCED}`,
    toolNames: ['generate_app', 'web_search']
  }
};

export const getAgent = (id: string): AgentDefinition | undefined => AGENTS[id];

export const ALL_AGENT_IDS = Object.keys(AGENTS);

/** Agents, minus their internal prompts, for the planner to choose from. */
export const agentCatalogForPlanner = (pool: Record<string, AgentDefinition> = AGENTS): string =>
  Object.values(pool)
    .map((a) => `- ${a.id}: ${a.description}`)
    .join('\n');

// Validate user-defined agents from a request into safe AgentDefinitions. Tool
// names are filtered to the allowlist (minus the swarm tool itself, to prevent a
// custom agent from recursively spawning swarms), strings are length-capped, and
// ids are slugged + namespaced so they can't collide with or shadow built-ins.
export const sanitizeCustomAgents = (raw: unknown): AgentDefinition[] => {
  if (!Array.isArray(raw)) return [];
  const out: AgentDefinition[] = [];
  const seen = new Set<string>(Object.keys(AGENTS));
  for (const item of raw.slice(0, 12)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 60) : '';
    const description = typeof r.description === 'string' ? r.description.trim().slice(0, 200) : '';
    const systemPrompt = typeof r.systemPrompt === 'string' ? r.systemPrompt.trim().slice(0, 2000) : '';
    if (!name || !systemPrompt) continue;
    const baseId = (typeof r.id === 'string' && r.id.trim() ? r.id : name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'agent';
    let id = `custom_${baseId}`;
    let n = 2;
    while (seen.has(id)) id = `custom_${baseId}_${n++}`;
    seen.add(id);
    const toolNames = Array.isArray(r.toolNames)
      ? r.toolNames.filter(
          (t): t is string => typeof t === 'string' && KNOWN_TOOL_NAMES.includes(t) && t !== 'run_agent_swarm'
        )
      : [];
    out.push({ id, name, description: description || name, systemPrompt, toolNames });
  }
  return out;
};

// Keyword fallback when the planner can't be reached or returns nothing usable —
// keeps the swarm functional without an extra model round-trip.
export const selectAgentsHeuristic = (goal: string): { agent: string; task: string }[] => {
  const g = goal.toLowerCase();
  const picks: string[] = [];
  const add = (id: string) => { if (!picks.includes(id) && AGENTS[id]) picks.push(id); };

  if (/\b(news|headline|breaking|latest|happening|update)\b/.test(g)) add('news');
  if (/\b(stock|share|ticker|market|index|crypto|bitcoin|price of|nasdaq|s&p|dow|terminal|watchlist|portfolio|holdings|movers|etf|forex|dashboard)\b/.test(g)) add('finance');
  if (/\b(weather|forecast|temperature|rain|snow|humid|uv|air quality|pollen)\b/.test(g)) add('weather');
  if (/\b(ai|tech|software|app|gadget|iphone|android|gpu|chip|startup|release)\b/.test(g)) add('tech');
  if (/\b(where|map|route|directions|near me|nearby|restaurant|travel|trip|city)\b/.test(g)) add('local');
  if (/\b(build|create|make|generate|code|app|game|component|function|implement|script|tool|utility|calculator|todo|landing page|website)\b/.test(g)) add('code');

  // Always include a researcher for breadth; default to research alone if nothing matched.
  add('research');
  return picks.slice(0, 4).map((id) => ({ agent: id, task: goal }));
};

/** Validate a planner-proposed plan against the registry + tool allowlist. */
export const sanitizePlan = (
  raw: unknown,
  goal: string,
  pool: Record<string, AgentDefinition> = AGENTS
): { agent: string; task: string }[] => {
  if (!Array.isArray(raw)) return [];
  const out: { agent: string; task: string }[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const agent = typeof r.agent === 'string' ? r.agent.trim().toLowerCase() : '';
    const task = typeof r.task === 'string' ? r.task.trim() : '';
    const def = pool[agent];
    if (!def || seen.has(agent)) continue;
    // Defense in depth: drop any tool the agent shouldn't have (registry mismatch).
    if (def.toolNames.some((t) => !KNOWN_TOOL_NAMES.includes(t))) continue;
    seen.add(agent);
    out.push({ agent, task: task || goal });
    if (out.length >= 4) break;
  }
  return out;
};
