import { describe, it, expect } from 'vitest';
import {
  runStudioAgents,
  runStudioAgentsParallel,
  sanitizeAgentIds,
  studioAgentCatalog,
  STUDIO_AGENTS,
  STUDIO_AGENT_ORDER,
  DEFAULT_STUDIO_AGENTS,
  type StudioAgentEvent
} from './studioAgents.js';

const fixJson = (path: string, content: string, note = 'ok') =>
  JSON.stringify({ note, files: [{ path, content }] });

describe('studioAgents — multi-agent refinement pipeline', () => {
  it('sanitizeAgentIds keeps known ids in canonical order and falls back to defaults', () => {
    // Out-of-order + unknown ids → canonical order, unknowns dropped.
    expect(sanitizeAgentIds(['security', 'architecture', 'bogus'])).toEqual(['architecture', 'security']);
    // Empty / invalid → the default team.
    expect(sanitizeAgentIds([])).toEqual(DEFAULT_STUDIO_AGENTS);
    expect(sanitizeAgentIds('nope')).toEqual(DEFAULT_STUDIO_AGENTS);
  });

  it('catalog exposes every agent without leaking prompts', () => {
    const cat = studioAgentCatalog();
    expect(cat.map((a) => a.id)).toEqual(STUDIO_AGENT_ORDER);
    expect(cat.every((a) => 'name' in a && 'description' in a && !('focus' in a))).toBe(true);
    expect(cat.find((a) => a.id === 'data')!.hasTools).toBe(true);
  });

  it('includes an opt-in Integrations agent wired with the Nango tools', () => {
    const integrations = STUDIO_AGENTS.integrations;
    expect(integrations).toBeDefined();
    expect(integrations.default).toBe(false); // opt-in (needs Nango configured)
    expect(integrations.toolNames).toContain('nango_call_api');
    expect(STUDIO_AGENT_ORDER).toContain('integrations');
    expect(studioAgentCatalog().find((a) => a.id === 'integrations')!.hasTools).toBe(true);
  });

  it('runs enabled agents in order, applies diffs cumulatively, emits events', async () => {
    const events: StudioAgentEvent[] = [];
    const seen: string[] = [];
    const result = await runStudioAgents(
      { '/App.tsx': 'v0' },
      ['verification', 'architecture'], // intentionally reversed → should run architecture first
      'make it nice',
      {
        complete: async (prompt, toolNames) => {
          // Record which agent ran by matching its name in the prompt.
          const agent = STUDIO_AGENT_ORDER.find((id) => prompt.includes(`You are the ${STUDIO_AGENTS[id].name} `));
          seen.push(agent!);
          void toolNames;
          return fixJson('/App.tsx', `v0+${agent}`, `${agent} pass`);
        },
        onEvent: (e) => events.push(e)
      }
    );
    // Canonical order: architecture before verification.
    expect(seen).toEqual(['architecture', 'verification']);
    // Cumulative: the last agent's edit wins on the shared file.
    expect(result.files['/App.tsx']).toBe('v0+verification');
    expect(result.trace.map((t) => t.status)).toEqual(['done', 'done']);
    expect(events.some((e) => e.stage === 'done')).toBe(true);
  });

  it('marks empty diffs as skipped and continues past an agent error', async () => {
    const result = await runStudioAgents(
      { '/App.tsx': 'base' },
      ['architecture', 'code', 'security'],
      '',
      {
        complete: async (prompt) => {
          if (prompt.includes(`You are the ${STUDIO_AGENTS.architecture.name} `)) return JSON.stringify({ note: 'all good', files: [] });
          if (prompt.includes(`You are the ${STUDIO_AGENTS.code.name} `)) throw new Error('model blew up');
          return fixJson('/App.tsx', 'secured');
        }
      }
    );
    const byId = Object.fromEntries(result.trace.map((t) => [t.id, t.status]));
    expect(byId.architecture).toBe('skipped');
    expect(byId.code).toBe('error');
    expect(byId.security).toBe('done');
    expect(result.files['/App.tsx']).toBe('secured');
  });

  it('canonicalizes paths so diffs overwrite instead of duplicating files', async () => {
    const result = await runStudioAgents(
      { 'App.tsx': 'no-slash' }, // initial key without a leading slash
      ['architecture'],
      '',
      { complete: async () => fixJson('App.tsx', 'fixed') } // diff also without a slash
    );
    expect(Object.keys(result.files)).toEqual(['/App.tsx']);
    expect(result.files['/App.tsx']).toBe('fixed');
  });
});

describe('runStudioAgentsParallel — parallel review → single synthesis', () => {
  it('reviews concurrently, feeds findings into one synthesis writer', async () => {
    const reviewed: string[] = [];
    const result = await runStudioAgentsParallel(
      { '/App.tsx': 'base' },
      ['architecture', 'code', 'verification'],
      'make it great',
      {
        review: async (prompt, toolNames) => {
          const id = STUDIO_AGENT_ORDER.find((x) => prompt.includes(`You are the ${STUDIO_AGENTS[x].name} `));
          reviewed.push(id!);
          void toolNames;
          return JSON.stringify({ findings: id === 'architecture' ? ['/App.tsx: weak structure -> split it'] : [] });
        },
        synthesize: async (prompt) => {
          expect(prompt).toContain('weak structure'); // findings are fed into synthesis
          return JSON.stringify({ note: 'applied', files: [{ path: '/App.tsx', content: 'synthesized' }] });
        }
      }
    );
    expect(reviewed.sort()).toEqual(['architecture', 'code', 'verification']);
    expect(result.files['/App.tsx']).toBe('synthesized');
    expect(result.trace.find((t) => t.id === 'synthesis')!.status).toBe('done');
  });

  it('skips synthesis entirely when no reviewer finds anything', async () => {
    let synthCalls = 0;
    const result = await runStudioAgentsParallel(
      { '/App.tsx': 'base' },
      ['code'],
      '',
      { review: async () => JSON.stringify({ findings: [] }), synthesize: async () => { synthCalls += 1; return ''; } }
    );
    expect(synthCalls).toBe(0);
    expect(result.files['/App.tsx']).toBe('base'); // unchanged
  });
});
