// Public gallery (sharing.md §5.5): published v4 comics open their read-only share link /c/<slug> with
// the public cover; the publish gate's rating shows as a badge; "Kids-friendly (G/PG)" keeps only G and
// PG comics (an unrated comic is never assumed kids-friendly). Classic comics keep the in-app reader.
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SLUG = 'AbCdEfGhIjKlMnOpQ';
const KEY = 'A'.repeat(22);
const rows = vi.hoisted(() => ({ value: [] as Record<string, unknown>[] }));

vi.mock('../services/supabase', () => {
  const query: Record<string, unknown> = {};
  query.select = () => query;
  query.eq = () => query;
  query.order = () => Promise.resolve({ data: rows.value, error: null });
  query.in = () => Promise.resolve({ data: [{ id: 'u1', username: 'mira' }], error: null });
  return {
    supabase: {
      from: () => query,
      storage: { from: (bucket: string) => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://sb.test/storage/v1/object/public/${bucket}/${p}` } }) }) }
    }
  };
});
vi.mock('../services/db', () => ({
  getImageUrl: vi.fn(async () => undefined),
  getProjectLikeMap: vi.fn(async () => ({})),
  toggleProjectLike: vi.fn(async () => ({ liked: true }))
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
// The first candidate SmartImage would try (it preloads before painting).
vi.mock('./common/SmartImage', () => ({ SmartImage: ({ src, alt }: { src?: string; alt?: string }) => <img src={src} alt={alt} /> }));

const { PublicGallery, shareSlugOf, publicCoverUrl, isKidsFriendly } = await import('./PublicGallery');

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
    expect(screen.getByRole('link', { name: 'Read The Lake' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Read Night Raid' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Read Old Classic' })).toBeNull();
  });

  it('says so when no comic is kids-friendly yet', async () => {
    rows.value = [rows.value[1]];
    render(<PublicGallery onReadComic={() => undefined} onBack={() => undefined} />);
    await screen.findByRole('link', { name: 'Read Night Raid' });
    fireEvent.click(screen.getByRole('button', { name: /Kids-friendly/ }));
    expect(screen.getByText('No kids-friendly comics yet.')).toBeInTheDocument();
  });
});
