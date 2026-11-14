// useStudioMode: the Easy/Pro view — the user's pick persists (try/catch storage), falls back to
// Easy, never shows Pro without caps.proEditor, and follows other tabs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { DEFAULT_CAPS } from '../../shared/comic/capabilities';
import { MODE_STORAGE_KEY, readStoredMode, resolveStudioMode, useStudioMode } from './useStudioMode';

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('useStudioMode', () => {
  it('keeps Easy when paid capabilities arrive until the user explicitly picks Pro', () => {
    const { result, rerender } = renderHook(({ caps }) => useStudioMode(caps), { initialProps: { caps: DEFAULT_CAPS } });
    expect(result.current.mode).toBe('easy');
    expect(result.current.stored).toBeNull();
    rerender({ caps: { ...DEFAULT_CAPS, defaultMode: 'pro' } });
    expect(result.current.mode).toBe('easy');
    act(() => result.current.setMode('pro'));
    expect(result.current.mode).toBe('pro');
    expect(window.localStorage.getItem(MODE_STORAGE_KEY)).toBe('pro');
    expect(readStoredMode()).toBe('pro');
  });

  it('never shows Pro when the proEditor capability is off (mode is a view, not a permission)', () => {
    window.localStorage.setItem(MODE_STORAGE_KEY, 'pro');
    const { result } = renderHook(() => useStudioMode({ ...DEFAULT_CAPS, proEditor: false }));
    expect(result.current.stored).toBe('pro');
    expect(result.current.mode).toBe('easy');
    expect(resolveStudioMode('pro', { ...DEFAULT_CAPS, proEditor: false })).toBe('easy');
  });

  it('ignores junk values and survives blocked storage', () => {
    window.localStorage.setItem(MODE_STORAGE_KEY, 'expert');
    expect(readStoredMode()).toBeNull();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useStudioMode(DEFAULT_CAPS));
    act(() => result.current.setMode('pro'));
    expect(result.current.mode).toBe('pro'); // switches for this session even when not persisted
    act(() => result.current.setMode('nonsense' as never));
    expect(result.current.mode).toBe('pro');
  });

  it('follows a switch made in another tab', () => {
    const { result } = renderHook(() => useStudioMode(DEFAULT_CAPS));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: MODE_STORAGE_KEY, newValue: 'pro' }));
    });
    expect(result.current.mode).toBe('pro');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'easy' }));
    });
    expect(result.current.mode).toBe('pro');
  });
});
