// @vitest-environment jsdom
// The verification widget fits the card it sits in (compact below its 300 px normal width, so it never overflows a
// phone card) and follows the page's own light or dark theme.
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/clientConfig', () => ({ TURNSTILE_SITE_KEY: 'site-key' }));

import { Turnstile, turnstileSize, turnstileTheme } from './Turnstile';

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  delete (window as { turnstile?: unknown }).turnstile;
});

describe('turnstileSize / turnstileTheme', () => {
  it('compact only when the space is known and narrower than 300 px', () => {
    expect(turnstileSize(238)).toBe('compact');
    expect(turnstileSize(299)).toBe('compact');
    expect(turnstileSize(300)).toBe('normal');
    expect(turnstileSize(0)).toBe('normal');
  });

  it('reads the page theme, not the system one', () => {
    expect(turnstileTheme()).toBe('light');
    document.documentElement.classList.add('dark');
    expect(turnstileTheme()).toBe('dark');
  });
});

describe('Turnstile', () => {
  it('renders compact and dark inside a narrow card on a dark page', async () => {
    document.documentElement.classList.add('dark');
    const renderWidget = vi.fn((_el: HTMLElement, _opts: Record<string, unknown>) => 'w1');
    (window as { turnstile?: unknown }).turnstile = { render: renderWidget, reset: vi.fn(), remove: vi.fn() };
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(238);
    try {
      render(
        <div>
          <Turnstile onToken={vi.fn()} action="waitlist" />
        </div>
      );
      await waitFor(() => expect(renderWidget).toHaveBeenCalledTimes(1));
      expect(renderWidget.mock.calls[0]?.[1]).toMatchObject({ sitekey: 'site-key', size: 'compact', theme: 'dark' });
    } finally {
      width.mockRestore();
    }
  });
});
