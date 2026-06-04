// Client-side catalogue + storage for chat agents.
//
// - BUILTIN_AGENTS mirrors the server agent registry for display (the server is the
//   source of truth; this is read-only metadata).
// - AGENT_TOOLS is the set of tools a custom agent may be given (the server
//   re-validates against its allowlist).
// - Custom agents are stored per-user in localStorage and sent with swarm requests,
//   where the orchestrator adds them to the deployable pool.

import type { CustomAgentDef } from '../apiTypes';

export interface BuiltinAgentMeta {
  id: string;
  name: string;
  description: string;
  toolNames: string[];
}

/** Mirrors server/src/ai/agents/registry.ts (display only). */
export const BUILTIN_AGENTS: BuiltinAgentMeta[] = [
  { id: 'news', name: 'News Analyst', description: 'Latest news & current events on any topic or place.', toolNames: ['get_news', 'web_search'] },
  { id: 'finance', name: 'Markets Analyst', description: 'Stocks, indices, crypto and market-moving news.', toolNames: ['get_stock', 'get_news', 'web_search'] },
  { id: 'weather', name: 'Weather Specialist', description: 'Conditions, forecasts, air quality and planning.', toolNames: ['get_weather', 'web_search'] },
  { id: 'tech', name: 'Tech Reporter', description: 'Technology, products, AI, gadgets and releases.', toolNames: ['get_news', 'web_search', 'video_search'] },
  { id: 'research', name: 'Web Researcher', description: 'Deep research: facts, comparisons, how-tos, docs.', toolNames: ['web_search', 'video_search', 'image_search'] },
  { id: 'local', name: 'Local & Places', description: 'Nearby places, directions, travel and "near me".', toolNames: ['find_places', 'show_map', 'get_weather', 'web_search'] },
  { id: 'general', name: 'Generalist', description: 'Reasoning, writing, analysis and coding — no live data.', toolNames: [] }
];

/** Tools a custom agent may use (the swarm tool itself is intentionally excluded). */
export const AGENT_TOOLS: { name: string; label: string }[] = [
  { name: 'web_search', label: 'Web search' },
  { name: 'get_news', label: 'News' },
  { name: 'get_weather', label: 'Weather' },
  { name: 'get_stock', label: 'Stocks' },
  { name: 'find_places', label: 'Places / local' },
  { name: 'show_map', label: 'Maps' },
  { name: 'video_search', label: 'Video search' },
  { name: 'image_search', label: 'Image search' },
  { name: 'render_chart', label: 'Charts' },
  { name: 'show_metrics', label: 'Metric board' }
];

export const TOOL_LABEL: Record<string, string> = Object.fromEntries(
  AGENT_TOOLS.map((t) => [t.name, t.label])
);

const AGENTS_KEY = 'dreamstream_chat_agents';
const keyFor = (userId?: string) => `${AGENTS_KEY}:${userId || 'anon'}`;

export const listCustomAgents = (userId?: string): CustomAgentDef[] => {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const persist = (agents: CustomAgentDef[], userId?: string): void => {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(agents.slice(0, 24)));
  } catch {
    /* ignore */
  }
};

/** Create or update a custom agent; returns the new list. */
export const saveCustomAgent = (agent: CustomAgentDef, userId?: string): CustomAgentDef[] => {
  const agents = listCustomAgents(userId);
  const idx = agents.findIndex((a) => a.id === agent.id);
  if (idx >= 0) agents[idx] = agent;
  else agents.push(agent);
  persist(agents, userId);
  return agents;
};

export const deleteCustomAgent = (id: string, userId?: string): CustomAgentDef[] => {
  const agents = listCustomAgents(userId).filter((a) => a.id !== id);
  persist(agents, userId);
  return agents;
};

export const newCustomAgent = (): CustomAgentDef => ({
  id: crypto.randomUUID(),
  name: '',
  description: '',
  systemPrompt: '',
  toolNames: []
});

// --- Memory as a list of points (the stored form is a newline string, which is
// also exactly what the auto-memory endpoint emits as "- " bullets). ---

export const parseMemoryItems = (memory: string): string[] =>
  memory
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);

export const formatMemoryItems = (items: string[]): string =>
  items.map((i) => `- ${i.trim()}`).filter((l) => l.length > 2).join('\n');
