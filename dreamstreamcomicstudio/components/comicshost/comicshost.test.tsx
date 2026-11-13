import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { DENSITY } from '../chat/studioDesign';
import { CONTACT_HREF } from '../layout/LegalMicroLinks';
import { ComicsLanding } from './ComicsLanding';
import { OFF_HOST_VIEWS, comicsChromeFor, offHostUrlForView, shouldBootToDashboard } from './hostRouting';
import { useComicsHost } from './useComicsHost';

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

const loc = (url: string) => {
  const u = new URL(url, 'https://comics.dreamstreamstudio.ai');
  return { pathname: u.pathname, search: u.search, hash: u.hash };
};

describe('hostRouting', () => {
  it('boots a bare visit (tracking params allowed) into the dashboard', () => {
    expect(shouldBootToDashboard(loc('/'))).toBe(true);
    expect(shouldBootToDashboard(loc('/?source=pwa'))).toBe(true);
    expect(shouldBootToDashboard(loc('/?utm_source=x#top'))).toBe(true);
  });

  it('never overrides a load that already has somewhere to go', () => {
    for (const url of [
      '/?view=studio&id=p1',
      '/?view=read&id=p1',
      '/?view=gallery',
      '/?board=p1',
      '/?next=/live.html',
      '/?invite=ABC',
      '/auth/callback?code=1',
      '/?code=1',
      '/#access_token=x&type=magiclink',
      '/?token_hash=t&type=signup',
      '/c/Ab3dEf6hIj9kLm2nP',
      '/share/tok'
    ]) {
      expect(shouldBootToDashboard(loc(url))).toBe(false);
    }
  });

  it('sends other products to the main site', () => {
    expect([...OFF_HOST_VIEWS].sort()).toEqual(['chat', 'models', 'ventures']);
    expect(offHostUrlForView('chat')).toBe('https://dreamstreamstudio.ai/?view=chat');
    expect(offHostUrlForView('ventures')).toBe('https://dreamstreamstudio.ai/?view=ventures');
    expect(offHostUrlForView('models')).toBe('https://dreamstreamstudio.ai/models');
    for (const comicsView of ['dashboard', 'comicstudio', 'gallery', 'reader', 'settings', 'learn', 'how-it-works', 'home', 'auth']) {
      expect(offHostUrlForView(comicsView)).toBeNull();
    }
  });
});

describe('comicsChromeFor (App.tsx: the suite header, ComicsHeader and the floating widgets per view)', () => {
  const on = (signedIn: boolean) => ({ active: true, signedIn });

  it('signed out, the landing, sign-in, Privacy, Terms and the Library are comics chrome: ComicsHeader (but the landing draws its own), no widgets', () => {
    expect(comicsChromeFor('home', on(false))).toEqual({ owns: true, header: false, widgets: false, current: 'other' });
    expect(comicsChromeFor('auth', on(false))).toEqual({ owns: true, header: true, widgets: false, current: 'auth' });
    expect(comicsChromeFor('privacy', on(false))).toEqual({ owns: true, header: true, widgets: false, current: 'other' });
    expect(comicsChromeFor('terms', on(false))).toEqual({ owns: true, header: true, widgets: false, current: 'other' });
    expect(comicsChromeFor('gallery', on(false))).toEqual({ owns: true, header: true, widgets: false, current: 'gallery' });
  });

  it('signed in, the public journey stays in Comic Studio; working views retain their app chrome', () => {
    expect(comicsChromeFor('home', on(true))).toMatchObject({ owns: true, header: false, widgets: false });
    for (const view of ['auth', 'privacy', 'terms', 'gallery']) {
      expect(comicsChromeFor(view, on(true)), view).toMatchObject({ owns: true, header: true, widgets: false });
    }
    for (const view of ['dashboard', 'comicstudio', 'reader', 'settings']) {
      expect(comicsChromeFor(view, on(true)), view).toMatchObject({ owns: false, header: false, widgets: true });
    }
  });

  it('the studio and the dashboard are never comics chrome, signed in or out', () => {
    for (const signedIn of [false, true]) {
      for (const view of ['dashboard', 'comicstudio']) expect(comicsChromeFor(view, on(signedIn)), `${view} ${signedIn}`).toMatchObject({ owns: false, header: false, widgets: true });
    }
  });

  it('off the comics host nothing changes: no comics chrome on any view', () => {
    for (const view of ['home', 'auth', 'privacy', 'terms', 'gallery', 'dashboard']) {
      for (const signedIn of [false, true]) {
        expect(comicsChromeFor(view, { active: false, signedIn }), view).toMatchObject({ owns: false, header: false, widgets: true });
      }
    }
  });
});

describe('useComicsHost', () => {
  const COMICS = 'comics.dreamstreamstudio.ai';

  it('is inert on the main site: no boot, no redirects, suite chrome everywhere', () => {
    const setView = vi.fn();
    const navigate = vi.fn();
    const { result } = renderHook(() =>
      useComicsHost({ view: 'chat', setView, signedIn: true, ready: true, hostname: 'dreamstreamstudio.ai', navigate })
    );
    expect(result.current.active).toBe(false);
    expect(result.current.leaving).toBe(false);
    expect(result.current.ownsChrome('home')).toBe(false);
    expect(setView).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('boots a signed-in visitor on the bare comics host into the dashboard, once, after auth resolves', () => {
    const setView = vi.fn();
    const { rerender } = renderHook((props: { ready: boolean; view: string }) =>
      useComicsHost({ view: props.view, setView, signedIn: true, ready: props.ready, hostname: COMICS }), { initialProps: { ready: false, view: 'home' } }
    );
    expect(setView).not.toHaveBeenCalled();
    rerender({ ready: true, view: 'home' });
    expect(setView).toHaveBeenCalledTimes(1);
    expect(setView).toHaveBeenCalledWith('dashboard');
    // Later visits to 'home' (logo click) show the landing instead of bouncing again.
    rerender({ ready: true, view: 'dashboard' });
    rerender({ ready: true, view: 'home' });
    expect(setView).toHaveBeenCalledTimes(1);
  });

  it('keeps signed-out visitors on the landing, and its chrome on the views they reach from it', () => {
    const setView = vi.fn();
    const { result } = renderHook(() => useComicsHost({ view: 'home', setView, signedIn: false, ready: true, hostname: COMICS }));
    expect(setView).not.toHaveBeenCalled();
    expect(result.current.active).toBe(true);
    // Sign-in, Privacy, Terms and the signed-out Library keep the comics header (no suite header, no widgets).
    for (const view of ['home', 'auth', 'privacy', 'terms', 'gallery']) expect(result.current.ownsChrome(view), view).toBe(true);
    for (const view of ['dashboard', 'comicstudio', 'reader', 'settings', 'learn']) expect(result.current.ownsChrome(view), view).toBe(false);
  });

  it('signed in, the Library and public pages retain Comic Studio chrome while working views keep their app header', () => {
    const { result } = renderHook(() => useComicsHost({ view: 'dashboard', setView: vi.fn(), signedIn: true, ready: true, hostname: COMICS }));
    expect(result.current.ownsChrome('home')).toBe(true);
    for (const view of ['gallery', 'privacy', 'terms', 'auth']) expect(result.current.ownsChrome(view), view).toBe(true);
    for (const view of ['dashboard', 'comicstudio']) expect(result.current.ownsChrome(view), view).toBe(false);
  });

  it('starts each view change at the top of the page on the comics host (never on the first render, never on the main site)', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    try {
      const { rerender } = renderHook((props: { view: string }) => useComicsHost({ view: props.view, setView: vi.fn(), signedIn: false, ready: true, hostname: COMICS }), {
        initialProps: { view: 'home' }
      });
      expect(scrollTo).not.toHaveBeenCalled();
      rerender({ view: 'gallery' });
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 0 });
      rerender({ view: 'gallery' });
      expect(scrollTo).toHaveBeenCalledTimes(1);
      rerender({ view: 'privacy' });
      expect(scrollTo).toHaveBeenCalledTimes(2);
      scrollTo.mockClear();
      const main = renderHook((props: { view: string }) => useComicsHost({ view: props.view, setView: vi.fn(), signedIn: false, ready: true, hostname: 'dreamstreamstudio.ai' }), {
        initialProps: { view: 'home' }
      });
      main.rerender({ view: 'gallery' });
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      scrollTo.mockRestore();
    }
  });

  it('does not boot when the first URL carried a deep link (read before the URL sync rewrites it)', () => {
    window.history.replaceState({}, '', '/?view=studio&id=p1');
    const setView = vi.fn();
    const { rerender } = renderHook((props: { ready: boolean }) =>
      useComicsHost({ view: 'home', setView, signedIn: true, ready: props.ready, hostname: COMICS }), { initialProps: { ready: false } }
    );
    window.history.replaceState({}, '', '/'); // App's URL-sync effect clears ?view=&id= before auth resolves
    rerender({ ready: true });
    expect(setView).not.toHaveBeenCalled();
  });

  it('hands other products to the main site with replace() and reports leaving while it does', () => {
    const navigate = vi.fn();
    const { result, rerender } = renderHook((props: { view: string }) =>
      useComicsHost({ view: props.view, setView: vi.fn(), signedIn: false, ready: true, hostname: COMICS, navigate }), { initialProps: { view: 'gallery' } }
    );
    expect(result.current.leaving).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    rerender({ view: 'chat' });
    expect(result.current.leaving).toBe(true);
    expect(navigate).toHaveBeenCalledWith('https://dreamstreamstudio.ai/?view=chat');
    rerender({ view: 'models' });
    expect(navigate).toHaveBeenLastCalledWith('https://dreamstreamstudio.ai/models');
  });
});

describe('ComicsLanding', () => {
  const handlers = () => ({
    onSignIn: vi.fn(),
    onRequestAccess: vi.fn(),
    onOpenComics: vi.fn(),
    onBrowseGallery: vi.fn(),
    onOpenPrivacy: vi.fn(),
    onOpenTerms: vi.fn()
  });
  const heroOf = () => screen.getByTestId('comics-hero-cta').closest('section') as HTMLElement;

  it('routes signed-out readers to sign-in, access requests and the Library', () => {
    const h = handlers();
    render(<ComicsLanding signedIn={false} {...h} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Make your story a comic.' })).toBeInTheDocument();
    fireEvent.click(within(heroOf()).getByRole('button', { name: 'Start creating' }));
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Sign in' }));
    expect(h.onSignIn).toHaveBeenCalledTimes(2);
    fireEvent.click(within(heroOf()).getByRole('button', { name: 'Request access' }));
    expect(h.onRequestAccess).toHaveBeenCalledTimes(1);
    fireEvent.click(within(heroOf()).getByRole('button', { name: 'Browse the Library' }));
    expect(h.onBrowseGallery).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'My comics' })).toBeNull();
  });

  it('offers signed-in visitors their comics and the Library', () => {
    const h = handlers();
    render(<ComicsLanding signedIn {...h} />);
    fireEvent.click(within(heroOf()).getByRole('button', { name: 'My comics' }));
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'My comics' }));
    expect(h.onOpenComics).toHaveBeenCalledTimes(2);
    fireEvent.click(within(heroOf()).getByRole('button', { name: 'Browse the Library' }));
    expect(h.onBrowseGallery).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
  });

  it('the footer links to the Library, legal pages, and the routed support mailbox', () => {
    const h = handlers();
    render(<ComicsLanding signedIn={false} {...h} />);
    const footer = within(screen.getByRole('contentinfo'));
    expect(footer.getByRole('link', { name: 'Contact' })).toHaveAttribute('href', CONTACT_HREF);
    fireEvent.click(footer.getByRole('button', { name: 'Privacy Policy' }));
    fireEvent.click(footer.getByRole('button', { name: 'Terms & Conditions' }));
    fireEvent.click(footer.getByRole('button', { name: 'Library' }));
    expect(h.onOpenPrivacy).toHaveBeenCalledTimes(1);
    expect(h.onOpenTerms).toHaveBeenCalledTimes(1);
    expect(h.onBrowseGallery).toHaveBeenCalledTimes(1);
  });

  it('keeps touch targets and artwork accessible without legacy chrome', () => {
    const { container } = render(<ComicsLanding signedIn={false} {...handlers()} />);
    expect(container.innerHTML).not.toMatch(/font-comic|border-black|shadow-comic/);
    const floor = DENSITY.coarse.split(' ')[0];
    for (const target of [...screen.getAllByRole('button'), ...screen.getAllByRole('link')]) {
      expect(target.getAttribute('data-slot') === 'button' || target.className.split(/\s+/).includes(floor), target.outerHTML.slice(0, 120)).toBe(true);
    }
    for (const art of container.querySelectorAll('[data-comic-art]')) expect(art.closest('[aria-hidden]')).not.toBeNull();
  });

  it('the first view has one filled action: the hero; the header’s Sign in / My comics is the outline button, never a fill (C1)', () => {
    for (const signedIn of [false, true]) {
      const { unmount } = render(<ComicsLanding signedIn={signedIn} {...handlers()} />);
      const header = screen.getByRole('banner');
      const entry = within(header).getByRole('button', { name: signedIn ? 'My comics' : 'Sign in' });
      expect(entry).toHaveAttribute('data-variant', 'outline');
      // Nothing in the header is a filled button on the landing (the ink primary or the spark).
      const fills = [...header.querySelectorAll('[data-slot="button"]')].filter((b) => ['default', 'create'].includes(b.getAttribute('data-variant') || ''));
      expect(fills.map((b) => b.textContent?.trim())).toEqual([]);
      // The hero carries the one fill, scoped to the Comic Studio theme.
      expect(screen.getByTestId('comics-hero-cta')).toHaveAttribute('data-variant', 'default');
      expect(screen.getByTestId('comics-hero-cta')).toHaveClass('comics-primary-action');
      unmount();
    }
  });

  it('uses the scoped comic primary without the global purple spark', () => {
    for (const signedIn of [false, true]) {
      const { container, unmount } = render(<ComicsLanding signedIn={signedIn} {...handlers()} />);
      const sparks = container.querySelectorAll('[data-variant="create"]');
      expect(sparks).toHaveLength(0);
      expect(container.innerHTML).not.toMatch(/(?<![\w-])text-white(?![\w-])/);
      unmount();
    }
  });

  it('no money and no model names, for anyone (governed users never see $ or ¢)', () => {
    for (const signedIn of [false, true]) {
      const { container, unmount } = render(<ComicsLanding signedIn={signedIn} {...handlers()} />);
      const text = container.textContent || '';
      expect(text).not.toMatch(/[$¢€£]/);
      expect(text).not.toMatch(/\b(?:cost|price|pricing|credits?|usd|gemini|gpt|claude|imagen|flux|nano banana)\b/i);
      unmount();
    }
  });
});
