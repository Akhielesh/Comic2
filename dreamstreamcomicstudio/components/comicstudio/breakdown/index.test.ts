// The breakdown barrel re-exports the fit dot and the free layout fix (A5 wave note 3), so other surfaces that show
// plan fit (the lettering chip, templates) reuse one implementation instead of copying it.
import { describe, expect, it } from 'vitest';
import * as barrel from './index';
import { fitWords, layoutFitFix, paidAmount } from './BreakdownCard';
import { FIT_DOT_COLOR, fitDotOf } from './PageWireframe';

describe('breakdown barrel', () => {
  it('re-exports the fit helpers as the same functions', () => {
    expect(barrel.fitDotOf).toBe(fitDotOf);
    expect(barrel.FIT_DOT_COLOR).toBe(FIT_DOT_COLOR);
    expect(barrel.layoutFitFix).toBe(layoutFitFix);
    expect(barrel.paidAmount).toBe(paidAmount);
    // The breakdown never extends a gate itself (the held-back notice beside the gate does): no gate helper.
    expect('gateRenderAll' in barrel).toBe(false);
    expect(barrel.fitWords).toBe(fitWords);
    expect(barrel.fitDotOf('overfull')).toBe('overfull');
  });
});
