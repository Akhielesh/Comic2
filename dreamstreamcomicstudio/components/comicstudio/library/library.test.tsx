// Library client (assets.md §12/§15): the index hook never throws (failure → 'unavailable' and the
// procedural fallback), fetches once per page, sanitises URLs; LibraryImage layers the image over
// its fallback and drops back on error; the style_presets card runs the FREE use_preset action;
// the feature registers its card and the admin section.
import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryIndex } from '../../../shared/comic/library';
import { makeFakeStudio, makeSampleDoc } from '../conversation/testing/fixtures';
import { LibraryImage } from './LibraryImage';
import { StylePresetsCard, STYLE_PRESETS_FREE_NOTE } from './StylePresetsCard';
import { LIBRARY_CACHE_KEY, __resetComicLibraryForTests, libraryApi, loadComicLibrary, sanitizeIndex, useComicLibrary } from './useComicLibrary';
import { feature } from './index';

const asset = (id: string, over: Partial<LibraryIndex['assets'][number]> = {}): LibraryIndex['assets'][number] => ({
  id,
  kind: 'style_preview',
  presetId: id.replace(/^style\./, ''),
  theme: 'any',
  aspect: '4:5',
  w: 800,
  h: 1000,
  url: `https://cdn.test/library/v1/${id}/1.webp`,
  thumbs: { 320: `https://cdn.test/library/v1/${id}/1@320.webp`, 640: `https://cdn.test/library/v1/${id}/1@640.webp` },
  alt: `${id} sample`,
  tags: [],
  palette: ['#111111'],
  rev: 1,
  ...over
});

const INDEX: LibraryIndex = {
  manifestVersion: 1,
  generatedAt: 1,
  assets: [
    asset('style.noir-ink'),
    asset('empty.studio-hero.light', { kind: 'empty_state', theme: 'light', presetId: undefined }),
    asset('empty.cast', { kind: 'empty_state', theme: 'light', presetId: undefined })
  ]
};

const okFetch = (body: unknown = INDEX) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

beforeEach(() => {
  __resetComicLibraryForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  __resetComicLibraryForTests();
});

describe('useComicLibrary', () => {
  it('a failed fetch is "unavailable", never a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const { result } = renderHook(() => useComicLibrary());
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.preview('noir-ink')).toBeUndefined();
    expect(result.current.byKind('style_preview')).toEqual([]);
  });

  it('a 500 is "unavailable" too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const { result } = renderHook(() => useComicLibrary());
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
  });

  it('loads once per page (single flight), caches in sessionStorage, and answers lookups', async () => {
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);
    const a = renderHook(() => useComicLibrary());
    const b = renderHook(() => useComicLibrary());
    await waitFor(() => expect(a.result.current.status).toBe('ready'));
    expect(b.result.current.status).toBe('ready');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toContain('/api/comic/public/library');
    expect(((fetchSpy.mock.calls[0] as unknown[])[1] as RequestInit).credentials).toBe('omit');
    const lib = a.result.current;
    expect(lib.preview('noir-ink')?.id).toBe('style.noir-ink');
    expect(lib.byKind('empty_state', { theme: 'dark' }).map((x) => x.id)).toEqual([]);
    expect(lib.byKind('empty_state', { theme: 'light' })).toHaveLength(2);
    // dark → light fallback; aliases ("studio" → studio-hero)
    expect(lib.empty('studio', 'dark')?.id).toBe('empty.studio-hero.light');
    expect(lib.empty('cast', 'dark')?.id).toBe('empty.cast');
    expect(window.sessionStorage.getItem(LIBRARY_CACHE_KEY)).toContain('style.noir-ink');
    await loadComicLibrary();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sanitises the index: drops non-https and malformed assets', () => {
    const clean = sanitizeIndex({
      manifestVersion: 1,
      generatedAt: 0,
      assets: [
        asset('style.noir-ink'),
        asset('style.retro-pop', { url: 'javascript:alert(1)' }),
        asset('style.webtoon-cel', { url: 'http://evil.test/x.webp' }),
        asset('../bad'),
        asset('style.cozy-anime', { thumbs: { 320: 'data:image/svg+xml,<svg onload=alert(1)>' } })
      ]
    })!;
    expect(clean.assets.map((x) => x.id)).toEqual(['style.noir-ink', 'style.cozy-anime']);
    expect(clean.assets[1].thumbs[320]).toBeUndefined();
    expect(sanitizeIndex('nope')).toBeUndefined();
    expect(libraryApi({ status: 'idle', byId: new Map() }).get('x')).toBeUndefined();
  });
});

describe('LibraryImage', () => {
  it('renders only the fallback when the asset is not published (or the API is down)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 503 })));
    render(<LibraryImage id="style.noir-ink" fallback={<span>procedural</span>} />);
    expect(screen.getByText('procedural')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('img')).not.toBeInTheDocument());
  });

  it('fades the image in over its fallback, with srcset and size; drops back on error', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { container } = render(<LibraryImage id="style.noir-ink" sizes="120px" fallback={<span>procedural</span>} className="rounded-lg" />);
    const img = (await screen.findByRole('img')) as HTMLImageElement;
    expect(img).toHaveAttribute('alt', 'style.noir-ink sample');
    expect(img.getAttribute('srcset')).toContain('@320.webp 320w');
    expect(img.getAttribute('srcset')).toContain('1.webp 800w');
    expect(img).toHaveAttribute('width', '800');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img.className).toContain('opacity-0');
    expect(screen.getByText('procedural')).toBeVisible();
    act(() => {
      fireEvent.load(img);
    });
    expect(img.className).toContain('opacity-100');
    expect(container.querySelector('[aria-hidden="true"]')).toHaveClass('invisible');
    act(() => {
      fireEvent.error(img);
    });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('procedural')).toBeInTheDocument();
  });
});

describe('StylePresetsCard', () => {
  const card = { type: 'style_presets' as const, id: 'c1', presetIds: ['watercolor-storybook', 'cartoon-strip', 'nope'], note: 'Gentle looks for a bedtime story.' };

  it('shows the suggested presets with their art, marks it free, and runs use_preset on tap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 503 })));
    const doc = makeSampleDoc();
    doc.style = { status: 'empty', refs: [], options: [] };
    const studio = makeFakeStudio({ doc });
    render(<StylePresetsCard card={card} message={{ id: 'm', role: 'assistant', text: '', at: 0 }} studio={studio} />);
    expect(screen.getByText('Gentle looks for a bedtime story.')).toBeInTheDocument();
    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.getByText(STYLE_PRESETS_FREE_NOTE)).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2); // the unknown id is dropped
    expect(radios[0]).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(radios[0]);
    await waitFor(() => expect(studio.act).toHaveBeenCalledWith({ type: 'use_preset', presetId: 'watercolor-storybook' }));
    expect(document.querySelectorAll('[data-preset-thumb]')).toHaveLength(2);
  });

  it('shows the current preset as picked and does not re-run it', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 503 })));
    const doc = makeSampleDoc();
    doc.style = { ...doc.style, status: 'drafted', presetId: 'cartoon-strip' };
    const studio = makeFakeStudio({ doc });
    render(<StylePresetsCard card={card} message={{ id: 'm', role: 'assistant', text: '', at: 0 }} studio={studio} />);
    const picked = screen.getByRole('radio', { name: /Cartoon strip/ });
    expect(picked).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(picked);
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('is honest when none of its presets exist anymore', () => {
    const studio = makeFakeStudio();
    render(<StylePresetsCard card={{ ...card, presetIds: ['gone'] }} message={{ id: 'm', role: 'assistant', text: '', at: 0 }} studio={studio} />);
    expect(screen.getByText(/aren't available anymore/)).toBeInTheDocument();
  });
});

describe('feature registration', () => {
  it('registers the style_presets card and the admin Library section', () => {
    expect(feature.cards?.map((c) => c.type)).toEqual(['style_presets']);
    expect(feature.adminSections?.map((s) => [s.id, s.label])).toEqual([['library', 'Library']]);
  });
});
