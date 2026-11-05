// @vitest-environment node
// The Model Lab's per-image A/B allowance is the plan's reference allowance (B4 wave note 6): one number, in
// shared/comic/plan.ts REF_ALLOWANCE_USD, read by both quoteRenderPages and the lab. A mocked plan module proves lab.ts
// reads it rather than repeating the literal.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REF_ALLOWANCE_USD } from '../../../../shared/comic/plan.js';
import { LAB_AB_REF_ALLOWANCE_USD } from './lab.js';

afterEach(() => {
  vi.doUnmock('../../../../shared/comic/plan.js');
  vi.resetModules();
});

describe('LAB_AB_REF_ALLOWANCE_USD', () => {
  it('is the plan allowance, $0.004 per attached image', () => {
    expect(LAB_AB_REF_ALLOWANCE_USD).toBe(REF_ALLOWANCE_USD);
    expect(LAB_AB_REF_ALLOWANCE_USD).toBe(0.004);
  });

  it('follows REF_ALLOWANCE_USD when the plan number changes (no second literal in lab.ts)', async () => {
    vi.resetModules();
    vi.doMock('../../../../shared/comic/plan.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../../shared/comic/plan.js')>()),
      REF_ALLOWANCE_USD: 0.0075
    }));
    const fresh = await import('./lab.js');
    expect(fresh.LAB_AB_REF_ALLOWANCE_USD).toBe(0.0075);
  });
});
