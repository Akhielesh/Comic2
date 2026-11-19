// @vitest-environment jsdom
// ComicsHeader: the comics host's header is the app's own AppHeader (the studio's header height and glass), with
// the ink Comic Studio lockup, the right actions per sign-in state, and a compact menu whose rows follow the
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
import { AccountProvider } from '../account/AccountContext';

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove('dark', 'ds-no-transitions');
});

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
/** Signed in, App fills the account context: the header's account menu shows the person's initial. */
const PERSON = { id: 'person-1', name: 'Ada Example', initial: 'A', username: 'ada', avatarUrl: null };
const renderHeader = (p: ComicsHeaderProps) =>
  render(
    <AccountProvider value={{ person: p.signedIn ? PERSON : null, staff: false, onSignedOut: () => undefined }}>
      <ComicsHeader {...p} />
    </AccountProvider>
  );
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

  it('owns its ink, so its ghost buttons and icons read in dark whatever page sits under it', () => {
    for (const page of ['home', 'other'] as const) {
      const { unmount } = render(<ComicsHeader {...props({ page })} />);
      expect(screen.getByRole('banner').className.split(/\s+/), page).toContain('text-[var(--ds-ink)]');
      unmount();
    }
  });

  it('the lockup reads "Comic Studio" (with the space) inside its accessible name, so axe sees no label mismatch', () => {
    render(<ComicsHeader {...props()} />);
    const home = screen.getByRole('button', { name: 'Comic Studio, home' });
    const visible = (home.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(visible).toBe('Comic Studio');
    expect(home.getAttribute('aria-label')?.startsWith(visible)).toBe(true);
  });

  it('the lockup is the Comic Studio home link', () => {
    const p = props();
    render(<ComicsHeader {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Comic Studio, home' }));
    expect(p.onGoHome).toHaveBeenCalledTimes(1);
  });

  it('signed out: Register interest and Sign in (round; outline on the landing, the ink fill elsewhere); no My comics', () => {
    const other = render(<ComicsHeader {...props({ page: 'other' })} />);
    expect(within(screen.getByRole('banner')).getByRole('button', { name: /^sign in$/i })).toHaveAttribute('data-variant', 'default');
    other.unmount();
    const p = props();
    render(<ComicsHeader {...p} />);
    const actions = screen.getByRole('banner').querySelector('[data-region="actions"]') as HTMLElement;
    const signIn = within(actions).getByRole('button', { name: /^sign in$/i });
    // On the landing the hero holds the one fill (one fill per view), so the header's Sign in is outline.
    expect(signIn).toHaveAttribute('data-variant', 'outline');
    expect(signIn.className.split(/\s+/)).toContain(RADIUS_ROUND);
    fireEvent.click(signIn);
    expect(p.onSignIn).toHaveBeenCalledTimes(1);
    expect(within(actions).queryByRole('button', { name: /^request access$/i })).toBeNull();
    // On the landing the join row scrolls to the page's own form; elsewhere it opens the sign-in card's Register interest tab.
    // From lg the header also carries it as a ghost beside Sign in (never a second fill), so it stays one press away.
    const register = within(actions).getByRole('button', { name: 'Register interest' });
    expect(register).toHaveAttribute('data-variant', 'ghost');
    expect(register.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'lg:inline-flex']));
    fireEvent.click(register);
    expect(p.onRequestAccess).toHaveBeenCalledTimes(1);
    fireEvent.click(within(actions).getByRole('button', { name: 'Menu' }));
    fireEvent.click(within(document.querySelector('[data-slot="comics-menu"]') as HTMLElement).getByRole('button', { name: 'Register interest' }));
    expect(p.onRequestAccess).toHaveBeenCalledTimes(2);
    expect(within(actions).queryByRole('button', { name: /my comics/i })).toBeNull();
  });

  it('signed in: My comics only (outline on the landing, the ink fill elsewhere); no Sign in, no Register interest', () => {
    const other = render(<ComicsHeader {...props({ signedIn: true, page: 'other' })} />);
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'My comics' })).toHaveAttribute('data-variant', 'default');
    other.unmount();
    const p = props({ signedIn: true });
    render(<ComicsHeader {...p} />);
    const actions = screen.getByRole('banner').querySelector('[data-region="actions"]') as HTMLElement;
    expect(within(actions).getByRole('button', { name: 'My comics' })).toHaveAttribute('data-variant', 'outline');
    fireEvent.click(within(actions).getByRole('button', { name: 'My comics' }));
    expect(p.onOpenComics).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /request access|register interest/i })).toBeNull();
  });

  it('the menu rows per state and page: section links on the landing only, Register interest only signed out', () => {
    const cases: Array<[Partial<ComicsHeaderProps>, string[]]> = [
      [{ signedIn: false, page: 'home' }, ['Features', 'Looks', 'Models', 'Pricing', 'Library', 'Register interest']],
      [{ signedIn: true, page: 'home' }, ['Features', 'Looks', 'Models', 'Pricing', 'Library', 'My comics']],
      [{ signedIn: false, page: 'other' }, ['Home', 'Library', 'Register interest']],
      [{ signedIn: true, page: 'other' }, ['Home', 'Library', 'My comics']]
    ];
    for (const [over, rows] of cases) {
      const { unmount } = renderHeader(props(over));
      expect(menuRows(), JSON.stringify(over)).toEqual(rows);
      // Public pages keep an explicit way home beside the current Library destination.
      const nav = screen.getByRole('navigation', { name: 'Comic Studio' });
      expect(within(nav).getAllByRole('button').map((b) => b.textContent), JSON.stringify(over)).toEqual(
        over.page === 'home' ? ['Features', 'Looks', 'Models', 'Pricing', 'Library'] : ['Home', 'Library']
      );
      expect(nav.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'expanded:flex']));
      unmount();
    }
  });

  it('signed in: the account menu sits at the right end; the menu toggle is the plain Menu, gone from expanded, with no Account settings row', () => {
    const p = props({ signedIn: true, page: 'other', current: 'gallery', onOpenAccount: vi.fn() });
    renderHeader(p);
    const actions = screen.getByRole('banner').querySelector('[data-region="actions"]') as HTMLElement;
    const account = within(actions).getByRole('button', { name: 'Account and settings' });
    expect(account.textContent).toBe('A');
    // The right end: the account menu is the actions' last control.
    expect(actions.lastElementChild?.contains(account)).toBe(true);
    const toggle = within(actions).getByRole('button', { name: 'Menu' });
    expect(toggle.className.split(/\s+/)).toContain('expanded:hidden');
    expect(within(actions).queryByRole('button', { name: 'Account and navigation' })).toBeNull();
    fireEvent.click(toggle);
    const menu = within(document.querySelector('[data-slot="comics-menu"]') as HTMLElement);
    expect(menu.getByRole('button', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
    expect(menu.queryByRole('button', { name: 'Account settings' })).toBeNull();
    // My comics stays in the menu below 600, where the header button steps aside (comicsShell.css).
    const myComics = menu.getByRole('button', { name: 'My comics' });
    expect((myComics.closest('li') as HTMLElement).className.split(/\s+/)).toContain('medium:hidden');
    fireEvent.click(myComics);
    expect(p.onOpenComics).toHaveBeenCalledOnce();
    expect(p.onOpenAccount).not.toHaveBeenCalled();
    // The menu container is gone from expanded for everyone now (nothing account-only lives in it).
    expect((document.querySelector('[data-slot="comics-menu"]')!.parentElement as HTMLElement).className.split(/\s+/)).toContain('expanded:hidden');
  });

  it('signed out: Appearance alone, no account trigger', () => {
    renderHeader(props({ signedIn: false, page: 'other' }));
    expect(screen.queryByRole('button', { name: 'Account and settings' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Appearance: Light' })).toBeInTheDocument();
  });

  it('on the sign-in page the header offers neither Sign in nor Register interest (the card switches between them); on the Library its link is the current page', () => {
    const p = props({ page: 'other', current: 'auth' });
    const { unmount } = render(<ComicsHeader {...p} />);
    const banner = screen.getByRole('banner');
    expect(within(banner).queryByRole('button', { name: /^sign in$/i })).toBeNull();
    // Pressing it there remounted the card and wiped what was typed.
    expect(within(banner).queryByRole('button', { name: /^register interest$|^request access$/i })).toBeNull();
    expect(menuRows()).toEqual(['Home', 'Library']);
    expect(p.onRequestAccess).not.toHaveBeenCalled();
    unmount();
    const g = props({ page: 'other', current: 'gallery' });
    render(<ComicsHeader {...g} />);
    const library = within(screen.getByRole('navigation', { name: 'Comic Studio' })).getByRole('button', { name: 'Library' });
    expect(library).toHaveAttribute('aria-current', 'page');
    fireEvent.click(library);
    expect(g.onBrowseGallery).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole('banner')).getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
  });

  it('appearance: no Palette toggle; signed out, the Appearance button sits in the actions (from 600) and the compact menu ends with the Appearance group (below 600)', () => {
    const { unmount: un } = renderHeader(props({ signedIn: false, page: 'home' }));
    {
      const banner = screen.getByRole('banner');
      expect(within(banner).queryByRole('button', { name: /theme/i })).toBeNull();
      const actions = banner.querySelector('[data-region="actions"]') as HTMLElement;
      const button = within(actions).getByRole('button', { name: 'Appearance: Light' });
      // Hidden below 600 by its class (comicsShell.css), where the menu carries the same choice. The class sits on the
      // wrapper, so nothing of the control is left in the actions row to take a gap there.
      const wrapper = button.parentElement as HTMLElement;
      expect(wrapper.parentElement).toBe(actions);
      expect(wrapper.className.split(/\s+/)).toContain('comics-header-theme');
      const menu = document.querySelector('[data-slot="comics-menu"]') as HTMLElement;
      const group = within(menu).getByRole('radiogroup', { name: 'Appearance', hidden: true });
      expect(within(group).getAllByRole('radio', { hidden: true }).map((r) => r.textContent)).toEqual(['Light', 'Dark', 'Paper', 'System']);
      // The group is the menu's last entry, after a hairline, and hidden from 600 (comicsShell.css).
      const row = group.closest('li') as HTMLElement;
      expect(row.className.split(/\s+/)).toContain('comics-header-menu-theme');
      expect(row.parentElement?.lastElementChild).toBe(row);
      expect(within(row).getByText('Appearance')).toBeInTheDocument();
    }
    un();
    // Signed in, Appearance has one home: the account panel (the header carries neither the button nor the group).
    renderHeader(props({ signedIn: true, page: 'other' }));
    const banner = screen.getByRole('banner');
    expect(within(banner).queryByRole('button', { name: /^Appearance/ })).toBeNull();
    expect(within(document.querySelector('[data-slot="comics-menu"]') as HTMLElement).queryByRole('radiogroup', { name: 'Appearance', hidden: true })).toBeNull();
  });

  it('one overlay at a time: opening Appearance closes the menu, and pressing the menu trigger closes Appearance', () => {
    renderHeader(props({ signedIn: false, page: 'other' }));
    const menu = document.querySelector('[data-slot="comics-menu"]') as HTMLElement;
    const trigger = screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(trigger);
    expect(menu).not.toHaveAttribute('hidden');
    const appearance = screen.getByRole('button', { name: /^Appearance: / });
    fireEvent.pointerDown(appearance);
    fireEvent.click(appearance);
    expect(appearance).toHaveAttribute('aria-expanded', 'true');
    expect(menu).toHaveAttribute('hidden');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(menu).not.toHaveAttribute('hidden');
    expect(appearance).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('[data-slot="appearance-panel"]')).toBeNull();
  });

  it('one overlay at a time, signed in: opening the account menu closes the compact menu', () => {
    renderHeader(props({ signedIn: true, page: 'other' }));
    const menu = document.querySelector('[data-slot="comics-menu"]') as HTMLElement;
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(menu).not.toHaveAttribute('hidden');
    const account = screen.getByRole('button', { name: 'Account and settings' });
    fireEvent.pointerDown(account);
    fireEvent.click(account);
    expect(account).toHaveAttribute('aria-expanded', 'true');
    expect(menu).toHaveAttribute('hidden');
  });

  it('choosing Dark in the compact menu darkens the page at once and keeps the menu open', () => {
    render(<ComicsHeader {...props({ page: 'other' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const menu = document.querySelector('[data-slot="comics-menu"]') as HTMLElement;
    fireEvent.click(within(menu).getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(menu).not.toHaveAttribute('hidden');
    expect(screen.getByRole('button', { name: 'Appearance: Dark' })).toBeInTheDocument();
    document.documentElement.classList.remove('dark');
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
