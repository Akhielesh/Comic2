// Capability log + report — the platform's honesty layer.
//
// Two things:
// 1) A small in-memory ring buffer of "capability notices": moments where the AI
//    wanted to do something but couldn't fully (a tool failed, returned nothing,
//    ran in a degraded/open-data fallback, or a key was missing). The chat loop
//    feeds these in; the system dashboard reads them out.
// 2) A point-in-time capability report: which providers/tools are OK, degraded
//    (e.g. Foursquare key missing ⇒ OSM fallback), or unavailable — derived from
//    what keys/config are actually present.

import type { CapabilityNotice, CapabilityReport, CapabilityStatus } from '../../../apiTypes.js';
import { FOURSQUARE_API_KEY } from '../config.js';

const MAX_NOTICES = 200;
const ring: CapabilityNotice[] = [];

/** Record a capability gap observed at runtime (kept in a bounded ring buffer). */
export const logCapabilityNotice = (notice: CapabilityNotice): void => {
  ring.push({ ...notice, at: notice.at || new Date().toISOString() });
  if (ring.length > MAX_NOTICES) ring.splice(0, ring.length - MAX_NOTICES);
};

/** Most recent notices, newest first. */
export const recentNotices = (limit = 50): CapabilityNotice[] =>
  ring.slice(-limit).reverse();

const hasEnv = (name: string): boolean => Boolean(process.env[name]);

/** Current status of each platform capability, derived from real config. */
export const capabilityStatuses = (): CapabilityStatus[] => {
  const openrouter = hasEnv('OPENROUTER_API_KEY');
  const nvidia = hasEnv('NVIDIA_API_KEY');
  const places = Boolean(FOURSQUARE_API_KEY);
  return [
    {
      id: 'provider.openrouter',
      label: 'OpenRouter (models + tool calling)',
      status: openrouter ? 'ok' : 'unavailable',
      detail: openrouter ? 'Platform key present.' : 'No platform key — chat/tools/swarm need a key (BYOK or env).',
      envVar: 'OPENROUTER_API_KEY'
    },
    {
      id: 'provider.nvidia',
      label: 'NVIDIA (alternate models)',
      status: nvidia ? 'ok' : 'unavailable',
      detail: nvidia ? 'Platform key present.' : 'No NVIDIA key (optional).',
      envVar: 'NVIDIA_API_KEY'
    },
    {
      id: 'tool.find_places',
      label: 'Places / local search',
      status: places ? 'ok' : 'degraded',
      detail: places
        ? 'Foursquare configured — ratings, price and photos available.'
        : 'Using keyless OpenStreetMap (distance/hours/map, limited photos, no ratings/menus).',
      envVar: 'FOURSQUARE_API_KEY'
    },
    { id: 'tool.web_search', label: 'Web search (DuckDuckGo)', status: 'ok', detail: 'Keyless.' },
    { id: 'tool.get_news', label: 'News (Google News)', status: 'ok', detail: 'Keyless.' },
    { id: 'tool.get_weather', label: 'Weather (Open-Meteo)', status: 'ok', detail: 'Keyless.' },
    { id: 'tool.get_stock', label: 'Stocks (Stooq)', status: 'ok', detail: 'Keyless.' },
    { id: 'tool.show_map', label: 'Maps (OpenStreetMap)', status: 'ok', detail: 'Keyless.' },
    { id: 'tool.video_search', label: 'Video search (DuckDuckGo)', status: 'ok', detail: 'Keyless.' },
    { id: 'tool.image_search', label: 'Image search (DuckDuckGo)', status: 'ok', detail: 'Keyless.' },
    { id: 'tool.run_agent_swarm', label: 'Agent swarm', status: openrouter ? 'ok' : 'unavailable', detail: openrouter ? 'Available.' : 'Needs OpenRouter (tool calling).' }
  ];
};

export const capabilityReport = (): CapabilityReport => ({
  capabilities: capabilityStatuses(),
  recentNotices: recentNotices(50)
});
