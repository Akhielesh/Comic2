// useLetteringFontsReady(fontIds) — lettering.md §6.2: load faces asynchronously and bump a generation
// counter as they arrive, so plans re-run with real metrics. Before that the registry estimates are
// used (no flash of unlettered art; balloons may resize once when the real face lands).

import { useEffect, useState } from 'react';
import type { FontId } from '../../../shared/comic/lettering/style';
import type { Measure } from '../../../shared/comic/lettering/layout';
import { ensureFonts, type EnsureFontsOptions } from './fontLoader';
import { measureForGeneration } from './measure';
import { useFontGeneration } from './useLetterPlans';

export interface LetteringFontsState {
  /** Bumps whenever any lettering face finishes loading. */
  generation: number;
  /** Measure for the current generation (stable identity until the next load). */
  measure: Measure;
  /** Every requested face is ready (false while loading or after a failure). */
  ready: boolean;
  /** Faces that did not load (drawn with a fallback face). */
  failed: FontId[];
}

export function useLetteringFontsReady(fontIds: readonly FontId[], opts: EnsureFontsOptions = {}): LetteringFontsState {
  const generation = useFontGeneration();
  const [state, setState] = useState<{ key: string; ready: boolean; failed: FontId[] }>({ key: '', ready: false, failed: [] });
  const key = `${[...new Set(fontIds)].sort().join(',')}|${(opts.weights || []).join('/')}|${opts.italic ? 'i' : ''}|${opts.sample || ''}`;
  useEffect(() => {
    let alive = true;
    if (!fontIds.length) {
      setState({ key, ready: true, failed: [] });
      return;
    }
    void ensureFonts(fontIds, opts).then((r) => {
      if (alive) setState({ key, ready: r.failed.length === 0, failed: r.failed });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const current = state.key === key ? state : { ready: false, failed: [] as FontId[] };
  return { generation, measure: measureForGeneration(generation), ready: current.ready, failed: current.failed };
}

export default useLetteringFontsReady;
