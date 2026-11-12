/**
 * StudioErrorBoundary on the DS (DS-2): the error tile, the state title and words, the DS buttons and the
 * canvas in both themes; no studio-theme classes, no legacy kit, no raw hue.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioErrorBoundary } from './ErrorBoundary';

const Boom: React.FC = () => {
  throw new Error('kaboom');
};
const classesIn = (root: Element): string[] => [root, ...root.querySelectorAll('*')].flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/)).filter(Boolean);

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe('StudioErrorBoundary on the DS', () => {
  it('uses the DS buttons and state type, on the canvas', () => {
    const onBack = vi.fn();
    const { container } = render(
      <StudioErrorBoundary onBack={onBack} label="The board stopped">
        <Boom />
      </StudioErrorBoundary>
    );
    const page = container.querySelector('[data-slot="studio-error"]')!;
    expect(page).toHaveAttribute('role', 'alert');
    expect(page.className).toContain('bg-[var(--ds-canvas)]');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('The board stopped');
    for (const name of ['Try again', 'Reload', 'Back']) expect(screen.getByRole('button', { name })).toHaveAttribute('data-slot', 'button');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(classesIn(container).filter((c) => /border-black|shadow-comic|font-comic|font-display|text-amber-\d|text-red-\d/.test(c))).toEqual([]);
  });

  it('logs the error with the component stack', () => {
    render(
      <StudioErrorBoundary>
        <Boom />
      </StudioErrorBoundary>
    );
    expect(vi.mocked(console.error).mock.calls.some((c) => c[0] === '[studio] render error:')).toBe(true);
  });
});
