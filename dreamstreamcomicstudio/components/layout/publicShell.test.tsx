// usePublicViewHistory (components/layout/publicShell.ts): browser Back / Forward between the public pages.
// The harness reproduces App's routing as it is: handleNavigate pushes an entry per public page (/models gets
// its own path), handleBackToHome pushes one through clearReaderUrlParams, and the ?view= sync effect rewrites
// the current entry with replaceState. Before the hook, Home → How it works → Back changed the address and left
// How it works on screen (UX map §0 item 1). Studios, readers and signed-in workspaces own their history: the
// hook must be a strict no-op whenever the page on screen or the entry's page is one of them.
import React, { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearReaderUrlParams } from '../../services/readerUrl';
import { collapsesFloatingChrome, isPublicSurface, publicViewFromLocation, usePublicViewHistory } from './publicShell';

const NOT_SYNCED = new Set(['reader', 'shared', 'auth-callback', 'models', 'publiccomic']);

let setViewFromTest: (view: string) => void = () => undefined;

const Harness: React.FC<{ signedIn?: boolean; initial?: string }> = ({ signedIn = false, initial = 'home' }) => {
  const [view, setView] = useState(initial);
  setViewFromTest = setView;
  // App's ?view= sync (replaceState), declared before the hook as in App.
  useEffect(() => {
    if (NOT_SYNCED.has(view)) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('id');
    if (view === 'home') url.searchParams.delete('view');
    else url.searchParams.set('view', view);
    window.history.replaceState({}, '', url);
  }, [view]);
  usePublicViewHistory(view, setView, signedIn);

  // App's handleNavigate for the public pages.
  const navigate = (next: string) => {
    setView(next);
    const url = new URL(window.location.href);
    url.pathname = next === 'models' ? '/models' : '/';
    window.history.pushState({}, '', url);
  };
  // App's handleBackToHome (the header's lockup).
  const goHome = () => {
    setView('home');
    clearReaderUrlParams();
  };
  return (
    <div>
      <output data-testid="view">{view}</output>
      <button type="button" onClick={() => navigate('how-it-works')}>How it works</button>
      <button type="button" onClick={() => navigate('models')}>Models</button>
      <button type="button" onClick={() => navigate('dashboard')}>Comic Studio</button>
      <button type="button" onClick={goHome}>Home</button>
    </div>
  );
};

const shown = () => screen.getByTestId('view').textContent;

/** Traverse and wait for the traversal itself (its popstate), as the reader's Back tests do. */
const traverse = (delta: -1 | 1) =>
  act(
    () =>
      new Promise<void>((resolve) => {
        const done = () => {
          window.removeEventListener('popstate', done);
          // Let the listener's state update and the sync effect run.
          setTimeout(resolve, 0);
        };
        window.addEventListener('popstate', done);
        window.history.go(delta);
      })
  );
const back = () => traverse(-1);
const forward = () => traverse(1);

/** Put an entry on the stack the way a studio or reader does, without the harness's navigate. */
const pushEntry = (href: string, state: unknown = {}) => window.history.pushState(state, '', href);

beforeEach(() => {
  window.history.replaceState({}, '', '/');
});
afterEach(cleanup);

describe('usePublicViewHistory', () => {
  it('Home → How it works → Back shows Home again, and Forward How it works', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'How it works' }));
    expect(shown()).toBe('how-it-works');
    expect(window.location.search).toBe('?view=how-it-works');
    await back();
    expect(shown()).toBe('home');
    expect(window.location.search).toBe('');
    await forward();
    expect(shown()).toBe('how-it-works');
    expect(window.location.search).toBe('?view=how-it-works');
  });

  it('leaving the catalog for Home puts the path back to "/", so Back and Forward land on the right page', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Models' }));
    expect(window.location.pathname).toBe('/models');
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(shown()).toBe('home');
    expect(window.location.pathname).toBe('/');
    await back();
    expect(shown()).toBe('models');
    await forward();
    expect(shown()).toBe('home');
    expect(window.location.pathname).toBe('/');
  });

  it('signed out, a gated page is the sign-in page: Home → Comic Studio → Back returns home', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Comic Studio' }));
    expect(window.location.search).toBe('?view=dashboard');
    await back();
    expect(shown()).toBe('home');
  });

  it('signed in, the dashboard is a workspace: Back from it is left to App (no-op)', async () => {
    render(<Harness signedIn />);
    fireEvent.click(screen.getByRole('button', { name: 'Comic Studio' }));
    await back();
    expect(shown()).toBe('dashboard');
  });

  it.each(['comicstudio', 'reader', 'editor', 'pagestudio', 'publiccomic', 'shared'])('is a strict no-op while %s is on screen', async (workspace) => {
    render(<Harness signedIn />);
    pushEntry('/?view=gallery');
    act(() => setViewFromTest(workspace));
    // The studio / reader pushes its own entry (a tagged layer), then Back pops it.
    pushEntry(window.location.href, { csLayers: ['reader:c1#x.1'] });
    await back();
    expect(shown()).toBe(workspace);
  });

  it('is a no-op while signed-in chat is on screen', async () => {
    render(<Harness signedIn initial="chat" />);
    pushEntry('/?view=chat');
    await back();
    expect(shown()).toBe('chat');
  });

  it.each([
    ['a reader entry', '/?view=read&id=c1'],
    ['a studio entry', '/?view=studio&id=c1'],
    ['a board deep link', '/?board=b1'],
    ['a share link', '/c/some-comic'],
    ["a legal document's own path", '/privacy'],
    ['the sign-in callback', '/auth/callback'],
    ['a view the hook does not restore', '/?view=profile']
  ])('does nothing when the entry is %s', async (_name, href) => {
    render(<Harness />);
    // The entry under the page was written by its owner (a reader, a studio, another route).
    window.history.replaceState({}, '', href);
    fireEvent.click(screen.getByRole('button', { name: 'How it works' }));
    await back();
    expect(shown()).toBe('how-it-works');
  });

  it('a #fragment jump on the same page changes nothing', async () => {
    render(<Harness />);
    pushEntry('/#home-faq');
    await back();
    expect(shown()).toBe('home');
  });
});

describe('publicViewFromLocation', () => {
  const at = (href: string, signedIn = false) => {
    const url = new URL(href, 'https://dreamstreamstudio.ai');
    return publicViewFromLocation(url, signedIn);
  };
  it('names the public pages by their address', () => {
    expect(at('/')).toBe('home');
    expect(at('/?invite=ABC')).toBe('home');
    expect(at('/?view=how-it-works')).toBe('how-it-works');
    expect(at('/?view=gallery')).toBe('gallery');
    expect(at('/?view=privacy')).toBe('privacy');
    expect(at('/?view=terms')).toBe('terms');
    expect(at('/?view=auth')).toBe('auth');
    expect(at('/models')).toBe('models');
    expect(at('/models/')).toBe('models');
  });
  it('gated pages are public only when signed out', () => {
    expect(at('/?view=dashboard')).toBe('dashboard');
    expect(at('/?view=dashboard', true)).toBeNull();
    expect(at('/?view=chat', true)).toBeNull();
  });
  it('never names a studio, a reader or another path', () => {
    expect(at('/?view=read&id=1')).toBeNull();
    expect(at('/?view=comicstudio&id=1')).toBeNull();
    expect(at('/?view=editor')).toBeNull();
    expect(at('/share/token')).toBeNull();
    expect(at('/terms')).toBeNull();
  });
});

describe('collapsesFloatingChrome', () => {
  it('collapses on a phone on the public pages only', () => {
    for (const view of ['home', 'how-it-works', 'gallery', 'models', 'privacy', 'terms', 'auth', 'profile']) {
      expect(isPublicSurface(view)).toBe(true);
      expect(collapsesFloatingChrome(view, true)).toBe(true);
      expect(collapsesFloatingChrome(view, false)).toBe(false);
    }
    for (const view of ['dashboard', 'settings', 'chat', 'reader', 'comicstudio', 'editor', 'ventures']) {
      expect(collapsesFloatingChrome(view, true)).toBe(false);
    }
  });
});
