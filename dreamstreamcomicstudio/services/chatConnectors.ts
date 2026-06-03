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
    label: 'Web search',
    description: 'Free, keyless live web + image search (DuckDuckGo) and weather (Open-Meteo). The model searches the web, shows images, and renders weather cards.',
    toolNames: ['web_search', 'image_search', 'get_weather']
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
