// Pure clamp-math for the resizable splitter gutter (S1.1).

import { describe, it, expect } from 'vitest';
import { applyGutterDelta } from './ResizableSplit';

describe('applyGutterDelta', () => {
  it('moves weight between the two adjacent panes', () => {
    expect(applyGutterDelta([2, 2, 2], 0, 0.5, 0.5)).toEqual([2.5, 1.5, 2]);
  });

  it('clamps so the left pane never drops below minFrac', () => {
    // a=2, minFrac=1 → most we can subtract is 1 (a→1, b→3)
    expect(applyGutterDelta([2, 2], 0, -5, 1)).toEqual([1, 3]);
  });

  it('clamps so the right pane never drops below minFrac', () => {
    // b=2, minFrac=1 → most we can add to a is 1 (a→3, b→1)
    expect(applyGutterDelta([2, 2], 0, 5, 1)).toEqual([3, 1]);
  });

  it('preserves the total weight', () => {
    const out = applyGutterDelta([1, 3, 2], 1, 0.7, 0.4);
    expect(out[0]).toBe(1); // untouched
    expect(out[1] + out[2]).toBeCloseTo(5);
  });

  it('is a no-op for an out-of-range gutter index', () => {
    expect(applyGutterDelta([1, 1], 1, 0.5, 0.2)).toEqual([1, 1]);
    expect(applyGutterDelta([1, 1], -1, 0.5, 0.2)).toEqual([1, 1]);
  });
});
