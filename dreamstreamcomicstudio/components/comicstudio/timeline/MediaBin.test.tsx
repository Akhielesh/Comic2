// MediaBin / MediaPreview / the timeline feature module (timeline.md §4.3, §7 client).
import { computeAccessibleName } from 'dom-accessibility-api';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ArchivedVersion, ComicDoc } from '../../../shared/comic/doc';
import { applyOps } from '../../../shared/comic/ops';
import { makeFakeStudio, makeSampleDoc } from '../conversation/testing/fixtures';
import { A, richDoc } from './__fixtures__/richDoc';
import { MediaBin } from './MediaBin';
import { OLDER_COMIC_LINE, OUTSIDE_STUDIO_LINE, OVERLAY_LINE, PANEL_PICTURE_LINE, pageArtRefusal } from './MediaPreview';
import type { MediaItem } from './bookModel';
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

  it('badges over a thumbnail are opaque tone surfaces, readable on any art (TONE_CHIP_ON_ART)', () => {
    setup();
    const overArt = [...document.querySelectorAll<HTMLElement>('[data-badge][data-on-art]')];
    const words = new Set(overArt.map((b) => b.textContent));
    expect(words.has('Deleted')).toBe(true);
    expect(words.has('Archived')).toBe(true);
    for (const b of overArt) {
      // Mixed into the raised surface (or the raised surface itself), never a tint over transparency.
      expect(b.className, b.textContent!).toMatch(/var\(--ds-raised\)/);
      expect(b.className, b.textContent!).not.toMatch(/_10%,transparent\)|well-strong/);
    }
    const deleted = overArt.find((b) => b.textContent === 'Deleted')!;
    expect(deleted.className).toContain('text-[var(--ds-danger-text)]');
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
    expect(studio.patch.mock.calls[0][0]).toEqual([{ op: 'render_use', target: { kind: 'page', id: 'pg_2' }, path: 'u/x/p/proj_1/ref/attach.webp', at: expect.any(Number), adopt: true }]);
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

  it('the preview stays on the same image after an action regroups the bin (tracked by path, not position)', () => {
    const doc = richDoc();
    const { studio, rerender } = setup(doc);
    fireEvent.click(tile(/^Chat uploads/));
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Page to put this image on'), { target: { value: 'pg_2' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Use for this page' }));
    const [ops] = studio.patch.mock.calls[0];
    // The optimistic doc: the upload is now page 2's art, so it moves up into the "Page 2" group.
    rerender(<MediaBin studio={{ ...studio, doc: applyOps(doc, ops) }} />);
    const dialog = screen.getByRole('dialog', { name: 'Page 2' });
    expect(within(dialog).getByRole('img', { name: /^Page 2, v1/ })).toBeInTheDocument();
    expect(within(dialog).getByText(/Page 2 · Chat uploads/)).toBeInTheDocument();
    expect(within(dialog).getByRole('status').textContent).toMatch(/page 2 uses this image now/);
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
    fireEvent.keyDown(screen.getAllByRole('option').find((o) => /^Page 1,/.test(computeAccessibleName(o)))!, { key: 'Delete' });
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

describe('MediaPreview — page/cover use follows the server’s render_use rule (gate follow-up)', () => {
  it('a reference that is not server art for this comic gets a calm line instead of Use for this page / Use as cover', () => {
    const { studio } = setup();
    // richDoc's MAYA reference keeps a legacy-shaped path (u/x/p/ref-maya.webp — not this comic's lane).
    fireEvent.click(tile(/^MAYA references/));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: 'Use for this page' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Use as cover' })).toBeNull();
    expect(within(dialog).queryByLabelText('Page to put this image on')).toBeNull();
    expect(within(dialog).getByTestId('page-art-refusal')).toHaveTextContent(OLDER_COMIC_LINE);
    // Everything else about it still works: a reference elsewhere, the style board, download.
    expect(within(dialog).getByLabelText('Use as a reference for')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Set as style board' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(studio.patch).not.toHaveBeenCalled();
  });

  it('this comic’s own uploads (its ref lane) and server-drawn versions keep both buttons', () => {
    setup();
    fireEvent.click(tile(/^Chat uploads/));
    const d1 = screen.getByRole('dialog');
    expect(within(d1).getByRole('button', { name: 'Use for this page' })).toBeInTheDocument();
    expect(within(d1).getByRole('button', { name: 'Use as cover' })).toBeInTheDocument();
    expect(within(d1).queryByTestId('page-art-refusal')).toBeNull();
    fireEvent.click(within(d1).getByRole('button', { name: 'Close' }));
    fireEvent.click(tile(/^Page 1, v2/));
    const d2 = screen.getByRole('dialog');
    expect(within(d2).getByRole('button', { name: 'Use as cover' })).toBeInTheDocument();
    expect(within(d2).queryByTestId('page-art-refusal')).toBeNull();
  });

  it('pageArtRefusal mirrors isServerArtForComic (+ the publish boundary’s isServerArt)', () => {
    const doc = richDoc(); // id proj_1
    const item = (path: string, role: MediaItem['role'] = 'ref', source: MediaItem['source'] = 'upload') => ({ path, role, source });
    // Server art for this comic: the library, this comic's ref lane (uploads re-encoded by the server), its generated img lane.
    expect(pageArtRefusal(item('library/photos/sky.webp'), doc)).toBeNull();
    expect(pageArtRefusal(item('u/x/p/proj_1/ref/photo.webp'), doc)).toBeNull();
    expect(pageArtRefusal(item('u/x/p/proj_1/img/gen-1.webp', 'style_option', 'generated'), doc)).toBeNull();
    expect(pageArtRefusal(item('u/x/p/proj_1/img/sheet.webp', 'sheet', 'derived'), doc)).toBeNull();
    // Art the server already drew for the book (a version of a page / cover / deleted page) is always fine.
    expect(pageArtRefusal(item('u/x/p/p1-v2.webp', 'page', 'generated'), doc)).toBeNull();
    expect(pageArtRefusal(item('u/x/p/trashed.webp', 'deleted_page', 'generated'), doc)).toBeNull();
    // A legacy import: an `upload` in this comic's PUBLIC img lane — the publish boundary refuses it.
    expect(pageArtRefusal(item('u/x/p/proj_1/img/legacy.webp'), doc)).toBe(OUTSIDE_STUDIO_LINE);
    // Not this comic's lane: another comic's, the classic <uid>/<file> lane, the client tmp lane, a bare library root, a traversal.
    expect(pageArtRefusal(item('u/x/p/other_2/ref/photo.webp'), doc)).toBe(OLDER_COMIC_LINE);
    expect(pageArtRefusal(item('u/x/p/other_2/img/gen.webp', 'style_option', 'generated'), doc)).toBe(OLDER_COMIC_LINE);
    expect(pageArtRefusal(item('x/photo.webp'), doc)).toBe(OLDER_COMIC_LINE);
    expect(pageArtRefusal(item('u/x/tmp/photo.webp'), doc)).toBe(OLDER_COMIC_LINE);
    expect(pageArtRefusal(item('library/sky.webp'), doc)).toBe(OLDER_COMIC_LINE);
    expect(pageArtRefusal(item('u/x/p/proj_1/ref/../img/x.webp'), doc)).toBe(OLDER_COMIC_LINE);
    expect(pageArtRefusal(item(''), doc)).toBe(OLDER_COMIC_LINE);
    // The doc id is matched the way the server builds the lane (laneSegment: anything odd → '-'), never as a regex.
    expect(pageArtRefusal(item('u/x/p/proj-1/ref/photo.webp'), { id: 'proj.1' })).toBeNull();
    expect(pageArtRefusal(item('u/x/p/projX1/ref/photo.webp'), { id: 'proj.1' })).toBe(OLDER_COMIC_LINE);
    expect(pageArtRefusal(item('u/x/p/proj_1/ref/photo.webp'), { id: '' })).toBe(OLDER_COMIC_LINE);
  });
});

describe('MediaPreview — the page picker starts on the image’s own page (timeline owner note 4a)', () => {
  /** richDoc with a second drawn page that has an earlier version. */
  const twoDrawn = () => {
    const doc = richDoc();
    doc.pages[1] = { ...doc.pages[1], render: { status: 'ready', asset: A('p2-v2', 32), history: [A('p2-v1', 22)] } };
    return doc;
  };
  const picker = (dialog: HTMLElement) => within(dialog).getByLabelText('Page to put this image on') as HTMLSelectElement;

  it('an earlier version of page 2 offers "Use for this page" on page 2, not page 1', () => {
    const { studio } = setup(twoDrawn());
    fireEvent.click(tile(/^Page 2, v1/));
    const dialog = screen.getByRole('dialog', { name: 'Page 2' });
    expect(picker(dialog).value).toBe('pg_2');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use for this page' }));
    expect(studio.patch.mock.calls[0][0]).toEqual([{ op: 'render_use', target: { kind: 'page', id: 'pg_2' }, path: 'u/x/p/p2-v1.webp', at: expect.any(Number) }]);
  });

  it('starts again on the new image’s page whenever the image changes; an image with no page starts on page 1', () => {
    setup(twoDrawn());
    fireEvent.click(tile(/^Page 2, v1/));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(picker(dialog), { target: { value: 'pg_3' } });
    expect(picker(dialog).value).toBe('pg_3');
    // ← to page 2's current version: back on page 2, not the pick made for the other image.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Previous image' }));
    expect(within(dialog).getByRole('img', { name: /^Page 2, v2 · current/ })).toBeInTheDocument();
    expect(picker(dialog).value).toBe('pg_2');
    fireEvent.change(picker(dialog), { target: { value: 'pg_3' } });
    // ← again: page 1's archived v1 starts on page 1.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Previous image' }));
    expect(within(dialog).getByRole('img', { name: /^Page 1, v1/ })).toBeInTheDocument();
    expect(picker(dialog).value).toBe('pg_1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    // A chat upload belongs to no page: page 1.
    fireEvent.click(tile(/^Chat uploads/));
    expect(picker(screen.getByRole('dialog')).value).toBe('pg_1');
  });
});

describe('MediaPreview — a panel picture or overlay a restore archived is not page art (timeline owner note 4b)', () => {
  const plain = (name: string, targetKey: string, label: string, archivedAt: number): ArchivedVersion => ({ path: `u/x/p/${name}.webp`, source: 'upload', at: 0, targetKey, label, archivedAt });
  const withPanelSources = () => {
    const doc = richDoc();
    doc.archive = [plain('ov-p1', 'page:pg_1', 'Page 1 overlay', 26), plain('pic-p2', 'page:pg_2', 'Page 2 panel picture', 27), plain('ov-t', 'page:pg_t', 'Deleted page 4 overlay', 28), ...doc.archive];
    return doc;
  };

  it('is shown under its page by its label, and never as one of the page’s versions', () => {
    setup(withPanelSources());
    const page1 = screen.getAllByRole('region').find((r) => r.getAttribute('aria-label') === 'Page 1')!;
    expect(within(page1).getByText('Page 1 overlay · date not recorded')).toBeInTheDocument();
    expect(within(page1).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).not.toContainEqual(expect.stringMatching(/^Page 1, v\d.*overlay/));
    const page2 = screen.getAllByRole('region').find((r) => r.getAttribute('aria-label') === 'Page 2')!;
    expect(within(page2).getByText('Page 2 panel picture · date not recorded')).toBeInTheDocument();
    expect(within(page2).queryByText(/^v\d/)).toBeNull();
    const deleted = screen.getAllByRole('region').find((r) => r.getAttribute('aria-label') === 'Deleted page 4')!;
    expect(within(deleted).getByText('Deleted page 4 overlay · date not recorded')).toBeInTheDocument();
  });

  it('offers no "Use for this page" or "Use as cover" — a calm line instead; reference, star and download stay', () => {
    const { studio } = setup(withPanelSources());
    fireEvent.click(tile(/^Page 1, Page 1 overlay · date not recorded, archived/));
    const dialog = screen.getByRole('dialog', { name: 'Page 1' });
    expect(within(dialog).queryByRole('button', { name: 'Use for this page' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Use as cover' })).toBeNull();
    expect(within(dialog).queryByLabelText('Page to put this image on')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /Compare with current/ })).toBeNull();
    expect(within(dialog).getByTestId('page-art-refusal')).toHaveTextContent(OVERLAY_LINE);
    // Shown by its label; its facts say only what is known (source 'upload' recorded that nothing was).
    expect(within(dialog).getByRole('img', { name: 'Page 1 overlay · date not recorded' })).toBeInTheDocument();
    expect(within(dialog).getByText("Overlay · not a version of the page's drawing", { selector: 'dd' })).toBeInTheDocument();
    expect(within(dialog).getByText('Date not recorded', { selector: 'dd' })).toBeInTheDocument();
    expect(within(dialog).queryByText('Uploaded', { selector: 'dd' })).toBeNull();
    expect(within(dialog).queryByText('Page art', { selector: 'dd' })).toBeNull();
    expect(within(dialog).getByLabelText('Use as a reference for')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Star \(keep forever\)/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(studio.patch).not.toHaveBeenCalled();
  });

  it('a panel picture says so; a deleted page’s overlay is not a way to restore that page', () => {
    setup(withPanelSources());
    fireEvent.click(tile(/^Page 2, Page 2 panel picture/));
    expect(within(screen.getByRole('dialog')).getByTestId('page-art-refusal')).toHaveTextContent(PANEL_PICTURE_LINE);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    fireEvent.click(tile(/^Deleted page 4, Deleted page 4 overlay/));
    const dialog = screen.getByRole('dialog', { name: 'Deleted page 4' });
    expect(within(dialog).queryByRole('button', { name: 'Restore this page · Free' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Use for this page' })).toBeNull();
    expect(within(dialog).getByTestId('page-art-refusal')).toHaveTextContent(OVERLAY_LINE);
  });
});
