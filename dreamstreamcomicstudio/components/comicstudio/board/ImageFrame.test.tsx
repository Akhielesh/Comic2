// board/ImageFrame — the corner badges over art ("1:1 · book is 4:5", "From older photos").
// A badge is a flex pill, and text directly inside a flex container is an anonymous flex item that
// `text-overflow` never applies to: a long badge on a narrow card was clipped mid-word with no
// ellipsis (layoutLint `flex-truncate`, P2-BOARD). The text must sit in its own truncating span.
// jsdom can't measure, so these check the structure that makes the ellipsis possible.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FrameBadge, ImageFrame } from './ImageFrame';

const DISPLAY_FLEX = /^(?:[\w-]+:)*!?(?:inline-)?flex$/;
const tokens = (el: Element): string[] => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
/** Every element in `root` (itself included) that is a flex box AND asks for an ellipsis. */
const flexTruncating = (root: Element): Element[] =>
  [root, ...Array.from(root.querySelectorAll('*'))].filter((el) => {
    const t = tokens(el);
    return t.some((c) => DISPLAY_FLEX.test(c)) && t.includes('truncate');
  });

const LONG = 'From older photos — redraw this sheet to use the three you added this morning';

describe('FrameBadge', () => {
  it('a long badge ellipsizes: the text sits in an inner min-w-0 truncate span, never on the flex pill', () => {
    render(<FrameBadge title="This sheet was drawn before your newest photos.">{LONG}</FrameBadge>);
    const text = screen.getByText(LONG);
    expect(tokens(text)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
    expect(tokens(text).some((c) => DISPLAY_FLEX.test(c))).toBe(false);

    const pill = text.closest('[data-frame-badge]');
    expect(pill).not.toBeNull();
    expect(pill).not.toBe(text);
    // The pill can shrink to its container (so the inner span has a width to ellipsize against)…
    expect(tokens(pill!)).toEqual(expect.arrayContaining(['inline-flex', 'min-w-0', 'max-w-full']));
    // …and nothing in the badge combines a flex box with truncate.
    expect(flexTruncating(pill!)).toEqual([]);
    // The full explanation stays one hover away.
    expect(pill).toHaveAttribute('title', 'This sheet was drawn before your newest photos.');
  });

  it('keeps its tone on the pill (warn is the amber aspect-mismatch badge)', () => {
    render(
      <>
        <FrameBadge tone="warn">1:1 · book is 4:5</FrameBadge>
        <FrameBadge>From older photos</FrameBadge>
      </>
    );
    const warn = screen.getByText('1:1 · book is 4:5').closest('[data-frame-badge]')!;
    const info = screen.getByText('From older photos').closest('[data-frame-badge]')!;
    expect(tokens(warn)).toContain('bg-amber-500/90');
    expect(tokens(info)).toContain('bg-[var(--ds-surface-strong)]');
    expect(flexTruncating(warn)).toEqual([]);
    expect(flexTruncating(info)).toEqual([]);
  });
});

describe('ImageFrame badges', () => {
  it('pins badges in the top-left corner over the art, inside the frame, and they still ellipsize', () => {
    const { container } = render(
      <ImageFrame
        url="https://example.test/sheet.webp"
        aspect="4 / 5"
        alt="Maya sheet"
        badges={
          <>
            <FrameBadge tone="warn">1:1 · book is 4:5</FrameBadge>
            <FrameBadge>{LONG}</FrameBadge>
          </>
        }
      />
    );
    const frame = container.firstElementChild!;
    expect(frame).toContainElement(screen.getByRole('img', { name: 'Maya sheet' }));
    const long = screen.getByText(LONG);
    expect(frame).toContainElement(long);
    // The corner is bounded by the frame and wraps, so a long badge shrinks instead of overflowing.
    const corner = long.closest('[data-frame-badge]')!.parentElement!;
    expect(tokens(corner)).toEqual(expect.arrayContaining(['absolute', 'left-1.5', 'top-1.5', 'flex-wrap', 'max-w-[calc(100%-0.75rem)]']));
    expect(flexTruncating(frame)).toEqual([]);
  });
});

describe('ImageFrame safety', () => {
  it('a blocked image offers Redraw safer with the price the host formatted for this user', () => {
    const onRedrawSafer = vi.fn();
    render(
      <ImageFrame
        aspect="3 / 2"
        alt="Cover"
        asset={{ path: 'u/proj/cover.png', source: 'generated', at: 1, safety: { assessed: 'X', at: 1 } }}
        safety={{ rating: 'PG-13', onRedrawSafer, redrawPrice: '≈3% of your usage' }}
      />
    );
    expect(screen.queryByRole('img', { name: 'Cover' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Redraw safer · ≈3% of your usage' }));
    expect(onRedrawSafer).toHaveBeenCalled();
  });
});

// A FAILED tile painted its "Not drawn yet" / initials placeholder under the (opaque) failure card, and
// a DRAWING tile painted the initials' hint under the "Still drawing · Check again" pill: text under
// text for the layout scanner, and nothing a reader could use (ui-findings 2026-10-29,
// style-tile-failed-text-overlap / cast-card-sheet-hint-overlap).
describe('ImageFrame placeholder under an overlay', () => {
  it('drops the placeholder while the failure card or the drawing shimmer is up, and shows it again for a render still to come', () => {
    const placeholder = <div>Not drawn yet</div>;
    const { rerender } = render(
      <ImageFrame aspect="4 / 5" alt="Riso style board" render={{ status: 'failed', history: [], error: 'boom', updatedAt: 1 }} placeholder={placeholder} overlay={<div data-testid="ov">failed</div>} />
    );
    expect(screen.queryByText('Not drawn yet')).toBeNull();
    expect(screen.getByTestId('ov')).toBeInTheDocument();
    rerender(<ImageFrame aspect="4 / 5" alt="Riso style board" render={{ status: 'rendering', history: [], updatedAt: 1 }} placeholder={placeholder} overlay={<div data-testid="ov">drawing</div>} />);
    expect(screen.queryByText('Not drawn yet')).toBeNull();
    rerender(<ImageFrame aspect="4 / 5" alt="Riso style board" render={{ status: 'none', history: [] }} placeholder={placeholder} overlay={<div data-testid="ov">planned</div>} />);
    expect(screen.getByText('Not drawn yet')).toBeInTheDocument();
  });
});
