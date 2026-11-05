import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StudioLogo } from './StudioLogo';
import { STUDIO_MARKS, STUDIOS } from './studios';

const rootOf = (container: HTMLElement) => container.firstElementChild as HTMLElement;

describe('StudioLogo', () => {
  it.each(STUDIOS)('%s: mark plus "<First> Studio", "Studio" muted, the mark decorative', (studio) => {
    const { container } = render(<StudioLogo studio={studio} />);
    const root = rootOf(container);
    expect(root).toHaveClass('ds-logo', 'ds-logo--header');
    expect(root.getAttribute('translate')).toBe('no');
    expect(root.textContent).toBe(`${STUDIO_MARKS[studio].first} Studio`);
    const muted = root.querySelector('.ds-logo-word-muted')!;
    expect(muted.textContent).toBe('Studio');
    expect(muted.parentElement).toHaveClass('ds-logo-word');
    const mark = root.querySelector('svg')!;
    expect(mark).toHaveClass(`ds-logo-mark--${studio}`);
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('img')).toBeNull();
    expect(root.querySelector('.ds-logo-overline')).toBeNull();
  });

  it.each(['header', 'display', 'compact'] as const)('size %s sets its lockup class', (size) => {
    const { container } = render(<StudioLogo studio="dreamstream" size={size} />);
    expect(rootOf(container)).toHaveClass('ds-logo', `ds-logo--${size}`);
    expect(rootOf(container).className).not.toMatch(/\b(h|w|text|gap)-\S+/); // plain CSS, no Tailwind
  });

  it.each(['comic', 'stream'] as const)('endorsed %s stacks a DreamStream overline over the wordmark', (studio) => {
    const { container } = render(<StudioLogo studio={studio} endorsed />);
    const root = rootOf(container);
    expect(root).toHaveClass('ds-logo--endorsed');
    const stack = root.querySelector('.ds-logo-stack')!;
    const [overline, word] = [...stack.children];
    expect(overline).toHaveClass('ds-logo-overline');
    expect(overline.textContent).toBe('DreamStream');
    expect(word).toHaveClass('ds-logo-word');
    // Read in order, the lockup says the product's full name.
    expect(root.textContent).toBe(`DreamStream${STUDIO_MARKS[studio].first} Studio`);
  });

  it.each(['dreamstream', 'atlas'] as const)('never endorses %s (the house mark, and Atlas, carry no endorsement)', (studio) => {
    const { container } = render(<StudioLogo studio={studio} endorsed />);
    expect(rootOf(container)).not.toHaveClass('ds-logo--endorsed');
    expect(rootOf(container).querySelector('.ds-logo-overline')).toBeNull();
  });

  it('without a label it is the mark alone, named for assistive tech', () => {
    const { container } = render(<StudioLogo studio="comic" showLabel={false} endorsed />);
    expect(screen.getByRole('img', { name: 'Comic Studio' })).toBeInTheDocument();
    expect(rootOf(container).textContent).toBe('');
    expect(rootOf(container)).not.toHaveClass('ds-logo--endorsed');
  });

  it('passes loading and the class hooks through', () => {
    const { container } = render(
      <StudioLogo studio="stream" loading className="outer" markClassName="m" labelClassName="l" style={{ color: 'blue' }} />,
    );
    const root = rootOf(container);
    expect(root).toHaveClass('outer');
    expect(root.style.color).toBe('blue');
    expect(root.querySelector('svg')).toHaveClass('ds-logo-mark--loading', 'm');
    expect(root.querySelector('.ds-logo-word')).toHaveClass('l');
  });

  it('names a link by its visible text', () => {
    render(
      <a href="/">
        <StudioLogo studio="dreamstream" />
      </a>,
    );
    expect(screen.getByRole('link', { name: 'DreamStream Studio' })).toBeInTheDocument();
  });
});
