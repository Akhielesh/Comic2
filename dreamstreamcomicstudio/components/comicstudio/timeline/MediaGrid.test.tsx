// MediaGrid (DS-R1; redesign plan §4, master §11.3 M7): collectMedia → a CardGrid of MediaTiles. Sign-when-visible
// (urlFor runs only for tiles near the viewport), blocked images never signed nor drawn, the on-art badges and the
// version caption, filters through bookModel, explicit columns, and selection mode with pressed tiles.
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { richDoc } from './__fixtures__/richDoc';
import { collectMedia } from './bookModel';
import { MediaGrid, mediaTileLabel, MEDIA_GRID_THUMB_PX } from './MediaGrid';

class FakeIO {
  static all: FakeIO[] = [];
  targets: Element[] = [];
  constructor(public cb: IntersectionObserverCallback) {
    FakeIO.all.push(this);
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.targets = [];
  }
  takeRecords() {
    return [];
  }
}
const showAll = () =>
  act(() => {
    for (const io of [...FakeIO.all]) for (const t of [...io.targets]) io.cb([{ isIntersecting: true, target: t } as IntersectionObserverEntry], io as unknown as IntersectionObserver);
  });

const realIO = globalThis.IntersectionObserver;
beforeEach(() => {
  FakeIO.all = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIO;
});
afterEach(() => {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = realIO;
});

const studioFor = (doc: ComicDoc) => {
  const urlFor = vi.fn((asset: unknown, _opts?: { width?: number }) => {
    const path = typeof asset === 'string' ? asset : (asset as { path?: string } | null)?.path;
    return path ? `https://cdn.test/${path}` : undefined;
  });
  return { studio: { doc, urlFor } as never, urlFor };
};

describe('MediaGrid', () => {
  it('is one list of every image with explicit columns; tiles sign their 240 px URL only once near the viewport', () => {
    const doc = richDoc();
    const { studio, urlFor } = studioFor(doc);
    const all = collectMedia(doc);
    render(<MediaGrid studio={studio} columns={3} />);
    const list = screen.getByRole('list', { name: new RegExp(`^Assets, ${all.length} images$`) });
    expect(list.style.getPropertyValue('--cols')).toBe('3');
    expect(within(list).getAllByRole('listitem')).toHaveLength(all.length);
    expect(urlFor).not.toHaveBeenCalled();
    expect(document.querySelectorAll('img')).toHaveLength(0);
    showAll();
    const servable = all.filter((it) => !it.blocked);
    expect(urlFor).toHaveBeenCalledTimes(servable.length);
    for (const call of urlFor.mock.calls) expect(call[1]).toEqual({ width: MEDIA_GRID_THUMB_PX });
    expect(document.querySelectorAll('img')).toHaveLength(servable.length);
  });

  it('a blocked image is never signed and never an <img>: the neutral tile instead', () => {
    const doc = richDoc();
    const page = doc.pages[0];
    page.render = { ...page.render, asset: { ...page.render.asset!, safety: { assessed: 'X' } as never } };
    const blockedPath = page.render.asset!.path;
    const { studio, urlFor } = studioFor(doc);
    render(<MediaGrid studio={studio} columns={2} />);
    showAll();
    expect(urlFor.mock.calls.some((c) => (c[0] as { path?: string })?.path === blockedPath)).toBe(false);
    expect([...document.querySelectorAll('img')].some((img) => img.getAttribute('src')?.includes(blockedPath))).toBe(false);
    expect(screen.getAllByRole('img', { name: 'Hidden by the content check' }).length).toBeGreaterThan(0);
  });

  it('shows the on-art badges and names each tile the way MediaBin did', () => {
    const doc = richDoc();
    const { studio } = studioFor(doc);
    const { unmount } = render(<MediaGrid studio={studio} columns={4} filter="deleted" />);
    // Without onOpen a tile is a named picture, not a control.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getAllByRole('img', { name: /deleted/ }).length).toBeGreaterThan(0);
    unmount();
    render(<MediaGrid studio={studio} columns={4} filter="deleted" onOpen={() => {}} />);
    const tiles = screen.getAllByRole('button');
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) expect(t.getAttribute('aria-label')).toMatch(/deleted/);
    expect(screen.getAllByText('Deleted').length).toBe(tiles.length);
    const item = collectMedia(doc).find((it) => it.archived)!;
    expect(mediaTileLabel(item)).toContain('archived');
  });

  it('a filter with no match says so calmly', () => {
    const { studio } = studioFor(richDoc());
    render(<MediaGrid studio={studio} columns={2} query="zzzz-no-such-image" />);
    expect(screen.getByText('No images match these filters')).toBeInTheDocument();
  });

  it('opens a tile outside selection mode; in selection mode a tap toggles it and the tile is pressed', () => {
    const doc = richDoc();
    const { studio } = studioFor(doc);
    const onOpen = vi.fn();
    const items = collectMedia(doc);
    const { rerender } = render(<MediaGrid studio={studio} columns={3} onOpen={onOpen} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][1]).toBe(0);
    const toggle = vi.fn();
    const first = onOpen.mock.calls[0][0].path as string;
    rerender(<MediaGrid studio={studio} columns={3} onOpen={onOpen} selection={{ selecting: true, isSelected: (p) => p === first, toggle, clear: vi.fn() }} />);
    const tiles = screen.getAllByRole('button');
    expect(tiles[0]).toHaveAttribute('aria-pressed', 'true');
    expect(tiles[1]).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(tiles[1]);
    expect(toggle).toHaveBeenCalledWith(items.length > 1 ? expect.any(String) : first);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('grouped: one labelled section per owner in book order', () => {
    const { studio } = studioFor(richDoc());
    render(<MediaGrid studio={studio} columns={3} grouped />);
    const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(regions.slice(0, 2)).toEqual(['Cover', 'Page 1']);
  });
});
