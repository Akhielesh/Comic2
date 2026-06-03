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
    name: 'Markets Analyst',
    description: 'Stocks, indices, crypto, company financials and market-moving news.',
    systemPrompt: `You are a markets analyst. Pull live quotes with get_stock and relevant market news with get_news/web_search. Report price, movement and the why behind it. Never give personalized financial advice; present facts and context. ${SOURCED}`,
    toolNames: ['get_stock', 'get_news', 'web_search']
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
    systemPrompt: `You are a local & places specialist. Use show_map for locations/routes, get_weather for local conditions, and web_search for hours/details. Honor the user's location context for "near me". ${SOURCED}`,
    toolNames: ['show_map', 'get_weather', 'web_search']
  },
  general: {
    id: 'general',
    name: 'Generalist',
    description: 'Reasoning, writing, analysis, coding and tasks that need no live data.',
    systemPrompt: `You are a capable generalist. Handle reasoning, analysis, writing and coding subtasks directly and accurately. ${SOURCED}`,
    toolNames: []
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
  if (/\b(stock|share|ticker|market|index|crypto|bitcoin|price of|nasdaq|s&p|dow)\b/.test(g)) add('finance');
  if (/\b(weather|forecast|temperature|rain|snow|humid|uv|air quality|pollen)\b/.test(g)) add('weather');
  if (/\b(ai|tech|software|app|gadget|iphone|android|gpu|chip|startup|release)\b/.test(g)) add('tech');
  if (/\b(where|map|route|directions|near me|nearby|restaurant|travel|trip|city)\b/.test(g)) add('local');

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
