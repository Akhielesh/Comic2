import { describe, it, expect } from 'vitest';
import { BUILTIN_RECIPES, getBuiltinRecipe } from './library.js';
import { resolveRecipe } from './validate.js';

describe('built-in recipe library', () => {
  it('ships a non-empty, valid set of recipes', () => {
    expect(BUILTIN_RECIPES.length).toBeGreaterThan(0);
    for (const r of BUILTIN_RECIPES) {
      expect(r.id).toBeTruthy();
      expect(r.title).toBeTruthy();
      // goose core rule: instructions or prompt must be present.
      expect(Boolean(r.instructions || r.prompt)).toBe(true);
    }
  });

  it('has unique ids', () => {
    const ids = BUILTIN_RECIPES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every recipe resolves with only its default + a stub for each required param', () => {
    for (const r of BUILTIN_RECIPES) {
      const values: Record<string, unknown> = {};
      for (const p of r.parameters || []) {
        if (p.requirement === 'required') values[p.key] = p.input_type === 'number' ? 1 : 'sample';
      }
      const res = resolveRecipe(r, values);
      expect(res.missing, `recipe ${r.id} missing ${res.missing.join(',')}`).toEqual([]);
      expect(res.resolved).toBeDefined();
      // No unresolved placeholders should remain.
      expect(res.resolved!.instructions).not.toMatch(/\{\{/);
      expect(res.resolved!.prompt).not.toMatch(/\{\{/);
    }
  });

  it('exposes the self-improvement retrospective recipe', () => {
    const retro = getBuiltinRecipe('self-retrospective');
    expect(retro).toBeDefined();
    expect(retro!.response?.json_schema).toBeDefined();
  });
});
