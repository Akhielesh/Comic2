import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { Confetti } from './Confetti';

const mockMatchMedia = (reduce: boolean) => {
  (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: reduce && q.includes('prefers-reduced-motion'),
    media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent() { return true; }, onchange: null,
  });
};
afterEach(() => { delete (window as unknown as { matchMedia?: unknown }).matchMedia; });

describe('Confetti', () => {
  it('renders the requested number of particles', () => {
    const { container } = render(<Confetti count={12} />);
    expect(container.querySelectorAll('span').length).toBe(12);
  });

  it('renders nothing under reduced motion', () => {
    mockMatchMedia(true);
    const { container } = render(<Confetti count={12} />);
    expect(container.querySelectorAll('span').length).toBe(0);
  });
});
