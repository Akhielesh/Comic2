import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button, BUTTON_BASE, BUTTON_SIZE, BUTTON_SIZES, BUTTON_VARIANT, BUTTON_VARIANTS, buttonClasses } from './Button';
import { IconButton, ICON_BUTTON_SIZE } from './IconButton';
import { ACCENT_FILL, ACCENT_FILL_HOVER, ACCENT_TEXT, DANGER_FILL, DANGER_FILL_HOVER, DENSITY, FOCUS_RING, ON_ACCENT_TEXT } from './recipes';
import { expectClasses } from './testUtils';

describe('Button — Atlas variant × size matrix on the tokens', () => {
  it.each(BUTTON_VARIANTS.flatMap((v) => BUTTON_SIZES.map((s) => [v, s] as const)))('%s × %s renders the base, variant, size and focus classes', (variant, size) => {
    render(
      <Button variant={variant} size={size}>
        Save
      </Button>
    );
    const btn = screen.getByRole('button', { name: 'Save' });
    // Every class survives the merge: tailwind-merge reads a bare `outline` as a width (Tailwind 4) and
    // drops FOCUS_RING's outline STYLE unless the recipe is appended after the merge.
    expectClasses(btn, BUTTON_VARIANT[variant], BUTTON_SIZE[size], FOCUS_RING);
    // The base survives except where the size deliberately overrides it (sm's gap-1.5 over gap-2).
    expectClasses(btn, cn(BUTTON_BASE, BUTTON_SIZE[size]));
    expect(btn).toHaveAttribute('data-variant', variant);
    expect(btn).toHaveAttribute('data-size', size);
    expect(btn).toHaveAttribute('type', 'button');
  });

  it('ports the Atlas recipes 1:1: the six variants and the h-8 / h-9 / h-10 / 36 px square sizes', () => {
    expect(BUTTON_VARIANTS).toEqual(['default', 'destructive', 'outline', 'secondary', 'ghost', 'link']);
    expect(BUTTON_SIZE.sm.split(' ')).toContain('h-8');
    expect(BUTTON_SIZE.default.split(' ')).toContain('h-9');
    expect(BUTTON_SIZE.lg.split(' ')).toContain('h-10');
    expect(BUTTON_SIZE.icon.split(' ')).toContain('size-9');
    // default = Atlas bg-primary / text-primary-foreground / hover:bg-primary/85, on the readable accent tokens.
    expect(BUTTON_VARIANT.default).toContain(`${ACCENT_FILL} ${ON_ACCENT_TEXT} ${ACCENT_FILL_HOVER}`);
    // destructive = bg-destructive text-white, with the danger label token (white fails on the dark theme's red).
    expect(BUTTON_VARIANT.destructive).toContain(`${DANGER_FILL} ${DANGER_FILL_HOVER}`);
    expect(BUTTON_VARIANT.outline).toContain('border-[var(--ds-hairline)] bg-[var(--ds-raised)] text-[var(--ds-ink)]');
    expect(BUTTON_VARIANT.outline).toContain('hover:border-[color:color-mix(in_srgb,var(--ds-ink)_25%,transparent)]');
    expect(BUTTON_VARIANT.secondary).toContain('bg-[var(--ds-surface-soft)]');
    expect(BUTTON_VARIANT.ghost).toContain('hover:bg-[var(--ds-hover)]');
    expect(BUTTON_VARIANT.link).toContain(`${ACCENT_TEXT} underline-offset-4 hover:underline`);
    // Atlas's press feedback, motion-safe.
    expect(BUTTON_BASE).toContain('motion-safe:active:scale-[0.98]');
  });

  it('every variant keeps a 1 px edge (transparent where Atlas draws none), so forced-colours mode draws the button', () => {
    expect(BUTTON_BASE.split(' ')).toContain('border');
    for (const v of BUTTON_VARIANTS) expect(BUTTON_VARIANT[v], v).toMatch(/(^|\s)border-(transparent|\[)/);
  });

  it('is 44 px tall under a coarse pointer in every size, and 44 × 44 as an icon button', () => {
    for (const s of BUTTON_SIZES) {
      render(<Button size={s}>{s}</Button>);
      expectClasses(screen.getByRole('button', { name: s }), DENSITY.coarse);
    }
    render(
      <Button size="icon" aria-label="Close">
        <X />
      </Button>
    );
    expectClasses(screen.getByRole('button', { name: 'Close' }), DENSITY.coarseSquare);
  });

  it('loading: busy and aria-disabled (focus stays), a spinner, and presses are ignored', () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button loading onClick={onClick}>
        Publish
      </Button>
    );
    const btn = screen.getByRole('button', { name: 'Publish' });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).not.toBeDisabled();
    expect(btn.querySelector('[data-slot="button-spinner"]')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    rerender(<Button onClick={onClick}>Publish</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Publish' })).not.toHaveAttribute('aria-busy');
  });

  it('buttonClasses styles a link like a button, with the focus outline intact', () => {
    render(
      <a href="/new" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
        New comic
      </a>
    );
    expectClasses(screen.getByRole('link', { name: 'New comic' }), cn(BUTTON_BASE, BUTTON_SIZE.sm), BUTTON_VARIANT.outline, BUTTON_SIZE.sm, FOCUS_RING);
  });

  it('a className merges over the recipe (later wins), the focus outline still last', () => {
    render(<Button className="h-12 px-8">Big</Button>);
    const btn = screen.getByRole('button', { name: 'Big' });
    expect(btn).toHaveClass('h-12', 'px-8');
    expect(btn).not.toHaveClass('h-9');
    expect(btn.className.endsWith(FOCUS_RING)).toBe(true);
  });
});

describe('IconButton', () => {
  it('always has a name, a native title, the icon hidden from assistive tech, 32 px fine / 44 × 44 coarse', () => {
    render(
      <IconButton label="Close panel">
        <X />
      </IconButton>
    );
    const btn = screen.getByRole('button', { name: 'Close panel' });
    expect(btn).toHaveAttribute('title', 'Close panel');
    expect(btn.querySelector('svg')?.closest('[aria-hidden="true"]')).not.toBeNull();
    expectClasses(btn, BUTTON_BASE, BUTTON_VARIANT.ghost, ICON_BUTTON_SIZE.default, DENSITY.coarseSquare, FOCUS_RING);
    expect(ICON_BUTTON_SIZE.default.split(' ')).toContain('size-8');
  });

  it('takes the Button variants and sizes; title can be dropped', () => {
    render(
      <IconButton label="Delete page" variant="destructive" size="lg" title={null}>
        <X />
      </IconButton>
    );
    const btn = screen.getByRole('button', { name: 'Delete page' });
    expectClasses(btn, BUTTON_VARIANT.destructive, ICON_BUTTON_SIZE.lg);
    expect(btn).not.toHaveAttribute('title');
  });
});
