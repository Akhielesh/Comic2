// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComicsLanding } from './ComicsLanding';
import { LANDING_SECTION_IDS } from './landing/parts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
});

const renderLanding = () => render(
  <ComicsLanding
    signedIn={false}
    onSignIn={vi.fn()}
    onRequestAccess={vi.fn()}
    onOpenComics={vi.fn()}
    onBrowseGallery={vi.fn()}
    onOpenPrivacy={vi.fn()}
    onOpenTerms={vi.fn()}
  />
);

describe('Comics landing', () => {
  it('lays the page out in order: hero, features, looks, how it works, models, pricing, read, register, questions, then the footer', () => {
    const { container } = renderLanding();
    const main = container.querySelector('main') as HTMLElement;
    const ids = [...main.querySelectorAll('section[id]')].map((section) => section.id);
    expect(ids).toEqual([...LANDING_SECTION_IDS]);
    expect(ids).toEqual(['top', 'features', 'workspaces', 'looks', 'how-it-works', 'models', 'pricing', 'read', 'register', 'faq']);
    // Every section is named by its own heading, and the footer comes after the page.
    for (const section of main.querySelectorAll('section[id]')) {
      const label = document.getElementById(section.getAttribute('aria-labelledby') || '');
      expect(label?.textContent?.trim(), section.id).toBeTruthy();
    }
    expect(main.compareDocumentPosition(screen.getByRole('contentinfo')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the footer links to every section on the page, and each link shows its section and focuses its heading', () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    try {
      renderLanding();
      const nav = within(screen.getByRole('navigation', { name: 'On this page' }));
      const links = nav.getAllByRole('link');
      expect(links.map((a) => a.getAttribute('href'))).toEqual(['#features', '#workspaces', '#how-it-works', '#models', '#pricing', '#read', '#register', '#faq']);
      fireEvent.click(nav.getByRole('link', { name: 'Pricing' }));
      expect(scroll.mock.contexts.at(-1)).toBe(document.getElementById('pricing'));
      expect(screen.getByRole('heading', { level: 2, name: 'Pricing' })).toHaveFocus();
      fireEvent.click(nav.getByRole('link', { name: 'FAQ' }));
      expect(screen.getByRole('heading', { level: 2, name: 'Questions and answers' })).toHaveFocus();
      // The join link puts the cursor in the form's first field (whatever fields the form has).
      fireEvent.click(nav.getByRole('link', { name: 'Sign up' }));
      expect(document.activeElement?.closest('#register')).not.toBeNull();
      expect(document.activeElement?.tagName).toBe('BUTTON');
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('signed out, "Create an account" renders the app’s own form on the page; signed in, members get their comics instead', () => {
    const { unmount } = renderLanding();
    const register = within(document.getElementById('register') as HTMLElement);
    expect(register.getByRole('heading', { level: 2, name: 'Create an account' })).toBeInTheDocument();
    expect(register.getByRole('button', { name: 'Sign up' })).toBeInTheDocument();
    expect(document.querySelectorAll('form')).toHaveLength(0);
    expect(register.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    unmount();
    const onOpenComics = vi.fn();
    render(
      <ComicsLanding signedIn onSignIn={vi.fn()} onRequestAccess={vi.fn()} onOpenComics={onOpenComics} onBrowseGallery={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} />
    );
    const member = within(document.getElementById('register') as HTMLElement);
    expect(member.queryByRole('textbox')).toBeNull();
    fireEvent.click(member.getByRole('button', { name: 'Open My comics' }));
    expect(onOpenComics).toHaveBeenCalledTimes(1);
    // No join link for members in the footer.
    expect(within(screen.getByRole('navigation', { name: 'On this page' })).queryByRole('link', { name: 'Sign up' })).toBeNull();
  });

  it('arriving on a section link shows that section once, after the fonts and two frames, with a jump', async () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    let releaseFonts: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      releaseFonts = resolve;
    });
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } });
    const frames = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    window.history.replaceState({}, '', '/#models');
    try {
      renderLanding();
      // Nothing moves while the fonts are still loading (the page above has not reached its final height).
      expect(scroll).not.toHaveBeenCalled();
      await act(async () => {
        releaseFonts();
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.contexts[0]).toBe(document.getElementById('models'));
      expect(scroll.mock.calls[0][0]).toMatchObject({ block: 'start', behavior: 'auto' });
      expect(frames.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(document.activeElement).toBe(document.getElementById('landing-models'));
    } finally {
      frames.mockRestore();
      window.history.replaceState({}, '', '/');
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      delete (document as { fonts?: unknown }).fonts;
    }
  });

  it('offers the sample and style choices', () => {
    renderLanding();
    expect(screen.getByRole('heading', { name: 'Your story in panels.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Find your look' })).toBeInTheDocument();
    const looks = within(screen.getByRole('region', { name: 'Find your look' }));
    expect(looks.getAllByRole('button')).toHaveLength(6);
    expect(looks.getByRole('button', { name: 'Preview Ligne claire' })).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.getByRole('figure', { name: 'The Last Tram' })).toBeInTheDocument();
    expect(looks.getByText('The Paper Boat · six looks')).toBeInTheDocument();
  });

  it('opens the chosen edition from the hero and keeps the current page on keyboard dismissal', async () => {
    renderLanding();
    const opener = screen.getByRole('button', { name: 'Read a sample' });
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'The Last Tram' });
    expect(within(dialog).getByRole('button', { name: 'Previous sample page' })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'End' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('Page 2 of 2');
    expect(within(dialog).getByRole('button', { name: 'Next sample page' })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Home' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next sample page' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.getByRole('status')).toHaveTextContent('Page 2 of 2');
  });

  it('loads the selected shelf page and restores focus after inspecting the full-size edition', async () => {
    renderLanding();
    const shelf = within(screen.getByRole('group', { name: 'Choose a sample comic' }));
    const choose = (title: string) => fireEvent.click(shelf.getByRole('button', { name: title }));
    const currentPage = () => screen.getByTestId('comics-proof').querySelector('img');
    expect(screen.getByTestId('comics-proof').querySelectorAll('img')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Next sample page' }));
    expect(currentPage()).toHaveAttribute('src', expect.stringContaining('last-tram-page-2'));

    for (const [title, file] of [['Hello, Europa', 'hello-europa'], ['A Small Giant', 'a-small-giant']]) {
      choose(title);
      expect(shelf.getByRole('button', { name: title })).toHaveAttribute('aria-pressed', 'true');
      expect(currentPage()).toHaveAttribute('srcset', expect.stringContaining(file + '-page-1-480.webp'));
      expect(screen.getByRole('status')).toHaveTextContent('Page 1 of 1');
      expect(screen.queryByRole('button', { name: 'Next sample page' })).toBeNull();
      const enlarge = screen.getByRole('button', { name: 'Enlarge ' + title });
      fireEvent.click(enlarge);
      const dialog = screen.getByRole('dialog', { name: title });
      const large = dialog.querySelector('img');
      expect(large).toHaveAttribute('src', expect.stringContaining(file + '-page-1-1200.webp'));
      expect(large).not.toHaveAttribute('srcset');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close enlarged page' }));
      await waitFor(() => expect(enlarge).toHaveFocus());
    }

    choose('The Last Tram');
    expect(screen.getByRole('status')).toHaveTextContent('Page 1 of 2');
    expect(currentPage()).toHaveAttribute('src', expect.stringContaining('last-tram-page-1'));
  });

  it('flips the page on horizontal swipes, leaves vertical gestures to scroll and mounts one resting illustration', () => {
    renderLanding();
    const figure = screen.getByRole('figure', { name: 'The Last Tram' });
    const surface = figure.querySelector('[data-paper-turn-surface]')!;
    const scene = within(figure).getByRole('status');
    const touch = (clientX: number, clientY: number) => ({ identifier: 1, clientX, clientY });
    const swipe = (endX: number, endY: number) => {
      fireEvent.touchStart(surface, { touches: [touch(150, 80)] });
      fireEvent.touchMove(surface, { touches: [touch(endX, endY)] });
      fireEvent.touchEnd(surface, { touches: [], changedTouches: [touch(endX, endY)] });
    };
    expect(surface).toBeInTheDocument();
    // The sample shows the house turn: the page flip.
    expect(surface).toHaveAttribute('data-turn-style', 'flip');
    expect(surface.querySelectorAll('img')).toHaveLength(1);
    swipe(145, 180);
    expect(scene).toHaveTextContent('Page 1 of 2');
    swipe(60, 84);
    expect(scene).toHaveTextContent('Page 2 of 2');
    expect(surface.querySelectorAll('img')).toHaveLength(1);
    swipe(250, 80);
    expect(scene).toHaveTextContent('Page 1 of 2');
  });

  it('turns the sample page, announces the scene, and preserves the page across look changes', () => {
    renderLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Preview Ligne claire' }));
    const comparison = within(screen.getByRole('dialog', { name: 'Compare styles' }));
    const sample = within(screen.getByRole('figure', { name: 'The Paper Boat' }));
    const next = sample.getByRole('button', { name: 'Next sample page' });
    const previous = sample.getByRole('button', { name: 'Previous sample page' });
    expect(previous).toBeDisabled();
    expect(sample.getByRole('status')).toHaveTextContent(/Page 1 of 2.*Mira and Biscuit/);
    fireEvent.click(next);
    expect(next).toBeDisabled();
    expect(sample.getByRole('status')).toHaveTextContent(/Page 2 of 2.*catch the paper boat/);
    fireEvent.click(comparison.getByRole('button', { name: 'Manga' }));
    expect(comparison.getByRole('button', { name: 'Manga', pressed: true })).toBeInTheDocument();
    expect(sample.getByRole('status')).toHaveTextContent('Page 2 of 2. Manga.');
    fireEvent.click(previous);
    expect(previous).toBeDisabled();
    expect(sample.getByRole('status')).toHaveTextContent('Page 1 of 2. Manga.');
  });

  it('focuses the styles heading when using the header link', () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    try {
      renderLanding();
      fireEvent.click(within(screen.getByRole('navigation', { name: 'Comic Studio' })).getByRole('button', { name: 'Looks' }));
      expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
      expect(screen.getByRole('heading', { name: 'Find your look' })).toHaveFocus();
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('opens a real story comparison without a cover action and returns focus to the chosen look', async () => {
    renderLanding();
    expect(screen.queryByRole('button', { name: 'View cover' })).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'Preview Manga' });
    fireEvent.click(trigger);
    const comparison = within(screen.getByRole('dialog', { name: 'Compare styles' }));
    expect(comparison.getByRole('button', { name: 'Manga', pressed: true })).toBeInTheDocument();
    fireEvent.click(comparison.getByRole('button', { name: 'Close style comparison' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('supports bounded keyboard page navigation in the hero reader', () => {
    renderLanding();
    const sample = within(screen.getByRole('figure', { name: 'The Last Tram' }));
    const pages = sample.getByRole('group', { name: 'The Last Tram pages' });
    fireEvent.keyDown(pages, { key: 'ArrowRight' });
    expect(sample.getByRole('status')).toHaveTextContent('Page 2 of 2.');
    fireEvent.keyDown(pages, { key: 'ArrowRight' });
    expect(sample.getByRole('status')).toHaveTextContent('Page 2 of 2.');
    fireEvent.keyDown(pages, { key: 'Home' });
    expect(sample.getByRole('status')).toHaveTextContent('Page 1 of 2.');
    fireEvent.keyDown(pages, { key: 'End' });
    expect(sample.getByRole('status')).toHaveTextContent('Page 2 of 2.');
    fireEvent.keyDown(pages, { key: 'ArrowLeft' });
    expect(sample.getByRole('status')).toHaveTextContent('Page 1 of 2.');
  });

  it('uses the sticky app header and frosts it on scroll', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    renderLanding();
    const header = screen.getByRole('banner');
    expect(header).toHaveAttribute('data-slot', 'app-header');
    act(() => frames.splice(0).forEach((fn) => fn(0)));
    expect(header).toHaveAttribute('data-scrolled', 'false');
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 120 });
    window.dispatchEvent(new Event('scroll'));
    act(() => frames.splice(0).forEach((fn) => fn(0)));
    expect(header).toHaveAttribute('data-scrolled', 'true');
  });

  it('can switch to Paper, Dark and back to Light from the header Appearance control, with no reload', () => {
    renderLanding();
    const landing = screen.getByTestId('comics-landing');
    expect(landing).toHaveAttribute('data-comic-theme', 'atlas');
    fireEvent.click(screen.getByRole('button', { name: 'Appearance: Light' }));
    const choice = () => screen.getByRole('radiogroup', { name: 'Appearance' });
    fireEvent.click(within(choice()).getByRole('radio', { name: 'Paper' }));
    expect(landing).toHaveAttribute('data-comic-theme', 'paper');
    fireEvent.click(within(choice()).getByRole('radio', { name: 'Dark' }));
    expect(landing).toHaveAttribute('data-comic-theme', 'atlas');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    fireEvent.click(within(choice()).getByRole('radio', { name: 'Light' }));
    expect(landing).toHaveAttribute('data-comic-theme', 'atlas');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
