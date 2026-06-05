import { describe, it, expect } from 'vitest';
import { PERSONA_CORE, composePersona, withAgentPersona } from './persona.js';

describe('persona core', () => {
  it('names the brand and carries the honesty contract', () => {
    expect(PERSONA_CORE).toContain('DreamStream');
    expect(PERSONA_CORE.toLowerCase()).toContain('never fabricate');
  });
});

describe('composePersona', () => {
  it('puts the shared persona first, then the expertise layer', () => {
    const out = composePersona('You are a markets analyst.');
    expect(out.startsWith(PERSONA_CORE)).toBe(true);
    expect(out).toContain('You are a markets analyst.');
    expect(out.indexOf('DreamStream')).toBeLessThan(out.indexOf('markets analyst'));
  });

  it('returns the core unchanged when there is no layer', () => {
    expect(composePersona()).toBe(PERSONA_CORE);
    expect(composePersona('   ')).toBe(PERSONA_CORE);
  });
});

describe('withAgentPersona', () => {
  it('wraps an agent prompt in the shared identity + honesty', () => {
    const out = withAgentPersona('You are a news analyst. Fetch the latest news.');
    expect(out).toContain('DreamStream');
    expect(out).toContain('You are a news analyst.');
  });
});
