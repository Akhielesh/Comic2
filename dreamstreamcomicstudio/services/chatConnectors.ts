// Client-side catalogue of chat connectors (agentic tools).
//
// Each connector maps to one or more backend tool names. This is intentionally a
// simple, data-driven list so new open-source connectors (and, later, custom MCP
// servers) are added here without touching the chat UI.

export interface ChatConnector {
  id: string;
  label: string;
  description: string;
  /** Backend tool names this connector enables. */
  toolNames: string[];
}

export const CHAT_CONNECTORS: ChatConnector[] = [
  {
    id: 'web',
    label: 'Web & tools',
    description: 'Free, keyless live tools: web/image/video search (DuckDuckGo), live news (Google News), weather (Open-Meteo), stock quotes (Stooq), nearby places (OpenStreetMap) and interactive maps. The model searches, shows media, renders news/weather/stock/local cards and opens maps.',
    toolNames: ['web_search', 'image_search', 'video_search', 'get_news', 'get_weather', 'get_stock', 'find_places', 'show_map']
  },
  {
    id: 'agents',
    label: 'Agent swarm',
    description: 'Let the model delegate complex, multi-domain tasks to a swarm of specialized agents (news, finance, weather, tech, research, local) that work in parallel, then synthesize one sourced answer — on demand, without switching to Swarm mode.',
    toolNames: ['run_agent_swarm']
  }
];

/** True when every tool the connector needs is currently enabled. */
export const isConnectorEnabled = (connector: ChatConnector, enabledTools: string[]): boolean =>
  connector.toolNames.every((name) => enabledTools.includes(name));

/** Return the next enabled-tool list with the connector toggled on/off. */
export const toggleConnector = (connector: ChatConnector, enabledTools: string[], on: boolean): string[] => {
  const set = new Set(enabledTools);
  for (const name of connector.toolNames) {
    if (on) set.add(name);
    else set.delete(name);
  }
  return Array.from(set);
};
