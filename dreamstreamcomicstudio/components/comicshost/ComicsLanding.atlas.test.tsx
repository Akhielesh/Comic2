// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    expect(looks.getAllByRole('button')).toHaveLength(6);
    expect(looks.getByRole('button', { name: 'Preview Ligne claire' })).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.getByRole('figure', { name: 'The Last Tram' })).toBeInTheDocument();
    expect(looks.getByText('The Paper Boat · six looks')).toBeInTheDocument();
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
