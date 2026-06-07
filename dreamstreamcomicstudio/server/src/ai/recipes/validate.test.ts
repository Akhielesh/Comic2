import { describe, it, expect } from 'vitest';
import { sanitizeRecipe, resolveRecipe } from './validate.js';

describe('sanitizeRecipe', () => {
  it('rejects a recipe with no title', () => {
    expect(sanitizeRecipe({ instructions: 'do a thing' })).toBeNull();
  });

  it('rejects a recipe with neither instructions nor prompt (goose core rule)', () => {
    expect(sanitizeRecipe({ title: 'Empty' })).toBeNull();
  });

  it('accepts a minimal valid recipe and assigns an id from the title', () => {
    const r = sanitizeRecipe({ title: 'My Cool Recipe', prompt: 'Go.' });
    expect(r).not.toBeNull();
    expect(r!.id).toBe('my-cool-recipe');
    expect(r!.version).toBeTruthy();
  });

  it('filters tools to the allowlist and drops the swarm tool', () => {
    const r = sanitizeRecipe({
      title: 'T',
      instructions: 'x',
      tools: ['web_search', 'not_a_real_tool', 'run_agent_swarm']
    });
    expect(r!.tools).toEqual(['web_search']);
  });

  it('keeps only real agent ids and marks the recipe as a swarm when agents are present', () => {
    const r = sanitizeRecipe({ title: 'T', instructions: 'x', agents: ['research', 'nope'] });
    expect(r!.agents).toEqual(['research']);
    expect(r!.swarm).toBe(true);
  });

  it('sanitizes parameters (type/requirement defaults, select options)', () => {
    const r = sanitizeRecipe({
      title: 'T',
      instructions: 'x {{ depth }}',
      parameters: [
        { key: 'Depth Level', input_type: 'select', requirement: 'optional', options: ['a', 'b'], default: 'a' },
        { key: 'bad', input_type: 'weird', requirement: 'whatever' }
      ]
    });
    const params = r!.parameters!;
    expect(params[0].key).toBe('depth_level');
    expect(params[0].input_type).toBe('select');
    expect(params[0].options).toEqual(['a', 'b']);
    expect(params[1].input_type).toBe('string'); // fell back
    expect(params[1].requirement).toBe('optional'); // fell back
  });

  it('caps overly long strings', () => {
    const long = 'x'.repeat(10000);
    const r = sanitizeRecipe({ title: long, instructions: long });
    expect(r!.title.length).toBeLessThanOrEqual(120);
    expect(r!.instructions!.length).toBeLessThanOrEqual(8000);
  });
});

describe('resolveRecipe', () => {
  const recipe = sanitizeRecipe({
    title: 'Brief',
    instructions: 'Research {{ topic }} for {{ audience | default("an exec") }}. {% if deep %}Go deep.{% endif %}',
    parameters: [
      { key: 'topic', input_type: 'string', requirement: 'required' },
      { key: 'audience', input_type: 'string', requirement: 'optional', default: 'an exec' },
      { key: 'deep', input_type: 'boolean', requirement: 'optional', default: false }
    ]
  })!;

  it('reports missing required params instead of throwing', () => {
    const res = resolveRecipe(recipe, {});
    expect(res.missing).toEqual(['topic']);
    expect(res.resolved).toBeUndefined();
  });

  it('applies defaults and renders the instructions', () => {
    const res = resolveRecipe(recipe, { topic: 'fusion' });
    expect(res.missing).toEqual([]);
    expect(res.resolved!.instructions).toBe('Research fusion for an exec. ');
    expect(res.resolved!.values.audience).toBe('an exec');
  });

  it('coerces booleans and toggles conditional blocks', () => {
    const res = resolveRecipe(recipe, { topic: 'fusion', deep: 'true' });
    expect(res.resolved!.instructions).toContain('Go deep.');
    expect(res.resolved!.values.deep).toBe(true);
  });

  it('coerces numbers', () => {
    const r = sanitizeRecipe({
      title: 'N',
      prompt: 'panels: {{ n }}',
      parameters: [{ key: 'n', input_type: 'number', requirement: 'required' }]
    })!;
    const res = resolveRecipe(r, { n: '6' });
    expect(res.resolved!.values.n).toBe(6);
    expect(res.resolved!.prompt).toBe('panels: 6');
  });
});
