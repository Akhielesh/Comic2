// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useComicTheme, useComicThemeScope } from './useComicTheme';

const storageKey = 'ds.comic-theme.v1';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('Comic Studio appearance', () => {
  it('defaults to Atlas and remembers Paper without changing the light/dark preference', () => {
    window.localStorage.setItem('ds.theme.v1', 'dark');
    const { result, unmount } = renderHook(useComicTheme);
    expect(result.current.theme).toBe('atlas');

    act(() => result.current.setTheme('paper'));
    expect(result.current.theme).toBe('paper');
    expect(window.localStorage.getItem('ds.theme.v1')).toBe('dark');
    unmount();

    expect(renderHook(useComicTheme).result.current.theme).toBe('paper');
  });

  it('applies the appearance to the document only while a scoped screen is active', () => {
    const root = document.documentElement;
    const { result, rerender, unmount } = renderHook(({ active }) => {
      useComicThemeScope(active);
      return useComicTheme();
    }, { initialProps: { active: false } });

    act(() => result.current.setTheme('paper'));
    expect(root.hasAttribute('data-comic-theme')).toBe(false);
    rerender({ active: true });
    expect(root.getAttribute('data-comic-theme')).toBe('paper');

    act(() => {
      window.localStorage.setItem(storageKey, 'atlas');
      window.dispatchEvent(new StorageEvent('storage', { key: storageKey }));
    });
    expect(result.current.theme).toBe('atlas');
    expect(root.hasAttribute('data-comic-theme')).toBe(false);

    act(() => result.current.setTheme('paper'));
    unmount();
    expect(root.hasAttribute('data-comic-theme')).toBe(false);
  });

  it.each([
    ['comics.dreamstreamstudio.ai', 'paper'],
    ['comic.dreamstreamstudio.ai', 'paper'],
    ['dreamstreamstudio.ai', null],
    ['localhost', null]
  ])('boots Paper before React only on a Comics host (%s)', (hostname, expected) => {
    const source = readFileSync('public/theme-boot.js', 'utf8');
    const root = document.createElement('html');
    const boot = new Function('window', 'document', source);
    window.localStorage.setItem(storageKey, 'paper');
    window.localStorage.setItem('ds.theme.v1', 'dark');
    boot({ localStorage: window.localStorage, location: { hostname } }, { documentElement: root });
    expect(root.getAttribute('data-comic-theme')).toBe(expected);
    expect(root.classList.contains('dark')).toBe(true);
  });
});
