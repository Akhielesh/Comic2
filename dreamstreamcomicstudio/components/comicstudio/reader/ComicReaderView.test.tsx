import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { ComicReaderView } from './ComicReaderView';

const drawnDoc = (mutate?: (d: ComicDoc) => void) =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0, w: 1000, h: 1500 } };
    d.pages.forEach((p, i) => {
      if (!p.render.asset) p.render = { ...p.render, status: 'ready', asset: { path: `u/p${i + 1}.png`, source: 'generated', at: 0 } };
    });
    mutate?.(d);
  });

const shownKeys = () => screen.getAllByTestId('reader-page').map((el) => el.getAttribute('data-key'));
const reader = () => screen.getByTestId('comic-reader');

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe('ComicReaderView', () => {
  it('starts on the cover and turns pages with the arrow keys', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    expect(shownKeys()).toEqual(['cover']);
    expect(screen.getByRole('img', { name: 'Cover of The Saffron Thief' })).toHaveAttribute('src', 'https://cdn.test/u/cover.png');
    fireEvent.keyDown(reader(), { key: 'ArrowRight' });
    expect(shownKeys()).toEqual(['pg_1']);
    expect(screen.getByTestId('reader-counter')).toHaveTextContent('Page 1 · 2/7');
    fireEvent.keyDown(reader(), { key: 'ArrowRight' });
    fireEvent.keyDown(reader(), { key: 'ArrowLeft' });
    expect(shownKeys()).toEqual(['pg_1']);
  });

  it('jumps with Home/End and stops at the ends', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    fireEvent.keyDown(reader(), { key: 'End' });
    expect(shownKeys()).toEqual(['pg_6']);
    fireEvent.keyDown(reader(), { key: 'ArrowRight' });
    expect(shownKeys()).toEqual(['pg_6']);
    fireEvent.keyDown(reader(), { key: 'Home' });
    expect(shownKeys()).toEqual(['cover']);
    fireEvent.keyDown(reader(), { key: 'ArrowLeft' });
    expect(shownKeys()).toEqual(['cover']);
  });

  it('reads right to left: ← is next, and spreads put the earlier page on the right', () => {
    render(<ComicReaderView doc={drawnDoc((d) => (d.format.readingDirection = 'rtl'))} urlFor={fakeUrlFor} initialMode="spread" />);
    expect(screen.getByText('Reads right to left')).toBeInTheDocument();
    expect(shownKeys()).toEqual(['cover']);
    fireEvent.keyDown(reader(), { key: 'ArrowLeft' });
    expect(shownKeys()).toEqual(['pg_2', 'pg_1']);
    fireEvent.keyDown(reader(), { key: 'ArrowRight' });
    expect(shownKeys()).toEqual(['cover']);
  });

  it('shows facing pages in spread mode, left to right', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="spread" />);
    fireEvent.keyDown(reader(), { key: 'ArrowRight' });
    expect(shownKeys()).toEqual(['pg_1', 'pg_2']);
    expect(screen.getByTestId('reader-counter')).toHaveTextContent('Pages 1–2 · 2/4');
  });

  it('keeps your place when switching modes, and remembers the mode', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="spread" />);
    fireEvent.keyDown(reader(), { key: 'ArrowRight' });
    fireEvent.keyDown(reader(), { key: 'ArrowRight' });
    expect(shownKeys()).toEqual(['pg_3', 'pg_4']);
    fireEvent.click(screen.getByRole('radio', { name: /Page/ }));
    expect(shownKeys()).toEqual(['pg_3']);
    expect(window.localStorage.getItem('comicstudio.reader.mode')).toBe('page');
  });

  it('turns pages with swipes', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    const stage = screen.getByTestId('reader-stage');
    fireEvent.pointerDown(stage, { clientX: 300, clientY: 100, pointerType: 'touch' });
    fireEvent.pointerUp(stage, { clientX: 150, clientY: 110, pointerType: 'touch' });
    expect(shownKeys()).toEqual(['pg_1']);
    fireEvent.pointerDown(stage, { clientX: 100, clientY: 100, pointerType: 'touch' });
    fireEvent.pointerUp(stage, { clientX: 260, clientY: 100, pointerType: 'touch' });
    expect(shownKeys()).toEqual(['cover']);
  });

  it('uses the toolbar arrows', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    const toolbar = screen.getByTestId('reader-counter').parentElement!;
    const [prev, next] = Array.from(toolbar.querySelectorAll('button'));
    expect(prev).toBeDisabled();
    fireEvent.click(next);
    expect(shownKeys()).toEqual(['pg_1']);
  });

  it('scroll mode lays every page out vertically, lettered', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="scroll" />);
    expect(shownKeys()).toEqual(['cover', 'pg_1', 'pg_2', 'pg_3', 'pg_4', 'pg_5', 'pg_6']);
    expect(screen.getByTestId('reader-scroll').querySelectorAll('[data-testid="balloon"]').length).toBeGreaterThan(0);
    expect(screen.getByText('The end.')).toBeInTheDocument();
  });

  it('reads only what is drawn, and says so', () => {
    render(<ComicReaderView doc={makeSampleDoc()} urlFor={fakeUrlFor} initialMode="page" />);
    expect(shownKeys()).toEqual(['pg_1']);
    expect(screen.getByText('2 of 6 pages drawn')).toBeInTheDocument();
  });

  it('has an empty state', () => {
    const doc = makeSampleDoc((d) => d.pages.forEach((p) => (p.render = { status: 'none', history: [] })));
    render(<ComicReaderView doc={doc} urlFor={fakeUrlFor} />);
    expect(screen.getByText('Nothing to read yet')).toBeInTheDocument();
  });

  it('renders extra toolbar controls', () => {
    render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} toolbarExtra={<button type="button">Export it</button>} />);
    expect(screen.getByRole('button', { name: 'Export it' })).toBeInTheDocument();
  });
});
