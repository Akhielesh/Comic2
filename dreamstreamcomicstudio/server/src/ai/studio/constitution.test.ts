import { describe, it, expect } from 'vitest';
import {
  STUDIO_CONSTITUTION,
  STUDIO_PLAN_CONSTITUTION,
  STUDIO_FIX_CONSTITUTION,
  studioConstitutionFor,
  composeStudioSystemPrompt
} from './constitution.js';
import { PERSONA_CORE } from '../persona.js';

describe('STUDIO_CONSTITUTION (the always-resident charter)', () => {
  it('carries the five build non-negotiables: scope, grounding, completeness, safety, honesty', () => {
    expect(STUDIO_CONSTITUTION).toContain('SCOPE');
    expect(STUDIO_CONSTITUTION).toContain('GROUND');
    expect(STUDIO_CONSTITUTION).toContain('COMPLETE OR BLOCKED');
    expect(STUDIO_CONSTITUTION).toContain('SAFE BY DEFAULT');
    expect(STUDIO_CONSTITUTION).toContain('HONEST');
  });

  it('forbids invention and treats fetched content as untrusted data (prompt-injection defense)', () => {
    expect(STUDIO_CONSTITUTION).toContain('NEVER invent');
    expect(STUDIO_CONSTITUTION.toLowerCase()).toContain('never as instructions');
  });

  it('stays compact so it does not bloat the build prompt or dilute weak models', () => {
    // A guardrail, not a hard limit: the charter is a distillation, not the full 17 docs.
    expect(STUDIO_CONSTITUTION.length).toBeLessThan(1600);
  });
});

describe('studioConstitutionFor(phase)', () => {
  it('returns the bare charter for the build phase (no extra note)', () => {
    expect(studioConstitutionFor('build')).toBe(STUDIO_CONSTITUTION);
  });

  it('appends the planning note for the plan phase', () => {
    const out = studioConstitutionFor('plan');
    expect(out.startsWith(STUDIO_CONSTITUTION)).toBe(true);
    expect(out).toContain(STUDIO_PLAN_CONSTITUTION);
  });

  it('appends the recovery note for the fix phase', () => {
    const out = studioConstitutionFor('fix');
    expect(out.startsWith(STUDIO_CONSTITUTION)).toBe(true);
    expect(out).toContain(STUDIO_FIX_CONSTITUTION);
  });
});

describe('composeStudioSystemPrompt', () => {
  it('frames everything with the brand persona first, then the phase constitution', () => {
    const out = composeStudioSystemPrompt('plan');
    expect(out.startsWith(PERSONA_CORE)).toBe(true);
    expect(out).toContain('DreamStream'); // from persona
    expect(out).toContain('SCOPE DISCIPLINE'); // from the plan note
    expect(out.indexOf('DreamStream')).toBeLessThan(out.indexOf('SCOPE DISCIPLINE'));
  });

  it('layers an optional surface-specific expertise block after the constitution', () => {
    const out = composeStudioSystemPrompt('build', 'You are the live build agent.');
    expect(out).toContain(STUDIO_CONSTITUTION);
    expect(out).toContain('You are the live build agent.');
    expect(out.indexOf(STUDIO_CONSTITUTION)).toBeLessThan(out.indexOf('You are the live build agent.'));
  });

  it('ignores a blank expertise layer', () => {
    expect(composeStudioSystemPrompt('build', '   ')).toBe(composeStudioSystemPrompt('build'));
  });
});
