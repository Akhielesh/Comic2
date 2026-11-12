// StackedBars on the colour layer's hue palette (CL-0 #9): series i is hue i in its fixed order, its legend swatch the
// same hue's dot, and a sixth series ("Other") folds into one neutral chart step. No series reads a status or info token.
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HUE_DOT, HUE_FILL } from '../../chat/studioDesign';
import { StackedBars, seriesFill, seriesSwatch } from './Sparkline';
import { SERIES_GROUPS } from './insightsModel';

describe('StackedBars series colours (CL-0 #9)', () => {
  it('series 1-5 take hues 1-5 in order; past the fifth one neutral chart step', () => {
    expect([0, 1, 2, 3, 4].map(seriesFill)).toEqual([...HUE_FILL]);
    expect([0, 1, 2, 3, 4].map(seriesSwatch)).toEqual([...HUE_DOT]);
    expect(seriesFill(5)).toBe('fill-[var(--ds-chart-3)]');
    expect(seriesSwatch(5)).toBe('bg-[var(--ds-chart-3)]');
    expect(seriesFill(9)).toBe(seriesFill(5));
  });

  it('the spend chart draws each kind in its hue, names it in the legend, and never paints a status or info token', () => {
    const { container } = render(
      <StackedBars
        label="Spent over time, by kind"
        bars={[{ key: 'w1', label: 'Week 1', total: 6, segments: SERIES_GROUPS.map((g) => ({ id: g.id, value: 1 })) }]}
        series={SERIES_GROUPS}
        format={(n) => `${n}`}
      />
    );
    const rects = [...container.querySelectorAll('rect')];
    expect(rects.map((r) => r.getAttribute('class'))).toEqual([...HUE_FILL, 'fill-[var(--ds-chart-3)]']);
    const legend = within(screen.getByRole('list', { name: 'Legend' })).getAllByRole('listitem');
    expect(legend.map((li) => li.textContent)).toEqual(SERIES_GROUPS.map((g) => g.label));
    legend.forEach((li, i) => expect(li.querySelector('span')?.className).toContain(i < 5 ? HUE_DOT[i] : 'bg-[var(--ds-chart-3)]'));
    expect(container.innerHTML).not.toMatch(/--ds-(info|success|warning|accent)\b/);
  });
});
