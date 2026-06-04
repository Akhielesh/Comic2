import { describe, it, expect } from 'vitest';
import { KNOWN_TOOL_NAMES, resolveTools, toToolSpec } from './registry.js';
import { TOOL_CATALOG } from '../../../../toolCatalog.js';

// The catalogue (client/dashboard/routing) and the server registry (execution) must
// stay in lock-step: every tool the UI advertises has to be a real, resolvable tool,
// and the server must not expose tools the catalogue doesn't document.
describe('registry ↔ catalogue consistency', () => {
  const catalogNames = TOOL_CATALOG.filter((t) => t.kind !== 'mcp').map((t) => t.name);

  it('every documented (non-MCP) tool is a known server tool', () => {
    for (const name of catalogNames) {
      expect(KNOWN_TOOL_NAMES, `catalogue tool "${name}" missing from server registry`).toContain(name);
    }
  });

  it('every known server tool is documented in the catalogue', () => {
    for (const name of KNOWN_TOOL_NAMES) {
      expect(catalogNames, `server tool "${name}" missing from catalogue`).toContain(name);
    }
  });

  it('resolves every static/contextual tool to a callable spec', () => {
    // Exclude the swarm meta-tool (built in the route with provider creds).
    const resolvable = KNOWN_TOOL_NAMES.filter((n) => n !== 'run_agent_swarm');
    const tools = resolveTools(resolvable);
    expect(tools.length).toBe(resolvable.length);
    for (const t of tools) {
      const spec = toToolSpec(t);
      expect(spec.type).toBe('function');
      expect(spec.function.name).toBe(t.name);
      expect(typeof t.execute).toBe('function');
      expect(spec.function.parameters).toBeTruthy();
    }
  });
});
