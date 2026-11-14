import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComicSampleExploreButton, ComicSampleShelf } from './ComicSampleDeck';
import { FEATURED_SAMPLES, SAMPLE_COMICS, sampleLibraryHref } from '../comicstudio/library/sampleCatalog';

beforeEach(() => { Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo; });

describe('Sample comic collection', () => {
  it('offers five distinct complete new editions as native public Library links', () => {
    render(<ComicSampleShelf />);
    expect(FEATURED_SAMPLES).toHaveLength(5);
    expect(new Set(FEATURED_SAMPLES.map(comic => comic.style)).size).toBe(5);
    for (const comic of FEATURED_SAMPLES) {
      expect(screen.getByRole('link', { name: `Read ${comic.title}` })).toHaveAttribute('href', sampleLibraryHref(comic.id));
      expect(comic.pages[0].transcript).toHaveLength(comic.pages[0].panels);
      expect(comic.pages[0].src).toContain(`${comic.id}-page-1`);
    }
  });

  it('keeps three rapid next selections authoritative over a delayed smooth-scroll event', () => {
    render(<ComicSampleExploreButton />);
    fireEvent.click(screen.getByRole('button', { name: /Explore sample comics/ }));
    vi.useFakeTimers();
    try {
      const next = screen.getByRole('button', { name: 'Next sample comic' });
      fireEvent.click(next); fireEvent.click(next); fireEvent.click(next);
      expect(screen.getByRole('figure', { name: 'Hello, Europa' })).toBeInTheDocument();
      fireEvent.scroll(screen.getByRole('list', { name: 'Choose a sample comic' }));
      act(() => vi.advanceTimersByTime(200));
      expect(screen.getByRole('figure', { name: 'Hello, Europa' })).toBeInTheDocument();
      const track = screen.getByRole('list', { name: 'Choose a sample comic' });
      fireEvent.keyDown(track, { key: 'ArrowLeft' }); fireEvent.keyDown(track, { key: 'ArrowLeft' }); fireEvent.keyDown(track, { key: 'ArrowLeft' });
      expect(screen.getByRole('figure', { name: 'Rain for a Rooftop' })).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it('opens a readable deck, browses with buttons and keyboard, and restores its exact opener', async () => {
    render(<ComicSampleExploreButton />);
    const trigger = screen.getByRole('button', { name: /Explore sample comics/ });
    trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Explore sample comics' });
    const deck = within(dialog);
    expect(deck.getByRole('figure', { name: FEATURED_SAMPLES[0].title })).toBeInTheDocument();
    expect(deck.getByRole('button', { name: 'Previous sample comic' })).toBeDisabled();
    fireEvent.click(deck.getByRole('button', { name: 'Next sample comic' }));
    expect(deck.getByRole('figure', { name: FEATURED_SAMPLES[1].title })).toBeInTheDocument();
    expect(deck.getByRole('link', { name: /Open Midnight Parcel in the Library/ })).toHaveAttribute('href', sampleLibraryHref('midnight-parcel'));
    fireEvent.keyDown(deck.getByRole('list', { name: 'Choose a sample comic' }), { key: 'End' });
    expect(deck.getByRole('figure', { name: SAMPLE_COMICS.at(-1)!.title })).toBeInTheDocument();
    expect(deck.getByRole('button', { name: 'Next sample comic' })).toBeDisabled();
    fireEvent.keyDown(deck.getByRole('list', { name: 'Choose a sample comic' }), { key: 'Home' });
    expect(deck.getByRole('button', { name: `Read ${FEATURED_SAMPLES[0].title}`, pressed: true })).toHaveFocus();
    const figure = within(deck.getByRole('figure', { name: FEATURED_SAMPLES[0].title }));
    expect(figure.queryByRole('button', { name: 'Next sample page' })).toBeNull();
    fireEvent.click(figure.getByRole('button', { name: 'Enlarge comic page' }));
    expect(figure.getByRole('group', { name: `${FEATURED_SAMPLES[0].title} pages` })).toHaveAttribute('data-enlarged', 'true');
    fireEvent.click(figure.getByRole('button', { name: 'Fit comic page' }));
    expect(figure.getByRole('group', { name: `${FEATURED_SAMPLES[0].title} pages` })).not.toHaveAttribute('data-enlarged');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
