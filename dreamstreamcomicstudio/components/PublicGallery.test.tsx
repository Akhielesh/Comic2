// Public Library (sharing.md §5.5, services/publicListing.ts): only current Comic Studio publications are
// listed, each opening its read-only share link /c/<slug> with the public cover and the publish gate's rating;
// older comics are not listed (nor counted). A small Library shows its comics without search, sort or filters;
// "Kids-friendly (G/PG)" keeps only G and PG comics once the Library is big enough to need it.
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { libraryReads, rememberLibraryPage } from '../services/libraryDiscovery';
import { columnsRead, fakeSupabase, jsonBytes, projectRow } from '../services/projectRows.testkit';

const SLUG = 'AbCdEfGhIjKlMnOpQ';
const KEY = 'A'.repeat(22);
/** The public projects table the gallery reads (the fake applies the select, filters, order and range). */
const rows = {
  get value() {
    return fakeSupabase.state.tables.projects;
  },
  set value(next: Record<string, unknown>[]) {
    fakeSupabase.state.tables.projects = next;
  }
};

vi.mock('../services/supabase', async () => ({ supabase: (await import('../services/projectRows.testkit')).fakeSupabase.client }));
vi.mock('../services/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/db')>()),
  getImageUrl: vi.fn(async () => undefined),
  getProjectLikeMap: vi.fn(async () => ({})),
  toggleProjectLike: vi.fn(async () => ({ liked: true }))
}));
const viewer = vi.hoisted(() => ({ id: null as string | null }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: viewer.id ? {id:viewer.id} : null, loading:false }) }));
// The first candidate SmartImage would try (it preloads before painting), plus the fallbacks it
// would walk to when that fails.
vi.mock('./common/SmartImage', () => ({
  SmartImage: ({ src, alt, fallbackSources }: { src?: string; alt?: string; fallbackSources?: string[] }) => (
    <img src={src} alt={alt} data-fallbacks={(fallbackSources || []).join(' ')} />
  )
}));

const { PublicGallery, shareSlugOf, publicCoverUrl, isKidsFriendly, LIBRARY_TOOLS_MIN } = await import('./PublicGallery');
const db = await import('../services/db');

/** A listed comic: a published current-studio comic with a well-formed slug and a gate rating. */
const listed = (index: number, name: string, extra: Record<string, unknown> = {}) =>
  row(`comic-${String(index).padStart(3, '0')}`, name, { studioVersion: 4, shareSlug: `Slug${String(index).padStart(13, '0')}` }, { content_rating: 'PG', likes_count: 1, ...extra });
const manyRows = (count: number) => Array.from({ length: count }, (_, index) => listed(index, `Story ${String(index).padStart(3, '0')}`));
const LISTING_FILTERS = ['is_public=eq.true', 'is_forced_private=not.is.true', 'state->>studioVersion=eq.4', 'state->>shareSlug=not.is.null', 'content_rating=in.(G,PG,PG-13)'];
const submitSearch = (value: string) => {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value } });
  fireEvent.submit(screen.getByRole('search'));
};

const row = (id: string, name: string, state: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  user_id: 'u1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  is_public: true,
  state: { panels: [], styleVariants: [], ...state },
  ...extra
});

beforeEach(() => {
  viewer.id = null;
  localStorage.clear(); sessionStorage.clear();
  window.history.replaceState({}, '', '/?view=gallery');
  fakeSupabase.reset();
  fakeSupabase.state.tables.profiles = [{ id: 'u1', username: 'mira' }];
  rows.value = [
    row('v4-1', 'The Lake', { studioVersion: 4, shareSlug: SLUG, publicCover: `pub/${KEY}/cover-1080.webp` }, { content_rating: 'PG' }),
    row('v4-2', 'Night Raid', { studioVersion: 4, shareSlug: 'BbCdEfGhIjKlMnOpQ' }, { content_rating: 'PG-13' }),
    row('classic-1', 'Old Classic', { coverImageUrl: 'https://cdn.test/classic.png' })
  ];
});
afterEach(() => vi.clearAllMocks());

describe('PublicGallery helpers', () => {
  it('reads the share slug only from v4 rows with a well-formed slug', () => {
    expect(shareSlugOf({ id: 'a', name: 'a', createdAt: 0, updatedAt: 0, state: { studioVersion: 4, shareSlug: SLUG } } as never)).toBe(SLUG);
    expect(shareSlugOf({ id: 'a', name: 'a', createdAt: 0, updatedAt: 0, state: { studioVersion: 4, shareSlug: 'short' } } as never)).toBeUndefined();
    expect(shareSlugOf({ id: 'a', name: 'a', createdAt: 0, updatedAt: 0, state: { shareSlug: SLUG } } as never)).toBeUndefined();
  });

  it('builds the public cover URL only for an opaque pub/ path', () => {
    const p = (publicCover: unknown) => ({ id: 'a', name: 'a', createdAt: 0, updatedAt: 0, state: { studioVersion: 4, publicCover } }) as never;
    expect(publicCoverUrl(p(`pub/${KEY}/cover.webp`))).toBe(`https://sb.test/storage/v1/object/public/comic-assets/pub/${KEY}/cover.webp`);
    expect(publicCoverUrl(p('u/user/p/proj/cover.png'))).toBeUndefined();
    expect(publicCoverUrl(p(`pub/${KEY}/../secret.png`))).toBeUndefined();
    expect(publicCoverUrl(p(42))).toBeUndefined();
  });

  it('counts only G and PG as kids-friendly', () => {
    expect(isKidsFriendly('G')).toBe(true);
    expect(isKidsFriendly('PG')).toBe(true);
    expect(isKidsFriendly('PG-13')).toBe(false);
    expect(isKidsFriendly(undefined)).toBe(false);
  });
});

describe('PublicGallery lists only current Comic Studio comics', () => {
  it('links each listed comic to its share page with the public cover and rating; an older comic is not listed', async () => {
    const onReadComic = vi.fn();
    rows.value[1] = { ...rows.value[1], views_count: 12 };
    render(<PublicGallery onReadComic={onReadComic} onBack={() => undefined} />);
    const lake = await screen.findByRole('link', { name: 'Read The Lake' });
    expect(lake).toHaveAttribute('href', `/c/${SLUG}`);
    expect(lake.querySelector('img')?.getAttribute('src')).toBe(`https://sb.test/storage/v1/object/public/comic-assets/pub/${KEY}/cover-1080.webp`);
    expect(screen.getByRole('link', { name: 'Read Night Raid' })).toHaveAttribute('href', `/c/BbCdEfGhIjKlMnOpQ`);
    expect(screen.getByRole('img', { name: 'Rated PG' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Rated PG-13' })).toBeInTheDocument();
    expect(screen.queryByText('Old Classic')).toBeNull();
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(2);
    // A counted read shows; a zero does not.
    expect(screen.getAllByText('Views:')).toHaveLength(1);
    expect(screen.getByText('Views:').parentElement).toHaveTextContent('Views: 12');
    // A plain click follows the share link (a full page the reader owns); the in-app reader is not asked.
    fireEvent.click(lake);
    expect(onReadComic).not.toHaveBeenCalled();
  });

  it('asks the database for listed comics only, with the count, one page at a time', async () => {
    render(<PublicGallery onReadComic={() => undefined} />);
    await screen.findByRole('link', { name: 'Read The Lake' });
    const [query] = fakeSupabase.queriesOn('projects');
    expect(query.filters).toEqual([...LISTING_FILTERS, 'order=likes_count.desc', 'order=id.asc', 'range=0-47']);
    expect(query.count).toBe('exact');
    // The rows that come back are listed ones only: the older comic never leaves the database.
    const shipped = rows.value.filter((r) => r.id !== 'classic-1').map((r) => projectRow(r, query.columns));
    expect(JSON.stringify(shipped)).not.toContain('classic');
  });

  it('drops an older comic the database returned anyway, and does not count it', async () => {
    fakeSupabase.state.ignoredFilterColumns = new Set(['state->>studioVersion', 'state->>shareSlug', 'content_rating']);
    rows.value = [
      ...rows.value,
      // An older comic that copied the studio keys into its own state: the server-set rating is still missing.
      row('copycat', 'Copycat', { studioVersion: 4, shareSlug: 'CbCdEfGhIjKlMnOpQ' })
    ];
    render(<PublicGallery onReadComic={() => undefined} />);
    await screen.findByRole('link', { name: 'Read The Lake' });
    expect(screen.queryByText('Old Classic')).toBeNull();
    expect(screen.queryByText('Copycat')).toBeNull();
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent(/^2 comics$/);
  });

  it('never lists a comic held by moderation, even when the database returns it', async () => {
    fakeSupabase.state.ignoredFilterColumns = new Set(['is_forced_private']);
    rows.value = [...rows.value, row('held', 'Held Comic', { studioVersion: 4, shareSlug: 'CbCdEfGhIjKlMnOpQ', publicCover: `pub/${KEY}/cover.webp` }, { content_rating: 'G', is_forced_private: true })];
    render(<PublicGallery onReadComic={() => undefined} />);
    await screen.findByRole('link', { name: 'Read The Lake' });
    expect(screen.queryByRole('link', { name: 'Read Held Comic' })).toBeNull();
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(2);
  });

  it('a listed comic never shows an owner-written cover (first or fallback), and signs no draft', async () => {
    const owner = { coverImageUrl: 'https://evil.test/c.jpg', coverImageId: 'u/u1/p/v4/img/draft.webp', panels: [{ id: 'p', imageUrl: 'https://evil.test/p.jpg' }, { id: 'q', imageId: 'u/u1/p/v4/img/q.webp' }], styleVariants: [{ id: 's', imageUrl: 'https://evil.test/s.jpg' }] };
    rows.value = [
      row('v4-a', 'No Cover Yet', { studioVersion: 4, shareSlug: 'BbCdEfGhIjKlMnOpQ', ...owner }, { content_rating: 'G', cover_image_url: 'https://evil.test/x.jpg' }),
      row('v4-b', 'With Cover', { studioVersion: 4, shareSlug: SLUG, publicCover: `pub/${KEY}/cover-1080.webp`, ...owner }, { content_rating: 'PG', cover_image_url: 'https://evil.test/x.jpg' })
    ];
    render(<PublicGallery onReadComic={() => undefined} />);
    const noCover = await screen.findByRole('link', { name: 'Read No Cover Yet' });
    const withCover = screen.getByRole('link', { name: 'Read With Cover' });
    const seen = [noCover, withCover].map((a) => {
      const img = a.querySelector('img');
      return `${img?.getAttribute('src') ?? ''} ${img?.getAttribute('data-fallbacks') ?? ''}`;
    });
    expect(seen.join(' ')).not.toContain('evil.test');
    expect(withCover.querySelector('img')?.getAttribute('src')).toBe(`https://sb.test/storage/v1/object/public/comic-assets/pub/${KEY}/cover-1080.webp`);
    expect(noCover.querySelector('img')?.getAttribute('src')).toBeNull();
    expect(db.getImageUrl).not.toHaveBeenCalled();
  });

  it('reads cards: no `*`, no bare `state`, no `versions`', async () => {
    rows.value = [listed(1, 'Big', {}), ...rows.value];
    (rows.value[0].state as Record<string, unknown>).versions = Array.from({ length: 5 }, (_, i) => ({ id: `v${i}`, state: { script: 'draft '.repeat(2_000) } }));
    render(<PublicGallery onReadComic={() => undefined} />);
    await screen.findByRole('link', { name: 'Read Big' });
    const [query] = fakeSupabase.queriesOn('projects');
    const items = query.columns.split(',');
    expect(items).not.toContain('*');
    expect(items).not.toContain('state');
    expect(query.columns).not.toMatch(/versions|script/);
    for (const item of items) if (columnsRead(item)[0] === 'state') expect(item).toMatch(/^[A-Za-z]+:state->[A-Za-z]+$/);
    const shipped = rows.value.map((r) => projectRow(r, query.columns));
    expect(JSON.stringify(shipped)).not.toContain('draft draft');
    expect(jsonBytes(shipped)).toBeLessThan(jsonBytes(rows.value) / 10);
  });

  it('the trending fallback keeps the same projection and the listing rule', async () => {
    fakeSupabase.state.failures.push({ when: (q) => q.table === 'projects' && q.filters.includes('order=likes_count.desc'), error: { code: '42703', message: 'no likes_count' } });
    render(<PublicGallery onReadComic={() => undefined} />);
    await screen.findByRole('link', { name: 'Read The Lake' });
    const [failed, fallback] = fakeSupabase.queriesOn('projects');
    expect(fallback.columns).toBe(failed.columns);
    expect(fallback.filters).toEqual([...LISTING_FILTERS, 'order=created_at.desc', 'order=id.asc', 'range=0-47']);
  });
});

describe('a small Library looks deliberate', () => {
  it('one comic: the comic first, then the samples; no search, sort, filter, visible count or sign-in prompt', async () => {
    rows.value = [rows.value[0]];
    const onRequireAuth = vi.fn();
    const { container } = render(<PublicGallery onReadComic={vi.fn()} onBack={vi.fn()} onRequireAuth={onRequireAuth} />);
    await screen.findByRole('link', { name: 'Read The Lake' });
    expect(screen.getByRole('heading', { level: 1, name: 'Library' })).toBeInTheDocument();
    expect(screen.queryByRole('search')).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('button', { name: /Kids-friendly/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /sign in|log in|back home/i })).toBeNull();
    // The count is still announced to a screen reader, but not shown.
    expect(screen.getByRole('status')).toHaveTextContent(/^1 comic$/);
    expect(screen.getByRole('status')).toHaveClass('sr-only');
    // Real comics come before the two short samples.
    const comics = screen.getByRole('region', { name: 'New comics' });
    const samples = screen.getByRole('region', { name: 'Studio samples' });
    expect(comics.compareDocumentPosition(samples) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A visitor sees likes, but no button that leads to a sign-in page.
    const card = screen.getByTestId('gallery-card');
    expect(within(card).queryByRole('button')).toBeNull();
    expect(within(card).getByText('Likes:')).toBeInTheDocument();
    // A zero read count is left out (current-studio reads are counted with the publication, not on the row).
    expect(within(card).queryByText('Views:')).toBeNull();
    expect(onRequireAuth).not.toHaveBeenCalled();
    // No maker stand-in ("by user-…") under the title.
    expect(card.textContent).not.toMatch(/\bby\b|user-/);
    expect(container.innerHTML).not.toMatch(/border-black|shadow-comic|font-comic|(?<![\w-])font-display|brand-(?:yellow|blue|red)|bg-slate-50|text-white|orange|#[0-9a-f]{6}\b/i);
  });

  it('one or two comics read as wide cards like the samples (cover, title, date, a read link), never a near-empty row', async () => {
    for (const count of [1, 2]) {
      fakeSupabase.reset();
      rows.value = manyRows(count);
      const view = render(<PublicGallery onReadComic={vi.fn()} />);
      await screen.findByText('Story 000');
      const list = screen.getByRole('list');
      expect(list).toHaveAttribute('data-layout', 'few');
      const cards = screen.getAllByTestId('gallery-card');
      expect(cards).toHaveLength(count);
      for (const card of cards) {
        expect(card).toHaveAttribute('data-layout', 'wide');
        // One link per card, holding the cover and saying where it goes, with the date and likes beside it.
        const link = within(card).getByRole('link', { name: /^Read Story/ });
        expect(link.querySelector('img')).not.toBeNull();
        expect(within(link).getByText('Read comic')).toBeInTheDocument();
        expect(within(card).getByText('Likes:')).toBeInTheDocument();
        expect(within(card).getByText(/\d{4}/)).toBeInTheDocument();
      }
      view.unmount();
    }
  });

  it('three comics or more keep the cover grid', async () => {
    rows.value = manyRows(3);
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByText('Story 000');
    expect(screen.getByRole('list')).not.toHaveAttribute('data-layout');
    for (const card of screen.getAllByTestId('gallery-card')) expect(card).not.toHaveAttribute('data-layout');
  });

  it('an empty Library shows no comics section, no "0 comics" and no empty shelf: just the samples', async () => {
    rows.value = [rows.value[2]];
    render(<PublicGallery onReadComic={vi.fn()} />);
    await waitFor(() => expect(fakeSupabase.queriesOn('projects')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'New comics' })).toBeNull());
    expect(screen.queryByText(/0 comics/)).toBeNull();
    expect(screen.queryByRole('heading', { level: 3, name: /next story|No matching/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Read The Paper Boat' })).toBeInTheDocument();
  });

  it(`up to the threshold (${6}) the tools stay hidden; above it they appear with the visible count`, async () => {
    expect(LIBRARY_TOOLS_MIN).toBe(6);
    rows.value = manyRows(LIBRARY_TOOLS_MIN);
    const first = render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByText('Story 000');
    expect(screen.queryByRole('search')).toBeNull();
    first.unmount();
    fakeSupabase.reset();
    rows.value = manyRows(LIBRARY_TOOLS_MIN + 1);
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByText('Story 000');
    expect(await screen.findByRole('searchbox', { name: 'Search comic titles' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Sort the Library' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/^7 comics$/);
    expect(screen.getByRole('status')).not.toHaveClass('sr-only');
    // There is no creator search: makers' names are not public.
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

describe('Library discovery and recovery', { timeout: 15000 }, () => {
  it('searches titles beyond the first page and keeps the listing rule on the search', async () => {
    rows.value = manyRows(65);
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByText('Story 000');
    expect(screen.queryByText('Story 064')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('65 comics');
    submitSearch('Story 064');
    expect(await screen.findByText('Story 064')).toBeInTheDocument();
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(1);
    const searched = fakeSupabase.queriesOn('projects').at(-1)!;
    expect(searched.filters).toEqual(expect.arrayContaining([...LISTING_FILTERS, 'name=ilike.%Story 064%', 'range=0-47']));
    expect(screen.getByRole('status')).toHaveTextContent('1 comic for “Story 064”');
  });

  it('loads the next stable page once, preserves existing cards, and focuses its first comic', async () => {
    rows.value = manyRows(65).reverse();
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByText('Story 000');
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(48);
    expect(screen.getByText('Showing 48 of 65 comics.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more comics' }));
    const next = (await screen.findByText('Story 048')).closest('a');
    await waitFor(() => expect(next).toHaveFocus());
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(65);
    expect(screen.queryByRole('button', { name: 'Load more comics' })).toBeNull();
    const later = fakeSupabase.queriesOn('projects').at(-1)!;
    expect(later.filters).toEqual(expect.arrayContaining([...LISTING_FILTERS, 'order=likes_count.desc', 'order=id.asc', 'range=48-95']));
    expect(later.count).toBeUndefined();
  });

  it('filters kids-friendly comics in the query and on the client', async () => {
    rows.value = [...manyRows(8), listed(90, 'Safe Story', { content_rating: 'G' }), listed(91, 'Older Teen', { content_rating: 'PG-13' })];
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByText('Story 000');
    const toggle = await screen.findByRole('button', { name: /Kids-friendly \(G\/PG\)/ });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByRole('link', { name: 'Read Safe Story' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Read Older Teen' })).toBeNull());
    expect(fakeSupabase.queriesOn('projects').at(-1)?.filters).toContain('content_rating=in.(G,PG)');
  });

  it('says so when no comic is kids-friendly yet, and the tools stay while filtering', async () => {
    rows.value = Array.from({ length: 8 }, (_, i) => listed(i, `Teen ${i}`, { content_rating: 'PG-13' }));
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByText('Teen 0');
    fireEvent.click(await screen.findByRole('button', { name: /Kids-friendly/ }));
    expect(await screen.findByText('No kids-friendly comics yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Kids-friendly/ })).toBeInTheDocument();
  });

  it('treats wildcard punctuation as literal text', async () => {
    rows.value = [...manyRows(7), listed(80, '100%_done'), listed(81, '100 percent done')];
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByRole('link', { name: 'Read 100%_done' });
    submitSearch('%_');
    expect(await screen.findByRole('link', { name: 'Read 100%_done' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Read 100 percent done' })).toBeNull());
  });

  it('reports a failed first request with retry instead of an empty collection', async () => {
    fakeSupabase.state.failures.push({ when: (q) => q.table === 'projects', error: { code: '503', message: 'Unavailable' } });
    render(<PublicGallery onReadComic={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The Library could not be loaded.');
    expect(fakeSupabase.queriesOn('projects')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Read The Lake' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('preserves the first page when loading more fails, then retries the same range', async () => {
    rows.value = manyRows(65);
    fakeSupabase.state.failures.push({ when: (q) => q.filters.includes('range=48-95'), error: { code: '503', message: 'Unavailable' } });
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByText('Story 000');
    fireEvent.click(screen.getByRole('button', { name: 'Load more comics' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your place is saved.');
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(48);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Story 064');
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(65);
  });

  it('does not replace a newer search with an older slow result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fakeSupabase.state.gates.push({ when: (q) => q.filters.includes('name=ilike.%Slow%'), release: gate });
    rows.value = [...manyRows(7), listed(70, 'Slow Story'), listed(71, 'The Lake')];
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByRole('link', { name: 'Read The Lake' });
    submitSearch('Slow');
    await waitFor(() => expect(fakeSupabase.queriesOn('projects').some((q) => q.filters.includes('name=ilike.%Slow%'))).toBe(true));
    submitSearch('Lake');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Read Story 000' })).toBeNull());
    await act(async () => { release(); await gate; });
    expect(screen.getByRole('link', { name: 'Read The Lake' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Read Slow Story' })).toBeNull();
  });

  it('distinguishes a search with no matches and clears it without leaving the Library', async () => {
    rows.value = manyRows(7);
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByText('Story 000');
    submitSearch('Does not exist');
    expect(await screen.findByRole('heading', { name: 'No matching comics.' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]);
    expect(await screen.findByText('Story 000')).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });
});

describe('Library sample reading', () => {
  it('opens the selected story at a real URL, turns a page and restores focus to its card', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByText('The Lake');
    const card = screen.getByRole('link', { name: 'Read The Paper Boat' });
    expect(card).toHaveAttribute('href', '/?view=gallery&sample=paper-boat');
    fireEvent.click(card);
    expect(screen.getByRole('heading', { name: 'The Paper Boat', level: 1 })).toHaveFocus();
    expect(window.location.search).toBe('?view=gallery&sample=paper-boat');
    fireEvent.click(screen.getByRole('button', { name: 'Next sample page' }));
    expect(screen.getAllByRole('status').some((el) => /Page 2 of 2/.test(el.textContent ?? ''))).toBe(true);
    fireEvent.click(screen.getByRole('link', { name: 'Back to Library' }));
    await waitFor(() => expect(card).toHaveFocus());
    expect(window.location.search).toBe('?view=gallery');
    expect(screen.getByRole('link', { name: 'Read The Lake' })).toBeInTheDocument();
  });

  it('restores accepted sample deep links and handles browser navigation back to the shelf', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    window.history.replaceState({}, '', '/?view=gallery&sample=last-tram');
    render(<PublicGallery onReadComic={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'The Last Tram', level: 1 })).toHaveFocus();
    act(() => {
      window.history.replaceState({}, '', '/?view=gallery');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    const title = screen.getByRole('heading', { name: 'Library', level: 1 });
    await waitFor(() => expect(title).toHaveFocus());
    await screen.findByText('The Lake');
  });

  it('ignores an unknown sample id and keeps the Library usable', async () => {
    window.history.replaceState({}, '', '/?view=gallery&sample=unknown');
    render(<PublicGallery onReadComic={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Library', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Back to Library' })).toBeNull();
    await screen.findByText('The Lake');
  });
});

describe('Library discovery from real listed publications', () => {
  const seedSlug = 'Slug0000000000001';
  const setLibrary = () => {
    rows.value = Array.from({length:8}, (_,i)=>listed(i, ['Harbor','Star Route','Cold Horizon','Foxtail','Garden Wall','Bookbinder','Sky Pier','Kitchen Table'][i],{user_id:'author-'+i}));
    (rows.value[1].state as Record<string,unknown>).overview = 'An astronomer spots starships in orbit.';
    (rows.value[2].state as Record<string,unknown>).overview = 'Two starships rendezvous in orbit.';
  };
  it('opens a real page deep link, explains its related pick and removes both when history is cleared',async()=>{
    setLibrary();
    rememberLibraryPage(null,{slug:seedSlug,visibility:'public'},3,6);
    render(<PublicGallery onReadComic={vi.fn()}/>);
    const resume = await screen.findByRole('link',{name:'Continue Star Route from page 3'});
    expect(resume).toHaveAttribute('href','/c/'+seedSlug+'?p=3');
    const recommendation = screen.getByText('Because you read “Star Route”').closest('li')!;
    expect(within(recommendation).getByRole('link',{name:'Read Cold Horizon'})).toHaveAttribute('href','/c/Slug0000000000002');
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(8);
    fireEvent.click(screen.getByRole('button',{name:'Clear reading history'}));
    expect(screen.queryByText('Because you read “Star Route”')).toBeNull();
    expect(libraryReads(null)).toHaveLength(0);
  });
  it('ranks after a real like, then discards that member’s recommendations when another account opens the library', async()=>{
    setLibrary();viewer.id='member-a';
    const current=render(<PublicGallery onReadComic={vi.fn()}/>);
    fireEvent.click(await screen.findByRole('button',{name:/^Like Star Route/}));
    expect(await screen.findByText('Because you liked “Star Route”')).toBeVisible();
    expect(db.toggleProjectLike).toHaveBeenCalledWith('comic-001','author-1','member-a');
    viewer.id='member-b';current.rerender(<PublicGallery onReadComic={vi.fn()}/>);
    await screen.findByRole('link',{name:'Read Star Route'});
    expect(screen.queryByText('Because you liked “Star Route”')).toBeNull();
  });
  it('checks older reads against current listing rules without exposing a removed or held publication',async()=>{
    rows.value=manyRows(60);
    const older=rows.value[55].state as Record<string,string>;
    const held=rows.value[56].state as Record<string,string>;
    const unlisted=rows.value[57].state as Record<string,string>;
    rows.value[56].is_forced_private=true;
    rows.value[57].is_public=false;
    const gone='Deleted1234567890';
    for (const slug of [older.shareSlug,held.shareSlug,unlisted.shareSlug,gone]) rememberLibraryPage(null,{slug,visibility:'public'},2,8);
    render(<PublicGallery onReadComic={vi.fn()}/>);
    expect(await screen.findByRole('link',{name:'Continue Story 055 from page 2'})).toHaveAttribute('href','/c/'+older.shareSlug+'?p=2');
    expect(screen.queryByText('Story 056')).toBeNull();
    expect(screen.queryByText('Story 057')).toBeNull();
    expect(document.body.textContent).not.toContain(gone);
    const historyQuery=fakeSupabase.queriesOn('projects').find(q=>q.filters.some(f=>f.startsWith('state->>shareSlug=in.')));
    expect(historyQuery?.filters).toEqual(expect.arrayContaining(LISTING_FILTERS));
  });
});
