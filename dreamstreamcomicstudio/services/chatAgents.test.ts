import { describe, expect, it } from 'vitest';
import { AGENT_TOOLS, BUILTIN_AGENTS, TOOL_LABEL } from './chatAgents';
import { ALL_TOOL_NAMES } from '../toolCatalog';

// The client mirrors of the agent registry are display-only, so nothing fails loudly when a
// tool is removed server-side (as the retired app builder was). Pin them to the catalog.
describe('chat agent tool lists', () => {
  it('only offer custom agents tools that exist in the catalog', () => {
    for (const t of AGENT_TOOLS) expect(ALL_TOOL_NAMES, t.name).toContain(t.name);
  });

  it('only show built-in agents with tools that exist', () => {
    for (const agent of BUILTIN_AGENTS) {
      for (const tool of agent.toolNames) expect(ALL_TOOL_NAMES, `${agent.id}: ${tool}`).toContain(tool);
    }
  });

  it('labels the Code Engineer tools a user can also pick for a custom agent', () => {
    expect(TOOL_LABEL.render_react).toBeTruthy();
    expect(TOOL_LABEL.run_python).toBeTruthy();
  });
});
