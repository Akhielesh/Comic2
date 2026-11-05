// The shared site header on the Atlas tokens (components/layout/StaticSiteHeader.tsx): the DreamStream lockup,
// the studio switcher (DreamStream, Comic, Chat, Stream, Atlas Studio), the public pages, the phone menu and
// the per-account studio confinement (product_access), which must behave exactly as before.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const access = vi.hoisted(() => ({ allowed: null as Set<string> | null }));
const live = vi.hoisted(() => ({ openLiveApp: vi.fn(async () => undefined) }));

vi.mock('../../services/productAccess', () => ({ useProductAccess: () => access.allowed }));
vi.mock('../../services/liveLink', () => ({ liveAppUrl: (legacy: string) => legacy, openLiveApp: live.openLiveApp }));
vi.mock('../NotificationBell', () => ({ NotificationBell: () => <button type="button">Notifications</button> }));
vi.mock('../UserAvatar', () => ({ UserAvatar: ({ onClick }: { onClick: () => void }) => <button type="button" onClick={onClick}>Your profile</button> }));
vi.mock('../TokenAvailabilityPill', () => ({ TokenAvailabilityPill: () => <span>Credits</span> }));

const { StaticSiteHeader } = await import('./StaticSiteHeader');

const handlers = () => ({
  onGoHome: vi.fn(),
  onViewComics: vi.fn(),
  onEnterStudio: vi.fn(),
  onSignIn: vi.fn(),
  onRequestAccess: vi.fn(),
  onNotify: vi.fn(),
  onOpenProfile: vi.fn(),
  onNavigate: vi.fn()
});

const renderHeader = (props: Partial<React.ComponentProps<typeof StaticSiteHeader>> = {}) => {
  const h = handlers();
  render(
    <div>
      <StaticSiteHeader isAuthenticated={false} currentView="home" {...h} {...props} />
      <main>
        <a href="/somewhere">Page content</a>
      </main>
    </div>
  );
  return h;
};

const openStudios = () => fireEvent.click(screen.getByRole('button', { name: 'Studios' }));
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

beforeEach(() => {
  access.allowed = null;
  live.openLiveApp.mockClear();
  document.documentElement.style.overflow = '';
});
afterEach(cleanup);

describe('StaticSiteHeader', () => {
  it('leads with the DreamStream lockup, a real link home that a plain click opens in the app', () => {
    const h = renderHeader({ currentView: 'gallery' });
    const home = screen.getByRole('link', { name: 'DreamStream Studio home' });
    expect(home).toHaveAttribute('href', '/');
    expect(home.querySelector('svg[data-studio="dreamstream"]')).not.toBeNull();
    fireEvent.click(home);
    expect(h.onGoHome).toHaveBeenCalledTimes(1);
  });

  it('draws no comic chrome and no stale announcement banner', () => {
    renderHeader();
    const header = screen.getByRole('banner');
    expect(header.outerHTML).not.toMatch(/border-black|shadow-comic|brand-|font-display|font-comic/);
    expect(header.textContent).not.toMatch(/Try it free|Chat Studio is live/);
  });

  it('the studio switcher offers DreamStream, Comic, Chat, Stream and Atlas Studio', () => {
    const h = renderHeader();
    openStudios();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const panel = document.getElementById(screen.getByRole('button', { name: 'Studios' }).getAttribute('aria-controls')!)!;
    const names = within(panel).getAllByRole('link').map((a) => a.textContent ?? '');
    expect(names.map((n) => n.match(/^(DreamStream|Comic|Chat|Stream|Atlas) Studio/)?.[0])).toEqual([
      'DreamStream Studio',
      'Comic Studio',
      'Chat Studio',
      'Stream Studio',
      'Atlas Studio'
    ]);
    expect(within(nav).getByRole('link', { name: /^DreamStream Studio/ })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: /^Comic Studio/ })).toHaveAttribute('href', '/?view=dashboard');
    expect(within(nav).getByRole('link', { name: /^Chat Studio/ })).toHaveAttribute('href', '/?view=chat');
    expect(within(nav).getByRole('link', { name: /^Stream Studio/ })).toHaveTextContent(/baby monitor and family calls/);
    const atlas = within(nav).getByRole('link', { name: /^Atlas Studio/ });
    expect(atlas).toHaveAttribute('href', 'https://atlas.dreamstreamstudio.ai');
    fireEvent.click(within(nav).getByRole('link', { name: /^Chat Studio/ }));
    expect(h.onNavigate).toHaveBeenCalledWith('chat');
  });

  it('Stream Studio opens through the hand-off and says so while it waits', async () => {
    let finish!: () => void;
    live.openLiveApp.mockImplementationOnce(() => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))));
    renderHeader();
    openStudios();
    fireEvent.click(screen.getByRole('link', { name: /^Stream Studio/ }));
    expect(live.openLiveApp).toHaveBeenCalledWith('/live.html');
    expect(screen.getByText('Opening Stream Studio…')).toBeInTheDocument();
    await act(async () => finish());
  });

  it('links the public pages, holding the underline under the one on screen', () => {
    const h = renderHeader({ currentView: 'how-it-works' });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'How it works' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Library' })).toHaveAttribute('href', '/?view=gallery');
    expect(within(nav).getByRole('link', { name: 'Models' })).toHaveAttribute('href', '/models');
    fireEvent.click(within(nav).getByRole('link', { name: 'Library' }));
    expect(h.onViewComics).toHaveBeenCalledTimes(1);
  });

  describe('studio confinement (product_access) is unchanged', () => {
    it('an account confined to Stream Studio sees neither Comic nor Chat, nor the comic pages', () => {
      access.allowed = new Set(['stream_studio']);
      renderHeader();
      openStudios();
      const nav = screen.getByRole('navigation', { name: 'Main' });
      expect(within(nav).queryByRole('link', { name: /^Comic Studio/ })).toBeNull();
      expect(within(nav).queryByRole('link', { name: /^Chat Studio/ })).toBeNull();
      expect(within(nav).queryByRole('link', { name: 'How it works' })).toBeNull();
      expect(within(nav).queryByRole('link', { name: 'Library' })).toBeNull();
      expect(within(nav).getByRole('link', { name: 'Models' })).toBeInTheDocument();
      expect(within(nav).getByRole('link', { name: /^Atlas Studio/ })).toBeInTheDocument();
    });

    it('an account without Stream Studio sees it as Soon, with a way to be told', () => {
      access.allowed = new Set(['comic_studio']);
      const h = renderHeader();
      openStudios();
      const stream = screen.getByRole('link', { name: /^Stream Studio/ });
      expect(stream).toHaveTextContent('Soon');
      fireEvent.click(stream);
      expect(h.onNotify).toHaveBeenCalledTimes(1);
      expect(live.openLiveApp).not.toHaveBeenCalled();
    });

    it('admins are never confined', () => {
      access.allowed = new Set(['stream_studio']);
      renderHeader({ isAdmin: true });
      openStudios();
      expect(screen.getByRole('link', { name: /^Comic Studio/ })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /^Chat Studio/ })).toBeInTheDocument();
    });
  });

  it('signed out: Sign in and Request access; signed in: the account controls instead', () => {
    const h = renderHeader();
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' })[0]);
    expect(h.onSignIn).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Request access/ }));
    expect(h.onRequestAccess).toHaveBeenCalled();
    cleanup();
    const signedIn = renderHeader({ isAuthenticated: true });
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Your profile' }));
    expect(signedIn.onOpenProfile).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('frosts only once the page scrolls under it', () => {
    renderHeader();
    const header = screen.getByRole('banner');
    expect(header).not.toHaveAttribute('data-scrolled');
    act(() => {
      Object.defineProperty(window, 'scrollY', { value: 120, configurable: true });
      window.dispatchEvent(new Event('scroll'));
    });
    expect(header).toHaveAttribute('data-scrolled', 'true');
    act(() => {
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
      window.dispatchEvent(new Event('scroll'));
    });
    expect(header).not.toHaveAttribute('data-scrolled');
  });

  describe('the phone menu', () => {
    it('opens every studio and page in one panel with 44 px rows, and locks the page scroll meanwhile', () => {
      renderHeader();
      openMenu();
      const toggle = screen.getByRole('button', { name: 'Close menu' });
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
      const nav = within(panel).getByRole('navigation', { name: 'Studios and pages' });
      for (const name of [/^DreamStream Studio/, /^Comic Studio/, /^Chat Studio/, /^Stream Studio/, /^Atlas Studio/, /How it works/, /Library/, /Models/]) {
        const row = within(nav).getByRole('link', { name });
        expect(row.className).toContain('min-h-11');
      }
      // The page on screen is the ink-filled row.
      expect(within(nav).getByRole('link', { name: /^DreamStream Studio/ })).toHaveAttribute('aria-current', 'page');
      expect(within(panel).getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: 'Request access' })).toBeInTheDocument();
      expect(document.documentElement.style.overflow).toBe('hidden');
      // Above the page's own fixed bars while open; back on the header layer once closed.
      expect(screen.getByRole('banner').className).toContain('z-[var(--ds-z-popover)]');
      fireEvent.click(toggle);
      expect(screen.getByRole('banner').className).toContain('z-[var(--ds-z-header)]');
      expect(screen.getByRole('button', { name: 'Open menu' })).toHaveAttribute('aria-expanded', 'false');
      expect(document.documentElement.style.overflow).toBe('');
    });

    it('Escape closes it and returns focus to the menu button', () => {
      renderHeader();
      openMenu();
      const row = screen.getByRole('navigation', { name: 'Studios and pages' }).querySelector('a')!;
      row.focus();
      fireEvent.keyDown(row, { key: 'Escape' });
      const toggle = screen.getByRole('button', { name: 'Open menu' });
      expect(toggle).toHaveFocus();
      expect(screen.queryByRole('navigation', { name: 'Studios and pages' })).toBeNull();
    });

    it('a press on the page or focus leaving the header closes it', () => {
      renderHeader();
      openMenu();
      fireEvent.pointerDown(screen.getByRole('link', { name: 'Page content' }));
      expect(screen.queryByRole('navigation', { name: 'Studios and pages' })).toBeNull();
      openMenu();
      fireEvent.focusIn(screen.getByRole('link', { name: 'Page content' }));
      expect(screen.queryByRole('navigation', { name: 'Studios and pages' })).toBeNull();
    });

    it('choosing a row runs it and closes the menu; the sign-in buttons close it too', () => {
      const h = renderHeader();
      openMenu();
      fireEvent.click(within(screen.getByRole('navigation', { name: 'Studios and pages' })).getByRole('link', { name: 'Models' }));
      expect(h.onNavigate).toHaveBeenCalledWith('models');
      expect(screen.queryByRole('navigation', { name: 'Studios and pages' })).toBeNull();
      openMenu();
      const panel = document.getElementById(screen.getByRole('button', { name: 'Close menu' }).getAttribute('aria-controls')!)!;
      fireEvent.click(within(panel).getByRole('button', { name: 'Request access' }));
      expect(h.onRequestAccess).toHaveBeenCalled();
      expect(screen.queryByRole('navigation', { name: 'Studios and pages' })).toBeNull();
    });

    it('closes when the page changes', () => {
      const h = handlers();
      const { rerender } = render(<StaticSiteHeader isAuthenticated={false} currentView="home" {...h} />);
      openMenu();
      rerender(<StaticSiteHeader isAuthenticated={false} currentView="gallery" {...h} />);
      expect(screen.queryByRole('navigation', { name: 'Studios and pages' })).toBeNull();
    });
  });
});
