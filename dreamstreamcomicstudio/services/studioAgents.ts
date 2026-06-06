// Client-side catalog of Code Studio's specialist refinement agents.
//
// Mirrors the server roster (server/src/ai/studio/studioAgents.ts) by id so the UI can render
// agent toggles and the live refinement trace without a network round-trip. The server remains
// the source of truth for the actual prompts/tools; this is metadata for selection + display.

export interface StudioAgentMeta {
  id: string;
  name: string;
  description: string;
  /** Lucide icon name (mapped to a component in the UI). */
  icon: string;
  /** On by default. */
  default: boolean;
  /** Uses live web/data tools (shown with a "live data" hint). */
  hasTools: boolean;
}

// Order matches the server's canonical run order.
export const STUDIO_AGENT_CATALOG: StudioAgentMeta[] = [
  { id: 'architecture', name: 'Architect', icon: 'Building2', default: true, hasTools: false, description: 'Project structure, module boundaries, state & scalability.' },
  { id: 'code', name: 'Code Engineer', icon: 'Code2', default: true, hasTools: true, description: 'Code quality, correctness, completeness & idiomatic patterns.' },
  { id: 'frontend', name: 'Frontend', icon: 'MonitorSmartphone', default: true, hasTools: false, description: 'Framework correctness, hooks, performance & build config.' },
  { id: 'ui', name: 'UI / UX', icon: 'Layout', default: true, hasTools: false, description: 'Layout, interaction, accessibility & responsive design.' },
  { id: 'design', name: 'Visual Design', icon: 'Palette', default: false, hasTools: false, description: 'Typography, color, spacing system & aesthetic polish.' },
  { id: 'data', name: 'Data & Live APIs', icon: 'Database', default: false, hasTools: true, description: 'Wires real, LIVE data sources & robust fetching into the app.' },
  { id: 'security', name: 'Security', icon: 'ShieldCheck', default: true, hasTools: true, description: 'Input validation, secrets, XSS/injection & safe defaults.' },
  { id: 'verification', name: 'Verification / QA', icon: 'CheckCircle2', default: true, hasTools: false, description: 'Correctness, edge cases, error handling — does it actually run.' }
];

export const STUDIO_AGENT_ORDER = STUDIO_AGENT_CATALOG.map((a) => a.id);
export const DEFAULT_STUDIO_AGENT_IDS = STUDIO_AGENT_CATALOG.filter((a) => a.default).map((a) => a.id);

const BY_ID = new Map(STUDIO_AGENT_CATALOG.map((a) => [a.id, a]));
export const studioAgentMeta = (id: string): StudioAgentMeta | undefined => BY_ID.get(id);
export const studioAgentName = (id: string): string => BY_ID.get(id)?.name ?? id;

/** Validate + order a set of agent ids; empty/invalid falls back to the default team. */
export const resolveStudioAgentIds = (ids: string[] | null | undefined): string[] => {
  const set = new Set(ids ?? []);
  const picked = STUDIO_AGENT_ORDER.filter((id) => set.has(id));
  return picked.length ? picked : DEFAULT_STUDIO_AGENT_IDS;
};
