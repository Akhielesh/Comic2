// Client-side catalogue of chat connectors (agentic tools), grouped by category.
//
// Each connector maps to one or more backend tool names and is derived from the
// shared TOOL_CATALOG so new free-API tools light up here (and in the composer's
// toggle chips) automatically. Enabling a category turns on all its tools; the
// server then smart-routes to the few most relevant per message, so users can keep
// several categories on without flooding the model.

import { CATEGORY_META, toolsByCategory, type ToolCategory } from '../toolCatalog';

export interface ChatConnector {
  id: string;
  label: string;
  description: string;
  /** lucide-react icon name for the chip. */
  icon: string;
  category: ToolCategory;
  /** Backend tool names this connector enables. */
  toolNames: string[];
}

export const CHAT_CONNECTORS: ChatConnector[] = CATEGORY_META.map((cat) => {
  const tools = toolsByCategory(cat.id);
  const names = tools.map((t) => t.name);
  const sample = tools.slice(0, 4).map((t) => t.label).join(', ');
  return {
    id: cat.id,
    label: cat.label,
    description: `${cat.blurb} Tools: ${sample}${tools.length > 4 ? `, +${tools.length - 4} more` : ''}.`,
    icon: cat.icon,
    category: cat.id,
    toolNames: names
  };
}).filter((c) => c.toolNames.length > 0);

/** True when every tool the connector needs is currently enabled. */
export const isConnectorEnabled = (connector: ChatConnector, enabledTools: string[]): boolean =>
  connector.toolNames.every((name) => enabledTools.includes(name));

/** True when at least one (but not all) of a connector's tools is enabled. */
export const isConnectorPartial = (connector: ChatConnector, enabledTools: string[]): boolean => {
  const on = connector.toolNames.filter((name) => enabledTools.includes(name)).length;
  return on > 0 && on < connector.toolNames.length;
};

/** Return the next enabled-tool list with the connector toggled on/off. */
export const toggleConnector = (connector: ChatConnector, enabledTools: string[], on: boolean): string[] => {
  const set = new Set(enabledTools);
  for (const name of connector.toolNames) {
    if (on) set.add(name);
    else set.delete(name);
  }
  return Array.from(set);
};
