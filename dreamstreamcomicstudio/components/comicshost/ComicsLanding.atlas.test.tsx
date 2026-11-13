// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComicsLanding } from './ComicsLanding';

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
  it('offers the sample and style choices without the previous walkthrough', () => {
    renderLanding();
    expect(screen.queryByText(/how it works/i)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Make your story a comic.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Find your look' })).toBeInTheDocument();
    const looks = within(screen.getByRole('region', { name: 'Find your look' }));
    expect(looks.getAllByRole('button', { pressed: false })).toHaveLength(5);
    expect(looks.getByRole('button', { name: 'Ligne claire' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('turns the sample page, announces the scene, and preserves the page across look changes', () => {
    renderLanding();
    const sample = within(screen.getByRole('figure', { name: 'The Paper Boat' }));
    const next = sample.getByRole('button', { name: 'Next sample page' });
    const previous = sample.getByRole('button', { name: 'Previous sample page' });
    expect(previous).toBeDisabled();
    expect(sample.getByRole('status')).toHaveTextContent(/Page 1 of 2.*Mira and Biscuit/);
    fireEvent.click(next);
    expect(next).toBeDisabled();
    expect(sample.getByRole('status')).toHaveTextContent(/Page 2 of 2.*catch the paper boat/);
    fireEvent.click(screen.getByRole('button', { name: 'Manga' }));
    expect(screen.getByRole('button', { name: 'Manga', pressed: true })).toBeInTheDocument();
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

  it('loads the cover only when the cover preview opens', () => {
    renderLanding();
    expect(screen.queryByAltText(/Mira and Biscuit look over/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View cover' }));
    const cover = within(screen.getByRole('dialog', { name: 'The Paper Boat' }));
    expect(cover.getByRole('img')).toHaveAttribute('src', '/assets/comic-sample/paper-boat-cover.webp');
    fireEvent.click(cover.getByRole('button', { name: 'Close cover preview' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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

  it('can switch from Atlas to Paper and back from the header', () => {
    renderLanding();
    const landing = screen.getByTestId('comics-landing');
    expect(landing).toHaveAttribute('data-comic-theme', 'atlas');
    fireEvent.click(screen.getByRole('button', { name: 'Use Paper theme' }));
    expect(landing).toHaveAttribute('data-comic-theme', 'paper');
    fireEvent.click(screen.getByRole('button', { name: 'Use Atlas theme' }));
    expect(landing).toHaveAttribute('data-comic-theme', 'atlas');
  });
});
