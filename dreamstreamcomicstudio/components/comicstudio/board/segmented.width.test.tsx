// FX-15: studio switches show their whole words. The board kit's Segmented split its track EQUALLY (`flex-1`), so
// in an inline track the longer label was cut while the track still had room: "Com…" beside "Large" (Card size),
// "Sup…" beside "Lead" (the cast tier), the Easy | Pro switch (Editor view). Each segment is now as wide as its
// own label (flex-auto, basis = content) and a label is cut only when the parent squeezes the whole track.
//
// jsdom has no layout, so this pins the sizing contract on the real consumers; the measured check
// (scrollWidth <= clientWidth for every radio label at 1280 and 390) is in tests/e2e/studio.layout.spec.ts.
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { BoardPane } from './BoardPane';
import { Segmented } from './ui';
import { Segmented as ConversationSegmented } from '../conversation/ui';
import { ModeToggle } from '../mobile/ModeToggle';
import { makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';

const classes = (el: Element) => (el.getAttribute('class') || '').split(/\s+/);

/** Every radio sizes to its label (no equal split) and can still shrink when the track is squeezed. */
const expectWholeWordSegments = (group: HTMLElement) => {
  const radios = within(group).getAllByRole('radio');
  expect(radios.length).toBeGreaterThan(1);
  for (const r of radios) {
    const c = classes(r);
    expect(c, r.textContent || '').toContain('flex-auto');
    expect(c, r.textContent || '').not.toContain('flex-1');
    // Shrinkable only under a squeeze: min-w-0 on the segment and, for a text label, the cut lives on the label span.
    expect(c).toContain('min-w-0');
    const span = r.querySelector(':scope > span');
    if (span && typeof span.textContent === 'string' && span.textContent.trim()) expect(classes(span)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
  }
};

describe('Segmented: a segment is as wide as its label (FX-15)', () => {
  it('"Card size" on the Pages tab', () => {
    render(<BoardPane studio={makeStudio(makeSampleDoc(), { tab: 'pages' })} />);
    expectWholeWordSegments(screen.getByRole('radiogroup', { name: 'Card size' }));
  });

  it('the cast tier (Lead · Support · Extra) on every cast card', () => {
    render(<BoardPane studio={makeStudio(makeSampleDoc(), { tab: 'cast' })} />);
    const tiers = screen.getAllByRole('radiogroup', { name: / tier$/ });
    expect(tiers.length).toBeGreaterThan(0);
    for (const g of tiers) expectWholeWordSegments(g);
    expect(within(tiers[0]).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Lead', 'Support', 'Extra']);
  });

  it('"Editor view" (Easy | Pro), in the header and in the ⋯ menu', () => {
    const studio = { mode: 'easy' as const, setMode: vi.fn(), caps: { ...DEFAULT_CAPS, proEditor: true } };
    const { unmount } = render(<ModeToggle studio={studio} variant="menu" />);
    expectWholeWordSegments(screen.getByRole('radiogroup', { name: 'Editor view' }));
    unmount();
  });

  it('a full-width track still fills its row (the spare width is shared, not lost)', () => {
    render(<Segmented label="Text case" value="a" onChange={() => undefined} className="w-full" options={[{ value: 'a', label: 'As typed' }, { value: 'b', label: 'UPPER' }]} />);
    const group = screen.getByRole('radiogroup', { name: 'Text case' });
    expect(classes(group)).toContain('w-full');
    expectWholeWordSegments(group);
  });

  it('the conversation kit Segmented follows the same rule (format panels)', () => {
    render(
      <ConversationSegmented
        label="Reading direction"
        value="ltr"
        onChange={() => undefined}
        options={[
          { value: 'ltr', label: 'Left to right' },
          { value: 'rtl', label: 'Right to left (manga)' }
        ]}
      />
    );
    expectWholeWordSegments(screen.getByRole('radiogroup', { name: 'Reading direction' }));
  });
});
