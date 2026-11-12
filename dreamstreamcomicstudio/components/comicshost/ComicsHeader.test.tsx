// @vitest-environment jsdom
// ComicsHeader: the comics host's header is the app's own AppHeader (the studio's header height and glass), with
// the ink Comic Studio lockup, the right actions per sign-in state, and a menu below `lg` whose rows follow the
// page (section links on the landing only). ComicsMark: drawn in ink and page tokens, no hex.
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RADIUS_ROUND } from '../chat/studioDesign';
import { ComicsHeader, type ComicsHeaderProps } from './ComicsHeader';
import { ComicsMark } from './ComicsMark';

afterEach(cleanup);

const HERE = path.dirname(fileURLToPath(import.meta.url));

const props = (over: Partial<ComicsHeaderProps> = {}): ComicsHeaderProps => ({
  signedIn: false,
  page: 'home',
  onGoHome: vi.fn(),
  onSignIn: vi.fn(),
  onRequestAccess: vi.fn(),
  onOpenComics: vi.fn(),
  onBrowseGallery: vi.fn(),
  onShowSection: vi.fn(),
  ...over
});
const menuRows = () => {
  const menu = document.querySelector('[data-slot="comics-menu"]') as HTMLElement;
  return within(menu).queryAllByRole('button', { hidden: true }).map((b) => b.textContent);
};

describe('ComicsHeader', () => {
  it('is rendered through AppHeader: the app header object, regions and all', () => {
    render(<ComicsHeader {...props()} />);
    const header = screen.getByRole('banner');
    expect(header).toHaveAttribute('data-slot', 'app-header');
    expect(header.querySelector('[data-slot="app-header-glass"]')).not.toBeNull();
    for (const region of ['brand', 'nav', 'actions']) expect(header.querySelector(`[data-region="${region}"]`), region).not.toBeNull();
  });

  it('the lockup is the Comic Studio home link', () => {
    const p = props();
    render(<ComicsHeader {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Comic Studio, home' }));
    expect(p.onGoHome).toHaveBeenCalledTimes(1);
  });

  it('signed out: Request access and Sign in (round, ink); no My comics', () => {
    const p = props();
    render(<ComicsHeader {...p} />);
    const actions = screen.getByRole('banner').querySelector('[data-region="actions"]') as HTMLElement;
    const signIn = within(actions).getByRole('button', { name: /^sign in$/i });
    expect(signIn).toHaveAttribute('data-variant', 'default');
    expect(signIn.className.split(/\s+/)).toContain(RADIUS_ROUND);
    fireEvent.click(signIn);
    fireEvent.click(within(actions).getByRole('button', { name: /^request access$/i }));
    expect(p.onSignIn).toHaveBeenCalledTimes(1);
    expect(p.onRequestAccess).toHaveBeenCalledTimes(1);
    expect(within(actions).queryByRole('button', { name: /my comics/i })).toBeNull();
  });

  it('signed in: My comics only; no Sign in, no Request access', () => {
    const p = props({ signedIn: true });
    render(<ComicsHeader {...p} />);
    const actions = screen.getByRole('banner').querySelector('[data-region="actions"]') as HTMLElement;
    fireEvent.click(within(actions).getByRole('button', { name: 'My comics' }));
    expect(p.onOpenComics).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /request access/i })).toBeNull();
  });

  it('the menu rows per state and page: section links on the landing only, Request access only signed out', () => {
    const cases: Array<[Partial<ComicsHeaderProps>, string[]]> = [
      [{ signedIn: false, page: 'home' }, ['How it works', 'Looks', 'Library', 'Request access']],
      [{ signedIn: true, page: 'home' }, ['How it works', 'Looks', 'Library']],
      [{ signedIn: false, page: 'other' }, ['Library', 'Request access']],
      [{ signedIn: true, page: 'other' }, ['Library']]
    ];
    for (const [over, rows] of cases) {
      const { unmount } = render(<ComicsHeader {...props(over)} />);
      expect(menuRows(), JSON.stringify(over)).toEqual(rows);
      // The lg nav: on the landing the section links and the Library; elsewhere no nav at all.
      const nav = screen.queryByRole('navigation', { name: 'Comic Studio' });
      if (over.page === 'home') expect(within(nav!).getAllByRole('button').map((b) => b.textContent)).toEqual(['How it works', 'Looks', 'Library']);
      else expect(nav).toBeNull();
      unmount();
    }
  });

  it('the menu opens from its trigger, runs a row and closes; Esc closes it and returns focus to the trigger', () => {
    const p = props();
    render(<ComicsHeader {...p} />);
    const trigger = screen.getByRole('button', { name: 'Menu' });
    const menu = document.querySelector('[data-slot="comics-menu"]') as HTMLElement;
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-controls', menu.id);
    expect(menu).toHaveAttribute('hidden');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(menu).not.toHaveAttribute('hidden');
    fireEvent.click(within(menu).getByRole('button', { name: 'Looks' }));
    expect(p.onShowSection).toHaveBeenCalledWith('looks');
    expect(menu).toHaveAttribute('hidden');
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(menu).toHaveAttribute('hidden');
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(menu).toHaveAttribute('hidden');
  });

  it('every control is the ds Button or carries the 44 px coarse-pointer floor', () => {
    render(<ComicsHeader {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    for (const b of screen.getAllByRole('button')) {
      const ok = b.getAttribute('data-slot') === 'button' || /(?:^|\s)coarse:min-h-\[var\(--ds-density-touch\)\]/.test(b.className);
      expect(ok, b.textContent || b.getAttribute('aria-label') || '').toBe(true);
    }
  });
});

describe('ComicsMark', () => {
  it('draws in ink (currentColor) and the page colour, so it inverts in dark and on the inverse panel', () => {
    const { container } = render(<ComicsMark size={28} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg.getAttribute('class')).toContain('text-[var(--ds-ink)]');
    expect(svg.querySelector('rect')).toHaveAttribute('fill', 'currentColor');
    expect(container.innerHTML).toContain('var(--ds-canvas)');
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('its source keeps no hex (the coloured drawing lives only in public/icons/comics-mark.svg)', () => {
    expect(readFileSync(path.join(HERE, 'ComicsMark.tsx'), 'utf8')).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('a titled mark is an image with that name', () => {
    render(<ComicsMark title="Comic Studio" />);
    expect(screen.getByRole('img', { name: 'Comic Studio' })).toBeInTheDocument();
  });
});
