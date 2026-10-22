// MediaBin / MediaPreview / the timeline feature module (timeline.md §4.3, §7 client).
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { makeFakeStudio, makeSampleDoc } from '../conversation/testing/fixtures';
import { richDoc } from './__fixtures__/richDoc';
import { MediaBin } from './MediaBin';
import { feature } from './index';
import { VersionsCard } from './VersionsCard';
import { MediaTab } from './MediaTab';
import { BookTimeline } from './BookTimeline';

const setup = (doc: ComicDoc = richDoc(), extra: Parameters<typeof makeFakeStudio>[0] = {}) => {
  const studio = makeFakeStudio({ doc, ...extra });
  const utils = render(<MediaBin studio={studio} />);
  return { studio, ...utils };
};

const tile = (name: RegExp) => screen.getAllByRole('button').find((b) => name.test(b.getAttribute('aria-label') || ''))!;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('feature module', () => {
  it('registers the versions card and the Media tab (shown once any image exists)', () => {
    expect(feature.cards).toEqual([{ type: 'versions', Component: VersionsCard }]);
    const tab = feature.tabs![0];
    expect(tab).toMatchObject({ id: 'media', label: 'Media', order: 500, Component: MediaTab });
    expect(tab.visible!(richDoc(), {} as never)).toBe(true);
    const empty = makeSampleDoc({ pages: [], cast: [] });
    empty.style = { ...empty.style, options: [] };
    expect(tab.visible!(empty, {} as never)).toBe(false);
  });
});

describe('MediaBin', () => {
  it('groups every image by owner in book order, with filters, counts and the archive counter', () => {
    setup();
    const groups = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(groups.slice(0, 2)).toEqual(['Cover', 'Page 1']);
    expect(groups).toContain('MAYA references');
    expect(groups).toContain('Chat uploads');
    expect(groups).toContain('Deleted page 4');
    expect(screen.getByText('Archive 2/300')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Archived\s*2/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Deleted/ }));
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Deleted page 4', 'Deleted page 9']);
  });

  it('search narrows by owner; an empty result says so', () => {
    setup();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'maya' } });
    for (const r of screen.getAllByRole('region')) expect(r.getAttribute('aria-label')).toMatch(/MAYA/);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
    expect(screen.getByText('Nothing matches')).toBeInTheDocument();
  });

  it('tiles sign their URLs only when they come into view', () => {
    const observed: Element[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe(el: Element) {
          observed.push(el);
        }
        disconnect() {}
        unobserve() {}
      }
    );
    const urlFor = vi.fn(() => 'https://cdn.test/x');
    render(<MediaBin studio={makeFakeStudio({ doc: richDoc(), urlFor })} />);
    expect(observed.length).toBeGreaterThan(5);
    expect(urlFor).not.toHaveBeenCalled();
  });

  it('a deleted page restores from its preview (free)', () => {
    const { studio } = setup();
    fireEvent.click(tile(/^Deleted page 4.*deleted$/));
    const dialog = screen.getByRole('dialog', { name: 'Deleted page 4' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore this page · Free' }));
    expect(studio.patch.mock.calls[0][0]).toEqual([{ op: 'page_restore', id: 'pg_t' }]);
    expect(within(dialog).getByRole('status').textContent).toMatch(/Restored as page 4/);
  });

  it('“Use as reference” adds a ref through the ref op (never a refs patch)', () => {
    const { studio } = setup();
    fireEvent.click(tile(/^Page 1, v2/));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Use as a reference for'), { target: { value: 'character:c_maya' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use as reference' }));
    expect(studio.patch.mock.calls[0][0]).toEqual([
      { op: 'ref_add', owner: { kind: 'character', id: 'c_maya' }, ref: expect.objectContaining({ path: 'u/x/p/p1-v2.webp', addedBy: 'user' }) }
    ]);
  });

  it('a chat upload becomes page art only with the explicit adopt flag; off-shape art asks first', () => {
    const { studio } = setup();
    fireEvent.click(tile(/^Chat uploads/));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Page to put this image on'), { target: { value: 'pg_2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use for this page' }));
    expect(studio.patch.mock.calls[0][0]).toEqual([{ op: 'render_use', target: { kind: 'page', id: 'pg_2' }, path: 'u/x/p/attach.webp', at: expect.any(Number), adopt: true }]);
    // ←/→ walks the filtered set; a square version asks before going on the 4:5 cover.
    studio.patch.mockClear();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.click(tile(/^Page 1, v2/));
    const d2 = screen.getByRole('dialog');
    fireEvent.click(within(d2).getByRole('button', { name: 'Use as cover' }));
    expect(studio.patch).not.toHaveBeenCalled();
    expect(within(d2).getByRole('alert').textContent).toMatch(/This image is 1:1, not 4:5/);
    fireEvent.click(within(d2).getByRole('button', { name: 'Use it anyway · Free' }));
    expect(studio.patch.mock.calls[0][0]).toEqual([{ op: 'render_use', target: { kind: 'cover' }, path: 'u/x/p/p1-v2.webp', at: expect.any(Number) }]);
  });

  it('archived versions can be starred; facts are recorded data', () => {
    const { studio } = setup();
    fireEvent.click(tile(/^Page 1, v1, archived/));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByText('Not recorded', { selector: 'dd' }).length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole('button', { name: /Star \(keep forever\)/ }));
    expect(studio.patch.mock.calls[0][0]).toEqual([{ op: 'version_star', path: 'u/x/p/p1-v1.webp', starred: true }]);
  });

  it('a new style board says which drawn pages go out of date before it is set', () => {
    const { studio } = setup();
    fireEvent.click(tile(/^Page 1, v2/));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set as style board' }));
    expect(studio.patch).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('alert').textContent).toMatch(/marks the drawn page out of date/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set it anyway · Free' }));
    expect(studio.patch.mock.calls[0][0]).toEqual([{ op: 'style', patch: { board: expect.objectContaining({ path: 'u/x/p/p1-v2.webp' }) } }]);
  });

  it('only one undo toast shows across timeline surfaces (the newest edit wins)', () => {
    window.localStorage.setItem('comicstudio.timeline.dock', '1');
    const studio = makeFakeStudio({ doc: richDoc(), tab: 'media' });
    render(
      <>
        <MediaBin studio={studio} />
        <BookTimeline studio={studio} reorderActivation="immediate" />
      </>
    );
    fireEvent.click(tile(/^Deleted page 4.*deleted$/));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restore this page · Free' }));
    fireEvent.keyDown(screen.getAllByRole('option').find((o) => /^Page 1,/.test(o.getAttribute('aria-label') || ''))!, { key: 'Delete' });
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    expect(screen.getByText('Page 1 deleted')).toBeInTheDocument();
  });

  it('shows an honest empty state before any image exists', () => {
    const empty = makeSampleDoc({ pages: [], cast: [] });
    empty.style = { ...empty.style, options: [] };
    setup(empty);
    expect(screen.getByText('No images yet')).toBeInTheDocument();
    expect(screen.getByText('Archive 0/300')).toBeInTheDocument();
  });
});
