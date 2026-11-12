/**
 * The site header on Atlas chrome (DS-2): the shared AppHeader (sticky, plain then frosted), the products in
 * a nav track with Atlas menus, a 44 px phone toggle in place of the old 36 px one, a menu Escape closes,
 * the brand mark from its checked-in SVG, and no legacy kit class anywhere it renders.
 */
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../../services/productAccess', () => ({ useProductAccess: () => null }));
vi.mock('../../services/liveLink', () => ({ openLiveApp: vi.fn(async () => undefined) }));
vi.mock('../../services/db', () => ({
  getNotifications: vi.fn(async () => []),
  markAllNotificationsRead: vi.fn(async () => undefined),
  markNotificationRead: vi.fn(async () => undefined),
  getUserProfile: vi.fn(async () => null)
}));
vi.mock('../TokenAvailabilityPill', () => ({ TokenAvailabilityPill: () => <span data-testid="token-pill" /> }));

import { DENSITY, HEADER_GLASS, OVERLAY, SEGMENTED_TRACK, STICKY_HEADER } from '../chat/studioDesign';
import { expectClasses } from '../ds/ds.testkit';
import { BRAND_MARK_SRC } from './BrandLockup';
import { CONTACT_HREF, LEGAL_LINK, LegalMicroLinks } from './LegalMicroLinks';
import { MENU_TOGGLE, StaticSiteHeader } from './StaticSiteHeader';

const classesIn = (root: Element): string[] => [root, ...root.querySelectorAll('*')].flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/)).filter(Boolean);
const LEGACY = /^(?:[\w-]+:)*(?:border-black|shadow-comic|font-comic|font-display|(?:bg|text|border)-brand-[\w/]+|(?:bg|text|border)-slate-\d+|shadow-\[\dpx_\dpx_0px)/;

const props = (over: Partial<React.ComponentProps<typeof StaticSiteHeader>> = {}): React.ComponentProps<typeof StaticSiteHeader> => ({
  isAuthenticated: false,
  currentView: 'gallery',
  onGoHome: vi.fn(),
  onViewComics: vi.fn(),
  onEnterStudio: vi.fn(),
  onSignIn: vi.fn(),
  onRequestAccess: vi.fn(),
  onOpenProfile: vi.fn(),
  onNavigate: vi.fn(),
  ...over
});

beforeEach(() => {
  auth.user = null;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('StaticSiteHeader on Atlas chrome', () => {
  it('is the shared AppHeader: sticky, with the glass layer that frosts once the page scrolls under it', () => {
    render(<StaticSiteHeader {...props()} />);
    const header = screen.getByRole('banner');
    expect(header).toHaveAttribute('data-slot', 'app-header');
    expect(header).toHaveAttribute('data-scrolled', 'false');
    expectClasses(header, STICKY_HEADER);
    expect(header.firstElementChild!.className).toBe(HEADER_GLASS);
  });

  it('the brand is the checked-in mark and the name, a home button', () => {
    const p = props();
    render(<StaticSiteHeader {...p} />);
    const home = screen.getByRole('button', { name: 'DreamStream Studio, home' });
    expect(home.querySelector('img')).toHaveAttribute('src', BRAND_MARK_SRC);
    expect(home.querySelector('img')).toHaveAttribute('alt', '');
    // The visible words stay inside the name once "Studio" shows (from 380 px): axe label-content-name-mismatch.
    expect(home.textContent).toBe('DreamStream Studio');
    expect(home.getAttribute('aria-label')).toContain(home.textContent!);
    fireEvent.click(home);
    expect(p.onGoHome).toHaveBeenCalledTimes(1);
  });

  it('the products sit in a nav track on wide screens, each with an Atlas menu that Escape closes', () => {
    const p = props();
    render(<StaticSiteHeader {...p} />);
    const products = screen.getByRole('navigation', { name: 'Products' });
    expectClasses(products, 'hidden', 'lg:flex');
    for (const c of SEGMENTED_TRACK.split(/\s+/).filter((c) => c !== 'inline-flex')) expect(products.classList.contains(c), c).toBe(true);
    const comic = within(products).getByRole('button', { name: /Comic/ });
    fireEvent.click(comic);
    expect(comic).toHaveAttribute('aria-expanded', 'true');
    const menu = document.getElementById(comic.getAttribute('aria-controls')!)!;
    expectClasses(menu, OVERLAY);
    fireEvent.click(within(menu).getByRole('button', { name: /Library/ }));
    expect(p.onViewComics).toHaveBeenCalledTimes(1);
    fireEvent.click(comic);
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(comic).toHaveAttribute('aria-expanded', 'false');
    expect(comic).toHaveFocus();
  });
});

describe('a product menu by pointer, touch and focus', () => {
  const comicTrigger = () => within(screen.getByRole('navigation', { name: 'Products' })).getByRole('button', { name: /Comic/ });
  const comicRoot = () => comicTrigger().parentElement!;
  const menuOf = (trigger: HTMLElement) => (trigger.getAttribute('aria-controls') ? document.getElementById(trigger.getAttribute('aria-controls')!) : null);

  it('a tap opens it: the touch pointer entering does not, so the click is not a toggle back shut', () => {
    // From 1024 px the phone toggle is gone, so on a touch screen (iPad landscape) a tap is the only way in.
    // A tap fires pointerenter (and a compatibility mouseenter) before its click.
    render(<StaticSiteHeader {...props()} />);
    fireEvent.pointerEnter(comicRoot(), { pointerType: 'touch' });
    fireEvent.mouseEnter(comicRoot());
    expect(comicTrigger()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(comicTrigger());
    expect(comicTrigger()).toHaveAttribute('aria-expanded', 'true');
    expect(menuOf(comicTrigger())).toHaveAttribute('data-slot', 'nav-menu');
    // The finger lifting (touch pointerleave) leaves it open.
    fireEvent.pointerLeave(comicRoot(), { pointerType: 'touch' });
    expect(comicTrigger()).toHaveAttribute('aria-expanded', 'true');
  });

  it('a real mouse opens it on hover and closes it on leaving', () => {
    render(<StaticSiteHeader {...props()} />);
    fireEvent.pointerEnter(comicRoot(), { pointerType: 'mouse' });
    expect(comicTrigger()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.pointerLeave(comicRoot(), { pointerType: 'mouse' });
    expect(comicTrigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('focus moving out closes it; focus moving to one of its rows keeps it open', () => {
    render(<StaticSiteHeader {...props()} />);
    fireEvent.click(comicTrigger());
    const row = within(menuOf(comicTrigger())!).getByRole('button', { name: /Library/ });
    fireEvent.blur(comicTrigger(), { relatedTarget: row });
    expect(comicTrigger()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.blur(row, { relatedTarget: document.body });
    expect(comicTrigger()).toHaveAttribute('aria-expanded', 'false');
    expect(menuOf(comicTrigger())).toBeNull();
  });

  it('is a disclosure over plain buttons, not a menu, and enters with the 280 ms overlay scale-in', () => {
    render(<StaticSiteHeader {...props()} />);
    for (const trigger of within(screen.getByRole('navigation', { name: 'Products' })).getAllByRole('button')) {
      expect(trigger, trigger.textContent ?? '').not.toHaveAttribute('aria-haspopup');
    }
    fireEvent.click(comicTrigger());
    const menu = menuOf(comicTrigger())!;
    expect(menu).not.toHaveAttribute('role', 'menu');
    expect(menu.classList.contains('ds-scale-in')).toBe(true);
    expect(menu.classList.contains('ds-rise-in')).toBe(false);
  });
});

describe('the phone menu toggle', () => {
  it('carries a hook the IconButton does not overwrite (its data-slot stays icon-button)', () => {
    render(<StaticSiteHeader {...props()} />);
    const toggle = screen.getByRole('button', { name: 'Open menu' });
    expect(document.querySelector('[data-menu-toggle]')).toBe(toggle);
    expect(toggle).toHaveAttribute('data-slot', 'icon-button');
  });

  it('is 44 px (size-11) below the desktop breakpoint, at every pointer, instead of the old 36 px h-9 w-9', () => {
    render(<StaticSiteHeader {...props()} />);
    const toggle = screen.getByRole('button', { name: 'Open menu' });
    expectClasses(toggle, MENU_TOGGLE, DENSITY.coarseSquare);
    expect(MENU_TOGGLE).toBe('size-11 lg:hidden');
    // The IconButton's 32 px default and the old square are gone, not stacked under it.
    for (const c of ['size-8', 'h-9', 'w-9']) expect(toggle.classList.contains(c), c).toBe(false);
  });

  it('opens the products as a menu in the header; a choice closes it; Escape closes it and returns focus', () => {
    const p = props();
    render(<StaticSiteHeader {...p} />);
    const toggle = screen.getByRole('button', { name: 'Open menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAccessibleName('Close menu');
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    const menu = within(panel).getByRole('navigation', { name: 'Menu' });
    expect(within(menu).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'How It Works',
      'Comic Studio',
      'Library',
      'Open Chat Studio',
      'Model Catalog',
      'Open Stream Studio',
      'Browse Models',
      'Sign In'
    ]);
    for (const row of within(menu).getAllByRole('button')) expectClasses(row, DENSITY.coarse);
    fireEvent.click(within(menu).getByRole('button', { name: 'Library' }));
    expect(p.onViewComics).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('navigation', { name: 'Menu' })).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByRole('navigation', { name: 'Menu' })).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('navigation', { name: 'Menu' })).toBeNull();
    expect(toggle).toHaveFocus();
  });
});

describe('the home announcement', () => {
  it('shows on home only, as a quiet line with an ink link to Chat', () => {
    const p = props({ currentView: 'home' });
    const { rerender } = render(<StaticSiteHeader {...p} />);
    const banner = document.querySelector('[data-slot="announcement"]')!;
    expect(banner).toHaveTextContent('Chat Studio is live');
    fireEvent.click(within(banner as HTMLElement).getByRole('button', { name: 'Try it free →' }));
    expect(p.onNavigate).toHaveBeenCalledWith('chat');
    rerender(<StaticSiteHeader {...p} currentView="gallery" />);
    expect(document.querySelector('[data-slot="announcement"]')).toBeNull();
  });
});

describe('signed in', () => {
  it('shows the bell and the profile as real buttons', async () => {
    auth.user = { id: 'u1', email: 'reader@example.com' };
    const p = props({ isAuthenticated: true });
    render(<StaticSiteHeader {...p} />);
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Your profile and settings' }));
    expect(p.onOpenProfile).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /Request Access/ })).toBeNull();
  });
});

describe('the legal line', () => {
  it('every link is a 44 x 44 target under a coarse pointer, short words too', () => {
    render(<LegalMicroLinks onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} />);
    for (const name of ['Privacy Policy', 'Terms & Conditions', 'FAQs']) expectClasses(screen.getByRole('button', { name }), LEGAL_LINK, DENSITY.coarseSquare);
    expectClasses(screen.getByRole('link', { name: 'Contact' }), DENSITY.coarseSquare);
  });

  it('Contact writes to the site address the rest of the app uses, never a third-party domain', () => {
    render(<LegalMicroLinks onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} />);
    expect(CONTACT_HREF).toBe('mailto:support@dreamstreamstudio.ai');
    expect(screen.getByRole('link', { name: 'Contact' })).toHaveAttribute('href', 'mailto:support@dreamstreamstudio.ai');
  });
});

describe('no legacy kit anywhere the header renders', () => {
  it('signed out on home with the phone menu and a product menu open', () => {
    const { container } = render(<StaticSiteHeader {...props({ currentView: 'home' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Products' })).getByRole('button', { name: /Live/ }));
    expect(classesIn(container).filter((c) => LEGACY.test(c))).toEqual([]);
  });

  it('signed in', async () => {
    auth.user = { id: 'u1', email: 'reader@example.com' };
    const { container } = render(<StaticSiteHeader {...props({ isAuthenticated: true })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    // UserAvatar (its own file, not this package's) is wave-noted; everything around it is checked.
    const avatar = container.querySelector('[data-slot="profile-button"]')!;
    const mine = [container, ...container.querySelectorAll('*')].filter((el) => !avatar.contains(el) || el === avatar);
    const classes = mine.flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/)).filter(Boolean);
    expect(classes.filter((c) => LEGACY.test(c))).toEqual([]);
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeInTheDocument();
  });
});
