import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { DENSITY } from '../chat/studioDesign';
import { CONTACT_HREF } from '../layout/LegalMicroLinks';
import { mainAppUrl } from '../../services/productHost';
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

  it('signed in, only the landing is comics chrome; every other view keeps the app header and the widgets', () => {
    expect(comicsChromeFor('home', on(true))).toMatchObject({ owns: true, header: false, widgets: false });
    for (const view of ['auth', 'privacy', 'terms', 'gallery', 'dashboard', 'comicstudio', 'reader', 'settings']) {
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

  it('signed in, only the landing is comics chrome: the Library, Privacy, Terms and the dashboard keep the app header and its account menu', () => {
    const { result } = renderHook(() => useComicsHost({ view: 'dashboard', setView: vi.fn(), signedIn: true, ready: true, hostname: COMICS }));
    expect(result.current.ownsChrome('home')).toBe(true);
    for (const view of ['gallery', 'privacy', 'terms', 'auth', 'dashboard', 'comicstudio']) expect(result.current.ownsChrome(view), view).toBe(false);
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

  it('greets signed-out visitors with Comic Studio branding and the existing sign-in / request-access flows', () => {
    const h = handlers();
    render(<ComicsLanding signedIn={false} {...h} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Talk it through.Get a finished comic.');
    expect(screen.getByRole('button', { name: 'Comic Studio, home' })).toBeInTheDocument();
    const cta = screen.getByTestId('comics-hero-cta');
    expect(cta).toHaveTextContent(/start creating/i);
    fireEvent.click(cta);
    expect(h.onSignIn).toHaveBeenCalledTimes(1);
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: /^sign in$/i }));
    expect(h.onSignIn).toHaveBeenCalledTimes(2);
    fireEvent.click(within(heroOf()).getByRole('button', { name: /^request access$/i }));
    expect(h.onRequestAccess).toHaveBeenCalledTimes(1);
    // The access panel offers both again (Request access first, then Sign in).
    const access = document.getElementById('access') as HTMLElement;
    fireEvent.click(within(access).getByRole('button', { name: /request access/i }));
    fireEvent.click(within(access).getByRole('button', { name: /^sign in$/i }));
    expect(h.onRequestAccess).toHaveBeenCalledTimes(2);
    expect(h.onSignIn).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/invite-only during the beta/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /my comics/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /open your comics/i })).toBeNull();
  });

  it('offers signed-in visitors their comics and the Library', () => {
    const h = handlers();
    render(<ComicsLanding signedIn {...h} />);
    const open = screen.getAllByRole('button', { name: /open your comics/i });
    expect(open).toHaveLength(2); // the hero and the access panel
    for (const b of open) fireEvent.click(b);
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: /my comics/i }));
    expect(h.onOpenComics).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: /browse the library/i }));
    expect(h.onBrowseGallery).toHaveBeenCalledTimes(1);
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Library' }));
    expect(h.onBrowseGallery).toHaveBeenCalledTimes(2);
    fireEvent.click(within(screen.getByRole('contentinfo')).getByRole('button', { name: 'My comics' }));
    expect(h.onOpenComics).toHaveBeenCalledTimes(4);
    expect(screen.queryByText(/gallery/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /request access/i })).toBeNull();
    expect(screen.queryByText(/invite-only/i)).toBeNull();
  });

  it('the footer: the Library, the legal pages in-app, Contact, and DreamStream Studio as the only way off the product', () => {
    const h = handlers();
    render(<ComicsLanding signedIn={false} {...h} />);
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByRole('link', { name: 'DreamStream Studio' })).toHaveAttribute('href', mainAppUrl('/'));
    expect(within(footer).queryByRole('link', { name: /^(?:chat studio|stream studio|dreamstream home)$/i })).toBeNull();
    expect(screen.queryAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([CONTACT_HREF, mainAppUrl('/')]);
    // The routed support mailbox, spelled out (comparing with the imported constant would pass any address).
    expect(within(footer).getByRole('link', { name: 'Contact' })).toHaveAttribute('href', 'mailto:support@dreamstreamstudio.ai');
    expect(footer.innerHTML).not.toMatch(/contact@/);
    fireEvent.click(within(footer).getByRole('button', { name: 'Privacy Policy' }));
    fireEvent.click(within(footer).getByRole('button', { name: 'Terms & Conditions' }));
    expect(h.onOpenPrivacy).toHaveBeenCalledTimes(1);
    expect(h.onOpenTerms).toHaveBeenCalledTimes(1);
    fireEvent.click(within(footer).getByRole('button', { name: 'Library' }));
    fireEvent.click(within(footer).getByRole('button', { name: 'Request access' }));
    expect(h.onBrowseGallery).toHaveBeenCalledTimes(1);
    expect(h.onRequestAccess).toHaveBeenCalledTimes(1);
    expect(within(footer).getByRole('navigation', { name: 'Comic Studio links' })).toBeInTheDocument();
    expect(within(footer).getByRole('navigation', { name: 'Legal' })).toBeInTheDocument();
  });

  it('every target is the ds Button or carries the coarse-pointer 44 px floor; the art is decorative; no legacy comic chrome', () => {
    const { container } = render(<ComicsLanding signedIn={false} {...handlers()} />);
    const markup = container.innerHTML;
    expect(markup).not.toMatch(/font-comic|border-black|shadow-comic/);
    expect(markup).toContain('var(--ds-canvas)');
    const floor = DENSITY.coarse.split(' ')[0];
    for (const target of [...screen.getAllByRole('button'), ...screen.getAllByRole('link')]) {
      const ok = target.getAttribute('data-slot') === 'button' || target.className.split(/\s+/).includes(floor);
      expect(ok, target.outerHTML.slice(0, 120)).toBe(true);
    }
    const proof = screen.getByTestId('comics-proof');
    expect(proof.firstElementChild).toHaveAttribute('aria-hidden');
    expect(within(proof).getByText(/illustrated example/i)).toBeInTheDocument();
    // The replica is art: nothing in it is interactive.
    expect(proof.querySelectorAll('button, a, input, [tabindex]')).toHaveLength(0);
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
      // The hero carries the one fill: the spark signed out, the ink primary signed in.
      expect(screen.getByTestId('comics-hero-cta')).toHaveAttribute('data-variant', signedIn ? 'default' : 'create');
      unmount();
    }
  });

  it('the feature spots are the four CL-10 tiles (ink, magenta, leaf, sky; never ultramarine) and no terracotta anywhere beside the hero spark (DS-3 #5)', () => {
    // DS-3 #5 drew all three spots in ink; CL-10 ("Ink, Paper & Colour") makes them four solid tiles, the first still
    // ink, none in the spark's ultramarine (the full rule is in ComicsLanding.atlas.test.tsx).
    const { container } = render(<ComicsLanding signedIn={false} {...handlers()} />);
    const spots = [...container.querySelectorAll('#how-it-works ul > li > span[aria-hidden]')];
    expect(spots.map((spot) => /bg-\[var\(--ds-(ink|hue-\d-solid)\)\]/.exec(spot.className)?.[1])).toEqual(['ink', 'hue-2-solid', 'hue-6-solid', 'hue-7-solid']);
    expect(container.innerHTML.toLowerCase()).not.toMatch(/#d97757|#c2643f|#c2603f/);
  });

  it('one spark: signed out exactly one create fill (the hero), signed in none; never hard white', () => {
    for (const signedIn of [false, true]) {
      const { container, unmount } = render(<ComicsLanding signedIn={signedIn} {...handlers()} />);
      const sparks = container.querySelectorAll('[data-variant="create"]');
      expect(sparks).toHaveLength(signedIn ? 0 : 1);
      if (!signedIn) expect(sparks[0]).toBe(screen.getByTestId('comics-hero-cta'));
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
