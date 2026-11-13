/**
 * The app shell's own screens (DS-2): the full-screen loader, the product gate, the could-not-open screen
 * and the root's page are on the DS states and recipes, with no legacy kit class and no raw hue.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./services/liveLink', () => ({ openLiveApp: vi.fn(async () => undefined) }));

import { AppLoader, LEGACY_PAPER_VIEWS, ProductGateScreen, SystemErrorScreen, appRootClass, appRootSurface } from './App';
import { CANVAS_BG, INK } from './components/chat/studioDesign';
import { openLiveApp } from './services/liveLink';

/** Every class on every element under `root`. */
const classesIn = (root: Element): string[] => [root, ...root.querySelectorAll('*')].flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/)).filter(Boolean);
/** The legacy kit (DS-0's legacyKit guard) and the raw hues this shell used to spell. */
const LEGACY = /^(?:[\w-]+:)*(?:border-black|shadow-comic|font-comic|font-display|(?:bg|text|border)-brand-\w+|bg-slate-\d+|text-slate-\d+|bg-zinc-\d+|(?:bg|text|border)-red-\d+(?:\/\d+)?|animate-pulse)$/;

describe('AppLoader', () => {
  it('is the DS loading state on the canvas, saying what loads', () => {
    const { container } = render(<AppLoader label="Opening project…" />);
    const loader = container.querySelector('[data-slot="app-loader"]')!;
    expect(loader).toHaveAttribute('aria-busy', 'true');
    expect(loader.className).toContain(CANVAS_BG);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('data-slot', 'loading-state');
    expect(status).toHaveTextContent('Opening project…');
    expect(classesIn(container).filter((c) => LEGACY.test(c))).toEqual([]);
  });

  it('says "Loading…" by default', () => {
    render(<AppLoader />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });
});

describe('ProductGateScreen', () => {
  it('is the DS empty state: what is missing, why, and the way home', () => {
    const onGoHome = vi.fn();
    const { container } = render(<ProductGateScreen productLabel="Comic Studio" canStream={false} onGoHome={onGoHome} />);
    expect(container.querySelector('[data-slot="empty-state"]')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('This account doesn’t include Comic Studio');
    expect(screen.getByText(/Ask your admin to enable Comic Studio for you/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Stream Studio' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to home' }));
    expect(onGoHome).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Back to home' })).toHaveAttribute('data-slot', 'button');
    expect(classesIn(container).filter((c) => LEGACY.test(c))).toEqual([]);
  });

  it('offers Stream Studio first when the account has it', () => {
    render(<ProductGateScreen productLabel="Chat Studio" canStream onGoHome={() => undefined} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Open Stream Studio', 'Back to home']);
    fireEvent.click(buttons[0]);
    expect(openLiveApp).toHaveBeenCalledWith('/live.html');
  });
});

describe('SystemErrorScreen', () => {
  it('is the DS error state on the canvas: the reason, Try again and Dismiss, never a red slab', () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    const { container } = render(<SystemErrorScreen message="Comic not found or private." onRetry={onRetry} onDismiss={onDismiss} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-slot', 'error-state');
    expect(alert).toHaveTextContent('That didn’t open');
    expect(alert).toHaveTextContent('Comic not found or private.');
    expect(screen.queryByText(/System Error/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-slot="system-error"]')!.className).toContain(CANVAS_BG);
    expect(classesIn(container).filter((c) => LEGACY.test(c))).toEqual([]);
  });
});

describe('the root page under the views', () => {
  it('is the canvas token, except for the legacy views that still need their light page', () => {
    for (const view of ['home', 'chat', 'auth', 'auth-callback', 'gallery', 'settings', 'comicstudio', 'publiccomic', 'shared']) {
      expect(appRootSurface(view), view).toBe(CANVAS_BG);
    }
    expect([...LEGACY_PAPER_VIEWS].sort()).toEqual(['dashboard', 'editor', 'fontlab', 'learn']);
    for (const view of LEGACY_PAPER_VIEWS) expect(appRootSurface(view), view).not.toBe(CANVAS_BG);
  });
});

describe('the root div', () => {
  const classes = (view: string, gated: boolean, comicsChrome = false) => appRootClass(view, gated, comicsChrome).split(/\s+/);

  it('is the positioned full-height page on the canvas, or the legacy light page for a legacy view', () => {
    expect(classes('home', false)).toEqual(expect.arrayContaining(['relative', 'min-h-screen', 'font-sans', ...CANVAS_BG.split(/\s+/)]));
    expect(classes('dashboard', false)).toContain('bg-slate-50');
    expect(classes('dashboard', false)).not.toEqual(expect.arrayContaining(CANVAS_BG.split(/\s+/)));
  });

  it('a gated view sits on the canvas: the product gate is on the DS, even over a legacy-paper view', () => {
    for (const view of [...LEGACY_PAPER_VIEWS, 'chat', 'comicstudio']) {
      expect(classes(view, true), view).toEqual(expect.arrayContaining(CANVAS_BG.split(/\s+/)));
      expect(classes(view, true), view).not.toContain('bg-slate-50');
    }
  });

  it('the comics host’s own views sit on the canvas and the root owns their ink (never the body’s light ink in dark)', () => {
    for (const view of ['home', 'auth', 'privacy', 'terms', 'gallery']) {
      expect(classes(view, false, true), view).toEqual(expect.arrayContaining([...CANVAS_BG.split(/\s+/), ...INK.split(/\s+/)]));
      expect(classes(view, false, true), view).not.toContain('bg-slate-50');
      // Off the comics host (or signed in, where only the landing is comics chrome) the root sets no ink of its own.
      expect(classes(view, false, false), view).not.toEqual(expect.arrayContaining(INK.split(/\s+/)));
    }
  });

  it('App renders its root div with appRootClass, gated on the product gate, inked on the comics host’s own views', () => {
    const src = readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
    const root = src.split('\n').filter((l) => l.includes('data-slot="app-root"'));
    expect(root).toHaveLength(1);
    expect(root[0]).toContain('className={appRootClass(effectiveView, Boolean(gatedProductLabel), comicsChrome)}');
    // comicsChrome is hostRouting's rule (unit-tested there), read once for the header, the widgets and the root.
    expect(src).toContain('const chrome = comicsChromeFor(effectiveView, { active: comicsHost.active, signedIn: !!user });');
    expect(src).toContain('const comicsChrome = chrome.owns;');
  });
});

describe('opening a comic from the library (EGRESS-DB follow-up)', () => {
  const src = readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  /** The body of a top-level arrow function declared with `const name = ` inside App, up to the next one. */
  const body = (name: string) => {
    const start = src.indexOf(`  const ${name} = `);
    expect(start, name).toBeGreaterThan(-1);
    const next = src.indexOf('\n  const ', start + 1);
    const nextEffect = src.indexOf('\n  useEffect(', start + 1);
    const end = Math.min(...[next, nextEffect].filter((i) => i > start));
    return src.slice(start, end);
  };

  it('both opens go through resolveProjectOpen, and nothing else calls hydrateProjectAssets', () => {
    const calls = src.split('\n').filter((line) => /hydrateProjectAssets\(/.test(line));
    expect(calls).toHaveLength(2);
    for (const line of calls) expect(line).toContain('resolveProjectOpen(() => hydrateProjectAssets(id), ');
    // No bare promise chain on the hook's open: a `.catch` or `.finally` there is how the card used to be opened.
    expect(src).not.toMatch(/hydrateProjectAssets\(id\)\s*\.(then|catch|finally)\(/);
  });

  it('the workspace open returns before it sets the active comic or routes when the comic did not load', () => {
    const open = body('handleOpenProject');
    const stay = open.indexOf("if (opened.outcome === 'stayed') return;");
    expect(stay).toBeGreaterThan(open.indexOf('resolveProjectOpen('));
    // Every setActiveProjectId / routeTo in the promise chain comes after the early return.
    const chain = open.slice(open.indexOf('resolveProjectOpen('));
    expect(chain.indexOf('setActiveProjectId(id)')).toBeGreaterThan(chain.indexOf("if (opened.outcome === 'stayed') return;"));
    expect(chain.indexOf('routeTo(opened.project)')).toBeGreaterThan(chain.indexOf("if (opened.outcome === 'stayed') return;"));
    expect(chain.match(/setActiveProjectId\(id\)/g)).toHaveLength(1);
    // The loader always clears, whatever happened.
    expect(chain).toContain('.finally(() => setIsHydratingProject(false))');
  });

  it('the reader open does the same: no reader on the library card', () => {
    const read = body('navigateToReader');
    const chain = read.slice(read.indexOf('resolveProjectOpen('), read.indexOf('setIsHydratingProject(true);\n    try {'));
    const stay = chain.indexOf("if (opened.outcome === 'stayed') return;");
    expect(stay).toBeGreaterThan(-1);
    expect(chain.indexOf("setCurrentView('reader')")).toBeGreaterThan(stay);
    expect(chain.indexOf('setActiveProjectId(id)')).toBeGreaterThan(stay);
    expect(chain).toContain('.finally(() => setIsHydratingProject(false))');
  });
});
