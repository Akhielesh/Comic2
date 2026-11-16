import { describe, expect, it } from 'vitest';
import { createEmptyDoc, normalizeDoc, planInputHashOf } from './doc';
import { applyOps } from './ops';

describe('story length intent', () => {
  it('starts adaptive, preserves legacy counts, and records explicit page choices without putting guesses in charge', () => {
    const fresh = createEmptyDoc('new');
    expect(fresh.format.pageCountMode).toBe('auto');
    const legacy = structuredClone(fresh);
    delete legacy.format.pageCountMode;
    expect(normalizeDoc(legacy).format.pageCountMode).toBeUndefined();
    const requested = applyOps(fresh, [{ op: 'format', patch: { pageCount: 12 } }]);
    expect(requested.format).toMatchObject({ pageCountMode: 'fixed', pageCount: 12 });
    const estimate = applyOps(fresh, [{ op: 'format', patch: { pageCount: 9, pageCountMode: 'auto' } }]);
    expect(estimate.format).toMatchObject({ pageCountMode: 'auto', pageCount: 9 });
    expect(normalizeDoc(estimate).format.pageCountMode).toBe('auto');
    expect(planInputHashOf(requested)).not.toBe(planInputHashOf({ ...requested, format: { ...requested.format, pageCountMode: 'auto' } }));
    expect(planInputHashOf(estimate)).toBe(planInputHashOf(normalizeDoc(estimate)));
  });
});
