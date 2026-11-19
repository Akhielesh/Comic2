import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addKey, clearAllKeys, recordKeyUsage, updateKey } from '../../../services/apiKeys';
import { OwnKeyLimitLine, OwnKeySource } from './OwnKeyLimitLine';
import type { ManagedApiKey } from '../../../services/apiKeys';

beforeEach(() => {
  localStorage.clear();
  clearAllKeys();
});

describe('OwnKeyLimitLine', () => {
  it('renders nothing when the member has no key of their own', () => {
    const { container } = render(<OwnKeyLimitLine onManageKeys={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the active key is under its limit, or has no limit', () => {
    const key = addKey({ provider: 'openrouter', key: 'test-key-not-real', limitUsd: 5 });
    recordKeyUsage('openrouter', 1);
    const { container, unmount } = render(<OwnKeyLimitLine onManageKeys={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    unmount();
    updateKey(key.id, { limitUsd: null });
    recordKeyUsage('openrouter', 50);
    expect(render(<OwnKeyLimitLine onManageKeys={vi.fn()} />).container).toBeEmptyDOMElement();
  });

  it('shows one quiet line and Manage keys once the active key is over its limit', () => {
    addKey({ provider: 'openrouter', key: 'test-key-not-real', limitUsd: 5 });
    recordKeyUsage('openrouter', 5);
    const onManageKeys = vi.fn();
    const { container } = render(<OwnKeyLimitLine onManageKeys={onManageKeys} />);
    expect(screen.getByText('Your OpenRouter key reached its monthly limit.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Manage keys' }));
    expect(onManageKeys).toHaveBeenCalledTimes(1);
    // No price and no colour: muted ink, a ghost button.
    expect(container.textContent).not.toMatch(/\$|¢|\d+(\.\d+)?\s*USD/);
    expect(container.innerHTML).not.toMatch(/--ds-(warning|danger-text|danger\)|success|info|spark|accent|hue)/);
    expect(screen.getByRole('button', { name: 'Manage keys' })).toHaveAttribute('data-variant', 'ghost');
  });

  it('follows the key store without a reload or a timer', () => {
    addKey({ provider: 'openrouter', key: 'test-key-not-real', limitUsd: 5 });
    const { container } = render(<OwnKeyLimitLine onManageKeys={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    act(() => recordKeyUsage('openrouter', 6));
    expect(screen.getByText('Your OpenRouter key reached its monthly limit.')).toBeInTheDocument();
    act(() => clearAllKeys());
    expect(container).toBeEmptyDOMElement();
  });

  it('reads a provided source instead of the key store (QA scenes never touch stored keys)', () => {
    const fixture: ManagedApiKey = {
      id: 'fixture', provider: 'gemini', label: 'Fixture', key: 'test-key-not-real', active: true,
      limitUsd: 1, usedUsd: 1, periodStart: '2026-11-01T00:00:00.000Z', createdAt: '2026-11-01T00:00:00.000Z'
    };
    render(<OwnKeySource.Provider value={() => fixture}><OwnKeyLimitLine onManageKeys={vi.fn()} /></OwnKeySource.Provider>);
    expect(screen.getByText('Your Gemini key reached its monthly limit.')).toBeInTheDocument();
    expect(localStorage.getItem('dreamstream_api_keys_v2')).toBeNull();
  });
});
