// Coverage for the Code Studio theme system: registry completeness, the persisted store,
// and the ThemeSwitcher control.

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, renderHook } from '@testing-library/react';
import { STUDIO_THEMES, STUDIO_THEME_ORDER, type StudioThemeId } from './theme';
import { useStudioThemeStore, useStudioTheme } from './themeStore';
import { ThemeSwitcher } from './ThemeSwitcher';

const TOKEN_KEYS = [
  'id', 'label', 'isDark', 'monaco',
  'bg', 'panel', 'panelAlt', 'editorBg', 'edge', 'edgeStrong', 'hover',
  'text', 'textDim', 'textFaint',
  'accent', 'accentSoft', 'accentBg', 'accentBgHover', 'accentText', 'focusRing',
] as const;

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* ignore */ }
  useStudioThemeStore.setState({ id: 'black' });
});

describe('theme registry', () => {
  it('exposes exactly the three intended themes in order', () => {
    expect(STUDIO_THEME_ORDER).toEqual(['black', 'light', 'brand']);
    expect(Object.keys(STUDIO_THEMES).sort()).toEqual(['black', 'brand', 'light']);
  });

  it('every theme defines every token as a non-empty value', () => {
    for (const id of STUDIO_THEME_ORDER) {
      const theme = STUDIO_THEMES[id];
      for (const key of TOKEN_KEYS) {
        expect(theme[key], `${id}.${key}`).not.toBeUndefined();
        if (typeof theme[key] === 'string') expect((theme[key] as string).length, `${id}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('dark flag matches expectation (black dark, light/brand light)', () => {
    expect(STUDIO_THEMES.black.isDark).toBe(true);
    expect(STUDIO_THEMES.light.isDark).toBe(false);
    expect(STUDIO_THEMES.brand.isDark).toBe(false);
  });
});

describe('theme store', () => {
  it('setTheme switches the active tokens and persists', () => {
    const { result } = renderHook(() => useStudioTheme());
    expect(result.current.id).toBe('black');
    useStudioThemeStore.getState().setTheme('brand');
    expect(useStudioThemeStore.getState().id).toBe('brand');
    expect(window.localStorage.getItem('studio.theme')).toBe('brand');
  });
});

describe('ThemeSwitcher', () => {
  it('renders all three options and switches on click', () => {
    render(<ThemeSwitcher />);
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBe(3);
    // the premium dark theme is active by default
    expect(screen.getByRole('radio', { checked: true })).toHaveAttribute('title', 'Dark theme');
    fireEvent.click(screen.getByRole('radio', { name: /Light/i }));
    expect(useStudioThemeStore.getState().id).toBe('light');
  });
});
