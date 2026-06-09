import { describe, it, expect, beforeEach } from 'vitest';
import { useStudioFocus, STUDIO_FOCUS_ORDER } from './focusStore';

describe('focusStore', () => {
  beforeEach(() => {
    try { window.localStorage.removeItem('studio.focus'); } catch { /* ignore */ }
    useStudioFocus.setState({ focus: 'preview' });
  });

  it('defaults to preview (most people want to see the running app)', () => {
    expect(useStudioFocus.getState().focus).toBe('preview');
  });

  it('setFocus updates state and persists to localStorage', () => {
    useStudioFocus.getState().setFocus('code');
    expect(useStudioFocus.getState().focus).toBe('code');
    expect(window.localStorage.getItem('studio.focus')).toBe('code');
  });

  it('offers preview · code as a two-view toggle (no three-pane split)', () => {
    expect(STUDIO_FOCUS_ORDER).toEqual(['preview', 'code']);
  });
});
