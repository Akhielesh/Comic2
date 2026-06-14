import { describe, it, expect } from 'vitest';
import { planReskin } from './reskin';

describe('planReskin', () => {
  it('separates entities with sheets (re-skin) from those without (fresh)', () => {
    const plan = planReskin([
      { id: 'a', name: 'Maya', imageUrl: 'u' },
      { id: 'b', name: 'Cole', referenceImageIds: ['r1'] },
      { id: 'c', name: 'Vendor' },
    ]);
    expect(plan.reskin.map((r) => r.name).sort()).toEqual(['Cole', 'Maya']);
    expect(plan.fresh.map((f) => f.name)).toEqual(['Vendor']);
  });

  it('estimates cost per re-skinned sheet and frames the choice', () => {
    const plan = planReskin([{ id: 'a', name: 'Maya', imageUrl: 'u' }, { id: 'b', name: 'Cole', imageId: 'i' }], 0.05);
    expect(plan.estimateUsd).toBe(0.1);
    expect(plan.summary).toContain('Re-skin 2 cast sheets');
  });

  it('says nothing to migrate when no sheets exist', () => {
    const plan = planReskin([{ id: 'a', name: 'Maya' }]);
    expect(plan.reskin).toEqual([]);
    expect(plan.estimateUsd).toBe(0);
    expect(plan.summary).toContain('No existing cast art');
  });
});
