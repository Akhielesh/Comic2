import { describe, it, expect } from 'vitest';
import { applyAgentStep } from './agentActivity';
import type { AgentActivityArtifact, AgentActivityEvent } from '../../apiTypes';

const ev = (e: Partial<AgentActivityEvent> & Pick<AgentActivityEvent, 'phase' | 'tool'>): AgentActivityEvent => ({
  index: 0,
  iteration: 0,
  ...e
});

describe('applyAgentStep', () => {
  it('adds a running step on start', () => {
    const out = applyAgentStep(undefined, ev({ phase: 'start', tool: 'web_search', query: 'nvda' }));
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]).toMatchObject({ tool: 'web_search', query: 'nvda', status: 'running', round: 0 });
    expect(out.done).toBe(false);
  });

  it('settles the matching step to done on a successful end (preserving the query)', () => {
    let a: AgentActivityArtifact | undefined;
    a = applyAgentStep(a, ev({ phase: 'start', tool: 'web_search', query: 'nvda' }));
    a = applyAgentStep(a, ev({ phase: 'end', tool: 'web_search', query: 'nvda', ok: true, summary: '6 results' }));
    expect(a.steps).toHaveLength(1); // settles in place, does NOT duplicate
    expect(a.steps[0]).toMatchObject({ status: 'done', summary: '6 results', query: 'nvda' });
  });

  it('settles to error when the tool failed', () => {
    let a: AgentActivityArtifact | undefined;
    a = applyAgentStep(a, ev({ phase: 'start', tool: 'get_stock', query: 'NVDA' }));
    a = applyAgentStep(a, ev({ phase: 'end', tool: 'get_stock', query: 'NVDA', ok: false, summary: 'rate limited' }));
    expect(a.steps[0]).toMatchObject({ status: 'error', summary: 'rate limited' });
  });

  it('tracks several concurrent tools in one round and settles them independently, out of order', () => {
    let a: AgentActivityArtifact | undefined;
    // A single model round dispatches three tools at once (index 0,1,2).
    a = applyAgentStep(a, ev({ phase: 'start', tool: 'get_news', index: 0, iteration: 1 }));
    a = applyAgentStep(a, ev({ phase: 'start', tool: 'get_weather', index: 1, iteration: 1 }));
    a = applyAgentStep(a, ev({ phase: 'start', tool: 'show_map', index: 2, iteration: 1 }));
    expect(a.steps).toHaveLength(3);
    expect(a.steps.every((s) => s.status === 'running')).toBe(true);
    // They finish in a DIFFERENT order than they started.
    a = applyAgentStep(a, ev({ phase: 'end', tool: 'show_map', index: 2, iteration: 1, ok: true, summary: 'map' }));
    a = applyAgentStep(a, ev({ phase: 'end', tool: 'get_news', index: 0, iteration: 1, ok: true, summary: 'news' }));
    expect(a.steps).toHaveLength(3); // still three — none duplicated
    expect(a.steps.find((s) => s.tool === 'show_map')?.status).toBe('done');
    expect(a.steps.find((s) => s.tool === 'get_news')?.status).toBe('done');
    expect(a.steps.find((s) => s.tool === 'get_weather')?.status).toBe('running'); // still in flight
  });

  it('does NOT collapse the same tool used in different rounds', () => {
    let a: AgentActivityArtifact | undefined;
    a = applyAgentStep(a, ev({ phase: 'start', tool: 'web_search', iteration: 1 }));
    a = applyAgentStep(a, ev({ phase: 'end', tool: 'web_search', iteration: 1, ok: true }));
    a = applyAgentStep(a, ev({ phase: 'start', tool: 'web_search', iteration: 2 }));
    expect(a.steps).toHaveLength(2); // round 1 and round 2 are distinct steps
    expect(a.steps[0].status).toBe('done');
    expect(a.steps[1].status).toBe('running');
  });

  it('records an end with no matching start as already settled (defensive)', () => {
    const a = applyAgentStep(undefined, ev({ phase: 'end', tool: 'read_url', ok: true, summary: 'read' }));
    expect(a.steps).toHaveLength(1);
    expect(a.steps[0]).toMatchObject({ tool: 'read_url', status: 'done', summary: 'read' });
  });

  it('preserves prior steps immutably (does not mutate the input artifact)', () => {
    const prior: AgentActivityArtifact = { steps: [{ id: '0:0:web_search', tool: 'web_search', status: 'running', round: 0 }], done: false };
    const out = applyAgentStep(prior, ev({ phase: 'start', tool: 'get_news', index: 1 }));
    expect(prior.steps).toHaveLength(1); // input untouched
    expect(out.steps).toHaveLength(2);
    expect(out.steps).not.toBe(prior.steps);
  });
});
