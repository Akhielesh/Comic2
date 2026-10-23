// board/ImageFrame — the corner badges over art ("1:1 · book is 4:5", "From older photos").
// A badge is a flex pill, and text directly inside a flex container is an anonymous flex item that
// `text-overflow` never applies to: a long badge on a narrow card was clipped mid-word with no
// ellipsis (layoutLint `flex-truncate`, P2-BOARD). The text must sit in its own truncating span.
// jsdom can't measure, so these check the structure that makes the ellipsis possible.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
