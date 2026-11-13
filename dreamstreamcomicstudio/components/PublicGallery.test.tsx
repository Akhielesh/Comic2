// Public gallery (sharing.md §5.5): published v4 comics open their read-only share link /c/<slug> with
// the public cover; the publish gate's rating shows as a badge; "Kids-friendly (G/PG)" keeps only G and
// PG comics (an unrated comic is never assumed kids-friendly). Classic comics keep the in-app reader.
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
// The first candidate SmartImage would try (it preloads before painting), plus the fallbacks it
// would walk to when that fails.
vi.mock('./common/SmartImage', () => ({
  SmartImage: ({ src, alt, fallbackSources }: { src?: string; alt?: string; fallbackSources?: string[] }) => (
    <img src={src} alt={alt} data-fallbacks={(fallbackSources || []).join(' ')} />
  )
}));

const { PublicGallery, shareSlugOf, publicCoverUrl, isKidsFriendly } = await import('./PublicGallery');
const db = await import('../services/db');

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

describe('PublicGallery', () => {
  it('links published v4 comics to their share page with the public cover and rating', async () => {
    const onReadComic = vi.fn();
    render(<PublicGallery onReadComic={onReadComic} onBack={() => undefined} />);
    const lake = await screen.findByRole('link', { name: 'Read The Lake' });
    expect(lake).toHaveAttribute('href', `/c/${SLUG}`);
    expect(lake.querySelector('img')?.getAttribute('src')).toBe(`https://sb.test/storage/v1/object/public/comic-assets/pub/${KEY}/cover-1080.webp`);
    expect(screen.getByRole('img', { name: 'Rated PG' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Rated PG-13' })).toBeInTheDocument();
    // Classic comics still open the in-app reader (and keep a real href for a new tab).
    const classic = screen.getByRole('link', { name: 'Read Old Classic' });
    expect(classic).toHaveAttribute('href', '/?view=read&id=classic-1');
    fireEvent.click(classic);
    expect(onReadComic).toHaveBeenCalledWith('classic-1');
  });

  it('filters to kids-friendly (G/PG) comics, never assuming an unrated one is', async () => {
    render(<PublicGallery onReadComic={() => undefined} onBack={() => undefined} />);
    await screen.findByRole('link', { name: 'Read The Lake' });
    const toggle = screen.getByRole('button', { name: /Kids-friendly \(G\/PG\)/ });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByRole('link', { name: 'Read The Lake' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Read Night Raid' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Read Old Classic' })).toBeNull();
  });

  it('never lists a comic held by moderation', async () => {
    rows.value = [...rows.value, row('held', 'Held Comic', { studioVersion: 4, shareSlug: 'CbCdEfGhIjKlMnOpQ', publicCover: `pub/${KEY}/cover.webp` }, { content_rating: 'G', is_forced_private: true })];
    render(<PublicGallery onReadComic={() => undefined} onBack={() => undefined} />);
    await screen.findByRole('link', { name: 'Read The Lake' });
    expect(screen.queryByRole('link', { name: 'Read Held Comic' })).toBeNull();
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(3);
  });

  it('a rated row that is not a published v4 listing shows no rating and is not kids-friendly', async () => {
    // An owner flipped the studio marker and swapped the classic cover fields on a rated row.
    rows.value = [
      row('evil', 'Evil', { studioVersion: 3, shareSlug: SLUG, panels: [{ id: 'p', imageUrl: 'https://evil.test/p.jpg' }] }, { content_rating: 'G', cover_image_url: 'https://evil.test/x.jpg' }),
      rows.value[0]
    ];
    render(<PublicGallery onReadComic={() => undefined} onBack={() => undefined} />);
    const evil = await screen.findByRole('link', { name: 'Read Evil' });
    // Treated like any classic comic: the in-app reader, never the share page, never a badge.
    expect(evil).toHaveAttribute('href', '/?view=read&id=evil');
    expect(evil.querySelector('[aria-label^="Rated"]')).toBeNull();
    expect(screen.getAllByRole('img', { name: /^Rated / }).map((el) => el.getAttribute('aria-label'))).toEqual(['Rated PG']);
    fireEvent.click(screen.getByRole('button', { name: /Kids-friendly/ }));
    expect(await screen.findByRole('link', { name: 'Read The Lake' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Read Evil' })).toBeNull();
  });

  it('a v4 listing never shows an owner-written cover (first or fallback), and signs no draft', async () => {
    const owner = { coverImageUrl: 'https://evil.test/c.jpg', coverImageId: 'u/u1/p/v4/img/draft.webp', panels: [{ id: 'p', imageUrl: 'https://evil.test/p.jpg' }, { id: 'q', imageId: 'u/u1/p/v4/img/q.webp' }], styleVariants: [{ id: 's', imageUrl: 'https://evil.test/s.jpg' }] };
    rows.value = [
      row('v4-a', 'No Cover Yet', { studioVersion: 4, shareSlug: 'BbCdEfGhIjKlMnOpQ', ...owner }, { content_rating: 'G', cover_image_url: 'https://evil.test/x.jpg' }),
      row('v4-b', 'With Cover', { studioVersion: 4, shareSlug: SLUG, publicCover: `pub/${KEY}/cover-1080.webp`, ...owner }, { content_rating: 'PG', cover_image_url: 'https://evil.test/x.jpg' })
    ];
    render(<PublicGallery onReadComic={() => undefined} onBack={() => undefined} />);
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
    // Both are real publications: their badges stay.
    expect(screen.getByRole('img', { name: 'Rated G' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Rated PG' })).toBeInTheDocument();
  });

  it('says so when no comic is kids-friendly yet', async () => {
    rows.value = [rows.value[1]];
    render(<PublicGallery onReadComic={() => undefined} onBack={() => undefined} />);
    await screen.findByRole('link', { name: 'Read Night Raid' });
    fireEvent.click(screen.getByRole('button', { name: /Kids-friendly/ }));
    expect(await screen.findByText('No kids-friendly comics yet.')).toBeInTheDocument();
  });
});

// EGRESS-DB E3: the gallery reads cards (the columns and state keys a card reads), never a comic's whole state, and
// asks the database to leave out held comics; the client still drops one that slips through.
describe('PublicGallery reads cards', () => {
  const VERSIONS = Array.from({ length: 5 }, (_, i) => ({ id: `v${i}`, state: { script: 'draft '.repeat(2_000) } }));
  const galleryQueries = () => fakeSupabase.queriesOn('projects');

  it('selects no `*`, no bare `state` and no `versions`, unheld public comics only, one page at a time', async () => {
    rows.value = [...rows.value, row('big', 'Big Classic', { coverImageUrl: 'https://cdn.test/big.png', versions: VERSIONS, script: 'x'.repeat(10_000) })];
    render(<PublicGallery onReadComic={() => undefined} onBack={() => undefined} />);
    await screen.findByRole('link', { name: 'Read Big Classic' });
    const [query] = galleryQueries();
    const items = query.columns.split(',');
    expect(items).not.toContain('*');
    expect(items).not.toContain('state');
    expect(query.columns).not.toMatch(/versions|script/);
    for (const item of items) if (columnsRead(item)[0] === 'state') expect(item).toMatch(/^[A-Za-z]+:state->[A-Za-z]+$/);
    expect(query.filters).toEqual(['is_public=eq.true', 'is_forced_private=not.is.true', 'order=likes_count.desc', 'order=id.asc', 'range=0-47']);
    // The rows on the wire are cards: a small fraction of the full rows.
    const shipped = rows.value.map((r) => projectRow(r, query.columns));
    expect(JSON.stringify(shipped)).not.toContain('draft draft');
    expect(jsonBytes(shipped)).toBeLessThan(jsonBytes(rows.value) / 10);
  });

  it('the trending fallback and the recent tab keep the same projection', async () => {
    fakeSupabase.state.failures.push({ when: (q) => q.table === 'projects' && q.filters.includes('order=likes_count.desc'), error: { code: '42703', message: 'no likes_count' } });
    render(<PublicGallery onReadComic={() => undefined} onBack={() => undefined} />);
    await screen.findByRole('link', { name: 'Read The Lake' });
    const [failed, fallback] = galleryQueries();
    expect(fallback.columns).toBe(failed.columns);
    expect(fallback.filters).toEqual(['is_public=eq.true', 'is_forced_private=not.is.true', 'order=created_at.desc', 'order=id.asc', 'range=0-47']);
  });

  it('still drops a held comic the database returned (defence in depth)', async () => {
    fakeSupabase.state.ignoredFilterColumns = new Set(['is_forced_private']);
    rows.value = [...rows.value, row('held', 'Held Comic', { coverImageUrl: 'https://cdn.test/held.png' }, { is_forced_private: true })];
    render(<PublicGallery onReadComic={() => undefined} onBack={() => undefined} />);
    await screen.findByRole('link', { name: 'Read The Lake' });
    expect(screen.queryByRole('link', { name: 'Read Held Comic' })).toBeNull();
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(3);
  });

  it('a classic card falls back to its first panel or style preview, signing ids from the projected fields', async () => {
    rows.value = [
      row('panel', 'Panel Only', { panels: [{ id: 'p', imageUrl: 'https://cdn.test/panel.png' }], styleVariants: [{ id: 's', imageUrl: 'https://cdn.test/style.png' }], versions: VERSIONS }),
      row('style', 'Style Only', { styleVariants: [{ id: 's', imageUrl: 'https://cdn.test/style-only.png' }] }),
      row('ids', 'Ids Only', { coverImageId: 'u1/cover.png', panels: [{ id: 'q', imageId: 'u1/q.png' }] })
    ];
    vi.mocked(db.getImageUrl).mockImplementation(async (id: string) => `https://signed.test/${id}`);
    render(<PublicGallery onReadComic={() => undefined} onBack={() => undefined} />);
    const panel = await screen.findByRole('link', { name: 'Read Panel Only' });
    expect(panel.querySelector('img')?.getAttribute('src')).toBe('https://cdn.test/panel.png');
    expect(panel.querySelector('img')?.getAttribute('data-fallbacks')).toContain('https://cdn.test/style.png');
    expect(screen.getByRole('link', { name: 'Read Style Only' }).querySelector('img')?.getAttribute('src')).toBe('https://cdn.test/style-only.png');
    const ids = screen.getByRole('link', { name: 'Read Ids Only' });
    expect(ids.querySelector('img')?.getAttribute('src')).toBe('https://signed.test/u1/cover.png');
    expect(ids.querySelector('img')?.getAttribute('data-fallbacks')).toContain('https://signed.test/u1/q.png');
    expect(db.getImageUrl).toHaveBeenCalledWith('u1/cover.png', expect.anything());
  });
});

describe('PublicGallery on the Atlas tokens', () => {
  it('signed out: a calm sign-in note (an outline "Sign in", no yellow "Log In"), no Back button of its own, the display title', async () => {
    const onRequireAuth = vi.fn();
    const { container } = render(<PublicGallery onReadComic={vi.fn()} onBack={vi.fn()} onRequireAuth={onRequireAuth} />);
    await screen.findByRole('link', { name: 'Read The Lake' });
    expect(screen.getByRole('heading', { level: 1, name: 'Library' })).toBeInTheDocument();
    const signIn = screen.getByRole('button', { name: 'Sign in' });
    expect(signIn).toHaveAttribute('data-variant', 'outline');
    fireEvent.click(signIn);
    expect(onRequireAuth).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /log in|back home/i })).toBeNull();
    expect(container.innerHTML).not.toMatch(/border-black|shadow-comic|font-comic|(?<![\w-])font-display|brand-(?:yellow|blue|red)|bg-slate-50|text-white|#[0-9a-f]{6}\b/i);
  });

  it('sorts with one segmented switch and filters with a pressed toggle; each card names its comic under the cover', async () => {
    render(<PublicGallery onReadComic={vi.fn()} onBack={vi.fn()} />);
    await screen.findByRole('link', { name: 'Read The Lake' });
    const sort = screen.getByRole('radiogroup', { name: 'Sort the Library' });
    expect(screen.getByRole('radio', { name: 'Trending' })).toHaveAttribute('aria-checked', 'true');
    expect(sort).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search comic titles' })).toBeInTheDocument();
    for (const card of screen.getAllByTestId('gallery-card')) expect(card.tagName).toBe('LI');
    expect(within(screen.getByRole('region', { name: 'From the community' })).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Old Classic', 'The Lake', 'Night Raid']);
  });

  it('says so in the shared empty state when nothing is listed', async () => {
    rows.value = [];
    render(<PublicGallery onReadComic={vi.fn()} onBack={vi.fn()} />);
    expect(await screen.findByRole('heading', { level: 3, name: 'The next story could be yours.' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('0 comics');
    expect(screen.getByRole('link', { name: 'Read The Paper Boat' })).toBeInTheDocument();
  });
});

describe('Library discovery and recovery', () => {
  const manyRows = (count: number) => Array.from({ length: count }, (_, index) => row(
    `comic-${String(index).padStart(3, '0')}`, `Story ${String(index).padStart(3, '0')}`,
    { coverImageUrl: 'https://cdn.test/cover.webp' }, { likes_count: 1 }
  ));
  const submitSearch = (value: string) => {
    fireEvent.change(screen.getByRole('searchbox'), { target: { value } });
    fireEvent.submit(screen.getByRole('search'));
  };

  it('searches titles beyond the first page and keeps the wire projection bounded', async () => {
    rows.value = manyRows(65);
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByText('Story 000');
    expect(screen.queryByText('Story 064')).toBeNull();
    submitSearch('Story 064');
    expect(await screen.findByText('Story 064')).toBeInTheDocument();
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(1);
    const searched = fakeSupabase.queriesOn('projects').at(-1)!;
    expect(searched.filters).toContain('name=ilike.%Story 064%');
    expect(searched.filters).toContain('range=0-47');
    expect(searched.columns).not.toMatch(/versions|script/);
  });

  it('loads the next stable page once, preserves existing cards, and focuses its first comic', async () => {
    rows.value = manyRows(65).reverse();
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByText('Story 000');
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(48);
    fireEvent.click(screen.getByRole('button', { name: 'Load more comics' }));
    const next = (await screen.findByText('Story 048')).closest('a');
    await waitFor(() => expect(next).toHaveFocus());
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(65);
    expect(screen.getByText('Story 000')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more comics' })).toBeNull();
    expect(fakeSupabase.queriesOn('projects').at(-1)?.filters).toEqual(expect.arrayContaining(['order=likes_count.desc', 'order=id.asc', 'range=48-95']));
  });

  it('filters kids-friendly comics across all pages, while retaining the publication gate', async () => {
    rows.value = [...manyRows(60), row('safe', 'Safe Story', { studioVersion: 4, shareSlug: SLUG }, { content_rating: 'G' }), row('fake-safe', 'Unpublished Rating', {}, { content_rating: 'G' })];
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByText('Story 000');
    fireEvent.click(screen.getByRole('button', { name: /Kids-friendly/ }));
    expect(await screen.findByRole('link', { name: 'Read Safe Story' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Read Unpublished Rating' })).toBeNull();
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(1);
    expect(fakeSupabase.queriesOn('projects').at(-1)?.filters).toContain('content_rating=in.(G,PG)');
  });

  it('uses exact creator handles and creator names open that creator’s complete shelf', async () => {
    rows.value = [...manyRows(50), row('other', 'Someone Else', {}, { user_id: 'u2' })];
    fakeSupabase.state.tables.profiles.push({ id: 'u2', username: 'mira2' });
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByText('Story 000');
    fireEvent.click(screen.getAllByText('by mira')[0]);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Search by' })).toHaveValue('creator'));
    await screen.findByText('Story 000');
    expect(screen.queryByText('Someone Else')).toBeNull();
    expect(fakeSupabase.queriesOn('profiles').some((q) => q.filters.includes('username=ilike.mira'))).toBe(true);
    submitSearch('@mira2');
    expect(await screen.findByText('Someone Else')).toBeInTheDocument();
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(1);
  });

  it('treats wildcard punctuation as literal text', async () => {
    rows.value = [row('literal', '100%_done', {}), row('other', '100 percent done', {})];
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByRole('link', { name: 'Read 100%_done' });
    submitSearch('%_');
    expect(await screen.findByRole('link', { name: 'Read 100%_done' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Read 100 percent done' })).toBeNull();
  });

  it('reports a failed first request with retry instead of an empty collection or silent sort fallback', async () => {
    fakeSupabase.state.failures.push({ when: (q) => q.table === 'projects', error: { code: '503', message: 'Unavailable' } });
    render(<PublicGallery onReadComic={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The community Library could not be loaded.');
    expect(screen.queryByText('The next story could be yours.')).toBeNull();
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
    expect(fakeSupabase.queriesOn('projects').slice(-2).every((q) => q.filters.includes('range=48-95'))).toBe(true);
  });

  it('does not replace a newer search with an older slow result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fakeSupabase.state.gates.push({ when: (q) => q.filters.includes('name=ilike.%Slow%'), release: gate });
    rows.value.push(row('slow', 'Slow Story', {}));
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByRole('link', { name: 'Read The Lake' });
    submitSearch('Slow');
    await waitFor(() => expect(fakeSupabase.queriesOn('projects').some((q) => q.filters.includes('name=ilike.%Slow%'))).toBe(true));
    submitSearch('Lake');
    await screen.findByRole('link', { name: 'Read The Lake' });
    await act(async () => { release(); await gate; });
    expect(screen.getByRole('link', { name: 'Read The Lake' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Read Slow Story' })).toBeNull();
  });

  it('makes each title and cover one native link and preserves modifier-click navigation', async () => {
    const onReadComic = vi.fn();
    render(<PublicGallery onReadComic={onReadComic} />);
    const classic = await screen.findByRole('link', { name: 'Read Old Classic' });
    expect(classic.querySelector('h3')).toHaveTextContent('Old Classic');
    fireEvent.click(classic, { ctrlKey: true });
    expect(onReadComic).not.toHaveBeenCalled();
    fireEvent.click(classic.querySelector('h3')!);
    expect(onReadComic).toHaveBeenCalledWith('classic-1');
  });

  it('distinguishes a search with no matches and clears it without leaving the Library', async () => {
    render(<PublicGallery onReadComic={vi.fn()} />);
    await screen.findByRole('link', { name: 'Read The Lake' });
    submitSearch('Does not exist');
    expect(await screen.findByRole('heading', { name: 'No matching comics.' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]);
    expect(await screen.findByRole('link', { name: 'Read The Lake' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });
});
