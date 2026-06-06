import { describe, it, expect, beforeEach } from 'vitest';
import { useStudioFocus, STUDIO_FOCUS_ORDER } from './focusStore';

describe('focusStore', () => {
  beforeEach(() => {
    try { window.localStorage.removeItem('studio.focus'); } catch { /* ignore */ }
    useStudioFocus.setState({ focus: 'split' });
  });

  it('defaults to split', () => {
    expect(useStudioFocus.getState().focus).toBe('split');
  });

  it('setFocus updates state and persists to localStorage', () => {
    useStudioFocus.getState().setFocus('preview');
    expect(useStudioFocus.getState().focus).toBe('preview');
    expect(window.localStorage.getItem('studio.focus')).toBe('preview');
  });

  it('offers code · split · preview in a sensible order', () => {
    expect(STUDIO_FOCUS_ORDER).toEqual(['code', 'split', 'preview']);
  });
});
