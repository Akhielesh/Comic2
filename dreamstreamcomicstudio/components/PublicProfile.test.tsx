// Public profile (gate S4 parity with PublicGallery): a published Comic Studio (v4) comic opens its
// read-only share link /c/<slug> and shows ONLY its public cover (the frozen pub/ copy) — never an
// owner-written cover, panel or style URL, and no draft image id is ever signed for it. Classic comics
// keep their covers and the in-app reader.
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';

const SLUG = 'AbCdEfGhIjKlMnOpQ';
const KEY = 'A'.repeat(22);
const projects = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('../services/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
    storage: { from: (bucket: string) => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://sb.test/storage/v1/object/public/${bucket}/${p}` } }) }) }
  }
}));
vi.mock('../services/db', () => ({
  getImageUrl: vi.fn(async (id: string) => `https://signed.test/${id}`),
  getProfileByUsername: vi.fn(async () => ({ id: 'u1', username: 'mira', avatar_url: null, bio: 'Draws lakes.' })),
  getPublicProjectsByUser: vi.fn(async () => projects.value),
  isFollowing: vi.fn(async () => false),
  followUser: vi.fn(async () => true),
  unfollowUser: vi.fn(async () => true),
  getFollowersCount: vi.fn(async () => 2)
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
// The first candidate SmartImage would try (it preloads before painting), plus the fallbacks it
// would walk to when that fails.
vi.mock('./common/SmartImage', () => ({
  SmartImage: ({ src, alt, fallbackSources }: { src?: string; alt?: string; fallbackSources?: string[] }) => (
    <img src={src} alt={alt} data-fallbacks={(fallbackSources || []).join(' ')} />
  )
}));

const { PublicProfile, coverCandidates } = await import('./PublicProfile');
const db = await import('../services/db');

const project = (id: string, name: string, state: Record<string, unknown>, extra: Partial<Project> = {}): Project => ({
  id,
  name,
  createdAt: Date.parse('2026-10-01T00:00:00Z'),
  updatedAt: Date.parse('2026-10-02T00:00:00Z'),
  isPublic: true,
  userId: 'u1',
  state: { panels: [], styleVariants: [], ...state } as unknown as Project['state'],
  ...extra
});

/** What an owner can write on a v4 listing row (none of it went through the publish gate). */
const ownerWritten = {
  coverImageUrl: 'https://evil.test/c.jpg',
  coverImageId: 'u/u1/p/v4/img/draft.webp',
  panels: [{ id: 'p', imageUrl: 'https://evil.test/p.jpg' }, { id: 'q', imageId: 'u/u1/p/v4/img/q.webp' }],
  styleVariants: [{ id: 's', imageUrl: 'https://evil.test/s.jpg' }]
};

beforeEach(() => {
  projects.value = [
    project('v4-1', 'The Lake', { studioVersion: 4, shareSlug: SLUG, publicCover: `pub/${KEY}/cover-1080.webp`, ...ownerWritten }, { coverImage: 'https://evil.test/x.jpg' }),
    project('v4-2', 'No Cover Yet', { studioVersion: 4, shareSlug: 'BbCdEfGhIjKlMnOpQ', ...ownerWritten }, { coverImage: 'https://evil.test/x.jpg' }),
    project('classic-1', 'Old Classic', { coverImageId: 'img-classic-1', panels: [{ id: 'p', imageUrl: 'https://cdn.test/classic-p1.png' }] })
  ];
});
afterEach(() => vi.clearAllMocks());

const coverOf = (link: HTMLElement) => {
  const img = link.querySelector('img');
  return { src: img?.getAttribute('src') ?? null, fallbacks: img?.getAttribute('data-fallbacks') ?? '' };
};

describe('coverCandidates', () => {
  it('a v4 comic yields only its public cover — none of the owner-written fallbacks', () => {
    expect(coverCandidates(projects.value[0] as Project)).toEqual([`https://sb.test/storage/v1/object/public/comic-assets/pub/${KEY}/cover-1080.webp`]);
    expect(coverCandidates(projects.value[1] as Project)).toEqual([]);
  });

  it('a classic comic keeps the stored cover → first page → style board chain', () => {
    expect(coverCandidates(project('c', 'c', { coverImageUrl: 'https://cdn.test/c.png', panels: [{ id: 'p', imageUrl: 'https://cdn.test/p.png' }] }, { coverImage: 'https://cdn.test/stored.png' }))).toEqual([
      'https://cdn.test/stored.png',
      'https://cdn.test/c.png',
      'https://cdn.test/p.png'
    ]);
  });
});

describe('PublicProfile — released comics', () => {
  it('a published v4 comic links to its share page with the public cover, and nothing of the owner’s is shown or signed', async () => {
    render(<PublicProfile username="mira" onNavigate={vi.fn()} />);
    const lake = await screen.findByRole('link', { name: 'Read The Lake' });
    expect(lake).toHaveAttribute('href', `/c/${SLUG}`);
    expect(coverOf(lake).src).toBe(`https://sb.test/storage/v1/object/public/comic-assets/pub/${KEY}/cover-1080.webp`);
    const noCover = screen.getByRole('link', { name: 'Read No Cover Yet' });
    expect(noCover).toHaveAttribute('href', '/c/BbCdEfGhIjKlMnOpQ');
    expect(coverOf(noCover).src).toBeNull();
    const seen = [lake, noCover].map((a) => `${coverOf(a).src ?? ''} ${coverOf(a).fallbacks}`).join(' ');
    expect(seen).not.toContain('evil.test');
    expect(seen).not.toContain('signed.test');
    // Only the classic comic's draft id is signed; the v4 rows' ids (drafts) never are.
    expect(db.getImageUrl).toHaveBeenCalledTimes(1);
    expect(db.getImageUrl).toHaveBeenCalledWith('img-classic-1', expect.anything());
  });

  it('a classic comic keeps the in-app reader (with a real href for a new tab) and its signed cover', async () => {
    const onNavigate = vi.fn();
    render(<PublicProfile username="mira" onNavigate={onNavigate} />);
    const classic = await screen.findByRole('link', { name: 'Read Old Classic' });
    expect(classic).toHaveAttribute('href', '/?view=read&id=classic-1');
    expect(coverOf(classic).src).toBe('https://signed.test/img-classic-1');
    expect(coverOf(classic).fallbacks).toContain('https://cdn.test/classic-p1.png');
    fireEvent.click(classic);
    expect(onNavigate).toHaveBeenCalledWith('reader', 'classic-1');
    // A published v4 comic is a real page load: no in-app navigation is wired to it.
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('a v4 row that is not a real publication (no slug) opens in-app and still shows no owner-written cover', async () => {
    projects.value = [project('v4-x', 'Flipped', { studioVersion: 4, ...ownerWritten }, { coverImage: 'https://evil.test/x.jpg' })];
    const onNavigate = vi.fn();
    render(<PublicProfile username="mira" onNavigate={onNavigate} />);
    const flipped = await screen.findByRole('link', { name: 'Read Flipped' });
    expect(flipped).toHaveAttribute('href', '/?view=read&id=v4-x');
    expect(coverOf(flipped).src).toBeNull();
    expect(coverOf(flipped).fallbacks).toBe('');
    expect(db.getImageUrl).not.toHaveBeenCalled();
    fireEvent.click(flipped);
    expect(onNavigate).toHaveBeenCalledWith('reader', 'v4-x');
  });
});
