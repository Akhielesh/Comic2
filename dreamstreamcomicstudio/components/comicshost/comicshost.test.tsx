import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { ComicsLanding } from './ComicsLanding';
import { OFF_HOST_VIEWS, offHostUrlForView, shouldBootToDashboard } from './hostRouting';
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

  it('keeps signed-out visitors on the landing (which owns its chrome)', () => {
    const setView = vi.fn();
    const { result } = renderHook(() => useComicsHost({ view: 'home', setView, signedIn: false, ready: true, hostname: COMICS }));
    expect(setView).not.toHaveBeenCalled();
    expect(result.current.active).toBe(true);
    expect(result.current.ownsChrome('home')).toBe(true);
    expect(result.current.ownsChrome('dashboard')).toBe(false);
    expect(result.current.ownsChrome('auth')).toBe(false);
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

  it('greets signed-out visitors with Comic Studio branding and the existing sign-in / request-access flows', () => {
    const h = handlers();
    render(<ComicsLanding signedIn={false} {...h} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Talk it through.Get a finished comic.');
    expect(screen.getAllByText('Comic Studio').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /sign in to your studio/i }));
    expect(h.onSignIn).toHaveBeenCalledTimes(1);
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: /^sign in$/i }));
    expect(h.onSignIn).toHaveBeenCalledTimes(2);
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: /request access/i }));
    expect(h.onRequestAccess).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/invite-only during the beta/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /my comics/i })).toBeNull();
  });

  it('offers signed-in visitors their comics and the gallery', () => {
    const h = handlers();
    render(<ComicsLanding signedIn {...h} />);
    fireEvent.click(screen.getByRole('button', { name: /open my comics/i }));
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: /my comics/i }));
    expect(h.onOpenComics).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: /browse the gallery/i }));
    expect(h.onBrowseGallery).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull();
    expect(screen.queryByText(/invite-only/i)).toBeNull();
  });

  it('links other DreamStream products to the main site and keeps legal pages in-app', () => {
    const h = handlers();
    render(<ComicsLanding signedIn={false} {...h} />);
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByRole('link', { name: 'DreamStream home' })).toHaveAttribute('href', 'https://dreamstreamstudio.ai/');
    expect(within(footer).getByRole('link', { name: 'Chat Studio' })).toHaveAttribute('href', 'https://dreamstreamstudio.ai/?view=chat');
    expect(within(footer).getByRole('link', { name: 'Stream Studio' })).toHaveAttribute('href', 'https://dreamstreamstudio.ai/live.html');
    fireEvent.click(within(footer).getByRole('button', { name: 'Privacy' }));
    fireEvent.click(within(footer).getByRole('button', { name: 'Terms' }));
    expect(h.onOpenPrivacy).toHaveBeenCalledTimes(1);
    expect(h.onOpenTerms).toHaveBeenCalledTimes(1);
  });

  it('uses calm tokens, 44px targets and decorative-only art (no legacy comic chrome)', () => {
    const { container } = render(<ComicsLanding signedIn={false} {...handlers()} />);
    const markup = container.innerHTML;
    expect(markup).not.toMatch(/font-comic|border-2 border-black|shadow-comic/);
    expect(markup).toContain('var(--ds-canvas)');
    for (const target of [...screen.getAllByRole('button'), ...screen.getAllByRole('link')]) expect(target.className).toMatch(/min-h-\[44px\]/);
    expect(screen.getByTestId('comics-hero-art')).toHaveAttribute('aria-hidden');
  });
});
