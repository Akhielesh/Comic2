// Publish / share conversation cards (sharing.md §11 #35) and the public-reader hook.
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Card, Msg } from '../../../shared/comic/doc';
import { makeFakeStudio, makeSampleDoc } from '../conversation/testing/fixtures';
import { PublishCard } from './PublishCard';
import { ShareCardView } from './ShareCardView';
import { readShareBoot, usePublicComic } from './usePublicComic';
import { feature } from './index';

vi.mock('../studioApi', async (orig) => {
  const mod = await orig<typeof import('../studioApi')>();
  return { ...mod, loadPublicComicBySlug: vi.fn(), trackPublicEvent: vi.fn(async () => undefined) };
});
import * as api from '../studioApi';

type PublishCardData = Extract<Card, { type: 'publish' }>;
const msg: Msg = { id: 'm1', role: 'assistant', text: '', at: 1 };
const SLUG = 'Ab3dEf6hIj9kLm2nP';
const card = (over: Partial<PublishCardData> = {}): PublishCardData => ({ type: 'publish', id: 'c1', mode: 'publish', status: 'pending', request: { visibility: 'unlisted' }, ...over });

afterEach(() => vi.clearAllMocks());

describe('PublishCard', () => {
  it('registers the publish/share cards and the header slot', () => {
    expect(feature.cards?.map((c) => c.type)).toEqual(['publish', 'share']);
    expect(feature.headerSlots?.map((s) => s.id)).toEqual(['share']);
  });

  it('the Publish tap sends the publish action with the card id (the director never acts)', async () => {
    const studio = makeFakeStudio();
    render(<PublishCard card={card()} message={msg} studio={studio} />);
    expect(screen.getByText(/Publish “/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(studio.act).toHaveBeenCalledWith({ type: 'publish', cardId: 'c1', request: { visibility: 'unlisted' } }));
  });

  it('an Update card says honestly whether readers will see new edits', () => {
    const behind = makeFakeStudio({ publication: { behind: true } as never });
    const { unmount } = render(<PublishCard card={card({ mode: 'update' })} message={msg} studio={behind} />);
    expect(screen.getByText(/including any edits since you published/)).toBeInTheDocument();
    unmount();
    const same = makeFakeStudio({ publication: { behind: false } as never });
    render(<PublishCard card={card({ mode: 'update' })} message={msg} studio={same} />);
    expect(screen.getByText(/published pages stay the same/)).toBeInTheDocument();
  });

  it('Not now declines', async () => {
    const studio = makeFakeStudio();
    render(<PublishCard card={card()} message={msg} studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(studio.act).toHaveBeenCalledWith({ type: 'decline_publish', cardId: 'c1' }));
  });

  it('Unpublish needs two taps', async () => {
    const studio = makeFakeStudio();
    render(<PublishCard card={card({ mode: 'unpublish', request: undefined })} message={msg} studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }));
    expect(studio.act).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to confirm' }));
    await waitFor(() => expect(studio.act).toHaveBeenCalledWith({ type: 'unpublish', cardId: 'c1' }));
  });

  it('a failed card shows the reason and Retry, plus "Publish without page N" for safety blocks', async () => {
    const doc = makeSampleDoc();
    const studio = makeFakeStudio({ doc });
    const pageId = doc.pages[1].id;
    render(
      <PublishCard
        card={card({ status: 'failed', result: { error: "Page 2 doesn't fit the content rules.", blockers: [{ target: { kind: 'page', id: pageId }, status: 'blocked', categories: [] }] } })}
        message={msg}
        studio={studio}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent("Page 2 doesn't fit");
    fireEvent.click(screen.getByRole('button', { name: 'Publish without page 2' }));
    await waitFor(() => expect(studio.act).toHaveBeenCalledWith({ type: 'publish', cardId: 'c1', request: { visibility: 'unlisted', excludePageIds: [pageId] } }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(studio.act).toHaveBeenCalledTimes(2));
  });

  it('done shows the link with Copy / Share… / Open Share sheet; running shows honest progress', () => {
    const studio = makeFakeStudio();
    const { rerender } = render(<PublishCard card={card({ status: 'running' })} message={msg} studio={studio} />);
    expect(screen.getByRole('status')).toHaveTextContent('Publishing…');
    rerender(<PublishCard card={card({ status: 'done', result: { url: `https://comics.dreamstreamstudio.ai/c/${SLUG}` } })} message={msg} studio={studio} />);
    expect((screen.getByLabelText('Share link') as HTMLInputElement).value).toBe(`https://comics.dreamstreamstudio.ai/c/${SLUG}`);
    expect(screen.getByRole('button', { name: 'Open Share sheet' })).toBeInTheDocument();
  });
});

describe('ShareCardView', () => {
  it('shows the live link from the doc mirror, or an honest private note', () => {
    const doc = makeSampleDoc();
    doc.publication = { visibility: 'unlisted', status: 'live', slug: SLUG, publishedRev: 1, publishedAt: 1, languages: ['en'] };
    const { rerender } = render(<ShareCardView card={{ type: 'share', id: 's1' }} message={msg} studio={makeFakeStudio({ doc })} />);
    expect((screen.getByLabelText('Share link') as HTMLInputElement).value).toBe(`https://comics.dreamstreamstudio.ai/c/${SLUG}`);
    rerender(<ShareCardView card={{ type: 'share', id: 's1' }} message={msg} studio={makeFakeStudio()} />);
    expect(screen.getByText(/Only you can see this comic/)).toBeInTheDocument();
  });
});

describe('usePublicComic', () => {
  const Probe: React.FC<{ slug: string; owner?: boolean }> = ({ slug, owner }) => {
    const r = usePublicComic(slug, { isOwner: owner });
    return (
      <div>
        <span data-testid="status">{r.status}</span>
        <span data-testid="boot">{r.boot?.card.title || ''}</span>
        <button type="button" onClick={() => r.track('view')}>
          view
        </button>
      </div>
    );
  };

  it('reads the boot card before the fetch resolves, then loads; a 404 reads as not_found; views sent once, never for the owner', async () => {
    const el = document.createElement('script');
    el.type = 'application/json';
    el.id = 'ds-share-boot';
    el.textContent = JSON.stringify({ slug: SLUG, lang: 'en', card: { title: 'Playtime', coverUrl: 'javascript:alert(1)', aspect: '4:5' } });
    document.head.appendChild(el);
    let resolve!: (v: unknown) => void;
    vi.mocked(api.loadPublicComicBySlug).mockReturnValue(new Promise((r) => (resolve = r)) as never);
    const { unmount } = render(<Probe slug={SLUG} />);
    expect(screen.getByTestId('boot')).toHaveTextContent('Playtime');
    expect(readShareBoot(SLUG)?.card.coverUrl).toBeUndefined(); // only https cover URLs
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    resolve({ publication: { slug: SLUG }, doc: makeSampleDoc(), urls: {} });
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    fireEvent.click(screen.getByRole('button', { name: 'view' }));
    fireEvent.click(screen.getByRole('button', { name: 'view' }));
    expect(api.trackPublicEvent).toHaveBeenCalledTimes(1);
    unmount();
    el.remove();

    vi.mocked(api.loadPublicComicBySlug).mockRejectedValue(Object.assign(new Error('gone'), { status: 404, kind: 'not_found' }));
    render(<Probe slug={SLUG} owner />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('not_found'));
    fireEvent.click(screen.getByRole('button', { name: 'view' }));
    expect(api.trackPublicEvent).toHaveBeenCalledTimes(1);
    expect(readShareBoot('Zz3dEf6hIj9kLm2nP')).toBeNull();
  });
});
