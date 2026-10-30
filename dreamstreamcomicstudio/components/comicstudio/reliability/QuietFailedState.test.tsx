// The quiet failed-tile state (reliability.md §3/§5): "Paused — provider busy · Details · Retry"; Details shows
// who refused, the provider's words and the time; non-provider failures stay honest ("Didn't finish — …").
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuietFailedState, isProviderPause, quietCaption } from './QuietFailedState';

const AT = new Date(2026, 9, 22, 16, 52, 0).getTime();
const NOW = AT + 5 * 60_000;
const throttled = {
  error: 'Nano Banana 2.1 is being throttled by its provider (Google) right now.',
  updatedAt: AT,
  errorDetail: { code: '429', provider: 'OpenRouter · Google', at: AT, text: 'Resource has been exhausted (e.g. check quota).' }
};

describe('QuietFailedState', () => {
  it('reads "Paused — provider busy" for a provider refusal, with Details collapsed', () => {
    expect(isProviderPause(throttled)).toBe(true);
    expect(quietCaption(throttled)).toBe('Paused — provider busy');
    render(<QuietFailedState render={throttled} label="Page 3" now={NOW} />);
    expect(screen.getByRole('group', { name: 'Page 3: Paused — provider busy' })).toBeInTheDocument();
    const details = screen.getByRole('button', { name: /Details/ });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Who refused')).toBeNull();
  });

  it('Details reveals why, who refused, the provider’s own words and when', () => {
    render(<QuietFailedState render={throttled} label="Page 3" now={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByRole('button', { name: /Details/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Why').nextSibling).toHaveTextContent('Rate limited');
    expect(screen.getByText('Who refused').nextSibling).toHaveTextContent('OpenRouter · Google · 429');
    expect(screen.getByText('They said').nextSibling).toHaveTextContent('“Resource has been exhausted (e.g. check quota).”');
    expect(screen.getByText('When').nextSibling).toHaveTextContent('16:52');
  });

  it('Retry calls back without bubbling to the tile', () => {
    const onRetry = vi.fn();
    const onTile = vi.fn();
    render(
      <div onClick={onTile}>
        <QuietFailedState render={throttled} label="Cover" onRetry={onRetry} now={NOW} />
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry Cover' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onTile).not.toHaveBeenCalled();
  });

  it('busy, throttled, timeout and network all read "Paused — provider busy"; safety, limits and stops do not', () => {
    expect(quietCaption({ error: 'The image provider had a temporary problem (503).' })).toBe('Paused — provider busy');
    expect(quietCaption({ error: 'It took longer than 120s and was stopped.' })).toBe('Paused — provider busy');
    expect(quietCaption({ error: 'fetch failed: ECONNRESET' })).toBe('Paused — provider busy');
    render(<QuietFailedState render={{ error: 'It took longer than 120s and was stopped.', updatedAt: AT }} label="Cover" now={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByText('Why').nextSibling).toHaveTextContent('Timed out');
    expect(isProviderPause({ error: 'Held by the PG-13 safety check.' })).toBe(false);
    expect(quietCaption({ error: 'Held by the PG-13 safety check.' })).toBe("Didn't finish — held by the safety check");
    expect(quietCaption({ error: "You've used all of your usage this month." })).toBe("Didn't finish — usage limit reached");
    expect(isProviderPause(null)).toBe(false);
  });

  it('is calm (no red) and never wider than its tile', () => {
    const { container } = render(<QuietFailedState render={throttled} label="Style option 2" compact now={NOW} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('w-full');
    expect(root.className).toContain('min-w-0');
    expect(root.className).toContain('overflow-y-auto');
    expect(container.innerHTML).not.toMatch(/\bred-|ds-danger/);
    expect(root.getAttribute('data-quiet-failed')).toBe('provider');
  });
});
